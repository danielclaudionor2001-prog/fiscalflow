import { type PrismaClient } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { authorize } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { createCatalogRouter, recordRegistration, tenantActor } from "../registrations/catalog.ts";
import { customerCreate, moneyAmount, pagination, recordId } from "../registrations/input.ts";
import { commercialTransaction, maxStock, pageResult, requestKey, requireSupplier, title } from "./common.ts";

const supplierFields = customerCreate.extend({ federalTaxId: customerCreate.shape.federalTaxId.nullable().optional() });
const productFields = z.strictObject({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{1,48}$/),
  name: title,
  price: moneyAmount,
  cost: moneyAmount,
  minimumStock: z.number().int().min(0).max(maxStock).default(0),
  supplierId: recordId.nullable().default(null),
});
const movementFields = z.strictObject({
  quantity: z.number().int().min(-100_000).max(100_000).refine((value) => value !== 0),
  reason: title,
});
const productQuery = pagination.extend({ q: z.string().trim().max(160).optional() });

export function createCommercialCatalogRouter(prisma: PrismaClient, cookieName: string) {
  const router = express.Router();
  const read = authorize(prisma, cookieName);
  const write = authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const manage = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "16kb" });

  router.use("/suppliers", createCatalogRouter(prisma, cookieName, {
    entity: "SUPPLIER",
    createInput: supplierFields,
    updateInput: supplierFields.partial().refine((input) => Object.keys(input).length > 0),
    list: (where, skip, take) => prisma.supplier.findMany({ where, skip, take, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    get: (where) => prisma.supplier.findUnique({ where }),
    create: (tx, organizationId, data) => tx.supplier.create({ data: { ...data, organizationId } }),
    update: (tx, where, data) => tx.supplier.update({ where, data }),
    archive: (tx, where) => tx.supplier.update({ where, data: { archivedAt: new Date() } }),
  }));

  router.get("/products", read, asyncRoute(async (req, res) => {
    const { page, limit, q } = parseInput(productQuery, req.query);
    const { organizationId } = tenantActor(res);
    const products = await prisma.product.findMany({
      where: {
        organizationId, archivedAt: null,
        ...(q && { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] }),
      },
      include: { supplier: { select: { id: true, name: true, archivedAt: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit + 1,
    });
    res.json(pageResult(products, limit));
  }));

  router.post("/products", write, json, asyncRoute(async (req, res) => {
    const input = parseInput(productFields, req.body);
    const actor = tenantActor(res);
    const saved = await commercialTransaction(prisma, actor.organizationId, async (tx) => {
      await requireSupplier(tx, actor.organizationId, input.supplierId);
      const row = await tx.product.create({ data: { ...input, organizationId: actor.organizationId } });
      await recordRegistration(tx, actor, "PRODUCT", row.id, "CREATED");
      return row;
    });
    res.status(201).json(saved);
  }));

  router.put("/products/:id", write, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const input = parseInput(productFields, req.body);
    const actor = tenantActor(res);
    const saved = await commercialTransaction(prisma, actor.organizationId, async (tx) => {
      await requireSupplier(tx, actor.organizationId, input.supplierId);
      const row = await tx.product.update({ where: { id, organizationId: actor.organizationId, archivedAt: null }, data: input });
      await recordRegistration(tx, actor, "PRODUCT", id, "UPDATED");
      return row;
    });
    res.json(saved);
  }));

  router.delete("/products/:id", manage, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    await commercialTransaction(prisma, actor.organizationId, async (tx) => {
      const where = { id, organizationId: actor.organizationId, archivedAt: null };
      const product = await tx.product.findUnique({ where, select: { stock: true } });
      if (!product) throw new RequestError(404, "not-found");
      if (product.stock !== 0) throw new RequestError(409, "product-has-stock");
      await tx.product.update({ where, data: { archivedAt: new Date() } });
      await recordRegistration(tx, actor, "PRODUCT", id, "ARCHIVED");
    });
    res.status(204).end();
  }));

  router.get("/products/:id/movements", read, asyncRoute(async (req, res) => {
    const productId = parseInput(recordId, req.params.id);
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const product = await prisma.product.findUnique({ where: { id: productId, organizationId }, select: { id: true } });
    if (!product) throw new RequestError(404, "not-found");
    const rows = await prisma.stockMovement.findMany({
      where: { organizationId, productId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit, take: limit + 1, select: { id: true, quantity: true, reason: true, createdAt: true },
    });
    res.json(pageResult(rows, limit));
  }));

  router.post("/products/:id/movements", manage, json, asyncRoute(async (req, res) => {
    const productId = parseInput(recordId, req.params.id);
    const key = parseInput(requestKey, req.get("Idempotency-Key"));
    const input = parseInput(movementFields, req.body);
    const actor = tenantActor(res);
    const { organizationId } = actor;
    const result = await commercialTransaction(prisma, organizationId, async (tx) => {
      const where = { id: productId, organizationId, archivedAt: null };
      const product = await tx.product.findUnique({ where, select: { stock: true } });
      if (!product) throw new RequestError(404, "not-found");
      const prior = await tx.stockMovement.findUnique({ where: { organizationId_requestKey: { organizationId, requestKey: key } } });
      if (prior) {
        if (prior.productId !== productId || prior.quantity !== input.quantity || prior.reason !== input.reason) {
          throw new RequestError(409, "idempotency-conflict");
        }
        return { stock: product.stock };
      }
      const stock = product.stock + input.quantity;
      if (stock < 0 || stock > maxStock) throw new RequestError(409, "invalid-stock");
      await tx.product.update({ where, data: { stock } });
      const movement = await tx.stockMovement.create({ data: { ...input, organizationId, productId, requestKey: key } });
      await recordRegistration(tx, actor, "STOCK_MOVEMENT", movement.id, "CREATED");
      return { stock };
    });
    res.json(result);
  }));
  return router;
}
