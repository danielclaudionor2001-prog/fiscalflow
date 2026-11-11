import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import type { HomologationTransportProvider } from "../fiscal/certificate-vault.ts";
import { accessKeyPattern, assertPreparedDpsMatchesNote, dpsIdPattern } from "../fiscal/documents.ts";
import { FiscalError } from "../fiscal/errors.ts";
import type { SubmissionLedger } from "../fiscal/ledger.ts";
import { createSefinHomologation, type Submission } from "../fiscal/sefin.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";

const path = "/:id/dps/:dpsId/homologation";
const routeParams = z.object({ id: recordId, dpsId: z.string().regex(dpsIdPattern) });
const consent = z.strictObject({ confirmTest: z.literal(true) });
const reconciliation = z.strictObject({ accessKey: z.string().regex(accessKeyPattern).optional() });
export const homologationResultFields = {
  id: true, homologationStatus: true, homologationKey: true, homologationCodes: true, homologationAt: true,
} satisfies Prisma.PreparedDpsSelect;
const submissionFields = {
  ...homologationResultFields, invoiceVersion: true, certificateVersion: true, signedXml: true,
  invoice: { select: { status: true, discardedAt: true, updatedAt: true } },
  organization: { select: { cnpj: true } },
} satisfies Prisma.PreparedDpsSelect;
type Result = Prisma.PreparedDpsGetPayload<{ select: typeof homologationResultFields }>;
type Prepared = Prisma.PreparedDpsGetPayload<{ select: typeof submissionFields }>;
type Actor = ReturnType<typeof tenantActor>;
type RouteParams = z.infer<typeof routeParams>;

export function homologationView(result: Result) {
  return {
    idDps: result.id,
    status: result.homologationStatus ?? "READY",
    accessKey: result.homologationKey,
    codes: result.homologationCodes,
    updatedAt: result.homologationAt,
  };
}

function scope(organizationId: string, { id, dpsId }: RouteParams) {
  return { organizationId_environment_id: { organizationId, environment: "HOMOLOGATION" as const, id: dpsId }, invoiceId: id };
}

function submissionLedger(prisma: PrismaClient, actor: Actor, params: RouteParams, prepared: Prepared): SubmissionLedger {
  const { organizationId, actorUserId } = actor;
  const where = scope(organizationId, params);
  const hash = createHash("sha256").update(prepared.signedXml).digest("hex");
  const assertDocument = (id: string, documentHash: string) => {
    if (id !== prepared.id || documentHash !== hash) throw new RequestError(409, "dps-changed");
  };

  return {
    async check(id, documentHash) {
      assertDocument(id, documentHash);
      const row = await prisma.preparedDps.findUniqueOrThrow({ where, select: { homologationStatus: true } });
      return row.homologationStatus !== null;
    },
    async claim(id, documentHash) {
      assertDocument(id, documentHash);
      return prisma.$transaction(async (tx) => {
        await requireActiveOrganization(tx, organizationId);
        const owner = await tx.$queryRaw<{ userId: string }[]>`
          SELECT "userId" FROM "Membership" WHERE "organizationId" = ${organizationId}
          AND "userId" = ${actorUserId} AND "role" = 'OWNER' FOR SHARE
        `;
        if (!owner.length) throw new RequestError(403, "insufficient-role");
        const drafts = await tx.$queryRaw<{ updatedAt: Date }[]>`
          SELECT "updatedAt" FROM "Invoice" WHERE "organizationId" = ${organizationId} AND "id" = ${params.id}
          AND "discardedAt" IS NULL AND "status" = 'DRAFT' FOR SHARE
        `;
        if (!drafts[0] || drafts[0].updatedAt.getTime() !== prepared.invoiceVersion.getTime()) {
          throw new RequestError(409, "draft-changed");
        }
        const certificates = await tx.$queryRaw<{ validUntil: Date }[]>`
          SELECT "validUntil" FROM "FiscalCertificate"
          WHERE "organizationId" = ${organizationId} AND "version" = ${prepared.certificateVersion} FOR SHARE
        `;
        if (!certificates[0] || certificates[0].validUntil.getTime() <= Date.now()) {
          throw new RequestError(409, "homologation-certificate-changed");
        }
        const { count } = await tx.preparedDps.updateMany({
          where: { organizationId, environment: "HOMOLOGATION", invoiceId: params.id, id, homologationStatus: null },
          data: { homologationStatus: "PENDING", homologationAt: new Date() },
        });
        if (count === 0) return "previous-attempt";
        await recordRegistration(tx, actor, "PREPARED_DPS", id, "UPDATED");
        return "reserved";
      });
    },
  };
}

