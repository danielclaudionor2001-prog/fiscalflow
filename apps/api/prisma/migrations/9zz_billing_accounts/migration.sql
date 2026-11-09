ALTER TYPE "RegistrationEntity" ADD VALUE 'RECEIVING_ACCOUNT';
ALTER TYPE "RegistrationEntity" ADD VALUE 'BOLETO';

CREATE TYPE "BillingPurpose" AS ENUM ('SERVICE', 'SUBSCRIPTION');
CREATE TYPE "ReceivingProvider" AS ENUM ('CELCOIN', 'OWN_BANK');
CREATE TYPE "BoletoStatus" AS ENUM ('PLANNED', 'REGISTERED', 'SETTLED', 'CANCELLED');

CREATE TABLE "ReceivingAccount" (
    "organizationId" TEXT NOT NULL,
    "purpose" "BillingPurpose" NOT NULL,
    "provider" "ReceivingProvider" NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT,
    "branch" TEXT,
    "accountNumber" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceivingAccount_pkey" PRIMARY KEY ("organizationId", "purpose"),
    CONSTRAINT "ReceivingAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "Boleto" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" "BillingPurpose" NOT NULL,
    "invoiceId" TEXT,
    "period" TEXT,
    "payerName" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL CHECK ("amount" > 0),
    "dueDate" DATE NOT NULL,
    "status" "BoletoStatus" NOT NULL DEFAULT 'PLANNED',
    "bankName" TEXT NOT NULL,
    "accountLastFour" TEXT NOT NULL,
    "provider" "ReceivingProvider" NOT NULL,
    "issuerReference" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Boleto_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Boleto_billing_subject_check" CHECK (
      ("purpose" = 'SERVICE' AND "invoiceId" IS NOT NULL AND "period" IS NULL)
      OR ("purpose" = 'SUBSCRIPTION' AND "period" IS NOT NULL AND "invoiceId" IS NULL)
    ),
    CONSTRAINT "Boleto_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Boleto_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Boleto_organizationId_invoiceId_key" ON "Boleto"("organizationId", "invoiceId");
CREATE UNIQUE INDEX "Boleto_organizationId_period_key" ON "Boleto"("organizationId", "period");
CREATE INDEX "Boleto_organizationId_purpose_createdAt_id_idx" ON "Boleto"("organizationId", "purpose", "createdAt", "id");
