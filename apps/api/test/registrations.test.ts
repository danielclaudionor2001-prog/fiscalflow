import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/credentials.ts";
import { createAuthRouter } from "../src/auth/router.ts";
import { createCelcoinSandbox, type CelcoinSandbox } from "../src/billing/celcoin-sandbox.ts";
import { loadTrustedA1 } from "../src/fiscal/certificate.ts";
import { createCertificateVault, type CertificateVault } from "../src/fiscal/certificate-vault.ts";
import { validateDps } from "../src/fiscal/documents.ts";
import { runDueDraftSchedules } from "../src/invoices/schedules.ts";
import { createRegistrationsRouter } from "../src/registrations/router.ts";
import { testAuthority } from "./a1-fixture.ts";

const origin = "https://painel.example.test";
const password = randomBytes(24).toString("base64url");
const testCnpj = () => randomBytes(6).toString("hex").toUpperCase() + "00";
const maskCnpj = (value: string) => value.replace(/^(..)(...)(...)(....)(..)$/, "$1.$2.$3/$4-$5");

async function setup(t: TestContext, vault?: CertificateVault, celcoin?: (cnpj: string) => CelcoinSandbox) {
  const prisma = new PrismaClient();
  const testOrganizations = [testCnpj(), maskCnpj(testCnpj()), testCnpj()];
  const testCpfs: string[] = [];
  const emails = [randomUUID(), randomUUID(), randomUUID()].map((id) => `${id}@example.test`);
  const app = createApp(
    origin, async () => {}, createAuthRouter(prisma, origin, false), vault ? ["127.0.0.1"] : [],
    createRegistrationsRouter(prisma, origin, false, vault, celcoin?.(testOrganizations[0])),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const ids = await prisma.organization.findMany({
        where: { OR: [{ cnpj: { in: testOrganizations } }, { cpf: { in: testCpfs } }] }, select: { id: true },
      });
      const scope = { organizationId: { in: ids.map(({ id }) => id) } };
      await prisma.$transaction([
        prisma.celcoinSandboxCharge.deleteMany({ where: scope }),
        prisma.boleto.deleteMany({ where: scope }),
        prisma.receivingAccount.deleteMany({ where: scope }),
        prisma.preparedDps.deleteMany({ where: scope }),
        prisma.fiscalCertificate.deleteMany({ where: scope }),
        prisma.invoiceSchedule.deleteMany({ where: scope }),
        prisma.invoice.deleteMany({ where: scope }),
        prisma.customer.deleteMany({ where: scope }),
        prisma.service.deleteMany({ where: scope }),
        prisma.registrationAuditEvent.deleteMany({ where: scope }),
        prisma.authAuditEvent.deleteMany({ where: scope }),
        prisma.membership.deleteMany({ where: scope }),
        prisma.organization.deleteMany({ where: { id: scope.organizationId } }),
        prisma.user.deleteMany({ where: { email: { in: emails } } }),
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const passwordHash = await hashPassword(password);
  const seed = await prisma.$transaction(async (tx) => {
    const a = await tx.organization.create({ data: { legalName: "Empresa A", cnpj: testOrganizations[0] } });
    const b = await tx.organization.create({ data: { legalName: "Empresa B", cnpj: testOrganizations[1] } });
    const [shared, ownerB, operator] = await Promise.all(emails.map((email) => tx.user.create({
      data: { name: "Usuário de teste", email, passwordHash },
    })));
    await tx.membership.createMany({
      data: [
        { organizationId: a.id, userId: shared.id, role: "OWNER" },
        { organizationId: b.id, userId: shared.id, role: "VIEWER" },
        { organizationId: b.id, userId: ownerB.id, role: "OWNER" },
        { organizationId: a.id, userId: operator.id, role: "OPERATOR" },
      ],
    });
    return { a, b, shared, ownerB, operator };
  });

  function request(path: string, method = "GET", cookie?: string, data?: object, headers?: Record<string, string>) {
    return fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(vault && { "X-Forwarded-Proto": "https" }),
        ...(cookie && { Cookie: cookie }),
        ...(data && { "Content-Type": "application/json" }),
        ...headers,
      },
      body: data && JSON.stringify(data),
    });
  }
  async function login(email: string, organizationCnpj: string) {
    const response = await request("/auth/login", "POST", undefined, { email, password, organizationCnpj });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    return cookie;
  }
  return { ...seed, newCnpj: testOrganizations[2], testCpfs, prisma, request, login };
}

const customers = { name: "Cliente teste", federalTaxId: "000.000.000-00", email: "cliente@example.test" };
const services = { name: "Serviço teste", description: "Descrição de teste", defaultAmount: "123,45" };

test("CPF login requires membership and masks the document after activation", async (t) => {
  const { a, b, shared, operator, ownerB, testCpfs, prisma, request, login } = await setup(t);
  const cpf = "52998224725";
  testCpfs.push(cpf);
  const owner = await login(shared.email, a.cnpj);
  assert.equal((await request("/organizations", "POST", owner, { legalName: "Pessoa física", cpf })).status, 400);
  await prisma.membership.update({
    where: { userId_organizationId: { userId: shared.id, organizationId: a.id } }, data: { platformOwner: true },
  });
  const code = randomBytes(32).toString("base64url");
  const invitation = {
    legalName: "Assinante pessoa física", ownerName: operator.name, ownerEmail: operator.email,
    inviteHash: createHash("sha256").update(code).digest("hex"),
  };
  const create = (data: object) => request("/platform/companies", "POST", owner, { ...invitation, ...data });
  assert.equal((await create({ cpf: "529.982.247-24" })).status, 400);
  assert.equal((await create({ cpf, cnpj: a.cnpj })).status, 400);
  const invited = await create({ cpf: "529.982.247-25" });
  assert.equal(invited.status, 201, await invited.clone().text());
  const organization = await invited.json();
  assert.equal(organization.cnpj, null);
  assert.equal(organization.cpfMasked, "***.***.***-25");
  assert.equal(Object.hasOwn(organization, "cpf"), false);
  assert.equal((await create({ cpf })).status, 409);
  const loginByDocument = (email: string, organizationDocument: string) =>
    request("/auth/login", "POST", undefined, { email, password, organizationDocument });
  assert.equal((await loginByDocument(ownerB.email, cpf)).status, 401);
  assert.equal((await loginByDocument(operator.email, cpf)).status, 401);
  const activation = await request("/auth/activate", "POST", undefined, { code, password });
  assert.deepEqual(await activation.json(), { cnpj: null, documentType: "CPF" });
  const cpfSession = await loginByDocument(operator.email, "529.982.247-25");
  assert.equal(cpfSession.status, 200);
  const cpfCookie = cpfSession.headers.get("Set-Cookie")!.split(";", 1)[0];
  const signedIn = await cpfSession.json();
  assert.equal(signedIn.organization.id, organization.id);
  assert.equal(Object.hasOwn(signedIn.organization, "cpf"), false);
  const maskedCnpjLogin = await loginByDocument(ownerB.email, b.cnpj.replace(/[./-]/g, "").toLowerCase());
  assert.equal(maskedCnpjLogin.status, 200);
  assert.equal((await maskedCnpjLogin.json()).organization.id, b.id);
  const certificates = await request("/certificates", "GET", cpfCookie);
  assert.equal(certificates.status, 409);
  assert.equal((await certificates.json()).code, "issuer-cnpj-required");
  assert.equal((await loginByDocument(operator.email, cpf)).status, 200);
});

