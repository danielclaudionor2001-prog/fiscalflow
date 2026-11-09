ALTER TYPE "RegistrationEntity" ADD VALUE 'CELCOIN_SANDBOX';
CREATE TYPE "CelcoinSandboxStatus" AS ENUM ('AWAITING_LOOKUP', 'PROCESSING', 'PENDING', 'CONFIRMED', 'CANCELED', 'ERROR');

CREATE UNIQUE INDEX "Boleto_organizationId_id_key" ON "Boleto"("organizationId", "id");

CREATE TABLE "CelcoinSandboxCharge" (
  "organizationId" TEXT NOT NULL,
  "boletoId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "receiverFingerprint" TEXT NOT NULL,
  "transactionId" TEXT,
  "status" "CelcoinSandboxStatus" NOT NULL DEFAULT 'AWAITING_LOOKUP',
  "bankLine" TEXT,
  "dueDate" DATE NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CelcoinSandboxCharge_pkey" PRIMARY KEY ("organizationId", "boletoId"),
  CONSTRAINT "CelcoinSandboxCharge_organizationId_boletoId_fkey" FOREIGN KEY ("organizationId", "boletoId") REFERENCES "Boleto"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CelcoinSandboxCharge_externalId_key" ON "CelcoinSandboxCharge"("externalId");
