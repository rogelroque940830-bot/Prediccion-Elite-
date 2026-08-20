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
import {
  getUserPickFileStore,
  registerPicksV2MultiuserRoutes,
} from "./picks-v2-multiuser";
import { getMlbClosingLineStore, getMlbLedgerStore } from "./mlb-ledger";
import { registerMlbLedgerMultiuserRoutes } from "./mlb-ledger-multiuser";
import { registerMlbOwnedExportRoute } from "./mlb-ledger-owned-export";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { resolveSystemOwnerUserId } from "./user-data-context";
import { startMlbSettlementWorker } from "./mlb-settlement-worker";
import { createMlbSettlementStoreView } from "./mlb-settlement-lightweight-store";
import { startMlbClosingLineWorker } from "./mlb-closing-line-worker";
import { isMlbClosingLineCaptureEnabled } from "./odds-demand-policy";
import { getOperationalBackupService } from "./operational-backup";
import { startOperationalBackupWorker } from "./operational-backup-worker";
import { registerOperationalRoutes } from "./operational-routes";
import { getOperationalRestoreDrillService } from "./operational-restore-drill";
import { registerOperationalRestoreDrillRoutes } from "./operational-restore-routes";
import { getOperationalObservabilityService } from "./operational-observability";
import { OperationalDiagnosticsService } from "./operational-diagnostics";
import { OperationalAlertService } from "./operational-alerts";
import { startOperationalAlertWorker } from "./operational-alert-worker";
import { registerOperationalObservabilityRoutes } from "./operational-observability-routes";
import { OperationalSlaAlertService } from "./operational-sla-alerts";
import { createActiveOperationalIncidentCenterProvider } from "./operational-incident-center-active";
import { registerOperationalSlaAlertRoutes } from "./operational-sla-alert-routes";
import { startOperationalSlaAlertWorker } from "./operational-sla-alert-worker";
import { createActiveOperationalReprocessingService } from "./operational-reprocessing-active";
import { registerOperationalReprocessingRoutes } from "./operational-reprocessing-routes";
import { createOperationalEvidenceRepairService } from "./operational-evidence-repair";
import { registerOperationalEvidenceRepairRoutes } from "./operational-evidence-repair-routes";

export const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);
const deploymentCommit =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  "unknown";
const mlbClosingLineCaptureEnabled = isMlbClosingLineCaptureEnabled();

const missingApiVariables = ["BDL_API_KEY", "ODDS_API_KEY"].filter(
  (name) => !process.env[name],
);
if (missingApiVariables.length > 0) {
  console.warn(
    `[config] Variables API faltantes: ${missingApiVariables.join(", ")}`,
  );
}

const authDatabase = initializeAuthPersistence();
const systemOwnerUserId = resolveSystemOwnerUserId(authDatabase);
const mlbLedgerStore = getMlbLedgerStore();
const mlbClosingLineStore = getMlbClosingLineStore();
const mlbOwnershipStore = getMlbLedgerOwnershipStore();
const ledgerOwnershipMigration = mlbOwnershipStore.ensureExistingOwnership(
  mlbLedgerStore,
  systemOwnerUserId,
);
const userPickStore = getUserPickFileStore();
const pickOwnershipMigration = userPickStore.migrationStatus(systemOwnerUserId);
const operationalBackupService = getOperationalBackupService();
const operationalRestoreDrillService = getOperationalRestoreDrillService(operationalBackupService);
const operationalObservability = getOperationalObservabilityService();
const operationalDiagnostics = new OperationalDiagnosticsService({
  backup: () => operationalBackupService.status(),
  restoreDrill: () => operationalRestoreDrillService.status(),
  ledger: () => mlbLedgerStore.status(),
  ownership: () => mlbOwnershipStore.status(),
  picks: () => userPickStore.migrationStatus(systemOwnerUserId),
  metrics: () => operationalObservability.snapshot(),
});
const operationalAlerts = new OperationalAlertService(
  operationalDiagnostics,
  operationalBackupService.getRoot(),
);
const activeIncidentProvider = createActiveOperationalIncidentCenterProvider(systemOwnerUserId);
const operationalSlaAlerts = new OperationalSlaAlertService(
  activeIncidentProvider,
  operationalBackupService.getRoot(),
);
const operationalReprocessing = createActiveOperationalReprocessingService(
  systemOwnerUserId,
  operationalBackupService.getRoot(),
);
const operationalEvidenceRepair = createOperationalEvidenceRepairService(
  systemOwnerUserId,
  operationalBackupService.getRoot(),
);

