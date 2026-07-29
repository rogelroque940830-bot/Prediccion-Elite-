import type { LedgerRecord } from "./mlb-ledger-store";
import type { MlbInjuryAudit } from "./mlb-injury-audit";

export const MLB_INJURY_OUTCOMES_REPORT_VERSION = "mlb-injury-outcomes-report.v1" as const;

const COHORTS = [
  "ALL_AUDITED",
  "AUTO_APPLIED",
  "RETAINED",
  "NO_AUTO_ADJUSTMENT",
  "FULL_COVERAGE",
  "PARTIAL_COVERAGE",
  "BLOCKED_COVERAGE",
  "MANUAL_OVERRIDE",
  "BULLPEN_BLOCKED",
] as const;

type CohortKey = typeof COHORTS[number];
type Coverage = "FULL" | "PARTIAL" | "BLOCKED";

type InjuryEffect = {
  available: boolean;
  source: "COUNTERFACTUAL_RECALCULATION_V1" | "INFERRED_ZERO" | "UNAVAILABLE";
  homeProbabilityDeltaPp: number | null;
  totalRunsDelta: number | null;
  dataQuality: "VERIFIED" | "DEGRADED" | "UNKNOWN";
};

export type MlbInjuryOutcomeRow = {
  predictionId: string;
  recordedAt: string;
  gameDate: string;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  oddsAmerican: number;
  modelProbability: number;
  result: string | null;
  settledAt: string | null;
  profitUnits: number;
  stakeUnits: number;
  outcomeValue: number | null;
  brierScore: number | null;
  logLoss: number | null;
  clvPp: number | null;
  coverage: Coverage;
  autoApplied: boolean;
  retained: boolean;
  manualOverride: boolean;
  bullpenBlocked: boolean;
  candidates: number;
  autoAppliedPlayers: number;
  retainedPlayers: number;
  finalRunsHome: number;
  finalRunsAway: number;
  effect: InjuryEffect;
};

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function auditFrom(record: LedgerRecord): MlbInjuryAudit | null {
  const audit = (record.prediction.payload as any)?.analysis?.injuryAudit;
  if (!audit || audit.schemaVersion !== "mlb-injury-audit.v1" || !audit.home || !audit.away) return null;
  return audit as MlbInjuryAudit;
}

function coverageFrom(audit: MlbInjuryAudit): Coverage {
  const values = [audit.home.phaseB.coverage, audit.away.phaseB.coverage];
  if (values.includes("BLOCKED")) return "BLOCKED";
  if (values.includes("PARTIAL")) return "PARTIAL";
  return "FULL";
}

function bullpenBlocked(audit: MlbInjuryAudit): boolean {
  return [audit.home, audit.away].some((team) =>
    Boolean(team.reconciliation.blockedReason)
    || team.players.some((player) => player.disposition === "WITHHELD_BULLPEN")
  );
}

function scoringOutcome(record: LedgerRecord): number | null {
  if (!record.settlement) return null;
  // settlement.outcomeValue is the graded market measurement (run margin,
  // total runs, team runs, etc.), not a Bernoulli target. Proper scoring
  // rules must use the immutable settlement classification instead.
  if (record.settlement.result === "WIN") return 1;
  if (record.settlement.result === "LOSS") return 0;
  if (record.settlement.result === "HALF_WIN") return 0.75;
  if (record.settlement.result === "HALF_LOSS") return 0.25;
  return null;
}

function properScores(probability: number, outcome: number | null) {
  if (outcome == null) return { brierScore: null, logLoss: null };
  const p = Math.min(0.999999, Math.max(0.000001, probability));
  return {
    brierScore: round((p - outcome) ** 2, 6),
    logLoss: round(-(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p)), 6),
  };
}

function effectFrom(record: LedgerRecord, audit: MlbInjuryAudit): InjuryEffect {
  const layer = (record.prediction.payload as any)?.analysis?.layers?.injuryEffect;
  const homePp = Number(layer?.homeProbabilityDeltaPp);
  const totalRuns = Number(layer?.totalRunsDelta);
  if (Number.isFinite(homePp) && Number.isFinite(totalRuns)) {
    return {
      available: true,
      source: "COUNTERFACTUAL_RECALCULATION_V1",
      homeProbabilityDeltaPp: round(homePp, 4),
      totalRunsDelta: round(totalRuns, 4),
      dataQuality: layer?.dataQuality === "VERIFIED" ? "VERIFIED" : "DEGRADED",
    };
  }

  const finalAbs = Math.abs(finite(audit.home.adjustment.finalRuns)) + Math.abs(finite(audit.away.adjustment.finalRuns));
  if (finalAbs < 1e-9) {
    return {
      available: true,
      source: "INFERRED_ZERO",
      homeProbabilityDeltaPp: 0,
      totalRunsDelta: 0,
      dataQuality: "UNKNOWN",
    };
  }

  return {
    available: false,
    source: "UNAVAILABLE",
    homeProbabilityDeltaPp: null,
    totalRunsDelta: null,
    dataQuality: "UNKNOWN",
  };
}

