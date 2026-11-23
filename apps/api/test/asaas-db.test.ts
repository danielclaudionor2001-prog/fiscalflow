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

async function fixture(t: TestContext) {
  const db = new PrismaClient(), password = randomBytes(24).toString("base64url"), tag = randomUUID();
  const docs = ["A", "B"].map(() => randomBytes(6).toString("hex").toUpperCase() + "00");
  const keys = ["A", "B", "platform"].map((name) => "$aact_hmlg_" + name + randomBytes(24).toString("hex"));
  const secret = randomBytes(32).toString("hex");
  const customers: Record<string, { id: string; cpfCnpj: string; externalReference: string }[]> = {};
  const payments: Record<string, Record<string, any>[]> = {};
  const calls: { key: string; path: string; method: string; body: any }[] = [];
  let loseResponse = false, count = 0;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api-sandbox.asaas.com");
    const key = new Headers(init?.headers).get("access_token")!, method = init?.method ?? "GET";
    assert.ok(keys.includes(key));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ key, path: url.pathname, method, body }); customers[key] ??= []; payments[key] ??= [];
    if (url.pathname === "/v3/myAccount/commercialInfo/") return reply({ cpfCnpj: key === keys[1] ? docs[1] : docs[0] });
    if (url.pathname === "/v3/customers" && method === "GET") return reply({ data: customers[key].filter((r) => r.externalReference === url.searchParams.get("externalReference")), hasMore: false });
    if (url.pathname === "/v3/customers" && method === "POST") {
      const row = { id: "cus_" + ++count, ...body }; customers[key].push(row); return reply(row);
    }
    if (url.pathname.startsWith("/v3/customers/")) return reply(customers[key].find((r) => r.id === url.pathname.split("/").at(-1)));
    if (url.pathname === "/v3/payments" && method === "GET") return reply({ data: payments[key].filter((r) => r.externalReference === url.searchParams.get("externalReference")), hasMore: false });
    if (url.pathname === "/v3/payments" && method === "POST") {
      const row = { id: "pay_" + ++count, ...body, status: "PENDING", bankSlipUrl: "https://sandbox.asaas.com/b/pdf/fixture", invoiceUrl: "https://sandbox.asaas.com/i/fixture" };
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
  async function connect(key = keys[0], cookie = owner, path = "/receiving-account/asaas") {
    return request(path, "PUT", cookie, { apiKey: key, webhookToken: secret, version: null });
  }
  const payer = await (await request("/customers", "POST", owner, { name: "Pagador de teste", federalTaxId: "12345678000199" })).json();
  async function plan() {
    const draft = await request("/invoices", "POST", owner, { customerId: payer.id, serviceDescription: "Demonstração", amount: "10.33" });
    assert.equal(draft.status, 201); const invoice = await draft.json();
    const planned = await request("/boletos", "POST", owner, { invoiceId: invoice.id, dueDate: date });
    assert.equal(planned.status, 201); const boleto = await planned.json();
    return { path: "/boletos/" + boleto.id + "/asaas-sandbox", boleto, invoice };
  }
  return { db, base, request, a, b, keys, secret, owner, other, operator, gateway, connect, plan, payments, calls,
    loseNext: () => { loseResponse = true; } };
}

test("Asaas tenant isolation, sealed configuration, lost response reconciliation and authenticated idempotent webhooks", async (t) => {
  const f = await fixture(t), { request, owner, other, operator, db } = f;
  assert.equal((await f.connect(f.keys[0], operator)).status, 403);
  assert.equal((await f.connect(f.keys[1])).status, 422);
  const attempts = await Promise.all([f.connect(), f.connect()]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const connected = attempts.find((r) => r.status === 200)!;
  const result = await connected.json(); const json = JSON.stringify(result);
  assert.equal(json.includes(f.keys[0]), false); assert.equal(json.includes(f.secret), false);
  const connection = await db.asaasConnection.findUniqueOrThrow({ where: { organizationId_purpose: { organizationId: f.a.id, purpose: "SERVICE" } } });
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
  await processAsaasWebhooks(db, f.gateway);
  assert.equal((await db.asaasCharge.findUniqueOrThrow({ where: { organizationId_boletoId: { organizationId: f.a.id, boletoId: boleto.id } } })).status, "PENDING");
  payment.status = "RECEIVED";
  await request(webhook, "POST", "", { ...event, id: "evt_" + randomUUID() }, { "asaas-access-token": f.secret });
  await processAsaasWebhooks(db, f.gateway);
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
