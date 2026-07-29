from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    p.write_text(text.replace(old, new, 1))


# Backend: make readiness count unique analytical decisions, while preserving raw C1 and injury-context counts.
path = "server/mlb-injury-calibration-report.ts"
replace_once(
    path,
    'import type { MlbInjuryAudit } from "./mlb-injury-audit";\n',
    'import type { MlbInjuryAudit } from "./mlb-injury-audit";\nimport { classifyMlbAnalyticalDuplicates, MLB_ANALYTICAL_FINGERPRINT_VERSION } from "./mlb-analytical-dedup";\n',
    "calibration dedup import",
)
replace_once(
    path,
    '''  const auditedRecords = records.filter((record) => injuryAuditFrom(record));
  const contexts = buildContexts(records);
  const settledAuditedPredictions = auditedRecords.filter((record) => Boolean(record.settlement)).length;
  const pendingAuditedPredictions = auditedRecords.length - settledAuditedPredictions;
''',
    '''  const auditedRecords = records.filter((record) => injuryAuditFrom(record));
  const contexts = buildContexts(records);
  const analyticalStatuses = classifyMlbAnalyticalDuplicates(records);
  const uniqueAuditedRecords = auditedRecords.filter(
    (record) => !analyticalStatuses.get(record.prediction.id)?.analyticalDuplicate,
  );
  const analyticalDuplicateRecords = auditedRecords.filter(
    (record) => analyticalStatuses.get(record.prediction.id)?.analyticalDuplicate,
  );
  const settledAuditedPredictions = auditedRecords.filter((record) => Boolean(record.settlement)).length;
  const pendingAuditedPredictions = auditedRecords.length - settledAuditedPredictions;
  const settledUniqueAnalyticalDecisions = uniqueAuditedRecords.filter((record) => Boolean(record.settlement)).length;
  const pendingUniqueAnalyticalDecisions = uniqueAuditedRecords.length - settledUniqueAnalyticalDecisions;
''',
    "calibration unique counts",
)
replace_once(
    path,
    '''    readiness: {
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
''',
    '''    readiness: {
      countingBasis: "UNIQUE_ANALYTICAL_DECISIONS" as const,
      fingerprintVersion: MLB_ANALYTICAL_FINGERPRINT_VERSION,
      targetSettledAuditedPicks: target,
      settledAuditedPicks: settledUniqueAnalyticalDecisions,
      remaining: Math.max(0, target - settledUniqueAnalyticalDecisions),
      readyForExpansion: settledUniqueAnalyticalDecisions >= target,
    },
    sample: {
      totalPredictions: records.length,
      auditedPredictions: auditedRecords.length,
      legacyPredictionsWithoutAudit: records.length - auditedRecords.length,
      settledAuditedPredictions,
      pendingAuditedPredictions,
      uniqueAnalyticalDecisions: uniqueAuditedRecords.length,
      settledUniqueAnalyticalDecisions,
      pendingUniqueAnalyticalDecisions,
      analyticalDuplicatesExcluded: analyticalDuplicateRecords.length,
      settledAnalyticalDuplicatesExcluded: analyticalDuplicateRecords.filter((record) => Boolean(record.settlement)).length,
      uniqueAuditContexts: contexts.length,
      duplicateMarketSnapshotsExcluded: Math.max(0, auditedRecords.length - contexts.length),
    },
''',
    "calibration readiness payload",
)

# Backend regression: exact duplicate does not advance C2A readiness.
p = Path("server/mlb-injury-calibration-report.test.ts")
text = p.read_text()
text = text.replace(
    '''  assert.equal(report.sample.uniqueAuditContexts, 1);
  assert.equal(report.sample.duplicateMarketSnapshotsExcluded, 1);
  assert.equal(report.sample.settledAuditedPredictions, 1);
  assert.equal(report.sample.pendingAuditedPredictions, 1);
''',
    '''  assert.equal(report.sample.uniqueAnalyticalDecisions, 2);
  assert.equal(report.sample.analyticalDuplicatesExcluded, 0);
  assert.equal(report.sample.settledUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.pendingUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.uniqueAuditContexts, 1);
  assert.equal(report.sample.duplicateMarketSnapshotsExcluded, 1);
  assert.equal(report.sample.settledAuditedPredictions, 1);
  assert.equal(report.sample.pendingAuditedPredictions, 1);
''',
    1,
)
if 'assert.equal(report.sample.uniqueAnalyticalDecisions, 2);' not in text:
    raise SystemExit("calibration base assertions were not inserted")
