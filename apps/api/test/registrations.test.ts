import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { SignedXml } from "xml-crypto";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/credentials.ts";
import { createAuthRouter } from "../src/auth/router.ts";
import { createCelcoinSandbox, type CelcoinSandbox } from "../src/billing/celcoin-sandbox.ts";
import { loadHomologationSigningKey, loadTrustedA1 } from "../src/fiscal/certificate.ts";
import { createCertificateVault, type CertificateVault, type HomologationTransportProvider } from "../src/fiscal/certificate-vault.ts";
import type { ProductionLookupConfig } from "../src/fiscal/certificates-router.ts";
import { validateDps } from "../src/fiscal/documents.ts";
import type { PublicCnpjLookup } from "../src/invoices/cnpj-lookup.ts";
import { runDueDraftSchedules } from "../src/invoices/schedules.ts";
import { runAutomaticInvoices } from "../src/invoices/automatic-schedules.ts";
import type { ProductionIssuanceConfig } from "../src/invoices/production-issuance.ts";
import { dpsDraftFields, productionSourceHash } from "../src/invoices/prepare-dps.ts";
import { createRegistrationsRouter } from "../src/registrations/router.ts";
import { testAuthority } from "./a1-fixture.ts";

const origin = "https://painel.example.test";
const password = randomBytes(24).toString("base64url");
const testCnpj = () => randomBytes(6).toString("hex").toUpperCase() + "00";
const maskCnpj = (value: string) => value.replace(/^(..)(...)(...)(....)(..)$/, "$1.$2.$3/$4-$5");

async function setup(
  t: TestContext, vault?: CertificateVault, celcoin?: (cnpj: string) => CelcoinSandbox,
  homologation?: HomologationTransportProvider, productionLookup?: (cnpj: string) => ProductionLookupConfig,
  productionIssuance?: (cnpj: string, secondCnpj: string) => ProductionIssuanceConfig,
  publicCnpjLookup?: PublicCnpjLookup,
) {
  const prisma = new PrismaClient();
  const issuer = () => productionIssuance ? String(randomInt(10 ** 11, 10 ** 12)) + "00" : testCnpj();
  const testOrganizations = [issuer(), maskCnpj(issuer()), testCnpj()];
  const testCpfs: string[] = [];
  const emails = [randomUUID(), randomUUID(), randomUUID()].map((id) => `${id}@example.test`);
  const app = createApp(
    origin, async () => {}, createAuthRouter(prisma, origin, false), vault ? ["127.0.0.1"] : [],
    createRegistrationsRouter(prisma, origin, false, vault, celcoin?.(testOrganizations[0]), {
      homologation, publicCnpjLookup, productionLookup: productionLookup?.(testOrganizations[0]),
      productionIssuance: productionIssuance?.(testOrganizations[0], testOrganizations[1].replace(/[./-]/g, "")),
    }),
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
        prisma.cashPayment.deleteMany({ where: scope }),
        prisma.cashEntry.deleteMany({ where: scope }),
        prisma.stockMovement.deleteMany({ where: scope }),
        prisma.commercialItem.deleteMany({ where: scope }),
        prisma.commercialOrder.deleteMany({ where: { ...scope, sourceId: { not: null } } }),
        prisma.commercialOrder.deleteMany({ where: scope }),
        prisma.product.deleteMany({ where: scope }),
        prisma.supplier.deleteMany({ where: scope }),
        prisma.automaticInvoiceRun.deleteMany({ where: scope }),
        prisma.preparedDps.deleteMany({ where: scope }),
        prisma.dpsFiscalTemplate.deleteMany({ where: scope }),
        prisma.serviceDpsFiscalTemplate.deleteMany({ where: scope }),
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

test("the first platform owner invitation grants platform access to the exact tenant once", async (t) => {
  const { a, newCnpj, operator, prisma, request, login } = await setup(t);
  const code = randomBytes(32).toString("base64url");
  await prisma.organization.create({
    data: {
      cnpj: newCnpj, legalName: "Plataforma de teste",
      accessInvitation: { create: {
        email: operator.email, name: operator.name, platformOwner: true,
        tokenHash: createHash("sha256").update(code).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      } },
    },
  });
  const previousSession = await login(operator.email, a.cnpj);
  const claim = await request("/auth/activate", "POST", undefined, { code, password });
  assert.equal(claim.status, 200, await claim.clone().text());
  assert.equal((await request("/auth/activate", "POST", undefined, { code, password })).status, 404);
  assert.equal((await request("/platform/companies", "GET", previousSession)).status, 403);
  const platformSession = await login(operator.email, newCnpj);
  assert.equal((await request("/platform/companies", "GET", platformSession)).status, 200);
});

test("Orçamento Express protege a proposta e registra uma única resposta do cliente", async (t) => {
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const staff = await login(operator.email, a.cnpj);
  const commercial = "/organizations/current/branding";
  const logo = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRf8AAAAASUVORK5CYII=";
  const watermark = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGMUiQ1gYGBgYgADKAUADmsAxyDRF18AAAAASUVORK5CYII=";
  const brand = { commercialEmail: "vendas@example.test", commercialPhone: "12345678", commercialAddress: "Rua de teste", quoteWatermark: true };
  assert.equal((await request(commercial, "PUT", staff, brand)).status, 403);
  assert.equal((await request(commercial, "PUT", owner, { ...brand, commercialLogo: "PGh0bWw+" })).status, 400);
  assert.equal((await request(commercial, "PUT", owner, { ...brand, commercialLogo: logo })).status, 200);
  assert.equal((await request(commercial, "PUT", owner, { ...brand, quoteWatermarkImage: "PGh0bWw+" })).status, 400);
  assert.equal((await request(commercial, "PUT", owner, { ...brand, quoteWatermarkImage: watermark })).status, 200);
  const otherBrand = await (await request(commercial, "GET", other)).json();
  assert.equal(otherBrand.logo, null);
  assert.equal(otherBrand.watermarkImage, null);
  assert.equal(otherBrand.commercialEmail, null);

  const customer = await (await request("/customers", "POST", owner, { ...customers, federalTaxId: "00.000.000/0987-00" })).json();
  const service = await (await request("/services", "POST", owner, services)).json();
  const order = { customerId: customer.id, note: "Condições de teste", items: [{ id: service.id, type: "SERVICE", price: "123.45", quantity: 2 }] };
  const orders = "/commercial/orders";
  async function createQuote() {
    const response = await request(orders, "POST", owner, { kind: "QUOTE", order }, { "Idempotency-Key": randomUUID() });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  const current = async (path: string) => (await request(path, "GET", owner)).json();
  const version = (row: { updatedAt: string }) => ({ "If-Match": '"' + row.updatedAt + '"' });
  const token = randomBytes(32).toString("base64url");
  const shareBody = (code: string) => ({ tokenHash: createHash("sha256").update(code).digest("hex") });
  const publicPath = "/quote-express";
  const document = "00.000.000/0987-00";
  const access = { token, document };
  const quote = await createQuote();
  const path = orders + "/" + quote.id;
  const quoteBilling = "/boletos/quote/" + quote.id;
  const billingList = "/boletos?quoteId=" + quote.id;
  const billingYear = new Date().getUTCFullYear() + 1;
  const settlement = { dueDate: billingYear + "-01-31", installments: 4 };
  assert.equal((await request(path + "/invoice-draft", "POST", owner, undefined, version(quote))).status, 409);
  assert.equal((await request(quoteBilling, "POST", owner, settlement)).status, 404);
  assert.equal((await request(path + "/pdf")).status, 401);
  assert.equal((await request(path + "/pdf", "GET", other)).status, 404);
  assert.equal((await request(path + "/pdf", "GET", owner, undefined, { "X-FiscalFlow-Context": b.id })).status, 409);
  const pdf = await request(path + "/pdf", "GET", owner);
  assert.equal(pdf.status, 200, await pdf.clone().text());
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
  assert.equal(pdf.headers.get("Cache-Control"), "no-store");
  assert.match(pdf.headers.get("Content-Disposition") ?? "", /^attachment; filename="orcamento-/);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdfBytes.includes("/Subtype /Image"));
  assert.match(pdfBytes.toString("latin1"), /\/Width 2\s+\/Height 3/);
  assert.equal((await request(path + "/share", "PUT", other, shareBody(token), version(quote))).status, 404);
  const sharedQuote = await request(path + "/share", "PUT", owner, shareBody(token), version(quote));
  assert.equal(sharedQuote.status, 200, await sharedQuote.clone().text());
  assert.equal(Object.hasOwn(await sharedQuote.json(), "tokenHash"), false);
  assert.equal((await request(publicPath + "/view", "POST", undefined, { token, document: a.cnpj })).status, 404);
  assert.equal((await request(publicPath + "/view", "POST", undefined, { token, document: b.cnpj })).status, 404);
  assert.equal((await request(publicPath + "/view", "POST", undefined, access, { Origin: "https://outra.example.test" })).status, 403);
  const publicView = await request(publicPath + "/view", "POST", undefined, access);
  assert.equal(publicView.status, 200, await publicView.clone().text());
  assert.equal(publicView.headers.get("Cache-Control"), "no-store");
  const proposal = await publicView.json();
  assert.equal(proposal.amount, "246.9");
  assert.equal(proposal.brand.logo, "data:image/png;base64," + logo);
  assert.equal(proposal.brand.watermarkImage, "data:image/png;base64," + watermark);
  assert.equal(proposal.brand.commercialEmail, brand.commercialEmail);
  assert.equal(Object.hasOwn(proposal, "organizationId"), false);
  assert.equal(Object.hasOwn(proposal.items[0], "unitCost"), false);
  assert.equal((await request(path + "/convert", "POST", owner, undefined, version(await current(path)))).status, 409);
  const beforeResponse = await current(path);
  const answer = (decision: "APPROVED" | "DECLINED") => request(publicPath + "/respond", "POST", undefined, { ...access, decision });
  const decisions = await Promise.all([answer("APPROVED"), answer("APPROVED")]);
  assert.deepEqual(decisions.map((response) => response.status), [200, 200]);
  assert.equal((await answer("DECLINED")).status, 409);
  const approved = await current(path);
  assert.equal(approved.quoteShare.decision, "APPROVED");
  assert.equal(await prisma.registrationAuditEvent.count({ where: { organizationId: a.id, entityId: quote.id, action: "QUOTE_APPROVED", actorUserId: null } }), 1);
  assert.equal((await request(path, "PUT", owner, order, version(beforeResponse))).status, 409);
  assert.equal((await request(path + "/invoice-draft", "POST", other, undefined, version(approved))).status, 404);
  const invoice = await request(path + "/invoice-draft", "POST", owner, undefined, version(approved));
  assert.equal(invoice.status, 200, await invoice.clone().text());
  const { invoiceId } = await invoice.json();
  const fiscal = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId, organizationId: a.id } });
  assert.equal(fiscal.status, "DRAFT");
  assert.equal(fiscal.amount.toFixed(2), "246.90");
  assert.equal((await request(quoteBilling, "POST", owner, settlement)).status, 409);
  assert.equal((await request(billingList, "GET", other)).status, 404);
  assert.equal((await request(quoteBilling, "POST", other, settlement)).status, 404);
  assert.equal((await request(quoteBilling, "POST", staff, settlement)).status, 403);
  assert.equal((await request("/receiving-account", "PUT", owner, {
    provider: "OWN_BANK", bankName: "Banco de teste", bankCode: "001", branch: "0001", accountNumber: "123456-7",
  })).status, 200);
  const plans = await Promise.all([
    request(quoteBilling, "POST", owner, settlement), request(quoteBilling, "POST", owner, settlement),
  ]);
  assert.deepEqual(plans.map((result) => result.status).sort(), [200, 201]);
  const [firstPlan, secondPlan] = await Promise.all(plans.map((result) => result.json()));
  assert.deepEqual(firstPlan.items, secondPlan.items);
  assert.deepEqual(firstPlan.items.map((item: { amount: string }) => item.amount), ["61.73", "61.73", "61.72", "61.72"]);
  assert.equal(firstPlan.items[1].dueDate, new Date(Date.UTC(billingYear, 2, 0)).toISOString().slice(0, 10));
  assert.ok(firstPlan.items.every((item: { status: string }) => item.status === "PLANNED"));
  assert.equal((await request(quoteBilling, "POST", owner, { ...settlement, installments: 1 })).status, 409);
  const fiscalBilling = await (await request("/boletos?invoiceId=" + invoiceId, "GET", owner)).json();
  assert.deepEqual(fiscalBilling.items.map((item: { id: string }) => item.id), firstPlan.items.map((item: { id: string }) => item.id));
  assert.equal((await request("/boletos", "POST", owner, { invoiceId, dueDate: settlement.dueDate })).status, 409);
  const conversion = await request(path + "/convert", "POST", owner, undefined, version(await current(path)));
  assert.equal(conversion.status, 200, await conversion.clone().text());
  assert.equal((await conversion.json()).invoice.id, invoiceId);
  assert.equal(await prisma.invoice.count({ where: { organizationId: a.id, customerId: customer.id } }), 1);

  const cashQuote = await createQuote();
  const cashToken = randomBytes(32).toString("base64url");
  assert.equal((await request(orders + "/" + cashQuote.id + "/share", "PUT", owner, shareBody(cashToken), version(cashQuote))).status, 200);
  assert.equal((await request(publicPath + "/respond", "POST", undefined, { document, token: cashToken, decision: "APPROVED" })).status, 200);
  const cashPlan = await request("/boletos/quote/" + cashQuote.id, "POST", owner, { ...settlement, installments: 1 });
  assert.equal(cashPlan.status, 201, await cashPlan.clone().text());
  const { items: cashItems } = await cashPlan.json();
  assert.equal(cashItems.length, 1);
  assert.equal(cashItems[0].amount, "246.90");
  assert.equal(cashItems[0].dueDate, settlement.dueDate);

  const revised = await createQuote();
  const revisedPath = orders + "/" + revised.id;
  const oldToken = randomBytes(32).toString("base64url");
  assert.equal((await request(revisedPath + "/share", "PUT", owner, shareBody(oldToken), version(revised))).status, 200);
  assert.equal((await request(revisedPath, "PUT", owner, { ...order, note: "Nova versão" }, version(await current(revisedPath)))).status, 200);
  assert.equal((await request(publicPath + "/view", "POST", undefined, { document, token: oldToken })).status, 404);
  const newToken = randomBytes(32).toString("base64url");
  assert.equal((await request(revisedPath + "/share", "PUT", owner, shareBody(newToken), version(await current(revisedPath)))).status, 200);
  assert.equal((await request(publicPath + "/respond", "POST", undefined, { document, token: newToken, decision: "DECLINED" })).status, 200);
  const declined = await current(revisedPath);
  assert.equal(declined.quoteShare.decision, "DECLINED");
  assert.equal((await request(revisedPath + "/convert", "POST", owner, undefined, version(declined))).status, 409);
  assert.equal((await request(revisedPath + "/invoice-draft", "POST", owner, undefined, version(declined))).status, 409);
  assert.equal((await request("/boletos/quote/" + revised.id, "POST", owner, settlement)).status, 404);
  assert.equal((await request(revisedPath + "/share", "DELETE", owner, undefined, version(declined))).status, 200);
  assert.equal((await request(publicPath + "/view", "POST", undefined, { document, token: newToken })).status, 404);
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
  const listing = await request("/platform/companies?page=1", "GET", platform);
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get("Cache-Control"), "no-store");
  assert.ok((await listing.json()).items.some((item: { id: string }) => item.id === company.id));
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
  const municipalRegistration = "12345678";
  await prisma.organization.update({ where: { id: a.id }, data: { cityIbgeCode: "3550308", municipalRegistration } });
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
  const record = await prisma.preparedDps.findUniqueOrThrow({
    where: { organizationId_environment_id: { organizationId: a.id, environment: "HOMOLOGATION", id: prepared.idDps } },
  });
  const identity = validateDps(Buffer.from(record.signedXml));
  assert.equal(identity.cnpj, a.cnpj);
  assert.equal(identity.id, prepared.idDps);
  assert.match(Buffer.from(record.signedXml).toString("utf8"), /<IM>12345678<\/IM>/);
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
  const context = await (await request(path, "GET", owner)).json();
  assert.equal(context.prepared.current, true);
  assert.equal(context.hasIssuerMunicipalRegistration, true);
  const withoutRegistration = await request(path, "POST", writer, { ...data, nDPS: "2", omitIssuerMunicipalRegistration: true }, headers);
  assert.equal(withoutRegistration.status, 201, await withoutRegistration.clone().text());
  const { idDps: withoutRegistrationId } = await withoutRegistration.json();
  const withoutRegistrationRecord = await prisma.preparedDps.findUniqueOrThrow({
    where: { organizationId_environment_id: { organizationId: a.id, environment: "HOMOLOGATION", id: withoutRegistrationId } },
  });
  assert.doesNotMatch(Buffer.from(withoutRegistrationRecord.signedXml).toString("utf8"), /<IM>/);
  assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: a.id } })).municipalRegistration, municipalRegistration);
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

