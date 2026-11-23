import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type AsaasCharge, type AsaasConnection, type BillingPurpose, type PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { today } from "../commercial/common.ts";
import { asyncRoute, handleApiError, parseInput, RequestError } from "../http.ts";
import { lockManagedCompany, platformOwnerOnly, requirePlatformOwner } from "../organizations/platform.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";
import { apiKeyInput, asaasDocument, asaasId, documentHash, type AsaasPayment } from "./asaas-client.ts";
import type { AsaasGateway } from "./asaas-vault.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = z.string().min(32).max(255).regex(/^[\x21-\x7e]+$/);
const connectInput = z.strictObject({ apiKey: apiKeyInput, webhookToken: token, version: z.uuid().nullable() });
const testInput = z.strictObject({ confirmTest: z.literal(true) });
type Actor = ReturnType<typeof tenantActor>;

export function asaasChargeView(row: AsaasCharge) {
  return { environment: "SANDBOX", status: row.status, amount: row.amount.toFixed(2), dueDate: row.dueDate.toISOString().slice(0, 10),
    bankSlipUrl: row.bankSlipUrl, invoiceUrl: row.invoiceUrl, errorCode: row.errorCode, updatedAt: row.updatedAt,
    overdue: row.status === "OVERDUE" || (row.status === "PENDING" && row.dueDate < today()) };
}

async function ownerScope(tx: Prisma.TransactionClient, actor: Actor, purpose: BillingPurpose, write = false) {
  if (purpose === "SUBSCRIPTION") { await requirePlatformOwner(tx, actor); return; }
  await requireActiveOrganization(tx, actor.organizationId);
  const member = await tx.membership.findUnique({ where: { userId_organizationId: { userId: actor.actorUserId, organizationId: actor.organizationId } }, select: { role: true } });
  if (member?.role !== "OWNER" && !(write && member?.role === "ADMIN")) throw new RequestError(403, "insufficient-role");
}

export function createAsaasConnectionRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose, gateway?: AsaasGateway) {
  const router = express.Router();
  router.use(authorize(prisma, cookieName, "OWNER"));
  if (purpose === "SUBSCRIPTION") router.use(platformOwnerOnly);
  router.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { code: "rate-limited" } }));
  router.get("/", asyncRoute(async (_req, res) => {
    const { organizationId } = tenantActor(res);
    const connection = await prisma.asaasConnection.findUnique({ where: { organizationId_purpose: { organizationId, purpose } },
      select: { id: true, version: true, connectedAt: true, disabledAt: true } });
    res.json({ enabled: Boolean(gateway), environment: "SANDBOX", connection: connection && !connection.disabledAt ? {
      version: connection.version, connectedAt: connection.connectedAt, webhookPath: "/api/webhooks/asaas/" + connection.id,
    } : null });
  }));
  router.put("/", express.json({ limit: "3kb" }), asyncRoute(async (req, res) => {
    if (!gateway) throw new RequestError(503, "asaas-vault-unavailable");
    const input = parseInput(connectInput, req.body), actor = tenantActor(res);
    const company = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { cnpj: true, cpf: true } });
    const actualDocument = await gateway.client.accountDocument(input.apiKey);
    if (actualDocument !== asaasDocument(company.cnpj ?? company.cpf ?? "")) throw new RequestError(422, "asaas-holder-mismatch");
    const version = randomUUID();
    const sealedCredentials = gateway.seal({ organizationId: actor.organizationId, purpose, version }, input.apiKey);
    const row = await prisma.$transaction(async (tx) => {
      await ownerScope(tx, actor, purpose);
      const where = { organizationId_purpose: { organizationId: actor.organizationId, purpose } };
      const current = await tx.asaasConnection.findUnique({ where });
      if ((current && !current.disabledAt ? current.version : null) !== input.version || (current?.busyUntil && current.busyUntil > new Date())) {
        throw new RequestError(409, "asaas-connection-changed");
      }
      const credentials = { version, sealedCredentials, webhookTokenHash: digest(input.webhookToken), connectedAt: new Date(), disabledAt: null };
      let connection: AsaasConnection;
      if (current) {
        // Credential changes must also compete with the lease's atomic row update.
        const changed = await tx.asaasConnection.updateMany({ where: { id: current.id, organizationId: actor.organizationId,
          version: current.version, disabledAt: current.disabledAt,
          OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] }, data: credentials });
        if (!changed.count) throw new RequestError(409, "asaas-connection-changed");
        connection = await tx.asaasConnection.findUniqueOrThrow({ where });
      } else {
        try { connection = await tx.asaasConnection.create({ data: { organizationId: actor.organizationId, purpose, ...credentials } }); }
        catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new RequestError(409, "asaas-connection-changed");
          throw error;
        }
      }
      await tx.receivingAccount.upsert({ where,
        create: { organizationId: actor.organizationId, purpose, provider: "ASAAS", bankName: "Asaas (Sandbox)", bankCode: "461", accountNumber: "" },
        update: { provider: "ASAAS", bankName: "Asaas (Sandbox)", bankCode: "461", accountNumber: "", branch: null },
      });
      await recordRegistration(tx, actor, "ASAAS_CONNECTION", connection.id, "UPDATED");
      return connection;
    });
    res.json({ environment: "SANDBOX", connection: { version: row.version, connectedAt: row.connectedAt, webhookPath: "/api/webhooks/asaas/" + row.id } });
  }));
  router.delete("/", express.json({ limit: "1kb" }), asyncRoute(async (req, res) => {
    const { version } = parseInput(z.strictObject({ version: z.uuid() }), req.body), actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      await ownerScope(tx, actor, purpose);
      const row = await tx.asaasConnection.findUnique({ where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } } });
      if (!row || row.version !== version || (row.busyUntil && row.busyUntil > new Date())) throw new RequestError(409, "asaas-connection-changed");
      const changed = await tx.asaasConnection.updateMany({ where: { id: row.id, organizationId: actor.organizationId, version,
        disabledAt: null, OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] },
        data: { disabledAt: new Date(), sealedCredentials: Buffer.alloc(0), webhookTokenHash: "0".repeat(64) } });
      if (!changed.count) throw new RequestError(409, "asaas-connection-changed");
      await recordRegistration(tx, actor, "ASAAS_CONNECTION", row.id, "ARCHIVED");
    });
    res.status(204).end();
  }));
  return router;
}

