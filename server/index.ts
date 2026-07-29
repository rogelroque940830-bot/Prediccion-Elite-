import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerStagingAdminAuthObservation } from "./staging-admin-auth";
import { createServer } from "http";
import {
  apiRateLimit,
  requirePrivateReadAuth,
  requireWriteAuth,
  restrictedCors,
  securityHeaders,
} from "./security";
import {
  createSessionMiddleware,
  initializeAuthPersistence,
  registerAuthRoutes,
} from "./auth";
import { registerPicksV2Routes } from "./picks-v2";
import { getMlbClosingLineStore, getMlbLedgerStore, registerMlbLedgerRoutes } from "./mlb-ledger";
import { startMlbSettlementWorker } from "./mlb-settlement-worker";
import { startMlbClosingLineWorker } from "./mlb-closing-line-worker";

export const app = express();
// Railway terminates TLS and forwards one trusted proxy hop.
app.set("trust proxy", 1);
const httpServer = createServer(app);
const deploymentCommit =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  "unknown";

const missingApiVariables = ["BDL_API_KEY", "ODDS_API_KEY"].filter(
  (name) => !process.env[name],
);
if (missingApiVariables.length > 0) {
  console.warn(
    `[config] Variables API faltantes: ${missingApiVariables.join(", ")}`,
  );
}

const authDatabase = initializeAuthPersistence();

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Security boundary for the independent frontend.
app.use(securityHeaders);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(createSessionMiddleware(authDatabase));

app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(
  express.urlencoded({
    extended: false,
    limit: process.env.FORM_BODY_LIMIT || "256kb",
  }),
);

// Staging-only visibility. This observer never authorizes a request;
// the real enforcement remains in the read/write guards below.
registerStagingAdminAuthObservation(app);
app.use(requirePrivateReadAuth);
app.use(requireWriteAuth);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "CourtEdge Backend", version: "1.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    commit: deploymentCommit,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
    mlbLedgerAutoSettlement: process.env.MLB_LEDGER_AUTO_SETTLE !== "false",
    mlbClosingLineCapture: process.env.MLB_CLOSING_LINE_CAPTURE !== "false",
    authPersistence: true,
    authSessionStore: "sqlite",
    authRoles: ["admin", "analyst", "viewer"],
    privateReadProtection: true,
  });
});

(async () => {
  registerAuthRoutes(app, authDatabase);
  // Canonical v2 routes must precede historical handlers.
  registerPicksV2Routes(app);
  // Scientific MLB ledger: append-only predictions, settlements and reports.
  registerMlbLedgerRoutes(app);
  const mlbLedgerStore = getMlbLedgerStore();
  const mlbClosingLineStore = getMlbClosingLineStore();
  // Pregame closing prices and official results are append-only workers.
  startMlbClosingLineWorker(mlbLedgerStore, mlbClosingLineStore);
  startMlbSettlementWorker(mlbLedgerStore, mlbClosingLineStore);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message =
      status >= 500 ? "Internal Server Error" : err.message || "Request failed";

    console.error("Request error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`CourtEdge Backend serving on port ${port} commit ${deploymentCommit}`);
    },
  );
})();
