import express from "express";
import type { RequestHandler } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { emailSchema } from "../auth/credentials.ts";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { organizationDocumentView, organizationSubscriberCreate, pagination, recordId } from "../registrations/input.ts";
import { lockActiveOrganization } from "./access.ts";

const inviteHash = z.string().regex(/^[a-f0-9]{64}$/);
const companyInput = organizationSubscriberCreate.safeExtend({
  ownerEmail: emailSchema,
  ownerName: z.string().trim().min(1).max(120),
  inviteHash,
});
const inviteInput = z.strictObject({ inviteHash });
const accessInput = z.strictObject({ suspended: z.boolean() });
const companySelect = {
  id: true, legalName: true, cnpj: true, cpf: true, accessSuspendedAt: true,
  accessInvitation: { select: { email: true, expiresAt: true } },
} satisfies Prisma.OrganizationSelect;

function companyView({ cnpj, cpf, ...row }: Prisma.OrganizationGetPayload<{ select: typeof companySelect }>) {
  return { ...row, ...organizationDocumentView({ cnpj, cpf }) };
}

function invitationExpiry() {
  return new Date(Date.now() + 48 * 60 * 60 * 1000);
}

export const platformOwnerOnly: RequestHandler = (_req, res, next) => {
  const { membership } = res.locals.auth as AuthSession;
  if (membership.role !== "OWNER" || !membership.platformOwner) {
    next(new RequestError(403, "insufficient-role"));
    return;
  }
  next();
};

export async function requirePlatformOwner(tx: Prisma.TransactionClient, actor: ReturnType<typeof tenantActor>) {
  if (!await lockActiveOrganization(tx, actor.organizationId)) throw new RequestError(401, "authentication-required");
  const binding = await tx.membership.findUnique({
    where: { userId_organizationId: { userId: actor.actorUserId, organizationId: actor.organizationId } },
    select: { role: true, platformOwner: true },
  });
  if (binding?.role !== "OWNER" || !binding.platformOwner) throw new RequestError(403, "insufficient-role");
}

export async function lockManagedCompany(tx: Prisma.TransactionClient, id: string) {
  const allowed = await tx.organization.findUnique({
    where: { id, archivedAt: null, memberships: { none: { platformOwner: true } } }, select: { id: true },
  });
  if (!allowed) throw new RequestError(404, "company-unavailable");
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${id} FOR UPDATE`;
  const company = await tx.organization.findUnique({
    where: { id, archivedAt: null, memberships: { none: { platformOwner: true } } },
    select: companySelect,
  });
  if (!company) throw new RequestError(404, "company-unavailable");
  return company;
}

export function createPlatformRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  router.use(authorize(prisma, cookieName, "OWNER"), platformOwnerOnly);
  const json = express.json({ limit: "4kb" });

  router.get("/companies", asyncRoute(async (req, res) => {
    const { page, limit } = parseInput(pagination, req.query);
    const rows = await prisma.organization.findMany({
      where: { archivedAt: null, memberships: { none: { platformOwner: true } } },
      select: companySelect,
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit, take: limit + 1,
    });
    res.json({ items: rows.slice(0, limit).map(companyView), hasNext: rows.length > limit });
  }));

  router.post("/companies", json, asyncRoute(async (req, res) => {
    const { ownerEmail, ownerName, inviteHash: tokenHash, ...data } = parseInput(companyInput, req.body);
    const actor = tenantActor(res);
    const company = await prisma.$transaction(async (tx) => {
      await requirePlatformOwner(tx, actor);
      const created = await tx.organization.create({
        data: {
          ...data,
          accessInvitation: { create: { tokenHash, email: ownerEmail, name: ownerName, expiresAt: invitationExpiry() } },
        },
        select: companySelect,
      });
      await recordRegistration(tx, { ...actor, organizationId: created.id }, "ORGANIZATION", created.id, "CREATED");
      return created;
    });
    res.status(201).json(companyView(company));
  }));

  router.post("/companies/:id/invitation", json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { inviteHash: tokenHash } = parseInput(inviteInput, req.body);
    const actor = tenantActor(res);
    const company = await prisma.$transaction(async (tx) => {
      await requirePlatformOwner(tx, actor);
      const current = await lockManagedCompany(tx, id);
      if (current.accessSuspendedAt || !current.accessInvitation) throw new RequestError(409, "invitation-unavailable");
      const expiresAt = invitationExpiry();
      await tx.organizationInvitation.update({ where: { organizationId: id }, data: { tokenHash, expiresAt } });
      await recordRegistration(tx, { ...actor, organizationId: id }, "ORGANIZATION", id, "UPDATED");
      return { ...current, accessInvitation: { ...current.accessInvitation, expiresAt } };
    });
    res.json(companyView(company));
  }));

  router.patch("/companies/:id/access", json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { suspended } = parseInput(accessInput, req.body);
    const actor = tenantActor(res);
    const company = await prisma.$transaction(async (tx) => {
      await requirePlatformOwner(tx, actor);
      const current = await lockManagedCompany(tx, id);
      if (Boolean(current.accessSuspendedAt) === suspended) return current;
      const updated = await tx.organization.update({
        where: { id }, data: { accessSuspendedAt: suspended ? new Date() : null }, select: companySelect,
      });
      if (suspended) await tx.session.deleteMany({ where: { organizationId: id } });
      await recordRegistration(tx, { ...actor, organizationId: id }, "ORGANIZATION", id,
        suspended ? "ACCESS_SUSPENDED" : "ACCESS_REACTIVATED");
      return updated;
    });
    res.json(companyView(company));
  }));

  return router;
}
