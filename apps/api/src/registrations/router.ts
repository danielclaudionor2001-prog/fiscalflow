import { createCommercialCatalogRouter } from "../commercial/catalog.ts";
import { createOrdersRouter } from "../commercial/orders.ts";
import { createQuoteExpressRouter } from "../commercial/quote-express.ts";
import { createFinanceRouter } from "../commercial/finance.ts";
import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import { authorize, sessionCookieName } from "../auth/sessions.ts";
import { createBoletoRouter } from "../billing/boletos.ts";
import type { CelcoinSandbox } from "../billing/celcoin-sandbox.ts";
import { createReceivingAccountRouter } from "../billing/receiving-account.ts";
import type { CertificateVault, HomologationTransportProvider } from "../fiscal/certificate-vault.ts";
import { createCertificatesRouter, type ProductionLookupConfig } from "../fiscal/certificates-router.ts";
import { asyncRoute, handleApiError, parseInput, protectBrowserRequests, RequestError } from "../http.ts";
import { createCustomerInvoiceHistoryRouter } from "../invoices/customer-history.ts";
import { createInvoiceDraftsRouter } from "../invoices/drafts.ts";
import { createInvoiceReportsRouter } from "../invoices/reports.ts";
import { createDpsPreparationRouter } from "../invoices/prepare-dps.ts";
import { createProductionIssuanceRouter, type ProductionIssuanceConfig } from "../invoices/production-issuance.ts";
import { createHomologationRouter } from "../invoices/homologation.ts";
import { createInvoiceSchedulesRouter } from "../invoices/schedules.ts";
import { createIssuanceSummaryRouter } from "../invoices/issuance-summary.ts";
import { createTeamRouter } from "../organizations/team.ts";
import { createPlatformRouter } from "../organizations/platform.ts";
import { createBrandingRouter } from "../organizations/branding.ts";
import { createCatalogRouter, recordRegistration, requireActiveOrganization, tenantActor } from "./catalog.ts";
import { customerCreate, customerUpdate, organizationCreate, organizationDocumentView, organizationUpdate, serviceCreate, serviceUpdate } from "./input.ts";

const organizationSelect = {
  id: true, legalName: true, tradeName: true, cnpj: true, cpf: true, municipalRegistration: true, cityIbgeCode: true,
} satisfies Prisma.OrganizationSelect;

function organizationView({ cnpj, cpf, ...row }: Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>) {
  return { ...row, ...organizationDocumentView({ cnpj, cpf }) };
}
const customerSelect = {
  id: true, name: true, federalTaxId: true, email: true, phone: true,
} satisfies Prisma.CustomerSelect;
const serviceSelect = {
  id: true, name: true, description: true, defaultAmount: true, active: true,
  nationalServiceCode: true, municipalServiceCode: true,
} satisfies Prisma.ServiceSelect;

function serviceView(service: Prisma.ServiceGetPayload<{ select: typeof serviceSelect }>) {
  return { ...service, defaultAmount: service.defaultAmount.toFixed(2) };
}