test("a company owner can link their CPF and choose between company and personal accounts", async (t) => {
  const { a, b, shared, testCpfs, prisma, request, login } = await setup(t);
  const cpf = "11144477735";
  testCpfs.push(cpf);
  const owner = await login(shared.email, a.cnpj);
  const viewer = await login(shared.email, b.cnpj);
  const path = "/auth/cpf-login";
  assert.equal((await request(path, "PUT", viewer, { cpf, password })).status, 403);
  assert.equal((await request(path, "PUT", owner, { cpf, password: "wrong" })).status, 403);
  assert.equal((await request(path, "PUT", owner, { cpf, password, organizationId: b.id })).status, 400);
  assert.equal((await request(path, "PUT", owner, { cpf, password }, { "X-FiscalFlow-Context": b.id })).status, 409);
  assert.deepEqual(await (await request(path, "GET", owner)).json(), { cpfMasked: null });
  const saved = await request(path, "PUT", owner, { cpf: "111.444.777-35", password });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(await saved.json(), { cpfMasked: "***.***.***-35" });

  const loginByCpf = (overrides: object = {}) => request("/auth/login", "POST", undefined, {
    organizationDocument: cpf, email: shared.email, password, ...overrides,
  });
  const company = await loginByCpf();
  assert.equal(company.status, 200);
  assert.equal((await company.json()).organization.id, a.id);
  const personal = await prisma.organization.create({ data: {
    cpf, legalName: "Conta pessoal", memberships: { create: { userId: shared.id, role: "OWNER" } },
  } });
  const invalid = await loginByCpf({ password: "wrong" });
  assert.deepEqual(await invalid.json(), { code: "invalid-credentials" });
  const choice = await loginByCpf();
  assert.equal(choice.status, 409);
  assert.equal(choice.headers.has("Set-Cookie"), false);
  assert.deepEqual(await choice.json(), { code: "choose-account", accounts: [
    { key: "personal", legalName: personal.legalName, cnpj: null },
    { key: "cnpj:" + a.cnpj, legalName: a.legalName, cnpj: a.cnpj },
  ] });
  assert.equal((await loginByCpf({ account: "cnpj:" + b.cnpj })).status, 401);
  assert.equal((await (await loginByCpf({ account: "personal" })).json()).organization.id, personal.id);
  assert.equal((await (await loginByCpf({ account: "cnpj:" + a.cnpj })).json()).organization.id, a.id);
  assert.deepEqual(await (await request(path, "PUT", owner, { cpf: null, password })).json(), { cpfMasked: null });
  assert.equal((await (await loginByCpf()).json()).organization.id, personal.id);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, actorUserId: shared.id, entity: "MEMBERSHIP", action: "UPDATED" },
  }), 2);
});

test("the monthly issuance dashboard sums only authorized invoices in the session and Brasília calendar", async (t) => {
  const { a, b, shared, ownerB, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const [customerA, customerB] = await Promise.all([
    prisma.customer.create({ data: { ...customers, organizationId: a.id } }),
    prisma.customer.create({ data: { ...customers, organizationId: b.id } }),
  ]);
  const invoice = (time: string, amount: string, status: "AUTHORIZED" | "DRAFT" | "CANCELLED" = "AUTHORIZED") => ({
    organizationId: a.id, customerId: customerA.id, idempotencyKey: randomUUID(), serviceDescription: "Resumo mensal",
    authorizedAt: new Date(time), amount, status,
  });
  await prisma.invoice.createMany({ data: [
    invoice("2026-11-01T02:59:59Z", "999.00"),
    invoice("2026-11-01T03:00:00Z", "100.05"),
    invoice("2026-12-01T02:59:59Z", "0.20"),
    invoice("2026-12-01T03:00:00Z", "999.00"),
    invoice("2026-11-10T12:00:00Z", "999.00", "DRAFT"),
    invoice("2026-11-10T12:00:00Z", "999.00", "CANCELLED"),
    { ...invoice("2026-11-15T12:00:00Z", "999.00"), discardedAt: new Date("2026-11-18T00:00:00Z") },
    { ...invoice("2026-11-08T12:00:00Z", "9.80"), organizationId: b.id, customerId: customerB.id },
  ] });
  const path = "/dashboard/issuance?month=2026-11";
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path + "&organizationId=" + b.id, "GET", owner)).status, 400);
  const response = await request(path, "GET", owner);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    month: "2026-11", issuedCount: 2, totalAmount: "100.25", days: [{ day: 1, count: 1 }, { day: 30, count: 1 }],
  });
  assert.deepEqual(await (await request(path, "GET", other)).json(), {
    month: "2026-11", issuedCount: 1, totalAmount: "9.80", days: [{ day: 8, count: 1 }],
  });
  assert.deepEqual(await (await request("/dashboard/issuance?month=2026-10", "GET", other)).json(), {
    month: "2026-10", issuedCount: 0, totalAmount: "0.00", days: [],
  });
});

