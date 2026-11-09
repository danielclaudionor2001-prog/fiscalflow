ALTER TYPE "RegistrationEntity" ADD VALUE 'PREPARED_DPS';

CREATE TABLE "PreparedDps" (
    "organizationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersion" TIMESTAMP(3) NOT NULL,
    "certificateVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "signedXml" BYTEA NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreparedDps_pkey" PRIMARY KEY ("organizationId", "id"),
    CONSTRAINT "PreparedDps_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PreparedDps_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PreparedDps_organizationId_invoiceId_preparedAt_idx" ON "PreparedDps"("organizationId", "invoiceId", "preparedAt");
