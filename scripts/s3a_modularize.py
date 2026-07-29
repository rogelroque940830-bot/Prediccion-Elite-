from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
ROUTES = SERVER / "routes.ts"


def write_new(path: Path, content: str) -> None:
    if path.exists():
        raise SystemExit(f"Refusing to overwrite existing file: {path}")
    path.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


def route_inventory() -> list[dict[str, object]]:
    pattern = re.compile(r"\bapp\.(get|post|put|patch|delete)\s*\(\s*([\"'`])([^\"'`]+)\2")
    counter: Counter[tuple[str, str]] = Counter()
    for path in sorted(SERVER.rglob("*.ts")):
        if path.name.endswith(".test.ts") or path.name.endswith(".spec.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        for method, _quote, route in pattern.findall(text):
            if route.startswith("/api/") or route == "/health":
                counter[(method.upper(), route)] += 1
    return [
        {"method": method, "path": route, "registrations": count}
        for (method, route), count in sorted(counter.items())
    ]


original_inventory = route_inventory()
if len(original_inventory) < 20:
    raise SystemExit(f"Unexpectedly small route inventory: {len(original_inventory)}")

route_runtime = r'''import type { RequestInit } from "node-fetch";

export function requireSecret(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const NBA_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Origin": "https://www.nba.com",
  "Connection": "keep-alive",
};

export const WNBA_HEADERS: Record<string, string> = {
  ...NBA_HEADERS,
  Referer: "https://www.wnba.com/",
  Origin: "https://www.wnba.com",
};

export const SEASON = "2025-26";
export const FL_TZ = "America/New_York";
export const SELF_URL = `http://localhost:${process.env.PORT || 5000}`;

const cache: Record<string, { data: unknown; ts: number }> = {};
const TTL = 30 * 60 * 1000;

export async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < TTL) {
    return cache[key].data as T;
  }
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}

export async function nbaFetch(
  url: string,
  headers: Record<string, string> = NBA_HEADERS,
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function wnbaFetch(url: string) {
  const candidates: Array<{ url: string; headers: Record<string, string> }> = url.includes("stats.nba.com")
    ? [
        { url, headers: NBA_HEADERS },
        { url: url.replace("https://stats.nba.com", "https://stats.wnba.com"), headers: WNBA_HEADERS },
      ]
    : [{ url, headers: url.includes("stats.wnba.com") ? WNBA_HEADERS : NBA_HEADERS }];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await nbaFetch(candidate.url, candidate.headers, 12_000);
    } catch (error) {
      lastError = error;
      console.warn(`WNBA stats source failed: ${candidate.url}`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WNBA stats sources unavailable");
}

export function idx(headers: string[], name: string): number {
  return headers.indexOf(name);
}

export function floridaParts(offsetDays = 0): { y: string; m: string; d: string } {
  const now = new Date();
  if (offsetDays) now.setUTCDate(now.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((part) => [part.type, part.value]));
  return { y: parts.year, m: parts.month, d: parts.day };
}

export function todayNBA(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

export function todayISO(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

export function isoToNBA(iso: string): string {
  return iso;
}

export function nbaToISO(nba: string): string {
  const match = nba.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return nba;
  return `${match[3]}-${match[1]}-${match[2]}`;
}
'''
# Remove an accidental unused type-only import before writing.
route_runtime = route_runtime.replace('import type { RequestInit } from "node-fetch";\n\n', '')

legacy_store = r'''import fs from "node:fs";
import path from "node:path";

export interface SavedPick {
  id: string;
  ts: number;
  sport: "mlb" | "nba" | "nhl" | "wnba";
  homeTeam: string;
  awayTeam: string;
  pickType: string;
  pickSide: string;
  confidence: number;
  edge?: number;
  odds?: string;
  line?: string;
  notes?: string;
}

const PICKS_FILE = path.join(process.cwd(), "data", "picks.json");

export function loadPicks(): SavedPick[] {
  try {
    if (!fs.existsSync(PICKS_FILE)) return [];
    const raw = fs.readFileSync(PICKS_FILE, "utf-8");
    return JSON.parse(raw) as SavedPick[];
  } catch (error) {
    console.error("loadPicks error:", error);
    return [];
  }
}

export function savePicks(picks: SavedPick[]): void {
  try {
    const dir = path.dirname(PICKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2), "utf-8");
  } catch (error) {
    console.error("savePicks error:", error);
  }
}
'''

mlb_runtime = r'''export async function resolveMlbAnalysisDate(rawDate: unknown, gamePk?: number): Promise<string> {
  const candidate = String(rawDate || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;

  if (Number.isFinite(gamePk) && Number(gamePk) > 0) {
    try {
      const response = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=${Number(gamePk)}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } },
      );
      if (response.ok) {
        const payload: any = await response.json();
        const resolved = payload?.dates?.[0]?.date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(resolved || ""))) {
          return String(resolved);
        }
      }
    } catch (error) {
      console.warn("[MLB] Could not resolve analysis date from gamePk", gamePk, error);
    }
  }

  return new Date().toISOString().slice(0, 10);
}
'''

write_new(SERVER / "route-runtime.ts", route_runtime)
write_new(SERVER / "legacy-picks-store.ts", legacy_store)
write_new(SERVER / "mlb-route-runtime.ts", mlb_runtime)

text = ROUTES.read_text(encoding="utf-8")
text = replace_once(text, 'import fs from "fs";\nimport path from "path";\n', '', "legacy fs/path imports")

insert_anchor = 'import { buildMlbInjuryPhaseBPlan } from "./mlb-injury-phase-b";\n'
new_imports = insert_anchor + '''import {
  FL_TZ,
  NBA_HEADERS,
  SEASON,
  SELF_URL,
  WNBA_HEADERS,
  floridaParts,
  idx,
  isoToNBA,
  nbaFetch,
  nbaToISO,
  requireSecret,
  todayISO,
  todayNBA,
  withCache,
  wnbaFetch,
} from "./route-runtime";
import { loadPicks, savePicks, type SavedPick } from "./legacy-picks-store";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";
'''
text = replace_once(text, insert_anchor, new_imports, "route runtime import anchor")

helper_start = text.index('function requireSecret(name: string): string {')
helper_end = text.index('import { computeMlbTesi } from "./mlb-tesi.js";', helper_start)
text = text[:helper_start] + text[helper_end:]

picks_start = text.index('// ── Picks history storage')
routes_start = text.index('export function registerRoutes(', picks_start)
text = text[:picks_start] + text[routes_start:]
ROUTES.write_text(text, encoding="utf-8")

snapshot_path = SERVER / "route-contract.snapshot.json"
snapshot_path.write_text(json.dumps(original_inventory, indent=2) + "\n", encoding="utf-8")

contract_test = r'''import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

interface RouteContractEntry {
  method: string;
  path: string;
  registrations: number;
}

function collectRouteInventory(): RouteContractEntry[] {
  const serverDir = path.join(process.cwd(), "server");
  const counter = new Map<string, number>();
  const pattern = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\2/g;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
      const source = fs.readFileSync(full, "utf-8");
      for (const match of source.matchAll(pattern)) {
        const route = match[3];
        if (!route.startsWith("/api/") && route !== "/health") continue;
        const key = `${match[1].toUpperCase()} ${route}`;
        counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
  };

  walk(serverDir);
  return [...counter.entries()]
    .map(([key, registrations]) => {
      const separator = key.indexOf(" ");
      return {
        method: key.slice(0, separator),
        path: key.slice(separator + 1),
        registrations,
      };
    })
    .sort((left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path));
}

test("S3 preserves the backend route contract", () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "server", "route-contract.snapshot.json"), "utf-8"),
  ) as RouteContractEntry[];
  assert.deepEqual(collectRouteInventory(), expected);
});

test("S3A removes shared runtime and legacy persistence from routes.ts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  assert.match(source, /from "\.\/route-runtime"/);
  assert.match(source, /from "\.\/legacy-picks-store"/);
  assert.match(source, /from "\.\/mlb-route-runtime"/);
  assert.doesNotMatch(source, /const NBA_HEADERS\s*=/);
  assert.doesNotMatch(source, /const PICKS_FILE\s*=/);
  assert.doesNotMatch(source, /async function resolveMlbAnalysisDate/);
});
'''
write_new(SERVER / "routes-modularization.test.ts", contract_test)

s3_config = {
    "extends": "./tsconfig.json",
    "include": [
        "server/route-runtime.ts",
        "server/legacy-picks-store.ts",
        "server/mlb-route-runtime.ts",
        "server/routes-modularization.test.ts",
    ],
    "exclude": ["node_modules", "dist"],
    "compilerOptions": {"target": "ES2020", "noEmit": True},
}
write_new(ROOT / "tsconfig.s3-modularization.json", json.dumps(s3_config, indent=2) + "\n")

package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package.setdefault("scripts", {})
scripts["test:s3-modularization"] = "tsx --test server/routes-modularization.test.ts"
scripts["typecheck:s3-modularization"] = "tsc -p tsconfig.s3-modularization.json"
package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

final_inventory = route_inventory()
if final_inventory != original_inventory:
    raise SystemExit("Route inventory changed during S3A extraction")

print(json.dumps({
    "routeContracts": len(original_inventory),
    "routesBeforeLines": len(ROUTES.read_text(encoding="utf-8").splitlines()),
    "created": [
        "server/route-runtime.ts",
        "server/legacy-picks-store.ts",
        "server/mlb-route-runtime.ts",
        "server/route-contract.snapshot.json",
        "server/routes-modularization.test.ts",
        "tsconfig.s3-modularization.json",
    ],
}, indent=2))
