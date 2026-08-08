import crypto from "node:crypto";
import fs from "node:fs";

const [ledgerPath, healthPath, statusPath, outputPath] = process.argv.slice(2);
if (!ledgerPath || !healthPath || !statusPath || !outputPath) {
  throw new Error("USAGE: node scripts/p1-ultrapremium-economic-forensic.mjs <ledger.jsonl> <health.json> <status.json> <output.json>");
}

const EXPECTED_BACKEND_COMMIT = process.env.EXPECTED_BACKEND_COMMIT || null;

const HISTORICAL_RULE_REGISTRY = [
  {
    id: "F1_F3_CORE_FILTERS",
    commit: "f977d412a13a9d6a8cd2763f45156aa08e66d530",
    definedAt: "2026-07-07T21:07:19Z",
    market: "F5_ML",
    rule: "PASS when ERE_diff<10; PASS when ERE_pick<45; PASS when modelProb>=0.65 and confidence=HIGH.",
    developmentEvidence: "TEST n=92; surviving set n=27, 24W-3L, +18.84u, ROI +69.8% as reported in commit message.",
  },
  {
    id: "F4_RIVAL_XWOBA_GRAY_ZONE",
    commit: "a6d5b9a8c25b0368704f1f2fe4f1720a16e9b6c3",
    definedAt: "2026-07-08T01:44:08Z",
    market: "F5_ML",
    rule: "PASS when rival xwOBA TTO1 is in [0.28,0.32).",
    developmentEvidence: "TRAIN n=76 hit 42.1%; TEST n=22 hit 36.4%, -6.72u as reported in commit message.",
  },
  {
    id: "TT_OVER15_STRONG_EARLY_PREMIUM",
    commit: "7f8c69158f40881cc14fe55b53d9bd8065870785",
    definedAt: "2026-07-08T04:36:19Z",
    market: "TT_OVER_15_F5",
    rule: "PREMIUM badge when ERE category=STRONG_EARLY.",
    developmentEvidence: "TEST n=22 hit 95.5%; display rounded this to 96% historical hit and ranking probability floor was 0.85.",
  },
  {
    id: "F5_ML_PREMIUM",
    commit: "9af92ddb12a90f9f75f7d5f297fe51d80395abd9",
    definedAt: "2026-07-08T05:03:11Z",
    market: "F5_ML",
    rule: "Among surviving F5 filters: PREMIUM when ERE_diff>=20 OR ERE_pick>=65.",
    developmentEvidence: "Each reported TEST bucket was 6/6; ranking probability floor was 0.97. This was not a calibrated-probability estimate.",
  },
  {
    id: "F6_F8_DEEP_FILTERS",
    commit: "611a4e2ae0c0a705f522ebb0cc8cef992589a0bb",
    definedAt: "2026-07-11T02:57:09Z",
    market: "F5_ML",
    rule: "PASS rival F5 WHIP [1.2,1.7); PASS pick pitcher suppression [60,75); PASS rival F5 ERA>=5.5.",
    developmentEvidence: "Individual TEST blocked buckets: 40.5%, 25.0%, 36.4% hit respectively; commit projected surviving hit rate 78-83% rather than reporting a combined ULTRA result.",
  },
  {
    id: "F5_ML_ULTRA",
    commit: "3445ec667be0721cc6b3d7ce809105fa19418860",
    definedAt: "2026-07-11T03:11:19Z",
    market: "F5_ML",
    rule: "ULTRA badge when 2+ boost signals: IMPLOSION, ERA_DECLINE, QUALITY_BAD, H2H_STRUGGLE, SOS_INFLATED.",
    developmentEvidence: "Commit reported individual boost TEST hit rates 65.0-72.4%; it did NOT report a combined 2+ boost ULTRA hit rate. The implementation could display ULTRA independently of isPremiumF5.",
  },
  {
    id: "F9_MISSING_F5_DATA",
    commit: "0ab142b6f62fbff62074be00aa71194be6427e71",
    definedAt: "2026-07-11T03:50:43Z",
    market: "F5_ML",
    rule: "PASS when rival F5 data missing/insufficient or recent-form evidence absent.",
    developmentEvidence: "Added after a live failure exposed that missing rival data bypassed prior hard filters.",
  },
];

