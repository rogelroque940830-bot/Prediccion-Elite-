from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    p.write_text(text.replace(old, new, 1))

helper = r'''import { createHash } from "node:crypto";
import type { LedgerRecord } from "./mlb-ledger-store";

export const MLB_ANALYTICAL_FINGERPRINT_VERSION = "mlb-analytical-fingerprint.v1" as const;

export type MlbAnalyticalDuplicateStatus = {
  fingerprint: string | null;
  analyticalDuplicate: boolean;
  analyticalDuplicateOfPredictionId: string | null;
};

const OMIT_AUDIT_KEYS = new Set([
  "capturedAt",
  "detectorFetchedAt",
  "validatorFetchedAt",
]);

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1e12) / 1e12 : null;
}

function stableValue(value: any, key = ""): any {
  if (OMIT_AUDIT_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => stableValue(item))
      .filter((item) => item !== undefined)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, stableValue(value[childKey], childKey)] as const)
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  if (typeof value === "number") return normalizedNumber(value);
  return value;
}

function injuryAuditFrom(record: LedgerRecord): any | null {
  const audit = (record.prediction.payload as any)?.analysis?.injuryAudit;
  return audit?.schemaVersion === "mlb-injury-audit.v1" ? audit : null;
}

export function buildMlbAnalyticalFingerprint(record: LedgerRecord): string | null {
  const audit = injuryAuditFrom(record);
  if (!audit) return null;
  const prediction = record.prediction;
  const basis = stableValue({
    version: MLB_ANALYTICAL_FINGERPRINT_VERSION,
    game: {
      gamePk: prediction.game.gamePk ?? null,
      gameDate: prediction.game.gameDate,
      homeTeam: normalizedText(prediction.game.homeTeam),
      awayTeam: normalizedText(prediction.game.awayTeam),
    },
    market: {
      type: prediction.market.type,
      selection: normalizedText(prediction.market.selection),
      line: normalizedNumber(prediction.market.line),
      oddsAmerican: normalizedNumber(prediction.market.oddsAmerican),
      book: normalizedText(prediction.market.book),
    },
    model: {
      name: normalizedText(prediction.model.name),
      version: normalizedText(prediction.model.version),
      probability: normalizedNumber(prediction.probabilities.model),
    },
    injuryAudit: audit,
  });
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

export function classifyMlbAnalyticalDuplicates(
  records: LedgerRecord[],
): Map<string, MlbAnalyticalDuplicateStatus> {
  const ordered = [...records].sort((left, right) =>
    left.prediction.recordedAtMs - right.prediction.recordedAtMs
    || left.prediction.id.localeCompare(right.prediction.id)
  );
  const firstByFingerprint = new Map<string, string>();
  const result = new Map<string, MlbAnalyticalDuplicateStatus>();

  for (const record of ordered) {
    const fingerprint = buildMlbAnalyticalFingerprint(record);
    if (!fingerprint) {
      result.set(record.prediction.id, {
        fingerprint: null,
        analyticalDuplicate: false,
        analyticalDuplicateOfPredictionId: null,
      });
      continue;
    }
    const originalId = firstByFingerprint.get(fingerprint) ?? null;
    if (!originalId) firstByFingerprint.set(fingerprint, record.prediction.id);
    result.set(record.prediction.id, {
      fingerprint,
      analyticalDuplicate: Boolean(originalId),
      analyticalDuplicateOfPredictionId: originalId,
    });
  }
  return result;
}
'''
Path("server/mlb-analytical-dedup.ts").write_text(helper)

