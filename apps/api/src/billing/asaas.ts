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
import { apiKeyInput, keySchema, asaasDocument, asaasId, documentHash, type AsaasPayment, type AsaasEnvironment } from "./asaas-client.ts";
import { cpfSchema } from "../registrations/input.ts";
import { hasCnpjCheckDigits } from "../invoices/cnpj-lookup.ts";
import type { AsaasGateway } from "./asaas-vault.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = z.string().min(32).max(255).regex(/^[\x21-\x7e]+$/).refine((value) => !value.startsWith("$aact_"));
const connectInput = z.strictObject({ apiKey: apiKeyInput, webhookToken: token, version: z.uuid().nullable() });
const testInput = z.strictObject({ confirmTest: z.literal(true) });
type Actor = ReturnType<typeof tenantActor>;

export function parseAsaasConnection(value: unknown, environment: AsaasEnvironment = "SANDBOX") {
  const result = connectInput.extend({ apiKey: keySchema(environment) }).safeParse(value);
  if (result.success) {
    if (result.data.apiKey === result.data.webhookToken) throw new RequestError(400, "asaas-webhook-invalid");
    return result.data;
  }
  // Report the field, never the rejected value or the Zod error payload.
  const fields = new Set(result.error.issues.map((issue) => issue.path[0]));
  if (fields.has("apiKey")) {
    const raw = value && typeof value === "object" && "apiKey" in value ? value.apiKey : undefined;
    const production = typeof raw === "string" && raw.trim().startsWith("$aact_prod_");
    throw new RequestError(400, production && environment === "SANDBOX" ? "asaas-key-production" : "asaas-key-invalid");
  }
  if (fields.has("webhookToken")) throw new RequestError(400, "asaas-webhook-invalid");
  if (fields.has("version")) throw new RequestError(409, "asaas-connection-changed");
  throw new RequestError(400, "invalid-input");
}

export function asaasChargeView(row: AsaasCharge) {
  return { environment: row.environment, status: row.status, amount: row.amount.toFixed(2), dueDate: row.dueDate.toISOString().slice(0, 10),
    bankSlipUrl: row.bankSlipUrl, invoiceUrl: row.invoiceUrl, errorCode: row.errorCode, updatedAt: row.updatedAt,
    overdue: row.status === "OVERDUE" || (row.status === "PENDING" && row.dueDate < today()) };
}

async function ownerScope(tx: Prisma.TransactionClient, actor: Actor, purpose: BillingPurpose, write = false) {
  if (purpose === "SUBSCRIPTION") { await requirePlatformOwner(tx, actor); return; }
  await requireActiveOrganization(tx, actor.organizationId);
  const member = await tx.membership.findUnique({ where: { userId_organizationId: { userId: actor.actorUserId, organizationId: actor.organizationId } }, select: { role: true } });
  if (member?.role !== "OWNER" && !(write && member?.role === "ADMIN")) throw new RequestError(403, "insufficient-role");
}

