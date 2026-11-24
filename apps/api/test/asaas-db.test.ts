import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/credentials.ts";
import { createAuthRouter } from "../src/auth/router.ts";
import { createRegistrationsRouter } from "../src/registrations/router.ts";
import { createAsaasGateway } from "../src/billing/asaas-vault.ts";
import { processAsaasWebhooks } from "../src/billing/asaas.ts";

const origin = "https://painel.example.test";
const date = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function fixture(t: TestContext, production = false) {
  const db = new PrismaClient(), password = randomBytes(24).toString("base64url"), tag = randomUUID();
  const docs = ["A", "B"].map(() => randomBytes(6).toString("hex").toUpperCase() + "00");
  const keys = ["A", "B", "platform"].map((name) => (production ? "$aact_prod_" : "$aact_hmlg_") + name + randomBytes(24).toString("hex"));
  const sandboxKey = "$aact_hmlg_" + randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const customers: Record<string, { id: string; cpfCnpj: string; externalReference: string }[]> = {};
  const payments: Record<string, Record<string, any>[]> = {};
  const calls: { key: string; path: string; method: string; body: any }[] = [];
  let loseResponse = false, count = 0, approved = true;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get("access_token")!, method = init?.method ?? "GET";
    assert.ok(keys.includes(key) || key === sandboxKey);
    assert.equal(url.origin, key.startsWith("$aact_prod_") ? "https://api.asaas.com" : "https://api-sandbox.asaas.com");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ key, path: url.pathname, method, body }); customers[key] ??= []; payments[key] ??= [];
    if (url.pathname === "/v3/myAccount/commercialInfo/") return reply({ cpfCnpj: key === keys[1] ? docs[1] : docs[0] });
    if (url.pathname === "/v3/myAccount/status/") return reply({ general: approved ? "APPROVED" : "PENDING" });
    if (url.pathname === "/v3/customers" && method === "GET") return reply({ data: customers[key].filter((r) => r.externalReference === url.searchParams.get("externalReference")), hasMore: false });
    if (url.pathname === "/v3/customers" && method === "POST") {
      const row = { id: "cus_" + ++count, ...body }; customers[key].push(row); return reply(row);
    }
    if (url.pathname.startsWith("/v3/customers/")) return reply(customers[key].find((r) => r.id === url.pathname.split("/").at(-1)));
    if (url.pathname === "/v3/payments" && method === "GET") return reply({ data: payments[key].filter((r) => r.externalReference === url.searchParams.get("externalReference")), hasMore: false });
    if (url.pathname === "/v3/payments" && method === "POST") {
      const host = key.startsWith("$aact_prod_") ? "www.asaas.com" : "sandbox.asaas.com";
      const row = { id: "pay_" + ++count, ...body, status: "PENDING", bankSlipUrl: "https://" + host + "/b/pdf/fixture", invoiceUrl: "https://" + host + "/i/fixture" };
      payments[key].push(row);
      if (loseResponse) { loseResponse = false; throw new Error("timeout-after-acceptance"); }
      return reply(row);
    }
    if (url.pathname.startsWith("/v3/payments/")) {
      const row = payments[key].find((r) => r.id === url.pathname.split("/").at(-1));
      return row ? reply(row) : new Response(null, { status: 404 });
    }
    throw new Error("Unexpected upstream request");
  }) as typeof fetch;
  const gateway = createAsaasGateway(randomBytes(32).toString("base64url"), fetcher);
  const passwordHash = await hashPassword(password);
  const a = await db.organization.create({ data: { cnpj: docs[0], legalName: "Asaas teste A" } });
  const b = await db.organization.create({ data: { cnpj: docs[1], legalName: "Asaas teste B" } });
  const owners = await Promise.all([0, 1, 2].map((i) => db.user.create({ data: { name: "Teste", email: `${tag}-${i}@example.test`, passwordHash } })));
  await db.membership.createMany({ data: [
    { organizationId: a.id, userId: owners[0].id, role: "OWNER", platformOwner: true },
    { organizationId: b.id, userId: owners[1].id, role: "OWNER" },
    { organizationId: a.id, userId: owners[2].id, role: "OPERATOR" },
  ] });
  const app = createApp(origin, async () => {}, createAuthRouter(db, origin, false), [],
    createRegistrationsRouter(db, origin, false, undefined, undefined, { asaas: gateway }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  async function request(path: string, method: string, cookie: string, body?: object, extra: Record<string, string> = {}) {
    return fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...extra },
      ...(body && { body: JSON.stringify(body) }) });
  }
  async function login(i: number) {
    const res = await request("/auth/login", "POST", "", { organizationDocument: docs[i === 1 ? 1 : 0], email: owners[i].email, password });
    assert.equal(res.status, 200); return res.headers.get("set-cookie")!.split(";")[0];
  }
  const [owner, other, operator] = await Promise.all([0, 1, 2].map(login));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const scope = { organizationId: { in: [a.id, b.id] } };
    await db.$transaction([
      db.asaasWebhookEvent.deleteMany({ where: scope }), db.asaasCharge.deleteMany({ where: scope }), db.asaasConnection.deleteMany({ where: scope }),
      db.boleto.deleteMany({ where: scope }), db.receivingAccount.deleteMany({ where: scope }), db.invoice.deleteMany({ where: scope }),
      db.customer.deleteMany({ where: scope }), db.registrationAuditEvent.deleteMany({ where: scope }), db.authAuditEvent.deleteMany({ where: scope }),
      db.session.deleteMany({ where: { membership: { organizationId: scope.organizationId } } }), db.membership.deleteMany({ where: scope }),
      db.organization.deleteMany({ where: { id: scope.organizationId } }), db.user.deleteMany({ where: { id: { in: owners.map((u) => u.id) } } }),
    ]); await db.$disconnect();
  });
  async function connect(key = keys[0], cookie = owner, path = production ? "/receiving-account/asaas-production" : "/receiving-account/asaas") {
    return request(path, "PUT", cookie, { apiKey: key, webhookToken: secret, version: null });
  }
  const payer = await (await request("/customers", "POST", owner, { name: "Pagador de teste", federalTaxId: production ? "52998224725" : "12345678000199" })).json();
  async function plan() {
    const draft = await request("/invoices", "POST", owner, { customerId: payer.id, serviceDescription: "Demonstração", amount: "10.33" });
    assert.equal(draft.status, 201); const invoice = await draft.json();
    if (production) await db.invoice.update({ where: { organizationId: a.id, id: invoice.id },
      data: { status: "AUTHORIZED", authorizedAt: new Date(), accessKey: "1".repeat(50), xmlResponse: "<local-test-fixture/>" } });
    const planned = await request("/boletos", "POST", owner, { invoiceId: invoice.id, dueDate: date });
    assert.equal(planned.status, 201); const boleto = await planned.json();
    return { path: "/boletos/" + boleto.id + (production ? "/asaas-production" : "/asaas-sandbox"), boleto, invoice };
  }
  async function processEvents() {
    // Make the scheduled fixture explicitly due; PostgreSQL timestamps have finer precision than JS dates.
    await db.asaasWebhookEvent.updateMany({ where: { organizationId: { in: [a.id, b.id] }, processedAt: null }, data: { retryAfter: new Date(0) } });
    await processAsaasWebhooks(db, gateway);
  }
  return { db, base, request, a, b, keys, sandboxKey, payer, secret, owner, other, operator, gateway, connect, plan, payments, calls, processEvents,
    setApproved: (value: boolean) => { approved = value; },
    loseNext: () => { loseResponse = true; } };
}

