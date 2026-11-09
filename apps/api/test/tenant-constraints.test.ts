import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

for (const relation of ["customer", "service"] as const) {
  test(`an invoice cannot reference a ${relation} from another organization`, async (t) => {
    const prisma = new PrismaClient();
    t.after(() => prisma.$disconnect());
    const rollback = new Error("Roll back test fixtures");

    await assert.rejects(prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { legalName: "Test organization", cnpj: randomUUID() },
      });
      const other = await tx.organization.create({
        data: { legalName: "Other organization", cnpj: randomUUID() },
      });
      const customer = await tx.customer.create({
        data: { organizationId: organization.id, name: "Test customer", federalTaxId: randomUUID() },
      });
      const otherCustomer = await tx.customer.create({
        data: { organizationId: other.id, name: "Other customer", federalTaxId: randomUUID() },
      });
      const otherService = await tx.service.create({
        data: { organizationId: other.id, name: "Test service", description: "Fixture", defaultAmount: 1 },
      });
      const draft = {
        organizationId: organization.id,
        customerId: customer.id,
        idempotencyKey: randomUUID(),
        amount: 1,
        serviceDescription: "Test fixture",
      };
      await tx.invoice.create({ data: draft });

      const crossTenant = relation === "customer"
        ? { customerId: otherCustomer.id }
        : { serviceId: otherService.id };
      await assert.rejects(
        tx.invoice.create({ data: { ...draft, ...crossTenant, idempotencyKey: randomUUID() } }),
        (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003",
      );
      throw rollback;
    }), (error) => error === rollback);
  });
}
