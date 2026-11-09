CREATE TYPE "InvoiceKind" AS ENUM ('AVULSA', 'MENSALIDADE', 'MODERNIZACAO', 'ORCAMENTO');
ALTER TABLE "Invoice" ADD COLUMN "kind" "InvoiceKind" NOT NULL DEFAULT 'AVULSA';
ALTER TABLE "InvoiceSchedule" ALTER COLUMN "sourceInvoiceId" DROP NOT NULL;
ALTER TABLE "InvoiceSchedule" ADD COLUMN "kind" "InvoiceKind" NOT NULL DEFAULT 'MENSALIDADE';
CREATE UNIQUE INDEX "InvoiceSchedule_monthly_customer_kind_key"
    ON "InvoiceSchedule"("organizationId", "customerId", "kind") WHERE "sourceInvoiceId" IS NULL;
