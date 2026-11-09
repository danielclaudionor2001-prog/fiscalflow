import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { activateOrganization, activationInput } from "./activation.ts";
import { createCpfLoginRouter } from "./cpf-login.ts";
import { loginSchema, verifyPassword } from "./credentials.ts";
import { asyncRoute, handleApiError, parseInput, protectBrowserRequests } from "../http.ts";
import { authorize, cpfMembershipScope, openSession, readSessionHash, revokeSession, sessionCookieName, sessionLifetimeMs, sessionView, type AuthSession } from "./sessions.ts";

function loginAccount(organization: { legalName: string; cnpj: string | null }) {
  return { key: organization.cnpj ? "cnpj:" + organization.cnpj : "personal", ...organization };
}

export function createAuthRouter(prisma: PrismaClient, webOrigin: string, secureCookie: boolean) {
  const router = express.Router();
  const cookieName = sessionCookieName(secureCookie);
  const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: "strict", path: "/" } as const;

  router.use(protectBrowserRequests(webOrigin));
  router.use("/cpf-login", createCpfLoginRouter(prisma, cookieName));

  const loginLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "login",
    message: { code: "too-many-attempts" },
  });

  router.post("/login", loginLimit, express.json({ limit: "2kb" }), async (req, res, next) => {
    const input = loginSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: "invalid-input" });
      return;
    }

    try {
      const { email, password } = input.data;
      let documentScope: Prisma.OrganizationWhereInput;
      let cpf: string | undefined;
      let account: string | undefined;
      if ("organizationCnpj" in input.data) {
        documentScope = { cnpj: input.data.organizationCnpj };
      } else if (input.data.organizationDocument.length === 11) {
        cpf = input.data.organizationDocument;
        account = input.data.account;
        documentScope = {};
      } else {
        // Use the same normalization as the database's CNPJ uniqueness index.
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Organization"
          WHERE upper(translate(btrim("cnpj"), './-', '')) = ${input.data.organizationDocument}
        `;
        documentScope = { id: rows[0]?.id ?? "" };
      }
      const members = await prisma.membership.findMany({
        where: {
          user: { email },
          organization: { ...documentScope, archivedAt: null, accessSuspendedAt: null },
          ...(cpf && cpfMembershipScope(cpf)),
        },
        select: {
          organizationId: true, userId: true, user: { select: { passwordHash: true } },
          organization: { select: { legalName: true, cnpj: true } },
        },
        orderBy: [{ organization: { legalName: "asc" } }, { organizationId: "asc" }],
      });
      const valid = await verifyPassword(password, members[0]?.user.passwordHash);
      if (valid && !account && members.length > 1) {
        res.status(409).json({ code: "choose-account", accounts: members.map(({ organization }) => loginAccount(organization)) });
        return;
      }
      const member = account ? members.find(({ organization }) => loginAccount(organization).key === account) : members[0];
      const result = member && valid && await openSession(prisma, member, readSessionHash(req, cookieName), cpf);
      if (!result) {
        res.status(401).json({ code: "invalid-credentials" });
        return;
      }

      res.cookie(cookieName, result.token, { ...cookieOptions, maxAge: sessionLifetimeMs });
      res.json(sessionView(result.session));
    } catch (error) {
      // A membership can be removed between checking the password and inserting the session.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        res.status(401).json({ code: "invalid-credentials" });
        return;
      }
      next(error);
    }
  });

  router.get("/session", authorize(prisma, cookieName), (_req, res) => {
    res.json(sessionView(res.locals.auth as AuthSession));
  });

  router.post("/activate", loginLimit, express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
    res.json(await activateOrganization(prisma, parseInput(activationInput, req.body)));
  }));

  router.post("/logout", async (req, res, next) => {
    try {
      const tokenHash = readSessionHash(req, cookieName);
      if (tokenHash) await prisma.$transaction((tx) => revokeSession(tx, tokenHash));
      res.clearCookie(cookieName, cookieOptions);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/audit", authorize(prisma, cookieName, "OWNER", "ADMIN"), async (_req, res, next) => {
    try {
      const { membership } = res.locals.auth as AuthSession;
      const events = await prisma.authAuditEvent.findMany({
        where: { organizationId: membership.organization.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, userId: true, action: true, createdAt: true },
      });
      res.json({ events });
    } catch (error) {
      next(error);
    }
  });

  router.use(handleApiError);

  return router;
}