test("the homologation panel reserves a DPS once and only its company owner can reconcile and download it", async (t) => {
  const authority = testAuthority(true);
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root, authority.intermediate);
  const timestamp = "2026-11-09T12:00:00-03:00";
  const envelope = { tipoAmbiente: 2, versaoAplicativo: "SEFIN sintetica", dataHoraProcessamento: timestamp };
  let sentXml: Buffer | undefined;
  let posted = 0;
  let lookups = 0;
  let lookupBroken = false;
  let note: { idDps: string; accessKey: string; xml: string } | undefined;
  const transport: HomologationTransportProvider = async (_binding, _sealed, identity, use) => use({
    identity,
    async request(method, path, body) {
      if (method === "POST") {
        assert.equal(path, "/nfse");
        assert.ok(body);
        sentXml = gunzipSync(Buffer.from(body.dpsXmlGZipB64, "base64"));
        posted++;
        throw new Error("Resposta de teste perdida após envio");
      }
      if (path.startsWith("/dps/")) {
        lookups++;
        if (lookupBroken) return { status: 200, body: { chaveAcesso: note?.accessKey } };
        if (note) return { status: 200, body: { ...envelope, idDps: note.idDps, chaveAcesso: note.accessKey } };
        return { status: 404, body: { tipoAmbiente: 0, dataHoraProcessamento: timestamp, erro: { codigo: "E2404" } } };
      }
      assert.ok(note);
      assert.equal(path, "/nfse/" + note.accessKey);
      return { status: 200, body: { ...envelope, chaveAcesso: note.accessKey, nfseXmlGZipB64: gzipSync(note.xml).toString("base64") } };
    },
  });
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t, vault, undefined, transport);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const { pfx, password: passphrase } = authority.issue(a.cnpj, { leafOnly: true });
  const uploaded = await request("/certificates", "PUT", owner, { pfx: pfx.toString("base64"), password: passphrase }, {
    "If-Match": '"missing"',
  });
  assert.equal(uploaded.status, 201);
  const certificate = await prisma.fiscalCertificate.findUniqueOrThrow({ where: { organizationId: a.id } });
  await assert.rejects(vault.withHomologationTransport(
    { organizationId: a.id, version: certificate.version }, certificate.sealed,
    { cnpj: a.cnpj, fingerprint: certificate.fingerprint }, (client) => client.request("GET", "/fora-do-contrato"),
  ), { code: "invalid-operation" });
  await prisma.organization.update({ where: { id: a.id }, data: { cityIbgeCode: "3550308" } });
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  const draft = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, serviceDescription: "Serviço de teste",
    amount: "1.00", idempotencyKey: randomUUID(),
  } });
  const draftPath = "/invoices/" + draft.id + "/dps";
  const prepared = await request(draftPath, "POST", writer, {
    serie: "1", nDPS: "1", dCompet: "2026-11-01", opSimpNac: "2", regEspTrib: "0",
    cLocPrestacao: "3550308", cTribNac: "010101", tpRetISSQN: "1", totTrib: { indTotTrib: "0" },
  }, { "If-Match": '"' + draft.updatedAt.toISOString() + '"' });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { idDps } = await prepared.json();
  const path = draftPath + "/" + idDps + "/homologation";
  const confirm = { confirmTest: true };
  assert.equal((await request(path, "GET", other)).status, 404);
  assert.equal((await request(path, "POST", other, confirm)).status, 404);
  assert.equal((await request(path, "POST", writer, confirm)).status, 403);
  assert.equal((await request(path, "POST", owner, { confirmTest: false })).status, 400);
  assert.equal((await (await request(path, "GET", owner)).json()).status, "READY");
  const attempts = await Promise.all([
    request(path, "POST", owner, confirm), request(path, "POST", owner, confirm),
  ]);
  for (const response of attempts) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, "PENDING");
  }
  assert.equal(posted, 1);
  assert.ok(sentXml);
  const pending = await request(path + "/reconcile", "POST", owner);
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).status, "PENDING");

  const key = loadHomologationSigningKey(pfx, passphrase);
  const accessKey = "355030822" + a.cnpj + "0".repeat(27);
  const embeddedDps = sentXml.toString("utf8").replace(/^<\?xml[^?]+\?>/, "");
  const unsignedNfse = '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS' + accessKey + '">' +
    "<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>1</nNFSe>" +
    "<xTribNac>Teste</xTribNac><verAplic>Teste</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>" +
    "<dhProc>" + timestamp + "</dhProc><nDFSe>1</nDFSe><emit><CNPJ>" + a.cnpj + "</CNPJ><xNome>Empresa de teste</xNome>" +
    "<enderNac><xLgr>Rua de teste</xLgr><nro>1</nro><xBairro>Teste</xBairro><cMun>3550308</cMun><UF>SP</UF><CEP>01000000</CEP></enderNac>" +
    "</emit><valores><vLiq>1.00</vLiq></valores>" + embeddedDps + "</infNFSe></NFSe>";
  const canonical = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const signer = new SignedXml({
    privateKey: key.privateKey, publicCert: key.publicCert, canonicalizationAlgorithm: canonical,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signer.addReference({ xpath: "//*[local-name(.)='infNFSe']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", canonical] });
  signer.computeSignature(unsignedNfse, { location: { reference: "/*", action: "append" } });
  const matchingXml = signer.getSignedXml();
  note = { idDps, accessKey, xml: matchingXml.replace("Serviço de teste", "Outro serviço") };
  const reconcilePath = path + "/reconcile";
  assert.equal((await request(reconcilePath, "POST", other, { accessKey })).status, 404);
  assert.equal((await request(reconcilePath, "POST", writer, { accessKey })).status, 403);
  const mismatched = await request(reconcilePath, "POST", owner, { accessKey });
  assert.equal(mismatched.status, 422);
  assert.equal((await mismatched.json()).code, "response-mismatch");
  assert.equal((await (await request(path, "GET", owner)).json()).status, "PENDING");
  assert.equal((await request(path + "/xml", "GET", owner)).status, 404);
  note.xml = matchingXml;
  lookupBroken = true;
  assert.equal((await request(reconcilePath, "POST", owner)).status, 422);
  const previousLookups = lookups;
  const reconciled = await request(reconcilePath, "POST", owner, { accessKey });
  assert.equal(lookups, previousLookups);
  assert.equal(reconciled.status, 200, await reconciled.clone().text());
  const result = await reconciled.json();
  assert.equal(result.status, "AUTHORIZED");
  assert.equal(result.accessKey, accessKey);
  assert.equal(result.homologationXml, undefined);
  const replay = await request(path, "POST", owner, confirm);
  assert.deepEqual(await replay.json(), result);
  assert.equal(posted, 1);
  const context = await (await request(draftPath, "GET", owner)).json();
  assert.deepEqual(context.homologation, [result]);
  assert.equal((await (await request(draftPath, "GET", writer)).json()).homologation, null);
  const download = await request(path + "/xml", "GET", owner);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition") ?? "", /attachment; filename="nfse-teste-/);
  assert.equal(await download.text(), note.xml);
  assert.equal((await request(path + "/xml", "GET", other)).status, 404);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status, "DRAFT");
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, entity: "PREPARED_DPS", entityId: idDps, action: "UPDATED", actorUserId: shared.id },
  }), 2);
});

