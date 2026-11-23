import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createAsaasClient, documentHash, safeAsaasUrl } from "../src/billing/asaas-client.ts";
import { createAsaasGateway } from "../src/billing/asaas-vault.ts";

const apiKey = "$aact_hmlg_" + "local-fixture-".repeat(5);
const payer = "12345678000199";
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

test("Asaas credentials are authenticated to tenant, purpose and version and never expose upstream secrets", async () => {
  const gateway = createAsaasGateway(randomBytes(32).toString("base64url"));
  const binding = { organizationId: "tenant-a", purpose: "SERVICE" as const, version: "version-a" };
  const sealed = gateway.seal(binding, apiKey);
  assert.equal(sealed.includes(Buffer.from(apiKey)), false);
  assert.equal(await gateway.use(binding, sealed, async (key) => key === apiKey), true);
  for (const other of [{ ...binding, organizationId: "tenant-b" }, { ...binding, purpose: "SUBSCRIPTION" as const }, { ...binding, version: "changed" }]) {
    await assert.rejects(gateway.use(other, sealed, async () => true), { message: "asaas-vault-unavailable" });
  }
  const altered = Buffer.from(sealed); altered[30] ^= 1;
  await assert.rejects(gateway.use(binding, altered, async () => true), { message: "asaas-vault-unavailable" });
  assert.throws(() => gateway.seal(binding, "$aact_prod_" + "x".repeat(64)), { message: "asaas-key-invalid" });
  const failed = createAsaasClient((async () => { throw new Error(apiKey); }) as typeof fetch);
  await assert.rejects(failed.accountDocument(apiKey), (error: Error) => error.message === "asaas-unavailable" && !error.message.includes(apiKey));
});

test("Asaas uses the documented Sandbox contract, disables payer notifications and checks payment identity", async () => {
  const seen: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const charge = { id: "pay_fixture", customer: "cus_fixture", billingType: "BOLETO", value: 15.25,
    dueDate: "2027-01-15", externalReference: "ff:fixture", status: "PENDING", bankSlipUrl: "https://sandbox.asaas.com/b/pdf/fixture" };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api-sandbox.asaas.com");
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("access_token"), apiKey);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("commercialInfo/")) return response({ cpfCnpj: "12.345.678/0001-99" });
    if (url.pathname === "/v3/customers" && init?.method === "GET") return response({ data: [], hasMore: false });
    if (url.pathname === "/v3/customers" && body) return response({ id: "cus_fixture", ...body });
    if (url.pathname === "/v3/customers/cus_fixture") return response({ id: "cus_fixture", cpfCnpj: payer });
    if (url.pathname === "/v3/payments" && init?.method === "GET") return response({ data: [charge], hasMore: false });
    return response(charge);
  }) as typeof fetch;
  const client = createAsaasClient(fetcher);
  assert.equal(await client.accountDocument(apiKey), payer);
  assert.equal(await client.findCustomer(apiKey, "customer-reference", payer), undefined);
  assert.equal(await client.createCustomer(apiKey, "customer-reference", "Pagador fictício", payer), "cus_fixture");
  const customerBody = seen.find((r) => r.path === "/v3/customers" && r.method === "POST")!.body!;
  assert.equal(customerBody.notificationDisabled, true); assert.equal(customerBody.email, undefined); assert.equal(customerBody.mobilePhone, undefined);
  const binding = { externalReference: "ff:fixture", payerDocumentHash: documentHash(payer), amount: "15.25", dueDate: charge.dueDate, customerId: "cus_fixture" };
  const result = await client.createPayment(apiKey, binding);
  assert.equal((await client.verifyPayment(apiKey, result, binding)).paymentId, "pay_fixture");
  assert.equal((await client.findPayment(apiKey, "ff:fixture"))!.id, "pay_fixture");
  for (const altered of [{ ...binding, amount: "15.26" }, { ...binding, dueDate: "2027-01-16" }, { ...binding, payerDocumentHash: documentHash("00000000000") }]) {
    await assert.rejects(client.verifyPayment(apiKey, result, altered), { message: "asaas-response" });
  }
  assert.deepEqual(seen.find((r) => r.path === "/v3/payments" && r.method === "POST")!.body,
    { customer: "cus_fixture", billingType: "BOLETO", value: 15.25, dueDate: "2027-01-15", externalReference: "ff:fixture",
      description: "Fiscal Floow - cobrança de demonstração em Sandbox", postalService: false });
  for (const unsafe of ["http://sandbox.asaas.com/b/x", "https://evil.example.test/", "https://sandbox.asaas.com.evil.test/", "https://user:secret@sandbox.asaas.com/b/x", "https://www.asaas.com/b/x"]) {
    assert.throws(() => safeAsaasUrl(unsafe), { message: "asaas-response" });
  }
});

test("ambiguous and oversized Asaas responses fail closed", async () => {
  const client = createAsaasClient((async () => response({ data: [], hasMore: true })) as typeof fetch);
  await assert.rejects(client.findPayment(apiKey, "ref"), { message: "asaas-response" });
  const large = createAsaasClient((async () => response({ cpfCnpj: payer, padding: "x".repeat(270_000) })) as typeof fetch);
  await assert.rejects(large.accountDocument(apiKey), { message: "asaas-response" });
});
