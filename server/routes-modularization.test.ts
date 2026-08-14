import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

interface RouteContractEntry {
  method: string;
  path: string;
  registrations: number;
}

function sortRoutes(routes: RouteContractEntry[]): RouteContractEntry[] {
  return [...routes].sort(
    (left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path),
  );
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
  return sortRoutes(
    [...counter.entries()].map(([key, registrations]) => {
      const separator = key.indexOf(" ");
      return {
        method: key.slice(0, separator),
        path: key.slice(separator + 1),
        registrations,
      };
    }),
  );
}

function readExtensions(): RouteContractEntry[] {
  const filePath = path.join(process.cwd(), "server", "route-contract.extensions.json");
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as RouteContractEntry[];
}

test("S3 preserves the backend route contract", () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "server", "route-contract.snapshot.json"), "utf-8"),
  ) as RouteContractEntry[];
  const s5bPrivateRoutes: RouteContractEntry[] = [
    {
      method: "GET",
      path: "/api/mlb/ledger/v1/shadow-collection/latest",
      registrations: 1,
    },
    {
      method: "GET",
      path: "/api/mlb/ledger/v1/shadow-collection/status",
      registrations: 1,
    },
  ];
  assert.deepEqual(
    collectRouteInventory(),
    sortRoutes([...expected, ...s5bPrivateRoutes, ...readExtensions()]),
  );
});

test("S3A keeps shared runtime and legacy persistence in dedicated modules", () => {
  const registry = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  const runtime = fs.readFileSync(path.join(process.cwd(), "server", "route-runtime.ts"), "utf-8");
  const legacyStore = fs.readFileSync(path.join(process.cwd(), "server", "legacy-picks-store.ts"), "utf-8");
  const legacyRoutes = fs.readFileSync(path.join(process.cwd(), "server", "legacy-picks-routes.ts"), "utf-8");
  const mlbRuntime = fs.readFileSync(path.join(process.cwd(), "server", "mlb-route-runtime.ts"), "utf-8");
  assert.match(registry, /from "\.\/legacy-picks-routes"/);
  assert.match(runtime, /const NBA_HEADERS|export const NBA_HEADERS/);
  assert.match(legacyStore, /const PICKS_FILE/);
  assert.match(legacyRoutes, /registerLegacyPicksCompatibilityRoutes/);
  assert.match(mlbRuntime, /resolveMlbAnalysisDate/);
  assert.doesNotMatch(registry, /const NBA_HEADERS\s*=/);
  assert.doesNotMatch(registry, /const PICKS_FILE\s*=/);
  assert.doesNotMatch(registry, /async function resolveMlbAnalysisDate/);
});


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
