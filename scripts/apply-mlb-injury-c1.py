from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


# Backend ledger validation
store = Path("server/mlb-ledger-store.ts")
text = store.read_text(encoding="utf-8")
text = replace_once(
    text,
    'import { z } from "zod";\n',
    'import { z } from "zod";\nimport { mlbInjuryAuditSchema } from "./mlb-injury-audit";\n',
    "ledger audit import",
)
text = replace_once(
    text,
    '''    layers: z.record(z.unknown()).optional(),
    rawInputs: z.unknown().optional(),
''',
    '''    layers: z.record(z.unknown()).optional(),
    injuryAudit: mlbInjuryAuditSchema.optional(),
    rawInputs: z.unknown().optional(),
''',
    "ledger analysis injury audit field",
)
store.write_text(text, encoding="utf-8")

# Frontend scientific snapshot type
snapshot = Path("frontend/client/src/lib/mlb-scientific-snapshot.ts")
text = snapshot.read_text(encoding="utf-8")
text = replace_once(
    text,
    'export type MlbLedgerMarketType =\n',
    'import type { MlbInjuryAuditSnapshot } from "./mlb-injury-audit";\n\nexport type MlbLedgerMarketType =\n',
    "scientific snapshot audit type import",
)
text = replace_once(
    text,
    '''    layers?: Record<string, unknown>;
    rawInputs?: unknown;
''',
    '''    layers?: Record<string, unknown>;
    injuryAudit?: MlbInjuryAuditSnapshot;
    rawInputs?: unknown;
''',
    "scientific snapshot injury audit field",
)
snapshot.write_text(text, encoding="utf-8")

