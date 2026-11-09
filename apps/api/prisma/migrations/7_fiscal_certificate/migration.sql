ALTER TYPE "RegistrationEntity" ADD VALUE 'FISCAL_CERTIFICATE';

CREATE TABLE "FiscalCertificate" (
    "organizationId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "sealed" BYTEA NOT NULL,
    CONSTRAINT "FiscalCertificate_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "FiscalCertificate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FiscalCertificate_version_key" ON "FiscalCertificate"("version");