# C2B outcome rows and summaries
path = "server/mlb-injury-outcomes-report.ts"
text = Path(path).read_text()
text = text.replace(
    'import type { MlbInjuryAudit } from "./mlb-injury-audit";\n',
    'import type { MlbInjuryAudit } from "./mlb-injury-audit";\nimport { classifyMlbAnalyticalDuplicates, MLB_ANALYTICAL_FINGERPRINT_VERSION, type MlbAnalyticalDuplicateStatus } from "./mlb-analytical-dedup";\n',
    1,
)
text = text.replace(
    '  effect: InjuryEffect;\n};',
    '  effect: InjuryEffect;\n  analyticalFingerprint: string | null;\n  analyticalDuplicate: boolean;\n  analyticalDuplicateOfPredictionId: string | null;\n};',
    1,
)
text = text.replace(
    'function rowFrom(record: LedgerRecord): MlbInjuryOutcomeRow | null {',
    'function rowFrom(record: LedgerRecord, duplicateStatus: MlbAnalyticalDuplicateStatus): MlbInjuryOutcomeRow | null {',
    1,
)
text = text.replace(
    '    effect: effectFrom(record, audit),\n  };',
    '    effect: effectFrom(record, audit),\n    analyticalFingerprint: duplicateStatus.fingerprint,\n    analyticalDuplicate: duplicateStatus.analyticalDuplicate,\n    analyticalDuplicateOfPredictionId: duplicateStatus.analyticalDuplicateOfPredictionId,\n  };',
    1,
)
text = text.replace(
    'export function buildMlbInjuryOutcomeRows(records: LedgerRecord[]): MlbInjuryOutcomeRow[] {\n  return records.map(rowFrom).filter((row): row is MlbInjuryOutcomeRow => Boolean(row));\n}\n\nexport function buildMlbInjuryOutcomesReport(records: LedgerRecord[]) {\n  const rows = buildMlbInjuryOutcomeRows(records);',
    '''function buildAllMlbInjuryOutcomeRows(records: LedgerRecord[]): MlbInjuryOutcomeRow[] {
  const duplicateStatus = classifyMlbAnalyticalDuplicates(records);
  return records
    .map((record) => rowFrom(record, duplicateStatus.get(record.prediction.id) ?? {
      fingerprint: null,
      analyticalDuplicate: false,
      analyticalDuplicateOfPredictionId: null,
    }))
    .filter((row): row is MlbInjuryOutcomeRow => Boolean(row));
}

export function buildMlbInjuryOutcomeRows(records: LedgerRecord[]): MlbInjuryOutcomeRow[] {
  return buildAllMlbInjuryOutcomeRows(records).filter((row) => !row.analyticalDuplicate);
}

export function buildMlbInjuryOutcomesReport(records: LedgerRecord[]) {
  const allRows = buildAllMlbInjuryOutcomeRows(records);
  const rows = allRows.filter((row) => !row.analyticalDuplicate);
  const duplicateRows = allRows.filter((row) => row.analyticalDuplicate);''',
    1,
)
text = text.replace(
    '      formulasChanged: false,\n    },\n    summary: summarizeRows(rows),',
    '''      formulasChanged: false,
      analyticalDeduplication: "Equivalent C1 picks are fingerprinted by game, market, selection, line, odds, book, model version, probability and injury decision evidence; technical fetch timestamps are ignored.",
    },
    deduplication: {
      fingerprintVersion: MLB_ANALYTICAL_FINGERPRINT_VERSION,
      ledgerAuditedPicks: allRows.length,
      uniqueAnalyticalDecisions: rows.length,
      duplicatesExcluded: duplicateRows.length,
      settledDuplicatesExcluded: duplicateRows.filter((row) => row.result != null).length,
      pendingDuplicatesExcluded: duplicateRows.filter((row) => row.result == null).length,
    },
    summary: summarizeRows(rows),''',
    1,
)
Path(path).write_text(text)

