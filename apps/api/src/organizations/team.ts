import { Prisma, Role, type PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { pagination, recordId } from "../registrations/input.ts";

const roleUpdate = z.strictObject({ role: z.enum(Role) });
const memberSelect = {
  id: true,
  role: true,
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.MembershipSelect;

function memberView(member: Prisma.MembershipGetPayload<{ select: typeof memberSelect }>, actorUserId: string) {
  const { id, role, user } = member;
  return { id, role, name: user.name, email: user.email, isSelf: user.id === actorUserId };
}

async function mutableMember(tx: Prisma.TransactionClient, actor: ReturnType<typeof tenantActor>, id: string) {
  const { organizationId, actorUserId } = actor;
  // Serialize membership mutations so two owners cannot revoke each other at the same time.
  const organizations = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Organization"
    WHERE "id" = ${organizationId} AND "archivedAt" IS NULL AND "accessSuspendedAt" IS NULL FOR UPDATE
  `;
  if (!organizations.length) throw new RequestError(401, "authentication-required");
  const owner = await tx.membership.findUnique({
    where: { userId_organizationId: { userId: actorUserId, organizationId } },
    select: { role: true },
  });
  if (owner?.role !== "OWNER") throw new RequestError(403, "insufficient-role");
  const where = { id, organizationId };
  const member = await tx.membership.findUnique({ where, select: memberSelect });
  if (!member) throw new RequestError(404, "member-unavailable");
  if (member.user.id === actorUserId) throw new RequestError(409, "own-membership");
  return { member, where };
}

export function createTeamRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const owner = authorize(prisma, cookieName, "OWNER");

  router.get("/", read, asyncRoute(async (req, res) => {
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId, actorUserId } = tenantActor(res);
    const rows = await prisma.membership.findMany({
      where: { organizationId, organization: { archivedAt: null } },
      orderBy: [{ user: { name: "asc" } }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
      select: memberSelect,
    });
    res.json({ items: rows.slice(0, limit).map((member) => memberView(member, actorUserId)), hasNext: rows.length > limit });
  }));

  router.patch("/:id", owner, express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { role } = parseInput(roleUpdate, req.body);
    const actor = tenantActor(res);
    const saved = await prisma.$transaction(async (tx) => {
      const { member, where } = await mutableMember(tx, actor, id);
      if (member.role === role) return member;
      const updated = await tx.membership.update({ where, data: { role, platformOwner: false, loginCpf: null }, select: memberSelect });
      await tx.session.deleteMany({ where: { organizationId: actor.organizationId, userId: member.user.id } });
      await recordRegistration(tx, actor, "MEMBERSHIP", id, "UPDATED");
      return updated;
    });
    res.json(memberView(saved, actor.actorUserId));
  }));

  router.delete("/:id", owner, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      const { where } = await mutableMember(tx, actor, id);
      await tx.membership.delete({ where });
      await recordRegistration(tx, actor, "MEMBERSHIP", id, "ARCHIVED");
    });
    res.status(204).end();
  }));

  return router;
}
