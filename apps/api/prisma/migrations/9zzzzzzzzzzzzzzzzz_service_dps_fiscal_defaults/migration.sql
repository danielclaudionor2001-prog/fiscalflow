CREATE TABLE "ServiceDpsFiscalTemplate" (
    "organizationId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "fiscalData" JSONB NOT NULL,
    CONSTRAINT "ServiceDpsFiscalTemplate_pkey" PRIMARY KEY ("organizationId", "serviceId"),
    CONSTRAINT "ServiceDpsFiscalTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ServiceDpsFiscalTemplate_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
