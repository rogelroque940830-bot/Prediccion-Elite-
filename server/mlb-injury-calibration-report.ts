import crypto from "crypto";
import { canonicalJson, type LedgerRecord } from "./mlb-ledger-store";
import type { MlbInjuryAudit } from "./mlb-injury-audit";

export const MLB_INJURY_CALIBRATION_REPORT_VERSION = "mlb-injury-calibration-report.v1" as const;

const COVERAGES = ["FULL", "PARTIAL", "BLOCKED"] as const;
const DISPOSITIONS = [
  "AUTO_APPLIED",
  "BACKEND_ELIGIBLE",
  "WITHHELD_BULLPEN",
  "WITHHELD_POLICY",
  "WITHHELD_MANUAL_OVERRIDE",
  "MANUAL_SELECTED",
  "ALREADY_REFLECTED",
  "IGNORED",
  "CONFLICT",
  "PENDING",
  "DETECTED",
] as const;

type Coverage = typeof COVERAGES[number];
type Disposition = typeof DISPOSITIONS[number];

type AuditContext = {
  key: string;
  audit: MlbInjuryAudit;
  records: LedgerRecord[];
};

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value: number, total: number): number {
  return total > 0 ? round((value / total) * 100, 1) : 0;
}

function injuryAuditFrom(record: LedgerRecord): MlbInjuryAudit | null {
  const audit = (record.prediction.payload as any)?.analysis?.injuryAudit;
  if (!audit || audit.schemaVersion !== "mlb-injury-audit.v1") return null;
  if (!audit.home || !audit.away) return null;
  return audit as MlbInjuryAudit;
}

function auditContextKey(record: LedgerRecord, audit: MlbInjuryAudit): string {
  const game = record.prediction.game;
  const gameIdentity = game.gamePk
    ? `gamePk:${game.gamePk}`
    : `${game.gameDate}:${game.awayTeam}@${game.homeTeam}`;
  const digest = crypto.createHash("sha256").update(canonicalJson(audit)).digest("hex");
  return `${gameIdentity}:${digest}`;
}

function buildContexts(records: LedgerRecord[]): AuditContext[] {
  const map = new Map<string, AuditContext>();
  for (const record of records) {
    const audit = injuryAuditFrom(record);
    if (!audit) continue;
    const key = auditContextKey(record, audit);
    const existing = map.get(key);
    if (existing) existing.records.push(record);
    else map.set(key, { key, audit, records: [record] });
  }
  return [...map.values()];
}

