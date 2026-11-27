ALTER TYPE "RegistrationEntity" ADD VALUE 'TEAM_INVITATION';
ALTER TABLE "Membership" ADD COLUMN "department" TEXT;
CREATE TABLE "TeamInvitation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "department" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "TeamInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TeamInvitation_tokenHash_key" ON "TeamInvitation"("tokenHash");
CREATE INDEX "TeamInvitation_organizationId_createdAt_idx" ON "TeamInvitation"("organizationId", "createdAt");
CREATE INDEX "TeamInvitation_organizationId_email_idx" ON "TeamInvitation"("organizationId", "email");
ALTER TABLE "TeamInvitation" ADD CONSTRAINT "TeamInvitation_non_owner_role" CHECK ("role" <> 'OWNER');
