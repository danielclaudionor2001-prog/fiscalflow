import { randomUUID } from "node:crypto";
import { Prisma, type BillingPurpose, type Boleto, type BoletoStatus, type CelcoinSandboxCharge, type PrismaClient } from "@prisma/client";
import express from "express";
import type { Response } from "express";
import { z } from "zod";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { lockManagedCompany, platformOwnerOnly, requirePlatformOwner } from "../organizations/platform.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { moneyAmount, pagination, recordId } from "../registrations/input.ts";
import { sandboxAmount, type CelcoinSandbox } from "./celcoin-sandbox.ts";
import { accountLastFour } from "./receiving-account.ts";

const serviceInput = z.strictObject({ invoiceId: recordId, dueDate: z.iso.date() });
const subscriptionInput = z.strictObject({
  period: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/),
  dueDate: z.iso.date(),
  amount: moneyAmount,
});
const listQuery = pagination.extend({
  invoiceId: recordId.optional(),
  state: z.enum(["PLANNED", "REGISTERED", "OVERDUE", "SETTLED", "CANCELLED"]).optional(),
});
const statusInput = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("REGISTERED"), issuerReference: z.string().trim().min(1).max(100) }),
  z.strictObject({ status: z.literal("SETTLED") }),
  z.strictObject({ status: z.literal("CANCELLED") }),
]);
const before: Record<z.infer<typeof statusInput>["status"], BoletoStatus[]> = {
  REGISTERED: ["PLANNED"], SETTLED: ["REGISTERED"], CANCELLED: ["PLANNED", "REGISTERED"],
};
const brazilDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

function sandboxView(row: CelcoinSandboxCharge) {
  const { status, dueDate, bankLine, updatedAt } = row;
  const date = dueDate.toISOString().slice(0, 10);
  return {
    status, dueDate: date, amount: sandboxAmount.toFixed(2), bankLine: status === "PENDING" ? bankLine : null,
    overdue: status === "PENDING" && date < brazilDate.format(new Date()), updatedAt,
  };
}

function boletoView(row: Boleto & { sandbox?: CelcoinSandboxCharge | null }) {
  const { id, invoiceId, period, payerName, amount, dueDate, status, bankName, accountLastFour,
    issuerReference, settledAt } = row;
  const date = dueDate.toISOString().slice(0, 10);
  return {
    id, invoiceId, period, payerName, amount: amount.toFixed(2), dueDate: date, status,
    bankName, accountLastFour, issuerReference, settledAt,
    provider: row.provider, sandbox: row.sandbox ? sandboxView(row.sandbox) : null,
    overdue: status === "REGISTERED" && date < brazilDate.format(new Date()),
  };
}

function findInvoice(db: PrismaClient | Prisma.TransactionClient, organizationId: string, id: string) {
  return db.invoice.findUnique({
    where: { id, organizationId, discardedAt: null, status: { in: ["DRAFT", "AUTHORIZED"] } },
    select: { id: true, amount: true, status: true, serviceDescription: true, customer: { select: { name: true } } },
  });
}

