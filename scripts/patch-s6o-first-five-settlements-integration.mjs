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
  'import { startMlbS6nFirstRealSettlementMonitorWorker } from "./mlb-s6n-first-real-settlement-monitor";',
  'import { startMlbS6nFirstRealSettlementMonitorWorker } from "./mlb-s6n-first-real-settlement-monitor";\nimport { startMlbS6oFirstFiveSettlementsCertificationWorker } from "./mlb-s6o-first-five-settlements-certification";',
  "S6O import anchor",
);

staging = replaceOnce(
  staging,
  `const s6nFirstRealSettlement = startMlbS6nFirstRealSettlementMonitorWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  `const s6nFirstRealSettlement = startMlbS6nFirstRealSettlementMonitorWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6oFirstFiveSettlements = startMlbS6oFirstFiveSettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6nFirstRealSettlement.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  "S6O worker anchor",
);

const healthAnchor = 'app.get("/health/s6n-first-real-settlement", (_req, res) => {';
const healthRoute = `app.get("/health/s6o-first-five-settlements", (_req, res) => {
  const status = s6oFirstFiveSettlements.service.status();
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
    minimumStabilityMs: status.minimumStabilityMs,
    maxSnapshots: status.maxSnapshots,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    latest: latest ? {
      state: latest.state,
      sourceS6m: latest.sourceS6m,
      sourceS6n: latest.sourceS6n,
      sample: latest.sample,
      target: {
        certificatePresent: latest.target.certificatePresent,
        manifestEntries: latest.target.manifestEntries,
        wins: latest.target.wins,
        losses: latest.target.losses,
        clvAvailable: latest.target.clvAvailable,
      },
      stability: latest.stability,
      checks: latest.checks,
      readiness: latest.readiness,
      persistence: latest.persistence,
      issueCounts: latest.issues.reduce((counts, entry) => {
        counts[entry.severity] = (counts[entry.severity] ?? 0) + 1;
        return counts;
      }, { INFO: 0, WARNING: 0, CRITICAL: 0 }),
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
      probabilitiesChanged: false,
      signalsChanged: false,
      marketsChanged: false,
      thresholdsChanged: false,
      settlementRulesChanged: false,
      stakePolicyChanged: false,
    },
  });
});

`;
if (!staging.includes('/health/s6o-first-five-settlements')) {
  staging = replaceOnce(staging, healthAnchor, healthRoute + healthAnchor, "S6O health route anchor");
}

const apiAnchor = 'app.get("/api/mlb/ledger/v1/s6n-first-real-settlement/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6o-first-five-settlements/status", (_req, res) => {
  const status = s6oFirstFiveSettlements.service.status();
  res.json({
    success: true,
    data: {
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      initialDelayMs: status.initialDelayMs,
      minimumStabilityMs: status.minimumStabilityMs,
      maxSnapshots: status.maxSnapshots,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      latest: status.latest,
    },
  });
});

app.get("/api/mlb/ledger/v1/s6o-first-five-settlements/evidence", (_req, res) => {
  const latest = s6oFirstFiveSettlements.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6O first-five-settlement report has completed yet" });
    return;
  }
  res.json({
    success: true,
    data: {
      latest,
      baseline: s6oFirstFiveSettlements.service.readBaseline(),
      evidence: s6oFirstFiveSettlements.service.readEvidence(),
    },
  });
});

`;
if (!staging.includes('/api/mlb/ledger/v1/s6o-first-five-settlements/status')) {
  staging = replaceOnce(staging, apiAnchor, apiRoutes + apiAnchor, "S6O API route anchor");
}

fs.writeFileSync(stagingPath, staging);

const contractPath = "server/route-contract.extensions.json";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
for (const routePath of [
  "/api/mlb/ledger/v1/s6o-first-five-settlements/evidence",
  "/api/mlb/ledger/v1/s6o-first-five-settlements/status",
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
  "server/mlb-s6o-first-five-settlements-certification.ts",
  "server/mlb-s6o-first-five-settlements-certification.test.ts",
]) {
  if (!shadow.include.includes(file)) shadow.include.push(file);
}
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const testFile = "server/mlb-s6o-first-five-settlements-certification.test.ts";
if (!pkg.scripts["test:s5b-shadow"].includes(testFile)) {
  pkg.scripts["test:s5b-shadow"] += ` ${testFile}`;
}
pkg.scripts["test:s6o-first-five-settlements"] = `tsx --test ${testFile}`;
pkg.scripts["typecheck:s6o-first-five-settlements"] = "tsc -p tsconfig.s6o-first-five-settlements.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Applied S6O Phase 5C-4 integration patch.");