test("Asaas tenant isolation, sealed configuration, lost response reconciliation and authenticated idempotent webhooks", async (t) => {
  const f = await fixture(t), { request, owner, other, operator, db } = f;
  assert.equal((await f.connect(f.keys[0], operator)).status, 403);
  assert.equal((await f.connect(f.keys[1])).status, 422);
  const beforeInvalid = f.calls.length;
  for (const [change, code] of [
    [{ apiKey: "$aact_prod_" + "x".repeat(64) }, "asaas-key-production"],
    [{ apiKey: "incomplete" }, "asaas-key-invalid"],
    [{ webhookToken: f.keys[0] }, "asaas-webhook-invalid"],
  ] as const) {
    const rejected = await request("/receiving-account/asaas", "PUT", owner, { apiKey: f.keys[0], webhookToken: f.secret, version: null, ...change });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { code });
  }
  assert.equal(f.calls.length, beforeInvalid, "Rejected fields must never contact the provider.");
  const attempts = await Promise.all([f.connect(), f.connect()]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const connected = attempts.find((r) => r.status === 200)!;
  const result = await connected.json(); const json = JSON.stringify(result);
  assert.equal(json.includes(f.keys[0]), false); assert.equal(json.includes(f.secret), false);
  const connection = await db.asaasConnection.findUniqueOrThrow({ where: { organizationId_purpose_environment: { organizationId: f.a.id, purpose: "SERVICE", environment: "SANDBOX" } } });
  assert.equal(Buffer.from(connection.sealedCredentials).includes(Buffer.from(f.keys[0])), false);
  await db.asaasConnection.update({ where: { id: connection.id }, data: { busyUntil: new Date(Date.now() + 60_000) } });
  assert.equal((await request("/receiving-account/asaas", "PUT", owner, { apiKey: f.keys[0], webhookToken: f.secret, version: connection.version })).status, 409);
  assert.equal((await request("/receiving-account/asaas", "DELETE", owner, { version: connection.version })).status, 409);
  await db.asaasConnection.update({ where: { id: connection.id }, data: { busyUntil: null } });
  const foreign = await (await request("/receiving-account/asaas", "GET", other)).json(); assert.equal(foreign.connection, null);
  const { path, boleto } = await f.plan();
  assert.equal((await request(path, "POST", owner, {})).status, 400);
  assert.equal((await request(path, "POST", owner, { confirmTest: true, amount: "0.01" })).status, 400);
  assert.equal((await request(path, "POST", other, { confirmTest: true })).status, 404);
  const concurrent = await Promise.all([0, 1, 2].map(() => request(path, "POST", owner, { confirmTest: true })));
  assert.ok(concurrent.every((r) => [200, 201, 409].includes(r.status)));
  const first = concurrent.find((r) => r.status === 201)!; assert.ok(first, "One creation must succeed.");
  assert.equal((await first.json()).status, "PENDING");
  assert.equal((await request(path, "POST", owner, { confirmTest: true })).status, 200);
  assert.equal(f.calls.filter((c) => c.path === "/v3/payments" && c.method === "POST").length, 1);
  assert.equal((await request("/boletos/" + boleto.id, "PATCH", owner, { status: "REGISTERED", issuerReference: "fake" })).status, 409);
  const second = await f.plan(); f.loseNext();
  const lost = await request(second.path, "POST", owner, { confirmTest: true }); assert.equal(lost.status, 202);
  assert.equal((await lost.json()).status, "AWAITING_LOOKUP");
  await request(second.path, "POST", owner, { confirmTest: true });
  const recovered = await request(second.path + "/consultar", "POST", owner); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).status, "PENDING");
  assert.equal(f.calls.filter((c) => c.path === "/v3/payments" && c.method === "POST").length, 2);
  const charge = await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } } });
  const payment = f.payments[f.keys[0]].find((p) => p.id === charge.paymentId)!;
  const originalValue = payment.value; payment.value = 999;
  assert.equal((await request(path + "/consultar", "POST", owner)).status, 502); payment.value = originalValue;
  const webhook = "/webhooks/asaas/" + connection.id, event = { id: "evt_" + randomUUID(), event: "PAYMENT_RECEIVED", payment: { id: payment.id, value: 9999, status: "RECEIVED" } };
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": "x".repeat(64) })).status, 401);
  for (let i = 0; i < 2; i++) {
    const delivered = await fetch(f.base + webhook, { method: "POST", headers: { "Content-Type": "application/json", "asaas-access-token": f.secret }, body: JSON.stringify(event) });
    assert.equal(delivered.status, 200);
  }
  assert.equal(await db.asaasWebhookEvent.count({ where: { connectionId: connection.id } }), 1);
  // A forged status in the authenticated payload is not accepted as the financial result.
  await f.processEvents();
  assert.equal((await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } } })).status, "PENDING");
  payment.status = "RECEIVED";
  const receivedDelivery = await request(webhook, "POST", "", { ...event, id: "evt_" + randomUUID() }, { "asaas-access-token": f.secret });
  assert.equal(receivedDelivery.status, 200);
  await f.processEvents();
  assert.equal((await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } } })).status, "RECEIVED");
  const tracked = await db.boleto.findUniqueOrThrow({ where: { id: boleto.id } }); assert.equal(tracked.status, "PLANNED"); assert.equal(tracked.settledAt, null);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: second.invoice.id } })).status, "DRAFT");
  assert.equal((await (await request("/boletos", "GET", other)).json()).items.length, 0);
  await assert.rejects(db.asaasWebhookEvent.create({ data: { organizationId: f.b.id, connectionId: connection.id, eventId: "bad", paymentId: payment.id } }), { code: "P2003" });
  await assert.rejects(db.asaasCharge.create({ data: { organizationId: f.b.id, boletoId: boleto.id,
    accountOrganizationId: f.a.id, connectionId: connection.id, externalReference: "bad-" + randomUUID(), customerReference: "bad",
    payerDocumentHash: "0".repeat(64), amount: "10.33", dueDate: new Date(date) } }), { code: "P2003" });
  const disconnected = await request("/receiving-account/asaas", "DELETE", owner, { version: connection.version }); assert.equal(disconnected.status, 204);
  assert.equal((await db.asaasConnection.findUniqueOrThrow({ where: { id: connection.id } })).sealedCredentials.byteLength, 0);
  assert.equal((await request(path + "/consultar", "POST", owner)).status, 409);
});

