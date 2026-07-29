from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
ROUTES = SERVER / "routes.ts"
RUNTIME = SERVER / "route-runtime.ts"


def write_new(path: Path, content: str) -> None:
    if path.exists():
        raise SystemExit(f"Refusing to overwrite {path}")
    path.write_text(content, encoding="utf-8")


text = ROUTES.read_text(encoding="utf-8")

NBA_START = "  // ── GET /api/nba/teams"
MLB_LABEL = "  // MLB ROUTES"
WNBA_LABEL = "  // WNBA ROUTES (same NBA API with LeagueID=10)"
LEGACY_CALL = "  registerLegacyPicksCompatibilityRoutes(app);"
TAIL_START = "  // ── GET /api/odds/:sport"

# Locate the banner separators that precede MLB and WNBA labels.
mlb_label_index = text.index(MLB_LABEL)
nba_end = text.rfind("  // ════════════════════════════════════════════════════════════════════════════", 0, mlb_label_index)
wnba_label_index = text.index(WNBA_LABEL)
wnba_start = text.rfind("  // ════════════════════════════════════════════════════════════════════════════", 0, wnba_label_index)
legacy_index = text.index(LEGACY_CALL, wnba_start)
tail_start = text.index(TAIL_START, legacy_index)
function_end = text.rfind("\n}")
if min(nba_end, wnba_start, legacy_index, tail_start, function_end) < 0:
    raise SystemExit("One or more S3C structural boundaries were not found")

nba_body = text[text.index(NBA_START):nba_end]
wnba_nhl_body = text[wnba_start:legacy_index]
tail_body = text[tail_start:function_end]

# Replace the two hidden direct cache mutations with the public invalidation helper.
tail_body = tail_body.replace(
    'try { delete (cache as any)[`odds-v2-${req.params.sport.toLowerCase()}`]; } catch {}',
    'invalidateCache(`odds-v2-${String(req.params.sport).toLowerCase()}`)',
)
tail_body = tail_body.replace(
    'try { delete (cache as any)["mlb-f5-events-v1"]; } catch {}',
    'invalidateCache("mlb-f5-events-v1")',
)
if "cache as any" in tail_body:
    raise SystemExit("A direct route-level cache mutation remained after extraction")

nba_module = '''import type { Express } from "express";
import {
  NBA_HEADERS,
  SEASON,
  SELF_URL,
  idx,
  isoToNBA,
  nbaFetch,
  nbaToISO,
  todayNBA,
  withCache,
} from "./route-runtime";

/** NBA shared-data routes retained with their existing response contracts. */
export function registerNbaDataRoutes(app: Express): void {
'''
nba_module += nba_body
nba_module += "}\n"
write_new(SERVER / "nba-data-routes.ts", nba_module)

wnba_nhl_module = '''import type { Express } from "express";
import {
  FL_TZ,
  NBA_HEADERS,
  WNBA_HEADERS,
  idx,
  nbaFetch,
  todayISO,
  withCache,
  wnbaFetch,
} from "./route-runtime";

/** WNBA and NHL provider aggregation routes. */
export function registerWnbaNhlDataRoutes(app: Express): void {
'''
wnba_nhl_module += wnba_nhl_body
wnba_nhl_module += "}\n"
write_new(SERVER / "wnba-nhl-data-routes.ts", wnba_nhl_module)

support_module = '''import type { Express } from "express";
import {
  getNBARefImpact,
  getMLBUmpireImpact,
  type NBARefImpact,
  type MLBUmpireImpact,
} from "./referee-data";
import { getParkFactor, computeWeatherImpact, analyzeOpener } from "./mlb-advanced";
import {
  recordSnapshot,
  getHistoryForGame,
  getAllGameKeys,
  analyzeLineMovement,
  detectSteamMoves,
  detectReverseLineMovement,
  computeCLV,
} from "./sharp-signals";
import { computeContextual } from "./nba-contextual";
import { computeMLBContextual } from "./mlb-contextual";
import {
  FL_TZ,
  invalidateCache,
  requireSecret,
  withCache,
} from "./route-runtime";

/** Odds, officials, advanced context, sharp movement, CLV and health routes. */
export function registerMarketSupportRoutes(app: Express): void {
'''
support_module += tail_body
support_module += "}\n"
write_new(SERVER / "market-support-routes.ts", support_module)

