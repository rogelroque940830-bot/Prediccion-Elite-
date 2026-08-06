from pathlib import Path

CAPTURE = Path("frontend/client/src/lib/mlb-scientific-capture.ts")
STATUS = Path("frontend/client/src/components/mlb-scientific-capture-status.tsx")
APP = Path("frontend/client/src/App.tsx")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_capture() -> None:
    text = CAPTURE.read_text()
    text = replace_once(
        text,
        'import { prepareMlbP1M3cSnapshotForTransport } from "./mlb-scientific-capture-transport";\n',
        'import { prepareMlbP1M3cSnapshotForTransport } from "./mlb-scientific-capture-transport";\nimport {\n  MLB_P1_M4C_FRONTEND_RELEASE,\n  parseMlbEconomicAdapterResult,\n  type MlbEconomicAdapterResult,\n} from "./mlb-economic-decision";\n',
        "economic contract import",
    )
    text = replace_once(
        text,
        'export const MLB_P1_M3C_FRONTEND_RELEASE = "p1-m3c1-json-digest-transport-2026-08-05" as const;',
        'export const MLB_P1_M3C_FRONTEND_RELEASE = MLB_P1_M4C_FRONTEND_RELEASE;',
        "frontend release alias",
    )
    text = replace_once(
        text,
        '''  revision: {\n    decision: string;\n    supersedesId: string | null;\n    reason: string;\n  };\n  safety: {''',
        '''  revision: {\n    decision: string;\n    supersedesId: string | null;\n    reason: string;\n  };\n  economicDecision: MlbEconomicAdapterResult;\n  safety: {''',
        "capture result economic field",
    )
    text = replace_once(
        text,
        '''      revisionDecision: string;\n    }\n  | {''',
        '''      revisionDecision: string;\n      economicDecision: MlbEconomicAdapterResult;\n    }\n  | {''',
        "ui success economic field",
    )
    text = replace_once(
        text,
        '''function validCaptureResult(value: unknown): value is MlbP1M3bCaptureResult {\n  const data = record(value);\n  const safety = record(data?.safety);\n  return data?.schemaVersion === MLB_P1_M3B_SCHEMA''',
        '''function validCaptureResult(value: unknown): value is MlbP1M3bCaptureResult {\n  const data = record(value);\n  const safety = record(data?.safety);\n  const economicDecision = parseMlbEconomicAdapterResult(data?.economicDecision);\n  return data?.schemaVersion === MLB_P1_M3B_SCHEMA''',
        "capture validator parse",
    )
    text = replace_once(
        text,
        '''    && typeof data?.recordedAt === "string"\n    && safety?.mode === "SHADOW_DECISION_SUPPORT"''',
        '''    && typeof data?.recordedAt === "string"\n    && economicDecision != null\n    && safety?.mode === "SHADOW_DECISION_SUPPORT"''',
        "capture validator economic requirement",
    )
    text = replace_once(
        text,
        '''    recordedAt: result.recordedAt,\n    revisionDecision: result.revision.decision,\n  };''',
        '''    recordedAt: result.recordedAt,\n    revisionDecision: result.revision.decision,\n    economicDecision: result.economicDecision,\n  };''',
        "ui success economic value",
    )
    CAPTURE.write_text(text)


def patch_status() -> None:
    text = STATUS.read_text()
    text = replace_once(
        text,
        'import type { MlbP1M3cUiState } from "@/lib/mlb-scientific-capture";\n',
        'import type { MlbP1M3cUiState } from "@/lib/mlb-scientific-capture";\nimport { MlbEconomicDecisionCard } from "@/components/mlb-economic-decision-card";\n',
        "status card import",
    )
    text = replace_once(
        text,
        '''          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400">\n            <ShieldCheck className="h-3.5 w-3.5" />\n            Sin apuesta automática, sin sportsbook y sin exposición financiera real.\n          </div>\n        </div>\n      </CardContent>\n    </Card>''',
        '''          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400">\n            <ShieldCheck className="h-3.5 w-3.5" />\n            Sin apuesta automática, sin sportsbook y sin exposición financiera real.\n          </div>\n        </div>\n      </CardContent>\n      <CardContent className="px-4 pb-4 pt-0">\n        <MlbEconomicDecisionCard decision={state.economicDecision} />\n      </CardContent>\n    </Card>''',
        "status economic card render",
    )
    STATUS.write_text(text)


def patch_app() -> None:
    text = APP.read_text()
    text = replace_once(
        text,
        'import { MLB_P1_M3C_FRONTEND_RELEASE } from "@/lib/mlb-scientific-capture";\n',
        'import { MLB_P1_M4C_FRONTEND_RELEASE } from "@/lib/mlb-economic-decision";\n',
        "app release import",
    )
    text = replace_once(
        text,
        'const FRONTEND_RELEASE = MLB_P1_M3C_FRONTEND_RELEASE;',
        'const FRONTEND_RELEASE = MLB_P1_M4C_FRONTEND_RELEASE;',
        "app release value",
    )
    text = replace_once(
        text,
        'const PREVIOUS_OPERATIONAL_RELEASES = "p1-m2c3-mlb-smart-default-2026-08-05',
        'const PREVIOUS_OPERATIONAL_RELEASES = "p1-m3c1-json-digest-transport-2026-08-05 p1-m2c3-mlb-smart-default-2026-08-05',
        "previous release lineage",
    )
    APP.write_text(text)


patch_capture()
patch_status()
patch_app()
print("P1-M4C frontend patch applied")
