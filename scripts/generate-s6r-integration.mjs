import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, value) => fs.writeFileSync(file, value);
const requireReplace = (text, needle, replacement, label) => {
  if (!text.includes(needle)) throw new Error(`Missing integration anchor: ${label}`);
  return text.replace(needle, replacement);
};

const packageJson = JSON.parse(read("package.json"));
packageJson.scripts["test:s6r-human-review-dossier"] = "tsx --test server/mlb-s6r-human-review-dossier.test.ts";
packageJson.scripts["typecheck:s6r-human-review-dossier"] = "tsc -p tsconfig.s6r-human-review-dossier.json";
if (!packageJson.scripts["test:s5b-shadow"].includes("mlb-s6r-human-review-dossier.test.ts")) {
  packageJson.scripts["test:s5b-shadow"] += " server/mlb-s6r-human-review-dossier.test.ts";
}
write("package.json", JSON.stringify(packageJson, null, 2) + "\n");

const shadowConfig = JSON.parse(read("tsconfig.s5b-shadow.json"));
for (const file of [
  "server/mlb-s6r-human-review-dossier.ts",
  "server/mlb-s6r-human-review-dossier.test.ts",
]) {
  if (!shadowConfig.include.includes(file)) shadowConfig.include.push(file);
}
write("tsconfig.s5b-shadow.json", JSON.stringify(shadowConfig, null, 2) + "\n");

const routes = JSON.parse(read("server/route-contract.extensions.json"));
for (const route of [
  { method: "GET", path: "/api/mlb/ledger/v1/s6r-human-review-dossier/dossier", registrations: 1 },
  { method: "GET", path: "/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions", registrations: 1 },
  { method: "POST", path: "/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions", registrations: 1 },
  { method: "GET", path: "/api/mlb/ledger/v1/s6r-human-review-dossier/status", registrations: 1 },
]) {
  if (!routes.some((entry) => entry.method === route.method && entry.path === route.path)) routes.push(route);
}
routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
write("server/route-contract.extensions.json", JSON.stringify(routes, null, 2) + "\n");

let entry = read("server/s5b-staging-entry.ts");
entry = requireReplace(
  entry,
  'import { startMlbS6qFiftySettlementHumanReviewWorker } from "./mlb-s6q-fifty-settlement-human-review";\n',
  'import { startMlbS6qFiftySettlementHumanReviewWorker } from "./mlb-s6q-fifty-settlement-human-review";\n'
    + 'import { startMlbS6rHumanReviewDossierWorker, type S6rReviewConclusion, type S6rReviewStage } from "./mlb-s6r-human-review-dossier";\n',
  "S6R import",
);

const s6qStart = `const s6qFiftySettlementHumanReview = startMlbS6qFiftySettlementHumanReviewWorker(
  ledgerStore,
  ownershipStore,
  s6mStatisticalMilestones.service,
  s6pFirstTwentySettlements.service,
  s6kFirstTenCyclesCertification.service,
  { ownerUserId: systemOwnerUserId },
);
`;
entry = requireReplace(
  entry,
  s6qStart,
  s6qStart + `const s6rHumanReviewDossier = startMlbS6rHumanReviewDossierWorker(
  s6qFiftySettlementHumanReview.service,
  { ownerUserId: systemOwnerUserId },
);
`,
  "S6R worker startup",
);

const healthMarker = 'app.get("/health/s6p-first-twenty-settlements", (_req, res) => {';
const healthRoute = `app.get("/health/s6r-human-review-dossier", (_req, res) => {
  const status = s6rHumanReviewDossier.service.status();
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
    maxSnapshots: status.maxSnapshots,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    latest: latest ? {
      state: latest.state,
      sourceS6q: latest.sourceS6q,
      dossier: latest.dossier,
      review: latest.review,
      readiness: latest.readiness,
      persistence: latest.persistence,
      issueCounts: latest.issues.reduce((counts, issue) => {
        counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
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
entry = requireReplace(entry, healthMarker, healthRoute + healthMarker, "S6R health route");

const apiMarker = 'app.get("/api/mlb/ledger/v1/s6p-first-twenty-settlements/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6r-human-review-dossier/status", (_req, res) => {
  const status = s6rHumanReviewDossier.service.status();
  res.json({ success: true, data: status });
});

app.get("/api/mlb/ledger/v1/s6r-human-review-dossier/dossier", (_req, res) => {
  const latest = s6rHumanReviewDossier.service.readLatest();
  const dossier = s6rHumanReviewDossier.service.readDossier();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6R human-review dossier report has completed yet" });
    return;
  }
  res.json({ success: true, data: { latest, dossier } });
});

app.get("/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions", (_req, res) => {
  res.json({ success: true, data: { decisions: s6rHumanReviewDossier.service.readReviewDecisions() } });
});

app.post("/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions", async (req, res) => {
  const reviewerUserId = Number((req as any).user?.id ?? (req as any).session?.passport?.user);
  if (!Number.isInteger(reviewerUserId) || reviewerUserId !== systemOwnerUserId) {
    res.status(403).json({ success: false, error: "Only the configured owner may submit an S6R review decision" });
    return;
  }
  const body = req.body ?? {};
  try {
    const result = await s6rHumanReviewDossier.service.submitReviewDecision({
      stage: String(body.stage ?? "") as S6rReviewStage,
      conclusion: body.conclusion == null ? null : String(body.conclusion) as S6rReviewConclusion,
      rationale: String(body.rationale ?? ""),
      candidateVersion: body.candidateVersion == null ? null : String(body.candidateVersion),
    }, reviewerUserId);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

`;
entry = requireReplace(entry, apiMarker, apiRoutes + apiMarker, "S6R API routes");
write("server/s5b-staging-entry.ts", entry);

console.log("S6R integration generated successfully.");