# C2C transparency
path = "server/mlb-injury-decision-report.ts"
text = Path(path).read_text()
text = text.replace(
    '  buildMlbInjuryOutcomeRows,\n  type MlbInjuryOutcomeRow,',
    '  buildMlbInjuryOutcomeRows,\n  buildMlbInjuryOutcomesReport,\n  type MlbInjuryOutcomeRow,',
    1,
)
text = text.replace(
    '  const rows = buildMlbInjuryOutcomeRows(records);\n  const baseline = metrics(rows);',
    '  const outcomeReport = buildMlbInjuryOutcomesReport(records);\n  const rows = buildMlbInjuryOutcomeRows(records);\n  const baseline = metrics(rows);',
    1,
)
text = text.replace(
    '    policy: { ...POLICY, formulasChanged: false, automaticRuleChanges: false },\n    global,',
    '    policy: { ...POLICY, formulasChanged: false, automaticRuleChanges: false },\n    deduplication: outcomeReport.deduplication,\n    global,',
    1,
)
Path(path).write_text(text)

# History view labels while retaining raw financial summary
path = "server/mlb-ledger-history-view.ts"
text = Path(path).read_text()
text = text.replace(
    'import type { LedgerRecord } from "./mlb-ledger-store";\n',
    'import type { LedgerRecord } from "./mlb-ledger-store";\nimport { classifyMlbAnalyticalDuplicates, MLB_ANALYTICAL_FINGERPRINT_VERSION } from "./mlb-analytical-dedup";\n',
    1,
)
text = text.replace(
    '  const ordered = [...records].sort((a, b) => b.prediction.recordedAtMs - a.prediction.recordedAtMs);',
    '  const ordered = [...records].sort((a, b) => b.prediction.recordedAtMs - a.prediction.recordedAtMs);\n  const analyticalStatuses = classifyMlbAnalyticalDuplicates(records);',
    1,
)
text = text.replace(
    '    const settlement = record.settlement;\n    return {',
    '    const settlement = record.settlement;\n    const analyticalStatus = analyticalStatuses.get(prediction.id);\n    return {',
    1,
)
text = text.replace(
    '      hasInjuryAudit: prediction.payload?.analysis?.injuryAudit?.schemaVersion === "mlb-injury-audit.v1",\n    };',
    '''      hasInjuryAudit: prediction.payload?.analysis?.injuryAudit?.schemaVersion === "mlb-injury-audit.v1",
      analyticalFingerprint: analyticalStatus?.fingerprint ?? null,
      analyticalDuplicate: analyticalStatus?.analyticalDuplicate ?? false,
      analyticalDuplicateOfPredictionId: analyticalStatus?.analyticalDuplicateOfPredictionId ?? null,
    };''',
    1,
)
text = text.replace(
    '    summary: {',
    '''    analyticalCalibration: {
      fingerprintVersion: MLB_ANALYTICAL_FINGERPRINT_VERSION,
      auditedLedgerRecords: picks.filter((pick) => pick.hasInjuryAudit).length,
      uniqueDecisions: picks.filter((pick) => pick.hasInjuryAudit && !pick.analyticalDuplicate).length,
      duplicatesExcluded: picks.filter((pick) => pick.analyticalDuplicate).length,
      settledUniqueDecisions: picks.filter((pick) => pick.hasInjuryAudit && !pick.analyticalDuplicate && pick.settlementResult != null).length,
    },
    summary: {''',
    1,
)
Path(path).write_text(text)

