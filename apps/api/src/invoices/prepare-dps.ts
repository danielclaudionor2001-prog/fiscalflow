import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import type { CertificateVault } from "../fiscal/certificate-vault.ts";
import { prestadorDpsId, productionDpsSchemaRevision, readAuthorizedDpsDefaults, readLocalDpsSummary, type DpsEnvironment } from "../fiscal/documents.ts";
import { createUnsignedDps, dpsFiscalTemplate, homologationDpsPreparationInput, parseDpsDraft, productionDpsSigningInput, serviceDpsFiscalTemplate } from "../fiscal/dps-draft.ts";
import { FiscalError } from "../fiscal/errors.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { approvalForDps, certificateIsCurrent, readProductionAccess, type ProductionApproval } from "../organizations/production-access.ts";
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
type PreparationInput = z.infer<typeof productionDpsSigningInput> & z.infer<typeof homologationDpsPreparationInput>;

const digitsAndLetters = (document: string) => document.replace(/[./-]/g, "").toUpperCase();
const signedView = ({ id, preparedAt }: Prepared) => ({ state: "locally-signed", idDps: id, preparedAt });
export const hashXml = (xml: Uint8Array) => createHash("sha256").update(xml).digest("hex");
export const productionSourceHash = (draft: Draft) => createHash("sha256").update(JSON.stringify(draft)).digest("hex");

export function productionIssuerForSession(session: AuthSession) {
  const { organization, role } = session.membership;
  if (role !== "OWNER" || !organization.cnpj) return;
  return digitsAndLetters(organization.cnpj);
}

function productionView(prepared: Prepared, access: Awaited<ReturnType<typeof readProductionAccess>>, approval?: ProductionApproval) {
  const sha256 = hashXml(prepared.signedXml);
  return {
    ...signedView(prepared), sha256, layoutRevision: productionDpsSchemaRevision,
    transmission: prepared.productionStatus ?? (approvalForDps(access, prepared.id, sha256, approval) ? "RELEASED" : "BLOCKED"),
    codes: prepared.productionCodes,
    details: readLocalDpsSummary(Buffer.from(prepared.signedXml), "PRODUCTION"),
  };
}