const BOOST_TOKENS = ["IMPLOSION", "ERA_DECLINE", "QUALITY_BAD", "H2H_STRUGGLE", "SOS_INFLATED"];
const BINARY_RESULTS = new Set(["WIN", "LOSS"]);
const SETTLED_RESULTS = new Set(["WIN", "LOSS", "PUSH", "VOID", "HALF_WIN", "HALF_LOSS"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoMs(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const i = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[i] : (usable[i - 1] + usable[i]) / 2;
}

function americanToProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function winProfit(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function flatOutcome(result, odds) {
  const wp = winProfit(odds);
  if (result === "WIN") return wp == null ? null : { exposure: 1, profit: wp };
  if (result === "LOSS") return { exposure: 1, profit: -1 };
  if (result === "PUSH") return { exposure: 1, profit: 0 };
  if (result === "VOID") return { exposure: 0, profit: 0 };
  if (result === "HALF_WIN") return wp == null ? null : { exposure: 1, profit: wp / 2 };
  if (result === "HALF_LOSS") return { exposure: 1, profit: -0.5 };
  return null;
}

function wilson95(wins, total) {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = wins / total;
  const d = 1 + (z * z) / total;
  const c = (p + (z * z) / (2 * total)) / d;
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / d;
  return { lowPct: round(Math.max(0, c - m) * 100, 2), highPct: round(Math.min(1, c + m) * 100, 2) };
}

function collectStrings(value, path = "$", out = []) {
  if (typeof value === "string") {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) collectStrings(value[i], `${path}[${i}]`, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectStrings(child, `${path}.${key}`, out);
  }
  return out;
}

function collectKeyPaths(value, wanted, path = "$", out = []) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) collectKeyPaths(value[i], wanted, `${path}[${i}]`, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (wanted.has(key)) out.push(childPath);
      collectKeyPaths(child, wanted, childPath, out);
    }
  }
  return out;
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = String(keyFn(row) ?? "UNKNOWN");
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function priceBand(odds) {
  if (!Number.isFinite(odds)) return "UNKNOWN";
  if (odds <= -200) return "<=-200";
  if (odds <= -150) return "-199_TO_-150";
  if (odds <= -110) return "-149_TO_-110";
  if (odds <= 110) return "-109_TO_+110";
  if (odds <= 150) return "+111_TO_+150";
  if (odds <= 200) return "+151_TO_+200";
  return ">+200";
}

function monthKey(row) {
  const d = row.gameDate;
  return typeof d === "string" && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "UNKNOWN";
}

function summarize(rows) {
  const settled = rows.filter((r) => SETTLED_RESULTS.has(r.result));
  const binary = rows.filter((r) => BINARY_RESULTS.has(r.result));
  const wins = binary.filter((r) => r.result === "WIN").length;
  const losses = binary.filter((r) => r.result === "LOSS").length;

  let exposure = 0;
  let profit = 0;
  const chronological = [];
  for (const row of [...settled].sort((a, b) => (a.recordedAtMs ?? 0) - (b.recordedAtMs ?? 0))) {
    const outcome = flatOutcome(row.result, row.oddsAmerican);
    if (!outcome) continue;
    exposure += outcome.exposure;
    profit += outcome.profit;
    chronological.push(outcome.profit);
  }

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let currentLosingStreak = 0;
  let maxLosingStreak = 0;
  for (const p of chronological) {
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    if (p < 0) {
      currentLosingStreak += 1;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
    } else if (p > 0) {
      currentLosingStreak = 0;
    }
  }

  const modelProb = binary.map((r) => r.modelProbability).filter(Number.isFinite);
  const implied = settled.map((r) => americanToProbability(r.oddsAmerican)).filter(Number.isFinite);
  const clv = settled.map((r) => r.clvPp).filter(Number.isFinite);
  const observed = binary.length ? wins / binary.length : null;
  const meanModel = average(modelProb);

  return {
    records: rows.length,
    pending: rows.filter((r) => r.result == null).length,
    settled: settled.length,
    binaryDecisions: binary.length,
    wins,
    losses,
    observedWinRatePct: observed == null ? null : round(observed * 100, 3),
    winRateWilson95: wilson95(wins, binary.length),
    meanModelProbabilityPct: meanModel == null ? null : round(meanModel * 100, 3),
    calibrationGapPp: observed == null || meanModel == null ? null : round((meanModel - observed) * 100, 3),
    meanEntryImpliedProbabilityPct: implied.length ? round(average(implied) * 100, 3) : null,
    medianEntryOddsAmerican: median(settled.map((r) => r.oddsAmerican)),
    flatStakeExposureUnits: round(exposure, 4),
    flatStakeProfitUnits: round(profit, 4),
    flatStakeRoiPct: exposure > 0 ? round((profit / exposure) * 100, 3) : null,
    maxDrawdownUnits: round(maxDrawdown, 4),
    longestLosingStreak: maxLosingStreak,
    clvAvailable: clv.length,
    clvCoveragePct: settled.length ? round((clv.length / settled.length) * 100, 2) : null,
    meanClvPp: clv.length ? round(average(clv), 4) : null,
    medianClvPp: clv.length ? round(median(clv), 4) : null,
    positiveClvPct: clv.length ? round((clv.filter((v) => v > 0).length / clv.length) * 100, 2) : null,
    sources: countBy(rows, (r) => r.source),
    stages: countBy(rows, (r) => r.stage),
    priceBands: Object.fromEntries([...new Set(rows.map((r) => priceBand(r.oddsAmerican)))].sort().map((band) => [band, summarizeLeaf(rows.filter((r) => priceBand(r.oddsAmerican) === band))])),
    months: Object.fromEntries([...new Set(rows.map(monthKey))].sort().map((month) => [month, summarizeLeaf(rows.filter((r) => monthKey(r) === month))])),
  };
}

function summarizeLeaf(rows) {
  const binary = rows.filter((r) => BINARY_RESULTS.has(r.result));
  const settled = rows.filter((r) => SETTLED_RESULTS.has(r.result));
  const wins = binary.filter((r) => r.result === "WIN").length;
  let exposure = 0;
  let profit = 0;
  for (const row of settled) {
    const outcome = flatOutcome(row.result, row.oddsAmerican);
    if (!outcome) continue;
    exposure += outcome.exposure;
    profit += outcome.profit;
  }
  return {
    records: rows.length,
    settled: settled.length,
    wins,
    losses: binary.filter((r) => r.result === "LOSS").length,
    hitRatePct: binary.length ? round((wins / binary.length) * 100, 2) : null,
    profitUnits: round(profit, 4),
    roiPct: exposure > 0 ? round((profit / exposure) * 100, 2) : null,
  };
}

function pathFrequency(rows, field) {
  const counts = {};
  for (const row of rows) {
    for (const path of row[field] || []) counts[path] = (counts[path] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30));
}

const raw = fs.readFileSync(ledgerPath, "utf8");
const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
const records = lines.map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`ULTRAPREMIUM_OWNER_EXPORT_JSON_INVALID:${index + 1}`); }
});