test("webhook token rotation preserves the sealed API key, tenant scope and independent Sandbox", async (t) => {
  const f = await fixture(t, true), { request, owner, other, operator, db } = f;
  assert.equal((await f.connect()).status, 200);
  assert.equal((await f.connect(f.sandboxKey, owner, "/receiving-account/asaas")).status, 200);
  const where = { organizationId_purpose_environment: { organizationId: f.a.id, purpose: "SERVICE" as const, environment: "PRODUCTION" as const } };
  const old = await db.asaasConnection.findUniqueOrThrow({ where });
  const sandbox = await db.asaasConnection.findUniqueOrThrow({ where: {
    organizationId_purpose_environment: { organizationId: f.a.id, purpose: "SERVICE", environment: "SANDBOX" },
  } });
  await request("/receiving-account", "PUT", owner, { provider: "ASAAS_PRODUCTION" });
  const planned = await f.plan();
  const previousReview = await (await request(planned.path + "/review", "GET", owner)).json();
  const endpoint = "/receiving-account/asaas-production/webhook-token";
  const replacement = randomBytes(32).toString("hex"), input = { version: old.version, webhookToken: replacement };
  assert.equal((await request(endpoint, "POST", operator, input)).status, 403);
  assert.equal((await request(endpoint, "POST", other, input)).status, 409);
  assert.equal((await request(endpoint, "POST", owner, { ...input, organizationId: f.b.id })).status, 400);
  for (const webhookToken of ["short", f.keys[0], "with space".repeat(6)]) {
    assert.equal((await request(endpoint, "POST", owner, { ...input, webhookToken })).status, 400);
  }
  await db.asaasConnection.update({ where: { id: old.id }, data: { busyUntil: new Date(Date.now() + 60_000) } });
  assert.equal((await request(endpoint, "POST", owner, input)).status, 409);
  await db.asaasConnection.update({ where: { id: old.id }, data: { busyUntil: null } });
  const upstreamBefore = f.calls.length;
  const attempts = await Promise.all([request(endpoint, "POST", owner, input), request(endpoint, "POST", owner, input)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const response = await attempts.find((r) => r.status === 200)!.json();
  const updated = await db.asaasConnection.findUniqueOrThrow({ where });
  assert.equal(f.calls.length, upstreamBefore, "Rotating authentication must not call the provider or create charges.");
  assert.notEqual(updated.version, old.version);
  assert.notDeepEqual(updated.sealedCredentials, old.sealedCredentials);
  assert.equal(updated.connectedAt.toISOString(), old.connectedAt.toISOString());
  assert.equal(updated.busyUntil, null);
  assert.notEqual(updated.webhookTokenHash, old.webhookTokenHash);
  assert.equal(JSON.stringify(response).includes(replacement), false);
  assert.equal(JSON.stringify(response).includes(f.keys[0]), false);
  await f.gateway.use(updated, updated.sealedCredentials, async (key) => { assert.equal(key, f.keys[0]); });
  assert.deepEqual(await db.asaasConnection.findUniqueOrThrow({ where: { id: sandbox.id } }), sandbox);
  assert.equal((await request(endpoint, "POST", owner, input)).status, 409);
  const review = await (await request(planned.path + "/review", "GET", owner)).json();
  assert.notEqual(review.reviewHash, previousReview.reviewHash, "Old production approvals must be invalidated.");
  const event = { id: "evt_" + randomUUID(), event: "PAYMENT_UPDATED", payment: { id: "pay_localfixture" } };
  const webhook = "/webhooks/asaas/" + updated.id;
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": f.secret })).status, 401);
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": replacement })).status, 200);
  assert.equal((await request("/webhooks/asaas/" + sandbox.id, "POST", "", event, { "asaas-access-token": f.secret })).status, 200);
  assert.equal(await db.asaasCharge.count({ where: { organizationId: f.a.id } }), 0);
  assert.equal(await db.registrationAuditEvent.count({ where: { organizationId: f.a.id, entityId: old.id, entity: "ASAAS_CONNECTION", action: "UPDATED" } }), 2);
  assert.equal((await request("/receiving-account/asaas-production", "DELETE", owner, { version: updated.version })).status, 204);
  assert.equal((await request(endpoint, "POST", owner, { ...input, version: updated.version })).status, 409);
});

test("production preparation is read-only upstream, requires a reviewed authorized note and preserves Sandbox", async (t) => {
  const f = await fixture(t, true), { request, owner, db } = f;
  f.setApproved(false);
  assert.equal((await f.connect()).status, 422);
  assert.equal(await db.asaasConnection.count({ where: { organizationId: f.a.id } }), 0);
  f.setApproved(true);
  assert.equal((await f.connect(f.keys[0], f.operator)).status, 403);
  assert.equal((await f.connect(f.keys[1])).status, 422);
  assert.equal((await f.connect()).status, 200);
  assert.equal((await f.connect(f.sandboxKey, owner, "/receiving-account/asaas")).status, 200);
  assert.equal(await db.asaasConnection.count({ where: { organizationId: f.a.id, disabledAt: null } }), 2);
  assert.equal((await request("/receiving-account", "PUT", owner, { provider: "ASAAS_PRODUCTION" })).status, 200);
  const draft = await (await request("/invoices", "POST", owner, {
    customerId: f.payer.id, amount: "10.33", serviceDescription: "Local fixture only",
  })).json();
  assert.equal((await request("/boletos", "POST", owner, { invoiceId: draft.id, dueDate: date })).status, 409);
  await db.invoice.delete({ where: { organizationId: f.a.id, id: draft.id } });
  const { path, boleto } = await f.plan();
  assert.equal((await request(path + "/review", "GET", f.other)).status, 404);
  assert.equal((await request(path + "/review", "GET", f.operator)).status, 403);
  const reviewed = await request(path + "/review", "GET", owner);
  assert.equal(reviewed.status, 200); const review = await reviewed.json();
  assert.equal(review.environment, "PRODUCTION"); assert.equal(review.amount, "10.33");
  assert.equal(f.calls.some((c) => c.method === "POST"), false, "Preparing the first charge must not create customers or payments upstream.");
  assert.equal(await db.asaasCharge.count({ where: { organizationId: f.a.id } }), 0);
  for (const body of [{ confirmTest: true }, { confirmProduction: false, reviewHash: review.reviewHash }, { confirmProduction: true }]) {
    assert.equal((await request(path, "POST", owner, body)).status, 400);
  }
  assert.equal((await request(path, "POST", owner, { confirmProduction: true, reviewHash: "0".repeat(64) })).status, 409);
  await db.customer.update({ where: { organizationId: f.a.id, id: f.payer.id }, data: { name: "Updated local fixture" } });
  assert.equal((await request(path, "POST", owner, { confirmProduction: true, reviewHash: review.reviewHash })).status, 409);
  const updated = await (await request(path + "/review", "GET", owner)).json();
  assert.equal(f.calls.some((c) => c.method === "POST"), false);
  const approval = { confirmProduction: true, reviewHash: updated.reviewHash };
  f.setApproved(false);
  assert.equal((await request(path, "POST", owner, approval)).status, 422);
  assert.equal(await db.asaasCharge.count({ where: { organizationId: f.a.id } }), 0);
  f.setApproved(true);
  const created = await request(path, "POST", owner, approval);
  assert.equal(created.status, 201); assert.equal((await created.json()).environment, "PRODUCTION");
  assert.equal((await request(path, "POST", owner, approval)).status, 200);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/v3/payments").length, 1);
  assert.equal(f.calls.find((c) => c.method === "POST" && c.path === "/v3/customers")!.body.notificationDisabled, true);
  assert.equal((await request(path.replace("asaas-production", "asaas-sandbox"), "POST", owner, { confirmTest: true })).status, 409);
  assert.equal((await request("/boletos/" + boleto.id, "PATCH", owner, { status: "SETTLED" })).status, 409);
  await assert.rejects(db.asaasCharge.update({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } }, data: { environment: "SANDBOX" } }));
  await assert.rejects(db.boleto.update({ where: { organizationId: f.a.id, id: boleto.id }, data: { provider: "ASAAS" } }));
  const stored = await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } } });
  const event = { id: "evt_" + randomUUID(), event: "PAYMENT_RECEIVED", payment: { id: stored.paymentId!, status: "RECEIVED", value: 999 } };
  const webhook = "/webhooks/asaas/" + stored.connectionId;
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": "wrong-token-".repeat(5) })).status, 401);
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": f.secret })).status, 200);
  assert.equal((await request(webhook, "POST", "", event, { "asaas-access-token": f.secret })).status, 200);
  await f.processEvents();
  assert.equal((await db.boleto.findUniqueOrThrow({ where: { id: boleto.id } })).status, "REGISTERED", "A forged received payload cannot override the provider's PENDING status.");
  f.payments[f.keys[0]][0].status = "RECEIVED";
  f.payments[f.keys[0]][0].paymentDate = date;
  assert.equal((await request(webhook, "POST", "", { ...event, id: "evt_" + randomUUID() }, { "asaas-access-token": f.secret })).status, 200);
  await f.processEvents();
  assert.equal((await db.boleto.findUniqueOrThrow({ where: { id: boleto.id } })).status, "SETTLED");
  assert.equal((await db.boleto.findUniqueOrThrow({ where: { id: boleto.id } })).settledAt!.toISOString().slice(0, 10), date);
  assert.ok(await db.registrationAuditEvent.count({ where: { organizationId: f.a.id, entity: "ASAAS_CHARGE", entityId: boleto.id, actorUserId: null } }));
  const otherList = await (await request("/boletos", "GET", f.other)).json();
  assert.equal(otherList.items.length, 0);
});

