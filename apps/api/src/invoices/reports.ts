import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { tenantActor } from "../registrations/catalog.ts";
import { pagination } from "../registrations/input.ts";

const day = 86_400_000;
const exportLimit = 5000;
const date = z.iso.date().refine((value) => value >= "2020-01-01");
const period = z.strictObject({ from: date, to: date });
const reportQuery = period.extend(pagination.shape);
const select = {
  id: true, createdAt: true, amount: true, serviceDescription: true,
  customer: { select: { name: true } }, service: { select: { name: true } },
} satisfies Prisma.InvoiceSelect;
const orderBy: Prisma.InvoiceOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
const brasiliaDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

function reportScope(organizationId: string, { from, to }: z.infer<typeof period>): Prisma.InvoiceWhereInput {
  const first = new Date(from + "T00:00:00-03:00");
  const last = new Date(to + "T00:00:00-03:00");
  const duration = last.getTime() - first.getTime();
  if (duration < 0 || duration >= 366 * day) throw new RequestError(400, "invalid-report-period");
  return {
    organizationId, organization: { archivedAt: null }, status: "DRAFT", discardedAt: null,
    createdAt: { gte: first, lt: new Date(last.getTime() + day) },
  };
}

function csvText(value: string) {
  const text = /^(?:[\t\r\n]|\s*[=+\-@])/u.test(value) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function createInvoiceReportsRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName, "OWNER", "ADMIN", "ACCOUNTANT");

  router.get("/drafts", read, asyncRoute(async (req, res) => {
    const query = parseInput(reportQuery, req.query);
    const where = reportScope(tenantActor(res).organizationId, query);
    const [totals, rows] = await prisma.$transaction([
      prisma.invoice.aggregate({ where, _count: true, _sum: { amount: true } }),
      prisma.invoice.findMany({
        where, orderBy, select, skip: (query.page - 1) * query.limit, take: query.limit + 1,
      }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    res.json({
      count: totals._count,
      amount: totals._sum.amount?.toFixed(2) ?? "0.00",
      items: rows.slice(0, query.limit).map((row) => ({ ...row, amount: row.amount.toFixed(2) })),
      hasNext: rows.length > query.limit,
    });
  }));

  router.get("/drafts.csv", read, asyncRoute(async (req, res) => {
    const query = parseInput(period, req.query);
    const where = reportScope(tenantActor(res).organizationId, query);
    const rows = await prisma.invoice.findMany({ where, orderBy, select, take: exportLimit + 1 });
    if (rows.length > exportLimit) throw new RequestError(422, "report-too-large");
    const lines = ["Data de criação;Cliente;Serviço;Descrição;Valor (R$)"];
    for (const row of rows) {
      lines.push([
        brasiliaDate.format(row.createdAt), csvText(row.customer.name), csvText(row.service?.name ?? ""),
        csvText(row.serviceDescription), row.amount.toFixed(2).replace(".", ","),
      ].join(";"));
    }
    res.attachment("rascunhos.csv").type("text/csv").send("\uFEFF" + lines.join("\r\n") + "\r\n");
  }));
  return router;
}
