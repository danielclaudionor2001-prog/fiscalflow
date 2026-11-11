import "dotenv/config";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { isIP } from "node:net";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createApp } from "./app.ts";
import { emailSchema } from "./auth/credentials.ts";
import { createAuthRouter } from "./auth/router.ts";
import { configureCelcoinSandbox } from "./billing/celcoin-sandbox.ts";
import { configureCertificateVault } from "./fiscal/certificate-vault.ts";
import { runDueDraftSchedules } from "./invoices/schedules.ts";
import { createRegistrationsRouter } from "./registrations/router.ts";
import { organizationDocumentSchema } from "./registrations/input.ts";

const webOriginSchema = z.url().refine((origin) => {
  const url = URL.parse(origin);
  return url?.origin === origin && ["http:", "https:"].includes(url.protocol);
});

const config = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TRUSTED_PROXY_IPS: z.string().trim().default("")
    .transform((value) => value ? value.split(",").map((ip) => ip.trim()) : [])
    .refine((ips) => ips.every((ip) => isIP(ip) !== 0)),
  TRUST_RENDER_PROXY: z.stringbool().default(false),
  RENDER: z.string().optional(),
  RENDER_SERVICE_TYPE: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  WEB_ORIGIN: webOriginSchema.default("http://127.0.0.1:5173"),
  WEB_ALTERNATE_ORIGIN: webOriginSchema.refine((origin) => origin.startsWith("https://")).optional(),
  SERVE_WEB: z.stringbool().default(false),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
}).refine(
  ({ NODE_ENV, WEB_ORIGIN }) => NODE_ENV !== "production" || WEB_ORIGIN.startsWith("https://"),
  { path: ["WEB_ORIGIN"] },
).refine(
  (settings) => !settings.TRUST_RENDER_PROXY || (
    settings.NODE_ENV === "production" && settings.RENDER === "true" &&
    settings.RENDER_SERVICE_TYPE === "web" && settings.TRUSTED_PROXY_IPS.length === 0
  ),
  { path: ["TRUST_RENDER_PROXY"] },
).safeParse({ ...process.env, WEB_ORIGIN: process.env.WEB_ORIGIN || process.env.RENDER_EXTERNAL_URL });

if (!config.success) {
  const fields = config.error.issues.map((issue) => issue.path.join("."));
  console.error("Invalid API configuration:", fields.join(", "));
  process.exit(1);
}

const { API_HOST: host, PORT: port, WEB_ORIGIN: webOrigin, DATABASE_URL: databaseUrl } = config.data;
const alternateWebOrigin = config.data.WEB_ALTERNATE_ORIGIN;
const webOrigins = alternateWebOrigin ? [webOrigin, alternateWebOrigin] : webOrigin;
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const secureCookie = config.data.NODE_ENV === "production";
const trustedProxy = config.data.TRUST_RENDER_PROXY ? 1 : config.data.TRUSTED_PROXY_IPS;
const vault = (() => {
  try {
    return configureCertificateVault(
      process.env.FISCAL_CERTIFICATE_KEY,
      process.env.FISCAL_CERTIFICATE_ROOTS_FILE,
      process.env.FISCAL_CERTIFICATE_INTERMEDIATES_FILE,
    );
  } catch {
    console.error("Invalid certificate vault configuration. Check the encryption key and certificate bundles.");
    process.exit(1);
  }
})();
if (vault) console.info("A1 certificate vault initialized.");
const authRouter = createAuthRouter(prisma, webOrigins, secureCookie);
const celcoin = (() => {
  try {
    return configureCelcoinSandbox(process.env.CELCOIN_SANDBOX_CONFIG_FILE);
  } catch {
    console.error("Invalid Celcoin Sandbox configuration. Check the server-side file.");
    process.exit(1);
  }
})();
const registrationsRouter = createRegistrationsRouter(prisma, webOrigin, secureCookie, vault, celcoin, alternateWebOrigin);
const app = createApp(webOrigins, async () => {
  await prisma.$queryRaw`SELECT 1`;
}, authRouter, trustedProxy, registrationsRouter);

if (config.data.SERVE_WEB) {
  const webRoot = new URL("../../web/dist/", import.meta.url);
  try {
    await access(new URL("index.html", webRoot));
  } catch {
    console.error("The web build is missing. Run npm run build before starting.");
    process.exit(1);
  }
  app.use(express.static(fileURLToPath(webRoot), { dotfiles: "deny" }));
}

async function bootstrapFirstAccess() {
  const raw = process.env.FISCALFLOW_FIRST_ACCESS;
  if (!raw) return;
  const input = z.strictObject({
    cnpj: organizationDocumentSchema.refine((document) => document.length === 14),
    company: z.string().trim().min(1).max(160),
    email: emailSchema,
    name: z.string().trim().min(1).max(120),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.iso.datetime().transform((value) => new Date(value)),
    platformOwner: z.boolean().default(false),
  }).parse(JSON.parse(raw));
  const { cnpj, company, expiresAt, platformOwner, ...invitation } = input;
  const ttl = expiresAt.getTime() - Date.now();
  if (ttl <= 0) return;
  if (ttl > 48 * 60 * 60 * 1000) throw new Error("Invalid first access expiry.");

  const created = await prisma.$transaction(async (tx) => {
    if (platformOwner) {
      const formattedCnpj = cnpj.replace(/^(..)(...)(...)(....)(..)$/, "$1.$2.$3/$4-$5");
      const existing = await tx.organization.findFirst({ where: { OR: [
        { cnpj: { in: [cnpj, formattedCnpj] } },
        { memberships: { some: { platformOwner: true } } },
        { accessInvitation: { is: { platformOwner: true } } },
      ] }, select: { id: true } });
      if (existing) return false;
    } else if (await tx.organization.count()) return false;

    await tx.organization.create({
      data: { cnpj, legalName: company, accessInvitation: { create: { ...invitation, expiresAt, platformOwner } } },
    });
    return true;
  }, { isolationLevel: "Serializable" });
  if (created) console.info("First access invitation created.");
}

try {
  await bootstrapFirstAccess();
} catch {
  console.error("Unable to configure first access. Check FISCALFLOW_FIRST_ACCESS and database migrations.");
  await prisma.$disconnect();
  process.exit(1);
}

let scheduleTimer: NodeJS.Timeout | undefined;
let scheduleRun: Promise<void> | undefined;

function runSchedules() {
  scheduleRun ??= runDueDraftSchedules(prisma).catch(() => {
    console.error("Unable to process draft schedules.");
  }).finally(() => {
    scheduleRun = undefined;
  });
}

const server = app.listen(port, host, () => {
  runSchedules();
  scheduleTimer = setInterval(runSchedules, 60_000);
  console.log(`Fiscal Floow API listening on ${host}:${port}`);
});

server.on("error", () => {
  console.error("Unable to start the Fiscal Floow API. Check the host and port.");
  process.exitCode = 1;
});

function shutdown() {
  clearInterval(scheduleTimer);
  server.close(async () => {
    try {
      await scheduleRun;
      await prisma.$disconnect();
    } catch {
      console.error("Unable to close the database connection.");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
