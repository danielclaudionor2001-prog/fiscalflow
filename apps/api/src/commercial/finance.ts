import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { pagination, recordId } from "../registrations/input.ts";
import { calendarDate, commercialTransaction, fingerprint, pageResult, positiveMoney, requestKey, requireSupplier, title, today } from "./common.ts";

const entryFields = z.strictObject({
  kind: z.enum(["RECEIVABLE", "PAYABLE"]),
  description: title,
  amount: positiveMoney,
  dueOn: calendarDate,
  supplierId: recordId.nullable().default(null),
}).refine(({ kind, supplierId }) => kind === "PAYABLE" || supplierId === null);
const paymentFields = z.strictObject({
  amount: positiveMoney,
  paidOn: calendarDate,
  method: z.enum(["PIX", "CASH", "CARD", "BOLETO", "TRANSFER", "OTHER"]),
}).refine(({ paidOn }) => paidOn <= today());
const cashQuery = pagination.extend({
  kind: z.enum(["RECEIVABLE", "PAYABLE", "COMMISSION"]).optional(),
  status: z.enum(["OPEN", "OVERDUE", "SETTLED", "CANCELLED"]).optional(),
});
const rangeQuery = z.strictObject({ from: calendarDate, to: calendarDate })
  .refine(({ from, to }) => from <= to && to.getTime() - from.getTime() <= 365 * 86_400_000);
const entrySelect = {
  id: true, kind: true, description: true, amount: true, balance: true, dueOn: true,
  cancelledAt: true, orderId: true, supplier: { select: { name: true } },
} satisfies Prisma.CashEntrySelect;

function cashStatus(status: z.infer<typeof cashQuery>["status"]): Prisma.CashEntryWhereInput {
  if (status === "OPEN") return { cancelledAt: null, balance: { gt: 0 } };
  if (status === "OVERDUE") return { cancelledAt: null, balance: { gt: 0 }, dueOn: { lt: today() } };
  if (status === "SETTLED") return { cancelledAt: null, balance: 0 };
  if (status === "CANCELLED") return { cancelledAt: { not: null } };
  return {};
}

async function entryById(prisma: Prisma.TransactionClient, organizationId: string, id: string) {
  const entry = await prisma.cashEntry.findUnique({ where: { organizationId_id: { organizationId, id } }, select: entrySelect });
  if (!entry) throw new RequestError(404, "not-found");
  return entry;
}

