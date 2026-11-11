CREATE TYPE "NfseHomologationStatus" AS ENUM ('PENDING', 'REJECTED', 'AUTHORIZED');

ALTER TABLE "PreparedDps"
  ADD COLUMN "homologationStatus" "NfseHomologationStatus",
  ADD COLUMN "homologationKey" TEXT,
  ADD COLUMN "homologationXml" BYTEA,
  ADD COLUMN "homologationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "homologationAt" TIMESTAMP(3),
  ADD CONSTRAINT "PreparedDps_homologation_result_check" CHECK (
    ("homologationStatus" IS NULL) = ("homologationAt" IS NULL)
    AND ("homologationStatus" IS NOT DISTINCT FROM 'AUTHORIZED') = ("homologationKey" IS NOT NULL)
    AND ("homologationStatus" IS NOT DISTINCT FROM 'AUTHORIZED') = ("homologationXml" IS NOT NULL)
    AND ("homologationStatus" IS NOT DISTINCT FROM 'REJECTED' OR cardinality("homologationCodes") = 0)
  );
