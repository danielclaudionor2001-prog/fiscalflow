import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function protectBrowserRequests(webOrigin: string): RequestHandler {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("Origin") !== webOrigin) {
      res.status(403).json({ code: "origin-not-allowed" });
      return;
    }
    next();
  };
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, "invalid-input");
  return result.data;
}

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}

export const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof RequestError) {
    res.status(error.status).json({ code: error.code });
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    res.status(409).json({ code: "duplicate-registration" });
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    res.status(404).json({ code: "not-found" });
  } else if (error?.type === "entity.too.large") {
    res.status(413).json({ code: "invalid-input" });
  } else if (error?.status === 400 || error?.status === 415) {
    res.status(error.status).json({ code: "invalid-input" });
  } else {
    console.error("API request failed.");
    res.status(500).json({ code: "internal-error" });
  }
};