assert(health.status === "healthy", `HEALTH_NOT_HEALTHY:${health.status}`);
if (EXPECTED_BACKEND_COMMIT) assert(health.commit === EXPECTED_BACKEND_COMMIT, `BACKEND_COMMIT_MISMATCH:${health.commit}:${EXPECTED_BACKEND_COMMIT}`);
assert(status.success === true, "LEDGER_STATUS_NOT_SUCCESS");
assert(status.data?.schemaVersion === "mlb-ledger.v1", `LEDGER_SCHEMA_MISMATCH:${status.data?.schemaVersion}`);
assert(status.data?.immutable === true, "LEDGER_NOT_IMMUTABLE");
assert(records.length === status.data?.predictions, `OWNER_EXPORT_INCOMPLETE:${records.length}/${status.data?.predictions}`);
assert(status.data?.ownership?.unownedPredictions === 0, `UNOWNED_PREDICTIONS:${status.data?.ownership?.unownedPredictions}`);

const wantedKeys = new Set(["ereScore", "boostSignals", "finalRecommendation", "category", "ereDiff", "f5InningData", "pitcherSuppressionScore"]);
const normalized = [];
for (const record of records) {
  const prediction = record?.prediction;
  if (!prediction || typeof prediction !== "object") continue;
  const settlement = record?.settlement && typeof record.settlement === "object" ? record.settlement : null;
  const strings = collectStrings(prediction);
  const keyPaths = collectKeyPaths(prediction, wantedKeys);
  const upperStrings = strings.map((s) => s.value.toUpperCase());
  const ultra = upperStrings.some((s) => /(^|[^A-Z])ULTRA([^A-Z]|$)/.test(s));
  const premium = upperStrings.some((s) => /(^|[^A-Z])PREMIUM([^A-Z]|$)/.test(s));
  const strongEarly = upperStrings.some((s) => s.includes("STRONG_EARLY"));
  const eliteEarly = upperStrings.some((s) => s.includes("ELITE_EARLY"));
  const boostTypes = BOOST_TOKENS.filter((token) => upperStrings.some((s) => s.includes(token)));
  const ultraPaths = strings.filter((s) => /(^|[^A-Z])ULTRA([^A-Z]|$)/i.test(s.value)).map((s) => s.path);
  const premiumPaths = strings.filter((s) => /(^|[^A-Z])PREMIUM([^A-Z]|$)/i.test(s.value)).map((s) => s.path);

  const market = prediction.market?.type ?? null;
  const oddsAmerican = finite(prediction.market?.oddsAmerican);
  const recordedAt = prediction.recordedAt ?? null;
  const recordedAtMs = isoMs(recordedAt);
  const commenceTime = prediction.game?.commenceTime ?? null;
  const commenceTimeMs = isoMs(commenceTime);
  const source = prediction.source ?? prediction.payload?.source ?? null;
  const stage = prediction.analysisStage ?? prediction.payload?.analysis?.stage ?? null;
  const modelProbability = finite(prediction.probabilities?.model ?? prediction.payload?.probabilities?.model);
  const result = settlement?.result ?? null;
  const clvPp = finite(settlement?.clvPp);
  const gameDate = prediction.game?.gameDate ?? null;
  const pregame = recordedAtMs != null && commenceTimeMs != null && recordedAtMs < commenceTimeMs;
  const leadMinutes = pregame ? (commenceTimeMs - recordedAtMs) / 60000 : null;

  normalized.push({
    market,
    oddsAmerican,
    recordedAt,
    recordedAtMs,
    commenceTime,
    commenceTimeMs,
    gameDate,
    source,
    stage,
    modelProbability,
    result,
    clvPp,
    pregame,
    leadMinutes,
    ultra,
    premium,
    strongEarly,
    eliteEarly,
    boostTypes,
    ultraPaths,
    premiumPaths,
    keyPaths,
    hasEreScoreKey: keyPaths.some((p) => p.endsWith(".ereScore")),
    hasBoostSignalsKey: keyPaths.some((p) => p.endsWith(".boostSignals")),
    hasFinalRecommendationKey: keyPaths.some((p) => p.endsWith(".finalRecommendation")),
  });
}

