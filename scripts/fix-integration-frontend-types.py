#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

# One-shot deterministic reconciliation for the imported Sprint 2 source.
ROOT = Path(__file__).resolve().parents[1]


def replace_required(path: Path, old: str, new: str, minimum: int = 1) -> int:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"{path}: expected at least {minimum} occurrence(s), found {count}: {old!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")
    return count


context = ROOT / "frontend/client/src/lib/context.tsx"
replace_required(
    context,
    'Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit">',
    'Omit<Pick, "id" | "serverId" | "sport" | "impliedProb" | "edge" | "profit">',
    minimum=2,
)

mlb = ROOT / "frontend/client/src/pages/mlb-predictor.tsx"
replace_required(mlb, "MLBPredictorResult", "MLBResult", minimum=3)
replace_required(
    mlb,
    "       homeStats: any; awayStats: any;\n       homePitcher: any; awayPitcher: any;\n       venue: string;\n     }>;",
    "       homeStats: any; awayStats: any;\n       homePitcher: any; awayPitcher: any;\n       venue: string;\n       gameDate?: string;\n     }>;",
)

predictor = ROOT / "frontend/client/src/pages/predictor.tsx"
replace_required(
    predictor,
    '  total?: { estimatedTotal: number; edge: number; signal: "BET"|"LEAN"|"PASS"; side: "OVER"|"UNDER" };',
    '  total?: { estimatedTotal: number; edge: number; signal: "BET"|"LEAN"|"PASS"; side: "OVER"|"UNDER"; hitProb?: number; confidence?: string };',
)
replace_required(
    predictor,
    "  gamesPlayed?: number;\n  // Home/Away splits",
    "  gamesPlayed?: number;\n  // Provider aliases consumed by the current auto-fill path.\n  gamesLast7Days?: number; gp?: number;\n  l10eFGPct?: number; l10FTRate?: number; l10OrebPct?: number;\n  l10OppFTRate?: number; l10OppOrebPct?: number;\n  // Home/Away splits",
)
replace_required(
    predictor,
    '<NBARefsCard gameId={selectedGameId} onComposite={setRefComposite} />',
    '<NBARefsCard gameId={selectedGameId} onComposite={(value) => setRefComposite(value ?? null)} />',
)

print("PASS: integration frontend type reconciliation applied")