# Expose a narrow cache invalidation API rather than letting routes mutate internals.
runtime = RUNTIME.read_text(encoding="utf-8")
cache_anchor = '''export async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < TTL) {
    return cache[key].data as T;
  }
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}
'''
cache_replacement = cache_anchor + '''
export function invalidateCache(key: string): void {
  delete cache[key];
}
'''
if runtime.count(cache_anchor) != 1:
    raise SystemExit("route-runtime cache anchor changed")
runtime = runtime.replace(cache_anchor, cache_replacement, 1)
RUNTIME.write_text(runtime, encoding="utf-8")

# Replace the monolith with a registry in the exact current registration order.
registry = '''import type { Express } from "express";
import type { Server } from "http";
import { registerNbaManualRoutes } from "./nba-manual-routes";
import { registerIndependentNbaRoutes } from "./nba-independent-routes";
import { registerNhlManualRoutes } from "./nhl-manual-routes";
import { registerIndependentWnbaRoutes } from "./wnba-independent-routes";
import { registerMlbEarlyRoutes } from "./mlb-early-routes";
import { registerLegacyPicksV2Routes } from "./legacy-picks-v2-routes";
import { registerNbaDataRoutes } from "./nba-data-routes";
import { registerMlbCoreRoutes } from "./mlb-core-routes";
import { registerWnbaNhlDataRoutes } from "./wnba-nhl-data-routes";
import { registerLegacyPicksCompatibilityRoutes } from "./legacy-picks-routes";
import { registerMarketSupportRoutes } from "./market-support-routes";

/**
 * Backend route composition root. Domain behavior lives in dedicated modules;
 * this function only preserves registration order and compatibility.
 */
export function registerRoutes(_httpServer: Server, app: Express): void {
  registerIndependentNbaRoutes(app);
  registerNbaManualRoutes(app);
  registerNhlManualRoutes(app);
  registerIndependentWnbaRoutes(app);
  registerMlbEarlyRoutes(app);
  registerLegacyPicksV2Routes(app);
  registerNbaDataRoutes(app);
  registerMlbCoreRoutes(app);
  registerWnbaNhlDataRoutes(app);
  registerLegacyPicksCompatibilityRoutes(app);
  registerMarketSupportRoutes(app);
}
'''
ROUTES.write_text(registry, encoding="utf-8")

# Add source-level assertions while keeping the typecheck focused on infrastructure.
test_path = SERVER / "routes-modularization.test.ts"
test_source = test_path.read_text(encoding="utf-8")
if 'test("S3C leaves a minimal route composition root"' not in test_source:
    test_source += r'''

test("S3C leaves a minimal route composition root", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  assert.match(source, /registerNbaDataRoutes\(app\)/);
  assert.match(source, /registerWnbaNhlDataRoutes\(app\)/);
  assert.match(source, /registerMarketSupportRoutes\(app\)/);
  assert.doesNotMatch(source, /app\.(get|post|put|patch|delete)\(/);
  assert.ok(source.split("\n").length < 80, "routes.ts should remain a small composition root");
});

test("S3C exposes cache invalidation without route-level cache mutation", () => {
  const runtime = fs.readFileSync(path.join(process.cwd(), "server", "route-runtime.ts"), "utf-8");
  const support = fs.readFileSync(path.join(process.cwd(), "server", "market-support-routes.ts"), "utf-8");
  assert.match(runtime, /export function invalidateCache/);
  assert.match(support, /invalidateCache\(/);
  assert.doesNotMatch(support, /cache as any/);
});
'''
test_path.write_text(test_source, encoding="utf-8")

print(json.dumps({
    "nbaLinesMoved": len(nba_body.splitlines()),
    "wnbaNhlLinesMoved": len(wnba_nhl_body.splitlines()),
    "supportLinesMoved": len(tail_body.splitlines()),
    "registryLines": len(registry.splitlines()),
}, indent=2))
