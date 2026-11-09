import type { Prisma } from "@prisma/client";

// Serialize tenant writes and new sessions with access changes.
export async function lockActiveOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Organization"
    WHERE "id" = ${organizationId} AND "archivedAt" IS NULL AND "accessSuspendedAt" IS NULL
    FOR SHARE
  `;
  return rows.length > 0;
}