export function createBoletoRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose, celcoin?: CelcoinSandbox) {
  const router = express.Router({ mergeParams: true });
  const subscription = purpose === "SUBSCRIPTION";
  const read = authorize(prisma, cookieName, ...(subscription ? ["OWNER"] as const : ["OWNER", "ADMIN", "ACCOUNTANT"] as const));
  const write = authorize(prisma, cookieName, "OWNER", "ADMIN");
  router.use(read);
  if (subscription) router.use(platformOwnerOnly);
  const json = express.json({ limit: "3kb" });

  function sandboxConnection(res: Response) {
    const { membership } = res.locals.auth as AuthSession;
    const { cnpj } = membership.organization;
    return cnpj ? celcoin?.get(cnpj, purpose) : undefined;
  }

  async function scopeWrite(tx: Prisma.TransactionClient, actor: ReturnType<typeof tenantActor>, target: string) {
    if (subscription) {
      await requirePlatformOwner(tx, actor);
      return lockManagedCompany(tx, target);
    }
    await requireActiveOrganization(tx, actor.organizationId);
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId: actor.actorUserId, organizationId: actor.organizationId } },
      select: { role: true },
    });
    if (membership?.role !== "OWNER" && membership?.role !== "ADMIN") throw new RequestError(403, "insufficient-role");
  }

  router.get("/", asyncRoute(async (req, res) => {
    const actor = tenantActor(res);
    const organizationId = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const { page, limit, invoiceId, state } = parseInput(listQuery, req.query);
    if (invoiceId && subscription) throw new RequestError(400, "invalid-input");
    const company = subscription ? await prisma.organization.findUnique({
      where: { id: organizationId, archivedAt: null, memberships: { none: { platformOwner: true } } },
      select: { legalName: true },
    }) : null;
    if (subscription && !company) throw new RequestError(404, "company-unavailable");
    const today = new Date(brazilDate.format(new Date()));
    const status = state === "OVERDUE" ? "REGISTERED" : state;
    const dueDate = state === "OVERDUE" ? { lt: today } : state === "REGISTERED" ? { gte: today } : undefined;
    const [account, invoice, rows] = await Promise.all([
      prisma.receivingAccount.findUnique({
        where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } },
        select: { bankName: true, accountNumber: true, provider: true },
      }),
      invoiceId ? findInvoice(prisma, organizationId, invoiceId) : null,
      prisma.boleto.findMany({
        where: { organizationId, purpose, invoiceId, status, dueDate },
        include: { sandbox: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit, take: limit + 1,
      }),
    ]);
    if (invoiceId && !invoice && !rows.length) throw new RequestError(404, "invoice-unavailable");
    res.json({
      company, account: account && { bankName: account.bankName, provider: account.provider, accountLastFour: accountLastFour(account.accountNumber) },
      sandboxConfigured: Boolean(sandboxConnection(res)),
      invoice: invoice && { ...invoice, amount: invoice.amount.toFixed(2) },
      items: rows.slice(0, limit).map(boletoView), hasNext: rows.length > limit,
    });
  }));

  router.post("/", write, json, asyncRoute(async (req, res) => {
    const actor = tenantActor(res);
    const organizationId = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const data = subscription ? parseInput(subscriptionInput, req.body) : parseInput(serviceInput, req.body);
    const row = await prisma.$transaction(async (tx) => {
      const company = await scopeWrite(tx, actor, organizationId);
      const account = await tx.receivingAccount.findUnique({
        where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } },
      });
      if (!account) throw new RequestError(409, "receiving-account-required");
      let subject: { invoiceId?: string; period?: string; amount: Prisma.Decimal; payerName: string };
      if ("invoiceId" in data) {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "organizationId" = ${organizationId} AND "id" = ${data.invoiceId} FOR SHARE`;
        const invoice = await findInvoice(tx, organizationId, data.invoiceId);
        if (!invoice) throw new RequestError(404, "invoice-unavailable");
        subject = { invoiceId: invoice.id, amount: invoice.amount, payerName: invoice.customer.name };
      } else {
        subject = { period: data.period, amount: new Prisma.Decimal(data.amount), payerName: company!.legalName };
      }
      if (!subject.amount.gt(0)) throw new RequestError(400, "amount-required");
      const created = await tx.boleto.create({ data: {
        ...subject, organizationId, purpose, dueDate: new Date(data.dueDate), bankName: account.bankName,
        provider: account.provider, accountLastFour: accountLastFour(account.accountNumber),
      } });
      await recordRegistration(tx, { ...actor, organizationId }, "BOLETO", created.id, "CREATED");
      return created;
    });
    res.status(201).json(boletoView(row));
  }));

  router.patch("/:id", write, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const input = parseInput(statusInput, req.body);
    const actor = tenantActor(res);
    const organizationId = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const row = await prisma.$transaction(async (tx) => {
      await scopeWrite(tx, actor, organizationId);
      const where = { id, organizationId, purpose };
      const current = await tx.boleto.findUnique({ where });
      if (!current) throw new RequestError(404, "not-found");
      if (current.status === input.status &&
          (input.status !== "REGISTERED" || current.issuerReference === input.issuerReference)) return current;
      const { count } = await tx.boleto.updateMany({
        where: { ...where, status: { in: before[input.status] } },
        data: {
          status: input.status,
          ...(input.status === "REGISTERED" && { issuerReference: input.issuerReference }),
          ...(input.status === "SETTLED" && { settledAt: new Date() }),
        },
      });
      if (count !== 1) throw new RequestError(409, "boleto-status-conflict");
      await recordRegistration(tx, { ...actor, organizationId }, "BOLETO", id, "UPDATED");
      return tx.boleto.findUniqueOrThrow({ where });
    });
    res.json(boletoView(row));
  }));

  router.post("/:id/celcoin-sandbox", write, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    const organizationId = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const where = { id, organizationId, purpose };
    const current = await prisma.boleto.findUnique({ where, include: { sandbox: true } });
    if (!current) throw new RequestError(404, "not-found");
    if (current.sandbox) { res.json(sandboxView(current.sandbox)); return; }
    if (current.status !== "PLANNED" || current.provider !== "CELCOIN") throw new RequestError(409, "celcoin-sandbox-unavailable");
    const connection = sandboxConnection(res);
    if (!connection) throw new RequestError(409, "celcoin-sandbox-unconfigured");

    // Authenticate before reserving. A failed token exchange cannot have created a charge.
    const token = await connection.authenticate();
    const key = { organizationId, boletoId: id };
    const dueDate = new Date(brazilDate.format(new Date()));
    dueDate.setUTCDate(dueDate.getUTCDate() + 7);
    const reservation = await prisma.$transaction(async (tx) => {
      await scopeWrite(tx, actor, organizationId);
      const account = await tx.receivingAccount.findUnique({
        where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } },
        select: { provider: true },
      });
      const eligible = await tx.boleto.findUnique({
        where: { ...where, status: "PLANNED", provider: "CELCOIN" }, select: { id: true },
      });
      if (!eligible || account?.provider !== "CELCOIN") throw new RequestError(409, "celcoin-sandbox-unavailable");
      const { count } = await tx.celcoinSandboxCharge.createMany({
        data: { ...key, externalId: "ff-" + randomUUID(), dueDate, receiverFingerprint: connection.fingerprint },
        skipDuplicates: true,
      });
      if (count) await recordRegistration(tx, { ...actor, organizationId }, "CELCOIN_SANDBOX", id, "CREATED");
      return { created: count === 1, row: await tx.celcoinSandboxCharge.findUniqueOrThrow({ where: { organizationId_boletoId: key } }) };
    });
    if (!reservation.created) { res.json(sandboxView(reservation.row)); return; }

    const charge = { externalId: reservation.row.externalId, dueDate: dueDate.toISOString().slice(0, 10) };
    let transactionId: string;
    try {
      transactionId = await connection.issue(token, charge);
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      // The provider may have processed the POST. Preserve the reservation for lookup.
      res.status(202).json(sandboxView(reservation.row));
      return;
    }
    await prisma.celcoinSandboxCharge.updateMany({
      where: { ...key, version: 0 },
      data: { transactionId, status: "PROCESSING", version: { increment: 1 } },
    });
    const saved = await prisma.celcoinSandboxCharge.findUniqueOrThrow({ where: { organizationId_boletoId: key } });
    res.status(202).json(sandboxView(saved));
  }));

  router.post("/:id/celcoin-sandbox/consultar", write, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    const organizationId = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const key = { organizationId, boletoId: id };
    const current = await prisma.celcoinSandboxCharge.findUnique({
      where: { organizationId_boletoId: key, boleto: { purpose } },
    });
    if (!current) throw new RequestError(404, "not-found");
    const connection = sandboxConnection(res);
    if (!connection || connection.fingerprint !== current.receiverFingerprint) throw new RequestError(409, "celcoin-sandbox-unconfigured");
    const token = await connection.authenticate();
    const result = await connection.lookup(token, { ...current, dueDate: current.dueDate.toISOString().slice(0, 10) });
    const saved = await prisma.$transaction(async (tx) => {
      await scopeWrite(tx, actor, organizationId);
      // Ignore stale replies from parallel lookups and never regress confirmed outcomes.
      const next = await tx.celcoinSandboxCharge.updateMany({
        where: {
          ...key, version: current.version,
          status: { in: result.status === "PROCESSING" ? ["AWAITING_LOOKUP", "PROCESSING"] : ["AWAITING_LOOKUP", "PROCESSING", "PENDING"] },
        },
        data: { ...result, version: { increment: 1 } },
      });
      if (next.count && current.status !== result.status) {
        await recordRegistration(tx, { ...actor, organizationId }, "CELCOIN_SANDBOX", id, "UPDATED");
      }
      return tx.celcoinSandboxCharge.findUniqueOrThrow({ where: { organizationId_boletoId: key } });
    });
    res.json(sandboxView(saved));
  }));
  return router;
}
