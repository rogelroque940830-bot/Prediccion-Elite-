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
  'import { startMlbS6lScientificMetricsWorker } from "./mlb-s6l-scientific-metrics";',
  'import { startMlbS6lScientificMetricsWorker } from "./mlb-s6l-scientific-metrics";\nimport { startMlbS6mStatisticalMilestoneWorker } from "./mlb-s6m-statistical-milestones";',
  "S6M import anchor",
);
staging = replaceOnce(
  staging,
  'const s6lScientificMetrics = startMlbS6lScientificMetricsWorker(\n  ledgerStore,\n  ownershipStore,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);',
  'const s6lScientificMetrics = startMlbS6lScientificMetricsWorker(\n  ledgerStore,\n  ownershipStore,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6mStatisticalMilestones = startMlbS6mStatisticalMilestoneWorker(\n  ledgerStore,\n  ownershipStore,\n  s6lScientificMetrics.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);',
  "S6M worker anchor",
);

const healthAnchor = 'app.get("/health/s6l-scientific-metrics", (_req, res) => {';
const healthRoute = `app.get("/health/s6m-statistical-milestones", (_req, res) => {
  const status = s6mStatisticalMilestones.service.status();
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
      sample: latest.sample,
      metricParity: latest.metricParity,
      milestones: latest.milestones,
      highestCertifiedMilestone: latest.highestCertifiedMilestone,
      nextMilestone: latest.nextMilestone,
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
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

`;
if (!staging.includes('/health/s6m-statistical-milestones')) {
  staging = replaceOnce(staging, healthAnchor, healthRoute + healthAnchor, "S6M health route anchor");
}

const apiAnchor = 'app.get("/api/mlb/ledger/v1/s6l-scientific-metrics/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6m-statistical-milestones/status", (_req, res) => {
  const status = s6mStatisticalMilestones.service.status();
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
        sourceS6l: status.latest.sourceS6l,
        sample: status.latest.sample,
        metricParity: status.latest.metricParity,
        milestones: status.latest.milestones,
        highestCertifiedMilestone: status.latest.highestCertifiedMilestone,
        nextMilestone: status.latest.nextMilestone,
        readiness: status.latest.readiness,
        persistence: status.latest.persistence,
        safety: status.latest.safety,
      } : null,
    },
  });
});

app.get("/api/mlb/ledger/v1/s6m-statistical-milestones/report", (_req, res) => {
  const latest = s6mStatisticalMilestones.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6M statistical milestone report has completed yet" });
    return;
  }
  res.json({
    success: true,
    data: {
      ...latest,
      certificates: s6mStatisticalMilestones.service.readCertificates(),
    },
  });
});

`;
if (!staging.includes('/api/mlb/ledger/v1/s6m-statistical-milestones/status')) {
  staging = replaceOnce(staging, apiAnchor, apiRoutes + apiAnchor, "S6M API route anchor");
}
fs.writeFileSync(stagingPath, staging);

const contractPath = "server/route-contract.extensions.json";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
for (const routePath of [
  "/api/mlb/ledger/v1/s6m-statistical-milestones/report",
  "/api/mlb/ledger/v1/s6m-statistical-milestones/status",
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
  "server/mlb-s6m-statistical-milestones.ts",
  "server/mlb-s6m-statistical-milestones.test.ts",
]) {
  if (!shadow.include.includes(file)) shadow.include.push(file);
}
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const testFile = "server/mlb-s6m-statistical-milestones.test.ts";
if (!pkg.scripts["test:s5b-shadow"].includes(testFile)) {
  pkg.scripts["test:s5b-shadow"] += ` ${testFile}`;
}
pkg.scripts["test:s6m-statistical-milestones"] = `tsx --test ${testFile}`;
pkg.scripts["typecheck:s6m-statistical-milestones"] = "tsc -p tsconfig.s6m-statistical-milestones.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Applied S6M Phase 5C-2 integration patch.");
