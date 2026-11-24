-- Preserve every existing connection, credential and charge as Sandbox.
CREATE TYPE "AsaasEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
ALTER TYPE "ReceivingProvider" ADD VALUE 'ASAAS_PRODUCTION';
ALTER TABLE "AsaasConnection" ADD COLUMN "environment" "AsaasEnvironment" NOT NULL DEFAULT 'SANDBOX';
ALTER TABLE "AsaasCharge" ADD COLUMN "environment" "AsaasEnvironment" NOT NULL DEFAULT 'SANDBOX';
DROP INDEX "AsaasConnection_organizationId_purpose_key";
CREATE UNIQUE INDEX "AsaasConnection_organizationId_purpose_environment_key" ON "AsaasConnection"("organizationId", "purpose", "environment");
CREATE UNIQUE INDEX "AsaasConnection_organizationId_id_environment_key" ON "AsaasConnection"("organizationId", "id", "environment");
ALTER TABLE "AsaasCharge" DROP CONSTRAINT "AsaasCharge_accountOrganizationId_connectionId_fkey";
ALTER TABLE "AsaasCharge" ADD CONSTRAINT "AsaasCharge_accountOrganizationId_connectionId_environment_fkey"
  FOREIGN KEY ("accountOrganizationId", "connectionId", "environment") REFERENCES "AsaasConnection"("organizationId", "id", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "check_asaas_charge_environment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected TEXT;
BEGIN
  SELECT "provider"::text INTO expected FROM "Boleto" WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."boletoId";
  IF expected IS NOT NULL AND expected IS DISTINCT FROM (CASE WHEN NEW."environment" = 'PRODUCTION' THEN 'ASAAS_PRODUCTION' ELSE 'ASAAS' END) THEN
    RAISE EXCEPTION 'Asaas charge environment mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AsaasCharge_environment_guard" BEFORE INSERT OR UPDATE ON "AsaasCharge"
  FOR EACH ROW EXECUTE FUNCTION "check_asaas_charge_environment"();

CREATE FUNCTION "check_boleto_asaas_environment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE environment TEXT;
BEGIN
  SELECT "environment"::text INTO environment FROM "AsaasCharge" WHERE "organizationId" = NEW."organizationId" AND "boletoId" = NEW."id";
  IF environment IS NOT NULL AND NEW."provider"::text IS DISTINCT FROM (CASE WHEN environment = 'PRODUCTION' THEN 'ASAAS_PRODUCTION' ELSE 'ASAAS' END) THEN
    RAISE EXCEPTION 'Boleto Asaas environment mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Boleto_asaas_environment_guard" BEFORE UPDATE OF "provider" ON "Boleto"
  FOR EACH ROW EXECUTE FUNCTION "check_boleto_asaas_environment"();