test("production preparation is isolated and a released DPS is transmitted at most once and reconciled", async (t) => {
  const authority = testAuthority();
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root);
  const timestamp = "2026-11-11T12:00:00-03:00";
  const envelope = { tipoAmbiente: 1, versaoAplicativo: "SEFIN sintetica", dataHoraProcessamento: timestamp };
  let config!: ProductionIssuanceConfig;
  let sent: Buffer | undefined;
  let posted = 0;
  let calls = 0;
  let note: { xml: string; accessKey: string } | undefined;
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t, vault, undefined, undefined, undefined, (cnpj, secondCnpj) => {
    config = {
      cnpjs: new Set([cnpj, secondCnpj]),
      transport: async (_binding, _sealed, identity, use, approval) => use({
        identity,
        async request(method, path, body) {
          calls++;
          if (method === "POST") {
            assert.equal(identity.cnpj, cnpj);
            assert.equal(path, "/nfse");
            assert.ok(approval && body);
            posted++;
            sent = gunzipSync(Buffer.from(body.dpsXmlGZipB64, "base64"));
            throw new Error("Resposta sintética perdida após o envio");
          }
          if (path.startsWith("/dps/")) {
            if (note) return { status: 200, body: { ...envelope, chaveAcesso: note.accessKey } };
            return { status: 404, body: { tipoAmbiente: 0, dataHoraProcessamento: timestamp, erro: { codigo: "E2404" } } };
          }
          assert.ok(note);
          assert.equal(path, "/nfse/" + note.accessKey);
          assert.equal(approval, undefined);
          return { status: 200, body: { ...envelope, chaveAcesso: note.accessKey, nfseXmlGZipB64: gzipSync(note.xml).toString("base64") } };
        },
      }),
    };
    return config;
  });
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const { pfx, password: passphrase } = authority.issue(a.cnpj);
  const uploaded = await request("/certificates", "PUT", owner, { pfx: pfx.toString("base64"), password: passphrase }, { "If-Match": '"missing"' });
  assert.equal(uploaded.status, 201);
  await prisma.organization.update({ where: { id: a.id }, data: { cityIbgeCode: "3550308" } });
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: a.id } });
  const service = await prisma.service.create({
    data: { ...services, organizationId: a.id, nationalServiceCode: "140101", defaultAmount: "123.45" },
  });
  const draft = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, serviceId: service.id, serviceDescription: "Manutenção de teste",
    amount: "10.00", idempotencyKey: randomUUID(),
  } });
  const draftPath = "/invoices/" + draft.id;
  const path = draftPath + "/production-dps";
  const header = { "If-Match": '"' + draft.updatedAt.toISOString() + '"' };
  const fiscal = {
    serie: "101", nDPS: "1", dCompet: "2026-11-01", opSimpNac: "3", regApTribSN: "1", regEspTrib: "0",
    cLocPrestacao: "3550308", cTribNac: "140101", tpRetISSQN: "1", totTrib: { pTotTribSN: "6.00" },
  };
  assert.equal((await request(path, "GET", other)).status, 404);
  assert.equal((await request(path, "POST", writer, fiscal, header)).status, 403);
  const secondCnpj = b.cnpj.replace(/[./-]/g, "");
  const secondCertificate = authority.issue(secondCnpj);
  const secondUpload = await request("/certificates", "PUT", other, {
    pfx: secondCertificate.pfx.toString("base64"), password: secondCertificate.password,
  }, { "If-Match": '"missing"' });
  assert.equal(secondUpload.status, 201);
  await prisma.organization.update({ where: { id: b.id }, data: { cityIbgeCode: "3550308" } });
  const secondCustomer = await prisma.customer.create({ data: { ...customers, organizationId: b.id } });
  const secondDraft = await prisma.invoice.create({ data: {
    organizationId: b.id, customerId: secondCustomer.id, serviceDescription: "Serviço da empresa B",
    amount: "25.00", idempotencyKey: randomUUID(),
  } });
  const secondDraftPath = "/invoices/" + secondDraft.id;
  const secondPath = secondDraftPath + "/production-dps";
  assert.equal((await (await request(secondDraftPath + "/dps", "GET", other)).json()).productionEnabled, true);
  assert.equal((await request(secondPath, "GET", owner)).status, 404);
  const secondProduction = await request(secondPath, "POST", other, fiscal, { "If-Match": '"' + secondDraft.updatedAt.toISOString() + '"' });
  assert.equal(secondProduction.status, 201, await secondProduction.clone().text());
  const secondPrepared = await secondProduction.json();
  assert.equal(secondPrepared.transmission, "BLOCKED");
  assert.equal(secondPrepared.idDps.slice(11, 25), secondCnpj);
  assert.equal((await request(path, "POST", owner, { ...fiscal, omitIssuerMunicipalRegistration: true }, header)).status, 400);
  const homologated = await request(draftPath + "/dps", "POST", owner, fiscal, header);
  assert.equal(homologated.status, 201, await homologated.clone().text());
  const production = await request(path, "POST", owner, { ...fiscal, rememberFiscalData: true, buyerAddress: {
    municipality: "3550308", zipCode: "01000000", street: "Rua de teste", number: "1", neighborhood: "Centro",
  } }, header);
  assert.equal(production.status, 201, await production.clone().text());
  const prepared = await production.json();
  assert.equal(prepared.transmission, "BLOCKED");
  assert.equal((await homologated.json()).idDps, prepared.idDps);
  assert.equal(await prisma.preparedDps.count({ where: { organizationId: a.id, id: prepared.idDps } }), 2);
  const defaults = (await (await request(path, "GET", owner)).json()).fiscalDefaults;
  assert.equal(defaults.serie, fiscal.serie);
  assert.equal(defaults.nDPS, String(Number(fiscal.nDPS) + 1));
  assert.deepEqual(defaults.totTrib, fiscal.totTrib);
  assert.equal(defaults.buyerAddress.zipCode, "01000000");
  assert.equal(defaults.dCompet, undefined);
  assert.equal((await (await request(draftPath + "/dps", "GET", owner)).json()).fiscalDefaults, undefined);
  const nextDraft = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: customer.id, serviceId: service.id, serviceDescription: "Descrição nova",
    amount: "25.00", idempotencyKey: randomUUID(),
  } });
  const nextContext = await (await request("/invoices/" + nextDraft.id + "/production-dps", "GET", owner)).json();
  assert.deepEqual(nextContext.fiscalDefaults, defaults);
  assert.equal(nextContext.description, "Descrição nova");
  assert.equal(nextContext.amount, "25.00");
  const anotherCustomer = await prisma.customer.create({
    data: { ...customers, federalTaxId: "11111111111", organizationId: a.id },
  });
  const unrelatedDraft = await prisma.invoice.create({ data: {
    organizationId: a.id, customerId: anotherCustomer.id, serviceId: service.id, serviceDescription: draft.serviceDescription,
    amount: draft.amount, idempotencyKey: randomUUID(),
  } });
  assert.equal((await (await request("/invoices/" + unrelatedDraft.id + "/production-dps", "GET", owner)).json()).fiscalDefaults, undefined);
  assert.equal(await prisma.registrationAuditEvent.count({ where: { organizationId: a.id, entity: "DPS_FISCAL_TEMPLATE" } }), 1);
  const submit = path + "/" + prepared.idDps + "/submit";
  const confirm = { confirmProduction: true };
  assert.equal((await request(submit, "POST", owner, confirm)).status, 423);
  config.approval = { dpsId: prepared.idDps, sha256: "0".repeat(64) };
  assert.equal((await request(submit, "POST", owner, confirm)).status, 423);
  assert.equal(calls, 0);
  config.approval = { dpsId: prepared.idDps, sha256: prepared.sha256 };
  assert.equal((await request(secondPath + "/" + secondPrepared.idDps + "/submit", "POST", other, confirm)).status, 423);
  assert.equal(calls, 0);
  const submissions = await Promise.all([request(submit, "POST", owner, confirm), request(submit, "POST", owner, confirm)]);
  for (const response of submissions) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).transmission, "PENDING");
  }
  assert.equal(posted, 1);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status, "PROCESSING");
  assert.equal((await request(draftPath, "DELETE", owner, undefined, header)).status, 404);
  assert.equal((await request(path, "GET", owner)).status, 200);
  assert.ok(sent);
  const accessKey = "355030822" + a.cnpj + "0".repeat(27);
  const dps = sent.toString("utf8").replace(/^<\?xml[^?]+\?>/, "");
  const unsigned = '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS' + accessKey + '">' +
    "<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>38</nNFSe><cStat>100</cStat><dhProc>" +
    timestamp + "</dhProc><emit><CNPJ>" + a.cnpj + "</CNPJ><xNome>Empresa A</xNome></emit>" +
    "<valores><vLiq>10.00</vLiq></valores>" + dps + "</infNFSe></NFSe>";
  const key = loadHomologationSigningKey(pfx, passphrase);
  const canonical = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const signer = new SignedXml({
    privateKey: key.privateKey, publicCert: key.publicCert, canonicalizationAlgorithm: canonical,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signer.addReference({ xpath: "//*[local-name(.)='infNFSe']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", canonical] });
  signer.computeSignature(unsigned, { location: { reference: "/*", action: "append" } });
  note = { xml: signer.getSignedXml(), accessKey };
  config.approval = undefined;
  const recovered = await request(path + "/" + prepared.idDps + "/reconcile", "POST", owner, {});
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal((await recovered.json()).transmission, "AUTHORIZED");
  const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(saved.status, "AUTHORIZED");
  assert.equal(saved.accessKey, accessKey);
  assert.equal(saved.xmlResponse, note.xml);
  assert.equal(posted, 1);
  const downloadPath = "/customers/" + customer.id + "/invoices/" + draft.id + "/nfse.xml";
  const download = await request(downloadPath, "GET", owner);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), note.xml);
  assert.equal((await request(downloadPath, "GET", other)).status, 404);
  const pdfPath = downloadPath.replace(/\.xml$/, ".pdf");
  const pdf = await request(pdfPath, "GET", owner);
  assert.equal(pdf.status, 200, await pdf.clone().text().then((body) => body.slice(0, 60)));
  assert.match(pdf.headers.get("Content-Type") ?? "", /^application\/pdf\b/);
  assert.equal(pdf.headers.get("Cache-Control"), "no-store");
  assert.match(pdf.headers.get("Content-Disposition") ?? "", /attachment;.*danfse-/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await request(pdfPath, "GET")).status, 401);
  assert.equal((await request(pdfPath, "GET", other)).status, 404);
  assert.equal((await request(pdfPath.replace(customer.id, anotherCustomer.id), "GET", owner)).status, 404);
  assert.equal((await request(pdfPath.replace(draft.id, nextDraft.id), "GET", owner)).status, 404);
  const reopened = await request(path, "GET", owner);
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).prepared.transmission, "AUTHORIZED");
  await prisma.dpsFiscalTemplate.deleteMany({ where: { organizationId: a.id } });
  const fromHistory = await (await request("/invoices/" + nextDraft.id + "/production-dps", "GET", owner)).json();
  assert.equal(fromHistory.fiscalDefaults.cTribNac, fiscal.cTribNac);
  assert.equal(fromHistory.fiscalDefaults.buyerAddress.zipCode, "01000000");
  assert.deepEqual(fromHistory.fiscalDefaults.totTrib, fiscal.totTrib);
  const issuedPath = "/invoices/issued?limit=1";
  const issued = await request(issuedPath, "GET", owner);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("Cache-Control"), "no-store");
  const listed = await issued.json();
  assert.deepEqual(listed.items.map(({ id, customerId, hasXml, status }: Record<string, unknown>) =>
    ({ id, customerId, hasXml, status })), [{ id: draft.id, customerId: customer.id, hasXml: true, status: "AUTHORIZED" }]);
  assert.equal(listed.hasNext, false);
  assert.equal(Object.hasOwn(listed.items[0], "xmlResponse"), false);
  assert.equal((await request(issuedPath, "GET")).status, 401);
  assert.equal((await request(issuedPath, "GET", owner, undefined, { "X-FiscalFlow-Context": b.id })).status, 409);
  assert.deepEqual(await (await request(issuedPath, "GET", other)).json(), { items: [], hasNext: false });
  await prisma.customer.update({ where: { id: customer.id }, data: { archivedAt: new Date() } });
  assert.equal((await (await request(issuedPath, "GET", owner)).json()).items[0].id, draft.id);
  assert.equal((await request(pdfPath, "GET", owner)).status, 200);
});