function binding(row: AsaasCharge) {
  return { externalReference: row.externalReference, payerDocumentHash: row.payerDocumentHash, amount: row.amount.toFixed(2),
    dueDate: row.dueDate.toISOString().slice(0, 10), customerId: row.customerId };
}

async function savePayment(prisma: PrismaClient, gateway: AsaasGateway, connection: AsaasConnection, charge: AsaasCharge, result: AsaasPayment, actorUserId: string | null) {
  const verified = await gateway.use(connection, connection.sealedCredentials, (key) => gateway.client.verifyPayment(key, result, binding(charge)));
  return prisma.$transaction(async (tx) => {
    const where = { organizationId: charge.organizationId, boletoId: charge.boletoId, version: charge.version };
    const changed = await tx.asaasCharge.updateMany({ where, data: { ...verified, errorCode: null, version: { increment: 1 } } });
    if (!changed.count) throw new RequestError(409, "asaas-busy");
    await recordRegistration(tx, { organizationId: charge.organizationId, actorUserId }, "ASAAS_CHARGE", charge.boletoId, "UPDATED");
    return tx.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: charge.organizationId, boletoId: charge.boletoId } } });
  });
}

async function acquire(prisma: PrismaClient, connection: AsaasConnection) {
  const operationId = randomUUID();
  const lease = await prisma.asaasConnection.updateMany({ where: { id: connection.id, organizationId: connection.organizationId,
    version: connection.version, disabledAt: null, OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] },
    data: { operationId, busyUntil: new Date(Date.now() + 120_000) } });
  if (!lease.count) throw new RequestError(409, "asaas-busy");
  return () => prisma.asaasConnection.updateMany({ where: { id: connection.id, operationId }, data: { busyUntil: null, operationId: null } });
}

