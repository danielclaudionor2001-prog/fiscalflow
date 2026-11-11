import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import type { CertificateVault } from "../fiscal/certificate-vault.ts";
import { prestadorDpsId } from "../fiscal/documents.ts";
import { createUnsignedDps, dpsPreparationInput, parseDpsDraft } from "../fiscal/dps-draft.ts";
import { FiscalError } from "../fiscal/errors.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { recordId } from "../registrations/input.ts";
import { draftScope, draftVersion, lockDraftReferences } from "./drafts.ts";
import { homologationResultFields, homologationView } from "./homologation.ts";
import type { z } from "zod";

const draftFields = {
  id: true, updatedAt: true, amount: true, serviceDescription: true, customerId: true, serviceId: true,
  customer: { select: { name: true, federalTaxId: true, archivedAt: true } },
  service: { select: { nationalServiceCode: true, municipalServiceCode: true, active: true, archivedAt: true } },
  organization: { select: { cnpj: true, cityIbgeCode: true, municipalRegistration: true } },
} satisfies Prisma.InvoiceSelect;
const preparedFields = {
  id: true, invoiceId: true, invoiceVersion: true, certificateVersion: true, inputHash: true, preparedAt: true,
} satisfies Prisma.PreparedDpsSelect;
type Draft = Prisma.InvoiceGetPayload<{ select: typeof draftFields }>;
type Prepared = Prisma.PreparedDpsGetPayload<{ select: typeof preparedFields }>;

const digitsAndLetters = (document: string) => document.replace(/[./-]/g, "").toUpperCase();
const signedView = ({ id, preparedAt }: Prepared) => ({ state: "locally-signed", idDps: id, preparedAt });

function prepareData(draft: Draft, input: z.infer<typeof dpsPreparationInput>) {
  if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
  if (!draft.organization.cityIbgeCode) throw new RequestError(409, "issuer-city-required");
  if (draft.customer.archivedAt) throw new RequestError(409, "customer-unavailable");
  if (draft.service && (!draft.service.active || draft.service.archivedAt)) throw new RequestError(409, "service-unavailable");
  try {
    return parseDpsDraft({
      ...input,
      cnpjPrestador: digitsAndLetters(draft.organization.cnpj),
      cLocEmi: draft.organization.cityIbgeCode,
      inscricaoMunicipal: draft.organization.municipalRegistration ?? undefined,
      tomador: { documento: digitsAndLetters(draft.customer.federalTaxId), nome: draft.customer.name },
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

export function createDpsPreparationRouter(prisma: PrismaClient, cookieName: string, vault?: CertificateVault, homologationEnabled = false) {
  const router = express.Router();
  const canPrepare = authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const json = express.json({ limit: "8kb", inflate: false });

  router.get("/:id/dps", canPrepare, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { organizationId } = tenantActor(res);
    const draft = await prisma.invoice.findUnique({
      where: { id, ...draftScope(organizationId), organization: { archivedAt: null } }, select: draftFields,
    });
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const canHomologate = homologationEnabled && (res.locals.auth as AuthSession).membership.role === "OWNER";
    const [certificate, prepared, attempts] = await Promise.all([
      prisma.fiscalCertificate.findUnique({ where: { organizationId }, select: { version: true, validUntil: true } }),
      prisma.preparedDps.findFirst({
        where: { organizationId, invoiceId: id }, orderBy: [{ preparedAt: "desc" }, { id: "desc" }], select: preparedFields,
      }),
      canHomologate ? prisma.preparedDps.findMany({
        where: { organizationId, invoiceId: id, homologationStatus: { not: null } },
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
      prepared: prepared && {
        ...signedView(prepared),
        current: available && prepared.certificateVersion === certificate?.version &&
          prepared.invoiceVersion.getTime() === draft.updatedAt.getTime(),
      },
    });
  }));

  router.post("/:id/dps", canPrepare, json, asyncRoute(async (req, res) => {
    if (!vault) throw new RequestError(503, "certificate-unavailable");
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const input = parseInput(dpsPreparationInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const where = { id, ...draftScope(organizationId), organization: { archivedAt: null } };
    const [draft, certificate] = await Promise.all([
      prisma.invoice.findUnique({ where, select: draftFields }),
      prisma.fiscalCertificate.findUnique({
        where: { organizationId }, select: { version: true, validUntil: true, fingerprint: true, sealed: true },
      }),
    ]);
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (draft.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "draft-changed");
    if (!certificate || certificate.validUntil.getTime() <= Date.now()) throw new RequestError(409, "valid-certificate-required");
    const data = prepareData(draft, input);
    const hash = inputHash(data);
    const dpsId = prestadorDpsId(data.cLocEmi, data.cnpjPrestador, data.serie, data.nDPS);
    const key = { organizationId_id: { organizationId, id: dpsId } };
    const replay = await prisma.preparedDps.findUnique({ where: key, select: preparedFields });
    if (replay) {
      checkReplay(replay, id, version, certificate.version, hash);
      res.json(signedView(replay));
      return;
    }

    const binding = { organizationId, version: certificate.version };
    const { signed, fingerprint } = await vault.sign(binding, certificate.sealed, data.cnpjPrestador, createUnsignedDps(data));
    if (signed?.id !== dpsId || fingerprint !== certificate.fingerprint) throw new RequestError(422, "signing-failed");
    const { saved, created } = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const member = await tx.membership.findUnique({
        where: { userId_organizationId: { organizationId, userId: actor.actorUserId } }, select: { role: true },
      });
      if (!member || !["OWNER", "ADMIN", "OPERATOR"].includes(member.role)) throw new RequestError(403, "insufficient-role");
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR SHARE`;
      await lockDraftReferences(tx, organizationId, draft);
      const current = await tx.invoice.findUnique({ where, select: draftFields });
      if (!current || current.updatedAt.getTime() !== version.getTime() || inputHash(prepareData(current, input)) !== hash) {
        throw new RequestError(409, "draft-changed");
      }
      const active = await tx.$queryRaw<{ validUntil: Date }[]>`
        SELECT "validUntil" FROM "FiscalCertificate"
        WHERE "organizationId" = ${organizationId} AND "version" = ${certificate.version} FOR SHARE
      `;
      if (!active.length || active[0].validUntil.getTime() <= Date.now()) throw new RequestError(409, "valid-certificate-required");
      const { count } = await tx.preparedDps.createMany({
        data: { organizationId, id: dpsId, invoiceId: id, invoiceVersion: version,
          certificateVersion: certificate.version, inputHash: hash, signedXml: Buffer.from(signed.xml) },
        skipDuplicates: true,
      });
      const saved = await tx.preparedDps.findUniqueOrThrow({ where: key, select: preparedFields });
      checkReplay(saved, id, version, certificate.version, hash);
      if (count) await recordRegistration(tx, actor, "PREPARED_DPS", dpsId, "CREATED");
      return { saved, created: count === 1 };
    });
    res.status(created ? 201 : 200).json(signedView(saved));
  }));
  return router;
}