test("production timeout keeps a single reservation and recovers only through lookup", async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.connect()).status, 200);
  const { path } = await f.plan(), review = await (await f.request(path + "/review", "GET", f.owner)).json();
  const approval = { confirmProduction: true, reviewHash: review.reviewHash };
  f.loseNext();
  assert.equal((await f.request(path, "POST", f.owner, approval)).status, 202);
  assert.equal((await f.request(path, "POST", f.owner, approval)).status, 200);
  const recovered = await f.request(path + "/consultar", "POST", f.owner);
  assert.equal(recovered.status, 200); assert.equal((await recovered.json()).status, "PENDING");
  assert.equal(f.calls.filter((c) => c.path === "/v3/payments" && c.method === "POST").length, 1);
});

test("Asaas subscription charges use the platform connection without exposing it to the subscriber", async (t) => {
  const f = await fixture(t), { request, owner, other, db } = f;
  assert.equal((await f.connect(f.keys[2], owner, "/platform/receiving-account/asaas")).status, 200);
  assert.equal((await f.connect(f.keys[1], other)).status, 200);
  const prefix = "/platform/companies/" + f.b.id + "/boletos";
  const planned = await request(prefix, "POST", owner, { period: "2027-01", amount: "50.25", dueDate: date });
  assert.equal(planned.status, 201); const row = await planned.json();
  const issued = await request(prefix + "/" + row.id + "/asaas-sandbox", "POST", owner, { confirmTest: true });
  assert.equal(issued.status, 201, await issued.clone().text());
  const outgoing = f.calls.find((c) => c.path === "/v3/payments" && c.method === "POST")!;
  assert.equal(outgoing.key, f.keys[2]); assert.equal(outgoing.body.value, 50.25);
  const stored = await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.b.id, boletoId: row.id } } });
  assert.equal(stored.accountOrganizationId, f.a.id);
  assert.equal((await request(prefix + "/" + row.id + "/asaas-sandbox/consultar", "POST", other)).status, 403);
  assert.equal((await (await request("/boletos", "GET", other)).json()).items.length, 0);
});