test("a platform owner releases a subscriber once and can stop new production submissions", async (t) => {
  const authority = testAuthority();
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root);
  const posted: string[] = [];
  let pausedDps: string | undefined;
  let signalLookup!: () => void;
  let resumeLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
  const continueLookup = new Promise<void>((resolve) => { resumeLookup = resolve; });
  const { a, b, shared, ownerB, prisma, request, login } = await setup(t, vault, undefined, undefined, undefined, (_cnpj, subscriberCnpj) => ({
    cnpjs: new Set(),
    transport: async (binding, _sealed, identity, use, approval) => use({
      identity,
      async request(method, path, body) {
        assert.equal(binding.organizationId, b.id);
        assert.equal(identity.cnpj, subscriberCnpj);
        if (method === "POST") {
          assert.equal(path, "/nfse");
          assert.ok(body && approval);
          const signed = gunzipSync(Buffer.from(body.dpsXmlGZipB64, "base64"));
          assert.equal(approval.sha256, createHash("sha256").update(signed).digest("hex"));
          posted.push(approval.dpsId);
          throw new Error("Resposta sintética perdida após o envio");
        }
        assert.match(path, /^\/dps\//);
        if (pausedDps && path.endsWith(pausedDps)) {
          signalLookup();
          await continueLookup;
        }
        return { status: 404, body: { tipoAmbiente: 0, dataHoraProcessamento: "2026-11-11T12:00:00-03:00", erro: { codigo: "E2404" } } };
      },
    }),
  }));
  await prisma.membership.update({
    where: { userId_organizationId: { organizationId: a.id, userId: shared.id } }, data: { platformOwner: true },
  });
  const platform = await login(shared.email, a.cnpj);
  const subscriber = await login(ownerB.email, b.cnpj);
  const adminPath = "/platform/companies/" + b.id + "/issuance";
  const enable = { enabled: true, accredited: true };
  assert.equal((await request(adminPath, "PATCH", subscriber, enable)).status, 403);
  assert.equal((await request(adminPath, "PATCH", platform, { enabled: true })).status, 400);
  assert.equal((await request("/platform/companies/" + a.id + "/issuance", "PATCH", platform, enable)).status, 404);
  const missing = await request(adminPath, "PATCH", platform, enable);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, "valid-certificate-required");

  const { pfx, password: passphrase } = authority.issue(b.cnpj.replace(/[./-]/g, ""));
  assert.equal((await request("/certificates", "PUT", subscriber, { pfx: pfx.toString("base64"), password: passphrase },
    { "If-Match": '"missing"' })).status, 201);
  const cert = await prisma.fiscalCertificate.findUniqueOrThrow({ where: { organizationId: b.id }, select: { validUntil: true } });
  await prisma.fiscalCertificate.update({ where: { organizationId: b.id }, data: { validUntil: new Date(Date.now() - 1000) } });
  assert.equal((await request(adminPath, "PATCH", platform, enable)).status, 409);
  await prisma.fiscalCertificate.update({ where: { organizationId: b.id }, data: { validUntil: cert.validUntil } });

  await prisma.organization.update({ where: { id: b.id }, data: { cityIbgeCode: "3550308" } });
  const customer = await prisma.customer.create({ data: { ...customers, organizationId: b.id } });
  const otherCustomer = await prisma.customer.create({
    data: { ...customers, name: "Outro tomador", federalTaxId: "33000000000001", organizationId: b.id },
  });
  const service = await prisma.service.create({ data: { ...services, organizationId: b.id, nationalServiceCode: "140101", defaultAmount: "12.34" } });
  const drafts = await Promise.all(["Primeiro serviço", "Segundo serviço", "Terceiro serviço"].map((serviceDescription, index) =>
    prisma.invoice.create({ data: {
      organizationId: b.id, customerId: index === 1 ? otherCustomer.id : customer.id, serviceId: index === 2 ? null : service.id,
      serviceDescription, amount: "12.34", idempotencyKey: randomUUID(),
    } })));
  const prepPath = (id: string) => "/invoices/" + id + "/production-dps";
  assert.equal((await request(prepPath(drafts[0].id), "GET", subscriber)).status, 404);
  for (let i = 0; i < 2; i++) {
    const granted = await request(adminPath, "PATCH", platform, enable);
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.deepEqual((await granted.json()).issuance, { mode: "company", certificateValid: true, available: true });
  }
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: b.id, actorUserId: shared.id, action: "PRODUCTION_ISSUANCE_ENABLED" },
  }), 1);
  assert.equal((await request(prepPath(drafts[0].id), "GET", platform)).status, 404);

  const fiscal = {
    serie: "101", dCompet: "2026-11-01", opSimpNac: "3", regApTribSN: "1", regEspTrib: "0",
    cLocPrestacao: "3550308", cTribNac: "140101", tpRetISSQN: "1", totTrib: { pTotTribSN: "6.00" },
  };
  const signed = [];
  for (const [index, draft] of drafts.entries()) {
    if (index > 0) {
      const suggestion = await (await request(prepPath(draft.id), "GET", subscriber)).json();
      if (index === 1) {
        assert.equal(suggestion.hasLinkedService, true);
        assert.equal(suggestion.fiscalDefaults.nDPS, "2");
        assert.equal(suggestion.fiscalDefaults.cTribNac, fiscal.cTribNac);
        assert.equal(suggestion.fiscalDefaults.buyerAddress, undefined);
        assert.deepEqual(suggestion.fiscalDefaults.totTrib, { valuesPerInvoice: true });
        assert.equal((await request(prepPath(draft.id), "GET", platform)).status, 404);
      } else {
        assert.equal(suggestion.fiscalDefaults, undefined);
        assert.deepEqual(suggestion.numbering, { serie: "101", nDPS: "3" });
      }
    }
    const prep = await request(prepPath(draft.id), "POST", subscriber, {
      ...fiscal, nDPS: String(index + 1),
      ...(index === 0 && { rememberFiscalData: true, rememberServiceFiscalData: true,
        totTrib: { vTotTrib: { federal: "1.00", estadual: "0.00", municipal: "0.50" } } }),
    },
      { "If-Match": '"' + draft.updatedAt.toISOString() + '"' });
    assert.equal(prep.status, 201, await prep.clone().text());
    const { idDps, transmission } = await prep.json();
    assert.equal(transmission, "RELEASED");
    signed.push({ idDps, path: prepPath(draft.id) + "/" + idDps });
  }
  const submit = (path: string, cookie = subscriber) => request(path + "/submit", "POST", cookie, { confirmProduction: true });
  assert.equal((await submit(signed[0].path, platform)).status, 404);
  for (const note of signed.slice(0, 2)) {
    const result = await submit(note.path);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).transmission, "PENDING");
  }
  assert.equal((await submit(signed[0].path)).status, 200);
  assert.deepEqual(posted, signed.slice(0, 2).map(({ idDps }) => idDps));

  pausedDps = signed[2].idDps;
  const inFlight = submit(signed[2].path);
  try {
    await Promise.race([lookupStarted, inFlight.then((response) => assert.fail("Submission finished before lookup: " + response.status))]);
    const blocked = await request(adminPath, "PATCH", platform, { enabled: false });
    assert.equal(blocked.status, 200);
    assert.equal((await blocked.json()).issuance.mode, "disabled");
  } finally {
    resumeLookup();
  }
  assert.equal((await inFlight).status, 423);
  assert.equal((await submit(signed[2].path)).status, 423);
  assert.equal(posted.length, 2);
  assert.equal((await request(prepPath(drafts[2].id), "GET", subscriber)).status, 404);
  assert.equal((await (await request(prepPath(drafts[0].id), "GET", subscriber)).json()).prepared.transmission, "PENDING");
  const reconciled = await request(signed[0].path + "/reconcile", "POST", subscriber, {});
  assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json()).transmission, "PENDING");
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: b.id, actorUserId: shared.id, action: "PRODUCTION_ISSUANCE_DISABLED" },
  }), 1);
});

