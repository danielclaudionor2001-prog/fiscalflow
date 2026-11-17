import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { RequestError } from "../http.ts";
import { requireActiveOrganization } from "../registrations/catalog.ts";
import { moneyAmount } from "../registrations/input.ts";

export const title = z.string().trim().min(1).max(160);
export const positiveMoney = moneyAmount.refine((value) => /[1-9]/.test(value));
export const calendarDate = z.iso.date().transform((value) => new Date(value + "T00:00:00Z"));
export const installmentCount = z.number().int().min(1).max(24);
export const requestKey = z.uuid();
export const quantity = z.number().int().min(1).max(100_000);
export const maxStock = 1_000_000_000;

const saoPauloDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
});

export function today() {
  return new Date(saoPauloDay.format(new Date()) + "T00:00:00Z");
}

function monthlyDue(first: Date, offset: number) {
  const due = new Date(first);
  due.setUTCMonth(due.getUTCMonth() + offset, 1);
  const last = new Date(due);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  due.setUTCDate(Math.min(first.getUTCDate(), last.getUTCDate()));
  return due;
}

export function installmentSchedule(amount: Prisma.Decimal, firstDue: Date, count: number) {
  const cents = amount.mul(100);
  if (cents.lt(count)) throw new RequestError(400, "installment-too-small");
  const base = cents.div(count).floor();
  const extra = cents.mod(count).toNumber();
  return Array.from({ length: count }, (_, index) => ({
    installment: index + 1,
    amount: base.plus(index < extra ? 1 : 0).div(100),
    dueOn: monthlyDue(firstDue, index),
  }));
}

export function fingerprint(input: object) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function commercialTransaction<T>(prisma: PrismaClient, organizationId: string, run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await requireActiveOrganization(tx, organizationId);
    // Serialize stock, sale and cash mutations for this tenant.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"commercial:" + organizationId}, 0))`);
    return run(tx);
  });
}

export async function requireSupplier(tx: Prisma.TransactionClient, organizationId: string, id?: string | null) {
  if (!id) return;
  const suppliers = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Supplier"
    WHERE "organizationId" = ${organizationId} AND "id" = ${id} AND "archivedAt" IS NULL
    FOR SHARE
  `;
  if (!suppliers.length) throw new RequestError(404, "supplier-unavailable");
}

export function checkTotal(amount: Prisma.Decimal) {
  if (amount.gte("1000000000000")) throw new RequestError(400, "amount-too-large");
  return amount;
}

export function pageResult<T>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), hasNext: rows.length > limit };
}