export function createFinanceRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName, "OWNER", "ADMIN", "ACCOUNTANT");
  const manage = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "8kb" });

  router.get("/summary", read, asyncRoute(async (req, res) => {
    const { from, to } = parseInput(rangeQuery, req.query);
    const { organizationId } = tenantActor(res);
    const result = await prisma.$transaction(async (tx) => {
      const [sales] = await tx.$queryRaw<{ count: number; revenue: Prisma.Decimal; cost: Prisma.Decimal }[]>`
        SELECT count(*)::int AS count, coalesce(sum("amount"), 0) AS revenue, coalesce(sum("cost"), 0) AS cost
        FROM "CommercialOrder"
        WHERE "organizationId" = ${organizationId} AND "kind" = 'SALE' AND "status" = 'CONFIRMED'
          AND (("confirmedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date
            BETWEEN ${from}::date AND ${to}::date
      `;
      const payments = await tx.$queryRaw<{ day: string; kind: string; total: Prisma.Decimal }[]>`
        SELECT p."paidOn"::text AS day, e."kind"::text AS kind, sum(p."amount") AS total
        FROM "CashPayment" p JOIN "CashEntry" e ON e."id" = p."entryId" AND e."organizationId" = p."organizationId"
        WHERE p."organizationId" = ${organizationId} AND p."paidOn" BETWEEN ${from}::date AND ${to}::date
          AND p."reversedAt" IS NULL
        GROUP BY p."paidOn", e."kind" ORDER BY p."paidOn", e."kind"
      `;
      const open = await tx.cashEntry.groupBy({
        by: ["kind"], where: { organizationId, cancelledAt: null, balance: { gt: 0 } }, _sum: { balance: true },
      });
      const zero = new Prisma.Decimal(0);
      const received = payments.filter((p) => p.kind === "RECEIVABLE").reduce((sum, p) => sum.plus(p.total), zero);
      const paid = payments.filter((p) => p.kind !== "RECEIVABLE").reduce((sum, p) => sum.plus(p.total), zero);
      return {
        ...sales, margin: sales.revenue.minus(sales.cost), received, paid, cashResult: received.minus(paid), payments,
        receivable: open.find((item) => item.kind === "RECEIVABLE")?._sum.balance ?? zero,
        payable: open.filter((item) => item.kind !== "RECEIVABLE").reduce((sum, item) => sum.plus(item._sum.balance ?? zero), zero),
      };
    }, { isolationLevel: "RepeatableRead" });
    res.json(result);
  }));

  router.get("/entries", read, asyncRoute(async (req, res) => {
    const { page, limit, kind, status } = parseInput(cashQuery, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.cashEntry.findMany({
      where: { organizationId, kind, ...cashStatus(status) },
      orderBy: [{ dueOn: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit + 1, select: entrySelect,
    });
    res.json(pageResult(rows, limit));
  }));

  router.post("/entries", read, json, asyncRoute(async (req, res) => {
    const input = parseInput(entryFields, req.body);
    const key = parseInput(requestKey, req.get("Idempotency-Key"));
    const requestHash = fingerprint(input);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const prior = await tx.cashEntry.findUnique({ where: { organizationId_requestKey: { organizationId, requestKey: key } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new RequestError(409, "idempotency-conflict");
        return { entry: await entryById(tx, organizationId, prior.id), created: false };
      }
      await requireSupplier(tx, organizationId, input.supplierId);
      const entry = await tx.cashEntry.create({
        data: { ...input, organizationId, balance: input.amount, requestKey: key, requestHash }, select: entrySelect,
      });
      await recordRegistration(tx, actor, "CASH_ENTRY", entry.id, "CREATED");
      return { entry, created: true };
    });
    res.status(result.created ? 201 : 200).json(result.entry);
  }));

  router.post("/entries/:id/cancel", manage, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const entry = await entryById(tx, organizationId, id);
      if (entry.cancelledAt) return entry;
      if (entry.orderId || !entry.balance.eq(entry.amount)) throw new RequestError(409, "entry-cannot-cancel");
      const saved = await tx.cashEntry.update({ where: { id, organizationId }, data: { cancelledAt: new Date() }, select: entrySelect });
      await recordRegistration(tx, actor, "CASH_ENTRY", id, "ARCHIVED");
      return saved;
    });
    res.json(result);
  }));

  router.get("/entries/:id/payments", read, asyncRoute(async (req, res) => {
    const entryId = parseInput(recordId, req.params.id);
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const entry = await entryById(prisma, organizationId, entryId);
    const rows = await prisma.cashPayment.findMany({
      where: { organizationId, entryId }, orderBy: [{ paidOn: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit, take: limit + 1,
      select: { id: true, amount: true, paidOn: true, method: true, reversedAt: true },
    });
    res.json({ entry, ...pageResult(rows, limit) });
  }));

  router.post("/entries/:id/payments", read, json, asyncRoute(async (req, res) => {
    const entryId = parseInput(recordId, req.params.id);
    const key = parseInput(requestKey, req.get("Idempotency-Key"));
    const input = parseInput(paymentFields, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const entry = await entryById(tx, organizationId, entryId);
      const prior = await tx.cashPayment.findUnique({ where: { organizationId_requestKey: { organizationId, requestKey: key } } });
      if (prior) {
        if (prior.entryId !== entryId || !prior.amount.eq(input.amount) || prior.method !== input.method || +prior.paidOn !== +input.paidOn) {
          throw new RequestError(409, "idempotency-conflict");
        }
        return entry;
      }
      if (entry.cancelledAt || entry.balance.lt(input.amount)) throw new RequestError(409, "payment-exceeds-balance");
      const payment = await tx.cashPayment.create({ data: { ...input, organizationId, entryId, requestKey: key } });
      const saved = await tx.cashEntry.update({
        where: { id: entryId, organizationId }, data: { balance: { decrement: input.amount } }, select: entrySelect,
      });
      await recordRegistration(tx, actor, "CASH_PAYMENT", payment.id, "CREATED");
      return saved;
    });
    res.json(result);
  }));

  router.post("/entries/:id/payments/:paymentId/reverse", manage, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const paymentId = parseInput(recordId, req.params.paymentId);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const entry = await entryById(tx, organizationId, id);
      const where = { id: paymentId, organizationId, entryId: id };
      const payment = await tx.cashPayment.findUnique({ where });
      if (!payment) throw new RequestError(404, "not-found");
      if (payment.reversedAt) return entry;
      await tx.cashPayment.update({ where, data: { reversedAt: new Date() } });
      const saved = await tx.cashEntry.update({
        where: { id, organizationId }, data: { balance: { increment: payment.amount } }, select: entrySelect,
      });
      await recordRegistration(tx, actor, "CASH_PAYMENT", paymentId, "ARCHIVED");
      return saved;
    });
    res.json(result);
  }));
  return router;
}