test("production lookup uses only the enabled company's A1 and leaves its invoices untouched", async (t) => {
  const authority = testAuthority();
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root);
  const calls: { organizationId: string; cnpj: string; accessKey: string }[] = [];
  const summary = { number: "38", status: "100", processedAt: "2026-11-06T13:11:29.000Z" };
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(t, vault, undefined, undefined, (cnpj) => ({
    cnpj,
    async lookup(binding, _sealed, identity, accessKey) {
      calls.push({ organizationId: binding.organizationId, cnpj: identity.cnpj, accessKey });
      return summary;
    },
  }));
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const writer = await login(operator.email, a.cnpj);
  const accessKey = "355030822" + a.cnpj + "0".repeat(27);
  const path = "/certificates/production-lookup";
  const payload = { accessKey };
  assert.equal((await request(path, "POST", other, payload)).status, 404);
  assert.equal((await request(path, "POST", writer, payload)).status, 403);
  assert.equal((await request(path, "POST", owner, { accessKey: "355030822" + "0".repeat(41) })).status, 422);
  assert.equal((await request(path, "POST", owner, payload)).status, 409);
  const { pfx, password: passphrase } = authority.issue(a.cnpj);
  const uploaded = await request("/certificates", "PUT", owner, { pfx: pfx.toString("base64"), password: passphrase }, { "If-Match": '"missing"' });
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).productionLookupEnabled, true);
  const result = await request(path, "POST", owner, payload);
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), summary);
  assert.deepEqual(calls, [{ organizationId: a.id, cnpj: a.cnpj, accessKey }]);
  assert.equal(await prisma.invoice.count({ where: { organizationId: a.id } }), 0);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, actorUserId: shared.id, entity: "FISCAL_CERTIFICATE", action: "PRODUCTION_NFSE_LOOKUP" },
  }), 1);
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

test("invoice CNPJ lookup isolates customers and saves new customers atomically with the draft", async (t) => {
  const directoryRequests: string[] = [];
  const existingCnpj = "11222333000181";
  const newCnpj = "11444777000161";
  const manualCnpj = "12ABC34501DE35";
  const directory: PublicCnpjLookup = async (cnpj) => {
    directoryRequests.push(cnpj);
    return cnpj === newCnpj ? { source: "public", name: "Nome público" } : { source: "unavailable" };
  };
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(
    t, undefined, undefined, undefined, undefined, undefined, directory,
  );
  const [writer, other, viewer] = await Promise.all([
    login(operator.email, a.cnpj), login(ownerB.email, b.cnpj), login(shared.email, b.cnpj),
  ]);
  const [customerA, customerB, foreignService] = await Promise.all([
    prisma.customer.create({ data: { organizationId: a.id, federalTaxId: existingCnpj, name: "Cadastro da empresa A" } }),
    prisma.customer.create({ data: { organizationId: b.id, federalTaxId: existingCnpj, name: "Cadastro da empresa B" } }),
    prisma.service.create({ data: { ...services, defaultAmount: "123.45", organizationId: b.id } }),
  ]);
  const lookup = (cnpj: string, cookie?: string) => request("/invoices/customer-lookup", "POST", cookie, { cnpj });
  const key = { "Idempotency-Key": randomUUID() };
  const post = (data: object, headers = { "Idempotency-Key": randomUUID() }) => request(
    "/invoices", "POST", writer, { amount: "10,00", serviceDescription: "Serviço", ...data }, headers,
  );
  assert.equal((await lookup(existingCnpj)).status, 401);
  assert.equal((await lookup(existingCnpj, viewer)).status, 403);
  assert.deepEqual(await (await lookup(maskCnpj(existingCnpj), writer)).json(), {
    source: "registered", customerId: customerA.id, name: customerA.name,
  });
  assert.deepEqual(await (await lookup(existingCnpj, other)).json(), {
    source: "registered", customerId: customerB.id, name: customerB.name,
  });
  const invalid = await lookup("11222333000180", writer);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid-cnpj");
  assert.deepEqual(directoryRequests, []);

  assert.deepEqual(await (await lookup(newCnpj, writer)).json(), { source: "public", name: "Nome público" });
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: newCnpj } }), 0);
  const input = { customerCnpj: maskCnpj(newCnpj), customerName: "Nome conferido" };
  assert.equal((await post({ ...input, serviceId: foreignService.id })).status, 404);
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: newCnpj } }), 0);
  const attempts = await Promise.all([post(input, key), post(input, key)]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 201]);
  const [saved, replay] = await Promise.all(attempts.map((result) => result.json()));
  assert.deepEqual(saved, replay);
  assert.equal(saved.status, "DRAFT");
  assert.deepEqual(saved.customer, { name: "Nome conferido" });
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: newCnpj } }), 1);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, entity: "CUSTOMER", entityId: saved.customerId, actorUserId: operator.id, action: "CREATED" },
  }), 1);
  assert.equal((await post({ customerCnpj: manualCnpj, customerName: "Nome manual" }, key)).status, 409);
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: manualCnpj } }), 0);
  assert.deepEqual(await (await lookup(newCnpj, other)).json(), { source: "public", name: "Nome público" });
  assert.deepEqual(await (await lookup(manualCnpj, writer)).json(), { source: "unavailable" });
  assert.equal((await post({ customerCnpj: manualCnpj, customerName: "Nome manual" })).status, 201);
  assert.deepEqual(directoryRequests, [newCnpj, newCnpj, manualCnpj]);

  const existing = await post({ customerCnpj: existingCnpj, customerName: "Outra razão social" });
  assert.equal(existing.status, 201);
  assert.deepEqual((await existing.json()).customer, { name: customerA.name });
  await prisma.customer.update({ where: { id: customerA.id }, data: { archivedAt: new Date() } });
  const archived = await lookup(existingCnpj, writer);
  assert.equal(archived.status, 409);
  assert.equal((await archived.json()).code, "customer-archived");
  assert.equal((await post({ customerCnpj: existingCnpj, customerName: customerA.name })).status, 409);
});

test("invoice CPF lookup stays within the company and saves a named customer with the draft", async (t) => {
  const directory = t.mock.fn(async () => ({ source: "unavailable" as const }));
  const { a, b, shared, ownerB, operator, prisma, request, login } = await setup(
    t, undefined, undefined, undefined, undefined, undefined, directory,
  );
  const [writer, other, viewer] = await Promise.all([
    login(operator.email, a.cnpj), login(ownerB.email, b.cnpj), login(shared.email, b.cnpj),
  ]);
  const cpf = "52998224725";
  const formattedCpf = "529.982.247-25";
  const foreign = await prisma.customer.create({ data: { organizationId: b.id, federalTaxId: cpf, name: "Cliente da empresa B" } });
  const lookup = (document: string, cookie?: string) => request("/invoices/customer-lookup", "POST", cookie, { cpf: document });
  const save = (data: object, idempotencyKey = randomUUID()) => request(
    "/invoices", "POST", writer, { amount: "10,00", serviceDescription: "Serviço de teste", ...data },
    { "Idempotency-Key": idempotencyKey },
  );
  assert.equal((await lookup(formattedCpf)).status, 401);
  assert.equal((await lookup(formattedCpf, viewer)).status, 403);
  const invalid = await lookup("529.982.247-24", writer);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid-cpf");
  assert.equal((await save({ customerCpf: "529.982.247-24", customerName: "CPF inválido" })).status, 400);
  assert.equal((await save({ customerCpf: cpf, customerName: "   " })).status, 400);
  assert.deepEqual(await (await lookup(formattedCpf, writer)).json(), { source: "not-found" });
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: cpf } }), 0);
  assert.deepEqual(await (await lookup(cpf, other)).json(), {
    source: "registered", customerId: foreign.id, name: foreign.name,
  });

  const input = { customerCpf: formattedCpf, customerName: "Cliente da empresa A" };
  const key = randomUUID();
  const attempts = await Promise.all([save(input, key), save(input, key)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 201]);
  const [first, replay] = await Promise.all(attempts.map((result) => result.json()));
  assert.equal(first.status, "DRAFT");
  assert.deepEqual(first, replay);
  assert.notEqual(first.customerId, foreign.id);
  assert.deepEqual(first.customer, { name: input.customerName });
  assert.deepEqual(await (await lookup(cpf, writer)).json(), {
    source: "registered", customerId: first.customerId, name: input.customerName,
  });
  assert.equal(await prisma.customer.count({ where: { organizationId: a.id, federalTaxId: cpf } }), 1);
  assert.equal(await prisma.registrationAuditEvent.count({
    where: { organizationId: a.id, entity: "CUSTOMER", entityId: first.customerId, action: "CREATED" },
  }), 1);
  await prisma.customer.update({ where: { id: first.customerId }, data: { archivedAt: new Date() } });
  assert.equal((await lookup(formattedCpf, writer)).status, 409);
  assert.equal((await save(input)).status, 409);
  assert.equal(directory.mock.callCount(), 0);
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

