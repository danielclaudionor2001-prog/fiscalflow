import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import type { CertificateVault } from "../fiscal/certificate-vault.ts";
import { prestadorDpsId, productionDpsSchemaRevision, readLocalDpsSummary, type DpsEnvironment } from "../fiscal/documents.ts";
import { createUnsignedDps, homologationDpsPreparationInput, parseDpsDraft, productionDpsPreparationInput } from "../fiscal/dps-draft.ts";
import { FiscalError } from "../fiscal/errors.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";
import { draftScope, draftVersion, lockDraftReferences } from "./drafts.ts";
import { homologationResultFields, homologationView } from "./homologation.ts";
import type { z } from "zod";

export const dpsDraftFields = {
  id: true, updatedAt: true, status: true, amount: true, serviceDescription: true, customerId: true, serviceId: true,
  customer: { select: { name: true, federalTaxId: true, archivedAt: true } },
  service: { select: { nationalServiceCode: true, municipalServiceCode: true, active: true, archivedAt: true } },
  organization: { select: { cnpj: true, cityIbgeCode: true, municipalRegistration: true } },
} satisfies Prisma.InvoiceSelect;
const preparedFields = {
  id: true, invoiceId: true, invoiceVersion: true, certificateVersion: true, inputHash: true, preparedAt: true,
  sourceHash: true, signedXml: true, productionStatus: true, productionCodes: true,
} satisfies Prisma.PreparedDpsSelect;
type Draft = Prisma.InvoiceGetPayload<{ select: typeof dpsDraftFields }>;
type Prepared = Prisma.PreparedDpsGetPayload<{ select: typeof preparedFields }>;
type PreparationInput = z.infer<typeof productionDpsPreparationInput> & z.infer<typeof homologationDpsPreparationInput>;
export type ProductionApproval = { dpsId: string; sha256: string };

const digitsAndLetters = (document: string) => document.replace(/[./-]/g, "").toUpperCase();
const signedView = ({ id, preparedAt }: Prepared) => ({ state: "locally-signed", idDps: id, preparedAt });
export const hashXml = (xml: Uint8Array) => createHash("sha256").update(xml).digest("hex");
export const productionSourceHash = (draft: Draft) => createHash("sha256").update(JSON.stringify(draft)).digest("hex");

export function canPrepareProduction(session: AuthSession, cnpj?: string) {
  return Boolean(cnpj && session.membership.role === "OWNER" && session.membership.organization.cnpj &&
    digitsAndLetters(session.membership.organization.cnpj) === cnpj);
}

function productionView(prepared: Prepared, approval?: ProductionApproval) {
  const sha256 = hashXml(prepared.signedXml);
  return {
    ...signedView(prepared), sha256, layoutRevision: productionDpsSchemaRevision,
    transmission: prepared.productionStatus ?? (approval?.dpsId === prepared.id && approval.sha256 === sha256 ? "RELEASED" : "BLOCKED"),
    codes: prepared.productionCodes,
    details: readLocalDpsSummary(Buffer.from(prepared.signedXml), "PRODUCTION"),
  };
}

function prepareData(draft: Draft, input: PreparationInput, production: boolean) {
  if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
  if (!draft.organization.cityIbgeCode) throw new RequestError(409, "issuer-city-required");
  if (draft.customer.archivedAt) throw new RequestError(409, "customer-unavailable");
  if (draft.service && (!draft.service.active || draft.service.archivedAt)) throw new RequestError(409, "service-unavailable");
  const { buyerAddress, omitIssuerMunicipalRegistration, ...fiscal } = input;
  const municipalRegistration = production || !omitIssuerMunicipalRegistration ? draft.organization.municipalRegistration : null;
  if (production) {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
    if (fiscal.dCompet > today) throw new RequestError(422, "future-competence");
    if (fiscal.tpRetISSQN === "2" && !buyerAddress) throw new RequestError(422, "buyer-address-required");
  }
  try {
    return parseDpsDraft({
      ...fiscal,
      cnpjPrestador: digitsAndLetters(draft.organization.cnpj),
      cLocEmi: draft.organization.cityIbgeCode,
      inscricaoMunicipal: municipalRegistration ?? undefined,
      tomador: { documento: digitsAndLetters(draft.customer.federalTaxId), nome: draft.customer.name, address: buyerAddress },
      xDescServ: draft.serviceDescription,
      vServ: draft.amount.toFixed(2),
    });
  } catch (error) {
    if (error instanceof FiscalError) throw new RequestError(422, error.code);
    throw error;
  }
}