const ultraDefinedAtMs = isoMs("2026-07-11T03:11:19Z");
const premiumF5DefinedAtMs = isoMs("2026-07-08T05:03:11Z");
const premiumTtDefinedAtMs = isoMs("2026-07-08T04:36:19Z");

const groups = {
  explicitUltraF5All: normalized.filter((r) => r.market === "F5_ML" && r.ultra),
  explicitUltraF5ProspectiveApp: normalized.filter((r) => r.market === "F5_ML" && r.ultra && r.recordedAtMs >= ultraDefinedAtMs && r.pregame && r.source === "app"),
  explicitUltraF5ProspectiveAnyNonBackfill: normalized.filter((r) => r.market === "F5_ML" && r.ultra && r.recordedAtMs >= ultraDefinedAtMs && r.pregame && !["backfill", "migration"].includes(r.source)),
  explicitUltraAndPremiumF5All: normalized.filter((r) => r.market === "F5_ML" && r.ultra && r.premium),
  explicitUltraWithoutPremiumF5All: normalized.filter((r) => r.market === "F5_ML" && r.ultra && !r.premium),
  explicitPremiumF5All: normalized.filter((r) => r.market === "F5_ML" && r.premium),
  explicitPremiumF5ProspectiveApp: normalized.filter((r) => r.market === "F5_ML" && r.premium && r.recordedAtMs >= premiumF5DefinedAtMs && r.pregame && r.source === "app"),
  explicitPremiumTtOverAll: normalized.filter((r) => r.market === "TT_OVER_15_F5" && r.premium),
  explicitPremiumStrongEarlyTtOverAll: normalized.filter((r) => r.market === "TT_OVER_15_F5" && r.premium && r.strongEarly),
  explicitPremiumStrongEarlyTtOverProspectiveApp: normalized.filter((r) => r.market === "TT_OVER_15_F5" && r.premium && r.strongEarly && r.recordedAtMs >= premiumTtDefinedAtMs && r.pregame && r.source === "app"),
};

