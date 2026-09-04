#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.dataset as pads
import pyarrow.parquet as pq

CONTRACT = Path("research/wnba/WNBA_R1A4C_FULL_PREFIX_CONSTRUCTOR_CUSTODY.json")
PINS = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
OUT_ROWS = Path("wnba-r1a4c-prefix-rowset.jsonl")
OUT_EVIDENCE = Path("wnba-r1a4c-prefix-evidence.json")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)
SCHEDULE_COLS = ["game_id", "season", "season_type", "game_date_time", "game_date", "home_id", "away_id", "team_box", "time_valid"]
IDENTITY_COLS = ["game_id", "season", "season_type", "game_date", "game_date_time", "team_id", "team_home_away", "opponent_team_id"]
STAT_COLS = ["game_id", "team_id", "team_home_away", "opponent_team_id", "team_score", "opponent_team_score", "field_goals_attempted", "free_throws_attempted", "offensive_rebounds", "turnovers"]


def headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "Prediccion-Elite-WNBA-R1A4C/1.0", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 90) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


def norm_id(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def norm_text(v: Any) -> str:
    return str(v or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def regular(v: Any) -> bool:
    return norm_text(v) in {"regular", "regularseason", "2"}


def parse_date(*vals: Any) -> date | None:
    for v in vals:
        if v is None:
            continue
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        s = str(v).strip()
        if not s:
            continue
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
        except ValueError:
            pass
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


def finite(v: Any) -> float | None:
    try:
        x = float(v)
        if math.isfinite(x):
            return x
    except (TypeError, ValueError):
        return None
    return None


def js_round(v: float, digits: int = 1) -> float:
    f = 10 ** digits
    return math.floor(v * f + 0.5) / f


def verify_download(pin: dict[str, Any], dst: Path) -> dict[str, Any]:
    aid = int(pin["asset_id"])
    meta = json.loads(get_bytes(API.format(asset_id=aid), "application/vnd.github+json").decode())
    payload = get_bytes(API.format(asset_id=aid), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    ok = int(meta.get("id", -1)) == aid and len(payload) == int(pin["size"]) and sha == expected_sha
    return {"asset_id": aid, "name": pin.get("name") or meta.get("name"), "bytes": len(payload), "sha256": sha, "custody_verified": ok}


def aggregate(games: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not games:
        return None
    keys = ("fga", "fta", "oreb", "tov", "scored", "allowed")
    for g in games:
        if any(finite(g.get(k)) is None for k in keys):
            return None
    n = len(games)
    means = {k: sum(float(g[k]) for g in games) / n for k in keys}
    pace = means["fga"] + 0.44 * means["fta"] - means["oreb"] + means["tov"]
    if pace <= 0:
        return None
    off = 100 * means["scored"] / pace
    deff = 100 * means["allowed"] / pace
    wins = sum(1 for g in games if g["won"])
    return {
        "games": n,
        "wins": wins,
        "losses": n - wins,
        "winRate": js_round(wins / n, 2),
        "pace": js_round(pace),
        "ppg": js_round(means["scored"]),
        "oppPpg": js_round(means["allowed"]),
        "offRtg": js_round(off),
        "defRtg": js_round(deff),
        "netRtg": js_round(off - deff),
    }


def team_state(team_id: str, target_date: date, history: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    games = history.get(team_id, [])
    season = aggregate(games)
    if not season:
        return None
    recent_games = games[-10:]
    recent = aggregate(recent_games)
    if not recent:
        return None
    last = games[-1]
    prev = games[-2] if len(games) >= 2 else None
    days_rest = max(0, (target_date - last["date"]).days)
    is_b2b = bool(prev and (last["date"] - prev["date"]).days <= 1)
    games_last_7 = sum(1 for g in games if g["date"] >= target_date - timedelta(days=7))
    winning = bool(last["won"])
    streak = 0
    for g in reversed(games):
        if bool(g["won"]) != winning:
            break
        streak += 1 if winning else -1

    opponent_occurrences = [g["opponent_id"] for g in recent_games]
    sos_rows: list[tuple[float, float]] = []
    for opp in opponent_occurrences:
        opp_games = history.get(opp, [])
        opp_season = aggregate(opp_games)
        if not opp_season:
            continue
        opp_recent = aggregate(opp_games[-10:])
        if opp_recent:
            boff = 0.4 * opp_season["offRtg"] + 0.6 * opp_recent["offRtg"]
            bdef = 0.4 * opp_season["defRtg"] + 0.6 * opp_recent["defRtg"]
        else:
            boff, bdef = opp_season["offRtg"], opp_season["defRtg"]
        sos_rows.append((boff, bdef))
    if sos_rows:
        avg_off = sum(x for x, _ in sos_rows) / len(sos_rows)
        avg_def = sum(x for _, x in sos_rows) / len(sos_rows)
        sos = {"status": "READY", "opponentOccurrencesUsed": len(sos_rows), "oppAvgOffRtg": js_round(avg_off), "oppAvgDefRtg": js_round(avg_def), "oppAvgNetRtg": js_round(avg_off - avg_def)}
    else:
        sos = {"status": "SOS_UNAVAILABLE", "opponentOccurrencesUsed": 0, "oppAvgOffRtg": None, "oppAvgDefRtg": None, "oppAvgNetRtg": None}

    return {
        "teamId": team_id,
        "gamesPlayed": season["games"],
        "wins": season["wins"],
        "losses": season["losses"],
        "winRate": season["winRate"],
        "pace": season["pace"],
        "ppg": season["ppg"],
        "offRtg": season["offRtg"],
        "defRtg": season["defRtg"],
        "netRtg": season["netRtg"],
        "recentPace": season["pace"],
        "recentOffRtg": season["offRtg"],
        "recentDefRtg": season["defRtg"],
        "recentNetRtg": season["netRtg"],
        "recentPpg": recent["ppg"],
        "recentWinPct": recent["winRate"],
        "daysRest": days_rest,
        "isB2B": is_b2b,
        "b2bWasRoad": bool(is_b2b and prev and not prev["is_home"]),
        "gamesLast7": games_last_7,
        "streak": streak,
        "sos": sos,
        "travelMiles": None,
        "travelStatus": "PENDING_SEASON_VENUE_CERTIFICATION",
        "injuryAdj": None,
        "injuryStatus": "UNKNOWN_NOT_ZERO",
        "manualAdjustment": None,
        "manualStatus": "NO_HISTORICAL_LOG"
    }


def read_stats_for_ids(path: Path, game_ids: list[str]) -> list[dict[str, Any]]:
    dataset = pads.dataset(str(path), format="parquet")
    field = dataset.schema.field("game_id")
    if pa.types.is_integer(field.type):
        vals = [int(float(x)) for x in game_ids]
    else:
        vals = game_ids
    expr = pads.field("game_id").isin(pa.array(vals, type=field.type))
    return dataset.to_table(columns=STAT_COLS, filter=expr).to_pylist()


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    pins = json.loads(PINS.read_text())
    evidence: dict[str, Any] = {
        "name": "WNBA_R1A4C_PREFIX_CONSTRUCTOR_EVIDENCE_V1",
        "candidate": contract["candidate"],
        "evaluation_labels_attached": False,
        "target_outcome_fields_in_rowset": 0,
        "market_data_consumed": False,
        "travel_injury_manual_imputed": False,
        "same_day_value_used_count": 0,
        "future_value_used_count": 0,
        "target_self_in_prefix_count": 0,
        "assets": {},
        "season": {},
    }
    canonical_lines: list[str] = []
    all_custody = True
    total_joined = total_regular_box = 0
    total_two_prefix = 0

    with tempfile.TemporaryDirectory(prefix="wnba-r1a4c-") as td:
        root = Path(td)
        schedule_pin = pins["frozen_asset_pins"]["schedule_master"]
        schedule_path = root / "schedule.parquet"
        schedule_ev = verify_download(schedule_pin, schedule_path)
        evidence["assets"]["schedule"] = schedule_ev
        all_custody &= schedule_ev["custody_verified"]
        schedule_rows = pq.read_table(schedule_path, columns=SCHEDULE_COLS).to_pylist()
        schedule_map: dict[tuple[int, str], dict[str, Any]] = {}
        schedule_type_values: dict[int, set[str]] = defaultdict(set)
        for r in schedule_rows:
            try:
                season = int(r.get("season"))
            except (TypeError, ValueError):
                continue
            if season not in SEASONS:
                continue
            schedule_type_values[season].add(str(r.get("season_type")))
            if not regular(r.get("season_type")):
                continue
            gid = norm_id(r.get("game_id"))
            dt = parse_date(r.get("game_date_time"), r.get("game_date"))
            if not gid or not dt:
                continue
            schedule_map[(season, gid)] = {"game_id": gid, "date": dt, "home_id": norm_id(r.get("home_id")), "away_id": norm_id(r.get("away_id"))}

        for season in SEASONS:
            pin = pins["frozen_asset_pins"][f"{season}_team_box"]
            path = root / f"team_box_{season}.parquet"
            asset_ev = verify_download(pin, path)
            evidence["assets"][str(season)] = asset_ev
            all_custody &= asset_ev["custody_verified"]
            identity = pq.read_table(path, columns=IDENTITY_COLS).to_pylist()
            type_values = sorted({str(r.get("season_type")) for r in identity})
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for r in identity:
                if not regular(r.get("season_type")):
                    continue
                gid = norm_id(r.get("game_id"))
                if gid:
                    grouped[gid].append(r)
            total_regular_box += len(grouped)

            targets_by_date: dict[date, list[dict[str, Any]]] = defaultdict(list)
            identity_bad = 0
            joined = 0
            for gid, sides in grouped.items():
                if len(sides) != 2:
                    identity_bad += 1
                    continue
                sched = schedule_map.get((season, gid))
                if not sched:
                    continue
                side_map = {norm_text(r.get("team_home_away")): r for r in sides}
                home = side_map.get("home")
                away = side_map.get("away")
                if not home or not away:
                    identity_bad += 1
                    continue
                home_id, away_id = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
                if home_id != sched["home_id"] or away_id != sched["away_id"]:
                    identity_bad += 1
                    continue
                joined += 1
                targets_by_date[sched["date"]].append({"game_id": gid, "target_date": sched["date"], "home_id": home_id, "away_id": away_id})
            total_joined += joined

            history: dict[str, list[dict[str, Any]]] = defaultdict(list)
            season_two_prefix = 0
            season_full_sos = 0
            cold_start = 0
            ingest_missing = 0
            date_batches = 0

            for d in sorted(targets_by_date):
                day_targets = sorted(targets_by_date[d], key=lambda x: x["game_id"])
                day_ids = [x["game_id"] for x in day_targets]

                # Phase 1: seal all date-D target rows from prefix strictly before D.
                for target in day_targets:
                    gid = target["game_id"]
                    for tid in (target["home_id"], target["away_id"]):
                        for g in history.get(tid, []):
                            if g["game_id"] == gid:
                                evidence["target_self_in_prefix_count"] += 1
                            if g["date"] == d:
                                evidence["same_day_value_used_count"] += 1
                            if g["date"] > d:
                                evidence["future_value_used_count"] += 1
                    hs = team_state(target["home_id"], d, history)
                    aws = team_state(target["away_id"], d, history)
                    if not hs or not aws:
                        cold_start += 1
                        continue
                    season_two_prefix += 1
                    total_two_prefix += 1
                    if hs["sos"]["status"] == "READY" and aws["sos"]["status"] == "READY":
                        season_full_sos += 1
                    row = {
                        "schemaVersion": 1,
                        "candidate": contract["candidate"],
                        "season": season,
                        "targetDate": d.isoformat(),
                        "gameId": gid,
                        "homeTeamId": target["home_id"],
                        "awayTeamId": target["away_id"],
                        "home": hs,
                        "away": aws,
                        "targetOutcomeAttached": False,
                        "marketAttached": False,
                    }
                    canonical_lines.append(json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False))

                # Phase 2: only after all date-D rows are sealed, ingest date-D boxes for future dates.
                stat_rows = read_stats_for_ids(path, day_ids)
                by_game: dict[str, list[dict[str, Any]]] = defaultdict(list)
                for r in stat_rows:
                    by_game[norm_id(r.get("game_id"))].append(r)
                for gid in day_ids:
                    rows = by_game.get(gid, [])
                    if len(rows) != 2:
                        ingest_missing += 1
                        continue
                    valid_records: list[tuple[str, dict[str, Any]]] = []
                    for r in rows:
                        team_id = norm_id(r.get("team_id"))
                        opp_id = norm_id(r.get("opponent_team_id"))
                        side = norm_text(r.get("team_home_away"))
                        vals = {k: finite(r.get(k)) for k in ("team_score", "opponent_team_score", "field_goals_attempted", "free_throws_attempted", "offensive_rebounds", "turnovers")}
                        if not team_id or not opp_id or side not in {"home", "away"} or any(v is None for v in vals.values()):
                            valid_records = []
                            break
                        rec = {"game_id": gid, "date": d, "is_home": side == "home", "opponent_id": opp_id, "scored": vals["team_score"], "allowed": vals["opponent_team_score"], "fga": vals["field_goals_attempted"], "fta": vals["free_throws_attempted"], "oreb": vals["offensive_rebounds"], "tov": vals["turnovers"], "won": vals["team_score"] > vals["opponent_team_score"]}
                        valid_records.append((team_id, rec))
                    if len(valid_records) != 2:
                        ingest_missing += 1
                        continue
                    for tid, rec in valid_records:
                        history[tid].append(rec)
                date_batches += 1

            evidence["season"][str(season)] = {
                "schedule_season_type_values": sorted(schedule_type_values.get(season, set())),
                "team_box_season_type_values": type_values,
                "regular_team_box_games": len(grouped),
                "joined_regular_targets": joined,
                "identity_bad_games": identity_bad,
                "join_rate": round(joined / len(grouped), 6) if grouped else 0.0,
                "date_batches": date_batches,
                "targets_with_two_team_prefix": season_two_prefix,
                "targets_with_both_sos_ready": season_full_sos,
                "cold_start_or_unavailable_targets": cold_start,
                "phase2_ingest_bad_games": ingest_missing,
            }

    canonical_lines.sort(key=lambda s: (json.loads(s)["season"], json.loads(s)["targetDate"], json.loads(s)["gameId"]))
    rowset_bytes = (("\n".join(canonical_lines) + "\n") if canonical_lines else "").encode()
    OUT_ROWS.write_bytes(rowset_bytes)
    rowset_sha = hashlib.sha256(rowset_bytes).hexdigest()
    per_season_ok = all(evidence["season"].get(str(s), {}).get("targets_with_two_team_prefix", 0) >= int(contract["empirical_gate"]["minimum_targets_per_season_with_two_team_prefix"]) for s in SEASONS)
    join_ok = all(evidence["season"].get(str(s), {}).get("join_rate", 0) >= float(contract["empirical_gate"]["identity_join_rate_min"]) for s in SEASONS)
    ingest_ok = all(evidence["season"].get(str(s), {}).get("phase2_ingest_bad_games", 1) == 0 for s in SEASONS)
    leakage_ok = evidence["target_self_in_prefix_count"] == 0 and evidence["same_day_value_used_count"] == 0 and evidence["future_value_used_count"] == 0 and evidence["target_outcome_fields_in_rowset"] == 0
    volume_ok = total_two_prefix >= int(contract["empirical_gate"]["minimum_total_targets_with_two_team_prefix"]) and per_season_ok
    if not all_custody or not join_ok or not ingest_ok or not leakage_ok:
        decision = "NOT_CERTIFIED_PREFIX_CUSTODY"
    elif not volume_ok:
        decision = "INSUFFICIENT_PREFIX_VOLUME"
    else:
        decision = "CERTIFIED_PREFIX_CUSTODY_RECONSTRUCTIBLE_GROUPS_TRAVEL_INJURY_MANUAL_STILL_OPEN"
    evidence.update({
        "total_regular_team_box_games": total_regular_box,
        "total_joined_regular_targets": total_joined,
        "overall_identity_join_rate": round(total_joined / total_regular_box, 6) if total_regular_box else 0.0,
        "total_targets_with_two_team_prefix": total_two_prefix,
        "rowset_rows": len(canonical_lines),
        "rowset_bytes": len(rowset_bytes),
        "rowset_sha256": rowset_sha,
        "all_source_custody_verified": all_custody,
        "join_gate_pass": join_ok,
        "phase2_ingest_gate_pass": ingest_ok,
        "leakage_gate_pass": leakage_ok,
        "volume_gate_pass": volume_ok,
        "decision": decision,
        "r1b_outcome_opening_authorized": False,
        "next_gate": "R1A4D_SEASON_VENUE_TRAVEL_CUSTODY_OR_R1A5_INJURY_NEUTRAL_CANDIDATE_FREEZE" if decision.startswith("CERTIFIED_") else "R1A4C_REPAIR"
    })
    OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps(evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
