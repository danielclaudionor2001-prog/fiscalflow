import type { Prisma, PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { recordRegistration, requireActiveOrganization, tenantActor } from "../registrations/catalog.ts";

const maxLogoBytes = 384 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const brandingUpdate = z.strictObject({
  commercialEmail: z.email().max(254).nullable(),
  commercialPhone: z.string().trim().min(1).max(40).nullable(),
  commercialAddress: z.string().trim().min(1).max(300).nullable(),
  quoteWatermark: z.boolean(),
  commercialLogo: z.base64().max(maxLogoBytes / 3 * 4).nullable().optional(),
});

function parseLogo(encoded: string | null | undefined) {
  if (encoded == null) return encoded;
  const png = Buffer.from(encoded, "base64");
  if (png.length < 45 || png.length > maxLogoBytes || !png.subarray(0, 8).equals(pngSignature) ||
      png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new RequestError(400, "invalid-logo");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 640 || height > 640) throw new RequestError(400, "invalid-logo");
  let hasImage = false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) break;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length) hasImage = true;
    if (type === "IEND" && length === 0 && hasImage && end === png.length) return png;
    offset = end;
  }
  throw new RequestError(400, "invalid-logo");
}

export const brandingSelect = {
  legalName: true, tradeName: true, cnpj: true, commercialEmail: true, commercialPhone: true,
  commercialAddress: true, commercialLogo: true, quoteWatermark: true,
} satisfies Prisma.OrganizationSelect;

export function brandingView({ commercialLogo, ...brand }: Prisma.OrganizationGetPayload<{ select: typeof brandingSelect }>) {
  return { ...brand, logo: commercialLogo ? "data:image/png;base64," + Buffer.from(commercialLogo).toString("base64") : null };
}

export function createBrandingRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  router.get("/", authorize(prisma, cookieName), asyncRoute(async (_req, res) => {
    const { organizationId } = tenantActor(res);
    const brand = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId, archivedAt: null, accessSuspendedAt: null }, select: brandingSelect,
    });
    res.json(brandingView(brand));
  }));
  router.put("/", authorize(prisma, cookieName, "OWNER", "ADMIN"), express.json({ limit: "520kb" }), asyncRoute(async (req, res) => {
    const actor = tenantActor(res);
    const { commercialLogo, ...fields } = parseInput(brandingUpdate, req.body);
    const logo = parseLogo(commercialLogo);
    const brand = await prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, actor.organizationId);
      const saved = await tx.organization.update({
        where: { id: actor.organizationId }, data: { ...fields, commercialLogo: logo }, select: brandingSelect,
      });
      await recordRegistration(tx, actor, "ORGANIZATION", actor.organizationId, "UPDATED");
      return saved;
    });
    res.json(brandingView(brand));
  }));
  return router;
}