export function buildMlbInjuryCalibrationReport(records: LedgerRecord[], targetSettledAuditedPicks = 20) {
  const auditedRecords = records.filter((record) => injuryAuditFrom(record));
  const contexts = buildContexts(records);
  const settledAuditedPredictions = auditedRecords.filter((record) => Boolean(record.settlement)).length;
  const pendingAuditedPredictions = auditedRecords.length - settledAuditedPredictions;

  const coverageCounts: Record<Coverage, number> = { FULL: 0, PARTIAL: 0, BLOCKED: 0 };
  const dispositionCounts = Object.fromEntries(DISPOSITIONS.map((key) => [key, 0])) as Record<Disposition, number>;
  const decisions = {
    detected: 0,
    candidates: 0,
    backendEligible: 0,
    autoApplied: 0,
    retained: 0,
    rejected: 0,
    officialOnly: 0,
    manualOverrideTeams: 0,
    bullpenBlockedTeams: 0,
  };

  let rawAbs = 0;
  let scaledAbs = 0;
  let finalAbs = 0;
  let totalRawRuns = 0;
  let totalScaledRuns = 0;
  let totalFinalRuns = 0;
  let maxAbsFinalRuns = 0;
  let teamsWithAutomaticAdjustment = 0;
  let teamsWithAnyFinalAdjustment = 0;
  let teamContexts = 0;

  const cohorts = {
    contextsWithAutoApplied: 0,
    contextsWithRetained: 0,
    contextsWithManualOverride: 0,
    contextsWithBullpenBlock: 0,
    contextsWithFullCoverage: 0,
    contextsWithPartialCoverage: 0,
    contextsWithBlockedCoverage: 0,
  };

  for (const context of contexts) {
    const teams = [context.audit.home, context.audit.away];
    let contextAutoApplied = false;
    let contextRetained = false;
    let contextManualOverride = false;
    let contextBullpenBlock = false;
    const contextCoverages = new Set<Coverage>();

    for (const team of teams) {
      teamContexts += 1;
      const coverage = COVERAGES.includes(team.phaseB.coverage as Coverage)
        ? team.phaseB.coverage as Coverage
        : "BLOCKED";
      coverageCounts[coverage] += 1;
      contextCoverages.add(coverage);

      decisions.detected += finite(team.counts.detected);
      decisions.candidates += finite(team.counts.candidates);
      decisions.backendEligible += finite(team.counts.backendEligible);
      decisions.autoApplied += finite(team.counts.autoApplied);
      decisions.retained += finite(team.counts.retained);
      decisions.rejected += finite(team.counts.rejected);
      decisions.officialOnly += finite(team.counts.officialOnly);

      if (team.adjustment.manualOverride) {
        decisions.manualOverrideTeams += 1;
        contextManualOverride = true;
      }
      const bullpenBlocked = Boolean(team.reconciliation.blockedReason)
        || team.players.some((player) => player.disposition === "WITHHELD_BULLPEN");
      if (bullpenBlocked) {
        decisions.bullpenBlockedTeams += 1;
        contextBullpenBlock = true;
      }

      for (const player of team.players) {
        if (player.disposition in dispositionCounts) {
          dispositionCounts[player.disposition as Disposition] += 1;
        }
      }

      const raw = finite(team.adjustment.rawAutomaticRuns);
      const scaled = finite(team.adjustment.scaledAutomaticRuns);
      const final = finite(team.adjustment.finalRuns);
      totalRawRuns += raw;
      totalScaledRuns += scaled;
      totalFinalRuns += final;
      rawAbs += Math.abs(raw);
      scaledAbs += Math.abs(scaled);
      finalAbs += Math.abs(final);
      maxAbsFinalRuns = Math.max(maxAbsFinalRuns, Math.abs(final));
      if (Math.abs(scaled) > 1e-9) teamsWithAutomaticAdjustment += 1;
      if (Math.abs(final) > 1e-9) teamsWithAnyFinalAdjustment += 1;

      if (team.counts.autoApplied > 0) contextAutoApplied = true;
      if (team.counts.retained > 0) contextRetained = true;
    }

    if (contextAutoApplied) cohorts.contextsWithAutoApplied += 1;
    if (contextRetained) cohorts.contextsWithRetained += 1;
    if (contextManualOverride) cohorts.contextsWithManualOverride += 1;
    if (contextBullpenBlock) cohorts.contextsWithBullpenBlock += 1;
    if (contextCoverages.has("BLOCKED")) cohorts.contextsWithBlockedCoverage += 1;
    else if (contextCoverages.has("PARTIAL")) cohorts.contextsWithPartialCoverage += 1;
    else cohorts.contextsWithFullCoverage += 1;
  }

  const recent = contexts
    .map((context) => {
      const recordsByTime = [...context.records].sort((a, b) => b.prediction.recordedAtMs - a.prediction.recordedAtMs);
      const newest = recordsByTime[0];
      const markets = [...new Set(context.records.map((record) => record.prediction.market.type))].sort();
      return {
        capturedAt: context.audit.capturedAt,
        recordedAt: newest.prediction.recordedAt,
        gamePk: newest.prediction.game.gamePk,
        gameDate: newest.prediction.game.gameDate,
        homeTeam: newest.prediction.game.homeTeam,
        awayTeam: newest.prediction.game.awayTeam,
        markets,
        predictionCount: context.records.length,
        settledPredictionCount: context.records.filter((record) => Boolean(record.settlement)).length,
        coverage: {
          home: context.audit.home.phaseB.coverage,
          away: context.audit.away.phaseB.coverage,
        },
        candidates: context.audit.home.counts.candidates + context.audit.away.counts.candidates,
        autoApplied: context.audit.home.counts.autoApplied + context.audit.away.counts.autoApplied,
        retained: context.audit.home.counts.retained + context.audit.away.counts.retained,
        officialOnly: context.audit.home.counts.officialOnly + context.audit.away.counts.officialOnly,
        manualOverride: context.audit.home.adjustment.manualOverride || context.audit.away.adjustment.manualOverride,
        bullpenBlocked: Boolean(context.audit.home.reconciliation.blockedReason || context.audit.away.reconciliation.blockedReason),
        finalRuns: {
          home: context.audit.home.adjustment.finalRuns,
          away: context.audit.away.adjustment.finalRuns,
        },
      };
    })
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .slice(0, 20);

  const target = Math.max(1, Math.trunc(targetSettledAuditedPicks));
  return {
    schemaVersion: MLB_INJURY_CALIBRATION_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    readiness: {
      targetSettledAuditedPicks: target,
      settledAuditedPicks: settledAuditedPredictions,
      remaining: Math.max(0, target - settledAuditedPredictions),
      readyForExpansion: settledAuditedPredictions >= target,
    },
    sample: {
      totalPredictions: records.length,
      auditedPredictions: auditedRecords.length,
      legacyPredictionsWithoutAudit: records.length - auditedRecords.length,
      settledAuditedPredictions,
      pendingAuditedPredictions,
      uniqueAuditContexts: contexts.length,
      duplicateMarketSnapshotsExcluded: Math.max(0, auditedRecords.length - contexts.length),
    },
    coverage: {
      teamContexts,
      full: coverageCounts.FULL,
      partial: coverageCounts.PARTIAL,
      blocked: coverageCounts.BLOCKED,
      fullPct: percentage(coverageCounts.FULL, teamContexts),
      partialPct: percentage(coverageCounts.PARTIAL, teamContexts),
      blockedPct: percentage(coverageCounts.BLOCKED, teamContexts),
    },
    decisions: {
      ...decisions,
      dispositions: dispositionCounts,
    },
    adjustments: {
      teamsWithAutomaticAdjustment,
      teamsWithAnyFinalAdjustment,
      totalRawRuns: round(totalRawRuns),
      totalScaledRuns: round(totalScaledRuns),
      totalFinalRuns: round(totalFinalRuns),
      averageAbsRawRuns: teamContexts ? round(rawAbs / teamContexts) : 0,
      averageAbsScaledRuns: teamContexts ? round(scaledAbs / teamContexts) : 0,
      averageAbsFinalRuns: teamContexts ? round(finalAbs / teamContexts) : 0,
      maxAbsFinalRuns: round(maxAbsFinalRuns),
    },
    cohorts,
    recent,
  };
}

export type MlbInjuryCalibrationReport = ReturnType<typeof buildMlbInjuryCalibrationReport>;
