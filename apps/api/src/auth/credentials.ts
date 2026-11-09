import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { organizationDocumentSchema } from "../registrations/input.ts";

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const organizationCnpjSchema = z.string().trim().min(1).max(32);
export const newPasswordSchema = z.string().min(15).max(128);

const credentials = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const loginSchema = z.union([
  credentials.extend({
    organizationDocument: organizationDocumentSchema,
    account: z.string().min(1).max(40).optional(),
  }).refine(({ account, organizationDocument }) => account === undefined || organizationDocument.length === 11),
  credentials.extend({ organizationCnpj: organizationCnpjSchema }),
]);

const saltLength = 16;
const keyLength = 32;
const hashPattern = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function deriveKey(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 ** 2 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(saltLength);
  const key = await deriveKey(password, salt);
  return `scrypt-v1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string | undefined) {
  const match = storedHash?.match(hashPattern);
  // Do the same amount of derivation work for missing credentials.
  const salt = match ? Buffer.from(match[1], "base64url") : Buffer.alloc(saltLength);
  const expected = match ? Buffer.from(match[2], "base64url") : Buffer.alloc(keyLength);
  const derived = await deriveKey(password, salt);
  return timingSafeEqual(expected, derived) && Boolean(match);
}