function rowFrom(record: LedgerRecord): MlbInjuryOutcomeRow | null {
  const audit = auditFrom(record);
  if (!audit) return null;
  const teams = [audit.home, audit.away];
  const autoAppliedPlayers = teams.reduce((sum, team) => sum + finite(team.counts.autoApplied), 0);
  const retainedPlayers = teams.reduce((sum, team) => sum + finite(team.counts.retained), 0);
  const candidates = teams.reduce((sum, team) => sum + finite(team.counts.candidates), 0);
  const outcomeValue = scoringOutcome(record);
  const scores = properScores(record.prediction.probabilities.model, outcomeValue);

  return {
    predictionId: record.prediction.id,
    recordedAt: record.prediction.recordedAt,
    gameDate: record.prediction.game.gameDate,
    gamePk: record.prediction.game.gamePk,
    homeTeam: record.prediction.game.homeTeam,
    awayTeam: record.prediction.game.awayTeam,
    marketType: record.prediction.market.type,
    selection: record.prediction.market.selection,
    oddsAmerican: record.prediction.market.oddsAmerican,
    modelProbability: record.prediction.probabilities.model,
    result: record.settlement?.result ?? null,
    settledAt: record.settlement?.settledAt ?? null,
    profitUnits: finite(record.settlement?.profitUnits),
    stakeUnits: finite(record.prediction.decision.stakeUnits),
    outcomeValue,
    brierScore: scores.brierScore,
    logLoss: scores.logLoss,
    clvPp: Number.isFinite(record.settlement?.clvPp) ? Number(record.settlement?.clvPp) : null,
    coverage: coverageFrom(audit),
    autoApplied: autoAppliedPlayers > 0,
    retained: retainedPlayers > 0,
    manualOverride: teams.some((team) => team.adjustment.manualOverride),
    bullpenBlocked: bullpenBlocked(audit),
    candidates,
    autoAppliedPlayers,
    retainedPlayers,
    finalRunsHome: finite(audit.home.adjustment.finalRuns),
    finalRunsAway: finite(audit.away.adjustment.finalRuns),
    effect: effectFrom(record, audit),
  };
}

function cohortKeys(row: MlbInjuryOutcomeRow): CohortKey[] {
  const keys: CohortKey[] = ["ALL_AUDITED"];
  if (row.autoApplied) keys.push("AUTO_APPLIED");
  else keys.push("NO_AUTO_ADJUSTMENT");
  if (row.retained) keys.push("RETAINED");
  if (row.manualOverride) keys.push("MANUAL_OVERRIDE");
  if (row.bullpenBlocked) keys.push("BULLPEN_BLOCKED");
  keys.push(`${row.coverage}_COVERAGE` as CohortKey);
  return keys;
}

function summarizeRows(rows: MlbInjuryOutcomeRow[]) {
  const settled = rows.filter((row) => row.result != null);
  const scored = settled.filter((row) => row.outcomeValue != null);
  const effectRows = rows.filter((row) => row.effect.available);
  const wins = settled.filter((row) => row.result === "WIN" || row.result === "HALF_WIN").length;
  const losses = settled.filter((row) => row.result === "LOSS" || row.result === "HALF_LOSS").length;
  const profitUnits = settled.reduce((sum, row) => sum + row.profitUnits, 0);
  const stakedUnits = settled.reduce((sum, row) => sum + row.stakeUnits, 0);
  const avg = (values: number[]) => values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 6) : null;

  return {
    total: rows.length,
    pending: rows.length - settled.length,
    settled: settled.length,
    scored: scored.length,
    wins,
    losses,
    pushesOrVoids: settled.length - wins - losses,
    profitUnits: round(profitUnits),
    stakedUnits: round(stakedUnits),
    roiPct: stakedUnits > 0 ? round((profitUnits / stakedUnits) * 100, 2) : 0,
    winRatePct: wins + losses > 0 ? round((wins / (wins + losses)) * 100, 2) : 0,
    averageModelProbabilityPct: avg(scored.map((row) => row.modelProbability * 100)),
    brierScore: avg(scored.map((row) => row.brierScore as number)),
    logLoss: avg(scored.map((row) => row.logLoss as number)),
    averageClvPp: avg(settled.filter((row) => row.clvPp != null).map((row) => row.clvPp as number)),
    effectAvailable: effectRows.length,
    effectUnavailable: rows.length - effectRows.length,
    averageHomeProbabilityDeltaPp: avg(effectRows.map((row) => row.effect.homeProbabilityDeltaPp as number)),
    averageTotalRunsDelta: avg(effectRows.map((row) => row.effect.totalRunsDelta as number)),
  };
}

export function buildMlbInjuryOutcomeRows(records: LedgerRecord[]): MlbInjuryOutcomeRow[] {
  return records.map(rowFrom).filter((row): row is MlbInjuryOutcomeRow => Boolean(row));
}

export function buildMlbInjuryOutcomesReport(records: LedgerRecord[]) {
  const rows = buildMlbInjuryOutcomeRows(records);
  const cohorts = Object.fromEntries(COHORTS.map((key) => [
    key,
    { key, ...summarizeRows(rows.filter((row) => cohortKeys(row).includes(key))) },
  ])) as Record<CohortKey, { key: CohortKey } & ReturnType<typeof summarizeRows>>;

  const recentSettled = rows
    .filter((row) => row.result != null)
    .sort((a, b) => Date.parse(b.settledAt || b.recordedAt) - Date.parse(a.settledAt || a.recordedAt))
    .slice(0, 25);

  return {
    schemaVersion: MLB_INJURY_OUTCOMES_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    methodology: {
      scoring: "Brier and logarithmic loss use the saved pregame model probability and the immutable WIN/LOSS settlement classification; raw market outcomeValue is not a probability target.",
      cohortsOverlap: true,
      probabilityEffectScope: "HOME_ML_AND_GAME_TOTAL_COUNTERFACTUAL",
      formulasChanged: false,
    },
    summary: summarizeRows(rows),
    cohorts,
    recentSettled,
  };
}

export type MlbInjuryOutcomesReport = ReturnType<typeof buildMlbInjuryOutcomesReport>;