# Append outcome regression
p = Path("server/mlb-injury-outcomes-report.test.ts")
text = p.read_text()
text += r'''

test("C2B.1 excludes equivalent C1 duplicates from analytical metrics", () => {
  const first = record({ id: "detroit-ml-first", probability: 0.6781014109277892, result: "WIN", profit: 0.7143, auditValue: audit() });
  const duplicate = record({ id: "detroit-ml-duplicate", probability: 0.6781014109277892, result: "WIN", profit: 0.7143, auditValue: audit({ capturedAt: "2026-07-28T12:00:05.000Z" }) });
  duplicate.prediction.recordedAt = "2026-07-28T12:00:05.000Z";
  duplicate.prediction.recordedAtMs = Date.parse(duplicate.prediction.recordedAt);
  const f5 = record({ id: "detroit-f5", probability: 0.6560877429477524, result: "WIN", profit: 0.6667, auditValue: audit() });
  f5.prediction.market.type = "F5_ML";
  f5.prediction.market.selection = "Home F5";
  f5.prediction.market.oddsAmerican = -150;

  const report = buildMlbInjuryOutcomesReport([first, duplicate, f5]);
  assert.equal(report.deduplication.ledgerAuditedPicks, 3);
  assert.equal(report.deduplication.uniqueAnalyticalDecisions, 2);
  assert.equal(report.deduplication.duplicatesExcluded, 1);
  assert.equal(report.deduplication.settledDuplicatesExcluded, 1);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.settled, 2);
  assert.equal(report.summary.wins, 2);
  assert.equal(report.summary.profitUnits, 1.381);
  assert.equal(report.recentSettled.some((row) => row.predictionId === "detroit-ml-duplicate"), false);
});
'''
p.write_text(text)

# Append C2C regression
p = Path("server/mlb-injury-decision-report.test.ts")
text = p.read_text()
text += r'''

test("C2C sample thresholds use unique analytical decisions", () => {
  const original = record(40, { probability: 0.67, result: "WIN", profit: 0.7, market: "ML" });
  const duplicate = record(41, { probability: 0.67, result: "WIN", profit: 0.7, market: "ML" });
  duplicate.prediction.game = { ...original.prediction.game };
  duplicate.prediction.market = { ...original.prediction.market };
  duplicate.prediction.model = { ...original.prediction.model };
  duplicate.prediction.payload = JSON.parse(JSON.stringify(original.prediction.payload));
  duplicate.prediction.payload.analysis.injuryAudit.capturedAt = "2026-07-28T12:00:10.000Z";
  duplicate.prediction.recordedAt = "2026-07-28T12:00:10.000Z";
  duplicate.prediction.recordedAtMs = Date.parse(duplicate.prediction.recordedAt);

  const report = buildMlbInjuryDecisionReport([original, duplicate]);
  assert.equal(report.deduplication.ledgerAuditedPicks, 2);
  assert.equal(report.deduplication.uniqueAnalyticalDecisions, 1);
  assert.equal(report.deduplication.duplicatesExcluded, 1);
  assert.equal(report.global.metrics.total, 1);
  assert.equal(report.global.metrics.settled, 1);
});
'''
p.write_text(text)

# Append history regression
p = Path("server/mlb-ledger-history-view.test.ts")
text = p.read_text()
text += r'''

test("marks equivalent C1 ledger records as analytical duplicates without removing them", () => {
  const first = record({ id: "first", recordedAtMs: 1000, marketType: "ML", selection: "Detroit Tigers ML", odds: -140, stake: 1, result: "WIN", profitUnits: 0.7143 });
  const duplicate = record({ id: "duplicate", recordedAtMs: 2000, marketType: "ML", selection: "Detroit Tigers ML", odds: -140, stake: 1, result: "WIN", profitUnits: 0.7143 });
  const view = buildMlbLedgerHistoryView([first, duplicate]);
  assert.equal(view.summary.total, 2);
  assert.equal(view.analyticalCalibration.auditedLedgerRecords, 2);
  assert.equal(view.analyticalCalibration.uniqueDecisions, 1);
  assert.equal(view.analyticalCalibration.duplicatesExcluded, 1);
  const duplicatePick = view.picks.find((pick) => pick.id === "duplicate");
  assert.equal(duplicatePick?.analyticalDuplicate, true);
  assert.equal(duplicatePick?.analyticalDuplicateOfPredictionId, "first");
});
'''
p.write_text(text)

