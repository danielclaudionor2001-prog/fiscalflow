import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import type { ProductionTransportProvider } from "../fiscal/certificate-vault.ts";
import { accessKeyPattern, assertPreparedDpsMatchesNote, dpsIdPattern } from "../fiscal/documents.ts";
import { FiscalError } from "../fiscal/errors.ts";
import type { SubmissionLedger } from "../fiscal/ledger.ts";
import { createSefinAdapter, type Submission } from "../fiscal/sefin.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";
import { draftScope, lockDraftReferences } from "./drafts.ts";
import { canPrepareProduction, dpsDraftFields, hashXml, productionSourceHash, type ProductionApproval } from "./prepare-dps.ts";

const path = "/:id/production-dps/:dpsId";
const params = z.object({ id: recordId, dpsId: z.string().regex(dpsIdPattern) });
const confirmation = z.strictObject({ confirmProduction: z.literal(true) });
const reconciliation = z.strictObject({ accessKey: z.string().regex(accessKeyPattern).optional() });
type Params = z.infer<typeof params>;
type Actor = ReturnType<typeof tenantActor>;
const productionFields = {
  id: true, invoiceId: true, invoiceVersion: true, certificateVersion: true, sourceHash: true,
  signedXml: true, productionStatus: true, productionCodes: true,
} satisfies Prisma.PreparedDpsSelect;
type Prepared = Prisma.PreparedDpsGetPayload<{ select: typeof productionFields }>;

export type ProductionIssuanceConfig = { cnpj: string; approval?: ProductionApproval; transport: ProductionTransportProvider };

function scope(organizationId: string, { id, dpsId }: Params) {
  return {
    organizationId_environment_id: { organizationId, environment: "PRODUCTION" as const, id: dpsId },
    invoiceId: id,
  };
}