export function createAsaasChargeRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose, gateway?: AsaasGateway) {
  const router = express.Router({ mergeParams: true }), subscription = purpose === "SUBSCRIPTION";
  router.use(authorize(prisma, cookieName, ...(subscription ? ["OWNER"] as const : ["OWNER", "ADMIN"] as const)));
  if (subscription) router.use(platformOwnerOnly);
  const json = express.json({ limit: "1kb" });
  async function find(actor: Actor, target: string, id: string) {
    const row = await prisma.boleto.findUnique({ where: { organizationId: target, id, purpose }, include: { asaas: true } });
    if (!row) throw new RequestError(404, "not-found");
    const connection = await prisma.asaasConnection.findUnique({ where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } } });
    if (!gateway || !connection || connection.disabledAt) throw new RequestError(409, "asaas-unconfigured");
    if (row.provider !== "ASAAS" || (row.asaas && row.asaas.connectionId !== connection.id)) throw new RequestError(409, "asaas-charge-unavailable");
    return { row, connection };
  }
  async function scope(tx: Prisma.TransactionClient, actor: Actor, target: string) {
    await ownerScope(tx, actor, purpose, true);
    if (subscription) await lockManagedCompany(tx, target);
  }
  router.post("/:id/asaas-sandbox", json, asyncRoute(async (req, res) => {
    parseInput(testInput, req.body);
    const id = parseInput(recordId, req.params.id), actor = tenantActor(res);
    const target = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const { row, connection } = await find(actor, target, id);
    if (row.asaas) { res.json(asaasChargeView(row.asaas)); return; }
    if (row.status !== "PLANNED" || row.dueDate < today()) throw new RequestError(409, "asaas-charge-unavailable");
    const release = await acquire(prisma, connection);
    let charge: AsaasCharge | undefined;
    try {
      const reservation = await prisma.$transaction(async (tx) => {
        await scope(tx, actor, target);
        const account = await tx.receivingAccount.findUnique({ where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } } });
        const current = await tx.boleto.findUnique({ where: { organizationId: target, id, purpose, status: "PLANNED", provider: "ASAAS" }, include: { asaas: true } });
        if (!current || account?.provider !== "ASAAS") throw new RequestError(409, "asaas-charge-unavailable");
        if (current.asaas) return { charge: current.asaas, created: false, payer: null };
        let payer: { name: string; document: string; reference: string };
        if (subscription) {
          const org = await tx.organization.findUniqueOrThrow({ where: { id: target } });
          payer = { name: org.legalName, document: asaasDocument(org.cnpj ?? org.cpf ?? ""), reference: "ff:subscription:" + target };
        } else {
          const invoice = current.invoiceId ? await tx.invoice.findUnique({ where: { organizationId: target, id: current.invoiceId, discardedAt: null,
            status: { in: ["DRAFT", "AUTHORIZED"] } }, select: { customerId: true } }) : null;
          const quote = current.quoteId ? await tx.commercialOrder.findUnique({ where: { organizationId: target, id: current.quoteId, kind: "QUOTE", status: { not: "CANCELLED" },
            quoteShare: { is: { decision: "APPROVED" } } }, select: { customerId: true } }) : null;
          const customerId = quote?.customerId ?? invoice?.customerId;
          const customer = customerId && await tx.customer.findUnique({ where: { organizationId: target, id: customerId, archivedAt: null } });
          if (!customer || (current.quoteId && !quote) || (current.invoiceId && !invoice)) throw new RequestError(409, "asaas-payer-required");
          payer = { name: customer.name, document: asaasDocument(customer.federalTaxId), reference: "ff:customer:" + target + ":" + customer.id };
        }
        if (!/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(payer.document)) throw new RequestError(400, "asaas-payer-required");
        const charge = await tx.asaasCharge.create({ data: { organizationId: target, boletoId: id, accountOrganizationId: actor.organizationId,
          connectionId: connection.id, externalReference: "ff:" + randomUUID(), customerReference: payer.reference,
          payerDocumentHash: documentHash(payer.document), amount: current.amount, dueDate: current.dueDate } });
        await recordRegistration(tx, { ...actor, organizationId: target }, "ASAAS_CHARGE", id, "CREATED");
        return { charge, created: true, payer };
      });
      charge = reservation.charge;
      if (!reservation.created || !reservation.payer) { res.json(asaasChargeView(charge)); return; }
      const result = await gateway!.use(connection, connection.sealedCredentials, async (key) => {
        // externalReference is a correlation field, not an upstream idempotency guarantee.
        // Only this new persisted reservation may POST. Every retry is lookup-only.
        const existing = await gateway!.client.findPayment(key, charge!.externalReference);
        if (existing) return existing;
        const payer = reservation.payer!;
        const customerId = await gateway!.client.findCustomer(key, payer.reference, payer.document)
          ?? await gateway!.client.createCustomer(key, payer.reference, payer.name, payer.document);
        return gateway!.client.createPayment(key, { ...binding(charge!), customerId });
      });
      const saved = await savePayment(prisma, gateway!, connection, charge, result, actor.actorUserId);
      res.status(201).json(asaasChargeView(saved));
    } catch (error) {
      if (!charge) throw error;
      await prisma.asaasCharge.updateMany({ where: { organizationId: target, boletoId: id, version: charge.version },
        data: { errorCode: error instanceof RequestError ? error.code : "asaas-unavailable" } });
      res.status(202).json(asaasChargeView(await prisma.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: target, boletoId: id } } })));
    } finally { await release(); }
  }));
  router.post("/:id/asaas-sandbox/consultar", asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id), actor = tenantActor(res);
    const target = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const { row, connection } = await find(actor, target, id);
    if (!row.asaas) throw new RequestError(404, "not-found");
    await prisma.$transaction((tx) => scope(tx, actor, target));
    const release = await acquire(prisma, connection);
    try {
      const result = await gateway!.use(connection, connection.sealedCredentials, (key) => row.asaas!.paymentId
        ? gateway!.client.retrievePayment(key, row.asaas!.paymentId)
        : gateway!.client.findPayment(key, row.asaas!.externalReference));
      if (!result) { res.status(202).json(asaasChargeView(row.asaas)); return; }
      res.json(asaasChargeView(await savePayment(prisma, gateway!, connection, row.asaas, result, actor.actorUserId)));
    } finally { await release(); }
  }));
  return router;
}

