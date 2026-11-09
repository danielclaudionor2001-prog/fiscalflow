import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/credentials.ts";
import { createAuthRouter } from "../src/auth/router.ts";

const origin = "https://painel.example.test";
const password = randomBytes(24).toString("base64url");

async function startAuth(t: TestContext, secureCookie = false) {
  const prisma = new PrismaClient();
  t.after(() => prisma.$disconnect());
  const app = createApp(origin, async () => {}, createAuthRouter(prisma, origin, secureCookie));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/auth`;
  return { prisma, request: (path: string, init?: RequestInit) => fetch(base + path, init) };
}

async function fixtures(t: TestContext, prisma: PrismaClient) {
  const passwordHash = await hashPassword(password);
  const seed = await prisma.$transaction(async (tx) => {
    const a = await tx.organization.create({
      data: { legalName: "Tenant A fixture", cnpj: randomBytes(7).toString("hex") },
    });
    const b = await tx.organization.create({
      data: { legalName: "Tenant B fixture", cnpj: randomBytes(7).toString("hex") },
    });
    const shared = await tx.user.create({
      data: { name: "Shared user fixture", email: `${randomUUID()}@example.test`, passwordHash },
    });
    const bAdmin = await tx.user.create({
      data: { name: "B admin fixture", email: `${randomUUID()}@example.test`, passwordHash },
    });
    await tx.membership.createMany({
      data: [
        { organizationId: a.id, userId: shared.id, role: "OWNER" },
        { organizationId: b.id, userId: shared.id, role: "VIEWER" },
        { organizationId: b.id, userId: bAdmin.id, role: "ADMIN" },
      ],
    });
    const auditA = await tx.authAuditEvent.create({
      data: { organizationId: a.id, userId: shared.id, action: "MEMBERSHIP_PROVISIONED" },
    });
    const auditB = await tx.authAuditEvent.create({
      data: { organizationId: b.id, userId: bAdmin.id, action: "MEMBERSHIP_PROVISIONED" },
    });
    return { a, b, shared, bAdmin, auditA, auditB };
  });
  t.after(async () => {
    const orgs = { in: [seed.a.id, seed.b.id] };
    await prisma.$transaction([
      prisma.authAuditEvent.deleteMany({ where: { organizationId: orgs } }),
      prisma.membership.deleteMany({ where: { organizationId: orgs } }),
      prisma.user.deleteMany({ where: { id: { in: [seed.shared.id, seed.bAdmin.id] } } }),
      prisma.organization.deleteMany({ where: { id: orgs } }),
    ]);
    await prisma.$disconnect();
  });
  return seed;
}

function loginRequest(email: string, organizationCnpj: string, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify({ email, organizationCnpj, password }),
  };
}

function sessionCookie(response: Response) {
  const header = response.headers.get("Set-Cookie");
  assert.ok(header);
  return header.split(";", 1)[0];
}

test("sessions and audit access stay scoped to the tenant and current role", async (t) => {
  const { prisma, request } = await startAuth(t);
  const { a, b, shared, bAdmin, auditA, auditB } = await fixtures(t, prisma);

  const unauthorized = await request("/login", loginRequest(bAdmin.email, a.cnpj));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { code: "invalid-credentials" });
  assert.equal(unauthorized.headers.has("Set-Cookie"), false);
  const forged = loginRequest(shared.email, a.cnpj);
  forged.body = JSON.stringify({ email: shared.email, organizationCnpj: a.cnpj, password, organizationId: b.id });
  assert.equal((await request("/login", forged)).status, 400);

  const ownerLogin = await request("/login", loginRequest(shared.email.toUpperCase(), a.cnpj));
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = sessionCookie(ownerLogin);
  const owner = await ownerLogin.json();
  assert.equal(owner.organization.id, a.id);
  assert.equal(owner.role, "OWNER");
  assert.deepEqual(Object.keys(owner.user).sort(), ["email", "id", "name"]);

  const forgedScope = { headers: { Cookie: ownerCookie, "X-Organization-Id": b.id } };
  const ownerSession = await request(`/session?organizationId=${b.id}`, forgedScope);
  assert.equal(ownerSession.status, 200);
  assert.equal((await ownerSession.json()).organization.id, a.id);
  const ownerAudit = await request(`/audit?organizationId=${b.id}`, forgedScope);
  assert.equal(ownerAudit.status, 200);
  const eventsA = (await ownerAudit.json()).events.map((event: { id: string }) => event.id);
  assert.ok(eventsA.includes(auditA.id));
  assert.ok(!eventsA.includes(auditB.id));

  const viewerLogin = await request("/login", loginRequest(shared.email, b.cnpj));
  assert.equal(viewerLogin.status, 200);
  assert.equal((await viewerLogin.json()).role, "VIEWER");
  const viewerAudit = await request(`/audit?organizationId=${a.id}`, { headers: { Cookie: sessionCookie(viewerLogin) } });
  assert.equal(viewerAudit.status, 403);

  const adminLogin = await request("/login", loginRequest(bAdmin.email, b.cnpj));
  assert.equal(adminLogin.status, 200);
  const adminAudit = await request("/audit", { headers: { Cookie: sessionCookie(adminLogin) } });
  assert.equal(adminAudit.status, 200);
  const eventsB = (await adminAudit.json()).events.map((event: { id: string }) => event.id);
  assert.ok(eventsB.includes(auditB.id));
  assert.ok(!eventsB.includes(auditA.id));

  const membership = { userId: shared.id, organizationId: a.id };
  await prisma.membership.update({ where: { userId_organizationId: membership }, data: { role: "VIEWER" } });
  assert.equal((await request("/audit", forgedScope)).status, 403);
  await prisma.membership.delete({ where: { userId_organizationId: membership } });
  assert.equal((await request("/session", forgedScope)).status, 401);
  assert.equal(await prisma.session.count({ where: membership }), 0);
});

test("session tokens rotate, expire and are revoked by logout", async (t) => {
  const { prisma, request } = await startAuth(t, true);
  const { a, shared } = await fixtures(t, prisma);
  const first = await request("/login", loginRequest(shared.email, a.cnpj));
  assert.equal(first.status, 200);
  const cookie = sessionCookie(first);
  const setCookie = first.headers.get("Set-Cookie")!;
  for (const part of ["__Host-fiscalflow_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.ok(setCookie.includes(part));
  }
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const token = cookie.split("=")[1];
  assert.equal((await first.text()).includes(token), false);
  const hash = createHash("sha256").update(token).digest("hex");
  const saved = await prisma.session.findUnique({ where: { tokenHash: hash } });
  assert.equal(saved?.organizationId, a.id);

  const rotated = await request("/login", loginRequest(shared.email, a.cnpj, cookie));
  assert.equal(rotated.status, 200);
  const active = sessionCookie(rotated);
  assert.ok(active !== cookie);
  assert.equal((await request("/session", { headers: { Cookie: cookie } })).status, 401);

  const attempt = await request("/logout", { method: "POST", headers: { Origin: "https://other.example.test", Cookie: active } });
  assert.equal(attempt.status, 403);
  assert.equal((await request("/session", { headers: { Cookie: active } })).status, 200);
  const logout = await request("/logout", { method: "POST", headers: { Origin: origin, Cookie: active } });
  assert.equal(logout.status, 204);
  assert.ok(logout.headers.get("Set-Cookie")?.includes("Expires="));
  assert.equal((await request("/session", { headers: { Cookie: active } })).status, 401);
  assert.equal(await prisma.authAuditEvent.count({
    where: { organizationId: a.id, userId: shared.id, action: "SESSION_ENDED" },
  }), 2);

  for (const data of [{ expiresAt: new Date(0) }, { lastSeenAt: new Date(0) }]) {
    const login = await request("/login", loginRequest(shared.email, a.cnpj));
    assert.equal(login.status, 200);
    const stale = sessionCookie(login);
    await prisma.session.updateMany({ where: { organizationId: a.id, userId: shared.id }, data });
    assert.equal((await request("/session", { headers: { Cookie: stale } })).status, 401);
  }
});

test("login requires the configured origin and limits attempts", async (t) => {
  const { request } = await startAuth(t);
  const login = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" };
  assert.equal((await request("/login", login)).status, 403);
  const trusted = { ...login, headers: { ...login.headers, Origin: origin } };
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await request("/login", trusted);
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { code: "invalid-input" });
  }
  const blocked = await request("/login", trusted);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { code: "too-many-attempts" });
});
