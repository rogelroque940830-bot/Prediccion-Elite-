#!/usr/bin/env python3
"""Slate-aware V80 per-game capture clock.

This module is operational infrastructure only. It never reads MLB outcomes or prices.
It plans capture children from the official MLB schedule and gates the exact per-game
attempt sequence: T-10 primary, T-7 only after no T-10 capture, and T-4 only after
no T-7 capture.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

PLAN_SCHEMA = "courtedge-p0-step12v80-capture-clock-plan.v1"
WAIT_SCHEMA = "courtedge-p0-step12v80-capture-clock-wait.v1"
ATTEMPT_LEADS = (10, 7, 4)
DEFAULT_DISPATCH_MIN_LEAD = 4.0
DEFAULT_DISPATCH_MAX_LEAD = 35.0
DEFAULT_STAGE_LATE_TOLERANCE_MINUTES = 0.75
USER_AGENT = "CourtEdge-V80-Capture-Clock/1.0"


def parse_time(value: str) -> dt.datetime:
    text = str(value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f"timezone required: {value}")
    return parsed.astimezone(dt.timezone.utc)


def now_utc(value: str | None = None) -> dt.datetime:
    return parse_time(value) if value else dt.datetime.now(dt.timezone.utc)


def dump(path: str, value: Any) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def load(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def fetch_schedule(target_date: str) -> Any:
    return fetch_json(
        "https://statsapi.mlb.com/api/v1/schedule"
        f"?sportId=1&gameType=R&date={target_date}"
    )


def schedule_games(schedule: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for day in schedule.get("dates", []) or []:
        for game in day.get("games", []) or []:
            if isinstance(game, dict):
                out.append(game)
    return out


def schedule_pregame(game: dict[str, Any]) -> bool:
    status = game.get("status") or {}
    abstract = str(status.get("abstractGameState") or "").lower()
    detailed = str(status.get("detailedState") or "").lower()
    coded = str(status.get("codedGameState") or "").upper()
    if abstract in {"live", "final"} or coded in {"I", "F", "O"}:
        return False
    terminal_terms = (
        "in progress",
        "final",
        "game over",
        "completed early",
        "postponed",
        "cancelled",
        "canceled",
        "suspended",
    )
    return not any(term in detailed for term in terminal_terms)


def existing_capture_game_pks(path: str | None) -> set[int]:
    if not path or not os.path.exists(path):
        return set()
    payload = load(path)
    return {int(row["gamePk"]) for row in payload.get("rows", []) if row.get("gamePk") is not None}


def terminal_attempt_game_pks(directory: str | None) -> set[int]:
    if not directory or not os.path.isdir(directory):
        return set()
    out: set[int] = set()
    for path in Path(directory).glob("*.json"):
        try:
            payload = load(str(path))
            if payload.get("terminal") is True and payload.get("gamePk") is not None:
                out.add(int(payload["gamePk"]))
        except Exception:
            continue
    return out


def plan_games(
    schedule: Any,
    target_date: str,
    observed_at: dt.datetime,
    captured: set[int],
    terminal_attempts: set[int],
    min_lead: float,
    max_lead: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for game in schedule_games(schedule):
        gp = int(game.get("gamePk") or 0)
        official_date = str(game.get("officialDate") or target_date)
        if gp <= 0 or official_date != target_date or gp in captured or gp in terminal_attempts:
            continue
        if not schedule_pregame(game):
            continue
        start_raw = str(game.get("gameDate") or "")
        try:
            start = parse_time(start_raw)
        except Exception:
            continue
        lead = (start - observed_at).total_seconds() / 60.0
        if not (lead > min_lead and lead <= max_lead):
            continue
        rows.append(
            {
                "gamePk": gp,
                "officialDate": target_date,
                "startTime": start.isoformat().replace("+00:00", "Z"),
                "leadMinutesAtPlanner": lead,
                "homeTeamId": int(((game.get("teams") or {}).get("home") or {}).get("team", {}).get("id") or 0),
                "awayTeamId": int(((game.get("teams") or {}).get("away") or {}).get("team", {}).get("id") or 0),
            }
        )
    rows.sort(key=lambda row: (row["startTime"], row["gamePk"]))
    return rows


def plan(args: argparse.Namespace) -> None:
    observed_at = now_utc(args.now)
    schedule = load(args.schedule_fixture) if args.schedule_fixture else fetch_schedule(args.target_date)
    captured = existing_capture_game_pks(args.existing_captures)
    terminal_attempts = terminal_attempt_game_pks(args.terminal_attempt_dir)
    rows = plan_games(
        schedule,
        args.target_date,
        observed_at,
        captured,
        terminal_attempts,
        float(args.min_lead_minutes),
        float(args.max_lead_minutes),
    )
    payload = {
        "schemaVersion": PLAN_SCHEMA,
        "targetOfficialDate": args.target_date,
        "plannedAt": observed_at.isoformat().replace("+00:00", "Z"),
        "attemptLeadMinutes": list(ATTEMPT_LEADS),
        "dispatchLeadWindowMinutes": {
            "exclusiveMinimum": float(args.min_lead_minutes),
            "inclusiveMaximum": float(args.max_lead_minutes),
        },
        "games": rows,
        "summary": {
            "dispatchCandidates": len(rows),
            "alreadyCapturedGames": len(captured),
            "terminalNoCaptureGames": len(terminal_attempts),
        },
        "policy": {
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))


def locate_game(schedule: Any, target_date: str, game_pk: int) -> dict[str, Any] | None:
    for game in schedule_games(schedule):
        if int(game.get("gamePk") or 0) == game_pk and str(game.get("officialDate") or target_date) == target_date:
            return game
    return None


def wait_stage(args: argparse.Namespace) -> None:
    stage = int(args.lead_minutes)
    if stage not in ATTEMPT_LEADS:
        raise SystemExit(f"V80_CAPTURE_CLOCK_INVALID_STAGE:{stage}")
    started = now_utc(args.now)
    deadline = started + dt.timedelta(minutes=float(args.max_wait_minutes))
    fixed_schedule = load(args.schedule_fixture) if args.schedule_fixture else None
    status = "TIMEOUT"
    result: dict[str, Any] = {}

    while True:
        observed_at = now_utc(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
        schedule = fixed_schedule if fixed_schedule is not None else fetch_schedule(args.target_date)
        game = locate_game(schedule, args.target_date, int(args.game_pk))
        if game is None:
            status = "GAME_NOT_FOUND"
            result = {"observedAt": observed_at.isoformat().replace("+00:00", "Z")}
            break
        start_raw = str(game.get("gameDate") or "")
        start = parse_time(start_raw)
        lead = (start - observed_at).total_seconds() / 60.0
        common = {
            "observedAt": observed_at.isoformat().replace("+00:00", "Z"),
            "startTime": start.isoformat().replace("+00:00", "Z"),
            "leadMinutes": lead,
            "detailedState": str((game.get("status") or {}).get("detailedState") or ""),
        }
        if not schedule_pregame(game) or lead <= 0:
            status = "GAME_NO_LONGER_PREGAME"
            result = common
            break
        tolerance = float(args.late_tolerance_minutes)
        if lead < stage - tolerance:
            status = "MISSED_STAGE"
            result = common
            break
        if lead <= stage:
            status = "READY"
            result = common
            break
        if fixed_schedule is not None or observed_at >= deadline:
            status = "TIMEOUT"
            result = common
            break
        seconds_until_stage = max(1.0, (lead - stage) * 60.0)
        sleep_seconds = min(float(args.poll_seconds), seconds_until_stage)
        time.sleep(sleep_seconds)

    payload = {
        "schemaVersion": WAIT_SCHEMA,
        "targetOfficialDate": args.target_date,
        "gamePk": int(args.game_pk),
        "attemptStage": f"T{stage}",
        "targetLeadMinutes": stage,
        "lateToleranceMinutes": float(args.late_tolerance_minutes),
        "status": status,
        **result,
        "policy": {
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("plan")
    p.add_argument("--target-date", required=True)
    p.add_argument("--existing-captures")
    p.add_argument("--terminal-attempt-dir")
    p.add_argument("--schedule-fixture")
    p.add_argument("--now")
    p.add_argument("--min-lead-minutes", type=float, default=DEFAULT_DISPATCH_MIN_LEAD)
    p.add_argument("--max-lead-minutes", type=float, default=DEFAULT_DISPATCH_MAX_LEAD)
    p.add_argument("--out", required=True)
    p.set_defaults(func=plan)

    w = sub.add_parser("wait-stage")
    w.add_argument("--target-date", required=True)
    w.add_argument("--game-pk", type=int, required=True)
    w.add_argument("--lead-minutes", type=int, required=True)
    w.add_argument("--late-tolerance-minutes", type=float, default=DEFAULT_STAGE_LATE_TOLERANCE_MINUTES)
    w.add_argument("--max-wait-minutes", type=float, default=45.0)
    w.add_argument("--poll-seconds", type=float, default=20.0)
    w.add_argument("--schedule-fixture")
    w.add_argument("--now")
    w.add_argument("--out", required=True)
    w.set_defaults(func=wait_stage)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