if (ledgerOwnershipMigration.remainingUnowned > 0) {
  console.error(
    `[s2] ${ledgerOwnershipMigration.remainingUnowned} MLB predictions remain without an owner`,
  );
}

console.log(
  `[s2] ownership ready: ledger migrated=${ledgerOwnershipMigration.migrated} ` +
    `repaired=${ledgerOwnershipMigration.repaired} picks=${pickOwnershipMigration.records}`,
);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(securityHeaders);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(createSessionMiddleware(authDatabase));
app.use(operationalObservability.middleware());

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
  const requestPath = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (requestPath.startsWith("/api")) {
      log(`${req.method} ${requestPath} ${res.statusCode} in ${duration}ms`);
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
    mlbClosingLineCapture: mlbClosingLineCaptureEnabled,
    authPersistence: true,
    authSessionStore: "sqlite",
    authRoles: ["admin", "analyst", "viewer"],
    privateReadProtection: true,
    multiUserOwnership: true,
    ownershipStore: "sqlite-append-only",
    ledgerOwnership: mlbOwnershipStore.status(),
    pickOwnership: pickOwnershipMigration,
    operationalBackup: operationalBackupService.status(),
    operationalRestoreDrill: operationalRestoreDrillService.status(),
    operationalDiagnostics: (() => { const report = operationalDiagnostics.evaluate(); return { status: report.status, checkedAt: report.checkedAt, counts: report.counts }; })(),
    operationalAlerts: operationalAlerts.status(),
    operationalSlaAlerts: operationalSlaAlerts.status(systemOwnerUserId),
    operationalReprocessing: operationalReprocessing.status(systemOwnerUserId),
    operationalEvidenceRepair: operationalEvidenceRepair.status(systemOwnerUserId),
  });
});

(async () => {
  registerAuthRoutes(app, authDatabase);
  registerPicksV2MultiuserRoutes(app, systemOwnerUserId, userPickStore);
  registerMlbOwnedExportRoute(app);
  registerMlbLedgerMultiuserRoutes(app);
  registerOperationalRoutes(app, operationalBackupService);
  registerOperationalRestoreDrillRoutes(app, operationalRestoreDrillService);
  registerOperationalObservabilityRoutes(app, operationalObservability, operationalDiagnostics, operationalAlerts);
  registerOperationalSlaAlertRoutes(app, operationalSlaAlerts);
  registerOperationalReprocessingRoutes(app, operationalReprocessing);
  registerOperationalEvidenceRepairRoutes(app, operationalEvidenceRepair);
  if (mlbClosingLineCaptureEnabled) {
    startMlbClosingLineWorker(mlbLedgerStore, mlbClosingLineStore);
  } else {
    log("MLB closing-line provider worker disabled; explicit MLB_CLOSING_LINE_CAPTURE=true is required", "odds");
  }
  startMlbSettlementWorker(createMlbSettlementStoreView(mlbLedgerStore), mlbClosingLineStore);
  startOperationalBackupWorker(operationalBackupService);
  startOperationalAlertWorker(operationalAlerts);
  startOperationalSlaAlertWorker(operationalSlaAlerts, systemOwnerUserId);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message =
      status >= 500 ? "Internal Server Error" : err.message || "Request failed";
    console.error("Request error:", err);
    operationalObservability.recordError(_req.method, _req.path, status, err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    { port, host: "0.0.0.0" },
    () => log(`CourtEdge Backend serving on port ${port} commit ${deploymentCommit}`),
  );
})();