async function recordResult(prisma: PrismaClient, actor: Actor, params: RouteParams, result: Submission) {
  if (result.state === "indeterminate") return;
  const { organizationId } = actor;
  const rejected = result.state === "rejected";
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.preparedDps.updateMany({
      where: {
        organizationId, environment: "HOMOLOGATION", invoiceId: params.id, id: params.dpsId,
        ...(rejected ? { homologationStatus: "PENDING" } : {
          OR: [{ homologationStatus: null }, { homologationStatus: { in: ["PENDING", "REJECTED"] } }],
        }),
      },
      data: rejected ? {
        homologationStatus: "REJECTED", homologationCodes: result.codes, homologationAt: new Date(),
      } : {
        homologationStatus: "AUTHORIZED", homologationKey: result.note.accessKey,
        homologationXml: Buffer.from(result.note.xml), homologationCodes: [], homologationAt: new Date(),
      },
    });
    if (count) await recordRegistration(tx, actor, "PREPARED_DPS", params.dpsId, "UPDATED");
  });
}

export function createHomologationRouter(prisma: PrismaClient, cookieName: string, withTransport: HomologationTransportProvider) {
  const router = express.Router();
  const owner = authorize(prisma, cookieName, "OWNER");
  const limit = rateLimit({
    windowMs: 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false,
    identifier: "nfse-homologation", keyGenerator: (_req, res) => tenantActor(res).organizationId,
    message: { code: "homologation-busy" },
  });

  async function state(organizationId: string, params: RouteParams) {
    const row = await prisma.preparedDps.findUnique({ where: scope(organizationId, params), select: homologationResultFields });
    if (!row) throw new RequestError(404, "dps-unavailable");
    return homologationView(row);
  }

  async function run(actor: Actor, params: RouteParams, action: "submit" | "reconcile", accessKey?: string) {
    const { organizationId } = actor;
    const prepared = await prisma.preparedDps.findUnique({ where: scope(organizationId, params), select: submissionFields });
    if (!prepared) throw new RequestError(404, "dps-unavailable");
    if (action === "submit") {
      if (prepared.homologationStatus !== null) return homologationView(prepared);
      if (prepared.invoice.status !== "DRAFT" || prepared.invoice.discardedAt ||
          prepared.invoice.updatedAt.getTime() !== prepared.invoiceVersion.getTime()) throw new RequestError(409, "draft-changed");
    } else if (prepared.homologationStatus !== "PENDING") {
      return homologationView(prepared);
    }
    const cnpj = prepared.organization.cnpj?.replace(/[./-]/g, "").toUpperCase();
    if (!cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const certificate = await prisma.fiscalCertificate.findUnique({
      where: { organizationId }, select: { version: true, sealed: true, fingerprint: true, validUntil: true },
    });
    if (!certificate || certificate.validUntil.getTime() <= Date.now()) throw new RequestError(409, "valid-certificate-required");
    if (action === "submit" && prepared.certificateVersion !== certificate.version) {
      throw new RequestError(409, "homologation-certificate-changed");
    }
    const ledger = submissionLedger(prisma, actor, params, prepared);
    try {
      const result = await withTransport(
        { organizationId, version: certificate.version }, certificate.sealed,
        { cnpj, fingerprint: certificate.fingerprint },
        async (transport): Promise<Submission> => {
          const sefin = createSefinHomologation(transport, ledger);
          if (action === "submit") return sefin.submit(Buffer.from(prepared.signedXml));
          const key = accessKey ?? (await sefin.lookup(prepared.id))?.accessKey;
          if (!key) return { state: "indeterminate", id: prepared.id };
          return { state: "reconciled", note: await sefin.getNote(key, prepared.id) };
        },
      );
      if (result.state === "authorized" || result.state === "reconciled") {
        assertPreparedDpsMatchesNote(Buffer.from(prepared.signedXml), result.note.xml);
      }
      await recordResult(prisma, actor, params, result);
    } catch (error) {
      if (error instanceof FiscalError) {
        if (action === "reconcile" && error.diagnostico) console.warn("SEFIN homologation reconciliation:", JSON.stringify(error.diagnostico));
        throw new RequestError(422, error.code);
      }
      throw error;
    }
    return state(organizationId, params);
  }

  router.get(path, owner, asyncRoute(async (req, res) => {
    res.json(await state(tenantActor(res).organizationId, parseInput(routeParams, req.params)));
  }));
  router.post(path, owner, limit, express.json({ limit: "1kb", inflate: false }), asyncRoute(async (req, res) => {
    parseInput(consent, req.body);
    res.json(await run(tenantActor(res), parseInput(routeParams, req.params), "submit"));
  }));
  router.post(path + "/reconcile", owner, limit, express.json({ limit: "1kb", inflate: false }), asyncRoute(async (req, res) => {
    const { accessKey } = parseInput(reconciliation, req.body === undefined ? {} : req.body);
    res.json(await run(tenantActor(res), parseInput(routeParams, req.params), "reconcile", accessKey));
  }));
  router.get(path + "/xml", owner, asyncRoute(async (req, res) => {
    const row = await prisma.preparedDps.findUnique({
      where: { ...scope(tenantActor(res).organizationId, parseInput(routeParams, req.params)), homologationStatus: "AUTHORIZED" },
      select: { homologationKey: true, homologationXml: true },
    });
    if (!row?.homologationXml || !row.homologationKey) throw new RequestError(404, "dps-unavailable");
    res.attachment(`nfse-teste-${row.homologationKey}.xml`).type("application/xml").send(Buffer.from(row.homologationXml));
  }));
  return router;
}
