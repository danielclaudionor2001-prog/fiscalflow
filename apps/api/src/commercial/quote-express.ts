import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { lockDraftReferences } from "../invoices/drafts.ts";
import { brandingSelect, brandingView } from "../organizations/branding.ts";
import { recordRegistration, type tenantActor } from "../registrations/catalog.ts";
import { commercialTransaction, today } from "./common.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const decisionInput = z.enum(["APPROVED", "DECLINED"]);
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicAccess = {
  token: tokenInput,
  document: z.string().trim().max(32).regex(/^[0-9A-Za-z./-]+$/)
    .transform((document) => document.replace(/[./-]/g, "").toUpperCase())
    .pipe(z.string().regex(/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/)),
};
export const shareInput = z.strictObject({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const quoteShareStatus = {
  expiresAt: true, revokedAt: true, decision: true, respondedAt: true,
} satisfies Prisma.QuoteShareSelect;

const orderAccessSelect = {
  kind: true, status: true, dueOn: true, customerId: true,
} satisfies Prisma.CommercialOrderSelect;
type QuoteAccess = Prisma.CommercialOrderGetPayload<{ select: typeof orderAccessSelect }>;
type Actor = ReturnType<typeof tenantActor>;
const unavailable = () => new RequestError(404, "quote-unavailable");
const publicQuoteSelect = {
  ...orderAccessSelect, id: true, customerName: true, createdAt: true, updatedAt: true, sellerName: true, note: true, amount: true,
  items: { orderBy: { position: "asc" }, select: { id: true, label: true, quantity: true, unitPrice: true } },
  organization: { select: brandingSelect },
} satisfies Prisma.CommercialOrderSelect;

function isExpired(order: Pick<QuoteAccess, "dueOn">) {
  return order.dueOn !== null && order.dueOn < today();
}

export async function createQuoteShare(tx: Prisma.TransactionClient, actor: Actor, id: string, order: QuoteAccess, tokenHash: string) {
  if (order.kind !== "QUOTE" || order.status !== "OPEN" || !order.customerId) throw new RequestError(409, "order-state");
  if (isExpired(order)) throw new RequestError(409, "quote-expired");
  const where = { organizationId: actor.organizationId, orderId: id };
  const previous = await tx.quoteShare.findUnique({ where: { organizationId_orderId: where }, select: { decision: true } });
  if (previous?.decision) throw new RequestError(409, "quote-answered");
  await lockDraftReferences(tx, actor.organizationId, { customerId: order.customerId });
  const { federalTaxId } = await tx.customer.findUniqueOrThrow({
    where: { id: order.customerId, organizationId: actor.organizationId }, select: { federalTaxId: true },
  });
  const data = { tokenHash, customerDocumentHash: digest(federalTaxId), expiresAt: new Date(Date.now() + 30 * 86400_000), revokedAt: null };
  const share = await tx.quoteShare.upsert({
    where: { organizationId_orderId: where }, create: { ...where, ...data }, update: data, select: quoteShareStatus,
  });
  await recordRegistration(tx, actor, "COMMERCIAL_ORDER", id, "UPDATED");
  return share;
}

export function quoteAwaitsResponse(share: { expiresAt: Date; revokedAt: Date | null; decision: string | null }, dueOn: Date | null) {
  return !share.revokedAt && !share.decision && share.expiresAt > new Date() && !isExpired({ dueOn });
}

async function customerMatches(tx: Prisma.TransactionClient, organizationId: string, order: QuoteAccess, expectedHash: string) {
  if (!order.customerId) return false;
  const customer = await tx.customer.findFirst({
    where: { organizationId, id: order.customerId, archivedAt: null }, select: { federalTaxId: true },
  });
  return customer !== null && digest(customer.federalTaxId) === expectedHash;
}

export function createQuoteExpressRouter(prisma: PrismaClient) {
  const router = express.Router();
  const json = express.json({ limit: "1kb" });
  const byIp = rateLimit({
    windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
    skipSuccessfulRequests: true, message: { code: "rate-limited" },
  });
  const byLink = rateLimit({
    windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
    skipSuccessfulRequests: true, skip: (req) => !tokenInput.safeParse(req.body?.token).success,
    keyGenerator: (req) => digest(req.body.token), message: { code: "rate-limited" },
  });

  const viewInput = z.strictObject(publicAccess);
  const responseInput = viewInput.extend({ decision: decisionInput });
  function access(respond: boolean) {
    return asyncRoute(async (req, res) => {
      const { token, document, decision } = respond
        ? parseInput(responseInput, req.body)
        : { ...parseInput(viewInput, req.body), decision: undefined };
      const tokenHash = digest(token);
      const documentHash = digest(document);
      const target = await prisma.quoteShare.findUnique({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() },
          order: { organization: { archivedAt: null, accessSuspendedAt: null } } },
        select: { organizationId: true, orderId: true, customerDocumentHash: true },
      });
      if (!target || !timingSafeEqual(Buffer.from(target.customerDocumentHash, "hex"), Buffer.from(documentHash, "hex"))) throw unavailable();

      const { organizationId, orderId } = target;
      const result = await commercialTransaction(prisma, organizationId, async (tx) => {
        const share = await tx.quoteShare.findUnique({
          where: { tokenHash, organizationId, orderId, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { ...quoteShareStatus, customerDocumentHash: true },
        });
        const row = await tx.commercialOrder.findUnique({
          where: { id: orderId, organizationId, kind: "QUOTE", status: { not: "CANCELLED" } }, select: publicQuoteSelect,
        });
        if (!share || !row || share.customerDocumentHash !== documentHash ||
            (!share.decision && (row.status !== "OPEN" || isExpired(row)))) throw unavailable();
        if (decision && row.customerId) await lockDraftReferences(tx, organizationId, { customerId: row.customerId });
        if (!await customerMatches(tx, organizationId, row, documentHash)) throw unavailable();

        let answer = { decision: share.decision, respondedAt: share.respondedAt };
        if (decision && share.decision && share.decision !== decision) throw new RequestError(409, "quote-answered");
        if (decision && !share.decision) {
          answer = await tx.quoteShare.update({
            where: { organizationId_orderId: { organizationId, orderId } },
            data: { decision, respondedAt: new Date() }, select: { decision: true, respondedAt: true },
          });
          await tx.commercialOrder.update({ where: { id: orderId, organizationId }, data: {
            updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
          } });
          await recordRegistration(tx, { organizationId, actorUserId: null }, "COMMERCIAL_ORDER", orderId,
            decision === "APPROVED" ? "QUOTE_APPROVED" : "QUOTE_DECLINED");
        }
        const { id, customerName, createdAt, dueOn, sellerName, note, amount, items, organization } = row;
        return { id, customerName, createdAt, dueOn, sellerName, note, amount, items, brand: brandingView(organization), ...answer };
      }).catch((error) => {
        if (error instanceof RequestError && (error.status === 401 || error.code === "customer-unavailable")) throw unavailable();
        throw error;
      });
      res.json(result);
    });
  }

  router.post("/view", byIp, json, byLink, access(false));
  router.post("/respond", byIp, json, byLink, access(true));
  return router;
}
