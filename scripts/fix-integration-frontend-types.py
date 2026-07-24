#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path

# Deterministic reconciliation for the imported Sprint 2 source.
ROOT = Path(__file__).resolve().parents[1]


def replace_or_confirm(path: Path, old: str, new: str, minimum: int = 1) -> int:
    text = path.read_text(encoding="utf-8")
    old_count = text.count(old)
    if old_count >= minimum:
        path.write_text(text.replace(old, new), encoding="utf-8")
        return old_count
    if text.count(new) >= minimum:
        return 0
    raise RuntimeError(
        f"{path}: neither the old nor reconciled form was found: {old!r}"
    )


context = ROOT / "frontend/client/src/lib/context.tsx"
replace_or_confirm(
    context,
    'Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit">',
    'Omit<Pick, "id" | "serverId" | "sport" | "impliedProb" | "edge" | "profit">',
    minimum=2,
)

mlb = ROOT / "frontend/client/src/pages/mlb-predictor.tsx"
replace_or_confirm(mlb, "MLBPredictorResult", "MLBResult", minimum=3)
mlb_text = mlb.read_text(encoding="utf-8")
if "gameDate?: string;" not in mlb_text:
    mlb_text, count = re.subn(
        r"(games:\s*Array<\{[\s\S]*?\n)(\s+venue:\s*string;\n)(\s+\}>;)",
        lambda match: f"{match.group(1)}{match.group(2)}{match.group(2).split('venue:')[0]}gameDate?: string;\n{match.group(3)}",
        mlb_text,
        count=1,
    )
    if count != 1:
        raise RuntimeError(f"{mlb}: unable to insert optional gameDate into MLB game response type")
    mlb.write_text(mlb_text, encoding="utf-8")

predictor = ROOT / "frontend/client/src/pages/predictor.tsx"
replace_or_confirm(
    predictor,
    '  total?: { estimatedTotal: number; edge: number; signal: "BET"|"LEAN"|"PASS"; side: "OVER"|"UNDER" };',
    '  total?: { estimatedTotal: number; edge: number; signal: "BET"|"LEAN"|"PASS"; side: "OVER"|"UNDER"; hitProb?: number; confidence?: string };',
)
replace_or_confirm(
    predictor,
    "  gamesPlayed?: number;\n  // Home/Away splits",
    "  gamesPlayed?: number;\n  // Provider aliases consumed by the current auto-fill path.\n  gamesLast7Days?: number; gp?: number;\n  l10eFGPct?: number; l10FTRate?: number; l10OrebPct?: number;\n  l10OppFTRate?: number; l10OppOrebPct?: number;\n  // Home/Away splits",
)
replace_or_confirm(
    predictor,
    '<NBARefsCard gameId={selectedGameId} onComposite={setRefComposite} />',
    '<NBARefsCard gameId={selectedGameId} onComposite={(value) => setRefComposite(value ?? null)} />',
)

print("PASS: integration frontend type reconciliation is present")
