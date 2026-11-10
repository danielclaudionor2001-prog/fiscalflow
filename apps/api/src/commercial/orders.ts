import { Prisma, type CommercialKind, type PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { draftVersion, lockDraftReferences } from "../invoices/drafts.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { pagination, recordId } from "../registrations/input.ts";
import { calendarDate, checkTotal, commercialTransaction, fingerprint, maxStock, pageResult, positiveMoney, quantity, requestKey } from "./common.ts";

const orderKind = z.enum(["QUOTE", "SERVICE_ORDER", "SALE"]);
const itemFields = z.strictObject({
  type: z.enum(["PRODUCT", "SERVICE"]), id: recordId, quantity, price: positiveMoney,
});
const orderFields = z.strictObject({
  customerId: recordId.nullable().default(null),
  note: z.string().trim().max(2000).default(""),
  sellerName: z.string().trim().min(1).max(160).nullable().default(null),
  commissionBps: z.number().int().min(0).max(10_000).default(0),
  dueOn: calendarDate.nullable().default(null),
  installments: z.number().int().min(1).max(24).default(1),
  items: z.array(itemFields).min(1).max(30),
}).refine(({ sellerName, commissionBps }) => commissionBps === 0 || sellerName !== null);
const orderCreate = z.strictObject({ kind: orderKind, order: orderFields });
const orderQuery = pagination.extend({ kind: orderKind, status: z.enum(["OPEN", "CONFIRMED", "CANCELLED"]).optional() });
const orderInclude = {
  items: { orderBy: { position: "asc" } },
  convertedSale: { select: { id: true } },
  invoice: { select: { id: true, discardedAt: true } },
} satisfies Prisma.CommercialOrderInclude;
type Order = Prisma.CommercialOrderGetPayload<{ include: typeof orderInclude }>;
type Actor = ReturnType<typeof tenantActor>;
type Input = z.infer<typeof orderFields>;

function orderView({ requestKey: _key, requestHash: _hash, ...order }: Order) {
  return order;
}

async function orderById(tx: Prisma.TransactionClient, organizationId: string, id: string) {
  const order = await tx.commercialOrder.findUnique({ where: { id, organizationId }, include: orderInclude });
  if (!order) throw new RequestError(404, "not-found");
  return order;
}

async function orderData(tx: Prisma.TransactionClient, organizationId: string, kind: CommercialKind, input: Input) {
  if (kind !== "SALE" && !input.customerId) throw new RequestError(400, "customer-required");
  if (kind !== "SALE" && (input.commissionBps || input.installments !== 1)) throw new RequestError(400, "invalid-input");
  await lockDraftReferences(tx, organizationId, { customerId: input.customerId ?? undefined });
  const customer = input.customerId ? await tx.customer.findUniqueOrThrow({
    where: { id: input.customerId, organizationId }, select: { name: true },
  }) : null;
  const products = await tx.product.findMany({
    where: { organizationId, archivedAt: null, id: { in: input.items.filter((item) => item.type === "PRODUCT").map((item) => item.id) } },
    select: { id: true, name: true, cost: true },
  });
  const services = await tx.service.findMany({
    where: { organizationId, archivedAt: null, active: true, id: { in: input.items.filter((item) => item.type === "SERVICE").map((item) => item.id) } },
    select: { id: true, name: true },
  });
  const items = input.items.map((item, position) => {
    const product = item.type === "PRODUCT" ? products.find(({ id }) => id === item.id) : undefined;
    const service = item.type === "SERVICE" ? services.find(({ id }) => id === item.id) : undefined;
    const entry = product ?? service;
    if (!entry) throw new RequestError(404, "item-unavailable");
    return {
      position, productId: product?.id ?? null, serviceId: service?.id ?? null,
      label: entry.name, quantity: item.quantity, unitPrice: new Prisma.Decimal(item.price), unitCost: product?.cost ?? new Prisma.Decimal(0),
    };
  });
  const amount = checkTotal(items.reduce((sum, item) => sum.plus(item.unitPrice.mul(item.quantity)), new Prisma.Decimal(0)));
  const cost = checkTotal(items.reduce((sum, item) => sum.plus(item.unitCost.mul(item.quantity)), new Prisma.Decimal(0)));
  const { items: _inputItems, ...fields } = input;
  return { ...fields, customerName: customer?.name ?? null, amount, cost, items: { createMany: { data: items } } };
}

async function moveStock(tx: Prisma.TransactionClient, actor: Actor, sale: Order, reverse: boolean) {
  const totals = new Map<string, number>();
  for (const item of sale.items) {
    if (item.productId) totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
  }
  for (const [id, quantity] of totals) {
    const where = { id, organizationId: actor.organizationId };
    const row = await tx.product.findUniqueOrThrow({ where, select: { stock: true, archivedAt: true } });
    const delta = reverse ? quantity : -quantity;
    const stock = row.stock + delta;
    if ((!reverse && row.archivedAt) || stock < 0 || stock > maxStock) throw new RequestError(409, "invalid-stock");
    await tx.product.update({ where, data: { stock, ...(reverse && { archivedAt: null }) } });
    const movement = await tx.stockMovement.create({
      data: { organizationId: actor.organizationId, orderId: sale.id, productId: id, quantity: delta, reason: reverse ? "Estorno de venda" : "Venda confirmada" },
    });
    await recordRegistration(tx, actor, "STOCK_MOVEMENT", movement.id, "CREATED");
  }
}

function monthlyDue(first: Date, offset: number) {
  const due = new Date(first);
  due.setUTCMonth(due.getUTCMonth() + offset, 1);
  const last = new Date(due);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  due.setUTCDate(Math.min(first.getUTCDate(), last.getUTCDate()));
  return due;
}

function saleReceivables(order: Order, firstDue: Date) {
  const cents = order.amount.mul(100);
  const count = order.installments;
  if (cents.lt(count)) throw new RequestError(400, "installment-too-small");
  const base = cents.div(count).floor();
  const extra = cents.mod(count).toNumber();
  const description = "Venda • " + (order.customerName ?? "Cliente avulso");
  return Array.from({ length: count }, (_, index) => ({
    kind: "RECEIVABLE" as const,
    description: count > 1 ? description + " • Parcela " + (index + 1) + "/" + count : description,
    amount: base.plus(index < extra ? 1 : 0).div(100),
    dueOn: monthlyDue(firstDue, index),
    installment: index + 1,
  }));
}

async function confirmOrder(tx: Prisma.TransactionClient, actor: Actor, order: Order) {
  if (order.kind === "QUOTE" || order.status === "CANCELLED") throw new RequestError(409, "order-state");
  if (order.status === "CONFIRMED") return order;
  if (order.customerId) await lockDraftReferences(tx, actor.organizationId, { customerId: order.customerId });
  if (order.kind === "SALE") {
    const { dueOn } = order;
    if (!dueOn) throw new RequestError(400, "due-date-required");
    await moveStock(tx, actor, order, false);
    const commission = order.amount.mul(order.commissionBps).div(10_000).toDecimalPlaces(2);
    const entries = [...saleReceivables(order, dueOn), ...(commission.gt(0) ? [{
      kind: "COMMISSION" as const, description: "Comissão • " + order.sellerName, amount: commission, dueOn, installment: 1,
    }] : [])];
    for (const entry of entries) {
      const saved = await tx.cashEntry.create({
        data: { ...entry, organizationId: actor.organizationId, orderId: order.id, balance: entry.amount },
      });
      await recordRegistration(tx, actor, "CASH_ENTRY", saved.id, "CREATED");
    }
  }
  const updated = await tx.commercialOrder.update({
    where: { id: order.id, organizationId: actor.organizationId },
    data: { status: "CONFIRMED", confirmedAt: new Date() }, include: orderInclude,
  });
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", order.id, "UPDATED");
  return updated;
}

async function convertOrder(tx: Prisma.TransactionClient, actor: Actor, order: Order) {
  if (order.kind === "SALE" || order.status === "CANCELLED" || (order.kind === "SERVICE_ORDER" && order.status !== "CONFIRMED")) {
    throw new RequestError(409, "order-state");
  }
  if (order.convertedSale) return orderById(tx, actor.organizationId, order.convertedSale.id);
  if (order.customerId) await lockDraftReferences(tx, actor.organizationId, { customerId: order.customerId });
  const sale = await tx.commercialOrder.create({
    data: {
      organizationId: actor.organizationId, sourceId: order.id, kind: "SALE", amount: order.amount, cost: order.cost,
      customerId: order.customerId, customerName: order.customerName, note: order.note, sellerName: order.sellerName,
      items: { createMany: { data: order.items.map(({ id: _id, orderId: _order, organizationId: _tenant, ...item }) => item) } },
    },
    include: orderInclude,
  });
  if (order.kind === "QUOTE") await tx.commercialOrder.update({
    where: { id: order.id, organizationId: actor.organizationId },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", sale.id, "CREATED");
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", order.id, "UPDATED");
  return sale;
}

async function cancelOrder(tx: Prisma.TransactionClient, actor: Actor, order: Order) {
  if (order.status === "CANCELLED") return order;
  if (order.convertedSale) throw new RequestError(409, "order-state");
  if (order.invoice && !order.invoice.discardedAt) throw new RequestError(409, "order-has-invoice");
  if (order.kind === "SALE" && order.status === "CONFIRMED") {
    const where = { organizationId: actor.organizationId, orderId: order.id };
    const entries = await tx.cashEntry.findMany({ where, select: { id: true, amount: true, balance: true } });
    if (entries.some(({ amount, balance }) => !amount.eq(balance))) throw new RequestError(409, "order-has-payments");
    await moveStock(tx, actor, order, true);
    await tx.cashEntry.updateMany({ where, data: { cancelledAt: new Date() } });
    for (const entry of entries) await recordRegistration(tx, actor, "CASH_ENTRY", entry.id, "ARCHIVED");
  }
  const updated = await tx.commercialOrder.update({
    where: { id: order.id, organizationId: actor.organizationId }, data: { status: "CANCELLED" }, include: orderInclude,
  });
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", order.id, "ARCHIVED");
  return updated;
}

async function makeDraft(tx: Prisma.TransactionClient, actor: Actor, order: Order) {
  if (order.kind !== "SALE" || order.status !== "CONFIRMED") throw new RequestError(409, "order-state");
  if (order.invoiceId && !order.invoice?.discardedAt) return { invoiceId: order.invoiceId };
  if (!order.customerId) throw new RequestError(400, "customer-required");
  const lines = order.items.filter((item) => item.serviceId);
  const serviceId = lines[0]?.serviceId;
  if (!serviceId || lines.some((item) => item.serviceId !== serviceId)) throw new RequestError(409, "order-needs-single-service");
  await lockDraftReferences(tx, actor.organizationId, { customerId: order.customerId, serviceId });
  const service = await tx.service.findUniqueOrThrow({
    where: { id: serviceId, organizationId: actor.organizationId }, select: { description: true },
  });
  const amount = lines.reduce((sum, line) => sum.plus(line.unitPrice.mul(line.quantity)), new Prisma.Decimal(0));
  const invoice = await tx.invoice.create({
    data: {
      organizationId: actor.organizationId, customerId: order.customerId, serviceId, amount,
      serviceDescription: service.description, status: "DRAFT", idempotencyKey: "commercial:" + order.id + ":" + (order.invoiceId ?? "original"),
    },
    select: { id: true },
  });
  await tx.commercialOrder.update({
    where: { id: order.id, organizationId: actor.organizationId }, data: { invoiceId: invoice.id },
  });
  await recordRegistration(tx, actor, "INVOICE", invoice.id, "CREATED");
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", order.id, "UPDATED");
  return { invoiceId: invoice.id };
}

export function createOrdersRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName);
  const write = authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const manage = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "24kb" });

  router.get("/", read, asyncRoute(async (req, res) => {
    const { page, limit, kind, status } = parseInput(orderQuery, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.commercialOrder.findMany({
      where: { organizationId, kind, status },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit + 1,
      select: { id: true, status: true, customerName: true, sellerName: true, amount: true, createdAt: true, dueOn: true },
    });
    res.json(pageResult(rows, limit));
  }));

  router.get("/:id", read, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { organizationId } = tenantActor(res);
    res.json(orderView(await orderById(prisma, organizationId, id)));
  }));

  router.post("/", write, json, asyncRoute(async (req, res) => {
    const input = parseInput(orderCreate, req.body);
    const key = parseInput(requestKey, req.get("Idempotency-Key"));
    const requestHash = fingerprint(input);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const prior = await tx.commercialOrder.findUnique({ where: { organizationId_requestKey: { organizationId, requestKey: key } }, include: orderInclude });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new RequestError(409, "idempotency-conflict");
        return { row: prior, created: false };
      }
      const data = await orderData(tx, organizationId, input.kind, input.order);
      const row = await tx.commercialOrder.create({
        data: { ...data, kind: input.kind, organizationId, requestHash, requestKey: key }, include: orderInclude,
      });
      await recordRegistration(tx, actor, "COMMERCIAL_ORDER", row.id, "CREATED");
      return { row, created: true };
    });
    res.status(result.created ? 201 : 200).json(orderView(result.row));
  }));

  router.put("/:id", write, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const input = parseInput(orderFields, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const row = await commercialTransaction(prisma, organizationId, async (tx) => {
      const existing = await orderById(tx, organizationId, id);
      if (existing.status !== "OPEN" || existing.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "order-changed");
      const data = await orderData(tx, organizationId, existing.kind, input);
      await tx.commercialItem.deleteMany({ where: { organizationId, orderId: id } });
      const updated = await tx.commercialOrder.update({
        where: { id, organizationId },
        data: { ...data, updatedAt: new Date(Math.max(Date.now(), version.getTime() + 1)) },
        include: orderInclude,
      });
      await recordRegistration(tx, actor, "COMMERCIAL_ORDER", id, "UPDATED");
      return updated;
    });
    res.json(orderView(row));
  }));

  function action<Result>(run: (tx: Prisma.TransactionClient, actor: Actor, order: Order) => Promise<Result>) {
    return asyncRoute(async (req, res) => {
      const id = parseInput(recordId, req.params.id);
      const version = parseInput(draftVersion, req.get("If-Match"));
      const actor = tenantActor(res);
      const result = await commercialTransaction(prisma, actor.organizationId, async (tx) => {
        const order = await orderById(tx, actor.organizationId, id);
        if (order.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "order-changed");
        return run(tx, actor, order);
      });
      res.json(result);
    });
  }

  router.post("/:id/confirm", write, action(async (...args) => orderView(await confirmOrder(...args))));
  router.post("/:id/convert", write, action(async (...args) => orderView(await convertOrder(...args))));
  router.post("/:id/cancel", manage, action(async (...args) => orderView(await cancelOrder(...args))));
  router.post("/:id/invoice-draft", write, action(makeDraft));
  return router;
}
