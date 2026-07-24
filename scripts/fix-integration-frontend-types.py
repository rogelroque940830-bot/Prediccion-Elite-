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
context_text = context.read_text(encoding="utf-8")
if "type NewHistoryPick =" not in context_text:
    marker = "export type Action =\n"
    if marker not in context_text:
        raise RuntimeError(f"{context}: Action declaration marker not found")
    alias = (
        'type NewHistoryPick = Omit<Pick, "id" | "serverId" | "sport" | "impliedProb" | "edge" | "profit"> '
        '& { sport?: Pick["sport"] };\n\n'
    )
    context_text = context_text.replace(marker, alias + marker, 1)

legacy_payload = 'Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit">'
reconciled_payload = 'Omit<Pick, "id" | "serverId" | "sport" | "impliedProb" | "edge" | "profit">'
context_text = context_text.replace(legacy_payload, "NewHistoryPick")
context_text = context_text.replace(reconciled_payload, "NewHistoryPick")
context.write_text(context_text, encoding="utf-8")

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

if "pickQuality?: PickQualityResult;" not in mlb_text:
    quality_block = (
        "  pickQualities?: {\n"
        "    ml?: PickQualityResult;\n"
        "    f5?: PickQualityResult;\n"
        "    runLine?: PickQualityResult;\n"
        "    ou?: PickQualityResult;\n"
        "  };\n"
    )
    if quality_block not in mlb_text:
        raise RuntimeError(f"{mlb}: pickQualities block not found")
    mlb_text = mlb_text.replace(
        quality_block,
        quality_block + "  // Compatibility field used by the legacy single-market quality helper.\n  pickQuality?: PickQualityResult;\n",
        1,
    )
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
