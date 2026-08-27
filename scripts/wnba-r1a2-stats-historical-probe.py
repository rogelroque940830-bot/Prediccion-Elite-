#!/usr/bin/env python3
"""Outcome-blind historical WNBA Stats source probe.

This probe only requests aggregate/team-log state with DateTo cutoffs that precede
hypothetical target dates. It does not request a target-game box score, result,
market price, or injury inference.

R1A.2 V2 parallelizes independent probes so host-level timeouts cannot consume the
entire workflow budget before an evidence artifact is written.
"""
from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUTPUT = Path("wnba-r1a2-stats-historical-probe.json")
REQUEST_TIMEOUT_SECONDS = 8
HOSTS = ("stats.nba.com", "stats.wnba.com")

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
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = response.read()
            status = response.status
    except HTTPError as exc:
        payload = exc.read()
        status = exc.code
    except (URLError, TimeoutError, OSError) as exc:
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


def probe_with_host_fallback(url_builder: Callable[..., str], *args: Any) -> dict[str, Any]:
    attempts = []
    for host in HOSTS:
        result = request_json(url_builder(host, *args))
        attempts.append({"host": host, **result})
        if result.get("http_status") == 200 and result.get("result_set") and result.get("row_count", 0) > 0:
            return {"success": True, "selected_host": host, "attempts": attempts}
    return {"success": False, "selected_host": None, "attempts": attempts}


def run_one(kind: str, season: int, date_to: str) -> tuple[tuple[int, str], dict[str, Any]]:
    if kind == "season_advanced":
        result = probe_with_host_fallback(build_teamstats_url, season, date_to, 0)
    elif kind == "last10_advanced":
        result = probe_with_host_fallback(build_teamstats_url, season, date_to, 10)
    elif kind == "team_game_log":
        result = probe_with_host_fallback(build_gamelog_url, season, date_to)
    else:
        raise ValueError(kind)
    return (season, kind), result


def classify_access(rows: list[dict[str, Any]]) -> str:
    logical_results = [
        row[kind]
        for row in rows
        for kind in ("season_advanced", "last10_advanced", "team_game_log")
    ]
    if all(item.get("success") for item in logical_results):
        return "ALL_REQUIRED_PROBES_NONEMPTY"
    attempts = [attempt for item in logical_results for attempt in item.get("attempts", [])]
    if attempts and all(attempt.get("http_status") is None for attempt in attempts):
        return "HOST_ACCESS_TIMEOUT_OR_NETWORK_BLOCK"
    if any(attempt.get("http_status") is not None for attempt in attempts):
        return "HOST_RESPONDED_BUT_REQUIRED_COVERAGE_INCOMPLETE"
    return "INDETERMINATE"


def main() -> None:
    results: dict[tuple[int, str], dict[str, Any]] = {}
    kinds = ("season_advanced", "last10_advanced", "team_game_log")

    with ThreadPoolExecutor(max_workers=len(PROBES) * len(kinds)) as pool:
        futures = [
            pool.submit(run_one, kind, season, date_to)
            for season, date_to in PROBES
            for kind in kinds
        ]
        for future in as_completed(futures):
            key, result = future.result()
            results[key] = result

    rows = []
    for season, date_to in PROBES:
        rows.append({
            "season": season,
            "date_to": date_to,
            "season_advanced": results[(season, "season_advanced")],
            "last10_advanced": results[(season, "last10_advanced")],
            "team_game_log": results[(season, "team_game_log")],
        })

    all_required_nonempty = all(
        row[kind].get("success") is True
        for row in rows
        for kind in kinds
    )
    doc = {
        "name": "WNBA_R1A2_STATS_HISTORICAL_ASOF_PROBE_V2",
        "generated_utc_date": date.today().isoformat(),
        "outcome_blind": True,
        "target_outcomes_requested": False,
        "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
        "parallel_logical_probes": True,
        "seasons": [x[0] for x in PROBES],
        "rows": rows,
        "summary": {
            "all_required_nonempty": all_required_nonempty,
            "access_classification": classify_access(rows),
        },
        "certification_policy": {
            "all_seasons_require_nonempty_season_advanced": True,
            "all_seasons_require_nonempty_last10_advanced": True,
            "all_seasons_require_nonempty_team_game_log": True,
            "http_200_alone_is_not_sufficient": True,
            "network_timeout_is_not_scientific_coverage_failure": True,
            "date_to_must_precede_target_tip": True,
            "no_final_season_snapshot_substitution": True,
        },
    }
    OUTPUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(doc, indent=2))


if __name__ == "__main__":
    main()