# Predictor snapshot construction
predictor = Path("frontend/client/src/pages/mlb-predictor.tsx")
text = predictor.read_text(encoding="utf-8")
text = replace_once(
    text,
    'import { resolveMlbPhaseBSelection, scaleMlbPhaseBRuns } from "@/lib/mlb-injury-phase-b";\n',
    'import { resolveMlbPhaseBSelection, scaleMlbPhaseBRuns } from "@/lib/mlb-injury-phase-b";\nimport { buildMlbInjuryAuditSnapshot } from "@/lib/mlb-injury-audit";\n',
    "predictor injury audit import",
)
text = replace_once(
    text,
    '''  officialValidationStatus?: "VERIFIED" | "PARTIAL";
  officialFetchedAt?: string;
  count: number;
''',
    '''  officialValidationStatus?: "VERIFIED" | "PARTIAL";
  officialFetchedAt?: string;
  rejectedCount?: number;
  count: number;
''',
    "predictor rejected count type",
)
text = replace_once(
    text,
    '''    const warnings = [
      ...(pq?.warnings || []),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional: faltan identificador oficial del juego o verificación completa de lesiones."] : []),
    ];

    const scientificSnapshot = createMlbScientificSnapshot({
''',
    '''    const warnings = [
      ...(pq?.warnings || []),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional: faltan identificador oficial del juego o verificación completa de lesiones."] : []),
    ];

    const homeAuditResolution = resolveMlbPhaseBSelection(homeInjuryRoster, homeInjuryFeed, bullpenStatus?.home);
    const awayAuditResolution = resolveMlbPhaseBSelection(awayInjuryRoster, awayInjuryFeed, bullpenStatus?.away);
    const homeAuditRawImpact = calcMLBInjuryImpact(homeInjuryRoster, homePhaseBAutoApplied, homeInjuryGamesOut);
    const awayAuditRawImpact = calcMLBInjuryImpact(awayInjuryRoster, awayPhaseBAutoApplied, awayInjuryGamesOut);
    const homeAuditScaledRuns = scaleMlbPhaseBRuns(
      homeAuditRawImpact.runs,
      homeInjuryFeed.phaseB?.scale ?? 0,
      homeInjuryFeed.phaseB?.maxAbsRuns ?? 0,
    );
    const awayAuditScaledRuns = scaleMlbPhaseBRuns(
      awayAuditRawImpact.runs,
      awayInjuryFeed.phaseB?.scale ?? 0,
      awayInjuryFeed.phaseB?.maxAbsRuns ?? 0,
    );
    const homeSelectedNames = Array.from(homeInjuryMissing);
    const awaySelectedNames = Array.from(awayInjuryMissing);
    const homeAutoNames = Array.from(homePhaseBAutoApplied);
    const awayAutoNames = Array.from(awayPhaseBAutoApplied);
    const setMismatch = (left: string[], right: string[]) => {
      const rightSet = new Set(right);
      return left.length !== right.length || left.some((name) => !rightSet.has(name));
    };
    const homeManualOverride = homeInjuryFactors.type === "Manual"
      || homePhaseBStatus.includes("Override manual")
      || setMismatch(homeSelectedNames, homeAutoNames);
    const awayManualOverride = awayInjuryFactors.type === "Manual"
      || awayPhaseBStatus.includes("Override manual")
      || setMismatch(awaySelectedNames, awayAutoNames);
    const injuryAudit = buildMlbInjuryAuditSnapshot({
      capturedAt,
      home: {
        side: "HOME",
        teamName: homeTeam || "Local",
        teamId: homeTeamMlbId,
        feed: homeInjuryFeed,
        roster: homeInjuryRoster,
        selectedPlayerNames: homeInjuryMissing,
        autoAppliedPlayerNames: homePhaseBAutoApplied,
        rawAutomaticRuns: homeAuditRawImpact.runs,
        scaledAutomaticRuns: homeAuditScaledRuns,
        finalRuns: parseFloat(homeInjury) || 0,
        manualOverride: homeManualOverride,
        factors: homeInjuryFactors,
        bullpenSide: bullpenStatus?.home,
        blockedReason: homeAuditResolution.blockedReason,
        statusText: homePhaseBStatus,
      },
      away: {
        side: "AWAY",
        teamName: awayTeam || "Visitante",
        teamId: awayTeamMlbId,
        feed: awayInjuryFeed,
        roster: awayInjuryRoster,
        selectedPlayerNames: awayInjuryMissing,
        autoAppliedPlayerNames: awayPhaseBAutoApplied,
        rawAutomaticRuns: awayAuditRawImpact.runs,
        scaledAutomaticRuns: awayAuditScaledRuns,
        finalRuns: parseFloat(awayInjury) || 0,
        manualOverride: awayManualOverride,
        factors: awayInjuryFactors,
        bullpenSide: bullpenStatus?.away,
        blockedReason: awayAuditResolution.blockedReason,
        statusText: awayPhaseBStatus,
      },
    });

    const scientificSnapshot = createMlbScientificSnapshot({
''',
    "predictor injury audit construction",
)
text = replace_once(
    text,
    '        version: "predictor-full-snapshot-v1",\n',
    '        version: "predictor-full-snapshot-v2",\n',
    "predictor model snapshot version",
)
text = replace_once(
    text,
    '''        stage,
        warnings,
        factors: (result.factorBreakdown?.notes || []).slice(0, 100).map((note) => ({
''',
    '''        stage,
        warnings,
        injuryAudit,
        factors: (result.factorBreakdown?.notes || []).slice(0, 100).map((note) => ({
''',
    "predictor analysis audit payload",
)
predictor.write_text(text, encoding="utf-8")

# Regression suite
package = Path("package.json")
text = package.read_text(encoding="utf-8")
text = replace_once(
    text,
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\n',
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\n',
    "ledger test script audit",
)
text = replace_once(
    text,
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\n',
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\n',
    "injury test script audit",
)
text = replace_once(
    text,
    'server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts"\n',
    'server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts"\n',
    "shadow test script audit",
)
package.write_text(text, encoding="utf-8")