test("extended registration profiles persist fiscal codes and contacts within the session company", async (t) => {
  const { a, b, shared, ownerB, prisma, request, login } = await setup(t);
  const [owner, other, viewer] = await Promise.all([
    login(shared.email, a.cnpj), login(ownerB.email, b.cnpj), login(shared.email, b.cnpj),
  ]);
  async function body(response: Response, status = 200) {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  const address = {
    zipCode: "01001-000", street: "Praça de demonstração", addressNumber: "100", addressComplement: "Sala 1",
    neighborhood: "Centro", cityName: "São Paulo", state: "SP", cityIbgeCode: "3550308",
  };
  const contacts = {
    contactName: "Atendimento de teste", financialContactName: "Financeiro de teste",
    financialContactEmail: "financeiro@example.test", financialContactPhone: "11999990000",
  };
  const company = await body(await request("/organizations/current", "PATCH", owner, {
    ...address, taxRegime: "SIMPLES_NACIONAL", simplesApportionment: "1", specialTaxRegime: "0",
    legalRepresentativeName: "Representante fictício", legalRepresentativeCpf: "529.982.247-25",
    legalRepresentativeEmail: "representante@example.test", legalRepresentativePhone: "1133330000",
  }));
  assert.equal(company.zipCode, "01001000");
  assert.equal(company.legalRepresentativeCpf, "52998224725");
  assert.equal(company.taxRegime, "SIMPLES_NACIONAL");
  const foreignCompany = await body(await request("/organizations/current", "GET", other));
  assert.equal(foreignCompany.taxRegime, null);
  assert.equal(foreignCompany.legalRepresentativeName, null);
  assert.equal((await request("/organizations/current", "PATCH", viewer, { taxRegime: "MEI" })).status, 403);
  assert.equal((await request("/organizations/current", "PATCH", owner, { taxRegime: "INVALID" })).status, 400);
  assert.equal((await request("/organizations/current", "PATCH", owner, { legalRepresentativeCpf: "52998224724" })).status, 400);

  const customer = await body(await request("/customers", "POST", owner, { ...customers, ...address, ...contacts }), 201);
  assert.equal(customer.financialContactEmail, contacts.financialContactEmail);
  assert.equal(customer.street, address.street);
  assert.equal((await request("/customers/" + customer.id, "GET", other)).status, 404);
  assert.equal((await request("/customers/" + customer.id, "PATCH", other, contacts)).status, 404);
  const updatedCustomer = await body(await request("/customers/" + customer.id, "PATCH", owner, { financialContactName: null }));
  assert.equal(updatedCustomer.financialContactName, null);
  assert.equal(updatedCustomer.financialContactEmail, contacts.financialContactEmail);
  assert.equal((await request("/customers/" + customer.id, "PATCH", owner, { financialContactEmail: "invalid" })).status, 400);

  const service = await body(await request("/services", "POST", owner, {
    ...services, nationalServiceCode: "14.01.01", municipalServiceCode: "009", nbsCode: "1.2002.90.00",
    ibsCbsCst: "000", ibsCbsClassCode: "000001", operationIndicator: "100301",
  }), 201);
  assert.equal(service.nationalServiceCode, "140101");
  assert.equal(service.nbsCode, "120029000");
  assert.equal((await request("/services/" + service.id, "GET", other)).status, 404);
  assert.equal((await request("/services/" + service.id, "PATCH", other, { nbsCode: "120029000" })).status, 404);
  assert.equal((await request("/services/" + service.id, "PATCH", owner, { ibsCbsCst: "200" })).status, 400);
  assert.equal((await request("/services/" + service.id, "PATCH", owner, { nbsCode: "123" })).status, 400);
  assert.equal((await request("/services", "POST", owner, { ...services, nationalServiceCode: "14.01" })).status, 400);
  const legacyService = await prisma.service.create({ data: {
    organizationId: a.id, ...services, defaultAmount: "123.45", nationalServiceCode: "14.01",
  } });
  const legacyUpdated = await body(await request("/services/" + legacyService.id, "PATCH", owner, { name: "Serviço legado preservado" }));
  assert.equal(legacyUpdated.nationalServiceCode, "14.01");
  assert.equal(legacyUpdated.nbsCode, null);
  const draft = await body(await request("/invoices", "POST", owner, {
    customerId: customer.id, serviceId: service.id, amount: "10.00", serviceDescription: "Teste de parâmetros",
  }, { "Idempotency-Key": randomUUID() }), 201);
  const context = await body(await request("/invoices/" + draft.id + "/dps", "GET", owner));
  assert.equal(context.nbsCode, service.nbsCode);
  assert.equal(context.issuerTaxRegime, "SIMPLES_NACIONAL");
  assert.equal(context.issuerSimplesApportionment, "1");
  assert.equal(context.issuerSpecialTaxRegime, "0");
  assert.deepEqual(context.customerAddress, {
    municipality: "3550308", zipCode: "01001000", street: address.street,
    number: address.addressNumber, complement: address.addressComplement, neighborhood: address.neighborhood,
  });

  const original = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id, organizationId: a.id }, select: dpsDraftFields });
  const { nbsCode: _nbs, ...oldService } = original.service!;
  const { taxRegime: _regime, simplesApportionment: _apportionment, specialTaxRegime: _special, ...oldOrganization } = original.organization;
  const oldCustomer = { name: original.customer.name, federalTaxId: original.customer.federalTaxId, archivedAt: original.customer.archivedAt };
  const before = createHash("sha256").update(JSON.stringify({ ...original, customer: oldCustomer, service: oldService, organization: oldOrganization })).digest("hex");
  assert.equal(productionSourceHash(original), before);

  const supplier = await body(await request("/commercial/suppliers", "POST", owner, {
    name: "Fornecedor fictício", tradeName: "Fornecedor Exemplo", ...address, ...contacts,
  }), 201);
  assert.equal(supplier.financialContactName, contacts.financialContactName);
  assert.equal(supplier.zipCode, "01001000");
  const account = await body(await request("/commercial/finance/entries", "POST", owner, {
    kind: "PAYABLE", description: "Conta de teste do fornecedor", amount: "10.00", dueOn: "2026-11-19", supplierId: supplier.id,
  }, { "Idempotency-Key": randomUUID() }), 201);
  assert.equal(account.supplier.financialContactEmail, contacts.financialContactEmail);
  assert.equal((await request("/commercial/suppliers/" + supplier.id, "GET", other)).status, 404);
  assert.equal((await request("/commercial/suppliers/" + supplier.id, "PATCH", other, contacts)).status, 404);
  const productInput = {
    sku: "PROFILE-TEST", name: "Produto fictício", description: "Produto para testes", unit: "UN", price: "10.00", cost: "5.00",
    supplierId: supplier.id, ncmCode: "8428.10.00", cfopCode: "5.102", icmsCst: "00",
    ibsCbsCst: "000", ibsCbsClassCode: "000001", ibsStateRate: "0,1000", ibsMunicipalRate: "0.0000", cbsRate: "0.9000",
  };
  const product = await body(await request("/commercial/products", "POST", owner, productInput), 201);
  assert.equal(product.ncmCode, "84281000");
  assert.equal(product.cfopCode, "5102");
  assert.equal(product.ibsStateRate, "0.1");
  assert.equal(product.cbsRate, "0.9");
  assert.equal((await request("/commercial/products/" + product.id, "PUT", other, { ...productInput, supplierId: null })).status, 404);
  assert.equal((await request("/commercial/products", "POST", other, { ...productInput, sku: "FOREIGN-SUPPLIER" })).status, 404);
  assert.equal((await request("/commercial/products/" + product.id, "PUT", owner, { ...productInput, cbsRate: "100.0001" })).status, 400);
  assert.equal((await request("/commercial/products/" + product.id, "PUT", owner, { ...productInput, ibsCbsCst: "200" })).status, 400);
  const listed = await body(await request("/commercial/products", "GET", owner));
  assert.equal(listed.items[0].supplier.id, supplier.id);
  assert.equal((await body(await request("/commercial/products", "GET", other))).items.length, 0);
  const changed = await body(await request("/services/" + service.id, "PATCH", owner, { nbsCode: null, ibsCbsClassCode: null, ibsCbsCst: "200" }));
  assert.equal(changed.nbsCode, null);
  assert.equal(changed.ibsCbsCst, "200");
  assert.equal(await prisma.preparedDps.count({ where: { organizationId: a.id } }), 0);
  assert.equal(await prisma.invoice.count({ where: { organizationId: b.id } }), 0);
});

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
  const { a, b, operator, ownerB, prisma, request, login } = await setup(t);
  const cookie = await login(operator.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const customer = await request("/customers", "POST", cookie, customers);
  const service = await request("/services", "POST", cookie, services);
  assert.equal(customer.status, 201);
  assert.equal(service.status, 201);
  const customerId = (await customer.json()).id;
  await prisma.customer.create({ data: { ...customers, name: "Cliente exclusivo", organizationId: b.id } });
  const find = async (q: string, session = cookie) =>
    (await request("/customers?" + new URLSearchParams({ q }), "GET", session)).json();
  assert.deepEqual((await find("TESTE")).items.map(({ id }: { id: string }) => id), [customerId]);
  assert.deepEqual((await find("exclusivo")).items, []);
  assert.deepEqual((await find("teste", other)).items, []);
  assert.deepEqual((await find("%")).items, []);
  assert.equal((await request("/customers?q=teste&q=cliente", "GET", cookie)).status, 400);
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
  assert.deepEqual((await find("teste")).items, []);
  const kept = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  assert.equal(kept?.customerId, customerId);
  assert.equal(kept?.serviceId, serviceId);
  assert.equal((await prisma.service.findUnique({ where: { id: serviceId } }))?.active, false);
});

