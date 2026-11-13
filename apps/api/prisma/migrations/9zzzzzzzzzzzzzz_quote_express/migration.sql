ALTER TYPE "RegistrationAction" ADD VALUE 'QUOTE_APPROVED';
ALTER TYPE "RegistrationAction" ADD VALUE 'QUOTE_DECLINED';

CREATE TYPE "QuoteDecision" AS ENUM ('APPROVED', 'DECLINED');

CREATE TABLE "QuoteShare" (
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "customerDocumentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "decision" "QuoteDecision",
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "QuoteShare_pkey" PRIMARY KEY ("organizationId", "orderId"),
    CONSTRAINT "QuoteShare_response_consistency" CHECK (("decision" IS NULL) = ("respondedAt" IS NULL)),
    CONSTRAINT "QuoteShare_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId")
      REFERENCES "CommercialOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "QuoteShare_tokenHash_key" ON "QuoteShare"("tokenHash");
