ALTER TYPE "RegistrationAction" ADD VALUE 'ACCESS_SUSPENDED';
ALTER TYPE "RegistrationAction" ADD VALUE 'ACCESS_REACTIVATED';
ALTER TABLE "Organization" ADD COLUMN "accessSuspendedAt" TIMESTAMP(3);
ALTER TABLE "Membership" ADD COLUMN "platformOwner" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "OrganizationInvitation" (
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");
