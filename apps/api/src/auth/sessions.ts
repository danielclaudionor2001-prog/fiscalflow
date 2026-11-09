import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient, type Role } from "@prisma/client";
import type { Request, RequestHandler } from "express";
import { lockActiveOrganization } from "../organizations/access.ts";

export const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const idleLifetimeMs = 30 * 60 * 1000;

const sessionSelect = {
  id: true,
  expiresAt: true,
  membership: {
    select: {
      role: true,
      platformOwner: true,
      user: { select: { id: true, name: true, email: true } },
      organization: { select: { id: true, legalName: true, cnpj: true } },
    },
  },
} satisfies Prisma.SessionSelect;

export type AuthSession = Prisma.SessionGetPayload<{ select: typeof sessionSelect }>;

export function sessionCookieName(secure: boolean) {
  return secure ? "__Host-fiscalflow_session" : "fiscalflow_session";
}

export function sessionView({ membership, expiresAt }: AuthSession) {
  return { ...membership, platformOwner: membership.role === "OWNER" && membership.platformOwner, expiresAt };
}

export function cpfMembershipScope(cpf: string): Prisma.MembershipWhereInput {
  return {
    OR: [
      { organization: { cpf } },
      { loginCpf: cpf, role: "OWNER", organization: { cnpj: { not: null } } },
    ],
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function readSessionHash(req: Request, cookieName: string) {
  const prefix = `${cookieName}=`;
  const cookie = req.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  const token = cookie?.slice(prefix.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : undefined;
}

export async function revokeSession(tx: Prisma.TransactionClient, tokenHash: string) {
  const session = await tx.session.findUnique({
    where: { tokenHash },
    select: { id: true, organizationId: true, userId: true },
  });
  if (!session) return;

  const { id, organizationId, userId } = session;
  const removed = await tx.session.deleteMany({ where: { id, organizationId, userId } });
  if (removed.count) {
    await tx.authAuditEvent.create({ data: { organizationId, userId, action: "SESSION_ENDED" } });
  }
}

export async function openSession(
  prisma: PrismaClient,
  member: { organizationId: string; userId: string; user: { passwordHash: string } },
  previousHash: string | undefined,
  cpf?: string,
) {
  const { organizationId, userId } = member;
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs);

  return prisma.$transaction(async (tx) => {
    if (!await lockActiveOrganization(tx, organizationId)) return null;
    const current = await tx.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId }, AND: cpf ? cpfMembershipScope(cpf) : undefined },
      select: { user: { select: { passwordHash: true } } },
    });
    if (current?.user.passwordHash !== member.user.passwordHash) return null;

    if (previousHash) await revokeSession(tx, previousHash);
    await tx.session.deleteMany({
      where: {
        organizationId,
        userId,
        OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lte: new Date(now.getTime() - idleLifetimeMs) } }],
      },
    });
    const session = await tx.session.create({
      data: { organizationId, userId, tokenHash: hashToken(token), lastSeenAt: now, expiresAt },
      select: sessionSelect,
    });
    await tx.authAuditEvent.create({ data: { organizationId, userId, action: "SESSION_STARTED" } });
    return { session, token };
  });
}

export function authorize(prisma: PrismaClient, cookieName: string, ...roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const tokenHash = readSessionHash(req, cookieName);
      const now = new Date();
      const session = tokenHash && await prisma.session.findUnique({
        where: {
          tokenHash,
          expiresAt: { gt: now },
          lastSeenAt: { gt: new Date(now.getTime() - idleLifetimeMs) },
          membership: { organization: { archivedAt: null, accessSuspendedAt: null } },
        },
        select: sessionSelect,
      });
      if (!session) {
        res.status(401).json({ code: "authentication-required" });
        return;
      }

      const { role, organization, user } = session.membership;
      const expectedOrganization = req.get("X-FiscalFlow-Context");
      if (expectedOrganization !== undefined && expectedOrganization !== organization.id) {
        res.status(409).json({ code: "organization-changed" });
        return;
      }
      if (roles.length && !roles.includes(role)) {
        res.status(403).json({ code: "insufficient-role" });
        return;
      }

      // Keep concurrent requests from moving lastSeenAt backwards.
      await prisma.session.updateMany({
        where: { id: session.id, organizationId: organization.id, userId: user.id, lastSeenAt: { lt: now } },
        data: { lastSeenAt: now },
      });
      res.locals.auth = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}
