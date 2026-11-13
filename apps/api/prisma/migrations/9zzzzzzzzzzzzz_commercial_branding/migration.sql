ALTER TABLE "Organization"
ADD COLUMN "commercialEmail" TEXT,
ADD COLUMN "commercialPhone" TEXT,
ADD COLUMN "commercialAddress" TEXT,
ADD COLUMN "commercialLogo" BYTEA,
ADD COLUMN "quoteWatermark" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_commercialLogo_size"
CHECK (octet_length("commercialLogo") <= 393216);
