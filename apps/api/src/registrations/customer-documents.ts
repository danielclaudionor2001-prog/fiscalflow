import type { AsaasEnvironment, PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { tenantActor } from "./catalog.ts";
import { pagination, recordId } from "./input.ts";
import { safeAsaasUrl } from "../billing/asaas-client.ts";

const query = pagination.extend({ kind: z.enum(["INVOICE", "QUOTE", "SERVICE_ORDER", "BOLETO"]), documentId: recordId.optional() });

function publicBoletoUrl(value: string | null, environment: AsaasEnvironment) {
  try { return safeAsaasUrl(value, environment); } catch { return null; }
}

export function createCustomerDocumentsRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  router.get("/customers/:id/documents", authorize(prisma, cookieName), asyncRoute(async (req, res) => {
    const { organizationId } = tenantActor(res);
    const { role } = (res.locals.auth as AuthSession).membership;
    const customerId = parseInput(recordId, req.params.id);
    const { kind, page, limit, documentId } = parseInput(query, req.query);
    if (kind === "BOLETO" && !["OWNER", "ADMIN", "ACCOUNTANT"].includes(role)) throw new RequestError(403, "forbidden");
    const customer = await prisma.customer.findUnique({
      where: { id: customerId, organizationId, archivedAt: null, organization: { archivedAt: null, accessSuspendedAt: null } },
      select: { id: true },
    });
    if (!customer) throw new RequestError(404, "customer-unavailable");
    const scope = { organizationId, customerId };
    const documentScope = documentId ? { id: documentId } : {};
    const paging = { skip: (page - 1) * limit, take: limit + 1 };
    let items;
    if (kind === "INVOICE") {
      const rows = await prisma.invoice.findMany({
        where: { ...scope, ...documentScope, discardedAt: null, status: { in: ["AUTHORIZED", "CANCEL_REQUESTED", "CANCELLED"] },
          accessKey: { not: null }, AND: [{ xmlResponse: { not: null } }, { xmlResponse: { not: "" } }] },
        ...paging, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, amount: true, serviceDescription: true, status: true, createdAt: true },
      });
      items = rows.map((row) => ({ id: row.id, amount: row.amount.toFixed(2), date: row.createdAt, status: row.status,
        title: "NFS-e · " + row.serviceDescription, filename: "nfse-" + row.id + ".pdf", publicUrl: null,
        pdfPath: "customers/" + customerId + "/invoices/" + row.id + "/nfse.pdf" }));
    } else if (kind === "BOLETO") {
      const rows = await prisma.boleto.findMany({
        where: { organizationId, ...documentScope, purpose: "SERVICE", OR: [{ invoice: scope }, { quote: scope }] },
        ...paging, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, amount: true, dueDate: true, status: true, installment: true,
          asaas: { select: { bankSlipUrl: true, environment: true, status: true } } },
      });
      items = rows.map((row) => ({ id: row.id, amount: row.amount.toFixed(2), date: row.dueDate.toISOString().slice(0, 10), status: row.status,
        title: "Boleto" + (row.installment ? " · parcela " + row.installment : "") + (row.asaas?.environment === "SANDBOX" ? " · TESTE SANDBOX" : ""),
        pdfPath: null, filename: null,
        publicUrl: row.status !== "CANCELLED" && row.asaas && !["CANCELED", "ERROR"].includes(row.asaas.status)
          ? publicBoletoUrl(row.asaas.bankSlipUrl, row.asaas.environment) : null }));
    } else {
      const rows = await prisma.commercialOrder.findMany({ where: { ...scope, ...documentScope, kind }, ...paging,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, amount: true, createdAt: true, status: true } });
      items = rows.map((row) => ({ id: row.id, amount: row.amount.toFixed(2), date: row.createdAt, status: row.status,
        title: (kind === "QUOTE" ? "Orçamento" : "Ordem de serviço") + " · " + row.id.slice(-8).toUpperCase(),
        pdfPath: "commercial/orders/" + row.id + "/pdf", publicUrl: null,
        filename: (kind === "QUOTE" ? "orcamento-" : "ordem-servico-") + row.id.slice(-8) + ".pdf" }));
    }
    res.set("Cache-Control", "no-store").json({ items: items.slice(0, limit), hasNext: items.length > limit });
  }));
  return router;
}
