BEGIN;

-- CreateEnum
CREATE TYPE "RegistrationEntity" AS ENUM ('ORGANIZATION', 'CUSTOMER', 'SERVICE');

-- CreateEnum
CREATE TYPE "RegistrationAction" AS ENUM ('CREATED', 'UPDATED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RegistrationAuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "entity" "RegistrationEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "RegistrationAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegistrationAuditEvent_organizationId_createdAt_idx" ON "RegistrationAuditEvent"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "RegistrationAuditEvent" ADD CONSTRAINT "RegistrationAuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve stored identifiers while making masked and unmasked values equivalent for uniqueness.
CREATE UNIQUE INDEX "Organization_normalized_cnpj_key"
    ON "Organization" (upper(translate(btrim("cnpj"), './-', '')));

CREATE UNIQUE INDEX "Customer_organizationId_normalized_federalTaxId_key"
    ON "Customer" ("organizationId", upper(translate(btrim("federalTaxId"), './-', '')));

COMMIT;