# Ledger round-trip and hash tests
ledger_test = Path("server/mlb-ledger.test.ts")
text = ledger_test.read_text(encoding="utf-8")
fixture = '''function injuryAuditPayload() {
  const team = (side: "HOME" | "AWAY", teamName: string) => ({
    side,
    teamName,
    source: {
      detector: "BALLDONTLIE",
      detectorStatus: "VERIFIED",
      detectorFetchedAt: "2026-07-26T19:58:00.000Z",
      detectorStale: false,
      validator: "MLB_STATS",
      validatorStatus: "VERIFIED",
      validatorFetchedAt: "2026-07-26T19:58:05.000Z",
      rejectedCount: 0,
      officialOnly: 0,
    },
    phaseB: {
      enabled: true,
      mode: "AUTO_CONSERVATIVE" as const,
      coverage: "FULL" as const,
      candidateCount: 1,
      eligiblePlayerNames: ["Test Closer"],
      withheldCandidateNames: [],
      scale: 0.5,
      maxAbsRuns: 0.5,
      autoApplyAllowed: true,
      requiresBullpenReconciliation: true,
      reason: "Test Phase B plan",
    },
    reconciliation: {
      bullpenStatusAvailable: true,
      bullpenRunsAdjustment: 0,
      blockedReason: null,
      closerAvailable: true,
      bullpenCompromised: false,
      statusText: "One reliever auto-applied",
    },
    adjustment: {
      rawAutomaticRuns: -0.8,
      scaledAutomaticRuns: -0.4,
      finalRuns: -0.4,
      manualOverride: false,
      factorType: "Fase B automática",
      offenseFactor: 1,
      defenseFactor: 0.8,
      selectedPlayerNames: ["Test Closer"],
      autoAppliedPlayerNames: ["Test Closer"],
    },
    counts: {
      detected: 1,
      candidates: 1,
      backendEligible: 1,
      autoApplied: 1,
      selected: 1,
      retained: 0,
      rejected: 0,
      officialOnly: 0,
    },
    players: [{
      playerId: side === "HOME" ? 101 : 201,
      name: "Test Closer",
      position: "P",
      isPitcher: true,
      detectorSource: "BALLDONTLIE",
      reportedStatus: "Out",
      officialStatusCode: "D15",
      officialStatus: "Injured 15-Day",
      officialTransaction: null,
      shadow: {
        decision: "APPLY_CANDIDATE" as const,
        confidence: "HIGH" as const,
        impact: "HIGH" as const,
        reasonCode: "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
        reason: "Official recent high-leverage reliever injury.",
        daysSinceOfficialTransaction: 1,
      },
      disposition: "AUTO_APPLIED" as const,
    }],
  });
  return {
    schemaVersion: "mlb-injury-audit.v1" as const,
    capturedAt: "2026-07-26T20:00:00.000Z",
    mode: "PHASE_B_AUTO_CONSERVATIVE" as const,
    home: team("HOME", "Home Club"),
    away: team("AWAY", "Away Club"),
  };
}

'''
text = replace_once(
    text,
    'function predictionPayload(overrides: Record<string, unknown> = {}) {\n',
    fixture + 'function predictionPayload(overrides: Record<string, unknown> = {}) {\n',
    "ledger audit fixture",
)
text = replace_once(
    text,
    '''      layers: { pureModel: 0.61 },
      rawInputs: { test: true },
''',
    '''      layers: { pureModel: 0.61 },
      injuryAudit: injuryAuditPayload(),
      rawInputs: { test: true },
''',
    "ledger prediction audit fixture use",
)
text = replace_once(
    text,
    '''    assert.ok(Math.abs(first.data.probabilities.edgePp - 6.5) < 1e-9);

    const retry = store.appendPrediction(predictionPayload());
''',
    '''    assert.ok(Math.abs(first.data.probabilities.edgePp - 6.5) < 1e-9);
    assert.equal(first.data.payload.analysis.injuryAudit.schemaVersion, "mlb-injury-audit.v1");
    assert.equal(first.data.payload.analysis.injuryAudit.home.adjustment.finalRuns, -0.4);

    const retry = store.appendPrediction(predictionPayload());
''',
    "ledger audit round-trip assertions",
)
new_test = '''
test("injury audit is hashed into the immutable payload and malformed evidence is rejected", () => {
  withStore((store) => {
    const firstPayload: any = predictionPayload({ clientRequestId: "req-audit-hash-001" });
    const first = store.appendPrediction(firstPayload).data;

    const changedPayload: any = predictionPayload({ clientRequestId: "req-audit-hash-002" });
    changedPayload.analysis.injuryAudit.home.adjustment.finalRuns = -0.2;
    const changed = store.appendPrediction(changedPayload).data;
    assert.notEqual(first.payloadSha256, changed.payloadSha256);

    const malformed: any = predictionPayload({ clientRequestId: "req-audit-invalid-001" });
    malformed.analysis.injuryAudit.schemaVersion = "mlb-injury-audit.invalid";
    assert.throws(() => store.appendPrediction(malformed));
  });
});

'''
text = replace_once(
    text,
    'test("settlements are idempotent, append-only and corrected by append order", () => {\n',
    new_test + 'test("settlements are idempotent, append-only and corrected by append order", () => {\n',
    "ledger audit hash test",
)
ledger_test.write_text(text, encoding="utf-8")
