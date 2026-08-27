#!/usr/bin/env python3
"""Materialize one exact V68 pregame source row for a target gamePk.

This is a narrow operational adapter around the frozen V68 source implementation.
It does not change any V68 feature, coefficient, preprocessing, calibration or
eligibility rule. It avoids a full-slate refetch during T-10/T-7/T-4 attempts by
revalidating only the target gamePk, matching the V80 capture architecture.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path


def load_module(path: str):
    spec = importlib.util.spec_from_file_location("v68_source_authority", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("V68_GAME_CONTEXT_SOURCE_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--target-date", required=True)
    ap.add_argument("--game-pk", type=int, required=True)
    ap.add_argument("--attempt-stage", required=True)
    ap.add_argument("--max-lead-minutes", type=float, required=True)
    ap.add_argument("--source-script", default="scripts/p0-step12v68-prospective-source.py")
    ap.add_argument("--source-manifest", required=True)
    ap.add_argument("--v62-contract", required=True)
    ap.add_argument("--now")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.attempt_stage not in {"T10", "T7", "T4"}:
        raise SystemExit(f"V68_GAME_CONTEXT_INVALID_STAGE:{args.attempt_stage}")
    if not (0 < float(args.max_lead_minutes) <= 20):
        raise SystemExit("V68_GAME_CONTEXT_CAPTURE_WINDOW_INVALID")

    source = load_module(args.source_script)
    state = source.load(args.state)
    manifest = source.load(args.source_manifest)
    v62c = source.load(args.v62_contract)

    if (
        state.get("schemaVersion") != source.STATE_SCHEMA
        or state.get("targetOfficialDate") != args.target_date
    ):
        raise SystemExit("V68_GAME_CONTEXT_STATE_DATE_OR_SCHEMA_INVALID")

    now = source.parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    feed = source.fetch_json(
        f"https://statsapi.mlb.com/api/v1.1/game/{int(args.game_pk)}/feed/live",
        f"feed:{int(args.game_pk)}",
    )
    gd = feed.get("gameData") or {}
    game = {
        "gamePk": int(feed.get("gamePk") or args.game_pk),
        "officialDate": str((gd.get("datetime") or {}).get("officialDate") or ""),
        "gameDate": str((gd.get("datetime") or {}).get("dateTime") or ""),
    }

    ident = source.target_identity(
        feed,
        game,
        args.target_date,
        now,
        float(args.max_lead_minutes),
    )

    captured = now.isoformat().replace("+00:00", "Z")
    rows = []
    diagnostics = {
        "targetGamePk": int(args.game_pk),
        "attemptStage": args.attempt_stage,
        "maximumLeadMinutes": float(args.max_lead_minutes),
        "targetGameOnlyRevalidation": True,
        "exactReadyGamesInCaptureWindow": 0,
        "reason": None,
    }

    if ident is None:
        diagnostics["reason"] = "NOT_EXACT_READY"
    else:
        feats, mechanism = source.feature_row(state, ident, manifest, v62c)
        evidence = {
            "stateDigest": state["stateDigest"],
            "gamePk": int(args.game_pk),
            "officialDate": args.target_date,
            "homeTeamId": ident["homeTeamId"],
            "awayTeamId": ident["awayTeamId"],
            "homePitcherId": ident["homePitcherId"],
            "awayPitcherId": ident["awayPitcherId"],
            "homeBattingOrder": ident["homeBattingOrder"],
            "awayBattingOrder": ident["awayBattingOrder"],
            "capturedAt": captured,
        }
        rows.append(
            {
                "gamePk": int(args.game_pk),
                "officialDate": args.target_date,
                "homeTeamId": ident["homeTeamId"],
                "awayTeamId": ident["awayTeamId"],
                "startTime": ident["startTime"],
                "capturedAt": captured,
                "sourceCutoffAt": captured,
                "exactPregameLineupSemantics": True,
                "exactPregameProbableStarterSemantics": True,
                "wholeOfficialDatePriorStateOnly": True,
                "featureSource": "V68_FROZEN_PROSPECTIVE_ADAPTER_V1",
                "sourceEvidenceDigest": source.canonical_digest(evidence),
                "features": feats,
                "mechanismDiagnostics": mechanism,
            }
        )
        diagnostics["exactReadyGamesInCaptureWindow"] = 1
        diagnostics["reason"] = "EXACT_READY"
        diagnostics["leadMinutes"] = ident.get("leadMinutes")

    payload = {
        "schemaVersion": source.SOURCE_SCHEMA,
        "targetOfficialDate": args.target_date,
        "capturedAt": captured,
        "rows": rows,
        "diagnostics": diagnostics,
        "policy": {
            "containsOutcomes": False,
            "containsMarketPrices": False,
            "targetGameOnlyRevalidation": True,
            "scientificModelChanged": False,
            "researchOnly": True,
            "realFinancialExposure": 0,
        },
    }

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")

    print(
        json.dumps(
            {
                "gamePk": int(args.game_pk),
                "stage": args.attempt_stage,
                "rows": len(rows),
                "reason": diagnostics["reason"],
                "leadMinutes": diagnostics.get("leadMinutes"),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
