import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const stagingPath = "server/s5b-staging-entry.ts";
let staging = fs.readFileSync(stagingPath, "utf8");
staging = replaceOnce(
  staging,
  'import { startMlbS6jFirstCycleCertificationWorker } from "./mlb-s6j-first-cycle-certification";',
  'import { startMlbS6jFirstCycleCertificationWorker } from "./mlb-s6j-first-cycle-certification";\nimport { startMlbS6kFirstTenCyclesCertificationWorker } from "./mlb-s6k-first-ten-cycles-certification";',
  "S6K import anchor",
);
staging = replaceOnce(
  staging,
  'const s6jFirstCycleCertification = startMlbS6jFirstCycleCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s5eCoverage.service,\n  { ownerUserId: systemOwnerUserId },\n);',
  'const s6jFirstCycleCertification = startMlbS6jFirstCycleCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s5eCoverage.service,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6kFirstTenCyclesCertification = startMlbS6kFirstTenCyclesCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s5eCoverage.service,\n  { ownerUserId: systemOwnerUserId },\n);',
  "S6K worker anchor",
);

const routeAnchor = 'app.get("/api/mlb/ledger/v1/s6j-first-cycle/status", (_req, res) => {';
const routes = `app.get("/health/s6k-first-ten-cycles", (_req, res) => {
  const status = s6kFirstTenCyclesCertification.service.status();
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
      summary: latest.summary,
      readyForAnalysis: latest.readyForAnalysis,
      persistence: latest.persistence,
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

app.get("/api/mlb/ledger/v1/s6k-first-ten-cycles/status", (_req, res) => {
  const status = s6kFirstTenCyclesCertification.service.status();
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
        cohort: status.latest.cohort,
        summary: status.latest.summary,
        cycles: status.latest.cycles,
        persistence: status.latest.persistence,
        readyForAnalysis: status.latest.readyForAnalysis,
        safety: status.latest.safety,
      } : null,
    },
  });
});

app.get("/api/mlb/ledger/v1/s6k-first-ten-cycles/evidence", (_req, res) => {
  const latest = s6kFirstTenCyclesCertification.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6K first-ten-cycle report has completed yet" });
    return;
  }
  res.json({ success: true, data: latest });
});

`;
if (!staging.includes('/health/s6k-first-ten-cycles')) {
  staging = replaceOnce(staging, routeAnchor, routes + routeAnchor, "S6K route anchor");
}
fs.writeFileSync(stagingPath, staging);

const contractPath = "server/route-contract.extensions.json";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
for (const routePath of [
  "/api/mlb/ledger/v1/s6k-first-ten-cycles/evidence",
  "/api/mlb/ledger/v1/s6k-first-ten-cycles/status",
]) {
  if (!contract.some((entry) => entry.method === "GET" && entry.path === routePath)) {
    contract.push({ method: "GET", path: routePath, registrations: 1 });
  }
}
contract.sort((left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path));
fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

const shadowPath = "tsconfig.s5b-shadow.json";
const shadow = JSON.parse(fs.readFileSync(shadowPath, "utf8"));
for (const file of [
  "server/mlb-s6k-first-ten-cycles-certification.ts",
  "server/mlb-s6k-first-ten-cycles-certification.test.ts",
]) {
  if (!shadow.include.includes(file)) shadow.include.push(file);
}
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const testFile = "server/mlb-s6k-first-ten-cycles-certification.test.ts";
if (!pkg.scripts["test:s5b-shadow"].includes(testFile)) {
  pkg.scripts["test:s5b-shadow"] += ` ${testFile}`;
}
pkg.scripts["test:s6k-first-ten"] = `tsx --test ${testFile}`;
pkg.scripts["typecheck:s6k-first-ten"] = "tsc -p tsconfig.s6k-first-ten.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Applied S6K Phase 5B integration patch.");
