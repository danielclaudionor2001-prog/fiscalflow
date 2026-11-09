ALTER TYPE "RegistrationEntity" ADD VALUE 'INVOICE_SCHEDULE';
ALTER TABLE "RegistrationAuditEvent" ALTER COLUMN "actorUserId" DROP NOT NULL;
CREATE UNIQUE INDEX "Invoice_organizationId_id_key" ON "Invoice"("organizationId", "id");

CREATE TABLE "InvoiceSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceInvoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "serviceDescription" TEXT NOT NULL,
    "dayOfMonth" INTEGER NOT NULL CHECK ("dayOfMonth" BETWEEN 1 AND 31),
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    CONSTRAINT "InvoiceSchedule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoiceSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceSchedule_organizationId_sourceInvoiceId_fkey" FOREIGN KEY ("organizationId", "sourceInvoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceSchedule_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceSchedule_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvoiceSchedule_organizationId_sourceInvoiceId_key" ON "InvoiceSchedule"("organizationId", "sourceInvoiceId");
CREATE INDEX "InvoiceSchedule_nextRunAt_id_idx" ON "InvoiceSchedule"("nextRunAt", "id");
