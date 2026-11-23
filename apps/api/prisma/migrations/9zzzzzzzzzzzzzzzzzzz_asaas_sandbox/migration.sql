-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RegistrationEntity" ADD VALUE 'ASAAS_CONNECTION';
ALTER TYPE "RegistrationEntity" ADD VALUE 'ASAAS_CHARGE';

-- AlterEnum
ALTER TYPE "ReceivingProvider" ADD VALUE 'ASAAS';

-- CreateTable
CREATE TABLE "AsaasConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" "BillingPurpose" NOT NULL,
    "version" TEXT NOT NULL,
    "sealedCredentials" BYTEA NOT NULL,
    "webhookTokenHash" TEXT NOT NULL,
    "operationId" TEXT,
    "busyUntil" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "AsaasConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsaasCharge" (
    "organizationId" TEXT NOT NULL,
    "boletoId" TEXT NOT NULL,
    "accountOrganizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalReference" TEXT NOT NULL,
    "customerReference" TEXT NOT NULL,
    "payerDocumentHash" TEXT NOT NULL,
    "customerId" TEXT,
    "paymentId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_LOOKUP',
    "bankSlipUrl" TEXT,
    "invoiceUrl" TEXT,
    "errorCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsaasCharge_pkey" PRIMARY KEY ("organizationId","boletoId")
);

-- CreateTable
CREATE TABLE "AsaasWebhookEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsaasWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AsaasConnection_organizationId_purpose_key" ON "AsaasConnection"("organizationId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "AsaasConnection_organizationId_id_key" ON "AsaasConnection"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AsaasCharge_externalReference_key" ON "AsaasCharge"("externalReference");

-- CreateIndex
CREATE UNIQUE INDEX "AsaasCharge_connectionId_paymentId_key" ON "AsaasCharge"("connectionId", "paymentId");

-- CreateIndex
CREATE INDEX "AsaasWebhookEvent_processedAt_retryAfter_idx" ON "AsaasWebhookEvent"("processedAt", "retryAfter");

-- CreateIndex
CREATE UNIQUE INDEX "AsaasWebhookEvent_connectionId_eventId_key" ON "AsaasWebhookEvent"("connectionId", "eventId");

-- AddForeignKey
ALTER TABLE "AsaasConnection" ADD CONSTRAINT "AsaasConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsaasCharge" ADD CONSTRAINT "AsaasCharge_organizationId_boletoId_fkey" FOREIGN KEY ("organizationId", "boletoId") REFERENCES "Boleto"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsaasCharge" ADD CONSTRAINT "AsaasCharge_accountOrganizationId_connectionId_fkey" FOREIGN KEY ("accountOrganizationId", "connectionId") REFERENCES "AsaasConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsaasWebhookEvent" ADD CONSTRAINT "AsaasWebhookEvent_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "AsaasConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
