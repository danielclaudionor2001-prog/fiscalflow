import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { lockActiveOrganization } from "../organizations/access.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import { moneyAmount, pagination, recordId, serviceCreate } from "../registrations/input.ts";
import { draftScope, lockDraftReferences } from "./drafts.ts";

const dayOfMonth = z.number().int().min(1).max(31);
const monthlyKind = z.enum(["MENSALIDADE", "MODERNIZACAO", "ORCAMENTO"]);
const scheduleInput = z.strictObject({ draftId: recordId, dayOfMonth, kind: monthlyKind.default("MENSALIDADE") });
const monthlyFields = z.strictObject({
  serviceId: recordId,
  amount: moneyAmount.refine((amount) => /[1-9]/.test(amount)),
  serviceDescription: serviceCreate.shape.description,
  kind: monthlyKind,
});
const monthlyInput = monthlyFields.extend({ customerId: recordId });
const scheduleUpdate = monthlyFields.partial().extend({ active: z.boolean(), dayOfMonth });
const snapshot = { customerId: true, serviceId: true, amount: true, serviceDescription: true } as const;
const scheduleSelect = {
  id: true, dayOfMonth: true, nextRunAt: true, lastRunAt: true, pauseReason: true,
  amount: true, serviceDescription: true, kind: true, sourceInvoiceId: true, serviceId: true,
  customer: { select: { name: true } }, service: { select: { name: true } },
} satisfies Prisma.InvoiceScheduleSelect;

type Schedule = Prisma.InvoiceScheduleGetPayload<{ select: typeof scheduleSelect }>;
function scheduleView(schedule: Schedule) {
  return { ...schedule, amount: schedule.amount.toFixed(2) };
}

