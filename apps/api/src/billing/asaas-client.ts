import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { RequestError } from "../http.ts";

export type AsaasEnvironment = "SANDBOX" | "PRODUCTION";
// Origins are selected by server-owned routes, never by a URL supplied in a request.
export const asaasSandboxOrigin = "https://api-sandbox.asaas.com/v3";
export const asaasProductionOrigin = "https://api.asaas.com/v3";
export const asaasDocument = (value: string) => value.replace(/[.\s/-]/g, "").toUpperCase();
export const documentHash = (value: string) => createHash("sha256").update(asaasDocument(value)).digest("hex");
export const asaasId = z.string().regex(/^[A-Za-z0-9_-]{4,100}$/);
export const apiKeyInput = z.string().trim().min(32).max(1024).regex(/^[\x21-\x7e]+$/)
  .refine((value) => !value.startsWith("$aact_prod_"));
export const productionApiKeyInput = z.string().trim().min(32).max(1024).regex(/^\$aact_prod_[\x21-\x7e]+$/);
export const keySchema = (environment: AsaasEnvironment) => environment === "PRODUCTION" ? productionApiKeyInput : apiKeyInput;
const document = z.string().min(11).max(30).transform(asaasDocument).pipe(z.string().regex(/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/));
const customer = z.object({ id: asaasId, cpfCnpj: document, externalReference: z.string().nullish() });
const payment = z.object({
  id: asaasId, customer: asaasId, billingType: z.literal("BOLETO"), value: z.number().finite().positive(),
  dueDate: z.iso.date(), externalReference: z.string(), status: z.string().min(1).max(80),
  bankSlipUrl: z.string().max(2048).nullish(), invoiceUrl: z.string().max(2048).nullish(), deleted: z.boolean().optional(),
  paymentDate: z.iso.date().nullish(),
});
export type AsaasPayment = z.infer<typeof payment>;
export type ChargeBinding = {
  externalReference: string; payerDocumentHash: string; amount: string; dueDate: string; customerId?: string | null;
};

export function safeAsaasUrl(value: string | null | undefined, environment: AsaasEnvironment = "SANDBOX") {
  if (!value) return null;
  const url = URL.parse(value);
  const hosts = environment === "PRODUCTION" ? ["www.asaas.com", "asaas.com"] : ["sandbox.asaas.com"];
  if (!url || url.protocol !== "https:" || !hosts.includes(url.hostname) || url.port || url.username || url.password) {
    throw new RequestError(502, "asaas-response");
  }
  return url.href;
}

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(502, "asaas-response");
  return result.data;
}

export function createAsaasClient(fetcher: typeof fetch = fetch, environment: AsaasEnvironment = "SANDBOX") {
  async function call(key: string, path: string, body?: object): Promise<unknown> {
    if (!keySchema(environment).safeParse(key).success) throw new RequestError(400, "asaas-key-invalid");
    try {
      const response = await fetcher((environment === "PRODUCTION" ? asaasProductionOrigin : asaasSandboxOrigin) + path, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: { Accept: "application/json", "User-Agent": "FiscalFloow/0.1", access_token: key,
          ...(body && { "Content-Type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RequestError(response.status === 401 || response.status === 403 ? 422 : 502,
          response.status === 401 || response.status === 403 ? "asaas-auth" : "asaas-unavailable");
      }
      if (!response.body) throw new RequestError(502, "asaas-response");
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.byteLength;
        if (length > 256 * 1024) throw new RequestError(502, "asaas-response");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      // Neither upstream payloads nor secrets are propagated to logs or callers.
      throw new RequestError(502, "asaas-unavailable");
    }
  }
  async function accountDocument(key: string) {
    return read(z.object({ cpfCnpj: document }), await call(key, "/myAccount/commercialInfo/")).cpfCnpj;
  }
  async function assertAccountApproved(key: string) {
    const status = read(z.object({ general: z.string() }), await call(key, "/myAccount/status/"));
    if (status.general !== "APPROVED") throw new RequestError(422, "asaas-account-pending");
  }
  async function findCustomer(key: string, reference: string, payerDocument: string) {
    const query = new URLSearchParams({ externalReference: reference, limit: "2" });
    const { data, hasMore } = read(z.object({ data: z.array(customer).max(2), hasMore: z.boolean() }), await call(key, "/customers?" + query));
    if (hasMore || data.length > 1 || data.some((row) => row.externalReference !== reference || row.cpfCnpj !== payerDocument)) {
      throw new RequestError(502, "asaas-response");
    }
    return data[0]?.id;
  }
  async function createCustomer(key: string, reference: string, name: string, payerDocument: string) {
    const saved = read(customer, await call(key, "/customers", {
      name, cpfCnpj: payerDocument, externalReference: reference, notificationDisabled: true,
    }));
    if (saved.cpfCnpj !== payerDocument || saved.externalReference !== reference) throw new RequestError(502, "asaas-response");
    return saved.id;
  }
  async function findPayment(key: string, reference: string) {
    const query = new URLSearchParams({ externalReference: reference, limit: "2" });
    const { data, hasMore } = read(z.object({ data: z.array(payment).max(2), hasMore: z.boolean() }), await call(key, "/payments?" + query));
    if (hasMore || data.length > 1 || data.some((row) => row.externalReference !== reference)) throw new RequestError(502, "asaas-response");
    return data[0];
  }
  async function retrievePayment(key: string, id: string) {
    return read(payment, await call(key, "/payments/" + asaasId.parse(id)));
  }
  async function retrieveWebhookPayment(key: string, id: string) {
    const body = await call(key, "/payments/" + asaasId.parse(id));
    const identity = read(z.object({ id: asaasId, externalReference: z.string().nullish() }), body);
    if (identity.id !== id) throw new RequestError(502, "asaas-response");
    // The connected account may already contain unrelated charges or other payment methods.
    return identity.externalReference?.startsWith("ff:") ? read(payment, body) : undefined;
  }
  async function createPayment(key: string, binding: ChargeBinding & { customerId: string }) {
    return read(payment, await call(key, "/payments", {
      customer: binding.customerId, billingType: "BOLETO", value: Number(binding.amount), dueDate: binding.dueDate,
      externalReference: binding.externalReference,
      description: environment === "PRODUCTION" ? "Fiscal Floow - cobrança vinculada à NFS-e" : "Fiscal Floow - cobrança de demonstração em Sandbox", postalService: false,
    }));
  }
  async function verifyPayment(key: string, row: AsaasPayment, binding: ChargeBinding) {
    if (row.externalReference !== binding.externalReference || row.dueDate !== binding.dueDate ||
        !new Prisma.Decimal(row.value).eq(binding.amount) || (binding.customerId && row.customer !== binding.customerId)) {
      throw new RequestError(502, "asaas-response");
    }
    const payer = read(customer, await call(key, "/customers/" + row.customer));
    if (documentHash(payer.cpfCnpj) !== binding.payerDocumentHash) throw new RequestError(502, "asaas-response");
    return { paymentId: row.id, customerId: row.customer, status: row.deleted ? "DELETED" : row.status,
      bankSlipUrl: safeAsaasUrl(row.bankSlipUrl, environment), invoiceUrl: safeAsaasUrl(row.invoiceUrl, environment) };
  }
  return { accountDocument, assertAccountApproved, findCustomer, createCustomer, findPayment, retrievePayment, retrieveWebhookPayment, createPayment, verifyPayment };
}
export type AsaasClient = ReturnType<typeof createAsaasClient>;
