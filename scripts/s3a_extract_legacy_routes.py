from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
ROUTES = SERVER / "routes.ts"

text = ROUTES.read_text(encoding="utf-8")
start_marker = "  // ── PICKS PERSISTENCE"
end_marker = "  // ── GET /api/odds/:sport"

if text.count(start_marker) != 1 or text.count(end_marker) != 1:
    raise SystemExit("Legacy picks compatibility block anchors changed")

start = text.index(start_marker)
end = text.index(end_marker, start)
body = text[start:end].rstrip() + "\n"

module = '''import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { getAllSnapshots, recordSnapshot } from "./sharp-signals";
import { requireSecret } from "./route-runtime";

/**
 * Compatibility routes for the pre-ledger picks dashboard and its historical
 * CLV refresh. This module intentionally preserves the old response contract
 * while keeping file I/O and timers out of the main route registry.
 */
export function registerLegacyPicksCompatibilityRoutes(app: Express): void {
'''
module += body
module += "}\n"

module_path = SERVER / "legacy-picks-routes.ts"
if module_path.exists():
    raise SystemExit("Refusing to overwrite server/legacy-picks-routes.ts")
module_path.write_text(module, encoding="utf-8")

import_anchor = 'import { loadPicks, savePicks, type SavedPick } from "./legacy-picks-store";\n'
new_import = import_anchor + 'import { registerLegacyPicksCompatibilityRoutes } from "./legacy-picks-routes";\n'
if text.count(import_anchor) != 1:
    raise SystemExit("Legacy picks import anchor changed")
text = text.replace(import_anchor, new_import, 1)

# Import insertion changes offsets. Recompute the exact block limits before slicing.
start = text.index(start_marker)
end = text.index(end_marker, start)
text = text[:start] + "  registerLegacyPicksCompatibilityRoutes(app);\n\n" + text[end:]
ROUTES.write_text(text, encoding="utf-8")

config_path = ROOT / "tsconfig.s3-modularization.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
include = config.setdefault("include", [])
if "server/legacy-picks-routes.ts" not in include:
    include.append("server/legacy-picks-routes.ts")
config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

test_path = SERVER / "routes-modularization.test.ts"
test_source = test_path.read_text(encoding="utf-8")
anchor = '  assert.match(source, /from "\\.\\/legacy-picks-store"/);\n'
addition = anchor + '  assert.match(source, /from "\\.\\/legacy-picks-routes"/);\n'
if anchor not in test_source:
    raise SystemExit("S3 test import anchor changed")
test_source = test_source.replace(anchor, addition, 1)
test_path.write_text(test_source, encoding="utf-8")

if "const PICKS_FILE" in text or "fs.writeFileSync(PICKS_FILE" in text:
    raise SystemExit("Legacy picks persistence remained in routes.ts")
if 'registerLegacyPicksCompatibilityRoutes(app);' not in text:
    raise SystemExit("Legacy picks registrar was not installed")

print(json.dumps({
    "module": "server/legacy-picks-routes.ts",
    "movedLines": len(body.splitlines()),
    "routesLinesAfter": len(text.splitlines()),
}, indent=2))
