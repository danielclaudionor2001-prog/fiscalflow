BEGIN;
CREATE TYPE "AutomaticInvoiceStatus" AS ENUM ('QUEUED', 'PROCESSING', 'PENDING', 'AUTHORIZED', 'REJECTED', 'BLOCKED');
ALTER TABLE "InvoiceSchedule"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "automaticProduction" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "automaticAuthorizedBy" TEXT,
  ADD COLUMN "automaticAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN "automaticFiscalData" JSONB,
  ADD COLUMN "automaticSourceHash" TEXT,
  ADD CONSTRAINT "InvoiceSchedule_automatic_consent_check" CHECK (NOT "automaticProduction" OR (
    "dayOfMonth" = 1 AND "serviceId" IS NOT NULL AND "automaticAuthorizedBy" IS NOT NULL
    AND "automaticAuthorizedAt" IS NOT NULL AND "automaticFiscalData" IS NOT NULL AND "automaticSourceHash" IS NOT NULL AND "automaticSourceHash" ~ '^[a-f0-9]{64}$'
  ));
CREATE UNIQUE INDEX "InvoiceSchedule_organizationId_id_key" ON "InvoiceSchedule"("organizationId", "id");
CREATE TABLE "AutomaticInvoiceRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "period" TEXT NOT NULL CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "authorizedBy" TEXT NOT NULL,
  "consentHash" TEXT NOT NULL CHECK ("consentHash" ~ '^[a-f0-9]{64}$'),
  "status" "AutomaticInvoiceStatus" NOT NULL DEFAULT 'QUEUED',
  "reservedDpsId" TEXT,
  "preparationInput" JSONB,
  "operationId" TEXT,
  "busyUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AutomaticInvoiceRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomaticInvoiceRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AutomaticInvoiceRun_organizationId_scheduleId_fkey" FOREIGN KEY ("organizationId", "scheduleId") REFERENCES "InvoiceSchedule"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AutomaticInvoiceRun_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AutomaticInvoiceRun_organizationId_id_key" ON "AutomaticInvoiceRun"("organizationId", "id");
CREATE UNIQUE INDEX "AutomaticInvoiceRun_organizationId_scheduleId_period_key" ON "AutomaticInvoiceRun"("organizationId", "scheduleId", "period");
CREATE UNIQUE INDEX "AutomaticInvoiceRun_organizationId_invoiceId_key" ON "AutomaticInvoiceRun"("organizationId", "invoiceId");
CREATE UNIQUE INDEX "AutomaticInvoiceRun_organizationId_reservedDpsId_key" ON "AutomaticInvoiceRun"("organizationId", "reservedDpsId");
CREATE INDEX "AutomaticInvoiceRun_status_nextAttemptAt_idx" ON "AutomaticInvoiceRun"("status", "nextAttemptAt");
COMMIT;
