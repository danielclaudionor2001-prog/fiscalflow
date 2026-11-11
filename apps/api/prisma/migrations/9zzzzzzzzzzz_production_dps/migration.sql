ALTER TYPE "RegistrationEntity" ADD VALUE 'PRODUCTION_DPS';
CREATE TYPE "DpsEnvironment" AS ENUM ('HOMOLOGATION', 'PRODUCTION');
CREATE TYPE "ProductionSubmissionStatus" AS ENUM ('PENDING', 'REJECTED', 'AUTHORIZED');

ALTER TABLE "PreparedDps"
  ADD COLUMN "environment" "DpsEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
  ADD COLUMN "sourceHash" TEXT,
  ADD COLUMN "productionStatus" "ProductionSubmissionStatus",
  ADD COLUMN "productionAt" TIMESTAMP(3),
  ADD COLUMN "productionCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  DROP CONSTRAINT "PreparedDps_pkey",
  ADD CONSTRAINT "PreparedDps_pkey" PRIMARY KEY ("organizationId", "environment", "id"),
  ADD CONSTRAINT "PreparedDps_environment_check" CHECK (
    ("environment" = 'HOMOLOGATION' AND "sourceHash" IS NULL AND "productionStatus" IS NULL)
    OR ("environment" = 'PRODUCTION' AND "sourceHash" IS NOT NULL AND "homologationStatus" IS NULL)
  ),
  ADD CONSTRAINT "PreparedDps_production_result_check" CHECK (
    ("productionStatus" IS NULL) = ("productionAt" IS NULL)
    AND ("productionStatus" IS NOT DISTINCT FROM 'REJECTED' OR cardinality("productionCodes") = 0)
  );

DROP INDEX "PreparedDps_organizationId_invoiceId_preparedAt_idx";
CREATE INDEX "PreparedDps_organizationId_invoiceId_environment_preparedAt_idx"
  ON "PreparedDps" ("organizationId", "invoiceId", "environment", "preparedAt");
