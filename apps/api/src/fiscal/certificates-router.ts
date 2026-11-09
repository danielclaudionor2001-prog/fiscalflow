import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";
import type { CertificateVault } from "./certificate-vault.ts";
import { maxPfxBytes } from "./errors.ts";

const upload = z.strictObject({
  pfx: z.string().min(4).max(4 * Math.ceil(maxPfxBytes / 3)).pipe(z.base64()),
  password: z.string().min(1).max(512),
});
const matchVersion = z.string().regex(/^"[^"]+"$/).transform((value) => value.slice(1, -1));
const version = matchVersion.pipe(z.uuid());
const metadata = { version: true, validFrom: true, validUntil: true, savedAt: true } satisfies Prisma.FiscalCertificateSelect;

function view(certificate: Prisma.FiscalCertificateGetPayload<{ select: typeof metadata }> | null, enabled: boolean) {
  return {
    enabled, certificate: certificate && { ...certificate, expired: certificate.validUntil.getTime() <= Date.now() },
  };
}

async function requireOwner(tx: Prisma.TransactionClient, { organizationId, actorUserId }: ReturnType<typeof tenantActor>) {
  await requireActiveOrganization(tx, organizationId);
  const member = await tx.membership.findUnique({
    where: { userId_organizationId: { userId: actorUserId, organizationId } },
    select: { role: true },
  });
  if (member?.role !== "OWNER") throw new RequestError(403, "insufficient-role");
}

export function createCertificatesRouter(prisma: PrismaClient, cookieName: string, allowLoopback: boolean, vault?: CertificateVault) {
  const router = express.Router();
  const manage = authorize(prisma, cookieName, "OWNER");
  const read = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const limited = rateLimit({
    windowMs: 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false,
    message: { code: "rate-limited" },
  });
  const json = express.json({ limit: 4 * Math.ceil(maxPfxBytes / 3) + 4096, inflate: false });

  router.get("/", read, asyncRoute(async (_req, res) => {
    const { membership } = res.locals.auth as AuthSession;
    if (!membership.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const { organizationId } = tenantActor(res);
    const saved = await prisma.fiscalCertificate.findUnique({
      where: { organizationId, organization: { archivedAt: null } }, select: metadata,
    });
    res.json(view(saved, Boolean(vault)));
  }));

  router.put("/", manage, limited, (req, res, next) => {
    const { membership } = res.locals.auth as AuthSession;
    if (!membership.organization.cnpj) return next(new RequestError(409, "issuer-cnpj-required"));
    const address = req.socket.remoteAddress ?? "";
    const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
    if (!req.secure && !(allowLoopback && loopback)) return next(new RequestError(403, "secure-connection-required"));
    if (!vault) return next(new RequestError(503, "certificate-unavailable"));
    next();
  }, json, asyncRoute(async (req, res) => {
    if (!vault) throw new RequestError(503, "certificate-unavailable");
    const expected = parseInput(matchVersion.pipe(z.union([z.literal("missing"), z.uuid()])), req.get("If-Match"));
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const { membership } = res.locals.auth as AuthSession;
    if (!membership.organization.cnpj) throw new RequestError(409, "issuer-cnpj-required");
    const cnpj = membership.organization.cnpj.replace(/[./-]/g, "").toUpperCase();
    const { pfx, password } = parseInput(upload, req.body);
    req.body = undefined;
    const buffer = Buffer.from(pfx, "base64");
    const id = randomUUID();
    let data;
    try {
      if (buffer.length > maxPfxBytes) throw new RequestError(413, "invalid-input");
      const { fingerprint, validFrom, validUntil } = await vault.inspect(buffer, password, cnpj);
      data = { version: id, fingerprint, validFrom, validUntil, savedAt: new Date(), sealed: vault.seal({ organizationId, version: id }, buffer, password) };
    } finally {
      buffer.fill(0);
    }
    const creating = expected === "missing";
    const saved = await prisma.$transaction(async (tx) => {
      await requireOwner(tx, actor);
      const { count } = creating
        ? await tx.fiscalCertificate.createMany({ data: { ...data, organizationId }, skipDuplicates: true })
        : await tx.fiscalCertificate.updateMany({ where: { organizationId, version: expected }, data });
      if (count !== 1) throw new RequestError(409, "certificate-changed");
      await recordRegistration(tx, actor, "FISCAL_CERTIFICATE", id, creating ? "CREATED" : "UPDATED");
      return tx.fiscalCertificate.findUniqueOrThrow({ where: { organizationId, version: id }, select: metadata });
    });
    res.status(creating ? 201 : 200).json(view(saved, true));
  }));

  router.delete("/", manage, asyncRoute(async (req, res) => {
    const expected = parseInput(version, req.get("If-Match"));
    const actor = tenantActor(res);
    await prisma.$transaction(async (tx) => {
      await requireOwner(tx, actor);
      const { count } = await tx.fiscalCertificate.deleteMany({ where: { organizationId: actor.organizationId, version: expected } });
      if (count !== 1) throw new RequestError(409, "certificate-changed");
      await recordRegistration(tx, actor, "FISCAL_CERTIFICATE", expected, "ARCHIVED");
    });
    res.status(204).end();
  }));

  return router;
}