test("Celcoin Sandbox reconciles a lost response without reissuing or settling the tracked boleto", async (t) => {
  const transactionId = randomUUID();
  const receiver = { account: "9000000000", document: "00000000000000" };
  const debtor = { name: "Pagador fictício", document: "00000000000", city: "São Paulo", publicArea: "Rua de teste",
    number: "10", neighborhood: "Bairro de teste", postalCode: "01000000", state: "SP" };
  const connection = { purpose: "SERVICE", clientId: "fixture-id", clientSecret: "fixture-secret",
    pixKey: "test@example.test", receiver, debtor };
  let posts = 0;
  let requestCharge: { externalId: string; duedate: string } | undefined;
  let returnWrongReceiver = true;
  let status = "PENDING";
  const bankLine = "1".repeat(47);
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, "https://sandbox.openfinance.celcoin.dev");
    assert.equal(req.redirect, "error");
    if (url.pathname === "/v5/token") {
      assert.equal(req.method, "POST");
      const form = await req.formData();
      assert.equal(form.get("client_id"), connection.clientId);
      assert.equal(form.get("client_secret"), connection.clientSecret);
      assert.equal(form.get("grant_type"), "client_credentials");
      return Response.json({ access_token: "test-token", token_type: "bearer" });
    }
    assert.equal(url.pathname, "/baas/v2/charge");
    assert.equal(req.headers.get("Authorization"), "Bearer test-token");
    if (req.method === "POST") {
      posts++;
      const payload = await req.json();
      assert.equal(payload.amount, 10);
      assert.deepEqual(payload.debtor, debtor);
      assert.deepEqual(payload.receiver, receiver);
      assert.equal(payload.chargeType, "BOLEPIX");
      assert.equal("invoiceNumber" in payload, false);
      requestCharge = payload;
      if (posts === 1) throw new TypeError("Connection reset");
      return Response.json({ status: 201, body: { transactionId } }, { status: 201 });
    }
    assert.equal(req.method, "GET");
    assert.ok(requestCharge);
    assert.equal(url.searchParams.get("ExternalId"), requestCharge.externalId);
    return Response.json({ status: "SUCCESS", body: {
      transactionId, externalId: requestCharge.externalId, amount: 10, duedate: requestCharge.duedate, status,
      receiver: returnWrongReceiver ? { ...receiver, account: "0000000001" } : receiver,
      boleto: { bankLine },
    } });
  };
  const { a, b, shared, ownerB, operator, prisma, request, login } =
    await setup(t, undefined, (organizationCnpj) => createCelcoinSandbox([{ ...connection, organizationCnpj }], fetcher));
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  assert.equal((await request("/receiving-account", "PUT", owner, { provider: "CELCOIN", accountNumber: "99999999" })).status, 200);
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  async function plan() {
    const invoice = await prisma.invoice.create({ data: {
      organizationId: a.id, customerId: customer.id, amount: "50.25", serviceDescription: "Serviço",
      idempotencyKey: randomUUID(),
    } });
    const response = await request("/boletos", "POST", owner, { invoiceId: invoice.id, dueDate: "2026-11-30" });
    assert.equal(response.status, 201);
    const boleto = await response.json();
    return { boleto, path: "/boletos/" + boleto.id + "/celcoin-sandbox" };
  }
  const { boleto, path } = await plan();
  assert.equal((await request(path, "POST", other)).status, 404);
  assert.equal((await request(path, "POST", writer)).status, 403);
  const attempts = await Promise.all([request(path, "POST", owner), request(path, "POST", owner)]);
  assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 202]);
  assert.equal(posts, 1);
  assert.equal((await attempts[0].json()).status, "AWAITING_LOOKUP");
  assert.equal((await request(path + "/consultar", "POST", other)).status, 404);
  assert.equal((await request(path + "/consultar", "POST", owner)).status, 502);
  returnWrongReceiver = false;
  const queried = await request(path + "/consultar", "POST", owner);
  assert.equal(queried.status, 200, await queried.clone().text());
  assert.equal((await queried.json()).bankLine, bankLine);
  status = "CONFIRMED";
  const paid = await (await request(path + "/consultar", "POST", owner)).json();
  assert.equal(paid.status, "CONFIRMED");
  assert.equal(paid.bankLine, null);
  status = "PENDING";
  assert.equal((await (await request(path + "/consultar", "POST", owner)).json()).status, "CONFIRMED");
  const listing = await (await request("/boletos", "GET", owner)).json();
  assert.equal(listing.items[0].status, "PLANNED");
  assert.equal(listing.items[0].sandbox.status, "CONFIRMED");
  assert.equal(JSON.stringify(listing).includes(connection.clientSecret), false);
  assert.equal((await prisma.boleto.findUniqueOrThrow({ where: { id: boleto.id } })).settledAt, null);
  const second = await plan();
  const accepted = await request(second.path, "POST", owner);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).status, "PROCESSING");
  assert.equal(posts, 2);
});

test("a platform invitation can be used once, and suspension revokes only the subscriber's sessions", async (t) => {
  const { a, b, shared, ownerB, operator, newCnpj, prisma, request, login } = await setup(t);
  await prisma.membership.update({
    where: { userId_organizationId: { userId: shared.id, organizationId: a.id } },
    data: { platformOwner: true },
  });
  const platform = await login(shared.email, a.cnpj);
  const otherOwner = await login(ownerB.email, b.cnpj);
  const operatorA = await login(operator.email, a.cnpj);
  assert.equal((await request("/platform/companies", "GET", otherOwner)).status, 403);
  const code = randomBytes(32).toString("base64url");
  const inviteHash = createHash("sha256").update(code).digest("hex");
  const create = await request("/platform/companies", "POST", platform, {
    legalName: "Assinante de teste", cnpj: newCnpj, ownerName: operator.name, ownerEmail: operator.email, inviteHash,
  });
  assert.equal(create.status, 201, await create.clone().text());
  const company = await create.json();
  assert.equal(JSON.stringify(company).includes(inviteHash), false);
  const claim = await request("/auth/activate", "POST", undefined, { code, password });
  assert.equal(claim.status, 200, await claim.clone().text());
  assert.equal((await request("/auth/activate", "POST", undefined, { code, password })).status, 404);
  const subscriber = await login(operator.email, newCnpj);
  assert.equal((await request("/platform/companies", "GET", subscriber)).status, 403);
  const access = "/platform/companies/" + company.id + "/access";
  assert.equal((await request(access, "PATCH", platform, { suspended: true })).status, 200);
  assert.equal((await request("/auth/session", "GET", subscriber)).status, 401);
  assert.equal((await request("/auth/session", "GET", operatorA)).status, 200);
  assert.equal((await request("/auth/login", "POST", undefined, {
    email: operator.email, password, organizationCnpj: newCnpj,
  })).status, 401);
  assert.equal((await request(access, "PATCH", platform, { suspended: false })).status, 200);
  assert.equal((await request("/auth/session", "GET", subscriber)).status, 401);
  await login(operator.email, newCnpj);
});

test("boletos and receiving accounts are tenant-scoped and subscription billing uses the platform account", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  await prisma.membership.update({
    where: { userId_organizationId: { userId: shared.id, organizationId: a.id } },
    data: { platformOwner: true },
  });
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const bank = { provider: "OWN_BANK", bankName: "Banco da empresa", bankCode: "001", branch: "0001", accountNumber: "123456-7" };
  assert.equal((await request("/receiving-account", "PUT", writer, bank)).status, 403);
  const bankResponse = await request("/receiving-account", "PUT", owner, bank);
  assert.equal(bankResponse.status, 200, await bankResponse.clone().text());
  assert.equal((await bankResponse.json()).account.accountLastFour, "4567");
  assert.deepEqual(await (await request("/receiving-account", "GET", other)).json(), { account: null });
  assert.equal((await request("/receiving-account", "PUT", other, { ...bank, accountNumber: "789012-3" })).status, 200);
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  const invoice = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, amount: "50.25", serviceDescription: "Serviço",
    idempotencyKey: randomUUID(),
  } });
  const data = { invoiceId: invoice.id, dueDate: "2020-01-02" };
  assert.equal((await request("/boletos?invoiceId=" + invoice.id, "GET", other)).status, 404);
  assert.equal((await request("/boletos", "POST", other, data)).status, 404);
  assert.equal((await request("/boletos", "POST", owner, { ...data, amount: "0.01" })).status, 400);
  const attempts = await Promise.all([
    request("/boletos", "POST", owner, data),
    request("/boletos", "POST", owner, data),
  ]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
  const boleto = await attempts.find((result) => result.status === 201)!.json();
  assert.equal(boleto.amount, "50.25");
  assert.equal(boleto.status, "PLANNED");
  assert.equal(boleto.overdue, false);
  const path = "/boletos/" + boleto.id;
  assert.equal((await request(path, "PATCH", other, { status: "CANCELLED" })).status, 404);
  assert.equal((await request(path, "PATCH", owner, { status: "SETTLED" })).status, 409);
  assert.equal((await request(path, "PATCH", owner, { status: "REGISTERED", issuerReference: "Nosso número 10" })).status, 200);
  const overdue = await (await request("/boletos?state=OVERDUE", "GET", owner)).json();
  assert.equal(overdue.items[0].overdue, true);
  assert.equal((await request(path, "PATCH", owner, { status: "SETTLED" })).status, 200);
  const settled = await (await request("/boletos?state=SETTLED", "GET", owner)).json();
  assert.equal(settled.items[0].status, "SETTLED");
  assert.equal(settled.items[0].overdue, false);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, "DRAFT");

  const subscriptions = "/platform/companies/" + b.id + "/boletos";
  assert.equal((await request(subscriptions, "GET", other)).status, 403);
  const subscription = { period: "2026-11", amount: "90.00", dueDate: "2026-11-10" };
  assert.equal((await request(subscriptions, "POST", owner, subscription)).status, 409);
  assert.equal((await request("/platform/receiving-account", "PUT", owner, {
    provider: "CELCOIN", accountNumber: "12340099",
  })).status, 200);
  const payment = await request(subscriptions, "POST", owner, subscription);
  assert.equal(payment.status, 201, await payment.clone().text());
  assert.equal((await payment.json()).bankName, "Celcoin");
  assert.equal((await request(subscriptions, "POST", owner, subscription)).status, 409);
  assert.deepEqual((await (await request("/boletos", "GET", other)).json()).items, []);
});

