-- CreateEnum
CREATE TYPE "CommercialKind" AS ENUM ('QUOTE', 'SERVICE_ORDER', 'SALE');

-- CreateEnum
CREATE TYPE "CommercialStatus" AS ENUM ('OPEN', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashKind" AS ENUM ('RECEIVABLE', 'PAYABLE', 'COMMISSION');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CASH', 'CARD', 'BOLETO', 'TRANSFER', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RegistrationEntity" ADD VALUE 'SUPPLIER';
ALTER TYPE "RegistrationEntity" ADD VALUE 'PRODUCT';
ALTER TYPE "RegistrationEntity" ADD VALUE 'STOCK_MOVEMENT';
ALTER TYPE "RegistrationEntity" ADD VALUE 'COMMERCIAL_ORDER';
ALTER TYPE "RegistrationEntity" ADD VALUE 'CASH_ENTRY';
ALTER TYPE "RegistrationEntity" ADD VALUE 'CASH_PAYMENT';

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "federalTaxId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "minimumStock" INTEGER NOT NULL DEFAULT 0,
    "supplierId" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderId" TEXT,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "CommercialKind" NOT NULL,
    "status" "CommercialStatus" NOT NULL DEFAULT 'OPEN',
    "customerId" TEXT,
    "customerName" TEXT,
    "sourceId" TEXT,
    "invoiceId" TEXT,
    "note" TEXT NOT NULL,
    "sellerName" TEXT,
    "commissionBps" INTEGER NOT NULL DEFAULT 0,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "dueOn" DATE,
    "amount" DECIMAL(14,2) NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "requestKey" TEXT,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CommercialOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "serviceId" TEXT,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "CommercialItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT,
    "supplierId" TEXT,
    "kind" "CashKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "dueOn" DATE NOT NULL,
    "requestKey" TEXT,
    "requestHash" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installment" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "CashPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_organizationId_archivedAt_name_idx" ON "Supplier"("organizationId", "archivedAt", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_id_key" ON "Supplier"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Product_organizationId_archivedAt_name_idx" ON "Product"("organizationId", "archivedAt", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_id_key" ON "Product"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON "Product"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "StockMovement_organizationId_productId_createdAt_idx" ON "StockMovement"("organizationId", "productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_organizationId_requestKey_key" ON "StockMovement"("organizationId", "requestKey");

-- CreateIndex
CREATE INDEX "CommercialOrder_organizationId_kind_createdAt_idx" ON "CommercialOrder"("organizationId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CommercialOrder_organizationId_kind_status_confirmedAt_idx" ON "CommercialOrder"("organizationId", "kind", "status", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOrder_organizationId_id_key" ON "CommercialOrder"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOrder_organizationId_sourceId_key" ON "CommercialOrder"("organizationId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOrder_organizationId_invoiceId_key" ON "CommercialOrder"("organizationId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOrder_organizationId_requestKey_key" ON "CommercialOrder"("organizationId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialItem_organizationId_orderId_position_key" ON "CommercialItem"("organizationId", "orderId", "position");

-- CreateIndex
CREATE INDEX "CashEntry_organizationId_cancelledAt_dueOn_idx" ON "CashEntry"("organizationId", "cancelledAt", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_organizationId_id_key" ON "CashEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_organizationId_orderId_kind_installment_key" ON "CashEntry"("organizationId", "orderId", "kind", "installment");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_organizationId_requestKey_key" ON "CashEntry"("organizationId", "requestKey");

-- CreateIndex
CREATE INDEX "CashPayment_organizationId_paidOn_idx" ON "CashPayment"("organizationId", "paidOn");

-- CreateIndex
CREATE INDEX "CashPayment_organizationId_entryId_paidOn_idx" ON "CashPayment"("organizationId", "entryId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "CashPayment_organizationId_requestKey_key" ON "CashPayment"("organizationId", "requestKey");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "CommercialOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "CommercialOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialItem" ADD CONSTRAINT "CommercialItem_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "CommercialOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialItem" ADD CONSTRAINT "CommercialItem_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialItem" ADD CONSTRAINT "CommercialItem_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "CommercialOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashPayment" ADD CONSTRAINT "CashPayment_organizationId_entryId_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "CashEntry"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Enforce inventory and monetary invariants in PostgreSQL.
ALTER TABLE "Product" ADD CONSTRAINT "Product_nonnegative" CHECK ("stock" >= 0 AND "minimumStock" >= 0 AND "price" >= 0 AND "cost" >= 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_nonzero" CHECK ("quantity" <> 0);
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_valid" CHECK ("amount" > 0 AND "cost" >= 0 AND "commissionBps" BETWEEN 0 AND 10000 AND "installments" BETWEEN 1 AND 24);
ALTER TABLE "CommercialItem" ADD CONSTRAINT "CommercialItem_valid" CHECK ("quantity" > 0 AND "unitPrice" > 0 AND "unitCost" >= 0 AND num_nonnulls("productId", "serviceId") = 1);
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_balance" CHECK ("amount" > 0 AND "balance" BETWEEN 0 AND "amount" AND "installment" BETWEEN 1 AND 24);
ALTER TABLE "CashPayment" ADD CONSTRAINT "CashPayment_positive" CHECK ("amount" > 0);