export function createRegistrationsRouter(
  prisma: PrismaClient,
  webOrigin: string,
  secureCookie: boolean,
  vault?: CertificateVault,
  celcoin?: CelcoinSandbox,
  options: {
    alternateWebOrigin?: string; homologation?: HomologationTransportProvider; productionLookup?: ProductionLookupConfig;
    productionIssuance?: ProductionIssuanceConfig;
  } = {},
) {
  const { alternateWebOrigin, homologation, productionIssuance } = options;
  const router = express.Router();
  const cookieName = sessionCookieName(secureCookie);
  const read = authorize(prisma, cookieName);
  const owner = authorize(prisma, cookieName, "OWNER");
  const manage = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "16kb" });
  router.use(protectBrowserRequests(alternateWebOrigin ? [webOrigin, alternateWebOrigin] : webOrigin));
  router.use("/platform/receiving-account", createReceivingAccountRouter(prisma, cookieName, "SUBSCRIPTION"));
  router.use("/platform/companies/:companyId/boletos", createBoletoRouter(prisma, cookieName, "SUBSCRIPTION", celcoin));
  router.use("/platform", createPlatformRouter(prisma, cookieName));
  router.use("/receiving-account", createReceivingAccountRouter(prisma, cookieName, "SERVICE"));
  router.use("/boletos", createBoletoRouter(prisma, cookieName, "SERVICE", celcoin));
  router.use("/organizations/current/branding", createBrandingRouter(prisma, cookieName));

  router.get("/organizations/current", read, asyncRoute(async (_req, res) => {
    const { organizationId } = tenantActor(res);
    const row = await prisma.organization.findUnique({
      where: { id: organizationId, archivedAt: null }, select: organizationSelect,
    });
    if (!row) throw new RequestError(404, "not-found");
    res.json(organizationView(row));
  }));

  router.post("/organizations", owner, json, asyncRoute(async (req, res) => {
    const data = parseInput(organizationCreate, req.body);
    const { organizationId, actorUserId } = tenantActor(res);
    const row = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const created = await tx.organization.create({
        data: {
          ...data,
          memberships: { create: { userId: actorUserId, role: "OWNER" } },
          authAuditEvents: { create: { userId: actorUserId, action: "MEMBERSHIP_PROVISIONED" } },
        },
        select: organizationSelect,
      });
      await recordRegistration(tx, { organizationId: created.id, actorUserId }, "ORGANIZATION", created.id, "CREATED");
      return created;
    });
    res.status(201).json(organizationView(row));
  }));

  router.patch("/organizations/current", manage, json, asyncRoute(async (req, res) => {
    const data = parseInput(organizationUpdate, req.body);
    const actor = tenantActor(res);
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: actor.organizationId, archivedAt: null, accessSuspendedAt: null }, data, select: organizationSelect,
      });
      await recordRegistration(tx, actor, "ORGANIZATION", updated.id, "UPDATED");
      return updated;
    });
    res.json(organizationView(row));
  }));

  router.delete("/organizations/current", owner, asyncRoute(async (_req, res) => {
    const actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      const { id } = await tx.organization.update({
        where: { id: actor.organizationId, archivedAt: null, accessSuspendedAt: null },
        data: { archivedAt: new Date() },
        select: { id: true },
      });
      await tx.session.deleteMany({ where: { organizationId: id } });
      const certificate = await tx.fiscalCertificate.findUnique({ where: { organizationId: id }, select: { version: true } });
      if (certificate) {
        await tx.fiscalCertificate.delete({ where: { organizationId: id, version: certificate.version } });
        await recordRegistration(tx, actor, "FISCAL_CERTIFICATE", certificate.version, "ARCHIVED");
      }
      await recordRegistration(tx, actor, "ORGANIZATION", id, "ARCHIVED");
    });
    res.status(204).end();
  }));

  router.use("/customers", createCustomerInvoiceHistoryRouter(prisma, cookieName), createCatalogRouter(prisma, cookieName, {
    entity: "CUSTOMER",
    createInput: customerCreate,
    updateInput: customerUpdate,
    list: (where, skip, take) => prisma.customer.findMany({
      where, skip, take, orderBy: [{ name: "asc" }, { id: "asc" }], select: customerSelect,
    }),
    get: (where) => prisma.customer.findUnique({ where, select: customerSelect }),
    create: (tx, organizationId, data) => tx.customer.create({ data: { ...data, organizationId }, select: customerSelect }),
    update: (tx, where, data) => tx.customer.update({ where, data, select: customerSelect }),
    archive: (tx, where) => tx.customer.update({ where, data: { archivedAt: new Date() }, select: { id: true } }),
  }));

  router.use("/services", createCatalogRouter(prisma, cookieName, {
    entity: "SERVICE",
    createInput: serviceCreate,
    updateInput: serviceUpdate,
    list: async (where, skip, take) => (await prisma.service.findMany({
      where, skip, take, orderBy: [{ name: "asc" }, { id: "asc" }], select: serviceSelect,
    })).map(serviceView),
    get: async (where) => {
      const row = await prisma.service.findUnique({ where, select: serviceSelect });
      return row && serviceView(row);
    },
    create: async (tx, organizationId, data) => serviceView(await tx.service.create({
      data: { ...data, organizationId }, select: serviceSelect,
    })),
    update: async (tx, where, data) => serviceView(await tx.service.update({ where, data, select: serviceSelect })),
    archive: (tx, where) => tx.service.update({ where, data: { archivedAt: new Date(), active: false }, select: { id: true } }),
  }));

  if (homologation) router.use("/invoices", createHomologationRouter(prisma, cookieName, homologation));
  if (productionIssuance) {
    router.use("/invoices", createDpsPreparationRouter(prisma, cookieName, vault, {
      environment: "PRODUCTION", productionCnpjs: productionIssuance.cnpjs, approval: productionIssuance.approval,
    }), createProductionIssuanceRouter(prisma, cookieName, productionIssuance));
  }
  router.use("/invoices", createDpsPreparationRouter(prisma, cookieName, vault, {
    homologationEnabled: Boolean(homologation), productionCnpjs: productionIssuance?.cnpjs,
  }), createInvoiceDraftsRouter(prisma, cookieName));
  router.use("/reports", createInvoiceReportsRouter(prisma, cookieName));
  router.use("/dashboard", createIssuanceSummaryRouter(prisma, cookieName));
  router.use("/schedules", createInvoiceSchedulesRouter(prisma, cookieName));
  router.use("/team", createTeamRouter(prisma, cookieName));
  const allowLoopback = !secureCookie && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(webOrigin).hostname);
  router.use("/certificates", createCertificatesRouter(prisma, cookieName, allowLoopback, vault, options.productionLookup));
  router.use("/commercial", createCommercialCatalogRouter(prisma, cookieName));
  router.use("/commercial/orders", createOrdersRouter(prisma, cookieName));
  router.use("/quote-express", createQuoteExpressRouter(prisma));
  router.use("/commercial/finance", createFinanceRouter(prisma, cookieName));
  router.use(handleApiError);
  return router;
}
