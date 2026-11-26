import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type AutomaticInvoiceRun } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import type { CertificateVault } from "../fiscal/certificate-vault.ts";
import { prestadorDpsId } from "../fiscal/documents.ts";
import { dpsFiscalTemplate, productionDpsSigningInput } from "../fiscal/dps-draft.ts";
import { FiscalError } from "../fiscal/errors.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { certificateIsCurrent, readProductionAccess } from "../organizations/production-access.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";
import { lockDraftReferences } from "./drafts.ts";
import { dpsDraftFields, loadFiscalDefaults, nextProductionDpsNumber, prepareData, prepareInvoiceDps, type Draft } from "./prepare-dps.ts";
import { runProductionIssuance, type ProductionIssuanceConfig } from "./production-issuance.ts";
import { nextRun } from "./schedules.ts";

const contextSelect = {
  id: true, customerId: true, serviceId: true, amount: true, serviceDescription: true, contractName: true, kind: true,
  dayOfMonth: true, nextRunAt: true, updatedAt: true, automaticProduction: true,
  automaticAuthorizedBy: true, automaticAuthorizedAt: true, automaticFiscalData: true, automaticSourceHash: true,
  customer: dpsDraftFields.customer, service: dpsDraftFields.service, organization: dpsDraftFields.organization,
} satisfies Prisma.InvoiceScheduleSelect;
type Context = Prisma.InvoiceScheduleGetPayload<{ select: typeof contextSelect }>;
const periodAt = (now: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(now).slice(0, 7);

function sourceHash(context: Context, fiscal: z.infer<typeof dpsFiscalTemplate>) {
  return createHash("sha256").update(JSON.stringify({
    customerId: context.customerId, serviceId: context.serviceId, amount: context.amount.toFixed(2),
    description: context.serviceDescription, kind: context.kind,
    ...(context.contractName && { contractName: context.contractName }),
    customer: context.customer, service: context.service, organization: context.organization, fiscal,
  })).digest("hex");
}

async function fiscalContext(db: Prisma.TransactionClient, organizationId: string, id: string) {
  const context = await db.invoiceSchedule.findUnique({ where: { organizationId, id }, select: contextSelect });
  if (!context) throw new RequestError(404, "schedule-unavailable");
  if (!context.serviceId) throw new RequestError(409, "automatic-service-required");
  const defaults = await loadFiscalDefaults(db, organizationId, context);
  if (!("fiscalDefaults" in defaults)) throw new RequestError(409, "automatic-fiscal-data-required");
  const fiscal = parseInput(dpsFiscalTemplate, defaults.fiscalDefaults && (() => {
    const { nDPS: _number, ...data } = defaults.fiscalDefaults;
    return data;
  })());
  if ("valuesPerInvoice" in fiscal.totTrib) throw new RequestError(409, "automatic-fiscal-data-required");
  // Validate the same fiscal input and issuer/customer rules as manual preparation, without signing or sending.
  const input = parseInput(productionDpsSigningInput, { ...fiscal, nDPS: "1", dCompet: periodAt(new Date()) + "-01" });
  prepareData({ ...context, status: "DRAFT", updatedAt: context.updatedAt } as Draft, input, true);
  return { context, fiscal, hash: sourceHash(context, fiscal) };
}

async function requireOwner(db: Prisma.TransactionClient, organizationId: string, userId: string) {
  const owners = await db.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "Membership" WHERE "organizationId" = ${organizationId}
    AND "userId" = ${userId} AND "role" = 'OWNER' FOR SHARE
  `;
  if (!owners.length) throw new RequestError(403, "automatic-owner-required");
}

async function readiness(db: Prisma.TransactionClient, organizationId: string, id: string, available: boolean, now = new Date()) {
  if (!available) throw new RequestError(409, "automatic-engine-unavailable");
  if (await readProductionAccess(db, organizationId) !== "company") throw new RequestError(409, "automatic-company-release-required");
  const certificate = await db.fiscalCertificate.findUnique({ where: { organizationId }, select: { validFrom: true, validUntil: true } });
  if (!certificateIsCurrent(certificate, now.getTime())) throw new RequestError(409, "valid-certificate-required");
  const data = await fiscalContext(db, organizationId, id);
  return { ...data, nextRunAt: nextRun(now, 1), certificateValidUntil: certificate!.validUntil };
}

export function createAutomaticSchedulesRouter(prisma: PrismaClient, cookieName: string, vault?: CertificateVault, config?: ProductionIssuanceConfig) {
  const router = express.Router();
  const owner = authorize(prisma, cookieName, "OWNER");
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { code: "rate-limited" } });
  router.get("/:id/automatic-production", owner, limit, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id), { organizationId } = tenantActor(res);
    const context = await prisma.invoiceSchedule.findUnique({ where: { organizationId, id }, select: contextSelect });
    if (!context) throw new RequestError(404, "schedule-unavailable");
    let preview: Awaited<ReturnType<typeof readiness>> | undefined, reason: string | undefined;
    try { preview = await readiness(prisma, organizationId, id, Boolean(vault && config)); }
    catch (error) { if (!(error instanceof RequestError)) throw error; reason = error.code; }
    res.json({ enabled: context.automaticProduction, version: context.updatedAt, ready: Boolean(preview), reason,
      customerName: context.customer.name, amount: context.amount.toFixed(2), serviceDescription: context.serviceDescription,
      nextRunAt: preview?.nextRunAt, competence: preview ? periodAt(preview.nextRunAt) + "-01" : null,
      fiscalData: preview?.fiscal, certificateValidUntil: preview?.certificateValidUntil,
      policy: "FIRST_DAY_08_BRASILIA_CURRENT_MONTH", authorizedAt: context.automaticAuthorizedAt,
    });
  }));
  router.put("/:id/automatic-production", owner, limit, express.json({ limit: "1kb" }), asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const input = parseInput(z.strictObject({ enabled: z.boolean(), version: z.iso.datetime().transform((value) => new Date(value)), confirmAutomaticProduction: z.literal(true).optional() }), req.body);
    if (input.enabled && !input.confirmAutomaticProduction) throw new RequestError(400, "automatic-confirmation-required");
    const actor = tenantActor(res), { organizationId, actorUserId } = actor;
    const saved = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      await requireOwner(tx, organizationId, actorUserId);
      await tx.$queryRaw`SELECT "id" FROM "InvoiceSchedule" WHERE "organizationId" = ${organizationId} AND "id" = ${id} FOR UPDATE`;
      const current = await tx.invoiceSchedule.findUnique({ where: { organizationId, id } });
      if (!current) throw new RequestError(404, "schedule-unavailable");
      if (current.updatedAt.getTime() !== input.version.getTime()) throw new RequestError(409, "automatic-settings-changed");
      let data: Prisma.InvoiceScheduleUpdateInput;
      if (input.enabled) {
        await lockDraftReferences(tx, organizationId, current);
        const preview = await readiness(tx, organizationId, id, Boolean(vault && config));
        if (preview.certificateValidUntil <= preview.nextRunAt) throw new RequestError(409, "automatic-certificate-renewal-required");
        data = { automaticProduction: true, automaticAuthorizedBy: actorUserId, automaticAuthorizedAt: new Date(),
          automaticFiscalData: preview.fiscal, automaticSourceHash: preview.hash,
          dayOfMonth: 1, nextRunAt: preview.nextRunAt, pauseReason: null };
      } else {
        data = { automaticProduction: false, automaticAuthorizedBy: null, automaticAuthorizedAt: null,
          automaticFiscalData: Prisma.DbNull, automaticSourceHash: null, nextRunAt: null, pauseReason: null };
      }
      const result = await tx.invoiceSchedule.update({ where: { organizationId, id }, data,
        select: { id: true, automaticProduction: true, nextRunAt: true, updatedAt: true } });
      await recordRegistration(tx, actor, "INVOICE_SCHEDULE", id, "UPDATED");
      return result;
    });
    res.json(saved);
  }));
  return router;
}

async function guardIntent(tx: Prisma.TransactionClient, run: AutomaticInvoiceRun, operationId: string) {
  const current = await tx.automaticInvoiceRun.findUnique({ where: { organizationId: run.organizationId, id: run.id } });
  if (!current || current.operationId !== operationId || !current.busyUntil || current.busyUntil <= new Date()) throw new RequestError(409, "automatic-busy");
  await tx.$queryRaw`SELECT "id" FROM "InvoiceSchedule" WHERE "organizationId" = ${run.organizationId} AND "id" = ${run.scheduleId} FOR SHARE`;
  const { context, fiscal, hash } = await fiscalContext(tx, run.organizationId, run.scheduleId);
  if (!context.automaticProduction || !context.nextRunAt || context.automaticAuthorizedBy !== run.authorizedBy ||
      context.automaticSourceHash !== run.consentHash || hash !== run.consentHash) throw new RequestError(409, "automatic-approval-changed");
  await requireOwner(tx, run.organizationId, run.authorizedBy);
  if (await readProductionAccess(tx, run.organizationId) !== "company") throw new RequestError(409, "automatic-company-release-required");
  if (run.period !== periodAt(new Date())) throw new RequestError(409, "automatic-period-missed");
  const invoice = await tx.invoice.findUnique({ where: { organizationId: run.organizationId, id: run.invoiceId, discardedAt: null } });
  if (!invoice || invoice.customerId !== context.customerId || invoice.serviceId !== context.serviceId ||
      invoice.serviceDescription !== context.serviceDescription || !invoice.amount.equals(context.amount) || invoice.kind !== context.kind) {
    throw new RequestError(409, "automatic-invoice-changed");
  }
  return { context, fiscal, invoice };
}

async function reserveInput(prisma: PrismaClient, run: AutomaticInvoiceRun, operationId: string) {
  return prisma.$transaction(async (tx) => {
    // Serialize numbering reservations with manual DPS saves and with other automatic runs of this issuer.
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${run.organizationId} AND "archivedAt" IS NULL AND "accessSuspendedAt" IS NULL FOR UPDATE`;
    await requireActiveOrganization(tx, run.organizationId);
    const { context, fiscal, invoice } = await guardIntent(tx, run, operationId);
    if (invoice.status !== "DRAFT") throw new RequestError(409, "draft-changed");
    const current = await tx.automaticInvoiceRun.findUniqueOrThrow({ where: { organizationId: run.organizationId, id: run.id } });
    if (current.reservedDpsId && current.preparationInput) return { input: parseInput(productionDpsSigningInput, current.preparationInput), invoice };
    const prefix = prestadorDpsId(context.organization.cityIbgeCode!, context.organization.cnpj!.replace(/[./-]/g, ""), fiscal.serie, "1").slice(0, -15);
    const nDPS = await nextProductionDpsNumber(tx, run.organizationId, prefix);
    const input = parseInput(productionDpsSigningInput, { ...fiscal, nDPS, dCompet: run.period + "-01" });
    const reservedDpsId = prefix + nDPS.padStart(15, "0");
    await tx.automaticInvoiceRun.update({ where: { organizationId: run.organizationId, id: run.id }, data: { reservedDpsId, preparationInput: input } });
    return { input, invoice };
  });
}

