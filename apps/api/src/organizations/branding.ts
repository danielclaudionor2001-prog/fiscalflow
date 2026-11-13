import type { Prisma, PrismaClient } from "@prisma/client";
import { inflateSync } from "node:zlib";
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

export function usableCommercialLogo(png: Buffer) {
  if (png.length < 45 || png.length > maxLogoBytes || !png.subarray(0, 8).equals(pngSignature) ||
      png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") {
    return false;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[png[25]];
  if (!width || !height || width > 640 || height > 640 || !channels || png[24] !== 8 ||
      png[26] !== 0 || png[27] !== 0 || png[28] !== 0) return false;
  const image: Buffer[] = [];
  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) return false;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") return false;
    if (type === "IDAT") image.push(png.subarray(offset + 8, end - 4));
    if (type === "IEND" && length === 0 && end === png.length) {
      const stride = width * channels + 1;
      try {
        const pixels = inflateSync(Buffer.concat(image), { maxOutputLength: stride * height });
        if (pixels.length !== stride * height) return false;
        for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) return false;
        return true;
      } catch {
        return false;
      }
    }
    offset = end;
  }
  return false;
}

function parseLogo(encoded: string | null | undefined) {
  if (encoded == null) return encoded;
  const png = Buffer.from(encoded, "base64");
  if (!usableCommercialLogo(png)) throw new RequestError(400, "invalid-logo");
  return png;
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
