BEGIN;

ALTER TABLE "Organization"
  ADD COLUMN "taxRegime" TEXT,
  ADD COLUMN "simplesApportionment" TEXT,
  ADD COLUMN "specialTaxRegime" TEXT,
  ADD COLUMN "stateRegistration" TEXT,
  ADD COLUMN "zipCode" TEXT,
  ADD COLUMN "street" TEXT,
  ADD COLUMN "addressNumber" TEXT,
  ADD COLUMN "addressComplement" TEXT,
  ADD COLUMN "neighborhood" TEXT,
  ADD COLUMN "cityName" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "legalRepresentativeName" TEXT,
  ADD COLUMN "legalRepresentativeCpf" TEXT,
  ADD COLUMN "legalRepresentativeEmail" TEXT,
  ADD COLUMN "legalRepresentativePhone" TEXT;

ALTER TABLE "Customer"
  ADD COLUMN "municipalRegistration" TEXT,
  ADD COLUMN "stateRegistration" TEXT,
  ADD COLUMN "zipCode" TEXT,
  ADD COLUMN "street" TEXT,
  ADD COLUMN "addressNumber" TEXT,
  ADD COLUMN "addressComplement" TEXT,
  ADD COLUMN "neighborhood" TEXT,
  ADD COLUMN "cityName" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "cityIbgeCode" TEXT,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "financialContactName" TEXT,
  ADD COLUMN "financialContactEmail" TEXT,
  ADD COLUMN "financialContactPhone" TEXT;

ALTER TABLE "Supplier"
  ADD COLUMN "tradeName" TEXT,
  ADD COLUMN "municipalRegistration" TEXT,
  ADD COLUMN "stateRegistration" TEXT,
  ADD COLUMN "zipCode" TEXT,
  ADD COLUMN "street" TEXT,
  ADD COLUMN "addressNumber" TEXT,
  ADD COLUMN "addressComplement" TEXT,
  ADD COLUMN "neighborhood" TEXT,
  ADD COLUMN "cityName" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "cityIbgeCode" TEXT,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "financialContactName" TEXT,
  ADD COLUMN "financialContactEmail" TEXT,
  ADD COLUMN "financialContactPhone" TEXT;

ALTER TABLE "Service"
  ADD COLUMN "nbsCode" TEXT,
  ADD COLUMN "ibsCbsCst" TEXT,
  ADD COLUMN "ibsCbsClassCode" TEXT,
  ADD COLUMN "operationIndicator" TEXT,
  ADD CONSTRAINT "Service_ibs_cbs_class_check"
    CHECK ("ibsCbsCst" IS NULL OR "ibsCbsClassCode" IS NULL OR LEFT("ibsCbsClassCode", 3) = "ibsCbsCst");

ALTER TABLE "Product"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "unit" TEXT,
  ADD COLUMN "ncmCode" TEXT,
  ADD COLUMN "cfopCode" TEXT,
  ADD COLUMN "icmsCst" TEXT,
  ADD COLUMN "csosnCode" TEXT,
  ADD COLUMN "ibsCbsCst" TEXT,
  ADD COLUMN "ibsCbsClassCode" TEXT,
  ADD COLUMN "ibsStateRate" DECIMAL(7,4),
  ADD COLUMN "ibsMunicipalRate" DECIMAL(7,4),
  ADD COLUMN "cbsRate" DECIMAL(7,4),
  ADD CONSTRAINT "Product_ibs_cbs_class_check"
    CHECK ("ibsCbsCst" IS NULL OR "ibsCbsClassCode" IS NULL OR LEFT("ibsCbsClassCode", 3) = "ibsCbsCst"),
  ADD CONSTRAINT "Product_tax_rates_check"
    CHECK (("ibsStateRate" IS NULL OR "ibsStateRate" BETWEEN 0 AND 100)
       AND ("ibsMunicipalRate" IS NULL OR "ibsMunicipalRate" BETWEEN 0 AND 100)
       AND ("cbsRate" IS NULL OR "cbsRate" BETWEEN 0 AND 100));

COMMIT;