async function finish(prisma: PrismaClient, run: AutomaticInvoiceRun, operationId: string, status: "AUTHORIZED" | "REJECTED" | "BLOCKED" | "PENDING", errorCode: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${run.organizationId} FOR SHARE`;
    const changed = await tx.automaticInvoiceRun.updateMany({ where: { organizationId: run.organizationId, id: run.id, operationId }, data: {
      status, errorCode, operationId: null, busyUntil: null,
      nextAttemptAt: new Date(Date.now() + 60_000), finishedAt: status === "PENDING" ? null : new Date(),
    } });
    if (!changed.count) return;
    if (status === "REJECTED" || status === "BLOCKED") await tx.invoiceSchedule.updateMany({
      where: { organizationId: run.organizationId, id: run.scheduleId, automaticSourceHash: run.consentHash },
      data: { nextRunAt: null, pauseReason: errorCode ?? "automatic-rejected" },
    });
    await recordRegistration(tx, { organizationId: run.organizationId, actorUserId: null }, "INVOICE_SCHEDULE", run.scheduleId, "UPDATED");
  });
}

export async function runAutomaticInvoices(prisma: PrismaClient, vault: CertificateVault, config: ProductionIssuanceConfig) {
  const due = await prisma.automaticInvoiceRun.findMany({
    where: { status: { in: ["QUEUED", "PROCESSING", "PENDING"] }, nextAttemptAt: { lte: new Date() },
      OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], take: 5,
  });
  for (const run of due) {
    const operationId = randomUUID();
    const claimed = await prisma.automaticInvoiceRun.updateMany({ where: { organizationId: run.organizationId, id: run.id,
      status: { in: ["QUEUED", "PROCESSING", "PENDING"] }, OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] },
      data: { operationId, busyUntil: new Date(Date.now() + 120_000), status: "PROCESSING", attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    const actor = { organizationId: run.organizationId, actorUserId: run.authorizedBy };
    try {
      let current = await prisma.automaticInvoiceRun.findUniqueOrThrow({ where: { organizationId: run.organizationId, id: run.id } });
      let prepared = current.reservedDpsId ? await prisma.preparedDps.findUnique({ where: {
        organizationId_environment_id: { organizationId: run.organizationId, environment: "PRODUCTION", id: current.reservedDpsId }, invoiceId: run.invoiceId,
      } }) : null;
      if (!prepared) {
        const { input, invoice } = await reserveInput(prisma, run, operationId);
        const result = await prepareInvoiceDps(prisma, actor, run.invoiceId, invoice.updatedAt, input, vault, {
          beforeSave: async (tx) => { await guardIntent(tx, run, operationId); },
        });
        prepared = await prisma.preparedDps.findUniqueOrThrow({ where: {
          organizationId_environment_id: { organizationId: run.organizationId, environment: "PRODUCTION", id: result.saved.id }, invoiceId: run.invoiceId,
        } });
      }
      if (prepared.productionStatus !== "AUTHORIZED" && prepared.productionStatus !== "REJECTED") {
        await runProductionIssuance(prisma, actor, { id: run.invoiceId, dpsId: prepared.id },
          prepared.productionStatus === "PENDING" ? "reconcile" : "submit", config, undefined,
          async (tx) => { await guardIntent(tx, run, operationId); });
        prepared = await prisma.preparedDps.findUniqueOrThrow({ where: { organizationId_environment_id: {
          organizationId: run.organizationId, environment: "PRODUCTION", id: prepared.id }, invoiceId: run.invoiceId } });
      }
      await finish(prisma, run, operationId, prepared.productionStatus ?? "BLOCKED", prepared.productionCodes[0] ?? null);
    } catch (error) {
      const current = await prisma.automaticInvoiceRun.findUniqueOrThrow({ where: { organizationId: run.organizationId, id: run.id } });
      const pending = current.reservedDpsId ? await prisma.preparedDps.findUnique({ where: { organizationId_environment_id: {
        organizationId: run.organizationId, environment: "PRODUCTION", id: current.reservedDpsId }, invoiceId: run.invoiceId }, select: { productionStatus: true } }) : null;
      // A reserved transmission is reconciled by GET only, including after restarts, pauses or lost responses.
      await finish(prisma, run, operationId, pending?.productionStatus === "PENDING" ? "PENDING" : "BLOCKED",
        error instanceof RequestError || error instanceof FiscalError ? error.code : "automatic-operation-failed");
    }
  }
}
