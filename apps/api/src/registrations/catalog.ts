import type { Prisma, PrismaClient, RegistrationAction, RegistrationEntity } from "@prisma/client";
import express, { type Response } from "express";
import type { ZodType } from "zod";
import { authorize, type AuthSession } from "../auth/sessions.ts";
import { asyncRoute, parseInput, RequestError } from "../http.ts";
import { lockActiveOrganization } from "../organizations/access.ts";
import { pagination, recordId } from "./input.ts";

export function tenantActor(res: Response) {
  const { membership } = res.locals.auth as AuthSession;
  return { organizationId: membership.organization.id, actorUserId: membership.user.id };
}

type Actor = ReturnType<typeof tenantActor>;

export function recordRegistration(
  tx: Prisma.TransactionClient,
  actor: { organizationId: string; actorUserId: string | null },
  entity: RegistrationEntity,
  entityId: string,
  action: RegistrationAction,
) {
  return tx.registrationAuditEvent.create({ data: { ...actor, entity, entityId, action } });
}

export async function requireActiveOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  if (!await lockActiveOrganization(tx, organizationId)) throw new RequestError(401, "authentication-required");
}

type CatalogScope = {
  organizationId: string;
  archivedAt: null;
  organization: { archivedAt: null };
};
type CatalogRecord = CatalogScope & { id: string };
type Item = { id: string };

type Catalog<Create, Update, Row extends Item> = {
  entity: "CUSTOMER" | "SERVICE" | "SUPPLIER";
  createInput: ZodType<Create>;
  updateInput: ZodType<Update>;
  list: (where: CatalogScope, skip: number, take: number) => Promise<Row[]>;
  get: (where: CatalogRecord) => Promise<Row | null>;
  create: (tx: Prisma.TransactionClient, organizationId: string, data: Create) => Promise<Row>;
  update: (tx: Prisma.TransactionClient, where: CatalogRecord, data: Update) => Promise<Row>;
  archive: (tx: Prisma.TransactionClient, where: CatalogRecord) => Promise<Item>;
};

function activeScope(organizationId: string): CatalogScope {
  return { organizationId, archivedAt: null, organization: { archivedAt: null } };
}

export function createCatalogRouter<Create, Update, Row extends Item>(
  prisma: PrismaClient,
  cookieName: string,
  catalog: Catalog<Create, Update, Row>,
) {
  const router = express.Router();
  const read = authorize(prisma, cookieName);
  const write = authorize(prisma, cookieName, "OWNER", "ADMIN", "OPERATOR");
  const archive = authorize(prisma, cookieName, "OWNER", "ADMIN");
  const json = express.json({ limit: "16kb" });

  function mutate<T extends Item>(
    actor: Actor,
    action: RegistrationAction,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return prisma.$transaction(async (tx) => {
      await requireActiveOrganization(tx, actor.organizationId);
      const row = await operation(tx);
      await recordRegistration(tx, actor, catalog.entity, row.id, action);
      return row;
    });
  }

  router.get("/", read, asyncRoute(async (req, res) => {
    const { page, limit } = parseInput(pagination, req.query);
    const { organizationId } = tenantActor(res);
    const rows = await catalog.list(activeScope(organizationId), (page - 1) * limit, limit + 1);
    res.json({ items: rows.slice(0, limit), hasNext: rows.length > limit });
  }));

  router.get("/:id", read, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const { organizationId } = tenantActor(res);
    const row = await catalog.get({ id, ...activeScope(organizationId) });
    if (!row) throw new RequestError(404, "not-found");
    res.json(row);
  }));

  router.post("/", write, json, asyncRoute(async (req, res) => {
    const data = parseInput(catalog.createInput, req.body);
    const actor = tenantActor(res);
    const row = await mutate(actor, "CREATED", (tx) => catalog.create(tx, actor.organizationId, data));
    res.status(201).json(row);
  }));

  router.patch("/:id", write, json, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const data = parseInput(catalog.updateInput, req.body);
    const actor = tenantActor(res);
    const where = { id, ...activeScope(actor.organizationId) };
    const row = await mutate(actor, "UPDATED", (tx) => catalog.update(tx, where, data));
    res.json(row);
  }));

  router.delete("/:id", archive, asyncRoute(async (req, res) => {
    const id = parseInput(recordId, req.params.id);
    const actor = tenantActor(res);
    const where = { id, ...activeScope(actor.organizationId) };
    await mutate(actor, "ARCHIVED", (tx) => catalog.archive(tx, where));
    res.status(204).end();
  }));
  return router;
}