test("a draft is signed locally under its company and series, without transitioning to an issued note", async (t) => {
  const authority = testAuthority(true);
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root, authority.intermediate);
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t, vault);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const viewer = await login(shared.email, b.cnpj);
  await prisma.organization.update({ where: { id: a.id }, data: { cityIbgeCode: "3550308" } });
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  const draft = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, amount: "12.34", serviceDescription: "Teste local",
    idempotencyKey: randomUUID(),
  } });
  const path = "/invoices/" + draft.id + "/dps";
  const headers = { "If-Match": '"' + draft.updatedAt.toISOString() + '"' };
  const data = { serie: "1", nDPS: "1", dCompet: "2026-11-01", opSimpNac: "2", regEspTrib: "0",
    cLocPrestacao: "3550308", cTribNac: "010101", tpRetISSQN: "1", totTrib: { indTotTrib: "0" } };
  assert.equal((await request(path, "GET", other)).status, 404);
  assert.equal((await request(path, "GET", viewer)).status, 403);
  assert.equal((await request(path, "POST", writer, data, headers)).status, 409);
  const cert = authority.issue(a.cnpj, { leafOnly: true });
  assert.throws(() => loadTrustedA1(cert.pfx, cert.password, [authority.root], a.cnpj), { code: "certificate-chain-untrusted" });
  const upload = await request("/certificates", "PUT", owner, { pfx: cert.pfx.toString("base64"), password: cert.password }, { "If-Match": '"missing"' });
  assert.equal(upload.status, 201);
  const { certificate } = await upload.json();
  assert.equal((await request(path, "POST", other, data, headers)).status, 404);
  assert.equal((await request(path, "POST", writer, { ...data, tpAmb: 1 }, headers)).status, 400);

  const response = await request(path, "POST", writer, data, headers);
  assert.equal(response.status, 201, await response.clone().text());
  const prepared = await response.json();
  assert.equal(prepared.state, "locally-signed");
  assert.deepEqual(Object.keys(prepared).sort(), ["idDps", "preparedAt", "state"]);
  const record = await prisma.preparedDps.findUniqueOrThrow({ where: { organizationId_id: { organizationId: a.id, id: prepared.idDps } } });
  const identity = validateDps(Buffer.from(record.signedXml));
  assert.equal(identity.cnpj, a.cnpj);
  assert.equal(identity.id, prepared.idDps);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status, "DRAFT");
  const customerHistory = "/customers/" + customer.id + "/invoices";
  const pdfPath = customerHistory + "/dps/" + prepared.idDps + ".pdf";
  const historyResponse = await request(customerHistory, "GET", owner);
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(await historyResponse.json(), {
    customer: { name: customer.name },
    items: [{
      id: draft.id, status: "DRAFT", serviceDescription: "Teste local", amount: "12.34",
      date: draft.createdAt.toISOString(), dpsId: prepared.idDps, accessKey: null,
    }],
    hasNext: false,
  });
  const pdfResponse = await request(pdfPath, "GET", writer);
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("Content-Type"), "application/pdf");
  assert.equal(pdfResponse.headers.get("Cache-Control"), "no-store");
  assert.match(pdfResponse.headers.get("Content-Disposition") ?? "", /^attachment; filename="dps-teste-DPS[0-9A-Z]+\.pdf"$/);
  assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await request(customerHistory, "GET", other)).status, 404);
  assert.equal((await request(pdfPath, "GET", other)).status, 404);
  assert.equal((await request(pdfPath)).status, 401);
  const anotherCustomer = await prisma.customer.create({
    data: { ...customers, organizationId: a.id, federalTaxId: "11111111111" },
  });
  const emptyHistory = await request("/customers/" + anotherCustomer.id + "/invoices", "GET", owner);
  assert.equal(emptyHistory.status, 200);
  assert.deepEqual((await emptyHistory.json()).items, []);
  assert.equal((await request(pdfPath.replace(customer.id, anotherCustomer.id), "GET", owner)).status, 404);
  const replay = await request(path, "POST", writer, data, headers);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), prepared);
  const reused = await request(path, "POST", writer, { ...data, cTribNac: "010102" }, headers);
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).code, "dps-number-in-use");
  assert.equal((await (await request(path, "GET", owner)).json()).prepared.current, true);
  assert.equal((await request("/certificates", "DELETE", owner, undefined, { "If-Match": '"' + certificate.version + '"' })).status, 204);
  assert.equal((await (await request(path, "GET", owner)).json()).prepared.current, false);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, entity: "PREPARED_DPS", entityId: prepared.idDps, actorUserId: operator.id },
  }), 1);
  assert.equal((await request(pdfPath, "GET", owner)).status, 200);
  await prisma.invoice.update({
    where: { id: draft.id }, data: { updatedAt: new Date(draft.updatedAt.getTime() + 1000) },
  });
  assert.equal((await request(pdfPath, "GET", owner)).status, 404);
  const editedHistory = await request(customerHistory, "GET", owner);
  assert.equal((await editedHistory.json()).items[0].dpsId, null);
});

