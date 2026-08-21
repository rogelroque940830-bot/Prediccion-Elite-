#!/usr/bin/env python3
"""Slate-aware V80 per-game capture clock.

Operational infrastructure only. This module never reads MLB outcomes or prices.
A single sanitized daily MLB slate snapshot is created at/after 10:30 ET. Later
dispatcher runs use that frozen snapshot, while each gamePk independently
revalidates only its own current MLB status/start before T-10/T-7/T-4.
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
from zoneinfo import ZoneInfo

PLAN_SCHEMA = "courtedge-p0-step12v80-capture-clock-plan.v2"
SLATE_SCHEMA = "courtedge-p0-step12v80-daily-slate.v1"
WAIT_SCHEMA = "courtedge-p0-step12v80-capture-clock-wait.v2"
ATTEMPT_LEADS = (10, 7, 4)
DEFAULT_DISPATCH_MIN_LEAD = 4.0
DEFAULT_DISPATCH_MAX_LEAD = 35.0
DEFAULT_STAGE_LATE_TOLERANCE_MINUTES = 0.75
USER_AGENT = "CourtEdge-V80-Capture-Clock/2.0"
ET = ZoneInfo("America/New_York")
OPERATING_START = dt.time(10, 30)
CAPTURE_CUTOFF = dt.time(23, 0)

TERMINAL_DISPOSITIONS = {
    "CANCELLED",
    "SUSPENDED",
    "STARTED_OR_FINAL",
    "POSTPONED_TO_ANOTHER_DATE",
}
NONTERMINAL_HOLD_DISPOSITIONS = {
    "DELAYED",
    "POSTPONED_SAME_DATE_UNRESOLVED",
}


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


def iso_z(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


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


def fetch_live_game(game_pk: int) -> dict[str, Any]:
    feed = fetch_json(f"https://statsapi.mlb.com/api/v1.1/game/{int(game_pk)}/feed/live")
    gd = feed.get("gameData") or {}
    return {
        "gamePk": int(feed.get("gamePk") or game_pk),
        "officialDate": str((gd.get("datetime") or {}).get("officialDate") or ""),
        "gameDate": str((gd.get("datetime") or {}).get("dateTime") or ""),
        "status": gd.get("status") or {},
        "teams": {
            "home": {"team": {"id": int(((gd.get("teams") or {}).get("home") or {}).get("id") or 0)}},
            "away": {"team": {"id": int(((gd.get("teams") or {}).get("away") or {}).get("id") or 0)}},
        },
    }


def schedule_games(schedule: Any) -> list[dict[str, Any]]:
    if isinstance(schedule, dict) and schedule.get("schemaVersion") == SLATE_SCHEMA:
        return [g for g in (schedule.get("games") or []) if isinstance(g, dict)]
    out: list[dict[str, Any]] = []
    for day in (schedule or {}).get("dates", []) or []:
        for game in day.get("games", []) or []:
            if isinstance(game, dict):
                out.append(game)
    return out


def normalized_game(game: dict[str, Any], target_date: str) -> dict[str, Any]:
    status = game.get("status") or {}
    return {
        "gamePk": int(game.get("gamePk") or 0),
        "officialDate": str(game.get("officialDate") or target_date),
        "gameDate": str(game.get("gameDate") or ""),
        "status": {
            "abstractGameState": str(status.get("abstractGameState") or ""),
            "detailedState": str(status.get("detailedState") or ""),
            "codedGameState": str(status.get("codedGameState") or ""),
        },
        "teams": {
            "home": {"team": {"id": int(((game.get("teams") or {}).get("home") or {}).get("team", {}).get("id") or 0)}},
            "away": {"team": {"id": int(((game.get("teams") or {}).get("away") or {}).get("team", {}).get("id") or 0)}},
        },
    }


def game_disposition(game: dict[str, Any], target_date: str, observed_at: dt.datetime) -> str:
    status = game.get("status") or {}
    abstract = str(status.get("abstractGameState") or "").strip().lower()
    detailed = str(status.get("detailedState") or "").strip().lower()
    coded = str(status.get("codedGameState") or "").strip().upper()

    if "cancelled" in detailed or "canceled" in detailed:
        return "CANCELLED"
    if "suspended" in detailed:
        return "SUSPENDED"
    if abstract in {"live", "final"} or coded in {"I", "F", "O"}:
        return "STARTED_OR_FINAL"
    if any(term in detailed for term in ("in progress", "final", "game over", "completed early")):
        return "STARTED_OR_FINAL"

    start = None
    try:
        start = parse_time(str(game.get("gameDate") or ""))
    except Exception:
        pass
    official_date = str(game.get("officialDate") or target_date)

    if "postponed" in detailed:
        if official_date and official_date != target_date:
            return "POSTPONED_TO_ANOTHER_DATE"
        if start is not None and start.astimezone(ET).date().isoformat() != target_date:
            return "POSTPONED_TO_ANOTHER_DATE"
        return "POSTPONED_SAME_DATE_UNRESOLVED"

    if "delay" in detailed:
        return "DELAYED"

    return "PREGAME"


def schedule_pregame(game: dict[str, Any], target_date: str | None = None, observed_at: dt.datetime | None = None) -> bool:
    td = target_date or str(game.get("officialDate") or "")
    obs = observed_at or dt.datetime.now(dt.timezone.utc)
    return game_disposition(game, td, obs) == "PREGAME"


def operational_window(target_date: str, observed_at: dt.datetime) -> str:
    local = observed_at.astimezone(ET)
    if local.date().isoformat() < target_date:
        return "BEFORE_DATE"
    if local.date().isoformat() > target_date:
        return "AFTER_CUTOFF"
    if local.time().replace(tzinfo=None) < OPERATING_START:
        return "BEFORE_WINDOW"
    if local.time().replace(tzinfo=None) >= CAPTURE_CUTOFF:
        return "AFTER_CUTOFF"
    return "ACTIVE"


def existing_capture_game_pks(path: str | None) -> set[int]:
    if not path or not os.path.exists(path):
        return set()
    payload = load(path)
    return {int(row["gamePk"]) for row in payload.get("rows", []) if row.get("gamePk") is not None}


def attempt_state(directory: str | None) -> tuple[set[int], dict[int, dict[str, Any]]]:
    terminal: set[int] = set()
    retries: dict[int, dict[str, Any]] = {}
    if not directory or not os.path.isdir(directory):
        return terminal, retries
    for path in Path(directory).glob("*.json"):
        try:
            payload = load(str(path))
            gp = int(payload["gamePk"])
        except Exception:
            continue
        if payload.get("terminal") is True:
            terminal.add(gp)
            retries.pop(gp, None)
            continue
        if payload.get("retryEligible") is not True:
            continue
        stamp = str(payload.get("updatedAt") or payload.get("lastObservedAt") or "")
        current = retries.get(gp)
        if current is None or stamp >= str(current.get("updatedAt") or current.get("lastObservedAt") or ""):
            retries[gp] = payload
    return terminal, retries


def terminal_attempt_game_pks(directory: str | None) -> set[int]:
    return attempt_state(directory)[0]


def snapshot_payload(schedule: Any, target_date: str, observed_at: dt.datetime) -> dict[str, Any]:
    games = []
    for game in schedule_games(schedule):
        row = normalized_game(game, target_date)
        if row["gamePk"] <= 0 or row["officialDate"] != target_date:
            continue
        games.append(row)
    games.sort(key=lambda x: (x.get("gameDate") or "", int(x["gamePk"])))
    return {
        "schemaVersion": SLATE_SCHEMA,
        "targetOfficialDate": target_date,
        "snapshottedAt": iso_z(observed_at),
        "games": games,
        "summary": {"games": len(games)},
        "policy": {
            "sanitizedScheduleOnly": True,
            "scoresStored": False,
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "realFinancialExposure": 0,
        },
    }


def snapshot(args: argparse.Namespace) -> None:
    observed_at = now_utc(args.now)
    if operational_window(args.target_date, observed_at) == "BEFORE_WINDOW":
        raise SystemExit("V80_CAPTURE_CLOCK_DAILY_SLATE_BEFORE_1030_ET")
    schedule = load(args.schedule_fixture) if args.schedule_fixture else fetch_schedule(args.target_date)
    payload = snapshot_payload(schedule, args.target_date, observed_at)
    dump(args.out, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))


def plan_games(
    schedule: Any,
    target_date: str,
    observed_at: dt.datetime,
    captured: set[int],
    terminal_attempts: set[int],
    retry_states: dict[int, dict[str, Any]],
    min_lead: float,
    max_lead: float,
) -> list[dict[str, Any]]:
    if operational_window(target_date, observed_at) != "ACTIVE":
        return []
    rows: list[dict[str, Any]] = []
    for raw in schedule_games(schedule):
        game = normalized_game(raw, target_date)
        gp = int(game.get("gamePk") or 0)
        official_date = str(game.get("officialDate") or target_date)
        if gp <= 0 or official_date != target_date or gp in captured or gp in terminal_attempts:
            continue

        retry = retry_states.get(gp) or {}
        unresolved = bool(retry.get("retryEligible")) and not retry.get("retryStartTime")
        start_raw = str(retry.get("retryStartTime") or game.get("gameDate") or "")
        try:
            start = parse_time(start_raw)
        except Exception:
            if unresolved:
                rows.append({
                    "gamePk": gp,
                    "officialDate": target_date,
                    "startTime": "",
                    "leadMinutesAtPlanner": None,
                    "dispatchReason": "RECHECK_UNRESOLVED_DELAY",
                    "homeTeamId": int(((game.get("teams") or {}).get("home") or {}).get("team", {}).get("id") or 0),
                    "awayTeamId": int(((game.get("teams") or {}).get("away") or {}).get("team", {}).get("id") or 0),
                })
            continue

        lead = (start - observed_at).total_seconds() / 60.0
        if unresolved:
            eligible = True
            reason = "RECHECK_UNRESOLVED_DELAY"
        else:
            eligible = lead > min_lead and lead <= max_lead
            reason = "APPROACHING_CAPTURE_CLOCK"
        if not eligible:
            continue
        rows.append({
            "gamePk": gp,
            "officialDate": target_date,
            "startTime": iso_z(start),
            "leadMinutesAtPlanner": lead,
            "dispatchReason": reason,
            "homeTeamId": int(((game.get("teams") or {}).get("home") or {}).get("team", {}).get("id") or 0),
            "awayTeamId": int(((game.get("teams") or {}).get("away") or {}).get("team", {}).get("id") or 0),
        })
    rows.sort(key=lambda row: (row["startTime"] or "9999", row["gamePk"]))
    return rows


def plan(args: argparse.Namespace) -> None:
    observed_at = now_utc(args.now)
    slate = load(args.slate_snapshot)
    if slate.get("schemaVersion") != SLATE_SCHEMA or slate.get("targetOfficialDate") != args.target_date:
        raise SystemExit("V80_CAPTURE_CLOCK_SLATE_SNAPSHOT_INVALID")
    captured = existing_capture_game_pks(args.existing_captures)
    terminal_attempts, retry_states = attempt_state(args.attempt_state_dir)
    rows = plan_games(
        slate,
        args.target_date,
        observed_at,
        captured,
        terminal_attempts,
        retry_states,
        float(args.min_lead_minutes),
        float(args.max_lead_minutes),
    )
    payload = {
        "schemaVersion": PLAN_SCHEMA,
        "targetOfficialDate": args.target_date,
        "plannedAt": iso_z(observed_at),
        "dailySlateSnapshottedAt": slate.get("snapshottedAt"),
        "attemptLeadMinutes": list(ATTEMPT_LEADS),
        "operationalWindowET": {"start": "10:30", "captureCutoff": "23:00"},
        "dispatchLeadWindowMinutes": {
            "exclusiveMinimum": float(args.min_lead_minutes),
            "inclusiveMaximum": float(args.max_lead_minutes),
        },
        "games": rows,
        "summary": {
            "dispatchCandidates": len(rows),
            "alreadyCapturedGames": len(captured),
            "terminalNoCaptureGames": len(terminal_attempts),
            "retryStateGames": len(retry_states),
        },
        "policy": {
            "fullSlateRefetched": False,
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
        if int(game.get("gamePk") or 0) == game_pk:
            return normalized_game(game, target_date)
    return None


def current_game(args: argparse.Namespace) -> dict[str, Any] | None:
    if args.schedule_fixture:
        schedule = load(args.schedule_fixture)
        return locate_game(schedule, args.target_date, int(args.game_pk))
    try:
        return fetch_live_game(int(args.game_pk))
    except Exception:
        return None


def wait_stage(args: argparse.Namespace) -> None:
    stage = int(args.lead_minutes)
    if stage not in ATTEMPT_LEADS:
        raise SystemExit(f"V80_CAPTURE_CLOCK_INVALID_STAGE:{stage}")
    started = now_utc(args.now)
    deadline = started + dt.timedelta(minutes=float(args.max_wait_minutes))
    status = "TIMEOUT"
    terminal = False
    retry_eligible = False
    result: dict[str, Any] = {}

    while True:
        observed_at = now_utc(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
        if operational_window(args.target_date, observed_at) == "AFTER_CUTOFF":
            status = "OPERATIONAL_CUTOFF_REACHED"
            terminal = True
            result = {"observedAt": iso_z(observed_at)}
            break

        game = current_game(args)
        if game is None:
            status = "GAME_NOT_FOUND"
            retry_eligible = True
            result = {"observedAt": iso_z(observed_at)}
            break

        disposition = game_disposition(game, args.target_date, observed_at)
        start = None
        try:
            start = parse_time(str(game.get("gameDate") or ""))
        except Exception:
            pass
        lead = (start - observed_at).total_seconds() / 60.0 if start else None
        common = {
            "observedAt": iso_z(observed_at),
            "startTime": iso_z(start) if start else None,
            "leadMinutes": lead,
            "detailedState": str((game.get("status") or {}).get("detailedState") or ""),
            "disposition": disposition,
            "scheduledStartFromPlanner": args.scheduled_start_from_planner,
            "scheduledStartChanged": bool(
                start is not None
                and args.scheduled_start_from_planner
                and abs((start - parse_time(args.scheduled_start_from_planner)).total_seconds()) >= 30
            ),
        }

        if disposition in TERMINAL_DISPOSITIONS:
            status = {
                "CANCELLED": "GAME_CANCELLED",
                "SUSPENDED": "GAME_SUSPENDED",
                "STARTED_OR_FINAL": "GAME_STARTED_OR_FINAL",
                "POSTPONED_TO_ANOTHER_DATE": "POSTPONED_TO_ANOTHER_DATE",
            }[disposition]
            terminal = True
            result = common
            break

        if disposition in NONTERMINAL_HOLD_DISPOSITIONS:
            if observed_at >= deadline:
                status = "WAITING_FOR_RESCHEDULE"
                retry_eligible = True
                result = common
                break
            if args.schedule_fixture:
                status = "WAITING_FOR_RESCHEDULE"
                retry_eligible = True
                result = common
                break
            time.sleep(float(args.poll_seconds))
            continue

        if start is None:
            status = "START_TIME_UNAVAILABLE"
            retry_eligible = True
            result = common
            break

        if lead is not None and lead <= 0:
            if observed_at >= deadline:
                status = "START_TIME_PASSED_WITHOUT_RESCHEDULE"
                retry_eligible = True
                result = common
                break
            if args.schedule_fixture:
                status = "START_TIME_PASSED_WITHOUT_RESCHEDULE"
                retry_eligible = True
                result = common
                break
            time.sleep(float(args.poll_seconds))
            continue

        tolerance = float(args.late_tolerance_minutes)
        if lead is not None and lead < stage - tolerance:
            status = "MISSED_STAGE"
            result = common
            break
        if lead is not None and lead <= stage:
            status = "READY"
            result = common
            break

        if observed_at >= deadline:
            status = "TIMEOUT"
            retry_eligible = True
            result = common
            break
        if args.schedule_fixture:
            status = "TIMEOUT"
            retry_eligible = True
            result = common
            break
        seconds_until_stage = max(1.0, ((lead or stage) - stage) * 60.0)
        time.sleep(min(float(args.poll_seconds), seconds_until_stage))

    retry_start = None
    if retry_eligible and result.get("startTime"):
        try:
            candidate = parse_time(str(result["startTime"]))
            if candidate > now_utc(args.now):
                retry_start = iso_z(candidate)
        except Exception:
            pass

    payload = {
        "schemaVersion": WAIT_SCHEMA,
        "targetOfficialDate": args.target_date,
        "gamePk": int(args.game_pk),
        "attemptStage": f"T{stage}",
        "targetLeadMinutes": stage,
        "lateToleranceMinutes": float(args.late_tolerance_minutes),
        "status": status,
        "terminal": terminal,
        "retryEligible": retry_eligible,
        "retryStartTime": retry_start,
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

    s = sub.add_parser("snapshot")
    s.add_argument("--target-date", required=True)
    s.add_argument("--schedule-fixture")
    s.add_argument("--now")
    s.add_argument("--out", required=True)
    s.set_defaults(func=snapshot)

    p = sub.add_parser("plan")
    p.add_argument("--target-date", required=True)
    p.add_argument("--slate-snapshot", required=True)
    p.add_argument("--existing-captures")
    p.add_argument("--attempt-state-dir")
    p.add_argument("--now")
    p.add_argument("--min-lead-minutes", type=float, default=DEFAULT_DISPATCH_MIN_LEAD)
    p.add_argument("--max-lead-minutes", type=float, default=DEFAULT_DISPATCH_MAX_LEAD)
    p.add_argument("--out", required=True)
    p.set_defaults(func=plan)

    w = sub.add_parser("wait-stage")
    w.add_argument("--target-date", required=True)
    w.add_argument("--game-pk", type=int, required=True)
    w.add_argument("--lead-minutes", type=int, required=True)
    w.add_argument("--scheduled-start-from-planner")
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
