import "dotenv/config";
import { isIP } from "node:net";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createApp } from "./app.ts";
import { createAuthRouter } from "./auth/router.ts";
import { configureCelcoinSandbox } from "./billing/celcoin-sandbox.ts";
import { configureCertificateVault } from "./fiscal/certificate-vault.ts";
import { runDueDraftSchedules } from "./invoices/schedules.ts";
import { createRegistrationsRouter } from "./registrations/router.ts";

const config = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TRUSTED_PROXY_IPS: z.string().trim().default("")
    .transform((value) => value ? value.split(",").map((ip) => ip.trim()) : [])
    .refine((ips) => ips.every((ip) => isIP(ip) !== 0)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  WEB_ORIGIN: z.url().refine((origin) => {
    const url = URL.parse(origin);
    return url?.origin === origin && ["http:", "https:"].includes(url.protocol);
  }).default("http://127.0.0.1:5173"),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
}).refine(
  ({ NODE_ENV, WEB_ORIGIN }) => NODE_ENV !== "production" || WEB_ORIGIN.startsWith("https://"),
  { path: ["WEB_ORIGIN"] },
).safeParse(process.env);

if (!config.success) {
  const fields = config.error.issues.map((issue) => issue.path.join("."));
  console.error("Invalid API configuration:", fields.join(", "));
  process.exit(1);
}

const { API_HOST: host, PORT: port, WEB_ORIGIN: webOrigin, DATABASE_URL: databaseUrl } = config.data;
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const secureCookie = config.data.NODE_ENV === "production";
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
const authRouter = createAuthRouter(prisma, webOrigin, secureCookie);
const celcoin = (() => {
  try {
    return configureCelcoinSandbox(process.env.CELCOIN_SANDBOX_CONFIG_FILE);
  } catch {
    console.error("Invalid Celcoin Sandbox configuration. Check the server-side file.");
    process.exit(1);
  }
})();
const registrationsRouter = createRegistrationsRouter(prisma, webOrigin, secureCookie, vault, celcoin);
const app = createApp(webOrigin, async () => {
  await prisma.$queryRaw`SELECT 1`;
}, authRouter, config.data.TRUSTED_PROXY_IPS, registrationsRouter);

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
  console.log(`FiscalFlow API listening on ${host}:${port}`);
});

server.on("error", () => {
  console.error("Unable to start the FiscalFlow API. Check the host and port.");
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