const groupSummaries = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, summarize(rows)]));

const allUltraRows = normalized.filter((r) => r.ultra);
const allPremiumRows = normalized.filter((r) => r.premium);
const historicalTokens = {
  ultraRecords: allUltraRows.length,
  premiumRecords: allPremiumRows.length,
  strongEarlyRecords: normalized.filter((r) => r.strongEarly).length,
  eliteEarlyRecords: normalized.filter((r) => r.eliteEarly).length,
  recordsWithEreScoreKey: normalized.filter((r) => r.hasEreScoreKey).length,
  recordsWithBoostSignalsKey: normalized.filter((r) => r.hasBoostSignalsKey).length,
  recordsWithFinalRecommendationKey: normalized.filter((r) => r.hasFinalRecommendationKey).length,
  boostTokenRecords: Object.fromEntries(BOOST_TOKENS.map((token) => [token, normalized.filter((r) => r.boostTypes.includes(token)).length])),
  ultraStringPathFrequency: pathFrequency(allUltraRows, "ultraPaths"),
  premiumStringPathFrequency: pathFrequency(allPremiumRows, "premiumPaths"),
  ereKeyPathFrequency: pathFrequency(normalized.filter((r) => r.hasEreScoreKey), "keyPaths"),
};

const reconstructability = {
  exactHistoricalLabelReplayFromLedgerPossible: groups.explicitUltraF5All.length > 0 || groups.explicitPremiumF5All.length > 0 || groups.explicitPremiumTtOverAll.length > 0,
  exactRuleRecomputationFromStoredEreInputsPotentiallyPossible: normalized.some((r) => r.hasEreScoreKey && r.hasFinalRecommendationKey),
  boostRuleRecomputationFromStoredInputsPotentiallyPossible: normalized.some((r) => r.hasBoostSignalsKey),
  note: "Label-based evaluation is valid only for labels present in the immutable pregame prediction payload. Full rule recomputation requires the underlying ERE/boost inputs to be present; this report does not synthesize missing historical inputs.",
};