test("commercial conversion settles stock, installments and payments inside the correct tenant", async (t) => {
  const { a, b, shared, operator, ownerB, prisma, request, login } = await setup(t);
  const owner = await login(shared.email, a.cnpj);
  const other = await login(ownerB.email, b.cnpj);
  const staff = await login(operator.email, a.cnpj);
  const post = (path: string, data: object, cookie = owner, key = randomUUID()) =>
    request("/commercial/" + path, "POST", cookie, data, { "Idempotency-Key": key });

  async function body(response: Response, status: number) {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }

  const supplier = await body(await post("suppliers", { name: "Fornecedor da empresa B" }, other), 201);
  const productInput = { name: "Peça", sku: "p-100", price: "10", cost: "3", minimumStock: 1 };
  await body(await post("products", { ...productInput, supplierId: supplier.id }), 404);
  const product = await body(await post("products", productInput), 201);
  const customer = await body(await request("/customers", "POST", owner, customers), 201);
  const service = await body(await request("/services", "POST", owner, services), 201);
  const items = [
    { id: product.id, type: "PRODUCT", quantity: 2, price: "10.00" },
    { id: service.id, type: "SERVICE", quantity: 1, price: "10.01" },
  ];
  const quoteInput = { kind: "QUOTE", order: { customerId: customer.id, items } };
  const key = randomUUID();
  const quote = await body(await post("orders", quoteInput, owner, key), 201);
  assert.equal((await body(await post("orders", quoteInput, owner, key), 200)).id, quote.id);
  assert.equal((await request("/commercial/orders/" + quote.id, "GET", other)).status, 404);
  assert.equal((await request("/commercial/products/" + product.id + "/movements", "GET", other)).status, 404);
  const action = (order: { id: string; updatedAt: string }, op: string, cookie = owner) =>
    request("/commercial/orders/" + order.id + "/" + op, "POST", cookie, undefined, { "If-Match": '"' + order.updatedAt + '"' });

  assert.equal((await action(quote, "convert", other)).status, 404);
  let sale = await body(await action(quote, "convert"), 200);
  const converted = await body(await request("/commercial/orders/" + quote.id, "GET", owner), 200);
  assert.equal((await body(await action(converted, "convert"), 200)).id, sale.id);
  sale = await body(await request("/commercial/orders/" + sale.id, "PUT", staff, {
    customerId: customer.id, items, dueOn: "2026-01-31", installments: 2, sellerName: "Vendedora teste", commissionBps: 500,
  }, { "If-Match": '"' + sale.updatedAt + '"' }), 200);
  await body(await action(sale, "confirm", staff), 409);
  assert.equal(await prisma.cashEntry.count({ where: { organizationId: a.id, orderId: sale.id } }), 0);

  const movement = { quantity: 4, reason: "Compra teste" };
  const stockKey = randomUUID();
  assert.equal((await post("products/" + product.id + "/movements", movement, staff)).status, 403);
  const stock = await body(await post("products/" + product.id + "/movements", movement, owner, stockKey), 200);
  assert.equal(stock.stock, 4);
  assert.equal((await body(await post("products/" + product.id + "/movements", movement, owner, stockKey), 200)).stock, 4);
  const confirmed = await Promise.all([action(sale, "confirm", staff), action(sale, "confirm", staff)]);
  assert.deepEqual(confirmed.map((response) => response.status).sort(), [200, 409]);
  sale = await confirmed.find((response) => response.ok)!.json();
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id, organizationId: a.id } })).stock, 2);
  const receivables = await prisma.cashEntry.findMany({
    where: { organizationId: a.id, orderId: sale.id, kind: "RECEIVABLE" }, orderBy: { installment: "asc" },
  });
  assert.deepEqual(receivables.map(({ amount, dueOn }) => [amount.toFixed(2), dueOn.toISOString().slice(0, 10)]), [
    ["15.01", "2026-01-31"], ["15.00", "2026-02-28"],
  ]);
  const commission = await prisma.cashEntry.findFirstOrThrow({ where: { organizationId: a.id, orderId: sale.id, kind: "COMMISSION" } });
  assert.equal(commission.amount.toFixed(2), "1.50");

  const draft = await body(await action(sale, "invoice-draft", staff), 200);
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId, organizationId: a.id } });
  assert.equal(invoice.status, "DRAFT");
  assert.equal(invoice.amount.toFixed(2), "10.01");
  sale = await body(await request("/commercial/orders/" + sale.id, "GET", owner), 200);
  assert.equal((await body(await action(sale, "invoice-draft", staff), 200)).invoiceId, invoice.id);
  assert.equal((await action(sale, "cancel")).status, 409);

  const route = "finance/entries/" + receivables[0].id + "/payments";
  const payment = { amount: "5.01", method: "PIX", paidOn: "2025-01-20" };
  const paymentKey = randomUUID();
  assert.equal((await post(route, payment, staff)).status, 403);
  assert.equal((await post(route, payment, other)).status, 404);
  assert.equal((await body(await post(route, payment, owner, paymentKey), 200)).balance, "10");
  assert.equal((await body(await post(route, payment, owner, paymentKey), 200)).balance, "10");
  assert.equal((await post(route, { ...payment, amount: "10.01" })).status, 409);
  const ledger = await body(await request("/commercial/" + route, "GET", owner), 200);
  assert.equal(ledger.items.length, 1);
  const summary = "/commercial/finance/summary?from=2025-01-01&to=2025-01-31";
  assert.equal((await body(await request(summary, "GET", owner), 200)).received, "5.01");
  assert.equal((await body(await request(summary, "GET", other), 200)).received, "0");
  const reverse = () => request("/commercial/" + route + "/" + ledger.items[0].id + "/reverse", "POST", owner);
  assert.equal((await body(await reverse(), 200)).balance, "15.01");
  assert.equal((await body(await reverse(), 200)).balance, "15.01");
  assert.equal((await body(await request(summary, "GET", owner), 200)).received, "0");

  const constraintProduct = await prisma.product.create({
    data: { organizationId: b.id, name: "Produto B", sku: "B", price: "10", cost: "0" },
  });
  await assert.rejects(prisma.stockMovement.create({
    data: { organizationId: a.id, productId: constraintProduct.id, quantity: 1, reason: "Cruzamento de tenant" },
  }), { code: "P2003" });
  assert.equal((await request("/invoices/" + invoice.id, "DELETE", owner, undefined, { "If-Match": '"' + invoice.updatedAt.toISOString() + '"' })).status, 204);
  assert.equal((await action(sale, "cancel")).status, 200);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id, organizationId: a.id } })).stock, 4);
  assert.equal(await prisma.cashEntry.count({ where: { organizationId: a.id, orderId: sale.id, cancelledAt: { not: null } } }), 3);
});

