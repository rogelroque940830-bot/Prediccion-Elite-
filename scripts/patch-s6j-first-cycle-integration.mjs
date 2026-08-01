import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  if (source.includes(after)) return source;
  return source.replace(before, after);
}

const stagingPath = "server/s5b-staging-entry.ts";
let staging = fs.readFileSync(stagingPath, "utf8");
staging = replaceOnce(
  staging,
  'import { startMlbS6iPostfixCertificationWorker } from "./mlb-s6i-postfix-certification";',
  'import { startMlbS6iPostfixCertificationWorker } from "./mlb-s6i-postfix-certification";\nimport { startMlbS6jFirstCycleCertificationWorker } from "./mlb-s6j-first-cycle-certification";',
  "S6J import anchor",
);
staging = replaceOnce(
  staging,
  'const s6iPostfixCertification = startMlbS6iPostfixCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  { ownerUserId: systemOwnerUserId },\n);',
  'const s6iPostfixCertification = startMlbS6iPostfixCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6jFirstCycleCertification = startMlbS6jFirstCycleCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s5eCoverage.service,\n  { ownerUserId: systemOwnerUserId },\n);',
  "S6J worker anchor",
);

const healthAnchor = 'app.get("/api/mlb/ledger/v1/shadow-collection/status", (_req, res) => {';
const healthRoute = `app.get("/health/s6j-first-cycle", (_req, res) => {
  const status = s6jFirstCycleCertification.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    initialDelayMs: status.initialDelayMs,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    latest: latest ? {
      state: latest.state,
      chainLength: latest.lifecycle.chainLength,
      provisionalStages: latest.lifecycle.provisionalStages,
      finalStages: latest.lifecycle.finalStages,
      settled: latest.lifecycle.settled,
      officialVerified: latest.officialVerification.gameFinal && latest.lifecycle.officialGradeResult != null,
      comparableClosingCaptured: latest.lifecycle.comparableClosingCaptured,
      clvCaptured: latest.lifecycle.clvCaptured,
      criticalIssues: latest.issues.filter((entry) => entry.severity === "CRITICAL").length,
      checks: latest.checks,
    } : null,
    safety: latest?.safety ?? {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

`;
if (!staging.includes('/health/s6j-first-cycle')) {
  staging = replaceOnce(staging, healthAnchor, healthRoute + healthAnchor, "S6J health anchor");
}

const apiAnchor = 'app.get("/api/mlb/ledger/v1/shadow-collection/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6j-first-cycle/status", (_req, res) => {
  const status = s6jFirstCycleCertification.service.status();
  res.json({
    success: true,
    data: {
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      initialDelayMs: status.initialDelayMs,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      latest: status.latest ? {
        generatedAt: status.latest.generatedAt,
        state: status.latest.state,
        target: status.latest.target,
        lifecycle: status.latest.lifecycle,
        checks: status.latest.checks,
        persistence: status.latest.persistence,
        issueCounts: status.latest.issues.reduce((counts, entry) => {
          counts[entry.code] = (counts[entry.code] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>),
        safety: status.latest.safety,
      } : null,
    },
  });
});

app.get("/api/mlb/ledger/v1/s6j-first-cycle/evidence", (_req, res) => {
  const latest = s6jFirstCycleCertification.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6J first-cycle report has completed yet" });
    return;
  }
  res.json({ success: true, data: latest });
});

`;
if (!staging.includes('/api/mlb/ledger/v1/s6j-first-cycle/status')) {
  staging = replaceOnce(staging, apiAnchor, apiRoutes + apiAnchor, "S6J API anchor");
}
fs.writeFileSync(stagingPath, staging);

const routePath = "server/route-contract.extensions.json";
const routes = JSON.parse(fs.readFileSync(routePath, "utf8"));
for (const path of [
  "/api/mlb/ledger/v1/s6j-first-cycle/evidence",
  "/api/mlb/ledger/v1/s6j-first-cycle/status",
]) {
  if (!routes.some((entry) => entry.method === "GET" && entry.path === path)) {
    routes.push({ method: "GET", path, registrations: 1 });
  }
}
routes.sort((left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path));
fs.writeFileSync(routePath, `${JSON.stringify(routes, null, 2)}\n`);

const shadowTsconfigPath = "tsconfig.s5b-shadow.json";
const shadowTsconfig = JSON.parse(fs.readFileSync(shadowTsconfigPath, "utf8"));
for (const file of [
  "server/mlb-s6j-first-cycle-certification.ts",
  "server/mlb-s6j-first-cycle-certification.test.ts",
]) {
  if (!shadowTsconfig.include.includes(file)) shadowTsconfig.include.push(file);
}
fs.writeFileSync(shadowTsconfigPath, `${JSON.stringify(shadowTsconfig, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const testFile = "server/mlb-s6j-first-cycle-certification.test.ts";
if (!pkg.scripts["test:s5b-shadow"].includes(testFile)) {
  pkg.scripts["test:s5b-shadow"] += ` ${testFile}`;
}
pkg.scripts["test:s6j-first-cycle"] = `tsx --test ${testFile}`;
pkg.scripts["typecheck:s6j-first-cycle"] = "tsc -p tsconfig.s6j-first-cycle.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Applied S6J Phase 5A integration patch.");
