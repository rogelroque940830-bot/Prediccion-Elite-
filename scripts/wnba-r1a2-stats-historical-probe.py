#!/usr/bin/env python3
"""Outcome-blind historical WNBA Stats source probe.

This probe only requests aggregate/team-log state with DateTo cutoffs that precede
hypothetical target dates. It does not request a target-game box score, result,
market price, or injury inference.
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

OUTPUT = Path("wnba-r1a2-stats-historical-probe.json")

# DateTo values deliberately precede a hypothetical target date by one day.
PROBES = [
    (2021, "06/14/2021"),
    (2022, "06/14/2022"),
    (2023, "06/14/2023"),
    (2024, "06/14/2024"),
    (2025, "06/14/2025"),
]

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "Origin": "https://www.wnba.com",
    "Referer": "https://www.wnba.com/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def build_teamstats_url(host: str, season: int, date_to: str, last_n: int) -> str:
    params = {
        "Conference": "",
        "DateFrom": "",
        "DateTo": date_to,
        "Division": "",
        "GameScope": "",
        "GameSegment": "",
        "Height": "",
        "LastNGames": str(last_n),
        "LeagueID": "10",
        "Location": "",
        "MeasureType": "Advanced",
        "Month": "0",
        "OpponentTeamID": "0",
        "Outcome": "",
        "PORound": "0",
        "PaceAdjust": "N",
        "PerMode": "PerGame",
        "Period": "0",
        "PlayerExperience": "",
        "PlayerPosition": "",
        "PlusMinus": "N",
        "Rank": "N",
        "Season": str(season),
        "SeasonSegment": "",
        "SeasonType": "Regular Season",
        "ShotClockRange": "",
        "StarterBench": "",
        "TeamID": "0",
        "TwoWay": "0",
        "VsConference": "",
        "VsDivision": "",
    }
    return f"https://{host}/stats/leaguedashteamstats?{urlencode(params)}"


def build_gamelog_url(host: str, season: int, date_to: str) -> str:
    params = {
        "Counter": "0",
        "DateFrom": "",
        "DateTo": date_to,
        "Direction": "DESC",
        "LeagueID": "10",
        "PlayerOrTeam": "T",
        "Season": str(season),
        "SeasonType": "Regular Season",
        "Sorter": "DATE",
    }
    return f"https://{host}/stats/leaguegamelog?{urlencode(params)}"


def parse_result_set(obj: Any) -> dict[str, Any]:
    sets = obj.get("resultSets") if isinstance(obj, dict) else None
    if not isinstance(sets, list) or not sets:
        return {"result_set": False, "headers": [], "row_count": 0, "team_count": None}
    first = sets[0] if isinstance(sets[0], dict) else {}
    headers = first.get("headers") if isinstance(first.get("headers"), list) else []
    rows = first.get("rowSet") if isinstance(first.get("rowSet"), list) else []
    team_count = None
    if "TEAM_ID" in headers:
        pos = headers.index("TEAM_ID")
        ids = {str(r[pos]) for r in rows if isinstance(r, list) and len(r) > pos}
        team_count = len(ids)
    return {
        "result_set": True,
        "headers": headers,
        "row_count": len(rows),
        "team_count": team_count,
    }


def request_json(url: str) -> dict[str, Any]:
    request = Request(url, headers=HEADERS)
    started = time.time()
    try:
        with urlopen(request, timeout=18) as response:
            payload = response.read()
            status = response.status
    except HTTPError as exc:
        payload = exc.read()
        status = exc.code
    except (URLError, TimeoutError) as exc:
        return {
            "http_status": None,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": round((time.time() - started) * 1000),
        }

    base = {
        "http_status": status,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "elapsed_ms": round((time.time() - started) * 1000),
    }
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except Exception as exc:
        return {**base, "parse_error": type(exc).__name__}
    return {**base, **parse_result_set(parsed)}


def probe_with_host_fallback(url_builder, *args) -> dict[str, Any]:
    attempts = []
    for host in ("stats.nba.com", "stats.wnba.com"):
        url = url_builder(host, *args)
        result = request_json(url)
        attempts.append({"host": host, **result})
        if result.get("http_status") == 200 and result.get("result_set") and result.get("row_count", 0) > 0:
            return {"success": True, "selected_host": host, "attempts": attempts}
    return {"success": False, "selected_host": None, "attempts": attempts}


def main() -> None:
    rows = []
    for season, date_to in PROBES:
        season_result = probe_with_host_fallback(build_teamstats_url, season, date_to, 0)
        recent_result = probe_with_host_fallback(build_teamstats_url, season, date_to, 10)
        log_result = probe_with_host_fallback(build_gamelog_url, season, date_to)
        rows.append({
            "season": season,
            "date_to": date_to,
            "season_advanced": season_result,
            "last10_advanced": recent_result,
            "team_game_log": log_result,
        })

    doc = {
        "name": "WNBA_R1A2_STATS_HISTORICAL_ASOF_PROBE_V1",
        "generated_utc_date": date.today().isoformat(),
        "outcome_blind": True,
        "target_outcomes_requested": False,
        "seasons": [x[0] for x in PROBES],
        "rows": rows,
        "certification_policy": {
            "all_seasons_require_nonempty_season_advanced": True,
            "all_seasons_require_nonempty_last10_advanced": True,
            "all_seasons_require_nonempty_team_game_log": True,
            "http_200_alone_is_not_sufficient": True,
            "date_to_must_precede_target_tip": True,
            "no_final_season_snapshot_substitution": True,
        },
    }
    OUTPUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(doc, indent=2))


if __name__ == "__main__":
    main()