# Frontend targeted edits
path = "frontend/client/src/pages/mlb-history.tsx"
text = Path(path).read_text()
text = text.replace(
    '  summary: InjuryOutcomeMetricSummary;\n  cohorts:',
    '''  deduplication: {
    fingerprintVersion: string;
    ledgerAuditedPicks: number;
    uniqueAnalyticalDecisions: number;
    duplicatesExcluded: number;
    settledDuplicatesExcluded: number;
    pendingDuplicatesExcluded: number;
  };
  summary: InjuryOutcomeMetricSummary;
  cohorts:''',
    1,
)
text = text.replace(
    '  global: InjuryDecisionItem;\n  cohorts:',
    '  deduplication: InjuryOutcomesReport["deduplication"];\n  global: InjuryDecisionItem;\n  cohorts:',
    1,
)
text = text.replace(
    '  hasInjuryAudit: boolean;\n}',
    '  hasInjuryAudit: boolean;\n  analyticalFingerprint: string | null;\n  analyticalDuplicate: boolean;\n  analyticalDuplicateOfPredictionId: string | null;\n}',
    1,
)
text = text.replace(
    '  summary: {\n    total: number;',
    '''  analyticalCalibration: {
    fingerprintVersion: string;
    auditedLedgerRecords: number;
    uniqueDecisions: number;
    duplicatesExcluded: number;
    settledUniqueDecisions: number;
  };
  summary: {
    total: number;''',
    1,
)
text = text.replace(
    '    hasInjuryAudit: Boolean(pick.scientificSnapshot?.analysis?.injuryAudit),\n  }));',
    '''    hasInjuryAudit: Boolean(pick.scientificSnapshot?.analysis?.injuryAudit),
    analyticalFingerprint: null,
    analyticalDuplicate: false,
    analyticalDuplicateOfPredictionId: null,
  }));''',
    1,
)
text = text.replace(
    '["C1 liquidados", injuryOutcomes.summary.settled],\n                   ["C1 pendientes", injuryOutcomes.summary.pending],',
    '["Únicos liquidados", injuryOutcomes.summary.settled],\n                   ["Únicos pendientes", injuryOutcomes.summary.pending],',
    1,
)
text = text.replace(
    '              {injuryOutcomes.summary.settled === 0 ? (',
    '''              <div className="flex items-start gap-2 rounded-lg border border-violet-500/25 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <Database className="h-4 w-4 text-violet-300 shrink-0" />
                <p>
                  C2B usa {injuryOutcomes.deduplication.uniqueAnalyticalDecisions} decisiones únicas de {injuryOutcomes.deduplication.ledgerAuditedPicks} registros C1. Se excluyeron {injuryOutcomes.deduplication.duplicatesExcluded} duplicado(s) analítico(s) de Brier, log loss, ROI y tamaño de muestra.
                </p>
              </div>

              {injuryOutcomes.summary.settled === 0 ? (''',
    1,
)
text = text.replace(
    '                 <p className="text-[11px] text-indigo-200/80">Protección: {injuryDecisions.global.guardrail}</p>',
    '''                 <p className="text-[11px] text-indigo-200/80">Protección: {injuryDecisions.global.guardrail}</p>
                 <p className="text-[11px] text-muted-foreground">Muestra analítica: {injuryDecisions.deduplication.uniqueAnalyticalDecisions} únicas · {injuryDecisions.deduplication.duplicatesExcluded} duplicado(s) excluido(s).</p>''',
    1,
)
text = text.replace(
    '                  {pick.hasInjuryAudit && <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-300">C1</Badge>}\n                   <span className="text-xs text-muted-foreground ml-auto">{pick.selection}</span>',
    '''                  {pick.hasInjuryAudit && <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-300">C1</Badge>}
                  {pick.analyticalDuplicate && (
                    <Badge variant="outline" className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-300" title="Visible en el ledger, pero excluido de C2B y C2C por equivaler a una decisión anterior">
                      Duplicado analítico
                    </Badge>
                  )}
                   <span className="text-xs text-muted-foreground ml-auto">{pick.selection}</span>''',
    1,
)
Path(path).write_text(text)