test("monthly note types generate one categorized draft on the first day and preserve one-off drafts", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const [customer, foreign, service] = await Promise.all([
    prisma.customer.create({ data: { ...customers, organizationId: a.id } }),
    prisma.customer.create({ data: { ...customers, organizationId: b.id } }),
    prisma.service.create({ data: { ...services, organizationId: a.id, defaultAmount: "100.00" } }),
  ]);
  const input = { customerId: customer.id, serviceId: service.id, amount: "50.42", serviceDescription: "Modernização mensal", kind: "MODERNIZACAO" };
  const path = "/schedules/monthly";
  assert.equal((await request(path, "POST", writer, input)).status, 403);
  assert.equal((await request(path, "POST", other, input)).status, 404);
  assert.equal((await request(path, "POST", owner, { ...input, customerId: foreign.id })).status, 404);
  assert.equal((await request(path, "POST", owner, { ...input, kind: "AVULSA" })).status, 400);
  const attempts = await Promise.all([request(path, "POST", owner, input), request(path, "POST", owner, input)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 201]);
  const [plan, replay] = await Promise.all(attempts.map((response) => response.json()));
  assert.deepEqual(plan, replay);
  assert.equal(plan.kind, "MODERNIZACAO");
  assert.equal(plan.dayOfMonth, 1);
  assert.equal(new Date(plan.nextRunAt).getUTCDate(), 1);
  assert.equal(new Date(plan.nextRunAt).getUTCHours(), 11);
  assert.equal((await request(path, "POST", owner, { ...input, amount: "60.00" })).status, 409);
  const planPath = "/schedules/" + plan.id;
  assert.equal((await request(planPath, "PATCH", owner, { dayOfMonth: 2, active: true })).status, 400);
  assert.equal((await request(planPath, "PATCH", owner, { dayOfMonth: 1, active: true, amount: "60.00", kind: "ORCAMENTO" })).status, 200);
  assert.equal(await prisma.invoice.count({ where: { organizationId: a.id } }), 0);
  const oneOff = await request("/invoices", "POST", writer, { customerId: customer.id, amount: "10.00", serviceDescription: "Avulsa" }, { "Idempotency-Key": randomUUID() });
  assert.equal(oneOff.status, 201);
  assert.equal((await oneOff.json()).kind, "AVULSA");
  const due = new Date(plan.nextRunAt);
  await Promise.all([runDueDraftSchedules(prisma, due), runDueDraftSchedules(prisma, due)]);
  const generated = await prisma.invoice.findMany({ where: { organizationId: a.id, kind: "ORCAMENTO" } });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].status, "DRAFT");
  assert.equal(generated[0].amount.toFixed(2), "60.00");
  assert.equal(await prisma.invoice.count({ where: { organizationId: b.id } }), 0);
});

test("the A1 vault validates ownership and trust and scopes rotation and deletion to the owner", async (t) => {
  const authority = testAuthority();
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root);
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t, vault);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const { pfx, password } = authority.issue(a.cnpj);
  const base64 = pfx.toString("base64");
  const path = "/certificates";
  const put = (cookie: string, version: string, data = { pfx: base64, password }) =>
    request(path, "PUT", cookie, data, { "If-Match": '"' + version + '"' });
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, "GET", writer)).status, 403);
  assert.equal((await put(writer, "missing")).status, 403);
  assert.equal((await request(path, "PUT", owner, { pfx: base64, password }, {
    "If-Match": '"missing"', "X-Forwarded-Proto": "http",
  })).status, 403);
  const wrongPassword = await put(owner, "missing", { pfx: base64, password: "errada" });
  assert.equal(wrongPassword.status, 422);
  assert.equal((await wrongPassword.json()).code, "pfx-unlock-failed");
  const wrongCompany = await put(other, "missing");
  assert.equal(wrongCompany.status, 422);
  assert.equal((await wrongCompany.json()).code, "certificate-holder-mismatch");
  const expired = authority.issue(a.cnpj, { expired: true });
  assert.equal((await put(owner, "missing", { pfx: expired.pfx.toString("base64"), password })).status, 422);
  const foreign = testAuthority().issue(a.cnpj);
  const wrongRoot = await put(owner, "missing", { pfx: foreign.pfx.toString("base64"), password });
  assert.equal(wrongRoot.status, 422);
  assert.equal((await wrongRoot.json()).code, "certificate-chain-untrusted");

  const response = await put(owner, "missing");
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const view = await response.json();
  assert.deepEqual(Object.keys(view.certificate).sort(), ["expired", "savedAt", "validFrom", "validUntil", "version"]);
  assert.equal(view.certificate.expired, false);
  const saved = await prisma.fiscalCertificate.findUniqueOrThrow({ where: { organizationId: a.id } });
  assert.equal(saved.version, view.certificate.version);
  assert.equal(Buffer.from(saved.sealed).includes(pfx), false);
  assert.equal(Buffer.from(saved.sealed).includes(Buffer.from(password)), false);
  assert.deepEqual(await (await request(path, "GET", other)).json(), { enabled: true, certificate: null });
  assert.equal((await request(path, "DELETE", other, undefined, { "If-Match": '"' + saved.version + '"' })).status, 409);
  assert.equal((await put(owner, "missing")).status, 409);
  const rotated = await put(owner, saved.version);
  assert.equal(rotated.status, 200);
  const { certificate } = await rotated.json();
  assert.notEqual(certificate.version, saved.version);
  assert.equal((await request(path, "DELETE", owner, undefined, { "If-Match": '"' + saved.version + '"' })).status, 409);
  assert.equal((await request(path, "DELETE", owner, undefined, { "If-Match": '"' + certificate.version + '"' })).status, 204);
  const audit = await prisma.registrationAuditEvent.findMany({
    where: { organizationId: a.id, entity: "FISCAL_CERTIFICATE" }, select: { action: true, actorUserId: true },
  });
  assert.deepEqual(audit.map(({ action }) => action).sort(), ["ARCHIVED", "CREATED", "UPDATED"]);
  assert.ok(audit.every(({ actorUserId }) => actorUserId === shared.id));
});

test("monthly schedules create one scoped draft from a snapshot and pause on unavailable references", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  const service = await prisma.service.create({ data: { ...services, organizationId: a.id, defaultAmount: "12.34" } });
  const source = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, serviceId: service.id,
    serviceDescription: "Modelo mensal", amount: "50.42", idempotencyKey: randomUUID(),
  } });
  const input = { draftId: source.id, dayOfMonth: 31 };
  assert.equal((await request("/schedules", "POST", writer, input)).status, 403);
  assert.equal((await request("/schedules", "POST", other, input)).status, 404);
  assert.equal((await request("/schedules", "POST", owner, { ...input, dayOfMonth: 32 })).status, 400);
  const attempts = await Promise.all([
    request("/schedules", "POST", owner, input),
    request("/schedules", "POST", owner, input),
  ]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 201]);
  const [schedule, replay] = await Promise.all(attempts.map((response) => response.json()));
  assert.deepEqual(schedule, replay);
  const path = "/schedules/" + schedule.id;
  const update = { active: false, dayOfMonth: 31 };
  assert.deepEqual((await (await request("/schedules", "GET", other)).json()).items, []);
  assert.equal((await request(path, "PATCH", other, update)).status, 404);
  const paused = await request(path, "PATCH", owner, update);
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).nextRunAt, null);
  const resumed = await request(path, "PATCH", owner, { ...update, active: true });
  assert.equal(resumed.status, 200);
  assert.ok((await resumed.json()).nextRunAt);

  const scheduleScope = { organizationId: a.id, id: schedule.id };
  const february = new Date("2028-02-29T11:00:00.000Z");
  await prisma.invoiceSchedule.update({ where: scheduleScope, data: { nextRunAt: february } });
  await prisma.invoice.update({ where: { id: source.id }, data: { amount: "500.00", discardedAt: new Date() } });
  await Promise.all([runDueDraftSchedules(prisma, february), runDueDraftSchedules(prisma, february)]);
  await runDueDraftSchedules(prisma, february);
  const drafts = await prisma.invoice.findMany({ where: { organizationId: a.id, discardedAt: null } });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].status, "DRAFT");
  assert.equal(drafts[0].amount.toFixed(2), "50.42");
  assert.equal(drafts[0].serviceDescription, "Modelo mensal");
  assert.equal(await prisma.invoice.count({ where: { organizationId: b.id } }), 0);
  const history = await (await request("/invoices/activity", "GET", owner)).json();
  assert.equal(history.items[0].actorName, "Automação");
  assert.equal(history.items[0].draftId, drafts[0].id);
  const advanced = await prisma.invoiceSchedule.findUniqueOrThrow({ where: scheduleScope });
  assert.equal(advanced.nextRunAt?.toISOString(), "2028-03-31T11:00:00.000Z");

  await prisma.service.update({ where: { id: service.id }, data: { active: false } });
  await runDueDraftSchedules(prisma, new Date("2028-03-31T11:00:00.000Z"));
  const blocked = await prisma.invoiceSchedule.findUniqueOrThrow({ where: scheduleScope });
  assert.equal(blocked.nextRunAt, null);
  assert.equal(blocked.pauseReason, "service-unavailable");
  assert.equal(await prisma.invoice.count({ where: { organizationId: a.id, discardedAt: null } }), 1);
  assert.equal((await request(path, "PATCH", owner, { ...update, active: true })).status, 404);
});

