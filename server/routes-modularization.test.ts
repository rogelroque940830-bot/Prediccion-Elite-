import assert from "node:assert/strict";
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
  assert.match(source, /from "\.\/legacy-picks-routes"/);
  assert.match(source, /from "\.\/mlb-route-runtime"/);
  assert.doesNotMatch(source, /const NBA_HEADERS\s*=/);
  assert.doesNotMatch(source, /const PICKS_FILE\s*=/);
  assert.doesNotMatch(source, /async function resolveMlbAnalysisDate/);
});