const inputHash = (data: ReturnType<typeof prepareData>) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

function checkReplay(saved: Prepared, invoiceId: string, version: Date, certificateVersion: string, hash: string) {
  if (saved.invoiceId !== invoiceId || saved.invoiceVersion.getTime() !== version.getTime() ||
      saved.certificateVersion !== certificateVersion || saved.inputHash !== hash) {
    throw new RequestError(409, "dps-number-in-use");
  }
}

export function createDpsPreparationRouter(
  prisma: PrismaClient, cookieName: string, vault?: CertificateVault,
  { environment = "HOMOLOGATION", homologationEnabled = false, productionCnpj, approval }: {
    environment?: DpsEnvironment; homologationEnabled?: boolean; productionCnpj?: string; approval?: ProductionApproval;
  } = {},
) {
  const router = express.Router();
  const production = environment === "PRODUCTION";
  const path = production ? "/:id/production-dps" : "/:id/dps";
  const canPrepare = production ? authorize(prisma, cookieName, "OWNER") : authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const json = express.json({ limit: "8kb", inflate: false });
  const limit = rateLimit({
    windowMs: 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false,
    identifier: "nfse-production-preparation", keyGenerator: (_req, res) => tenantActor(res).organizationId,
    message: { code: "rate-limited" },
  });

  router.get(path, canPrepare, asyncRoute(async (req, res) => {
    const session = res.locals.auth as AuthSession;
    const productionEnabled = canPrepareProduction(session, productionCnpj);
    if (production && !productionEnabled) throw new RequestError(404, "production-preparation-disabled");
    const id = parseInput(recordId, req.params.id);
    const { organizationId } = tenantActor(res);
    const draft = await prisma.invoice.findUnique({
      where: {
        id, organizationId, discardedAt: null, organization: { archivedAt: null },
        status: production ? { in: ["DRAFT", "PROCESSING"] } : "DRAFT",
      }, select: dpsDraftFields,
    });
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const canHomologate = !production && homologationEnabled && session.membership.role === "OWNER";
    const [certificate, prepared, attempts] = await Promise.all([
      prisma.fiscalCertificate.findUnique({ where: { organizationId }, select: { version: true, validUntil: true } }),
      prisma.preparedDps.findFirst({
        where: {
          organizationId, invoiceId: id, environment,
          ...(production && draft.status === "PROCESSING" && { productionStatus: "PENDING" }),
        },
        orderBy: [{ preparedAt: "desc" }, { id: "desc" }], select: preparedFields,
      }),
      canHomologate ? prisma.preparedDps.findMany({
        where: { organizationId, invoiceId: id, environment: "HOMOLOGATION", homologationStatus: { not: null } },
        orderBy: [{ homologationAt: "desc" }, { id: "desc" }], take: 12, select: homologationResultFields,
      }) : null,
    ]);
    const available = Boolean(vault && certificate && certificate.validUntil.getTime() > Date.now());
    res.json({
      draftVersion: draft.updatedAt,
      issuerCity: draft.organization.cityIbgeCode,
      nationalServiceCode: draft.service?.nationalServiceCode ?? null,
      municipalServiceCode: draft.service?.municipalServiceCode ?? null,
      certificateAvailable: available,
      homologation: attempts?.map(homologationView) ?? null,
      ...(!production && draft.organization.municipalRegistration && { hasIssuerMunicipalRegistration: true }),
      ...(productionEnabled && { productionEnabled: true }),
      ...(production && { customerName: draft.customer.name, description: draft.serviceDescription, amount: draft.amount.toFixed(2) }),
      prepared: prepared && {
        ...(production ? productionView(prepared, approval) : signedView(prepared)),
        current: available && prepared.certificateVersion === certificate?.version &&
          prepared.invoiceVersion.getTime() === draft.updatedAt.getTime() &&
          (!production || prepared.sourceHash === productionSourceHash(draft)),
      },
    });
  }));

  router.post(path, canPrepare, ...(production ? [limit] : []), json, asyncRoute(async (req, res) => {
    if (production && !canPrepareProduction(res.locals.auth as AuthSession, productionCnpj)) {
      throw new RequestError(404, "production-preparation-disabled");
    }
    if (!vault) throw new RequestError(503, "certificate-unavailable");
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const input = parseInput(production ? productionDpsPreparationInput : homologationDpsPreparationInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const where = { id, ...draftScope(organizationId), organization: { archivedAt: null } };
    const [draft, certificate] = await Promise.all([
      prisma.invoice.findUnique({ where, select: dpsDraftFields }),
      prisma.fiscalCertificate.findUnique({
        where: { organizationId }, select: { version: true, validUntil: true, fingerprint: true, sealed: true },
      }),
    ]);
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (draft.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "draft-changed");
    if (!certificate || certificate.validUntil.getTime() <= Date.now()) throw new RequestError(409, "valid-certificate-required");
    const data = prepareData(draft, input, production);
    const hash = inputHash(data);
    const dpsId = prestadorDpsId(data.cLocEmi, data.cnpjPrestador, data.serie, data.nDPS);
    const key = { organizationId_environment_id: { organizationId, environment, id: dpsId } };
    const view = (saved: Prepared) => production ? productionView(saved, approval) : signedView(saved);
    const replay = await prisma.preparedDps.findUnique({ where: key, select: preparedFields });
    if (replay) {
      checkReplay(replay, id, version, certificate.version, hash);
      if (production && replay.sourceHash !== productionSourceHash(draft)) throw new RequestError(409, "draft-changed");
      res.json(view(replay));
      return;
    }

    const binding = { organizationId, version: certificate.version };
    const { signed, fingerprint } = await vault.sign(
      binding, certificate.sealed, data.cnpjPrestador, createUnsignedDps(data, new Date(), environment), environment,
    );
    if (signed?.id !== dpsId || fingerprint !== certificate.fingerprint) throw new RequestError(422, "signing-failed");
    const { saved, created } = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const member = await tx.membership.findUnique({
        where: { userId_organizationId: { organizationId, userId: actor.actorUserId } }, select: { role: true },
      });
      if (!member || !(production ? ["OWNER"] : ["OWNER", "ADMIN", "OPERATOR"]).includes(member.role)) {
        throw new RequestError(403, "insufficient-role");
      }
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR SHARE`;
      await lockDraftReferences(tx, organizationId, draft);
      const current = await tx.invoice.findUnique({ where, select: dpsDraftFields });
      if (!current || current.updatedAt.getTime() !== version.getTime() || inputHash(prepareData(current, input, production)) !== hash) {
        throw new RequestError(409, "draft-changed");
      }
      const active = await tx.$queryRaw<{ validUntil: Date }[]>`
        SELECT "validUntil" FROM "FiscalCertificate"
        WHERE "organizationId" = ${organizationId} AND "version" = ${certificate.version} FOR SHARE
      `;
      if (!active.length || active[0].validUntil.getTime() <= Date.now()) throw new RequestError(409, "valid-certificate-required");
      const { count } = await tx.preparedDps.createMany({
        data: { organizationId, environment, id: dpsId, invoiceId: id, invoiceVersion: version,
          sourceHash: production ? productionSourceHash(current) : null,
          certificateVersion: certificate.version, inputHash: hash, signedXml: Buffer.from(signed.xml) },
        skipDuplicates: true,
      });
      const saved = await tx.preparedDps.findUniqueOrThrow({ where: key, select: preparedFields });
      checkReplay(saved, id, version, certificate.version, hash);
      if (production && saved.sourceHash !== productionSourceHash(current)) throw new RequestError(409, "draft-changed");
      if (count) await recordRegistration(tx, actor, production ? "PRODUCTION_DPS" : "PREPARED_DPS", dpsId, "CREATED");
      return { saved, created: count === 1 };
    });
    res.status(created ? 201 : 200).json(view(saved));
  }));
  return router;
}
