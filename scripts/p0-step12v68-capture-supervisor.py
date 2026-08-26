#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from urllib.request import Request, urlopen

SOURCE_SCHEMA = "courtedge-p0-step12v68-prospective-source-input.v1"
SUPERVISOR_SCHEMA = "courtedge-p0-step12v68-capture-supervisor.v1"


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


def fetch_schedule(target_date):
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&date={target_date}"
    req = Request(url, headers={"User-Agent": "CourtEdge-V68-Capture-Supervisor/1.0", "Accept": "application/json"})
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


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
    }


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
    }
    if not args.skip_preflight:
        pre = preflight(args.target_date, started, args.preflight_horizon_minutes)

    rows_by_game = {}
    attempts = []
    if pre["nearCaptureWindow"]:
        for index in range(args.attempts):
            poll_started = dt.datetime.now(dt.timezone.utc)
            poll_path = f"{args.out}.poll-{index + 1}.json"
            payload = run_source(args, poll_path)
            newly_seen = merge_first(rows_by_game, payload)
            source_diag = payload.get("diagnostics") or {}
            attempts.append({
                "attempt": index + 1,
                "pollStartedAtUtc": poll_started.isoformat().replace("+00:00", "Z"),
                "sourceRows": len(payload.get("rows", [])),
                "firstSeenRowsAdded": newly_seen,
                "scheduleGames": source_diag.get("scheduleGames"),
                "exactReadyGamesInCaptureWindow": source_diag.get("exactReadyGamesInCaptureWindow"),
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
        "firstSeenCanonicalCandidates": len(rows),
        "gamePks": diagnostics["gamePks"],
    }, indent=2))


if __name__ == "__main__":
    main()
