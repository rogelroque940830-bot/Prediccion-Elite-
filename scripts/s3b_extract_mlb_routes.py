from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
ROUTES = SERVER / "routes.ts"


def write_new(path: Path, content: str) -> None:
    if path.exists():
        raise SystemExit(f"Refusing to overwrite {path}")
    path.write_text(content, encoding="utf-8")


def exact_block(text: str, start_marker: str, end_marker: str) -> str:
    if text.count(start_marker) != 1:
        raise SystemExit(f"Expected one start marker {start_marker!r}, found {text.count(start_marker)}")
    if text.count(end_marker) != 1:
        raise SystemExit(f"Expected one end marker {end_marker!r}, found {text.count(end_marker)}")
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    return text[start:end]


text = ROUTES.read_text(encoding="utf-8")

EARLY_START = "  // ── Early Markets MLB"
EARLY_END = "  // ── Picks history endpoints"
PICKS_START = EARLY_END
PICKS_END = "  // ── GET /api/nba/teams"
CORE_START = '  const MLB_BASE = "https://statsapi.mlb.com/api/v1";'
WNBA_LABEL = "  // WNBA ROUTES (same NBA API with LeagueID=10)"

# Preserve the WNBA banner in routes.ts by cutting at the preceding separator.
wnba_label_index = text.index(WNBA_LABEL)
core_end = text.rfind("  // ════════════════════════════════════════════════════════════════════════════", 0, wnba_label_index)
if core_end < 0:
    raise SystemExit("Could not locate WNBA separator")

core_body = text[text.index(CORE_START):core_end]
early_body = exact_block(text, EARLY_START, EARLY_END)
picks_body = exact_block(text, PICKS_START, PICKS_END)

mlb_early = '''import type { Express } from "express";
import { computeMlbTesi } from "./mlb-tesi.js";
import { computeMlbEre } from "./mlb-ere.js";
import { computeEarlyMarkets } from "./mlb-early-markets.js";
import { computeF5Unified, type PitcherRecentForm, type UmpireData } from "./mlb-f5-unified.js";
import { computeMatchupSignal } from "./mlb-matchup-signal.js";
import { computeUncertainty } from "./mlb-uncertainty.js";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

export function registerMlbEarlyRoutes(app: Express): void {
'''
mlb_early += early_body
mlb_early += "}\n"
write_new(SERVER / "mlb-early-routes.ts", mlb_early)

legacy_v2 = '''import type { Express } from "express";
import { loadPicks, savePicks, type SavedPick } from "./legacy-picks-store";

/** Compatibility-only history endpoints retained until the old dashboard is retired. */
export function registerLegacyPicksV2Routes(app: Express): void {
'''
legacy_v2 += picks_body
legacy_v2 += "}\n"
write_new(SERVER / "legacy-picks-v2-routes.ts", legacy_v2)

mlb_core = '''import type { Express } from "express";
import { getParkFactor, computeWeatherImpact, analyzeOpener } from "./mlb-advanced";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";
import {
  classifyMlbInjuryShadow,
  fetchOfficialMlbInjurySnapshot,
  summarizeMlbInjuryShadow,
} from "./mlb-injury-shadow";
import { buildMlbInjuryPhaseBPlan } from "./mlb-injury-phase-b";
import { FL_TZ, requireSecret, todayISO, withCache } from "./route-runtime";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

/** MLB metadata, injury, pitcher, matchup, lineup and aggregate routes. */
export function registerMlbCoreRoutes(app: Express): void {
'''
mlb_core += core_body
mlb_core += "}\n"
write_new(SERVER / "mlb-core-routes.ts", mlb_core)

# Install registrar imports before changing blocks.
import_anchor = 'import { resolveMlbAnalysisDate } from "./mlb-route-runtime";\n'
registrar_imports = import_anchor + '''import { registerMlbEarlyRoutes } from "./mlb-early-routes";
import { registerMlbCoreRoutes } from "./mlb-core-routes";
import { registerLegacyPicksV2Routes } from "./legacy-picks-v2-routes";
'''
if text.count(import_anchor) != 1:
    raise SystemExit("Registrar import anchor changed")
text = text.replace(import_anchor, registrar_imports, 1)

# Replace exact bodies, not line offsets, so import insertion cannot shift a cut.
if text.count(early_body) != 1 or text.count(picks_body) != 1 or text.count(core_body) != 1:
    raise SystemExit("One or more extracted blocks are not uniquely replaceable")
text = text.replace(early_body, "  registerMlbEarlyRoutes(app);\n\n", 1)
text = text.replace(picks_body, "  registerLegacyPicksV2Routes(app);\n\n", 1)
text = text.replace(core_body, "  registerMlbCoreRoutes(app);\n\n", 1)
ROUTES.write_text(text, encoding="utf-8")

config_path = ROOT / "tsconfig.s3-modularization.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
for module in [
    "server/mlb-early-routes.ts",
    "server/mlb-core-routes.ts",
    "server/legacy-picks-v2-routes.ts",
]:
    if module not in config["include"]:
        config["include"].append(module)
config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

test_path = SERVER / "routes-modularization.test.ts"
test_source = test_path.read_text(encoding="utf-8")
if 'test("S3B moves MLB route domains out of routes.ts"' not in test_source:
    test_source += r'''

test("S3B moves MLB route domains out of routes.ts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  assert.match(source, /registerMlbEarlyRoutes\(app\)/);
  assert.match(source, /registerMlbCoreRoutes\(app\)/);
  assert.match(source, /registerLegacyPicksV2Routes\(app\)/);
  assert.doesNotMatch(source, /app\.post\("\/api\/mlb\/early-markets"/);
  assert.doesNotMatch(source, /app\.get\("\/api\/mlb\/all"/);
  assert.doesNotMatch(source, /async function getGameMeta/);
  assert.ok(source.split("\n").length < 2800, "routes.ts should be below 2,800 lines after S3B");
});
'''
test_path.write_text(test_source, encoding="utf-8")

# The contract snapshot must remain byte-for-byte unchanged and the main file should shrink substantially.
if len(text.splitlines()) >= 2800:
    raise SystemExit(f"routes.ts remained too large after S3B: {len(text.splitlines())} lines")

print(json.dumps({
    "earlyLinesMoved": len(early_body.splitlines()),
    "legacyV2LinesMoved": len(picks_body.splitlines()),
    "coreLinesMoved": len(core_body.splitlines()),
    "routesLinesAfter": len(text.splitlines()),
}, indent=2))
