import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes } from "node:crypto";
import type { BillingPurpose } from "@prisma/client";
import { RequestError } from "../http.ts";
import { keySchema, createAsaasClient, type AsaasEnvironment } from "./asaas-client.ts";

type Binding = { organizationId: string; purpose: BillingPurpose; version: string; environment?: AsaasEnvironment };
const aad = (binding: Binding) => Buffer.from(JSON.stringify([binding.environment === "PRODUCTION" ? "fiscalfloow-asaas-production-v1" : "fiscalfloow-asaas-sandbox-v1", binding.organizationId, binding.purpose, binding.version]));

export function createAsaasGateway(keyValue: string, fetcher: typeof fetch = fetch) {
  const bytes = Buffer.from(keyValue, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== keyValue) { bytes.fill(0); throw new Error("Invalid billing vault key."); }
  // Domain separation also permits safely deriving from the existing external vault master.
  const key = createSecretKey(Buffer.from(hkdfSync("sha256", bytes, "FiscalFloow", "asaas-sandbox-credentials-v1", 32)));
  const productionKey = createSecretKey(Buffer.from(hkdfSync("sha256", bytes, "FiscalFloow", "asaas-production-credentials-v1", 32)));
  bytes.fill(0);
  function seal(binding: Binding, apiKey: string) {
    if (!keySchema(binding.environment ?? "SANDBOX").safeParse(apiKey).success) throw new RequestError(400, "asaas-key-invalid");
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", binding.environment === "PRODUCTION" ? productionKey : key, nonce);
    cipher.setAAD(aad(binding));
    const plain = Buffer.from(apiKey, "utf8");
    try { const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); }
    finally { plain.fill(0); }
  }
  async function use<T>(binding: Binding, sealed: Uint8Array, operation: (apiKey: string) => Promise<T>) {
    let plain: Buffer | undefined;
    try {
      try {
        const decipher = createDecipheriv("aes-256-gcm", binding.environment === "PRODUCTION" ? productionKey : key, sealed.subarray(0, 12));
        decipher.setAAD(aad(binding)); decipher.setAuthTag(sealed.subarray(12, 28));
        plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
      } catch { throw new RequestError(503, "asaas-vault-unavailable"); }
      const apiKey = plain.toString("utf8");
      if (!keySchema(binding.environment ?? "SANDBOX").safeParse(apiKey).success) throw new RequestError(503, "asaas-vault-unavailable");
      return await operation(apiKey);
    } finally { plain?.fill(0); }
  }
  const client = createAsaasClient(fetcher), productionClient = createAsaasClient(fetcher, "PRODUCTION");
  return { seal, use, client, clientFor: (environment: AsaasEnvironment) => environment === "PRODUCTION" ? productionClient : client };
}
export type AsaasGateway = ReturnType<typeof createAsaasGateway>;

export function configureAsaasGateway(billingKey?: string, certificateMaster?: string) {
  const key = billingKey || certificateMaster;
  return key ? createAsaasGateway(key) : undefined;
}
