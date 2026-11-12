ALTER TYPE "RegistrationEntity" ADD VALUE 'DPS_FISCAL_TEMPLATE';

CREATE TABLE "DpsFiscalTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "fiscalData" JSONB NOT NULL,
    CONSTRAINT "DpsFiscalTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DpsFiscalTemplate_organizationId_customerId_serviceKey_key"
    ON "DpsFiscalTemplate"("organizationId", "customerId", "serviceKey");

ALTER TABLE "DpsFiscalTemplate" ADD CONSTRAINT "DpsFiscalTemplate_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DpsFiscalTemplate" ADD CONSTRAINT "DpsFiscalTemplate_organizationId_customerId_fkey"
    FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