export function createAsaasWebhookRouter(prisma: PrismaClient, gateway?: AsaasGateway) {
  const router = express.Router();
  const eventInput = z.object({ id: z.string().min(1).max(150), event: z.string().regex(/^PAYMENT_[A-Z_]{1,80}$/), payment: z.object({ id: asaasId }) });
  router.post("/:connectionId", express.json({ limit: "96kb" }), asyncRoute(async (req, res) => {
    if (!gateway) throw new RequestError(503, "asaas-vault-unavailable");
    const connectionId = parseInput(recordId, req.params.connectionId), supplied = req.get("asaas-access-token");
    if (!supplied || !token.safeParse(supplied).success) throw new RequestError(401, "asaas-webhook-auth");
    const connection = await prisma.asaasConnection.findUnique({ where: { id: connectionId, disabledAt: null } });
    if (!connection || !timingSafeEqual(Buffer.from(digest(supplied), "hex"), Buffer.from(connection.webhookTokenHash, "hex"))) {
      throw new RequestError(401, "asaas-webhook-auth");
    }
    const body = parseInput(eventInput, req.body);
    await prisma.asaasWebhookEvent.createMany({ data: { organizationId: connection.organizationId, connectionId, eventId: body.id, paymentId: body.payment.id }, skipDuplicates: true });
    res.json({ received: true });
  }));
  router.use(handleApiError);
  return router;
}

export async function processAsaasWebhooks(prisma: PrismaClient, gateway: AsaasGateway) {
  const events = await prisma.asaasWebhookEvent.findMany({ where: { processedAt: null, retryAfter: { lte: new Date() }, attempts: { lt: 10 } },
    orderBy: { createdAt: "asc" }, take: 10 });
  for (const event of events) {
    const claimed = await prisma.asaasWebhookEvent.updateMany({ where: { id: event.id, attempts: event.attempts, processedAt: null },
      data: { attempts: { increment: 1 }, retryAfter: new Date(Date.now() + 120_000) } });
    if (!claimed.count) continue;
    try {
      const connection = await prisma.asaasConnection.findUnique({ where: { id: event.connectionId, organizationId: event.organizationId, disabledAt: null } });
      if (!connection) continue;
      // Never trust webhook status/amount: recover the resource using the account's key.
      const result = await gateway.use(connection, connection.sealedCredentials, (key) => gateway.client.retrievePayment(key, event.paymentId));
      const charge = await prisma.asaasCharge.findFirst({ where: { connectionId: connection.id, accountOrganizationId: event.organizationId, externalReference: result.externalReference } });
      if (charge && (!charge.paymentId || charge.paymentId === result.id)) {
        const release = await acquire(prisma, connection);
        try { await savePayment(prisma, gateway, connection, charge, result, null); }
        finally { await release(); }
      }
      await prisma.asaasWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    } catch {
      // Durable event stays pending for bounded retries; no sensitive payloads in logs.
    }
  }
}
