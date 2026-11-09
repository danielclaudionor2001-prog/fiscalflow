import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { RequestError } from "../http.ts";
import { lockActiveOrganization } from "../organizations/access.ts";
import { hashPassword, newPasswordSchema, verifyPassword } from "./credentials.ts";

export const activationInput = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: newPasswordSchema,
});

export async function activateOrganization(prisma: PrismaClient, { code, password }: z.infer<typeof activationInput>) {
  const tokenHash = createHash("sha256").update(code).digest("hex");
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { tokenHash, expiresAt: { gt: new Date() }, organization: { archivedAt: null, accessSuspendedAt: null } },
    select: { organizationId: true, email: true, name: true, organization: { select: { cnpj: true } } },
  });
  if (!invitation) throw new RequestError(404, "invitation-unavailable");

  const existing = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true, passwordHash: true } });
  const passwordHash = existing ? undefined : await hashPassword(password);
  if (existing && !await verifyPassword(password, existing.passwordHash)) {
    throw new RequestError(403, "activation-password-invalid");
  }
  const { organizationId } = invitation;

  await prisma.$transaction(async (tx) => {
    if (!await lockActiveOrganization(tx, organizationId)) throw new RequestError(404, "invitation-unavailable");
    const claimed = await tx.organizationInvitation.deleteMany({
      where: { organizationId, tokenHash, expiresAt: { gt: new Date() } },
    });
    if (!claimed.count) throw new RequestError(404, "invitation-unavailable");
    const user = existing
      ? await tx.user.findUnique({ where: { id: existing.id, passwordHash: existing.passwordHash }, select: { id: true } })
      : await tx.user.create({ data: { email: invitation.email, name: invitation.name, passwordHash: passwordHash! }, select: { id: true } });
    if (!user) throw new RequestError(403, "activation-password-invalid");
    await tx.membership.create({ data: { organizationId, userId: user.id, role: "OWNER" } });
    await tx.authAuditEvent.create({ data: { organizationId, userId: user.id, action: "MEMBERSHIP_PROVISIONED" } });
  });
  return { cnpj: invitation.organization.cnpj, documentType: invitation.organization.cnpj ? "CNPJ" : "CPF" };
}
