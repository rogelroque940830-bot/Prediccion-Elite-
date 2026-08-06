from pathlib import Path

SERVICE = Path("server/mlb-p1-scientific-capture-service.ts")
TEST = Path("server/mlb-p1-scientific-capture-service.test.ts")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_service() -> None:
    text = SERVICE.read_text()
    text = replace_once(
        text,
        '} from "./mlb-p1-scientific-capture-contract";\n\nexport const MLB_P1_M3B_SCHEMA',
        '} from "./mlb-p1-scientific-capture-contract";\nimport {\n  MLB_P1_M4B_SCHEMA,\n  attachMlbP1M4bEconomicDecision,\n  type MlbP1M4bAdapterResult,\n} from "./mlb-p1-economic-decision-adapter";\n\nexport const MLB_P1_M3B_SCHEMA',
        "adapter import",
    )
    text = replace_once(
        text,
        '  revision: MlbP1M3aRevisionResult;\n  ownership: {',
        '  revision: MlbP1M3aRevisionResult;\n  economicDecision: MlbP1M4bAdapterResult;\n  ownership: {',
        "result economic field",
    )
    text = replace_once(
        text,
        '  revision: MlbP1M3aRevisionResult;\n  userId: number;\n}): MlbP1M3bCaptureResult {',
        '  revision: MlbP1M3aRevisionResult;\n  economicDecision: MlbP1M4bAdapterResult;\n  userId: number;\n}): MlbP1M3bCaptureResult {',
        "response input economic field",
    )
    text = replace_once(
        text,
        '    validation: input.validation,\n    revision: input.revision,\n    ownership: {',
        '    validation: input.validation,\n    revision: input.revision,\n    economicDecision: input.economicDecision,\n    ownership: {',
        "response output economic field",
    )
    text = replace_once(
        text,
        '    const identity = validation.identity;\n    return this.withLifecycleLock(`${userId}:${identity.lifecycleKey}`, async () => {',
        '''    const attachment = attachMlbP1M4bEconomicDecision(candidate, serverNow);\n    if (\n      attachment.adapter.status !== "ADAPTED"\n      || !attachment.adapter.economicDecision\n      || !attachment.adapter.effectiveDecision\n      || !attachment.candidate\n      || (!attachment.attached && !attachment.idempotent)\n    ) {\n      throw new MlbP1M3bCaptureError(\n        422,\n        "P1_M4B_ADAPTER_REJECTED",\n        "The scientific capture could not be enriched with the P1-M4B economic decision.",\n        { errors: attachment.adapter.errors, warnings: attachment.adapter.warnings },\n      );\n    }\n    const enrichedCandidate = attachment.candidate;\n    const enrichedValidation = validateMlbP1M3aCapture(enrichedCandidate, serverNow);\n    if (!enrichedValidation.captureAllowed || !enrichedValidation.identity) {\n      throw new MlbP1M3bCaptureError(\n        422,\n        "P1_M4B_ENRICHED_CAPTURE_REJECTED",\n        "The P1-M4B enriched scientific capture failed P1-M3A revalidation.",\n        { errors: enrichedValidation.errors, warnings: enrichedValidation.warnings },\n      );\n    }\n    const economicDecision = attachment.adapter;\n    const identity = enrichedValidation.identity;\n    return this.withLifecycleLock(`${userId}:${identity.lifecycleKey}`, async () => {''',
        "capture attachment boundary",
    )
    text = replace_once(
        text,
        '      const revision = decideMlbP1M3aRevision(previous?.ref ?? null, candidate);',
        '      const revision = decideMlbP1M3aRevision(previous?.ref ?? null, enrichedCandidate);',
        "revision enriched candidate",
    )
    text = replace_once(
        text,
        '''          identity,\n          validation,\n          revision,\n          userId,\n''',
        '''          identity,\n          validation: enrichedValidation,\n          revision,\n          economicDecision,\n          userId,\n''',
        "idempotent response economic",
    )
    text = replace_once(
        text,
        '''      const ledgerInput = toMlbP1M3aLedgerCompatibleInput(\n        candidate,\n        identity,\n''',
        '''      const ledgerInput = toMlbP1M3aLedgerCompatibleInput(\n        enrichedCandidate,\n        identity,\n''',
        "ledger enriched candidate",
    )
    text = replace_once(
        text,
        '            candidateCapturedAt: candidate.capturedAt,',
        '            candidateCapturedAt: enrichedCandidate.capturedAt,',
        "candidate timestamp",
    )
    text = replace_once(
        text,
        '''        identity,\n        validation,\n        revision: effectiveRevision,\n        userId,\n''',
        '''        identity,\n        validation: enrichedValidation,\n        revision: effectiveRevision,\n        economicDecision,\n        userId,\n''',
        "appended response economic",
    )
    text = replace_once(
        text,
        'export const MLB_P1_M3B_ENDPOINT = "/api/mlb/p1/v1/scientific-captures" as const;',
        'export const MLB_P1_M3B_ENDPOINT = "/api/mlb/p1/v1/scientific-captures" as const;\nexport const MLB_P1_M4C_BACKEND_RELEASE = "p1-m4c-backend-economic-response-2026-08-06" as const;',
        "backend release",
    )
    SERVICE.write_text(text)