async function lockInvoice(tx: Prisma.TransactionClient, organizationId: string, invoiceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "organizationId" = ${organizationId} AND "id" = ${invoiceId} FOR UPDATE`;
}

function productionLedger(prisma: PrismaClient, actor: Actor, route: Params, prepared: Prepared, approval?: ProductionApproval): SubmissionLedger {
  const { organizationId, actorUserId } = actor;
  const where = scope(organizationId, route);
  function checkApproval(id: string, sha256: string) {
    if (approval?.dpsId !== id || approval.sha256 !== sha256 || sha256 !== hashXml(prepared.signedXml)) {
      throw new RequestError(423, "production-transmission-blocked");
    }
  }
  return {
    async check(id, sha256) {
      checkApproval(id, sha256);
      const row = await prisma.preparedDps.findUniqueOrThrow({ where, select: { productionStatus: true } });
      return row.productionStatus !== null;
    },
    async claim(id, sha256) {
      checkApproval(id, sha256);
      return prisma.$transaction(async (tx) => {
        await requireActiveOrganization(tx, organizationId);
        const owner = await tx.$queryRaw<{ userId: string }[]>`
          SELECT "userId" FROM "Membership" WHERE "organizationId" = ${organizationId}
          AND "userId" = ${actorUserId} AND "role" = 'OWNER' FOR SHARE
        `;
        if (!owner.length) throw new RequestError(403, "insufficient-role");
        await lockInvoice(tx, organizationId, route.id);
        const attempt = await tx.preparedDps.findUniqueOrThrow({ where, select: { productionStatus: true } });
        if (attempt.productionStatus !== null) return "previous-attempt";
        const draftWhere = { id: route.id, ...draftScope(organizationId) };
        const invoice = await tx.invoice.findUnique({ where: draftWhere, select: dpsDraftFields });
        if (!invoice || invoice.updatedAt.getTime() !== prepared.invoiceVersion.getTime()) throw new RequestError(409, "draft-changed");
        await lockDraftReferences(tx, organizationId, invoice);
        const current = await tx.invoice.findUniqueOrThrow({ where: draftWhere, select: dpsDraftFields });
        if (productionSourceHash(current) !== prepared.sourceHash) throw new RequestError(409, "draft-changed");
        const cert = await tx.$queryRaw<{ version: string; validUntil: Date }[]>`
          SELECT "version", "validUntil" FROM "FiscalCertificate" WHERE "organizationId" = ${organizationId} FOR SHARE
        `;
        if (cert[0]?.version !== prepared.certificateVersion || cert[0].validUntil.getTime() <= Date.now()) {
          throw new RequestError(409, "valid-certificate-required");
        }
        await tx.preparedDps.update({ where, data: { productionStatus: "PENDING", productionAt: new Date() } });
        await tx.invoice.update({ where: draftWhere, data: {
          status: "PROCESSING", xmlRequest: Buffer.from(prepared.signedXml).toString("utf8"),
          rejectionReason: null, updatedAt: current.updatedAt,
        } });
        await recordRegistration(tx, actor, "PRODUCTION_DPS", id, "UPDATED");
        return "reserved";
      });
    },
  };
}

async function saveResult(prisma: PrismaClient, actor: Actor, route: Params, result: Submission) {
  if (result.state === "indeterminate") return;
  const { organizationId } = actor;
  const where = scope(organizationId, route);
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, organizationId, route.id);
    const row = await tx.preparedDps.findUniqueOrThrow({ where, select: { productionStatus: true, invoiceVersion: true } });
    if (row.productionStatus !== "PENDING") return;
    const rejected = result.state === "rejected";
    await tx.invoice.update({
      where: { id: route.id, organizationId, status: "PROCESSING" },
      data: rejected ? {
        status: "DRAFT", rejectionReason: result.codes.join(", "), updatedAt: row.invoiceVersion,
      } : {
        status: "AUTHORIZED", accessKey: result.note.accessKey,
        authorizedAt: new Date(result.note.processedAt!), xmlResponse: result.note.xml.toString("utf8"),
      },
    });
    await tx.preparedDps.update({ where, data: {
      productionStatus: rejected ? "REJECTED" : "AUTHORIZED", productionAt: new Date(),
      productionCodes: rejected ? result.codes : [],
    } });
    await recordRegistration(tx, actor, "PRODUCTION_DPS", route.dpsId, "UPDATED");
  });
}

export function createProductionIssuanceRouter(prisma: PrismaClient, cookieName: string, config: ProductionIssuanceConfig) {
  const router = express.Router();
  const owner = authorize(prisma, cookieName, "OWNER");
  const limit = rateLimit({
    windowMs: 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false,
    identifier: "nfse-production-submission", keyGenerator: (_req, res) => tenantActor(res).organizationId,
    message: { code: "rate-limited" },
  });
  const json = express.json({ limit: "1kb", inflate: false });

  async function run(res: express.Response, route: Params, action: "submit" | "reconcile", accessKey?: string) {
    if (!canPrepareProduction(res.locals.auth as AuthSession, config.cnpj)) {
      throw new RequestError(404, "production-preparation-disabled");
    }
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const where = scope(organizationId, route);
    const prepared = await prisma.preparedDps.findUnique({ where, select: productionFields });
    if (!prepared) throw new RequestError(404, "dps-unavailable");
    const sha256 = hashXml(prepared.signedXml);
    const approval = action === "submit" ? config.approval : undefined;
    if (action === "submit" && (approval?.dpsId !== prepared.id || approval.sha256 !== sha256)) {
      throw new RequestError(423, "production-transmission-blocked");
    }
    if (action === "submit" ? prepared.productionStatus !== null : prepared.productionStatus !== "PENDING") {
      return { transmission: prepared.productionStatus ?? "BLOCKED", codes: prepared.productionCodes };
    }
    const cert = await prisma.fiscalCertificate.findUnique({
      where: { organizationId }, select: { version: true, sealed: true, fingerprint: true, validUntil: true },
    });
    if (!cert || cert.validUntil.getTime() <= Date.now() || (action === "submit" && cert.version !== prepared.certificateVersion)) {
      throw new RequestError(409, "valid-certificate-required");
    }
    const ledger = productionLedger(prisma, actor, route, prepared, approval);
    try {
      const result = await config.transport(
        { organizationId, version: cert.version }, cert.sealed, { cnpj: config.cnpj, fingerprint: cert.fingerprint },
        async (transport): Promise<Submission> => {
          const adapter = createSefinAdapter(transport, ledger, "PRODUCTION");
          if (action === "submit") return adapter.submit(Buffer.from(prepared.signedXml));
          const key = accessKey ?? (await adapter.lookup(prepared.id))?.accessKey;
          if (!key) return { state: "indeterminate", id: prepared.id };
          return { state: "reconciled", note: await adapter.getNote(key, prepared.id) };
        }, approval,
      );
      if (result.state === "authorized" || result.state === "reconciled") {
        assertPreparedDpsMatchesNote(Buffer.from(prepared.signedXml), result.note.xml, "PRODUCTION");
        if (!result.note.processedAt) throw new RequestError(422, "invalid-production-response");
        if (action === "submit" && result.state === "reconciled") await ledger.claim(prepared.id, sha256);
      }
      await saveResult(prisma, actor, route, result);
    } catch (error) {
      if (error instanceof FiscalError) throw new RequestError(422, error.code);
      throw error;
    }
    const saved = await prisma.preparedDps.findUniqueOrThrow({ where, select: { productionStatus: true, productionCodes: true } });
    return { transmission: saved.productionStatus ?? "RELEASED", codes: saved.productionCodes };
  }

  router.post(path + "/submit", owner, limit, json, asyncRoute(async (req, res) => {
    parseInput(confirmation, req.body);
    res.json(await run(res, parseInput(params, req.params), "submit"));
  }));
  router.post(path + "/reconcile", owner, limit, json, asyncRoute(async (req, res) => {
    const { accessKey } = parseInput(reconciliation, req.body ?? {});
    res.json(await run(res, parseInput(params, req.params), "reconcile", accessKey));
  }));
  return router;
}