export function createAsaasConnectionRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose, gateway?: AsaasGateway, environment: AsaasEnvironment = "SANDBOX") {
  const router = express.Router();
  router.use(authorize(prisma, cookieName, "OWNER"));
  if (purpose === "SUBSCRIPTION") router.use(platformOwnerOnly);
  router.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { code: "rate-limited" } }));
  router.get("/", asyncRoute(async (_req, res) => {
    const { organizationId } = tenantActor(res);
    const connection = await prisma.asaasConnection.findUnique({ where: { organizationId_purpose_environment: { organizationId, purpose, environment } },
      select: { id: true, version: true, connectedAt: true, disabledAt: true } });
    res.json({ enabled: Boolean(gateway), environment, connection: connection && !connection.disabledAt ? {
      version: connection.version, connectedAt: connection.connectedAt, webhookPath: "/api/webhooks/asaas/" + connection.id,
    } : null });
  }));
  router.put("/", express.json({ limit: "3kb" }), asyncRoute(async (req, res) => {
    if (!gateway) throw new RequestError(503, "asaas-vault-unavailable");
    let input: z.infer<typeof connectInput>;
    try { input = parseAsaasConnection(req.body, environment); }
    catch (error) {
      if (error instanceof RequestError) console.warn("Asaas connection validation failed: " + error.code);
      throw error;
    }
    const actor = tenantActor(res);
    const company = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { cnpj: true, cpf: true } });
    const client = gateway.clientFor(environment);
    const actualDocument = await client.accountDocument(input.apiKey);
    if (actualDocument !== asaasDocument(company.cnpj ?? company.cpf ?? "")) throw new RequestError(422, "asaas-holder-mismatch");
    if (environment === "PRODUCTION") await client.assertAccountApproved(input.apiKey);
    const version = randomUUID();
    const sealedCredentials = gateway.seal({ organizationId: actor.organizationId, purpose, version, environment }, input.apiKey);
    const row = await prisma.$transaction(async (tx) => {
      await ownerScope(tx, actor, purpose);
      const where = { organizationId_purpose_environment: { organizationId: actor.organizationId, purpose, environment } };
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
        try { connection = await tx.asaasConnection.create({ data: { organizationId: actor.organizationId, purpose, environment, ...credentials } }); }
        catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new RequestError(409, "asaas-connection-changed");
          throw error;
        }
      }
      const accountData = { provider: environment === "PRODUCTION" ? "ASAAS_PRODUCTION" as const : "ASAAS" as const,
        bankName: environment === "PRODUCTION" ? "Asaas (Produção)" : "Asaas (Sandbox)", bankCode: "461", accountNumber: "", branch: null };
      await tx.receivingAccount.upsert({ where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } },
        create: { organizationId: actor.organizationId, purpose, ...accountData }, update: accountData,
      });
      await recordRegistration(tx, actor, "ASAAS_CONNECTION", connection.id, "UPDATED");
      return connection;
    });
    res.json({ environment, connection: { version: row.version, connectedAt: row.connectedAt, webhookPath: "/api/webhooks/asaas/" + row.id } });
  }));
  router.post("/webhook-token", express.json({ limit: "1kb" }), asyncRoute(async (req, res) => {
    if (!gateway) throw new RequestError(503, "asaas-vault-unavailable");
    const input = parseInput(z.strictObject({ version: z.uuid(), webhookToken: token }), req.body);
    const actor = tenantActor(res);
    const connection = await prisma.asaasConnection.findUnique({ where: {
      organizationId_purpose_environment: { organizationId: actor.organizationId, purpose, environment },
    } });
    if (!connection || connection.disabledAt || connection.version !== input.version) throw new RequestError(409, "asaas-connection-changed");
    const release = await acquire(prisma, connection);
    try {
      const version = randomUUID();
      // Version is authenticated encryption data: reseal the existing API key inside the vault.
      const sealedCredentials = await gateway.use(connection, connection.sealedCredentials,
        async (key) => gateway.seal({ organizationId: actor.organizationId, purpose, environment, version }, key));
      await prisma.$transaction(async (tx) => {
        await ownerScope(tx, actor, purpose);
        const changed = await tx.asaasConnection.updateMany({ where: {
          id: connection.id, organizationId: actor.organizationId, version: input.version, disabledAt: null,
        }, data: { version, sealedCredentials, webhookTokenHash: digest(input.webhookToken) } });
        if (!changed.count) throw new RequestError(409, "asaas-connection-changed");
        await recordRegistration(tx, actor, "ASAAS_CONNECTION", connection.id, "UPDATED");
      });
      res.json({ environment, connection: { version, connectedAt: connection.connectedAt, webhookPath: "/api/webhooks/asaas/" + connection.id } });
    } finally { await release(); }
  }));
  router.delete("/", express.json({ limit: "1kb" }), asyncRoute(async (req, res) => {
    const { version } = parseInput(z.strictObject({ version: z.uuid() }), req.body), actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      await ownerScope(tx, actor, purpose);
      const row = await tx.asaasConnection.findUnique({ where: { organizationId_purpose_environment: { organizationId: actor.organizationId, purpose, environment } } });
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
  if (connection.environment !== charge.environment) throw new RequestError(409, "asaas-charge-unavailable");
  const verified = await gateway.use(connection, connection.sealedCredentials, (key) => gateway.clientFor(connection.environment).verifyPayment(key, result, binding(charge)));
  return prisma.$transaction(async (tx) => {
    const where = { organizationId: charge.organizationId, boletoId: charge.boletoId, version: charge.version };
    const changed = await tx.asaasCharge.updateMany({ where, data: { ...verified, errorCode: null, version: { increment: 1 } } });
    if (!changed.count) throw new RequestError(409, "asaas-busy");
    if (charge.environment === "PRODUCTION") {
      const status = verified.status === "RECEIVED" ? "SETTLED" : ["DELETED", "REFUNDED"].includes(verified.status) ? "CANCELLED" : "REGISTERED";
      const boleto = await tx.boleto.findUniqueOrThrow({ where: { organizationId: charge.organizationId, id: charge.boletoId }, select: { settledAt: true } });
      await tx.boleto.update({ where: { organizationId: charge.organizationId, id: charge.boletoId }, data: {
        status, issuerReference: verified.paymentId, settledAt: status === "SETTLED" ? (boleto.settledAt ?? (result.paymentDate ? new Date(result.paymentDate) : new Date())) : null,
      } });
    }
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

export function createAsaasChargeRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose, gateway?: AsaasGateway, environment: AsaasEnvironment = "SANDBOX") {
  const router = express.Router({ mergeParams: true }), subscription = purpose === "SUBSCRIPTION";
  const production = environment === "PRODUCTION", provider = production ? "ASAAS_PRODUCTION" : "ASAAS";
  const operation = production ? "/:id/asaas-production" : "/:id/asaas-sandbox";
  router.use(authorize(prisma, cookieName, ...(subscription ? ["OWNER"] as const : ["OWNER", "ADMIN"] as const)));
  router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { code: "rate-limited" } }));
  if (subscription) router.use(platformOwnerOnly);
  const json = express.json({ limit: "1kb" });
  async function find(actor: Actor, target: string, id: string) {
    const row = await prisma.boleto.findUnique({ where: { organizationId: target, id, purpose }, include: { asaas: true } });
    if (!row) throw new RequestError(404, "not-found");
    const connection = await prisma.asaasConnection.findUnique({ where: { organizationId_purpose_environment: { organizationId: actor.organizationId, purpose, environment } } });
    if (!gateway || !connection || connection.disabledAt) throw new RequestError(409, "asaas-unconfigured");
    if (row.provider !== provider || (row.asaas && (row.asaas.connectionId !== connection.id || row.asaas.environment !== environment))) throw new RequestError(409, "asaas-charge-unavailable");
    return { row, connection };
  }
  async function scope(tx: Prisma.TransactionClient, actor: Actor, target: string) {
    await ownerScope(tx, actor, purpose, true);
    if (subscription) await lockManagedCompany(tx, target);
  }
  async function review(db: PrismaClient | Prisma.TransactionClient, target: string, id: string, connection: AsaasConnection) {
    const row = await db.boleto.findUnique({ where: { organizationId: target, id, purpose, provider, status: "PLANNED" } });
    if (!row || !row.invoiceId || row.dueDate < today() || row.quoteId) throw new RequestError(409, "asaas-authorized-invoice-required");
    const invoice = await db.invoice.findUnique({ where: { organizationId: target, id: row.invoiceId, status: "AUTHORIZED", discardedAt: null,
      authorizedAt: { not: null }, accessKey: { not: null }, xmlResponse: { not: null } }, include: { customer: true } });
    if (!invoice || invoice.customer.archivedAt || !invoice.amount.eq(row.amount)) throw new RequestError(409, "asaas-authorized-invoice-required");
    const document = asaasDocument(invoice.customer.federalTaxId);
    if (!(document.length === 11 ? cpfSchema.safeParse(document).success : hasCnpjCheckDigits(document))) throw new RequestError(400, "asaas-payer-required");
    const snapshot = [target, row.id, connection.id, connection.version, row.amount.toFixed(2), row.dueDate.toISOString(), invoice.id,
      invoice.updatedAt.toISOString(), invoice.accessKey, invoice.customer.id, document, invoice.customer.name];
    return { environment, boletoId: row.id, payerName: invoice.customer.name, payerDocument: document, amount: row.amount.toFixed(2),
      dueDate: row.dueDate.toISOString().slice(0, 10), invoiceAccessKey: invoice.accessKey, serviceDescription: invoice.serviceDescription,
      reviewHash: digest(JSON.stringify(snapshot)), notificationsDisabled: true };
  }
  if (production) router.get(operation + "/review", asyncRoute(async (req, res) => {
    const actor = tenantActor(res), target = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const id = parseInput(recordId, req.params.id), { connection } = await find(actor, target, id);
    res.json(await review(prisma, target, id, connection));
  }));
  router.post(operation, json, asyncRoute(async (req, res) => {
    const approval = production ? parseInput(z.strictObject({ confirmProduction: z.literal(true), reviewHash: z.string().regex(/^[a-f0-9]{64}$/) }), req.body) : null;
    if (!production) parseInput(testInput, req.body);
    const id = parseInput(recordId, req.params.id), actor = tenantActor(res);
    const target = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const { row, connection } = await find(actor, target, id);
    if (row.asaas) { res.json(asaasChargeView(row.asaas)); return; }
    if (row.status !== "PLANNED" || row.dueDate < today()) throw new RequestError(409, "asaas-charge-unavailable");
    const release = await acquire(prisma, connection);
    let charge: AsaasCharge | undefined;
    try {
      if (production) await gateway!.use(connection, connection.sealedCredentials, (key) => gateway!.clientFor(environment).assertAccountApproved(key));
      const reservation = await prisma.$transaction(async (tx) => {
        await scope(tx, actor, target);
        await tx.$queryRaw`SELECT "id" FROM "Boleto" WHERE "organizationId" = ${target} AND "id" = ${id} FOR UPDATE`;
        const account = await tx.receivingAccount.findUnique({ where: { organizationId_purpose: { organizationId: actor.organizationId, purpose } } });
        const current = await tx.boleto.findUnique({ where: { organizationId: target, id, purpose, status: "PLANNED", provider }, include: { asaas: true } });
        if (!current || account?.provider !== provider) throw new RequestError(409, "asaas-charge-unavailable");
        if (current.asaas) return { charge: current.asaas, created: false, payer: null };
        if (production) {
          if (current.invoiceId) {
            await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "organizationId" = ${target} AND "id" = ${current.invoiceId} FOR SHARE`;
            await tx.$queryRaw`SELECT c."id" FROM "Customer" c JOIN "Invoice" i ON c."organizationId" = i."organizationId" AND c."id" = i."customerId"
              WHERE i."organizationId" = ${target} AND i."id" = ${current.invoiceId} FOR SHARE OF c`;
          }
          const actual = await review(tx, target, id, connection);
          if (actual.reviewHash !== approval!.reviewHash) throw new RequestError(409, "asaas-review-changed");
        }
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
          connectionId: connection.id, environment, externalReference: "ff:" + randomUUID(), customerReference: payer.reference,
          payerDocumentHash: documentHash(payer.document), amount: current.amount, dueDate: current.dueDate } });
        await recordRegistration(tx, { ...actor, organizationId: target }, "ASAAS_CHARGE", id, "CREATED");
        return { charge, created: true, payer };
      });
      charge = reservation.charge;
      if (!reservation.created || !reservation.payer) { res.json(asaasChargeView(charge)); return; }
      const result = await gateway!.use(connection, connection.sealedCredentials, async (key) => {
        const client = gateway!.clientFor(environment);
        // externalReference is a correlation field, not an upstream idempotency guarantee.
        // Only this new persisted reservation may POST. Every retry is lookup-only.
        const existing = await client.findPayment(key, charge!.externalReference);
        if (existing) return existing;
        const payer = reservation.payer!;
        const customerId = await client.findCustomer(key, payer.reference, payer.document)
          ?? await client.createCustomer(key, payer.reference, payer.name, payer.document);
        return client.createPayment(key, { ...binding(charge!), customerId });
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
  router.post(operation + "/consultar", asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id), actor = tenantActor(res);
    const target = subscription ? parseInput(recordId, req.params.companyId) : actor.organizationId;
    const { row, connection } = await find(actor, target, id);
    if (!row.asaas) throw new RequestError(404, "not-found");
    await prisma.$transaction((tx) => scope(tx, actor, target));
    const release = await acquire(prisma, connection);
    try {
      const result = await gateway!.use(connection, connection.sealedCredentials, (key) => row.asaas!.paymentId
        ? gateway!.clientFor(environment).retrievePayment(key, row.asaas!.paymentId)
        : gateway!.clientFor(environment).findPayment(key, row.asaas!.externalReference));
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
      const result = await gateway.use(connection, connection.sealedCredentials, (key) => gateway.clientFor(connection.environment).retrieveWebhookPayment(key, event.paymentId));
      const charge = result && await prisma.asaasCharge.findFirst({ where: { connectionId: connection.id, accountOrganizationId: event.organizationId, externalReference: result.externalReference } });
      if (result && charge && (!charge.paymentId || charge.paymentId === result.id)) {
        const release = await acquire(prisma, connection);
        try { await savePayment(prisma, gateway, connection, charge, result, null); }
        finally { await release(); }
      }
      await prisma.asaasWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    } catch (error) {
      // Durable event stays pending for bounded retries; no sensitive payloads in logs.
      console.warn("Asaas webhook processing deferred: " + (error instanceof RequestError ? error.code : "internal"));
    }
  }
}