def patch_test() -> None:
    text = TEST.read_text()
    text = replace_once(
        text,
        'import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";\n',
        'import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";\nimport { MLB_P1_M4B_SCHEMA, MLB_P1_M4B_LAYER_KEY } from "./mlb-p1-economic-decision-adapter";\n',
        "test adapter import",
    )
    text = replace_once(
        text,
        '''    assert.equal(result.ownership.userId, 11);\n    assert.equal(result.safety.realFinancialExposure, 0);\n\n    const records''',
        '''    assert.equal(result.ownership.userId, 11);\n    assert.equal(result.safety.realFinancialExposure, 0);\n    assert.equal(result.economicDecision.schemaVersion, MLB_P1_M4B_SCHEMA);\n    assert.equal(result.economicDecision.status, "ADAPTED");\n    assert.equal(result.economicDecision.effectiveDecision?.decision, "LEAN");\n    assert.equal(result.economicDecision.effectiveDecision?.actionability, "WAIT_FOR_FINAL");\n    assert.equal(result.economicDecision.effectiveDecision?.analyticalUnits, 0);\n\n    const records''',
        "response economic assertions",
    )
    text = replace_once(
        text,
        '''    assert.equal(layers.p1M3aCapture.schemaVersion, MLB_P1_M3A_SCHEMA);\n    assert.equal(layers.p1M3bCapture.schemaVersion, MLB_P1_M3B_SCHEMA);''',
        '''    assert.equal(layers.p1M3aCapture.schemaVersion, MLB_P1_M3A_SCHEMA);\n    assert.equal(layers[MLB_P1_M4B_LAYER_KEY].schemaVersion, MLB_P1_M4B_SCHEMA);\n    assert.equal(layers[MLB_P1_M4B_LAYER_KEY].effectiveDecision.actionability, "WAIT_FOR_FINAL");\n    assert.equal(layers.p1M3bCapture.schemaVersion, MLB_P1_M3B_SCHEMA);''',
        "ledger economic layer assertions",
    )
    text = replace_once(
        text,
        '''    assert.equal(second.revision.decision, "IDEMPOTENT_RETRY");\n    assert.equal(ownedRecordsForUser(store, ownership, 12, { limit: 100 }).length, 1);''',
        '''    assert.equal(second.revision.decision, "IDEMPOTENT_RETRY");\n    assert.equal(second.economicDecision.sourceDigest, first.economicDecision.sourceDigest);\n    assert.equal(second.economicDecision.effectiveDecision?.actionability, "WAIT_FOR_FINAL");\n    assert.equal(ownedRecordsForUser(store, ownership, 12, { limit: 100 }).length, 1);''',
        "idempotent economic assertions",
    )
    TEST.write_text(text)


patch_service()
patch_test()
print("P1-M4C backend patch applied")
