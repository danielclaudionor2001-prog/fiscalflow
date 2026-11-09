import cors from "cors";
import express, { type Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

export function createApp(
  webOrigin: string,
  checkDatabase: () => Promise<void>,
  authRouter?: Router,
  trustedProxyIps: string[] = [],
  registrationsRouter?: Router,
) {
  const app = express();

  if (trustedProxyIps.length) app.set("trust proxy", trustedProxyIps);
  app.use(helmet());
  app.use(cors({ origin: webOrigin, credentials: true }));
  app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { status: "rate-limited" },
  }));

  app.get("/api/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ name: "FiscalFlow API", status: "ok", fiscalIntegration: "not-configured" });
  });

  app.get("/api/health/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await checkDatabase();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  if (authRouter) app.use("/api/auth", authRouter);
  if (registrationsRouter) app.use("/api", registrationsRouter);
  return app;
}