const pregameAll = normalized.filter((r) => r.pregame);
const result = {
  schemaVersion: "p1-ultrapremium-economic-forensic.v1",
  generatedAt: new Date().toISOString(),
  hypothesis: {
    alternative: "Historically identifiable PREMIUM/ULTRA pregame decisions retain positive economic value on genuinely prospective, non-backfilled decisions after the rule-definition timestamps.",
    null: "The apparent high hit rates do not translate into robust prospective economic value once development/backfill observations are excluded.",
  },
  backend: {
    commit: health.commit,
    environment: health.environment,
    expectedCommit: EXPECTED_BACKEND_COMMIT,
  },
  sourceIntegrity: {
    endpoint: "/api/mlb/ledger/v1/export?format=jsonl&limit=10000",
    ownerScoped: true,
    immutableLedger: status.data.immutable,
    exportedRecords: records.length,
    publicPredictionCount: status.data.predictions,
    settlementEvents: status.data.settlementEvents,
    unownedPredictions: status.data.ownership?.unownedPredictions,
    rawExportSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    rawExportUploaded: false,
  },
  historicalRuleRegistry: HISTORICAL_RULE_REGISTRY,
  ledgerCoverage: {
    normalizedPredictions: normalized.length,
    pregameWithCommenceTime: pregameAll.length,
    sources: countBy(normalized, (r) => r.source),
    markets: countBy(normalized, (r) => r.market),
    stages: countBy(normalized, (r) => r.stage),
    historicalTokens,
    reconstructability,
  },
  economicGroups: groupSummaries,
  interpretationGuards: {
    developmentBacktestClaimsAreNotProspectiveProof: true,
    rankingProbabilityFloorsAreNotCalibratedProbabilities: true,
    ultraCommitReportedCombinedTwoPlusBoostHitRate: false,
    ttStrongEarlyN22AndF5PremiumN6AreSmallDevelopmentSubsets: true,
    multipleIterativeBacktestsCreateSelectionRisk: true,
    prospectiveEconomicConclusionRequiresPregameNonBackfillRowsAfterDefinition: true,
    automaticThresholdChangeAllowed: false,
    automaticModelChangeAllowed: false,
    automaticPromotionAllowed: false,
  },
  decision: (() => {
    const ultra = groupSummaries.explicitUltraF5ProspectiveApp;
    if (!reconstructability.exactHistoricalLabelReplayFromLedgerPossible) return "HISTORICAL_LABELS_NOT_PRESERVED_IN_LEDGER";
    if (!ultra || ultra.records === 0) return "NO_PROSPECTIVE_APP_ULTRA_ROWS_AFTER_DEFINITION";
    if (ultra.binaryDecisions < 30) return "ULTRA_PROSPECTIVE_SAMPLE_TOO_SMALL_FOR_ECONOMIC_CERTIFICATION";
    return "ULTRA_PROSPECTIVE_ECONOMIC_REVIEW_AVAILABLE_NOT_AUTOMATICALLY_CERTIFIED";
  })(),
  safety: {
    readOnly: true,
    rawOwnerLedgerPersistedInArtifact: false,
    predictionsCreated: 0,
    settlementsCreated: 0,
    betsPlaced: 0,
    realFinancialExposure: 0,
  },
};

fs.mkdirSync(new URL(".", `file://${outputPath.startsWith("/") ? outputPath : `${process.cwd()}/${outputPath}`}`).pathname, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  backendCommit: result.backend.commit,
  exportedRecords: result.sourceIntegrity.exportedRecords,
  ultraTokenRecords: historicalTokens.ultraRecords,
  premiumTokenRecords: historicalTokens.premiumRecords,
  prospectiveUltraAppRecords: groupSummaries.explicitUltraF5ProspectiveApp.records,
  prospectiveUltraAppSettled: groupSummaries.explicitUltraF5ProspectiveApp.settled,
  prospectiveUltraAppRoiPct: groupSummaries.explicitUltraF5ProspectiveApp.flatStakeRoiPct,
  decision: result.decision,
}, null, 2));