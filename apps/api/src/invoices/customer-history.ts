import type { PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { accessKeyPattern, dpsIdPattern, readLocalDpsSummary } from "../fiscal/documents.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { tenantActor } from "../registrations/catalog.ts";
import { pagination, recordId } from "../registrations/input.ts";
import { dpsConferencePdf } from "./dps-pdf.ts";

const dpsIdInput = z.string().regex(dpsIdPattern);

function visibleInvoices(organizationId: string, customerId: string) {
  return {
    organizationId, customerId, discardedAt: null,
    customer: { archivedAt: null },
    organization: { archivedAt: null },
  };
}

export function createCustomerInvoiceHistoryRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName);

  router.get("/:id/invoices", read, asyncRoute(async (req, res) => {
    const customerId = parseInput(recordId, req.params.id);
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const customer = await prisma.customer.findUnique({
      where: { id: customerId, organizationId, archivedAt: null, organization: { archivedAt: null } },
      select: { name: true },
    });
    if (!customer) throw new RequestError(404, "customer-unavailable");
    const rows = await prisma.invoice.findMany({
      where: visibleInvoices(organizationId, customerId),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
      select: {
        id: true, status: true, serviceDescription: true, amount: true, createdAt: true, updatedAt: true,
        authorizedAt: true, accessKey: true, xmlResponse: true,
        preparedDps: {
          where: { organizationId, environment: "HOMOLOGATION" },
          orderBy: [{ preparedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true, invoiceVersion: true },
        },
      },
    });
    res.json({
      customer,
      items: rows.slice(0, limit).map((row) => {
        const prepared = row.preparedDps[0];
        const dpsId = row.status === "DRAFT" && prepared?.invoiceVersion.getTime() === row.updatedAt.getTime()
          ? prepared.id : null;
        const hasAuthorizedNote = row.status === "AUTHORIZED" || row.status === "CANCEL_REQUESTED" || row.status === "CANCELLED";
        return {
          id: row.id, status: row.status, serviceDescription: row.serviceDescription, amount: row.amount.toFixed(2),
          date: row.authorizedAt ?? row.createdAt, dpsId,
          accessKey: hasAuthorizedNote && row.accessKey && accessKeyPattern.test(row.accessKey) ? row.accessKey : null,
          hasXml: hasAuthorizedNote && Boolean(row.xmlResponse),
        };
      }),
      hasNext: rows.length > limit,
    });
  }));

  router.get("/:id/invoices/:invoiceId/nfse.xml", read, asyncRoute(async (req, res) => {
    const customerId = parseInput(recordId, req.params.id);
    const id = parseInput(recordId, req.params.invoiceId);
    const { organizationId } = tenantActor(res);
    const invoice = await prisma.invoice.findUnique({
      where: { id, ...visibleInvoices(organizationId, customerId), status: { in: ["AUTHORIZED", "CANCEL_REQUESTED", "CANCELLED"] } },
      select: { accessKey: true, xmlResponse: true },
    });
    if (!invoice?.xmlResponse || !invoice.accessKey || !accessKeyPattern.test(invoice.accessKey)) {
      throw new RequestError(404, "nfse-xml-unavailable");
    }
    res.attachment("nfse-" + invoice.accessKey + ".xml").type("application/xml").send(invoice.xmlResponse);
  }));

  router.get("/:id/invoices/dps/:dpsId.pdf", read, asyncRoute(async (req, res) => {
    const customerId = parseInput(recordId, req.params.id);
    const dpsId = parseInput(dpsIdInput, req.params.dpsId);
    const { organizationId } = tenantActor(res);
    const prepared = await prisma.preparedDps.findUnique({
      where: {
        organizationId_environment_id: { organizationId, environment: "HOMOLOGATION", id: dpsId },
        invoice: { ...visibleInvoices(organizationId, customerId), status: "DRAFT" },
      },
      select: {
        signedXml: true, preparedAt: true, invoiceVersion: true,
        invoice: { select: { updatedAt: true, organization: { select: { legalName: true } } } },
      },
    });
    if (!prepared || prepared.invoiceVersion.getTime() !== prepared.invoice.updatedAt.getTime()) {
      throw new RequestError(404, "dps-pdf-unavailable");
    }
    const data = readLocalDpsSummary(Buffer.from(prepared.signedXml));
    if (data.id !== dpsId) throw new RequestError(404, "dps-pdf-unavailable");
    const pdf = await dpsConferencePdf(data, prepared.preparedAt, prepared.invoice.organization.legalName);
    res.attachment("dps-teste-" + dpsId + ".pdf").send(pdf);
  }));
  return router;
}
