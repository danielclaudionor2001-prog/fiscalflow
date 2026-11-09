import type { BillingPurpose, PrismaClient, ReceivingAccount } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { platformOwnerOnly, requirePlatformOwner } from "../organizations/platform.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";

const accountNumber = z.string().trim().regex(/^\d{1,19}(?:-[0-9Xx])?$/).transform((value) => value.toUpperCase());
const accountInput = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("CELCOIN"), accountNumber }),
  z.strictObject({
    provider: z.literal("OWN_BANK"),
    bankName: z.string().trim().min(2).max(100),
    bankCode: z.string().trim().regex(/^\d{3}$/),
    branch: z.string().trim().regex(/^\d{1,8}(?:-[0-9Xx])?$/).transform((value) => value.toUpperCase()),
    accountNumber,
  }),
]);

export function accountLastFour(number: string) {
  // Keep at least one account character masked, including for short accounts.
  const compact = number.replace("-", "");
  return compact.slice(Math.max(1, compact.length - 4));
}

function accountView(account: ReceivingAccount) {
  const { provider, bankName, bankCode, branch } = account;
  return { provider, bankName, bankCode, branch, accountLastFour: accountLastFour(account.accountNumber) };
}

export function createReceivingAccountRouter(prisma: PrismaClient, cookieName: string, purpose: BillingPurpose) {
  const router = express.Router();
  const subscription = purpose === "SUBSCRIPTION";
  const access = subscription
    ? [authorize(prisma, cookieName, "OWNER"), platformOwnerOnly]
    : [authorize(prisma, cookieName, "OWNER")];
  router.use(...access);
  router.get("/", asyncRoute(async (_req, res) => {
    const { organizationId } = tenantActor(res);
    const account = await prisma.receivingAccount.findUnique({
      where: { organizationId_purpose: { organizationId, purpose } },
    });
    res.json({ account: account && accountView(account) });
  }));

  router.put("/", express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
    const input = parseInput(accountInput, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const account = await prisma.$transaction(async (tx) => {
      if (subscription) await requirePlatformOwner(tx, actor);
      else {
        await requireActiveOrganization(tx, organizationId);
        const membership = await tx.membership.findUnique({
          where: { userId_organizationId: { userId: actor.actorUserId, organizationId } },
          select: { role: true },
        });
        if (membership?.role !== "OWNER") throw new RequestError(403, "insufficient-role");
      }
      const data = input.provider === "CELCOIN"
        ? { ...input, bankName: "Celcoin", bankCode: null, branch: null }
        : input;
      const saved = await tx.receivingAccount.upsert({
        where: { organizationId_purpose: { organizationId, purpose } },
        create: { organizationId, purpose, ...data },
        update: data,
      });
      await recordRegistration(tx, actor, "RECEIVING_ACCOUNT", purpose, "UPDATED");
      return saved;
    });
    res.json({ account: accountView(account) });
  }));
  return router;
}