test("automatic monthly production requires scoped consent, waits for the future date and reconciles a lost response without resending", async (t) => {
  const authority = testAuthority(false, 60);
  const vault = createCertificateVault(randomBytes(32).toString("base64url"), authority.root);
  let config!: ProductionIssuanceConfig, cnpj = "", posted = 0, lookupsVisible = false;
  let pfx!: Buffer, passphrase = "", note: { xml: string; accessKey: string } | undefined;
  const stamp = new Date().toISOString();
  const envelope = { tipoAmbiente: 1, versaoAplicativo: "SEFIN local de teste", dataHoraProcessamento: stamp };
  const f = await setup(t, vault, undefined, undefined, undefined, (issuer) => {
    cnpj = issuer;
    config = { cnpjs: new Set(), transport: async (_binding, _sealed, identity, use, approval) => use({
      identity,
      async request(method, path, body) {
        assert.equal(identity.cnpj, cnpj);
        if (method === "POST") {
          assert.equal(path, "/nfse"); assert.ok(approval && body); posted++;
          const dps = gunzipSync(Buffer.from(body.dpsXmlGZipB64, "base64")).toString("utf8").replace(/^<\?xml[^?]+\?>/, "");
          const accessKey = "355030822" + cnpj + "0".repeat(27);
          const unsigned = '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS' + accessKey + '">' +
            '<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>38</nNFSe><cStat>100</cStat><dhProc>' + stamp +
            '</dhProc><emit><CNPJ>' + cnpj + '</CNPJ><xNome>Empresa de teste</xNome></emit><valores><vLiq>10.00</vLiq></valores>' + dps + '</infNFSe></NFSe>';
          const key = loadHomologationSigningKey(pfx, passphrase), canonical = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
          const signer = new SignedXml({ privateKey: key.privateKey, publicCert: key.publicCert, canonicalizationAlgorithm: canonical,
            signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
          signer.addReference({ xpath: "//*[local-name(.)='infNFSe']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
            transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", canonical] });
          signer.computeSignature(unsigned, { location: { reference: "/*", action: "append" } });
          note = { xml: signer.getSignedXml(), accessKey };
          throw new Error("Synthetic lost response after acceptance");
        }
        if (path.startsWith("/dps/")) return lookupsVisible && note
          ? { status: 200, body: { ...envelope, chaveAcesso: note.accessKey } }
          : { status: 404, body: { tipoAmbiente: 0, dataHoraProcessamento: stamp, erro: { codigo: "E2404" } } };
        assert.ok(note && lookupsVisible); assert.equal(path, "/nfse/" + note.accessKey);
        return { status: 200, body: { ...envelope, chaveAcesso: note.accessKey, nfseXmlGZipB64: gzipSync(note.xml).toString("base64") } };
      },
    }) };
    return config;
  });
  const { a, b, prisma, request, login, shared, ownerB, operator } = f;
  const owner = await login(shared.email, a.cnpj), other = await login(ownerB.email, b.cnpj), writer = await login(operator.email, a.cnpj);
  await prisma.organization.update({ where: { id: a.id }, data: { cityIbgeCode: "3550308", productionIssuanceEnabled: true } });
  const issued = authority.issue(a.cnpj); pfx = issued.pfx; passphrase = issued.password;
  assert.equal((await request("/certificates", "PUT", owner, { pfx: pfx.toString("base64"), password: passphrase }, { "If-Match": '"missing"' })).status, 201);
  const customer = await prisma.customer.create({ data: { organizationId: a.id, name: "Cliente de teste automático", federalTaxId: "52998224725" } });
  const service = await prisma.service.create({ data: { organizationId: a.id, name: "Manutenção de teste", description: "Manutenção mensal",
    defaultAmount: "10.00", nationalServiceCode: "140101", municipalServiceCode: "009", nbsCode: "120029000" } });
  const source = await prisma.invoice.create({ data: { organizationId: a.id, customerId: customer.id, serviceId: service.id,
    serviceDescription: "Manutenção mensal", amount: "10.00", idempotencyKey: randomUUID() } });
  const period = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date()).slice(0, 7);
  const fiscal = { serie: "49002", nDPS: "1", dCompet: period + "-01", opSimpNac: "3", regApTribSN: "1", regEspTrib: "0",
    cLocPrestacao: "3550308", cTribNac: "140101", cTribMun: "009", cNBS: "120029000", tpRetISSQN: "1", totTrib: { pTotTribSN: "13.94" } };
  const prepared = await request("/invoices/" + source.id + "/production-dps", "POST", owner,
    { ...fiscal, rememberServiceFiscalData: true }, { "If-Match": '"' + source.updatedAt.toISOString() + '"' });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  async function monthly(customerId: string) {
    const response = await request("/schedules/monthly", "POST", owner, { customerId, serviceId: service.id,
      serviceDescription: "Manutenção mensal", kind: "MENSALIDADE", amount: "10.00" });
    assert.equal(response.status, 201, await response.clone().text()); return response.json();
  }
  const plan = await monthly(customer.id), path = "/schedules/" + plan.id + "/automatic-production";
  assert.equal(plan.automaticProduction, false);
  const preview = await (await request(path, "GET", owner)).json();
  assert.equal(preview.ready, true); assert.equal(preview.fiscalData.cTribMun, "009"); assert.equal(preview.fiscalData.cNBS, "120029000");
  assert.equal(preview.policy, "FIRST_DAY_08_BRASILIA_CURRENT_MONTH");
  assert.equal((await request(path, "GET", other)).status, 404);
  assert.equal((await request(path, "GET", writer)).status, 403);
  const approval = { enabled: true, version: preview.version, confirmAutomaticProduction: true };
  assert.equal((await request(path, "PUT", owner, { enabled: true, version: preview.version })).status, 400);
  assert.equal((await request(path, "PUT", owner, { ...approval, organizationId: b.id })).status, 400);
  assert.equal((await request(path, "PUT", other, approval)).status, 404);
  assert.equal((await request(path, "PUT", writer, approval)).status, 403);
  const certificate = await prisma.fiscalCertificate.findUniqueOrThrow({ where: { organizationId: a.id } });
  await prisma.fiscalCertificate.update({ where: { organizationId: a.id }, data: { validUntil: new Date(Date.now() + 3600_000) } });
  assert.equal((await request(path, "PUT", owner, approval)).status, 409);
  await prisma.fiscalCertificate.update({ where: { organizationId: a.id }, data: { validUntil: certificate.validUntil } });
  const enabled = await request(path, "PUT", owner, approval); assert.equal(enabled.status, 200, await enabled.clone().text());
  assert.ok(new Date((await enabled.json()).nextRunAt) > new Date());
  assert.equal((await request(path, "PUT", owner, approval)).status, 409);
  await runDueDraftSchedules(prisma);
  await runAutomaticInvoices(prisma, vault, config);
  assert.equal(posted, 0, "Enabling or reviewing automation must never send a note immediately.");
  assert.equal(await prisma.automaticInvoiceRun.count({ where: { organizationId: a.id } }), 0);
  const consent = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { organizationId: a.id, id: plan.id } });
  const due = new Date(period + "-01T11:00:00Z");
  await prisma.invoiceSchedule.update({ where: { id: plan.id, organizationId: a.id }, data: { nextRunAt: due, automaticAuthorizedAt: new Date(due.getTime() - 86400_000) } });
  await Promise.all([runDueDraftSchedules(prisma), runDueDraftSchedules(prisma)]);
  assert.equal(await prisma.automaticInvoiceRun.count({ where: { organizationId: a.id } }), 1);
  await Promise.all([runAutomaticInvoices(prisma, vault, config), runAutomaticInvoices(prisma, vault, config)]);
  let run = await prisma.automaticInvoiceRun.findFirstOrThrow({ where: { organizationId: a.id, scheduleId: plan.id } });
  assert.equal(posted, 1); assert.equal(run.status, "PENDING");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: run.invoiceId } })).status, "PROCESSING");
  assert.ok(run.reservedDpsId?.endsWith("000000000000002"));
  async function retryPending() {
    await prisma.automaticInvoiceRun.updateMany({ where: { organizationId: a.id, status: "PENDING" }, data: { nextAttemptAt: new Date(0) } });
    await runAutomaticInvoices(prisma, vault, config);
  }
  await prisma.fiscalCertificate.update({ where: { organizationId: a.id }, data: { validUntil: new Date(Date.now() - 1000) } });
  await retryPending(); assert.equal(posted, 1);
  assert.equal((await prisma.automaticInvoiceRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PENDING");
  await prisma.fiscalCertificate.update({ where: { organizationId: a.id }, data: { validUntil: certificate.validUntil } });
  const current = await (await request(path, "GET", owner)).json();
  assert.equal((await request(path, "PUT", owner, { enabled: false, version: current.version })).status, 200);
  lookupsVisible = true;
  await retryPending();
  run = await prisma.automaticInvoiceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(run.status, "AUTHORIZED"); assert.equal(posted, 1);
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { organizationId: a.id, id: run.invoiceId } });
  assert.equal(invoice.status, "AUTHORIZED"); assert.equal(invoice.xmlResponse, note!.xml);
  assert.equal(await prisma.invoice.count({ where: { organizationId: a.id, idempotencyKey: "monthly:" + plan.id + ":" + period } }), 1);
  await prisma.invoiceSchedule.update({ where: { id: plan.id }, data: { automaticProduction: true,
    automaticAuthorizedBy: consent.automaticAuthorizedBy, automaticAuthorizedAt: consent.automaticAuthorizedAt,
    automaticFiscalData: consent.automaticFiscalData!, automaticSourceHash: consent.automaticSourceHash, nextRunAt: due } });
  await runDueDraftSchedules(prisma); await runAutomaticInvoices(prisma, vault, config);
  assert.equal(await prisma.automaticInvoiceRun.count({ where: { organizationId: a.id, scheduleId: plan.id } }), 1); assert.equal(posted, 1);
  // A second customer uses the reviewed service defaults, but a subsequent municipal-code edit pauses sending.
  const secondCustomer = await prisma.customer.create({ data: { organizationId: a.id, name: "Segundo cliente automático", federalTaxId: "11144477735" } });
  const second = await monthly(secondCustomer.id), secondPath = "/schedules/" + second.id + "/automatic-production";
  const secondPreview = await (await request(secondPath, "GET", owner)).json();
  assert.equal((await request(secondPath, "PUT", owner, { enabled: true, version: secondPreview.version, confirmAutomaticProduction: true })).status, 200);
  await prisma.invoiceSchedule.update({ where: { id: second.id }, data: { nextRunAt: due } });
  await prisma.service.update({ where: { id: service.id }, data: { municipalServiceCode: "008" } });
  await runDueDraftSchedules(prisma); await runAutomaticInvoices(prisma, vault, config);
  const blocked = await prisma.automaticInvoiceRun.findFirstOrThrow({ where: { organizationId: a.id, scheduleId: second.id } });
  assert.equal(blocked.status, "BLOCKED"); assert.equal(posted, 1);
  assert.equal((await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: second.id } })).nextRunAt, null);
  await prisma.service.update({ where: { id: service.id }, data: { municipalServiceCode: "009" } });
  // Automated number reservations are also unavailable to manual preparation.
  const reservedId = run.reservedDpsId!.slice(0, -15) + "99".padStart(15, "0");
  await prisma.automaticInvoiceRun.update({ where: { id: blocked.id }, data: { reservedDpsId: reservedId } });
  const collision = await request("/invoices/" + source.id + "/production-dps", "POST", owner,
    { ...fiscal, nDPS: "99" }, { "If-Match": '"' + source.updatedAt.toISOString() + '"' });
  assert.equal(collision.status, 409); assert.equal(posted, 1);
  const suggested = await (await request("/invoices/" + source.id + "/production-dps", "GET", owner)).json();
  assert.equal(suggested.fiscalDefaults.nDPS, "100");
  const foreignCustomer = await prisma.customer.create({ data: { organizationId: b.id, name: "Cliente B", federalTaxId: "52998224725" } });
  const foreignInvoice = await prisma.invoice.create({ data: { organizationId: b.id, customerId: foreignCustomer.id, amount: "10.00", serviceDescription: "Teste B", idempotencyKey: randomUUID() } });
  await assert.rejects(prisma.automaticInvoiceRun.create({ data: { organizationId: b.id, scheduleId: plan.id, invoiceId: foreignInvoice.id,
    period, authorizedBy: ownerB.id, consentHash: "f".repeat(64) } }), { code: "P2003" });
  const thirdCustomer = await prisma.customer.create({ data: { organizationId: a.id, name: "Terceiro cliente automático", federalTaxId: "93541134780" } });
  const third = await monthly(thirdCustomer.id), thirdPath = "/schedules/" + third.id + "/automatic-production";
  const thirdPreview = await (await request(thirdPath, "GET", owner)).json();
  assert.equal((await request(thirdPath, "PUT", owner, { enabled: true, version: thirdPreview.version, confirmAutomaticProduction: true })).status, 200);
  await prisma.invoiceSchedule.update({ where: { id: third.id }, data: { nextRunAt: due } });
  await prisma.membership.update({ where: { userId_organizationId: { userId: shared.id, organizationId: a.id } }, data: { role: "ADMIN" } });
  await runDueDraftSchedules(prisma); await runAutomaticInvoices(prisma, vault, config);
  const revoked = await prisma.automaticInvoiceRun.findFirstOrThrow({ where: { organizationId: a.id, scheduleId: third.id } });
  assert.equal(revoked.status, "BLOCKED"); assert.equal(revoked.errorCode, "automatic-owner-required"); assert.equal(posted, 1);
});
