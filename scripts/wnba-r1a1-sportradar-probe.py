#!/usr/bin/env python3
"""Outcome-blind empirical probe for Sportradar WNBA Daily Injuries.

Requires SPORTRADAR_API_KEY. This script never fetches target outcomes, box scores,
market prices, or game summaries. It only probes dated Daily Injuries responses,
records metadata/coverage indicators, and hashes raw payloads for source custody.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_DATES = [
    "2021-06-15",
    "2021-08-15",
    "2022-06-15",
    "2022-08-15",
    "2023-06-15",
    "2023-08-15",
    "2024-06-15",
    "2024-08-15",
    "2024-09-15",
    "2025-06-15",
    "2025-08-15",
]


def fetch_day(api_key: str, date: str, access_level: str) -> dict:
    year, month, day = date.split("-")
    url = f"https://api.sportradar.com/wnba/{access_level}/v8/en/league/{year}/{month}/{day}/daily_injuries.json"
    req = Request(url, headers={"x-api-key": api_key, "Accept": "application/json"})
    try:
        with urlopen(req, timeout=30) as resp:
            payload = resp.read()
            status = resp.status
    except HTTPError as exc:
        payload = exc.read()
        status = exc.code
    except URLError as exc:
        return {"date": date, "http_status": None, "error": str(exc.reason), "sha256": None}

    result = {
        "date": date,
        "http_status": status,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "team_count": None,
        "player_count": None,
        "injury_count": None,
        "feed_date": None,
        "parse_error": None,
    }
    try:
        obj = json.loads(payload.decode("utf-8"))
        result["feed_date"] = obj.get("date")
        teams = obj.get("teams") or []
        result["team_count"] = len(teams)
        player_count = 0
        injury_count = 0
        for team in teams:
            players = team.get("players") or []
            player_count += len(players)
            for player in players:
                injuries = player.get("injuries")
                if isinstance(injuries, list):
                    injury_count += len(injuries)
                elif player.get("injury"):
                    injury_count += 1
        result["player_count"] = player_count
        result["injury_count"] = injury_count
    except Exception as exc:
        result["parse_error"] = type(exc).__name__
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", action="append", dest="dates", help="YYYY-MM-DD; may be repeated")
    parser.add_argument("--access-level", default=os.getenv("SPORTRADAR_ACCESS_LEVEL", "trial"), choices=["trial", "production"])
    parser.add_argument("--out", default="wnba-r1a1-sportradar-probe.json")
    args = parser.parse_args()

    api_key = os.getenv("SPORTRADAR_API_KEY")
    if not api_key:
        raise SystemExit("SPORTRADAR_API_KEY is required; no source certification was attempted")

    dates = args.dates or DEFAULT_DATES
    rows = [fetch_day(api_key, date, args.access_level) for date in dates]
    document = {
        "name": "WNBA_R1A1_SPORTRADAR_DAILY_INJURIES_PROBE_V1",
        "outcome_blind": True,
        "access_level": args.access_level,
        "dates": dates,
        "rows": rows,
        "interpretation_policy": {
            "http_200_is_not_coverage_proof": True,
            "empty_response_is_not_healthy_state": True,
            "historical_coverage_requires_genuine_injury_records_and_asof_reconstructibility": True,
            "no_outcome_or_participation_inference": True
        }
    }
    Path(args.out).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(document, indent=2))


if __name__ == "__main__":
    main()