function prepareData(draft: Draft, input: PreparationInput, production: boolean) {
  if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
  if (!draft.organization.cityIbgeCode) throw new RequestError(409, "issuer-city-required");
  if (draft.customer.archivedAt) throw new RequestError(409, "customer-unavailable");
  if (draft.service && (!draft.service.active || draft.service.archivedAt)) throw new RequestError(409, "service-unavailable");
  const { buyerAddress, omitIssuerMunicipalRegistration, rememberFiscalData: _remember, rememberServiceFiscalData: _service, ...fiscal } = input;
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

function templateKey(organizationId: string, draft: Draft) {
  const service = draft.serviceId
    ? [draft.serviceId, draft.service?.nationalServiceCode, draft.service?.municipalServiceCode]
    : [null, draft.serviceDescription.trim().replace(/\s+/g, " ")];
  const serviceKey = createHash("sha256").update(JSON.stringify(service)).digest("hex");
  return { organizationId, customerId: draft.customerId, serviceKey };
}

async function authorizedFiscalDefaults(prisma: PrismaClient, organizationId: string, draft: Draft) {
  const previous = await prisma.preparedDps.findFirst({
    where: {
      organizationId, environment: "PRODUCTION", productionStatus: "AUTHORIZED",
      invoice: {
        organizationId, customerId: draft.customerId, serviceId: draft.serviceId, status: "AUTHORIZED",
        ...(draft.serviceId === null && { serviceDescription: { equals: draft.serviceDescription, mode: "insensitive" } }),
      },
    },
    orderBy: [{ productionAt: "desc" }, { id: "desc" }],
    select: { signedXml: true },
  });
  if (!previous) return;
  try {
    const note = readAuthorizedDpsDefaults(Buffer.from(previous.signedXml));
    if (note.cnpj !== digitsAndLetters(draft.organization.cnpj ?? "") ||
        note.issuerCity !== draft.organization.cityIbgeCode ||
        note.customerDocument !== digitsAndLetters(draft.customer.federalTaxId) ||
        (draft.service?.nationalServiceCode && note.fiscalData.cTribNac !== draft.service.nationalServiceCode) ||
        (draft.service?.municipalServiceCode && note.fiscalData.cTribMun !== draft.service.municipalServiceCode)) return;
    return dpsFiscalTemplate.safeParse(note.fiscalData).data;
  } catch (error) {
    if (!(error instanceof FiscalError)) throw error;
  }
}

async function loadFiscalDefaults(prisma: PrismaClient, organizationId: string, draft: Draft) {
  const { cnpj, cityIbgeCode } = draft.organization;
  if (!cnpj || !cityIbgeCode || draft.customer.archivedAt ||
      (draft.service && (!draft.service.active || draft.service.archivedAt))) return {};
  const scope = templateKey(organizationId, draft);
  const row = await prisma.dpsFiscalTemplate.findUnique({
    where: { organizationId_customerId_serviceKey: scope }, select: { fiscalData: true },
  });
  let fiscal = dpsFiscalTemplate.safeParse(row?.fiscalData).data;
  if (!fiscal) fiscal = await authorizedFiscalDefaults(prisma, organizationId, draft);
  if (!fiscal && draft.serviceId) {
    const service = await prisma.serviceDpsFiscalTemplate.findUnique({
      where: { organizationId_serviceId: { organizationId, serviceId: draft.serviceId } },
      select: { serviceKey: true, fiscalData: true },
    });
    if (service?.serviceKey === scope.serviceKey) fiscal = serviceDpsFiscalTemplate.safeParse(service.fiscalData).data;
  }
  const prefix = prestadorDpsId(cityIbgeCode, digitsAndLetters(cnpj), fiscal?.serie ?? "0", "1").slice(0, fiscal ? -15 : -20);
  const latest = await prisma.preparedDps.findFirst({
    where: { organizationId, environment: "PRODUCTION", id: { startsWith: prefix } },
    orderBy: fiscal ? { id: "desc" } : [{ preparedAt: "desc" }, { id: "desc" }], select: { id: true },
  });
  if (fiscal) {
    const nDPS = String(Number(latest?.id.slice(-15) ?? 0) + 1);
    return { fiscalDefaults: { ...fiscal, nDPS: nDPS.length <= 15 ? nDPS : "" } };
  }
  if (!latest) return {};
  const seriesPrefix = latest.id.slice(0, -15);
  const latestInSeries = await prisma.preparedDps.findFirst({
    where: { organizationId, environment: "PRODUCTION", id: { startsWith: seriesPrefix } },
    orderBy: { id: "desc" }, select: { id: true },
  });
  const nDPS = String(Number(latestInSeries?.id.slice(-15) ?? 0) + 1);
  return { numbering: { serie: String(Number(latest.id.slice(-20, -15))), nDPS: nDPS.length <= 15 ? nDPS : "" } };
}

function checkReplay(saved: Prepared, invoiceId: string, version: Date, certificateVersion: string, hash: string) {
  if (saved.invoiceId !== invoiceId || saved.invoiceVersion.getTime() !== version.getTime() ||
      saved.certificateVersion !== certificateVersion || saved.inputHash !== hash) {
    throw new RequestError(409, "dps-number-in-use");
  }
}

export function createDpsPreparationRouter(
  prisma: PrismaClient, cookieName: string, vault?: CertificateVault,
  { environment = "HOMOLOGATION", homologationEnabled = false, productionCnpjs, approval }: {
    environment?: DpsEnvironment; homologationEnabled?: boolean; productionCnpjs?: ReadonlySet<string>; approval?: ProductionApproval;
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
    const id = parseInput(recordId, req.params.id);
    const { organizationId } = tenantActor(res);
    const access = vault && productionIssuerForSession(session) ? await readProductionAccess(prisma, organizationId, productionCnpjs) : undefined;
    const productionEnabled = Boolean(access);
    const draft = await prisma.invoice.findUnique({
      where: {
        id, organizationId, discardedAt: null, organization: { archivedAt: null },
        status: production ? { in: ["DRAFT", "PROCESSING", "AUTHORIZED"] } : "DRAFT",
      }, select: dpsDraftFields,
    });
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (production && !productionEnabled && draft.status === "DRAFT") {
      throw new RequestError(404, "production-preparation-disabled");
    }
    if (!draft.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const canHomologate = !production && homologationEnabled && session.membership.role === "OWNER";
    const [certificate, prepared, attempts, defaults] = await Promise.all([
      prisma.fiscalCertificate.findUnique({ where: { organizationId }, select: { version: true, validFrom: true, validUntil: true } }),
      prisma.preparedDps.findFirst({
        where: {
          organizationId, invoiceId: id, environment,
          ...(production && draft.status === "PROCESSING" && { productionStatus: "PENDING" }),
          ...(production && draft.status === "AUTHORIZED" && { productionStatus: "AUTHORIZED" }),
        },
        orderBy: [{ preparedAt: "desc" }, { id: "desc" }], select: preparedFields,
      }),
      canHomologate ? prisma.preparedDps.findMany({
        where: { organizationId, invoiceId: id, environment: "HOMOLOGATION", homologationStatus: { not: null } },
        orderBy: [{ homologationAt: "desc" }, { id: "desc" }], take: 12, select: homologationResultFields,
      }) : null,
      production && draft.status === "DRAFT" ? loadFiscalDefaults(prisma, organizationId, draft) : undefined,
    ]);
    if (production && draft.status === "AUTHORIZED" && !prepared) throw new RequestError(404, "draft-unavailable");
    const available = Boolean(vault && certificateIsCurrent(certificate));
    res.json({
      draftVersion: draft.updatedAt,
      issuerCity: draft.organization.cityIbgeCode,
      nationalServiceCode: draft.service?.nationalServiceCode ?? null,
      municipalServiceCode: draft.service?.municipalServiceCode ?? null,
      certificateAvailable: available,
      homologation: attempts?.map(homologationView) ?? null,
      ...(!production && draft.organization.municipalRegistration && { hasIssuerMunicipalRegistration: true }),
      ...(productionEnabled && { productionEnabled: true }),
      ...(production && { customerName: draft.customer.name, description: draft.serviceDescription, amount: draft.amount.toFixed(2),
        hasLinkedService: Boolean(draft.serviceId) }),
      ...defaults,
      prepared: prepared && {
        ...(production ? productionView(prepared, access, approval) : signedView(prepared)),
        current: available && prepared.certificateVersion === certificate?.version &&
          prepared.invoiceVersion.getTime() === draft.updatedAt.getTime() &&
          (!production || prepared.sourceHash === productionSourceHash(draft)),
      },
    });
  }));

  router.post(path, canPrepare, ...(production ? [limit] : []), json, asyncRoute(async (req, res) => {
    if (!vault) throw new RequestError(503, "certificate-unavailable");
    const id = parseInput(recordId, req.params.id);
    const version = parseInput(draftVersion, req.get("If-Match"));
    const input: PreparationInput = parseInput(production ? productionDpsSigningInput : homologationDpsPreparationInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const access = production ? await readProductionAccess(prisma, organizationId, productionCnpjs) : undefined;
    if (production && !access) throw new RequestError(404, "production-preparation-disabled");
    const where = { id, ...draftScope(organizationId), organization: { archivedAt: null } };
    const [draft, certificate] = await Promise.all([
      prisma.invoice.findUnique({ where, select: dpsDraftFields }),
      prisma.fiscalCertificate.findUnique({
        where: { organizationId }, select: { version: true, validFrom: true, validUntil: true, fingerprint: true, sealed: true },
      }),
    ]);
    if (!draft) throw new RequestError(404, "draft-unavailable");
    if (draft.updatedAt.getTime() !== version.getTime()) throw new RequestError(409, "draft-changed");
    if (!certificate || !certificateIsCurrent(certificate)) throw new RequestError(409, "valid-certificate-required");
    const data = prepareData(draft, input, production);
    const { rememberFiscalData, rememberServiceFiscalData, nDPS: _number, dCompet: _date, omitIssuerMunicipalRegistration: _omit, ...reusable } = input;
    const templateData = { ...reusable, totTrib: "vTotTrib" in reusable.totTrib ? { valuesPerInvoice: true } : reusable.totTrib };
    const fiscalTemplate = rememberFiscalData ? parseInput(dpsFiscalTemplate, templateData) : undefined;
    if (rememberServiceFiscalData && !draft.serviceId) throw new RequestError(409, "fiscal-template-service-required");
    const serviceTemplate = rememberServiceFiscalData ? parseInput(serviceDpsFiscalTemplate, templateData) : undefined;
    const hash = inputHash(data);
    const dpsId = prestadorDpsId(data.cLocEmi, data.cnpjPrestador, data.serie, data.nDPS);
    const key = { organizationId_environment_id: { organizationId, environment, id: dpsId } };
    const view = (saved: Prepared) => production ? productionView(saved, access, approval) : signedView(saved);
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
      if (production && !await readProductionAccess(tx, organizationId, productionCnpjs)) {
        throw new RequestError(404, "production-preparation-disabled");
      }
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
      const active = await tx.$queryRaw<{ validFrom: Date; validUntil: Date }[]>`
        SELECT "validFrom", "validUntil" FROM "FiscalCertificate"
        WHERE "organizationId" = ${organizationId} AND "version" = ${certificate.version} FOR SHARE
      `;
      if (!certificateIsCurrent(active[0])) throw new RequestError(409, "valid-certificate-required");
      const { count } = await tx.preparedDps.createMany({
        data: { organizationId, environment, id: dpsId, invoiceId: id, invoiceVersion: version,
          sourceHash: production ? productionSourceHash(current) : null,
          certificateVersion: certificate.version, inputHash: hash, signedXml: Buffer.from(signed.xml) },
        skipDuplicates: true,
      });
      const saved = await tx.preparedDps.findUniqueOrThrow({ where: key, select: preparedFields });
      checkReplay(saved, id, version, certificate.version, hash);
      if (production && saved.sourceHash !== productionSourceHash(current)) throw new RequestError(409, "draft-changed");
      if (count) {
        await recordRegistration(tx, actor, production ? "PRODUCTION_DPS" : "PREPARED_DPS", dpsId, "CREATED");
        const scope = templateKey(organizationId, current);
        if (fiscalTemplate) {
          const template = await tx.dpsFiscalTemplate.upsert({
            where: { organizationId_customerId_serviceKey: scope },
            create: { ...scope, fiscalData: fiscalTemplate },
            update: { fiscalData: fiscalTemplate },
            select: { id: true },
          });
          await recordRegistration(tx, actor, "DPS_FISCAL_TEMPLATE", template.id, "UPDATED");
        }
        if (serviceTemplate && current.serviceId) {
          const serviceId = current.serviceId;
          const data = { serviceKey: scope.serviceKey, fiscalData: serviceTemplate };
          await tx.serviceDpsFiscalTemplate.upsert({
            where: { organizationId_serviceId: { organizationId, serviceId } },
            create: { organizationId, serviceId, ...data },
            update: data,
          });
          await recordRegistration(tx, actor, "DPS_FISCAL_TEMPLATE", serviceId, "UPDATED");
        }
      }
      return { saved, created: count === 1 };
    });
    res.status(created ? 201 : 200).json(view(saved));
  }));
  return router;
}
