import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput } from "../http.ts";
import { tenantActor } from "../registrations/catalog.ts";

const query = z.strictObject({ month: z.string().regex(/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/).optional() });
type SummaryRow = {
  month: string;
  day: number | null;
  count: number | null;
  issuedCount: bigint;
  totalAmount: Prisma.Decimal;
};

export function createIssuanceSummaryRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  router.get("/issuance", authorize(prisma, cookieName), asyncRoute(async (req, res) => {
    const { month } = parseInput(query, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.$queryRaw<SummaryRow[]>`
      WITH period AS (
        SELECT coalesce(
          (${month ?? null}::text || '-01')::date,
          date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date
        ) AS start_date
      )
      SELECT
        to_char(period.start_date, 'YYYY-MM') AS month,
        daily.day, daily.count,
        coalesce(sum(daily.count) OVER (), 0) AS "issuedCount",
        coalesce(sum(daily.amount) OVER (), 0) AS "totalAmount"
      FROM period
      LEFT JOIN LATERAL (
        SELECT extract(day FROM ("authorizedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::int AS day,
               count(*)::int AS count,
               sum("amount") AS amount
        FROM "Invoice"
        WHERE "organizationId" = ${organizationId}
          AND "status" = 'AUTHORIZED'
          AND "discardedAt" IS NULL
          AND "authorizedAt" >= (period.start_date::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC'
          AND "authorizedAt" < ((period.start_date + interval '1 month') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC'
        GROUP BY 1
      ) daily ON true
      ORDER BY daily.day
    `;
    const [summary] = rows;
    res.json({
      month: summary.month,
      issuedCount: Number(summary.issuedCount),
      totalAmount: summary.totalAmount.toFixed(2),
      days: rows.flatMap((row) => row.day === null ? [] : [{ day: row.day, count: row.count ?? 0 }]),
    });
  }));
  return router;
}
