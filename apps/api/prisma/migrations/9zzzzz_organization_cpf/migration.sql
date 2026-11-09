ALTER TABLE "Organization"
  ALTER COLUMN "cnpj" DROP NOT NULL,
  ADD COLUMN "cpf" TEXT,
  ADD CONSTRAINT "Organization_document_check" CHECK (
    ("cnpj" IS NOT NULL AND "cpf" IS NULL)
    OR ("cnpj" IS NULL AND "cpf" IS NOT NULL AND "cpf" ~ '^[0-9]{11}$')
  );

CREATE UNIQUE INDEX "Organization_cpf_key" ON "Organization"("cpf");
