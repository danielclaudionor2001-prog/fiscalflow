import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { emailSchema, hashPassword, newPasswordSchema, verifyPassword } from "../auth/credentials.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { lockActiveOrganization } from "./access.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { pagination, recordId } from "../registrations/input.ts";

const employeeRole = z.enum(["ADMIN", "OPERATOR", "ACCOUNTANT", "VIEWER"]);
export const departmentInput = z.string().trim().max(80).transform(value => value || null).nullable().optional();
const invitationInput = z.strictObject({ name: z.string().trim().min(1).max(160), email: emailSchema, role: employeeRole, department: departmentInput });
const invitationSelect = { id: true, name: true, email: true, role: true, department: true, expiresAt: true, createdAt: true } satisfies Prisma.TeamInvitationSelect;
export const teamActivationInput = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(1).max(128) });

async function ownerLock(tx: Prisma.TransactionClient, actor: ReturnType<typeof tenantActor>) {
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id"=${actor.organizationId} FOR UPDATE`;
  if (!await lockActiveOrganization(tx, actor.organizationId)) throw new RequestError(401, "authentication-required");
  const owner = await tx.membership.findUnique({ where: { userId_organizationId: { organizationId: actor.organizationId, userId: actor.actorUserId } }, select: { role: true } });
  if (owner?.role !== "OWNER") throw new RequestError(403, "insufficient-role");
}

export function createTeamInvitationsRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const owner = authorize(prisma, cookieName, "OWNER");
  router.get("/invitations", authorize(prisma, cookieName, "OWNER", "ADMIN"), asyncRoute(async (req, res) => {
    const { organizationId } = tenantActor(res); const { page, limit } = parseInput(pagination, req.query);
    const rows = await prisma.teamInvitation.findMany({ where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: invitationSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit + 1 });
    res.set("Cache-Control", "no-store").json({ items: rows.slice(0, limit), hasNext: rows.length > limit });
  }));
  router.post("/invitations", owner, rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { code: "too-many-attempts" } }),
    express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
      const data = parseInput(invitationInput, req.body); const actor = tenantActor(res);
      const code = randomBytes(32).toString("base64url"); const tokenHash = createHash("sha256").update(code).digest("hex");
      const saved = await prisma.$transaction(async tx => {
        await ownerLock(tx, actor);
        if (await tx.membership.findFirst({ where: { organizationId: actor.organizationId, user: { email: data.email } }, select: { id: true } })) throw new RequestError(409, "already-team-member");
        if (await tx.teamInvitation.findFirst({ where: { organizationId: actor.organizationId, email: data.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } })) throw new RequestError(409, "team-invitation-pending");
        const row = await tx.teamInvitation.create({ data: { ...data, organizationId: actor.organizationId, createdByUserId: actor.actorUserId, tokenHash, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, select: invitationSelect });
        await recordRegistration(tx, actor, "TEAM_INVITATION", row.id, "CREATED"); return row;
      });
      res.set("Cache-Control", "no-store").status(201).json({ ...saved, code });
    }));
  router.delete("/invitations/:id", owner, asyncRoute(async (req, res) => {
    const actor = tenantActor(res); const id = parseInput(recordId, req.params.id);
    await prisma.$transaction(async tx => {
      await ownerLock(tx, actor);
      const row = await tx.teamInvitation.updateMany({ where: { id, organizationId: actor.organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (!row.count) throw new RequestError(404, "invitation-unavailable");
      await recordRegistration(tx, actor, "TEAM_INVITATION", id, "ARCHIVED");
    }); res.status(204).end();
  }));
  return router;
}

export async function activateTeamInvitation(prisma: PrismaClient, { code, password }: z.infer<typeof teamActivationInput>) {
  const tokenHash = createHash("sha256").update(code).digest("hex");
  const invitation = await prisma.teamInvitation.findUnique({ where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, organization: { archivedAt: null, accessSuspendedAt: null } } });
  if (!invitation || !employeeRole.safeParse(invitation.role).success) throw new RequestError(404, "invitation-unavailable");
  const existing = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true, passwordHash: true } });
  if (existing && !await verifyPassword(password, existing.passwordHash)) throw new RequestError(403, "activation-password-invalid");
  if (!existing && !newPasswordSchema.safeParse(password).success) throw new RequestError(400, "new-password-too-short");
  const passwordHash = existing ? undefined : await hashPassword(password);
  const company = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id"=${invitation.organizationId} FOR UPDATE`;
    if (!await lockActiveOrganization(tx, invitation.organizationId)) throw new RequestError(404, "invitation-unavailable");
    const creator = await tx.membership.findUnique({ where: { userId_organizationId: { userId: invitation.createdByUserId, organizationId: invitation.organizationId } }, select: { role: true } });
    if (creator?.role !== "OWNER") throw new RequestError(404, "invitation-unavailable");
    const claimed = await tx.teamInvitation.updateMany({ where: { id: invitation.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
    if (!claimed.count) throw new RequestError(404, "invitation-unavailable");
    const user = existing ? await tx.user.findUnique({ where: { id: existing.id, passwordHash: existing.passwordHash }, select: { id: true } })
      : await tx.user.create({ data: { name: invitation.name, email: invitation.email, passwordHash: passwordHash! }, select: { id: true } });
    if (!user) throw new RequestError(403, "activation-password-invalid");
    if (await tx.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } }, select: { id: true } })) throw new RequestError(409, "already-team-member");
    const member = await tx.membership.create({ data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role, department: invitation.department } });
    await tx.authAuditEvent.create({ data: { organizationId: invitation.organizationId, userId: user.id, action: "MEMBERSHIP_PROVISIONED" } });
    await recordRegistration(tx, { organizationId: invitation.organizationId, actorUserId: user.id }, "MEMBERSHIP", member.id, "CREATED");
    return tx.organization.findUniqueOrThrow({ where: { id: invitation.organizationId }, select: { cnpj: true } });
  }, { timeout: 15000 });
  return { cnpj: company.cnpj, documentType: company.cnpj ? "CNPJ" : "CPF" };
}