test("draft reports total the local period, exclude discarded records and escape exported text", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const [customerA, customerB] = await Promise.all([
    prisma.customer.create({ data: { ...customers, organizationId: a.id, name: '=1+2; "Cliente"' } }),
    prisma.customer.create({ data: { ...customers, organizationId: b.id, name: "Cliente de outra empresa" } }),
  ]);
  const base = { organizationId: a.id, customerId: customerA.id, serviceDescription: "Linha 1\nLinha 2" };
  await prisma.invoice.createMany({ data: [
    { ...base, amount: "25.10", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-08T03:00:00Z") },
    { ...base, amount: "0.09", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-09T02:59:59.999Z") },
    { ...base, amount: "100.00", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-08T02:59:59.999Z") },
    { ...base, amount: "100.00", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-09T03:00:00Z") },
    { ...base, amount: "100.00", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-08T18:00:00Z"), discardedAt: new Date() },
    { ...base, amount: "100.00", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-08T18:00:00Z"), status: "QUEUED" },
    { ...base, amount: "50.00", idempotencyKey: randomUUID(), createdAt: new Date("2026-11-08T18:00:00Z"), organizationId: b.id, customerId: customerB.id },
  ] });
  const query = "from=2026-11-08&to=2026-11-08";
  const path = "/reports/drafts?" + query;
  const csvPath = "/reports/drafts.csv?" + query;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, "GET", writer)).status, 403);
  assert.equal((await request(csvPath, "GET", writer)).status, 403);
  assert.equal((await request(path + "&organizationId=" + b.id, "GET", owner)).status, 400);
  assert.equal((await request("/reports/drafts?from=2026-11-09&to=2026-11-08", "GET", owner)).status, 400);
  const summary = await request(path + "&limit=1", "GET", owner);
  assert.equal(summary.status, 200);
  const report = await summary.json();
  assert.equal(report.count, 2);
  assert.equal(report.amount, "25.19");
  assert.equal(report.hasNext, true);
  assert.equal(report.items[0].amount, "0.09");
  assert.equal(report.items[0].customer.name, customerA.name);
  const otherReport = await (await request(path, "GET", other)).json();
  assert.equal(otherReport.count, 1);
  assert.equal(otherReport.amount, "50.00");

  const download = await request(csvPath, "GET", owner);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition") ?? "", /attachment; filename="rascunhos\.csv"/);
  assert.equal(download.headers.get("Cache-Control"), "no-store");
  const csv = await download.text();
  assert.match(csv, /"\'=1\+2; ""Cliente""";"";"Linha 1\nLinha 2";25,10/);
  assert.doesNotMatch(csv, /Cliente de outra empresa|;100,00/);
});

test("team management isolates roles, revokes sessions and preserves an owner under concurrency", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const viewer = await login(shared.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const membership = (userId: string) => prisma.membership.findUniqueOrThrow({
    where: { userId_organizationId: { organizationId: a.id, userId } },
  });
  const [mine, target] = await Promise.all([membership(shared.id), membership(operator.id)]);
  const ownPath = `/team/${mine.id}`;
  const targetPath = `/team/${target.id}`;

  assert.equal((await request("/team")).status, 401);
  assert.equal((await request("/team", "GET", writer)).status, 403);
  assert.equal((await request("/team", "GET", viewer)).status, 403);
  const list = await (await request("/team", "GET", owner)).json();
  assert.deepEqual(list.items.map(({ id }: { id: string }) => id).sort(), [mine.id, target.id].sort());
  assert.deepEqual(list.items.find(({ id }: { id: string }) => id === mine.id), {
    id: mine.id, name: shared.name, email: shared.email, role: "OWNER", isSelf: true,
  });
  const otherList = await (await request("/team", "GET", other)).json();
  assert.deepEqual(otherList.items.map(({ email }: { email: string }) => email).sort(), [shared.email, ownerB.email].sort());
  assert.equal((await request(targetPath, "PATCH", other, { role: "ADMIN" })).status, 404);
  assert.equal((await request(targetPath, "DELETE", other)).status, 404);
  assert.equal((await request(ownPath, "PATCH", owner, { role: "VIEWER" })).status, 409);
  assert.equal((await request(ownPath, "DELETE", owner)).status, 409);
  assert.equal((await request(targetPath, "PATCH", owner, { role: "ADMIN", organizationId: b.id })).status, 400);

  const changed = await request(targetPath, "PATCH", owner, { role: "ADMIN" });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).role, "ADMIN");
  assert.equal((await request("/team", "GET", writer)).status, 401);
  const admin = await login(operator.email, a.cnpj);
  assert.equal((await request("/team", "GET", admin)).status, 200);
  assert.equal((await request(ownPath, "PATCH", admin, { role: "VIEWER" })).status, 403);
  assert.equal((await request(ownPath, "DELETE", admin)).status, 403);
  assert.equal((await request(targetPath, "PATCH", owner, { role: "OWNER" })).status, 200);
  const secondOwner = await login(operator.email, a.cnpj);

  const attempts = await Promise.all([
    request(targetPath, "DELETE", owner),
    request(ownPath, "DELETE", secondOwner),
  ]);
  const results = attempts.map(({ status }) => status);
  assert.equal(results.filter((status) => status === 204).length, 1);
  assert.ok(results.some((status) => status === 401 || status === 403));
  assert.equal(await prisma.membership.count({ where: { organizationId: a.id, role: "OWNER" } }), 1);
  assert.equal((await request("/invoices", "GET", viewer)).status, 200);
  const removed = results[0] === 204 ? target.id : mine.id;
  const events = await prisma.registrationAuditEvent.findMany({
    where: { organizationId: a.id, entity: "MEMBERSHIP" },
    select: { action: true, entityId: true },
  });
  assert.equal(events.length, 3);
  assert.equal(events.filter((event) => event.action === "UPDATED" && event.entityId === target.id).length, 2);
  assert.deepEqual(events.find((event) => event.action === "ARCHIVED"), { action: "ARCHIVED", entityId: removed });
});

