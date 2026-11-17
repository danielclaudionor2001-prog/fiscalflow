ALTER TABLE "Boleto"
  ADD COLUMN "quoteId" TEXT,
  ADD COLUMN "installment" INTEGER,
  ADD COLUMN "installments" INTEGER,
  DROP CONSTRAINT "Boleto_billing_subject_check";

ALTER TABLE "Boleto"
  ADD CONSTRAINT "Boleto_billing_subject_check" CHECK (
    ("purpose" = 'SERVICE' AND "period" IS NULL AND (
      ("invoiceId" IS NOT NULL AND "quoteId" IS NULL AND "installment" IS NULL AND "installments" IS NULL)
      OR ("invoiceId" IS NULL AND "quoteId" IS NOT NULL AND "installment" IS NOT NULL AND "installments" IS NOT NULL
        AND "installments" BETWEEN 1 AND 24 AND "installment" BETWEEN 1 AND "installments")
    ))
    OR ("purpose" = 'SUBSCRIPTION' AND "period" IS NOT NULL AND "invoiceId" IS NULL
      AND "quoteId" IS NULL AND "installment" IS NULL AND "installments" IS NULL)
  ),
  ADD CONSTRAINT "Boleto_organizationId_quoteId_fkey"
    FOREIGN KEY ("organizationId", "quoteId") REFERENCES "CommercialOrder"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Boleto_organizationId_quoteId_installment_key" ON "Boleto"("organizationId", "quoteId", "installment");
