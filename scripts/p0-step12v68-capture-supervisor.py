#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCE_SCHEMA = "courtedge-p0-step12v68-prospective-source-input.v1"
SUPERVISOR_SCHEMA = "courtedge-p0-step12v68-capture-supervisor.v1"
REQUEST_TIMEOUT = 20
MAX_HTTP_ATTEMPTS = 3


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def parse_iso(value):
    s = str(value or "").strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    x = dt.datetime.fromisoformat(s)
    if x.tzinfo is None:
        raise ValueError("timezone required")
    return x.astimezone(dt.timezone.utc)


def fetch_json(url, label):
    last = None
    for index in range(MAX_HTTP_ATTEMPTS):
        try:
            req = Request(url, headers={
                "User-Agent": "CourtEdge-V68-Capture-Supervisor/1.0",
                "Accept": "application/json",
            })
            with urlopen(req, timeout=REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            last = exc
            if index + 1 < MAX_HTTP_ATTEMPTS:
                time.sleep(0.25 * (2 ** index))
    raise RuntimeError(f"{label}:{type(last).__name__}:{last}")


def fetch_schedule(target_date):
    return fetch_json(
        f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&date={target_date}",
        "schedule",
    )


def scheduled_games(schedule):
    games = []
    for day in schedule.get("dates", []):
        for game in day.get("games", []):
            try:
                gp = int(game.get("gamePk") or 0)
                start = parse_iso(game.get("gameDate"))
            except Exception:
                continue
            if gp > 0:
                games.append((gp, start))
    return games


def preflight(target_date, now, horizon_minutes):
    schedule = fetch_schedule(target_date)
    games = scheduled_games(schedule)
    leads = []
    for gp, start in games:
        lead = (start - now).total_seconds() / 60.0
        if lead > 0:
            leads.append((gp, lead))
    nearest = min((lead for _, lead in leads), default=None)
    upcoming = sorted(gp for gp, lead in leads if 0 < lead <= horizon_minutes)
    return {
        "scheduleGames": len(games),
        "futureScheduledGames": len(leads),
        "nearestPositiveLeadMinutes": nearest,
        "upcomingGamePksWithinPreflightHorizon": upcoming,
        "nearCaptureWindow": bool(upcoming),
        "preflightError": None,
    }


def lineup_count(feed, side):
    order = (((feed.get("liveData") or {}).get("boxscore") or {}).get("teams") or {}).get(side, {}).get("battingOrder")
    if not isinstance(order, list):
        return 0
    ids = set()
    for value in order:
        try:
            pid = int(value)
        except Exception:
            continue
        if pid > 0:
            ids.add(pid)
    return len(ids)


def pregame_status(feed):
    status = (feed.get("gameData") or {}).get("status") or {}
    coded = str(status.get("codedGameState") or "").strip().upper()
    abstract = str(status.get("abstractGameState") or "").strip().lower()
    detailed = str(status.get("detailedState") or "").strip().lower()
    if coded in ("I", "F", "O"):
        return False, coded or None
    if detailed in ("in progress", "final", "game over", "completed early"):
        return False, coded or None
    if coded in ("S", "P"):
        return True, coded or None
    if detailed in ("scheduled", "pre-game", "warmup", "delayed start"):
        return True, coded or None
    return abstract == "preview", coded or None


def readiness_diagnostics(target_date, now, max_lead_minutes):
    schedule = fetch_schedule(target_date)
    games = scheduled_games(schedule)
    rows = []
    counts = {
        "gamesInsideStrictWindow": 0,
        "exactReady": 0,
        "missingLineup": 0,
        "missingPitcher": 0,
        "notPregame": 0,
        "feedError": 0,
    }
    for gp, start in games:
        lead = (start - now).total_seconds() / 60.0
        if not (0 < lead <= max_lead_minutes):
            continue
        counts["gamesInsideStrictWindow"] += 1
        try:
            feed = fetch_json(f"https://statsapi.mlb.com/api/v1.1/game/{gp}/feed/live", f"feed:{gp}")
            is_pregame, coded = pregame_status(feed)
            game_data = feed.get("gameData") or {}
            probable = game_data.get("probablePitchers") or {}
            home_pitcher = int(((probable.get("home") or {}).get("id")) or 0)
            away_pitcher = int(((probable.get("away") or {}).get("id")) or 0)
            home_lineup = lineup_count(feed, "home")
            away_lineup = lineup_count(feed, "away")
            exact = bool(is_pregame and home_pitcher > 0 and away_pitcher > 0 and home_lineup == 9 and away_lineup == 9)
            if exact:
                reason = "EXACT_READY"
                counts["exactReady"] += 1
            elif not is_pregame:
                reason = "NOT_PREGAME"
                counts["notPregame"] += 1
            elif home_pitcher <= 0 or away_pitcher <= 0:
                reason = "MISSING_PITCHER"
                counts["missingPitcher"] += 1
            else:
                reason = "MISSING_LINEUP"
                counts["missingLineup"] += 1
            rows.append({
                "gamePk": gp,
                "leadMinutes": lead,
                "codedGameState": coded,
                "homeLineupCount": home_lineup,
                "awayLineupCount": away_lineup,
                "homeProbablePitcherKnown": home_pitcher > 0,
                "awayProbablePitcherKnown": away_pitcher > 0,
                "reason": reason,
            })
        except Exception as exc:
            counts["feedError"] += 1
            rows.append({
                "gamePk": gp,
                "leadMinutes": lead,
                "reason": "FEED_ERROR",
                "error": f"{type(exc).__name__}:{exc}",
            })
    return {"counts": counts, "games": rows}


def run_source(args, out_path):
    command = [
        sys.executable,
        args.source_script,
        "live",
        "--state", args.state,
        "--target-date", args.target_date,
        "--source-manifest", args.source_manifest,
        "--v62-contract", args.v62_contract,
        "--max-lead-minutes", str(args.max_lead_minutes),
        "--out", out_path,
    ]
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(
            "V68_SUPERVISOR_SOURCE_FAILED:"
            + str(completed.returncode)
            + ":"
            + (completed.stderr.strip() or completed.stdout.strip())
        )
    payload = load(out_path)
    if payload.get("schemaVersion") != SOURCE_SCHEMA:
        raise RuntimeError("V68_SUPERVISOR_SOURCE_SCHEMA_INVALID")
    return payload


def merge_first(rows_by_game, payload):
    added = 0
    for row in payload.get("rows", []):
        gp = int(row["gamePk"])
        if gp not in rows_by_game:
            rows_by_game[gp] = row
            added += 1
    return added


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--target-date", required=True)
    ap.add_argument("--source-manifest", required=True)
    ap.add_argument("--v62-contract", required=True)
    ap.add_argument("--source-script", default="scripts/p0-step12v68-prospective-source.py")
    ap.add_argument("--max-lead-minutes", type=int, default=20)
    ap.add_argument("--preflight-horizon-minutes", type=int, default=45)
    ap.add_argument("--attempts", type=int, default=6)
    ap.add_argument("--interval-seconds", type=int, default=45)
    ap.add_argument("--out", required=True)
    ap.add_argument("--diagnostics-out", required=True)
    ap.add_argument("--skip-preflight", action="store_true")
    ap.add_argument("--no-sleep", action="store_true")
    args = ap.parse_args()

    if not (1 <= args.attempts <= 12):
        raise SystemExit("V68_SUPERVISOR_ATTEMPTS_INVALID")
    if not (0 <= args.interval_seconds <= 120):
        raise SystemExit("V68_SUPERVISOR_INTERVAL_INVALID")
    if not (0 < args.max_lead_minutes <= 20):
        raise SystemExit("V68_SUPERVISOR_CAPTURE_WINDOW_WIDENING_FORBIDDEN")
    if not (args.max_lead_minutes <= args.preflight_horizon_minutes <= 90):
        raise SystemExit("V68_SUPERVISOR_PREFLIGHT_HORIZON_INVALID")

    started = dt.datetime.now(dt.timezone.utc)
    pre = {
        "scheduleGames": None,
        "futureScheduledGames": None,
        "nearestPositiveLeadMinutes": None,
        "upcomingGamePksWithinPreflightHorizon": [],
        "nearCaptureWindow": True,
        "preflightError": None,
    }
    if not args.skip_preflight:
        try:
            pre = preflight(args.target_date, started, args.preflight_horizon_minutes)
        except Exception as exc:
            pre["preflightError"] = f"{type(exc).__name__}:{exc}"
            pre["nearCaptureWindow"] = True

    rows_by_game = {}
    attempts = []
    successful_source_attempts = 0
    if pre["nearCaptureWindow"]:
        for index in range(args.attempts):
            poll_started = dt.datetime.now(dt.timezone.utc)
            poll_path = f"{args.out}.poll-{index + 1}.json"
            source_error = None
            source_diag = {}
            newly_seen = 0
            source_rows = 0
            try:
                payload = run_source(args, poll_path)
                successful_source_attempts += 1
                newly_seen = merge_first(rows_by_game, payload)
                source_diag = payload.get("diagnostics") or {}
                source_rows = len(payload.get("rows", []))
            except Exception as exc:
                source_error = f"{type(exc).__name__}:{exc}"
            readiness = None
            readiness_error = None
            try:
                readiness = readiness_diagnostics(args.target_date, poll_started, args.max_lead_minutes)
            except Exception as exc:
                readiness_error = f"{type(exc).__name__}:{exc}"
            attempts.append({
                "attempt": index + 1,
                "pollStartedAtUtc": poll_started.isoformat().replace("+00:00", "Z"),
                "sourceRows": source_rows,
                "firstSeenRowsAdded": newly_seen,
                "scheduleGames": source_diag.get("scheduleGames"),
                "exactReadyGamesInCaptureWindow": source_diag.get("exactReadyGamesInCaptureWindow"),
                "sourceError": source_error,
                "readiness": readiness,
                "readinessError": readiness_error,
            })
            try:
                os.remove(poll_path)
            except FileNotFoundError:
                pass
            if index + 1 < args.attempts and not args.no_sleep:
                time.sleep(args.interval_seconds)

    ended = dt.datetime.now(dt.timezone.utc)
    rows = sorted(rows_by_game.values(), key=lambda r: (str(r.get("officialDate", "")), int(r.get("gamePk", 0))))
    combined = {
        "schemaVersion": SOURCE_SCHEMA,
        "targetOfficialDate": args.target_date,
        "capturedAt": ended.isoformat().replace("+00:00", "Z"),
        "rows": rows,
        "diagnostics": {
            "scheduleGames": pre.get("scheduleGames"),
            "exactReadyGamesInCaptureWindow": len(rows),
            "supervisorDensePolling": True,
            "attemptsCompleted": len(attempts),
            "successfulSourceAttempts": successful_source_attempts,
            "preflight": pre,
        },
        "policy": {
            "containsOutcomes": False,
            "containsMarketPrices": False,
            "researchOnly": True,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, combined)

    diagnostics = {
        "schemaVersion": SUPERVISOR_SCHEMA,
        "targetOfficialDate": args.target_date,
        "startedAtUtc": started.isoformat().replace("+00:00", "Z"),
        "endedAtUtc": ended.isoformat().replace("+00:00", "Z"),
        "captureWindowMaximumMinutesBeforeScheduledStart": args.max_lead_minutes,
        "preflightHorizonMinutes": args.preflight_horizon_minutes,
        "attemptsConfigured": args.attempts,
        "intervalSeconds": args.interval_seconds,
        "preflight": pre,
        "attempts": attempts,
        "successfulSourceAttempts": successful_source_attempts,
        "firstSeenCanonicalCandidates": len(rows),
        "gamePks": [int(r["gamePk"]) for r in rows],
        "outcomesRead": False,
        "marketPricesRead": False,
        "scientificModelChanged": False,
    }
    dump(args.diagnostics_out, diagnostics)
    print(json.dumps({
        "targetOfficialDate": args.target_date,
        "nearCaptureWindow": pre["nearCaptureWindow"],
        "attemptsCompleted": len(attempts),
        "successfulSourceAttempts": successful_source_attempts,
        "firstSeenCanonicalCandidates": len(rows),
        "gamePks": diagnostics["gamePks"],
    }, indent=2))

    if pre["nearCaptureWindow"] and successful_source_attempts == 0:
        raise SystemExit("V68_SUPERVISOR_ALL_SOURCE_ATTEMPTS_FAILED")


if __name__ == "__main__":
    main()
