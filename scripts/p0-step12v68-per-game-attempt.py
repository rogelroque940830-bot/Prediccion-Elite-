#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

ATTEMPTS = (("T10", 10), ("T7", 7), ("T4", 4))


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dump(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def source_row(source, state, manifest, v62c, target_date: str, game_pk: int, stage: str, lead: int):
    now = dt.datetime.now(dt.timezone.utc)
    feed = source.fetch_json(
        f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live",
        f"feed:{game_pk}",
    )
    gd = feed.get("gameData") or {}
    game = {
        "gamePk": int(feed.get("gamePk") or game_pk),
        "officialDate": str((gd.get("datetime") or {}).get("officialDate") or ""),
        "gameDate": str((gd.get("datetime") or {}).get("dateTime") or ""),
    }
    ident = source.target_identity(feed, game, target_date, now, float(lead))
    captured = now.isoformat().replace("+00:00", "Z")
    diagnostics = {
        "targetGamePk": game_pk,
        "attemptStage": stage,
        "maximumLeadMinutes": float(lead),
        "targetGameOnlyRevalidation": True,
        "exactReadyGamesInCaptureWindow": 0,
        "reason": "NOT_EXACT_READY",
    }
    if ident is None:
        return None, diagnostics, captured
    feats, mechanism = source.feature_row(state, ident, manifest, v62c)
    evidence = {
        "stateDigest": state["stateDigest"],
        "gamePk": game_pk,
        "officialDate": target_date,
        "homeTeamId": ident["homeTeamId"],
        "awayTeamId": ident["awayTeamId"],
        "homePitcherId": ident["homePitcherId"],
        "awayPitcherId": ident["awayPitcherId"],
        "homeBattingOrder": ident["homeBattingOrder"],
        "awayBattingOrder": ident["awayBattingOrder"],
        "capturedAt": captured,
    }
    row = {
        "gamePk": game_pk,
        "officialDate": target_date,
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
    diagnostics.update({
        "exactReadyGamesInCaptureWindow": 1,
        "reason": "EXACT_READY",
        "leadMinutes": ident.get("leadMinutes"),
    })
    return row, diagnostics, captured


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-date", required=True)
    ap.add_argument("--game-pk", type=int, required=True)
    ap.add_argument("--scheduled-start", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--source-manifest", required=True)
    ap.add_argument("--v62-contract", required=True)
    ap.add_argument("--clock-script", default="scripts/p0-step12v68-capture-clock.py")
    ap.add_argument("--source-script", default="scripts/p0-step12v68-prospective-source.py")
    ap.add_argument("--work-dir", required=True)
    args = ap.parse_args()

    clock = load_module("v68_clock_runtime", args.clock_script)
    source = load_module("v68_source_runtime", args.source_script)
    state = source.load(args.state)
    manifest = source.load(args.source_manifest)
    v62c = source.load(args.v62_contract)
    if state.get("schemaVersion") != source.STATE_SCHEMA or state.get("targetOfficialDate") != args.target_date:
        raise SystemExit("V68_PER_GAME_STATE_INVALID")

    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    attempts = {
        "schemaVersion": "courtedge-p0-step12v68-per-game-attempts.v1",
        "officialDate": args.target_date,
        "gamePk": args.game_pk,
        "scheduledStartFromPlanner": args.scheduled_start,
        "attemptOrder": [x[0] for x in ATTEMPTS],
        "attempts": [],
        "captureSucceeded": False,
        "captureStage": None,
        "terminal": False,
        "terminalReason": None,
        "retryEligible": False,
        "retryStartTime": None,
        "updatedAt": None,
        "policy": {
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "sameDateCompletedGameOutcomesUsed": False,
            "scientificModelChanged": False,
            "scientificCaptureWindowMaximumMinutes": 20,
            "realFinancialExposure": 0,
        },
    }

    captured_row = None
    context_captured_at = None
    final_reason = "ATTEMPTS_EXHAUSTED"
    retry_eligible = False

    for stage, lead in ATTEMPTS:
        clock_path = work / f"clock-{stage}.json"
        clock_args = SimpleNamespace(
            lead_minutes=lead,
            now=None,
            max_wait_minutes=45.0,
            target_date=args.target_date,
            game_pk=args.game_pk,
            schedule_fixture=None,
            scheduled_start_from_planner=args.scheduled_start,
            late_tolerance_minutes=0.75,
            poll_seconds=20.0,
            out=str(clock_path),
        )
        clock.wait_stage(clock_args)
        c = json.loads(clock_path.read_text(encoding="utf-8"))
        attempt = {
            "stage": stage,
            "targetLeadMinutes": lead,
            "clockStatus": c.get("status"),
            "terminal": c.get("terminal", False),
            "retryEligible": c.get("retryEligible", False),
            "retryStartTime": c.get("retryStartTime"),
            "observedAt": c.get("observedAt"),
            "startTime": c.get("startTime"),
            "leadMinutes": c.get("leadMinutes"),
            "codedGameState": c.get("codedGameState"),
            "abstractGameState": c.get("abstractGameState"),
            "detailedState": c.get("detailedState"),
            "disposition": c.get("disposition"),
            "scheduledStartChanged": c.get("scheduledStartChanged"),
            "contextRows": None,
        }
        attempts["attempts"].append(attempt)
        status = str(c.get("status") or "")

        if status == "MISSED_STAGE":
            continue
        if status in {
            "GAME_CANCELLED", "GAME_SUSPENDED", "GAME_STARTED_OR_FINAL",
            "POSTPONED_TO_ANOTHER_DATE", "OPERATIONAL_CUTOFF_REACHED",
        }:
            final_reason = status
            break
        if status in {
            "GAME_NOT_FOUND", "TIMEOUT", "WAITING_FOR_RESCHEDULE",
            "START_TIME_UNAVAILABLE", "START_TIME_PASSED_WITHOUT_RESCHEDULE",
        }:
            final_reason = status
            retry_eligible = True
            break
        if status != "READY":
            final_reason = status or "UNKNOWN_CLOCK_STATUS"
            retry_eligible = True
            break

        row, diagnostics, captured_at = source_row(
            source, state, manifest, v62c, args.target_date, args.game_pk, stage, lead
        )
        attempt["contextRows"] = 1 if row else 0
        attempt["contextDiagnostics"] = diagnostics
        dump(work / f"context-{stage}.json", {
            "schemaVersion": source.SOURCE_SCHEMA,
            "targetOfficialDate": args.target_date,
            "capturedAt": captured_at,
            "rows": [row] if row else [],
            "diagnostics": diagnostics,
            "policy": {
                "containsOutcomes": False,
                "containsMarketPrices": False,
                "targetGameOnlyRevalidation": True,
                "scientificModelChanged": False,
                "researchOnly": True,
                "realFinancialExposure": 0,
            },
        })
        if row:
            captured_row = row
            context_captured_at = captured_at
            attempts["captureSucceeded"] = True
            attempts["captureStage"] = stage
            final_reason = "CAPTURED"
            break

    attempts["terminal"] = not retry_eligible
    attempts["terminalReason"] = final_reason
    attempts["retryEligible"] = retry_eligible
    attempts["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    attempts["lastObservedAt"] = next(
        (a.get("observedAt") for a in reversed(attempts["attempts"]) if a.get("observedAt")),
        None,
    )
    attempts["retryStartTime"] = next(
        (a.get("retryStartTime") for a in reversed(attempts["attempts"]) if a.get("retryStartTime")),
        None,
    )
    dump(work / "attempts.json", attempts)

    final_context = {
        "schemaVersion": source.SOURCE_SCHEMA,
        "targetOfficialDate": args.target_date,
        "capturedAt": context_captured_at or attempts["updatedAt"],
        "rows": [captured_row] if captured_row else [],
        "diagnostics": {
            "targetGamePk": args.game_pk,
            "exactReadyGamesInCaptureWindow": 1 if captured_row else 0,
            "attemptSequence": [x[0] for x in ATTEMPTS],
            "captureStage": attempts["captureStage"],
            "targetGameOnlyRevalidation": True,
        },
        "policy": {
            "containsOutcomes": False,
            "containsMarketPrices": False,
            "researchOnly": True,
            "realFinancialExposure": 0,
        },
    }
    dump(work / "context.json", final_context)
    print(json.dumps({
        "gamePk": args.game_pk,
        "captureSucceeded": attempts["captureSucceeded"],
        "captureStage": attempts["captureStage"],
        "retryEligible": retry_eligible,
        "terminalReason": final_reason,
        "contextRows": len(final_context["rows"]),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
