from pathlib import Path

path = Path("server/routes-modularization.test.ts")
text = path.read_text(encoding="utf-8")
old = '''test("S3A removes shared runtime and legacy persistence from routes.ts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  assert.match(source, /from "\\.\\/route-runtime"/);
  assert.match(source, /from "\\.\\/legacy-picks-store"/);
  assert.match(source, /from "\\.\\/legacy-picks-routes"/);
  assert.match(source, /from "\\.\\/mlb-route-runtime"/);
  assert.doesNotMatch(source, /const NBA_HEADERS\\s*=/);
  assert.doesNotMatch(source, /const PICKS_FILE\\s*=/);
  assert.doesNotMatch(source, /async function resolveMlbAnalysisDate/);
});
'''
new = '''test("S3A keeps shared runtime and legacy persistence in dedicated modules", () => {
  const registry = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf-8");
  const runtime = fs.readFileSync(path.join(process.cwd(), "server", "route-runtime.ts"), "utf-8");
  const legacyStore = fs.readFileSync(path.join(process.cwd(), "server", "legacy-picks-store.ts"), "utf-8");
  const legacyRoutes = fs.readFileSync(path.join(process.cwd(), "server", "legacy-picks-routes.ts"), "utf-8");
  const mlbRuntime = fs.readFileSync(path.join(process.cwd(), "server", "mlb-route-runtime.ts"), "utf-8");
  assert.match(registry, /from "\\.\\/legacy-picks-routes"/);
  assert.match(runtime, /const NBA_HEADERS|export const NBA_HEADERS/);
  assert.match(legacyStore, /const PICKS_FILE/);
  assert.match(legacyRoutes, /registerLegacyPicksCompatibilityRoutes/);
  assert.match(mlbRuntime, /resolveMlbAnalysisDate/);
  assert.doesNotMatch(registry, /const NBA_HEADERS\\s*=/);
  assert.doesNotMatch(registry, /const PICKS_FILE\\s*=/);
  assert.doesNotMatch(registry, /async function resolveMlbAnalysisDate/);
});
'''
if old not in text:
    raise SystemExit("S3A modularization test anchor not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
