#!/usr/bin/env python3
"""Outcome-blind ESPN WNBA prior-game source audit.

Only historical games from a fixed window ending at least seven days before a
hypothetical June 15 target date are requested. Those are prior-game outcomes,
which are valid feature inputs. No target-date game, target result, market price,
or injury inference is requested.
"""
from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OUTPUT = Path("wnba-r1a3-espn-prior-game-probe.json")
BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba"
TIMEOUT = 12
SEASONS = [2021, 2022, 2023, 2024, 2025]
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
}


def fetch_json(url: str) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    started = time.time()
    req = Request(url, headers=HEADERS)
    try:
        with urlopen(req, timeout=TIMEOUT) as response:
            payload = response.read()
            status = response.status
    except HTTPError as exc:
        payload = exc.read()
        status = exc.code
    except (URLError, TimeoutError, OSError) as exc:
        return None, {
            "http_status": None,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": round((time.time() - started) * 1000),
        }
    meta = {
        "http_status": status,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "elapsed_ms": round((time.time() - started) * 1000),
    }
    try:
        return json.loads(payload.decode("utf-8")), meta
    except Exception as exc:
        return None, {**meta, "parse_error": type(exc).__name__}


def team_stat_names(summary: dict[str, Any]) -> list[str]:
    names: set[str] = set()
    teams = ((summary.get("boxscore") or {}).get("teams") or [])
    for team in teams:
        for stat in team.get("statistics") or []:
            if not isinstance(stat, dict):
                continue
            for key in ("name", "abbreviation", "label", "displayName"):
                value = stat.get(key)
                if value:
                    names.add(str(value))
    return sorted(names)


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    competition = ((event.get("competitions") or [{}])[0])
    competitors = competition.get("competitors") or []
    sides = []
    for comp in competitors:
        team = comp.get("team") or {}
        sides.append({
            "homeAway": comp.get("homeAway"),
            "team_id": team.get("id"),
            "abbreviation": team.get("abbreviation"),
            "display_name": team.get("displayName"),
        })
    return {
        "event_id": event.get("id"),
        "date": event.get("date"),
        "competitors": sides,
    }


def run_season(season: int) -> dict[str, Any]:
    start = f"{season}0601"
    end = f"{season}0607"
    scoreboard_url = f"{BASE}/scoreboard?dates={start}-{end}&limit=100"
    board, board_meta = fetch_json(scoreboard_url)
    events = board.get("events") if isinstance(board, dict) else None
    if not isinstance(events, list) or not events:
        return {
            "season": season,
            "prior_window": [start, end],
            "scoreboard": board_meta,
            "event_count": 0,
            "selected_event": None,
            "summary": None,
            "team_stat_names": [],
            "success": False,
        }

    selected_raw = sorted(events, key=lambda x: str(x.get("date", "")))[0]
    event_id = str(selected_raw.get("id"))
    summary_url = f"{BASE}/summary?event={event_id}"
    summary, summary_meta = fetch_json(summary_url)
    stat_names = team_stat_names(summary) if isinstance(summary, dict) else []
    box_teams = (((summary or {}).get("boxscore") or {}).get("teams") or []) if isinstance(summary, dict) else []
    return {
        "season": season,
        "prior_window": [start, end],
        "scoreboard": board_meta,
        "event_count": len(events),
        "selected_event": sanitize_event(selected_raw),
        "summary": summary_meta,
        "boxscore_team_count": len(box_teams),
        "team_stat_names": stat_names,
        "success": board_meta.get("http_status") == 200 and summary_meta.get("http_status") == 200 and len(box_teams) == 2 and bool(stat_names),
    }


def main() -> None:
    rows = []
    with ThreadPoolExecutor(max_workers=len(SEASONS)) as pool:
        futures = {pool.submit(run_season, season): season for season in SEASONS}
        for future in as_completed(futures):
            rows.append(future.result())
    rows.sort(key=lambda row: row["season"])
    all_success = all(row.get("success") for row in rows)
    doc = {
        "name": "WNBA_R1A3_ESPN_PRIOR_GAME_SOURCE_PROBE_V1",
        "outcome_blind_target_policy": True,
        "target_outcomes_requested": False,
        "prior_game_outcomes_allowed": True,
        "hypothetical_target_date": "June 15 of each season",
        "prior_source_window": "June 1-7 of each season",
        "seasons": SEASONS,
        "rows": rows,
        "summary": {
            "all_seasons_accessible": all_success,
            "successful_seasons": sum(1 for row in rows if row.get("success")),
        },
        "certification_policy": {
            "all_five_seasons_require_scoreboard_http_200": True,
            "all_five_seasons_require_nonempty_prior_events": True,
            "all_five_seasons_require_summary_http_200": True,
            "all_five_seasons_require_two_team_boxscore": True,
            "all_five_seasons_require_team_stat_schema": True,
            "score_values_not_persisted_in_probe_artifact": True,
            "target_date_not_requested": True,
        },
    }
    OUTPUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(doc, indent=2))


if __name__ == "__main__":
    main()
