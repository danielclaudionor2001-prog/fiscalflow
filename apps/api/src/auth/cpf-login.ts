import type { PrismaClient } from "@prisma/client";
import express, { type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { cpfSchema } from "../registrations/input.ts";
import { verifyPassword } from "./credentials.ts";
import { authorize, type AuthSession } from "./sessions.ts";

const cpfChange = z.strictObject({ cpf: cpfSchema.nullable(), password: z.string().min(1).max(128) });

function ownerScope(res: Response) {
  const { membership } = res.locals.auth as AuthSession;
  if (!membership.organization.cnpj) throw new RequestError(409, "cpf-login-requires-company");
  const actor = tenantActor(res);
  return { actor, where: { userId_organizationId: { userId: actor.actorUserId, organizationId: actor.organizationId }, role: "OWNER" as const } };
}

function view(cpf: string | null) {
  return { cpfMasked: cpf && "***.***.***-" + cpf.slice(-2) };
}

export function createCpfLoginRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const owner = authorize(prisma, cookieName, "OWNER");
  const changeLimit = rateLimit({
    windowMs: 15 * 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false, identifier: "cpf-login",
    message: { code: "too-many-attempts" },
  });

  router.get("/", owner, asyncRoute(async (_req, res) => {
    const { where } = ownerScope(res);
    const member = await prisma.membership.findUnique({ where, select: { loginCpf: true } });
    if (!member) throw new RequestError(403, "insufficient-role");
    res.json(view(member.loginCpf));
  }));

  router.put("/", owner, changeLimit, express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
    const { actor, where } = ownerScope(res);
    const { cpf, password } = parseInput(cpfChange, req.body);
    const member = await prisma.membership.findUnique({ where, select: { user: { select: { passwordHash: true } } } });
    const passwordHash = member?.user.passwordHash;
    if (!await verifyPassword(password, passwordHash) || !passwordHash) throw new RequestError(403, "password-confirmation-failed");

    await prisma.$transaction(async (tx) => {
      // Take an exclusive lock so a concurrent login checks the new link before opening a session.
      const active = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Organization" WHERE "id" = ${actor.organizationId}
          AND "cnpj" IS NOT NULL AND "archivedAt" IS NULL AND "accessSuspendedAt" IS NULL FOR UPDATE
      `;
      if (!active.length) throw new RequestError(401, "authentication-required");
      const current = await tx.membership.findUnique({
        where: { ...where, user: { passwordHash } }, select: { id: true, loginCpf: true },
      });
      if (!current) throw new RequestError(403, "password-confirmation-failed");
      if (current.loginCpf === cpf) return;
      await tx.membership.update({ where, data: { loginCpf: cpf } });
      await recordRegistration(tx, actor, "MEMBERSHIP", current.id, "UPDATED");
    });
    res.json(view(cpf));
  }));

  return router;
}
