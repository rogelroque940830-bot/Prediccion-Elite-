#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path

ROUTES = Path("server/routes.ts")
text = ROUTES.read_text(encoding="utf-8")
original = text

marker = 'import { computeMLBContextual } from "./mlb-contextual";\n'
helper = '''\nfunction requireSecret(name: string): string {\n  const value = (process.env[name] || "").trim();\n  if (!value) {\n    throw new Error(`Missing required environment variable: ${name}`);\n  }\n  return value;\n}\n'''

if "function requireSecret(name: string)" not in text:
    if marker not in text:
        raise SystemExit("Cannot insert requireSecret helper: import marker not found")
    text = text.replace(marker, marker + helper, 1)

replacements: list[tuple[str, str]] = [
    (
        r'const ODDS_API_KEY_BG\s*=\s*process\.env\.ODDS_API_KEY\s*\|\|\s*"[^"]+";',
        'const ODDS_API_KEY_BG = requireSecret("ODDS_API_KEY");',
    ),
    (
        r'const ODDS_API_KEY_BG\s*=\s*"[^"]+";',
        'const ODDS_API_KEY_BG = requireSecret("ODDS_API_KEY");',
    ),
    (
        r'const ODDS_API_KEY\s*=\s*process\.env\.ODDS_API_KEY\s*\|\|\s*"[^"]+";',
        'const ODDS_API_KEY = requireSecret("ODDS_API_KEY");',
    ),
    (
        r'const ODDS_API_KEY\s*=\s*"[^"]+";',
        'const ODDS_API_KEY = requireSecret("ODDS_API_KEY");',
    ),
]

for pattern, replacement in replacements:
    text = re.sub(pattern, replacement, text)

bdl_block = re.compile(
    r'\s*// Defensa contra env var[^\n]*\n'
    r'\s*const _envBdlKey[^\n]*\n'
    r'\s*const _bdlKeyLooksValid[^\n]*\n'
    r'\s*const BDL_KEY[^\n]*;',
    flags=re.MULTILINE,
)
text, bdl_count = bdl_block.subn(
    '\n  // Provider credential is required at runtime; no source-code fallback.\n'
    '  const BDL_KEY = requireSecret("BDL_API_KEY");',
    text,
)

# Also cover older snapshots where BDL_KEY was assigned directly.
text = re.sub(
    r'const BDL_KEY\s*=\s*process\.env\.BDL_API_KEY\s*\|\|\s*"[^"]+";',
    'const BDL_KEY = requireSecret("BDL_API_KEY");',
    text,
)
text = re.sub(
    r'const BDL_KEY\s*=\s*"[^"]+";',
    'const BDL_KEY = requireSecret("BDL_API_KEY");',
    text,
)

for label, pattern in {
    "Odds API literal": r'ODDS_API_KEY(?:_BG)?\s*=.*["\'][0-9a-fA-F]{24,}["\']',
    "BDL literal": r'BDL_KEY\s*=.*["\'][0-9a-fA-F-]{30,}["\']',
}.items():
    if re.search(pattern, text):
        raise SystemExit(f"Secret sanitation failed: {label} remains")

if text == original:
    print("No secret fallback changes required.")
else:
    ROUTES.write_text(text, encoding="utf-8")
    print("Sanitized server/routes.ts: removed provider-key fallbacks.")

if 'requireSecret("ODDS_API_KEY")' not in text:
    raise SystemExit("ODDS_API_KEY runtime requirement was not established")
if 'requireSecret("BDL_API_KEY")' not in text:
    raise SystemExit("BDL_API_KEY runtime requirement was not established")
