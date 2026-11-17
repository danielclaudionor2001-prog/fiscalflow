import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { cnpjSchema, cpfFormatSchema, cpfSchema, customerCreate, moneyAmount, pagination, recordId, serviceCreate } from "../registrations/input.ts";
import { hasCnpjCheckDigits, lookupPublicCnpj, type PublicCnpjLookup } from "./cnpj-lookup.ts";

const draftFields = z.strictObject({
  customerId: recordId,
  serviceId: recordId.nullable(),
  amount: moneyAmount.refine((amount) => /[1-9]/.test(amount)),
  serviceDescription: serviceCreate.shape.description,
});
const draftInput = draftFields.extend({ serviceId: draftFields.shape.serviceId.default(null) });
const draftWithNewCustomer = draftInput.omit({ customerId: true }).extend({
  customerName: customerCreate.shape.name,
});
const draftCreate = z.union([
  draftInput,
  draftWithNewCustomer.extend({ customerCnpj: cnpjSchema.refine(hasCnpjCheckDigits) })
    .transform(({ customerCnpj, ...data }) => ({ ...data, customerDocument: customerCnpj })),
  draftWithNewCustomer.extend({ customerCpf: cpfSchema })
    .transform(({ customerCpf, ...data }) => ({ ...data, customerDocument: customerCpf })),
]);
const lookupInput = z.union([z.strictObject({ cnpj: cnpjSchema }), z.strictObject({ cpf: cpfFormatSchema })]);
const draftUpdate = draftFields.partial().refine((data) => Object.keys(data).length > 0);
export const draftVersion = z.string().regex(/^"[^"]+"$/).transform((value) => value.slice(1, -1))
  .pipe(z.iso.datetime()).transform((value) => new Date(value));
const activityQuery = pagination.extend({ action: z.enum(["CREATED", "UPDATED", "ARCHIVED"]).optional() });
type DraftInput = z.infer<typeof draftInput>;
type DraftCreate = z.infer<typeof draftCreate>;

const draftSelect = {
  id: true,
  customerId: true,
  serviceId: true,
  amount: true,
  status: true,
  kind: true,
  serviceDescription: true,
  createdAt: true,
  updatedAt: true,
  discardedAt: true,
  customer: { select: { name: true, federalTaxId: true } },
  service: { select: { name: true } },
} satisfies Prisma.InvoiceSelect;
type Draft = Prisma.InvoiceGetPayload<{ select: typeof draftSelect }>;

function draftView({ discardedAt: _discardedAt, ...draft }: Draft) {
  return { ...draft, amount: draft.amount.toFixed(2), customer: { name: draft.customer.name } };
}

function matchRequest(draft: Draft, data: DraftCreate) {
  const sameCustomer = "customerId" in data ? draft.customerId === data.customerId : draft.customer.federalTaxId === data.customerDocument;
  if (draft.discardedAt || draft.status !== "DRAFT" || !sameCustomer || draft.serviceId !== data.serviceId ||
    !draft.amount.equals(data.amount) || draft.serviceDescription !== data.serviceDescription) {
    throw new RequestError(409, "idempotency-conflict");
  }
}

function customerByDocument(db: Pick<Prisma.TransactionClient, "customer">, organizationId: string, federalTaxId: string) {
  return db.customer.findUnique({
    where: { organizationId_federalTaxId: { organizationId, federalTaxId } },
    select: { id: true, name: true, archivedAt: true },
  });
}

async function resolveDraftCustomer(tx: Prisma.TransactionClient, actor: ReturnType<typeof tenantActor>, input: DraftCreate) {
  if ("customerId" in input) return input.customerId;
  const { organizationId } = actor;
  const { customerDocument, customerName } = input;
  let customer = await customerByDocument(tx, organizationId, customerDocument);
  if (!customer) {
    const { count } = await tx.customer.createMany({
      data: { organizationId, federalTaxId: customerDocument, name: customerName },
      skipDuplicates: true,
    });
    customer = await customerByDocument(tx, organizationId, customerDocument);
    if (!customer) throw new RequestError(404, "customer-unavailable");
    if (count) await recordRegistration(tx, actor, "CUSTOMER", customer.id, "CREATED");
  }
  if (customer.archivedAt) throw new RequestError(409, "customer-archived");
  return customer.id;
}

export function draftScope(organizationId: string) {
  return { organizationId, status: "DRAFT" as const, discardedAt: null };
}

