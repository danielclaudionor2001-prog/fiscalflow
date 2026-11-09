import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { hashPassword, loginSchema, newPasswordSchema, verifyPassword } from "../src/auth/credentials.ts";

test("password hashes are salted and verified without accepting malformed hashes", async () => {
  const password = randomBytes(18).toString("hex") + " ç";
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password + " ", first), false);
  assert.equal(await verifyPassword(password, "invalid-hash"), false);
  assert.equal(await verifyPassword(password, undefined), false);
});

test("login normalizes identity and rejects client-supplied organization IDs and roles", () => {
  const input = { email: " Owner@Example.test ", password: " a passphrase ", organizationCnpj: " 00123 " };
  assert.deepEqual(loginSchema.parse(input), { ...input, email: "owner@example.test", organizationCnpj: "00123" });
  assert.equal(loginSchema.safeParse({ ...input, organizationId: "another-tenant" }).success, false);
  assert.equal(loginSchema.safeParse({ ...input, role: "OWNER" }).success, false);
  assert.equal(newPasswordSchema.safeParse("short").success, false);
});