function nextRun(after: Date, day: number) {
  const local = new Date(after.getTime() - 3 * 3_600_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const occurrence = (offset: number) => {
    const daysInMonth = new Date(Date.UTC(year, month + offset + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month + offset, Math.min(day, daysInMonth), 11));
  };
  const thisMonth = occurrence(0);
  return thisMonth > after ? thisMonth : occurrence(1);
}

export function createInvoiceSchedulesRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const manage = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "16kb" });

  router.get("/", manage, asyncRoute(async (req, res) => {
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await prisma.invoiceSchedule.findMany({
      where: { organizationId, organization: { archivedAt: null } },
      orderBy: { id: "desc" }, skip: (page - 1) * limit, take: limit + 1, select: scheduleSelect,
    });
    res.json({ items: rows.slice(0, limit).map(scheduleView), hasNext: rows.length > limit });
  }));

  router.post("/", manage, json, asyncRoute(async (req, res) => {
    const { draftId, dayOfMonth: day, kind } = parseInput(scheduleInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const key = { organizationId_sourceInvoiceId: { organizationId, sourceInvoiceId: draftId } };
    const result = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const existing = await tx.invoiceSchedule.findUnique({ where: key, select: scheduleSelect });
      if (existing) {
        if (existing.dayOfMonth !== day || existing.kind !== kind) throw new RequestError(409, "schedule-exists");
        return { schedule: existing, created: false };
      }
      const source = await tx.invoice.findUnique({ where: { id: draftId, ...draftScope(organizationId) }, select: snapshot });
      if (!source) throw new RequestError(404, "draft-unavailable");
      await lockDraftReferences(tx, organizationId, source);
      const { count } = await tx.invoiceSchedule.createMany({
        data: { ...source, organizationId, sourceInvoiceId: draftId, kind, dayOfMonth: day, nextRunAt: nextRun(new Date(), day) },
        skipDuplicates: true,
      });
      const schedule = await tx.invoiceSchedule.findUniqueOrThrow({ where: key, select: scheduleSelect });
      if (schedule.dayOfMonth !== day || schedule.kind !== kind) throw new RequestError(409, "schedule-exists");
      if (count) await recordRegistration(tx, actor, "INVOICE_SCHEDULE", schedule.id, "CREATED");
      return { schedule, created: count === 1 };
    });
    res.status(result.created ? 201 : 200).json(scheduleView(result.schedule));
  }));

  router.post("/monthly", manage, json, asyncRoute(async (req, res) => {
    const data = parseInput(monthlyInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const scope = { organizationId, customerId: data.customerId, kind: data.kind, sourceInvoiceId: null };
    const result = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      await lockDraftReferences(tx, organizationId, data);
      const { count } = await tx.invoiceSchedule.createMany({
        data: { ...data, organizationId, dayOfMonth: 1, nextRunAt: nextRun(new Date(), 1) },
        skipDuplicates: true,
      });
      const schedule = await tx.invoiceSchedule.findFirstOrThrow({ where: scope, select: scheduleSelect });
      if (schedule.serviceId !== data.serviceId || !schedule.amount.equals(data.amount) ||
          schedule.serviceDescription !== data.serviceDescription) throw new RequestError(409, "schedule-exists");
      if (count) await recordRegistration(tx, actor, "INVOICE_SCHEDULE", schedule.id, "CREATED");
      return { schedule, created: count === 1 };
    });
    res.status(result.created ? 201 : 200).json(scheduleView(result.schedule));
  }));

  router.patch("/:id", manage, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { active, dayOfMonth: day, ...changes } = parseInput(scheduleUpdate, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const schedule = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, organizationId);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "InvoiceSchedule" WHERE "organizationId" = ${organizationId} AND "id" = ${id} FOR UPDATE
      `;
      if (!rows.length) throw new RequestError(404, "schedule-unavailable");
      const where = { id, organizationId };
      const current = await tx.invoiceSchedule.findUniqueOrThrow({ where });
      if (!current.sourceInvoiceId && day !== 1) throw new RequestError(400, "monthly-day-fixed");
      const scheduleChanged = active !== Boolean(current.nextRunAt) || current.dayOfMonth !== day;
      if (!scheduleChanged && !Object.keys(changes).length) {
        return tx.invoiceSchedule.findUniqueOrThrow({ where, select: scheduleSelect });
      }
      if (active || changes.serviceId) {
        await lockDraftReferences(tx, organizationId, { customerId: current.customerId, serviceId: changes.serviceId ?? current.serviceId });
      }
      const saved = await tx.invoiceSchedule.update({
        where, data: { ...changes, dayOfMonth: day,
          nextRunAt: scheduleChanged ? (active ? nextRun(new Date(), day) : null) : current.nextRunAt,
          pauseReason: scheduleChanged ? null : current.pauseReason },
        select: scheduleSelect,
      });
      await recordRegistration(tx, actor, "INVOICE_SCHEDULE", id, "UPDATED");
      return saved;
    });
    res.json(scheduleView(schedule));
  }));
  return router;
}

export async function runDueDraftSchedules(prisma: PrismaClient, now = new Date()) {
  // The scheduler discovers due rows across tenants, then scopes each write to its selected organization.
  const due = await prisma.invoiceSchedule.findMany({
    where: { nextRunAt: { lte: now }, organization: { archivedAt: null, accessSuspendedAt: null } },
    orderBy: [{ nextRunAt: "asc" }, { id: "asc" }], take: 30,
    select: { id: true, organizationId: true },
  });
  let failure: unknown;
  for (const where of due) {
    const { organizationId, id } = where;
    const actor = { organizationId, actorUserId: null };
    try {
      await prisma.$transaction(async (tx) => {
        if (!await lockActiveOrganization(tx, organizationId)) return;
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "InvoiceSchedule"
          WHERE "id" = ${id} AND "organizationId" = ${organizationId}
          FOR UPDATE SKIP LOCKED
        `;
        if (!locked.length) return;
        const schedule = await tx.invoiceSchedule.findUniqueOrThrow({ where });
        if (!schedule.nextRunAt || schedule.nextRunAt > now) return;
        const { customerId, serviceId, amount, serviceDescription, kind, dayOfMonth: day } = schedule;
        try {
          await lockDraftReferences(tx, organizationId, schedule);
        } catch (error) {
          if (!(error instanceof RequestError) || error.status !== 404) throw error;
          await tx.invoiceSchedule.update({ where, data: { nextRunAt: null, pauseReason: error.code } });
          await recordRegistration(tx, actor, "INVOICE_SCHEDULE", id, "UPDATED");
          return;
        }
        const draft = await tx.invoice.create({
          data: { organizationId, customerId, serviceId, amount, serviceDescription, kind, idempotencyKey: randomUUID() },
          select: { id: true },
        });
        await recordRegistration(tx, actor, "INVOICE", draft.id, "CREATED");
        await tx.invoiceSchedule.update({ where, data: { nextRunAt: nextRun(now, day), lastRunAt: now } });
      });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
