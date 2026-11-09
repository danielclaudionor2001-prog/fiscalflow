import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BillingPurpose } from "@prisma/client";
import { z } from "zod";
import { RequestError } from "../http.ts";

const origin = "https://sandbox.openfinance.celcoin.dev";
const chargePath = "/baas/v2/charge";
export const sandboxAmount = 10;
const text = (max: number) => z.string().trim().min(1).max(max);
const document = z.string().regex(/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/);
const receiver = z.strictObject({ account: z.string().regex(/^\d{1,20}$/), document });
const debtor = z.strictObject({
  name: text(100), document, city: text(80), publicArea: text(100), number: text(16),
  neighborhood: text(80), postalCode: z.string().regex(/^\d{8}$/), state: z.string().regex(/^[A-Z]{2}$/),
});
const bindings = z.array(z.strictObject({
  organizationCnpj: z.string().regex(/^[A-Z0-9]{12}\d{2}$/),
  purpose: z.enum(["SERVICE", "SUBSCRIPTION"]),
  clientId: text(256),
  clientSecret: text(1024),
  pixKey: text(256),
  receiver,
  debtor,
})).min(1).max(100);

const tokenBody = z.object({ access_token: z.string().regex(/^[\w.+/=-]{1,4096}$/), token_type: z.string().toLowerCase().pipe(z.literal("bearer")) });
const accepted = z.object({ status: z.literal(201), body: z.object({ transactionId: z.uuid() }) });
const lookupBody = z.object({
  status: z.literal("SUCCESS"),
  body: z.object({
    transactionId: z.uuid(),
    externalId: text(100),
    amount: z.number(),
    duedate: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T.*)?$/),
    status: z.enum(["PROCESSING", "PENDING", "CONFIRMED", "CANCELED", "ERROR"]),
    receiver: z.object({ account: receiver.shape.account, document }),
    boleto: z.object({ bankLine: z.string().regex(/^\d{47}$/).nullish() }).nullish(),
  }),
});

type TestCharge = { externalId: string; dueDate: string; transactionId?: string | null };

export function createCelcoinSandbox(config: unknown, fetcher: typeof fetch = fetch) {
  const clients = new Map<string, ReturnType<typeof connect>>();
  for (const binding of bindings.parse(config)) {
    const key = binding.organizationCnpj + ":" + binding.purpose;
    if (clients.has(key)) throw new Error("Duplicate Celcoin Sandbox configuration");
    clients.set(key, connect(binding));
  }
  return {
    get(cnpj: string, purpose: BillingPurpose) {
      return clients.get(cnpj.replace(/[./-]/g, "").toUpperCase() + ":" + purpose);
    },
  };

  function connect({ clientId, clientSecret, debtor, receiver, pixKey }: z.infer<typeof bindings>[number]) {
    const fingerprint = createHash("sha256").update(receiver.account + ":" + receiver.document).digest("hex");
    return { fingerprint, authenticate, issue, lookup };

    async function authenticate() {
      const body = new FormData();
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
      body.set("grant_type", "client_credentials");
      const result = tokenBody.safeParse(await call("/v5/token", { method: "POST", body }, 200, "celcoin-sandbox-auth"));
      if (!result.success) throw new RequestError(502, "celcoin-sandbox-auth");
      return result.data.access_token;
    }

    async function issue(token: string, { externalId, dueDate }: TestCharge) {
      const body = JSON.stringify({
        externalId, duedate: dueDate, expirationAfterPayment: 1, amount: sandboxAmount,
        key: pixKey, chargeType: "BOLEPIX", debtor, receiver,
      });
      const result = accepted.safeParse(await call(chargePath, {
        method: "POST", body, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      }, 201, "celcoin-sandbox-response"));
      if (!result.success) throw new RequestError(502, "celcoin-sandbox-response");
      return result.data.body.transactionId;
    }

    async function lookup(token: string, charge: TestCharge) {
      const query = new URLSearchParams({ ExternalId: charge.externalId });
      const result = lookupBody.safeParse(await call(chargePath + "?" + query, {
        headers: { Authorization: "Bearer " + token },
      }, 200, "celcoin-sandbox-response"));
      if (!result.success) throw new RequestError(502, "celcoin-sandbox-response");
      const row = result.data.body;
      if (row.externalId !== charge.externalId || (charge.transactionId && row.transactionId !== charge.transactionId) ||
          row.receiver.account !== receiver.account || row.receiver.document !== receiver.document ||
          row.amount !== sandboxAmount || row.duedate.slice(0, 10) !== charge.dueDate) {
        throw new RequestError(502, "celcoin-sandbox-response");
      }
      return { transactionId: row.transactionId, status: row.status, bankLine: row.boleto?.bankLine ?? null };
    }
  }

  async function call(path: string, init: RequestInit, status: number, code: string): Promise<unknown> {
    try {
      const response = await fetcher(origin + path, {
        ...init, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json", ...init.headers },
      });
      if (response.status === status) return await response.json();
      await response.body?.cancel();
    } catch {
      // Return only a public error code. Credentials and provider payloads stay server-side.
    }
    throw new RequestError(502, code);
  }
}

export type CelcoinSandbox = ReturnType<typeof createCelcoinSandbox>;

export function configureCelcoinSandbox(path: string | undefined) {
  if (!path) return;
  if (!isAbsolute(path) || !statSync(path).isFile() || statSync(path).size > 64 * 1024) {
    throw new Error("Invalid Celcoin Sandbox configuration file");
  }
  const config: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return createCelcoinSandbox(config);
}