test("invoice drafts isolate references, reads and idempotency keys by organization", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const viewer = await login(shared.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const [customerA, customerB, serviceA, serviceB] = await Promise.all([
    prisma.customer.create({ data: { ...customers, organizationId: a.id } }),
    prisma.customer.create({ data: { ...customers, organizationId: b.id } }),
    prisma.service.create({ data: { ...services, defaultAmount: "123.45", organizationId: a.id } }),
    prisma.service.create({ data: { ...services, defaultAmount: "123.45", organizationId: b.id } }),
  ]);
  const key = { "Idempotency-Key": randomUUID() };
  const input = { customerId: customerA.id, serviceId: serviceA.id, amount: "123,45", serviceDescription: "Serviço do rascunho" };
  const otherInput = { ...input, customerId: customerB.id, serviceId: serviceB.id };
  const post = (cookie: string, data: object, headers = key) => request("/invoices", "POST", cookie, data, headers);

  assert.equal((await request("/invoices")).status, 401);
  assert.equal((await post(viewer, otherInput)).status, 403);
  assert.equal((await post(owner, { ...input, organizationId: b.id })).status, 400);
  assert.equal((await post(owner, { ...input, status: "AUTHORIZED" })).status, 400);
  assert.equal((await post(owner, { ...input, amount: "0.00" })).status, 400);
  assert.equal((await request("/invoices", "POST", owner, input)).status, 400);
  assert.equal((await post(owner, { ...input, customerId: customerB.id })).status, 404);
  assert.equal((await post(owner, { ...input, serviceId: serviceB.id })).status, 404);
  assert.equal((await request("/invoices", "GET", owner, undefined, { "X-FiscalFlow-Context": b.id })).status, 409);

  const attempts = await Promise.all([post(writer, input), post(writer, input)]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 201]);
  const [first, replay] = await Promise.all(attempts.map((result) => result.json()));
  assert.deepEqual(first, replay);
  assert.equal(first.status, "DRAFT");
  assert.equal(first.amount, "123.45");
  assert.equal(first.serviceDescription, input.serviceDescription);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, entity: "INVOICE", entityId: first.id, action: "CREATED", actorUserId: operator.id },
  }), 1);

  const conflict = await post(owner, { ...input, amount: "99.00" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency-conflict");
  const otherResponse = await post(other, otherInput);
  assert.equal(otherResponse.status, 201);
  const otherDraft = await otherResponse.json();
  const visible = await (await request("/invoices", "GET", viewer)).json();
  assert.deepEqual(visible.items.map((draft: { id: string }) => draft.id), [otherDraft.id]);
  const mine = await (await request("/invoices?limit=1", "GET", owner)).json();
  assert.deepEqual(mine.items.map((draft: { id: string }) => draft.id), [first.id]);
  assert.equal(mine.hasNext, false);

  await prisma.service.update({ where: { id: serviceA.id }, data: { active: false } });
  const freshKey = { "Idempotency-Key": randomUUID() };
  assert.equal((await post(owner, input, freshKey)).status, 404);
  assert.equal((await post(owner, input)).status, 200);
  const manual = await post(owner, { ...input, serviceId: null }, freshKey);
  assert.equal(manual.status, 201);
  assert.equal((await manual.json()).service, null);
});

test("draft changes require the current version, the right company and the right role", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const viewer = await login(shared.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const [customer, foreignCustomer] = await Promise.all([
    prisma.customer.create({ data: { ...customers, organizationId: a.id } }),
    prisma.customer.create({ data: { ...customers, organizationId: b.id } }),
  ]);
  const service = await prisma.service.create({ data: { ...services, defaultAmount: "123.45", organizationId: a.id } });
  const input = { customerId: customer.id, serviceId: service.id, amount: "10.00", serviceDescription: "Antes de editar" };
  const key = { "Idempotency-Key": randomUUID() };
  const initial = await request("/invoices", "POST", writer, input, key);
  assert.equal(initial.status, 201);
  const draft = await initial.json();
  const path = `/invoices/${draft.id}`;
  const version = { "If-Match": `"${draft.updatedAt}"` };
  assert.equal((await request(path, "PATCH", viewer, { amount: "20.00" }, version)).status, 403);
  assert.equal((await request(path, "DELETE", writer, undefined, version)).status, 403);
  assert.equal((await request(path, "PATCH", other, { amount: "20.00" }, version)).status, 404);
  assert.equal((await request(path, "DELETE", other, undefined, version)).status, 404);
  assert.equal((await request(path, "PATCH", writer, { customerId: foreignCustomer.id }, version)).status, 404);
  assert.equal((await request(path, "PATCH", writer, { status: "AUTHORIZED" }, version)).status, 400);

  await prisma.service.update({ where: { id: service.id }, data: { active: false } });
  const edits = await Promise.all([
    request(path, "PATCH", writer, { amount: "20,25" }, version),
    request(path, "PATCH", writer, { amount: "30,50" }, version),
  ]);
  assert.deepEqual(edits.map((result) => result.status).sort(), [200, 409]);
  const changed = await edits.find((result) => result.status === 200)!.json();
  assert.equal(changed.serviceId, service.id);
  assert.notEqual(changed.updatedAt, draft.updatedAt);
  assert.equal((await request(path, "DELETE", owner, undefined, version)).status, 409);
  const current = { "If-Match": `"${changed.updatedAt}"` };
  assert.equal((await request(path, "DELETE", owner, undefined, current)).status, 204);
  assert.equal((await request(path, "PATCH", owner, { amount: "99.00" }, current)).status, 404);
  const listing = await (await request("/invoices", "GET", owner)).json();
  assert.deepEqual(listing.items, []);
  assert.ok((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).discardedAt);
  assert.equal((await request("/invoices", "POST", writer, input, key)).status, 409);
  const events = await prisma.registrationAuditEvent.findMany({
    where: { organizationId: a.id, entity: "INVOICE", entityId: draft.id },
    select: { action: true, actorUserId: true },
  });
  assert.deepEqual(events.sort((left, right) => left.action.localeCompare(right.action)), [
    { action: "ARCHIVED", actorUserId: shared.id }, { action: "CREATED", actorUserId: operator.id }, { action: "UPDATED", actorUserId: operator.id },
  ]);
  assert.equal((await request("/invoices/activity", "GET", writer)).status, 403);
  const foreignActivity = await (await request("/invoices/activity", "GET", other)).json();
  assert.deepEqual(foreignActivity.items, []);
  const history = await request("/invoices/activity?action=ARCHIVED", "GET", owner);
  assert.equal(history.status, 200);
  const activity = await history.json();
  assert.deepEqual(activity.items.map((event: { draftId: string; action: string; actorName: string; customerName: string }) => [
    event.draftId, event.action, event.actorName, event.customerName,
  ]), [[draft.id, "ARCHIVED", shared.name, customer.name]]);
});