export async function lockDraftReferences(tx: Prisma.TransactionClient, organizationId: string, data: Partial<Pick<DraftInput, "customerId" | "serviceId">>) {
  // Keep the selected records eligible until the draft and its audit event are saved.
  if (data.customerId !== undefined) {
    const customers = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Customer"
      WHERE "organizationId" = ${organizationId} AND "id" = ${data.customerId} AND "archivedAt" IS NULL
      FOR SHARE
    `;
    if (!customers.length) throw new RequestError(404, "customer-unavailable");
  }
  if (!data.serviceId) return;

  const services = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Service"
    WHERE "organizationId" = ${organizationId} AND "id" = ${data.serviceId} AND "archivedAt" IS NULL AND "active"
    FOR SHARE
  `;
  if (!services.length) throw new RequestError(404, "service-unavailable");
}

async function currentDraft(tx: Prisma.TransactionClient, organizationId: string, id: string, version: Date) {
  const where = { id, ...draftScope(organizationId) };
  const draft = await tx.invoice.findUnique({ where, select: draftSelect });
  if (!draft) throw new RequestError(404, "draft-unavailable");
  if (draft.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "draft-changed");
  return { draft, where: { ...where, updatedAt: version } };
}

export function createInvoiceDraftsRouter(prisma: PrismaClient, cookieName: string, lookupCnpj: PublicCnpjLookup = lookupPublicCnpj) {
  const router = express.Router();
  const read = authorize(prisma, cookieName);
  const write = authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const discard = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "16kb" });
  const lookupLimit = rateLimit({
    windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, identifier: "invoice-customer-lookup",
    keyGenerator: (_req, res) => tenantActor(res).organizationId, message: { code: "rate-limited" },
  });

  router.get("/", read, asyncRoute(async (req, res) => {
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.invoice.findMany({
      where: {
        organizationId, discardedAt: null, organization: { archivedAt: null },
        OR: [{ status: "DRAFT" }, { status: "PROCESSING", preparedDps: { some: { environment: "PRODUCTION", productionStatus: "PENDING" } } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
      select: draftSelect,
    });
    res.json({ items: rows.slice(0, limit).map(draftView), hasNext: rows.length > limit });
  }));

  router.get("/activity", discard, asyncRoute(async (req, res) => {
    const { page, limit, action } = parseInput(activityQuery, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.registrationAuditEvent.findMany({
      where: { organizationId, entity: "INVOICE", action, organization: { archivedAt: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
      select: { id: true, entityId: true, actorUserId: true, action: true, createdAt: true },
    });
    const events = rows.slice(0, limit);
    const [actors, drafts] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: events.flatMap((event) => event.actorUserId ?? []) }, memberships: { some: { organizationId } } },
        select: { id: true, name: true },
      }),
      prisma.invoice.findMany({
        where: { organizationId, id: { in: events.map((event) => event.entityId) } },
        select: { id: true, customer: { select: { name: true } } },
      }),
    ]);
    const names = new Map(actors.map(({ id, name }) => [id, name]));
    const customers = new Map(drafts.map(({ id, customer }) => [id, customer.name]));
    res.json({
      items: events.map(({ id, entityId, actorUserId, action, createdAt }) => ({
        id, draftId: entityId, action, createdAt,
        actorName: actorUserId === null ? "Automação" : names.get(actorUserId) ?? null,
        customerName: customers.get(entityId) ?? null,
      })),
      hasNext: rows.length > limit,
    });
  }));

  router.post("/customer-lookup", write, lookupLimit, express.json({ limit: "1kb" }), asyncRoute(async (req, res) => {
    const data = parseInput(lookupInput, req.body);
    const { organizationId } = tenantActor(res);
    const customer = await customerByDocument(prisma, organizationId, "cpf" in data ? data.cpf : data.cnpj);
    if (customer?.archivedAt) throw new RequestError(409, "customer-archived");
    if (customer) {
      res.json({ source: "registered", customerId: customer.id, name: customer.name });
      return;
    }
    if ("cpf" in data) {
      if (!cpfSchema.safeParse(data.cpf).success) throw new RequestError(400, "invalid-cpf");
      res.json({ source: "not-found" });
      return;
    }
    if (!hasCnpjCheckDigits(data.cnpj)) throw new RequestError(400, "invalid-cnpj");
    res.json(await lookupCnpj(data.cnpj));
  }));

  router.post("/", write, json, asyncRoute(async (req, res) => {
    const data = parseInput(draftCreate, req.body);
    const idempotencyKey = parseInput(z.uuid(), req.get("Idempotency-Key"));
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const where = { organizationId_idempotencyKey: { organizationId, idempotencyKey } };
    const { draft, created } = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const existing = await tx.invoice.findUnique({ where, select: draftSelect });
      if (existing) {
        matchRequest(existing, data);
        return { draft: existing, created: false };
      }

      const customerId = await resolveDraftCustomer(tx, actor, data);
      const { serviceId, amount, serviceDescription } = data;
      await lockDraftReferences(tx, organizationId, { customerId, serviceId });
      const { count } = await tx.invoice.createMany({
        data: { customerId, serviceId, amount, serviceDescription, organizationId, idempotencyKey, status: "DRAFT" },
        skipDuplicates: true,
      });
      const saved = await tx.invoice.findUniqueOrThrow({ where, select: draftSelect });
      matchRequest(saved, data);
      if (count) await recordRegistration(tx, actor, "INVOICE", saved.id, "CREATED");
      return { draft: saved, created: count === 1 };
    });
    res.status(created ? 201 : 200).json(draftView(draft));
  }));

  router.patch("/:id", write, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const data = parseInput(draftUpdate, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const saved = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const { draft, where } = await currentDraft(tx, organizationId, id, version);
      await lockDraftReferences(tx, organizationId, {
        customerId: data.customerId === draft.customerId ? undefined : data.customerId,
        serviceId: data.serviceId === draft.serviceId ? undefined : data.serviceId,
      });
      const updatedAt = new Date(Math.max(Date.now(), version.getTime() + 1));
      const [updated] = await tx.invoice.updateManyAndReturn({ where, data: { ...data, updatedAt }, select: draftSelect });
      if (!updated) throw new RequestError(409, "draft-changed");
      await recordRegistration(tx, actor, "INVOICE", id, "UPDATED");
      return updated;
    });
    res.json(draftView(saved));
  }));

  router.delete("/:id", discard, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, actor.organizationId);
      const { where } = await currentDraft(tx, actor.organizationId, id, version);
      const { count } = await tx.invoice.updateMany({ where, data: { discardedAt: new Date() } });
      if (count !== 1) throw new RequestError(409, "draft-changed");
      await recordRegistration(tx, actor, "INVOICE", id, "ARCHIVED");
    });
    res.status(204).end();
  }));

  return router;
}
