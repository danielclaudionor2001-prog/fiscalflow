BEGIN;
ALTER TABLE "InvoiceSchedule" ADD COLUMN "contractName" VARCHAR(160) NOT NULL DEFAULT '';
DROP INDEX "InvoiceSchedule_monthly_customer_kind_key";
CREATE UNIQUE INDEX "InvoiceSchedule_monthly_customer_contract_kind_key"
  ON "InvoiceSchedule"("organizationId", "customerId", "contractName", "kind")
  WHERE "sourceInvoiceId" IS NULL;
COMMIT;