text += r'''

test("C2A readiness excludes exact analytical duplicates without removing ledger records", () => {
  const original = record("ML", true, true, 1_000);
  const duplicate = record("ML", true, true, 2_000);
  duplicate.prediction.id = "pred-ML-duplicate";
  duplicate.prediction.clientRequestId = "request-ML-duplicate";
  duplicate.prediction.payloadSha256 = "sha-ML-duplicate";
  duplicate.settlement.predictionId = duplicate.prediction.id;
  duplicate.settlement.eventId = "settle-ML-duplicate";

  const report = buildMlbInjuryCalibrationReport([original, duplicate], 20);

  assert.equal(report.readiness.countingBasis, "UNIQUE_ANALYTICAL_DECISIONS");
  assert.equal(report.readiness.settledAuditedPicks, 1);
  assert.equal(report.readiness.remaining, 19);
  assert.equal(report.sample.auditedPredictions, 2);
  assert.equal(report.sample.settledAuditedPredictions, 2);
  assert.equal(report.sample.uniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.settledUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.analyticalDuplicatesExcluded, 1);
  assert.equal(report.sample.settledAnalyticalDuplicatesExcluded, 1);
});
'''
p.write_text(text)

# Frontend types and copy.
path = "frontend/client/src/pages/mlb-history.tsx"
replace_once(
    path,
    '''  readiness: {
    targetSettledAuditedPicks: number;
    settledAuditedPicks: number;
    remaining: number;
    readyForExpansion: boolean;
  };
''',
    '''  readiness: {
    countingBasis: "UNIQUE_ANALYTICAL_DECISIONS";
    fingerprintVersion: string;
    targetSettledAuditedPicks: number;
    settledAuditedPicks: number;
    remaining: number;
    readyForExpansion: boolean;
  };
''',
    "frontend readiness type",
)
replace_once(
    path,
    '''    settledAuditedPredictions: number;
    pendingAuditedPredictions: number;
    uniqueAuditContexts: number;
    duplicateMarketSnapshotsExcluded: number;
''',
    '''    settledAuditedPredictions: number;
    pendingAuditedPredictions: number;
    uniqueAnalyticalDecisions: number;
    settledUniqueAnalyticalDecisions: number;
    pendingUniqueAnalyticalDecisions: number;
    analyticalDuplicatesExcluded: number;
    settledAnalyticalDuplicatesExcluded: number;
    uniqueAuditContexts: number;
    duplicateMarketSnapshotsExcluded: number;
''',
    "frontend sample type",
)
replace_once(
    path,
    '                  <span className="text-muted-foreground">Muestra liquidada para ampliar automatización</span>\n',
    '                  <span className="text-muted-foreground">Decisiones únicas liquidadas para ampliar automatización</span>\n',
    "frontend progress heading",
)
replace_once(
    path,
    ': `Faltan ${injuryReport.readiness.remaining} picks C1 liquidados para la primera revisión.`}',
    ': `Faltan ${injuryReport.readiness.remaining} decisiones únicas liquidadas para la primera revisión.`}',
    "frontend remaining copy",
)
replace_once(
    path,
    '''                  ["Picks auditados", injuryReport.sample.auditedPredictions],
                  ["Contextos únicos", injuryReport.sample.uniqueAuditContexts],
''',
    '''                  ["Registros C1", injuryReport.sample.auditedPredictions],
                  ["Decisiones únicas", injuryReport.sample.uniqueAnalyticalDecisions],
''',
    "frontend metric labels",
)
replace_once(
    path,
    '''              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <Activity className="h-4 w-4 text-cyan-300 shrink-0" />
                <p>
                  Se excluyeron {injuryReport.sample.duplicateMarketSnapshotsExcluded} snapshots duplicados de mercado al contar decisiones de lesiones. Así, guardar ML, F5 y total del mismo análisis no infla la calibración.
                </p>
              </div>
''',
    '''              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <Database className="h-4 w-4 text-cyan-300 shrink-0" />
                <p>
                  C2A usa {injuryReport.sample.uniqueAnalyticalDecisions} decisiones únicas de {injuryReport.sample.auditedPredictions} registros C1 para el progreso. Se excluyeron {injuryReport.sample.analyticalDuplicatesExcluded} duplicado(s) analítico(s).
                </p>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <Activity className="h-4 w-4 text-cyan-300 shrink-0" />
                <p>
                  La evidencia se agrupó en {injuryReport.sample.uniqueAuditContexts} contexto(s) de lesiones; se excluyeron {injuryReport.sample.duplicateMarketSnapshotsExcluded} snapshots de mercado equivalentes al sumar jugadores y ajustes.
                </p>
              </div>
''',
    "frontend C2A transparency notes",
)