for (const resource of ["customers", "services"] as const) {
  const input = resource === "customers" ? customers : services;
  test(`${resource} CRUD keeps reads, writes and archives inside the session tenant`, async (t) => {
    const { a, b, shared, ownerB, prisma, request, login } = await setup(t);
    const path = `/${resource}`;
    const owner = await login(shared.email, a.cnpj);
    const other = await login(ownerB.email, b.cnpj);
    const viewer = await login(shared.email, b.cnpj);

    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, "POST", owner, { ...input, organizationId: b.id })).status, 400);
    assert.equal((await request(path, "POST", owner, input, { Origin: "https://other.example.test" })).status, 403);
    const first = await request(path, "POST", owner, input);
    const second = await request(path, "POST", other, input);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const mine = await first.json();
    const theirs = await second.json();
    if (resource === "customers") {
      assert.equal(mine.federalTaxId, "00000000000");
      await prisma.customer.update({ where: { id: mine.id }, data: { federalTaxId: customers.federalTaxId } });
      assert.equal((await request(path, "POST", owner, customers)).status, 409);
    } else {
      assert.equal(mine.defaultAmount, "123.45");
    }

    const list = await request(`${path}?page=1&limit=1`, "GET", owner, undefined, { "X-Organization-Id": b.id });
    const rows = await list.json();
    assert.equal(list.status, 200);
    assert.deepEqual(rows.items.map((row: { id: string }) => row.id), [mine.id]);
    assert.equal(rows.hasNext, false);
    assert.equal((await request(`${path}?organizationId=${b.id}`, "GET", owner)).status, 400);
    assert.equal((await request(`${path}?limit=101`, "GET", owner)).status, 400);

    const target = `${path}/${theirs.id}`;
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const data = method === "PATCH" ? { name: "Tentativa de invasão" } : undefined;
      assert.equal((await request(target, method, owner, data)).status, 404);
    }
    assert.equal((await request(target, "GET", viewer)).status, 200);
    assert.equal((await request(target, "PATCH", viewer, { name: "Bloqueado" })).status, 403);
    const unchanged = await request(target, "GET", other);
    assert.equal((await unchanged.json()).name, input.name);

    const minePath = `${path}/${mine.id}`;
    const updated = await request(minePath, "PATCH", owner, { name: "Cadastro atualizado" });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).name, "Cadastro atualizado");
    const read = await request(minePath, "GET", owner);
    assert.equal((await read.json()).name, "Cadastro atualizado");
    assert.equal((await request(minePath, "DELETE", owner)).status, 204);
    assert.equal((await request(minePath, "GET", owner)).status, 404);
    assert.equal((await request(minePath, "PATCH", owner, { name: "Arquivado" })).status, 404);
    const archived = resource === "customers"
      ? await prisma.customer.findUnique({ where: { id: mine.id } })
      : await prisma.service.findUnique({ where: { id: mine.id } });
    assert.ok(archived?.archivedAt);

    const audit = await prisma.registrationAuditEvent.findMany({ where: { entityId: mine.id } });
    assert.deepEqual(audit.map(({ action }) => action).sort(), ["ARCHIVED", "CREATED", "UPDATED"]);
    assert.ok(audit.every((event) => event.organizationId === a.id && event.actorUserId === shared.id));
    assert.equal(await prisma.registrationAuditEvent.count({ where: { entityId: theirs.id, organizationId: a.id } }), 0);
  });
}

test("organization creation grants owner only in the new tenant and archiving revokes that tenant's sessions", async (t) => {
  const { a, b, shared, ownerB, newCnpj, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const current = "/organizations/current";
  const mask = maskCnpj(newCnpj);
  const created = await request("/organizations", "POST", owner, { legalName: "Empresa nova", cnpj: mask.toLowerCase() });
  assert.equal(created.status, 201);
  const company = await created.json();
  assert.equal(company.cnpj, newCnpj);
  const createdMembership = await prisma.membership.findUnique({
    where: { userId_organizationId: { organizationId: company.id, userId: shared.id } },
  });
  assert.equal(createdMembership?.role, "OWNER");
  assert.equal(await prisma.membership.count({ where: { organizationId: company.id } }), 1);
  assert.equal((await request("/organizations", "POST", owner, { legalName: "Duplicada", cnpj: newCnpj })).status, 409);
  assert.equal((await request("/organizations", "POST", owner, { legalName: "Duplicada legada", cnpj: b.cnpj })).status, 409);

  const before = await request(`${current}?organizationId=${b.id}`, "GET", owner, undefined, { "X-Organization-Id": b.id });
  assert.equal((await before.json()).id, a.id);
  assert.equal((await request(`/organizations/${b.id}`, "GET", owner)).status, 404);
  assert.equal((await request(current, "PATCH", owner, { cnpj: b.cnpj })).status, 400);
  const stale = await request(current, "PATCH", owner, { legalName: "Empresa errada" }, { "X-FiscalFlow-Context": b.id });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { code: "organization-changed" });
  const changed = await request(current, "PATCH", owner, { legalName: "Empresa A editada", cityIbgeCode: "3550308" });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).legalName, "Empresa A editada");
  assert.equal((await prisma.organization.findUnique({ where: { id: b.id } }))?.legalName, "Empresa B");

  const c = await login(shared.email, newCnpj);
  const secondC = await login(shared.email, newCnpj);
  assert.equal((await (await request(current, "GET", c)).json()).id, company.id);
  assert.equal((await request(current, "DELETE", c)).status, 204);
  assert.equal((await request(current, "GET", secondC)).status, 401);
  assert.equal(await prisma.session.count({ where: { organizationId: company.id } }), 0);
  assert.ok((await prisma.organization.findUnique({ where: { id: company.id } }))?.archivedAt);
  assert.equal((await request("/auth/login", "POST", undefined, { email: shared.email, organizationCnpj: newCnpj, password })).status, 401);
  assert.equal((await request("/organizations", "POST", owner, { legalName: "Reutilização", cnpj: newCnpj })).status, 409);
  assert.equal((await request(current, "GET", owner)).status, 200);
  assert.equal((await request(current, "GET", other)).status, 200);
});

test("catalog roles restrict archive and preserve historical invoice references", async (t) => {
  const { a, operator, prisma, request, login } = await setup(t);
  const cookie = await login(operator.email, a.cnpj);
  const customer = await request("/customers", "POST", cookie, customers);
  const service = await request("/services", "POST", cookie, services);
  assert.equal(customer.status, 201);
  assert.equal(service.status, 201);
  const customerId = (await customer.json()).id;
  const serviceId = (await service.json()).id;
  assert.equal((await request(`/services/${serviceId}`, "PATCH", cookie, { defaultAmount: "0.001" })).status, 400);
  assert.equal((await request(`/services/${serviceId}`, "PATCH", cookie, { defaultAmount: "12.50" })).status, 200);
  assert.equal((await request(`/services/${serviceId}`, "DELETE", cookie)).status, 403);
  assert.equal((await request("/organizations/current", "PATCH", cookie, { legalName: "Bloqueado" })).status, 403);
  const invoice = await prisma.invoice.create({
    data: { organizationId: a.id, customerId, serviceId, idempotencyKey: randomUUID(), amount: "12.50", serviceDescription: "Histórico de teste" },
  });

  await prisma.membership.update({
    where: { userId_organizationId: { userId: operator.id, organizationId: a.id } },
    data: { role: "ADMIN" },
  });
  assert.equal((await request("/organizations/current", "PATCH", cookie, { legalName: "Editado pelo admin" })).status, 200);
  assert.equal((await request("/organizations/current", "DELETE", cookie)).status, 403);
  assert.equal((await request("/organizations", "POST", cookie, { legalName: "Bloqueado", cnpj: testCnpj() })).status, 403);
  assert.equal((await request(`/services/${serviceId}`, "DELETE", cookie)).status, 204);
  assert.equal((await request(`/customers/${customerId}`, "DELETE", cookie)).status, 204);
  const kept = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  assert.equal(kept?.customerId, customerId);
  assert.equal(kept?.serviceId, serviceId);
  assert.equal((await prisma.service.findUnique({ where: { id: serviceId } }))?.active, false);
});
