#!/usr/bin/env python3
"""WNBA R1A.4B outcome-blind advanced as-of source/semantics probe.

Target-cohort requests are restricted to June 1-7 prior-game windows for
hypothetical June 15 targets.  The 2026 season is used only as a source-semantics
validation surface.  No 2021-2025 target-date game is requested and no model
coefficient/threshold is changed here.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUTPUT = Path("wnba-r1a4b-bdl-advanced-asof-evidence.json")
BASE = "https://api.balldontlie.io/wnba/v1"
TARGET_WINDOWS = {
    2021: ("2021-06-01", "2021-06-07"),
    2022: ("2022-06-01", "2022-06-07"),
    2023: ("2023-06-01", "2023-06-07"),
    2024: ("2024-06-01", "2024-06-07"),
    2025: ("2025-06-01", "2025-06-07"),
}
TOL = 0.1
MIN_MATCHED_TEAMS = 10


def num(value: Any) -> float | None:
    try:
        x = float(value)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def first_num(obj: dict[str, Any], names: tuple[str, ...]) -> float | None:
    for name in names:
        value = num(obj.get(name))
        if value is not None:
            return value
    return None


def round1(x: float) -> float:
    return round(x + 1e-12, 1)


def team_id(row: dict[str, Any]) -> int | None:
    value = row.get("team", {}).get("id") if isinstance(row.get("team"), dict) else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def game_id(row: dict[str, Any]) -> int | None:
    game = row.get("game")
    value = game.get("id") if isinstance(game, dict) else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def advanced_obj(row: dict[str, Any]) -> dict[str, Any]:
    stats = row.get("stats")
    if isinstance(stats, dict):
        adv = stats.get("advanced")
        if isinstance(adv, dict):
            return adv
        return stats
    return {}


def request_page(path: str, params: dict[str, Any], api_key: str, timeout: int = 30) -> dict[str, Any]:
    query = urlencode(params, doseq=True)
    url = f"{BASE}{path}?{query}" if query else f"{BASE}{path}"
    req = Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": api_key,
            "User-Agent": "Prediccion-Elite-WNBA-R1A4B/1.0",
        },
    )
    with urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("non-object JSON payload")
    return payload


def paged(path: str, params: dict[str, Any], api_key: str, max_pages: int = 30) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor: Any = None
    for _ in range(max_pages):
        p = dict(params)
        p["per_page"] = 100
        if cursor is not None:
            p["cursor"] = cursor
        payload = request_page(path, p, api_key)
        data = payload.get("data")
        if not isinstance(data, list):
            raise RuntimeError(f"{path}: missing data array")
        rows.extend(x for x in data if isinstance(x, dict))
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        cursor = meta.get("next_cursor")
        if cursor in (None, ""):
            break
    return rows


def safe_call(path: str, params: dict[str, Any], api_key: str) -> tuple[list[dict[str, Any]] | None, dict[str, Any]]:
    started = time.time()
    try:
        rows = paged(path, params, api_key)
        return rows, {
            "ok": True,
            "row_count": len(rows),
            "elapsed_ms": round((time.time() - started) * 1000),
        }
    except HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        return None, {
            "ok": False,
            "http_status": exc.code,
            "error": f"HTTPError:{exc.code}",
            "body_prefix": body,
            "elapsed_ms": round((time.time() - started) * 1000),
        }
    except (URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
        return None, {
            "ok": False,
            "error": f"{type(exc).__name__}:{str(exc)[:220]}",
            "elapsed_ms": round((time.time() - started) * 1000),
        }


def digest_rows(rows: list[dict[str, Any]]) -> str:
    sanitized = []
    for row in rows:
        adv = advanced_obj(row)
        sanitized.append({
            "game_id": game_id(row),
            "team_id": team_id(row),
            "date": (row.get("game") or {}).get("date") if isinstance(row.get("game"), dict) else None,
            "period": row.get("period"),
            "advanced": {k: adv.get(k) for k in sorted(adv)},
        })
    sanitized.sort(key=lambda x: (str(x.get("game_id")), str(x.get("team_id"))))
    raw = json.dumps(sanitized, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(raw).hexdigest()


def historical_access(api_key: str) -> tuple[dict[str, Any], bool, bool]:
    evidence: dict[str, Any] = {}
    all_access = True
    schema_ok = True
    for season, (start, end) in TARGET_WINDOWS.items():
        rows, call = safe_call(
            "/team_game_advanced_stats",
            {
                "season": season,
                "season_type": "regular",
                "start_date": start,
                "end_date": end,
                "period": 0,
            },
            api_key,
        )
        item: dict[str, Any] = {"window": [start, end], "call": call}
        if rows is None:
            all_access = False
            evidence[str(season)] = item
            continue
        games = {game_id(r) for r in rows if game_id(r) is not None}
        teams = {team_id(r) for r in rows if team_id(r) is not None}
        key_union: set[str] = set()
        rows_with_off = rows_with_def = rows_with_net = 0
        for row in rows:
            adv = advanced_obj(row)
            key_union.update(str(k) for k in adv)
            rows_with_off += first_num(adv, ("offensive_rating", "off_rating", "off_rtg")) is not None
            rows_with_def += first_num(adv, ("defensive_rating", "def_rating", "def_rtg")) is not None
            rows_with_net += first_num(adv, ("net_rating", "net_rtg")) is not None
        item.update({
            "distinct_games": len(games),
            "distinct_teams": len(teams),
            "advanced_field_names": sorted(key_union),
            "rows_with_off_rating": rows_with_off,
            "rows_with_def_rating": rows_with_def,
            "rows_with_net_rating": rows_with_net,
            "rows_digest_sha256": digest_rows(rows),
            "target_date_requested": False,
        })
        season_ok = len(rows) > 0 and rows_with_off == len(rows) and rows_with_def == len(rows) and rows_with_net == len(rows)
        if not season_ok:
            schema_ok = False
        evidence[str(season)] = item
    return evidence, all_access, schema_ok


def games_map(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for row in rows:
        try:
            gid = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        out[gid] = row
    return out


def score_for_team(game: dict[str, Any], tid: int) -> tuple[float, float] | None:
    home = game.get("home_team") if isinstance(game.get("home_team"), dict) else {}
    away = game.get("visitor_team") if isinstance(game.get("visitor_team"), dict) else game.get("away_team") if isinstance(game.get("away_team"), dict) else {}
    try:
        home_id = int(home.get("id"))
        away_id = int(away.get("id"))
    except (TypeError, ValueError):
        return None
    home_score = first_num(game, ("home_score", "home_team_score"))
    away_score = first_num(game, ("away_score", "visitor_team_score", "away_team_score"))
    if home_score is None or away_score is None:
        return None
    if tid == home_id:
        return home_score, away_score
    if tid == away_id:
        return away_score, home_score
    return None


def semantic_2026(api_key: str) -> dict[str, Any]:
    calls: dict[str, Any] = {}
    adv_game, calls["team_game_advanced_stats"] = safe_call(
        "/team_game_advanced_stats",
        {"season": 2026, "season_type": "regular", "period": 0},
        api_key,
    )
    basic_game, calls["team_stats"] = safe_call(
        "/team_stats",
        {"seasons[]": 2026},
        api_key,
    )
    games, calls["games"] = safe_call(
        "/games",
        {"seasons[]": 2026, "season_type": 2},
        api_key,
    )
    adv_season, calls["team_season_advanced_stats"] = safe_call(
        "/team_season_advanced_stats",
        {
            "season": 2026,
            "season_type": "regular",
            "scope": "general",
            "measure_type": "advanced",
            "per_mode": "per_game",
        },
        api_key,
    )
    basic_season, calls["team_season_stats"] = safe_call(
        "/team_season_stats",
        {"season": 2026, "season_type": 2},
        api_key,
    )
    if any(x is None for x in (adv_game, basic_game, games, adv_season, basic_season)):
        return {"calls": calls, "comparison_possible": False, "reason": "one_or_more_2026_source_calls_failed"}

    assert adv_game is not None and basic_game is not None and games is not None and adv_season is not None and basic_season is not None
    gm = games_map(games)
    basic_by_key: dict[tuple[int, int], dict[str, Any]] = {}
    for row in basic_game:
        gid, tid = game_id(row), team_id(row)
        if gid is not None and tid is not None:
            basic_by_key[(gid, tid)] = row

    adv_by_team: dict[int, list[dict[str, Any]]] = defaultdict(list)
    game_adv_fields: set[str] = set()
    for row in adv_game:
        tid = team_id(row)
        if tid is not None:
            adv_by_team[tid].append(row)
        game_adv_fields.update(advanced_obj(row).keys())

    season_adv_by_team = {tid: row for row in adv_season if (tid := team_id(row)) is not None}
    season_basic_by_team = {tid: row for row in basic_season if (tid := team_id(row)) is not None}
    season_adv_fields: set[str] = set()
    for row in adv_season:
        season_adv_fields.update(advanced_obj(row).keys())

    team_results = []
    for tid, season_row in sorted(season_adv_by_team.items()):
        advs = adv_by_team.get(tid, [])
        s_adv = advanced_obj(season_row)
        s_basic = season_basic_by_team.get(tid, {})
        gp = first_num(s_adv, ("gp",))
        if gp is None:
            gp = first_num(s_basic, ("games_played", "gp"))
        if gp is None or int(round(gp)) != len(advs):
            continue

        total_pts = total_opp_pts = total_poss = 0.0
        simple_off: list[float] = []
        simple_def: list[float] = []
        simple_net: list[float] = []
        pace_estimates: list[float] = []
        valid = True
        for row in advs:
            gid = game_id(row)
            adv = advanced_obj(row)
            off = first_num(adv, ("offensive_rating", "off_rating", "off_rtg"))
            deff = first_num(adv, ("defensive_rating", "def_rating", "def_rtg"))
            net = first_num(adv, ("net_rating", "net_rtg"))
            if gid is None or off is None or deff is None or net is None or off <= 0:
                valid = False
                break
            score = score_for_team(gm.get(gid, {}), tid)
            basic = basic_by_key.get((gid, tid), {})
            fga = first_num(basic, ("fga",))
            fta = first_num(basic, ("fta",))
            oreb = first_num(basic, ("oreb",))
            tov = first_num(basic, ("turnovers", "turnover", "tov"))
            if score is None or None in (fga, fta, oreb, tov):
                valid = False
                break
            pts, opp_pts = score
            poss = pts * 100.0 / off
            if poss <= 0:
                valid = False
                break
            total_pts += pts
            total_opp_pts += opp_pts
            total_poss += poss
            simple_off.append(off)
            simple_def.append(deff)
            simple_net.append(net)
            pace_estimates.append(float(fga) + 0.44 * float(fta) - float(oreb) + float(tov))
        if not valid or total_poss <= 0 or not pace_estimates:
            continue

        reconstructed_off = 100.0 * total_pts / total_poss
        reconstructed_def = 100.0 * total_opp_pts / total_poss
        reconstructed_net = reconstructed_off - reconstructed_def
        reconstructed_pace = sum(pace_estimates) / len(pace_estimates)

        season_off = first_num(s_adv, ("off_rating", "offensive_rating", "off_rtg"))
        season_def = first_num(s_adv, ("def_rating", "defensive_rating", "def_rtg"))
        season_net = first_num(s_adv, ("net_rating", "net_rtg"))
        season_adv_pace = first_num(s_adv, ("pace", "pace_per_game"))
        base_fga = first_num(s_basic, ("fga",))
        base_fta = first_num(s_basic, ("fta",))
        base_oreb = first_num(s_basic, ("oreb",))
        base_tov = first_num(s_basic, ("turnover", "turnovers", "tov"))
        if None in (season_off, season_def, season_net, base_fga, base_fta, base_oreb, base_tov):
            continue
        production_pace_fallback = float(base_fga) + 0.44 * float(base_fta) - float(base_oreb) + float(base_tov)

        team_results.append({
            "team_id": tid,
            "gp": int(round(gp)),
            "season_advanced_pace_present": season_adv_pace is not None,
            "delta_after_round1": {
                "offRtg": round(abs(round1(reconstructed_off) - round1(float(season_off))), 3),
                "defRtg": round(abs(round1(reconstructed_def) - round1(float(season_def))), 3),
                "netRtg": round(abs(round1(reconstructed_net) - round1(float(season_net))), 3),
                "pace": round(abs(round1(reconstructed_pace) - round1(production_pace_fallback)), 3),
            },
            "diagnostic_simple_mean_delta_after_round1": {
                "offRtg": round(abs(round1(sum(simple_off)/len(simple_off)) - round1(float(season_off))), 3),
                "defRtg": round(abs(round1(sum(simple_def)/len(simple_def)) - round1(float(season_def))), 3),
                "netRtg": round(abs(round1(sum(simple_net)/len(simple_net)) - round1(float(season_net))), 3),
            },
        })

    max_delta = {k: None for k in ("offRtg", "defRtg", "netRtg", "pace")}
    for field in max_delta:
        vals = [r["delta_after_round1"][field] for r in team_results]
        max_delta[field] = max(vals) if vals else None
    pace_present_count = sum(bool(r["season_advanced_pace_present"]) for r in team_results)
    enough = len(team_results) >= MIN_MATCHED_TEAMS
    within = enough and all(max_delta[k] is not None and float(max_delta[k]) <= TOL + 1e-9 for k in max_delta)
    pace_semantics_ok = pace_present_count == 0
    return {
        "calls": calls,
        "comparison_possible": True,
        "game_advanced_field_names": sorted(game_adv_fields),
        "season_advanced_field_names": sorted(season_adv_fields),
        "matched_teams": len(team_results),
        "minimum_matched_teams": MIN_MATCHED_TEAMS,
        "season_advanced_pace_present_team_count": pace_present_count,
        "production_pace_path_observed": "BASE_FALLBACK" if pace_present_count == 0 else "ADVANCED_PACE_PRESENT",
        "max_abs_delta_after_one_decimal_quantization": max_delta,
        "frozen_tolerance": TOL,
        "preregistered_possession_ratio_formula_pass": bool(within and pace_semantics_ok),
        "pace_semantics_pass": pace_semantics_ok,
        "team_delta_digest_sha256": hashlib.sha256(json.dumps(team_results, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "diagnostic_only_simple_mean_not_candidate": True,
    }


def main() -> int:
    api_key = os.environ.get("BDL_API_KEY", "").strip()
    evidence: dict[str, Any] = {
        "name": "WNBA_R1A4B_BDL_ADVANCED_ASOF_EVIDENCE_V1",
        "target_outcomes_opened": False,
        "target_dates_requested": False,
        "production_mutation": False,
        "frozen_tolerance_after_round1": TOL,
        "api_key_present": bool(api_key),
    }
    if not api_key:
        evidence.update({
            "historical_access": {},
            "semantic_2026": {"comparison_possible": False, "reason": "BDL_API_KEY_not_present_in_GitHub_Actions"},
            "decision": "ACCESS_NOT_CERTIFIED",
        })
        OUTPUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        return 0

    hist, access_ok, schema_ok = historical_access(api_key)
    evidence["historical_access"] = hist
    sem = semantic_2026(api_key)
    evidence["semantic_2026"] = sem

    if not access_ok:
        decision = "ACCESS_NOT_CERTIFIED"
    elif not schema_ok:
        decision = "GAME_ADVANCED_SCHEMA_INSUFFICIENT"
    elif not sem.get("comparison_possible"):
        decision = "ACCESS_CERTIFIED_SEMANTICS_NOT_EQUIVALENT"
    elif sem.get("preregistered_possession_ratio_formula_pass") is True:
        decision = "CERTIFIED_ADVANCED_ASOF_RECONSTRUCTION_SEMANTICS"
    else:
        decision = "ACCESS_CERTIFIED_SEMANTICS_NOT_EQUIVALENT"
    evidence["decision"] = decision
    OUTPUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
