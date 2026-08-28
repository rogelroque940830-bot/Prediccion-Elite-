#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT = Path("research/wnba/WNBA_R3A2_STRICT_PREFIX_FEATURE_CONSTRUCTOR_CONTRACT.json")
R1_PINS = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
R3_2020 = Path("research/wnba/WNBA_R3A1B_2020_FOUR_FACTORS_CUSTODY_CERTIFICATION.json")
OUT_ROWS = Path("wnba-r3a2-strict-prefix-four-factors.jsonl")
OUT_EVIDENCE = Path("wnba-r3a2-strict-prefix-four-factors-evidence.json")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2020, 2021, 2022, 2023, 2024, 2025)
EXPECTED_REGULAR = {2020:132, 2021:192, 2022:216, 2023:240, 2024:240, 2025:286}
COLS = [
    "game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id",
    "field_goals_made", "field_goals_attempted", "three_point_field_goals_made",
    "three_point_field_goals_attempted", "free_throws_attempted", "offensive_rebounds",
    "defensive_rebounds", "turnovers"
]


def norm_id(v: Any) -> str:
    s = str(v or "").strip()
    return s[:-2] if s.endswith(".0") and s[:-2].isdigit() else s


def norm_text(v: Any) -> str:
    return str(v or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def regular(v: Any) -> bool:
    return norm_text(v) in {"regular", "regularseason", "2"}


def parse_date(v: Any) -> date | None:
    if isinstance(v, datetime): return v.date()
    if isinstance(v, date): return v
    s = str(v or "").strip()
    if not s: return None
    for candidate in (s, s[:10]):
        try: return datetime.fromisoformat(candidate.replace("Z", "+00:00")).date()
        except ValueError: pass
    return None


def finite(v: Any) -> float | None:
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def q(x: float) -> float:
    return round(float(x), 12)


def headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "Prediccion-Elite-WNBA-R3A2/1.0", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token: h["Authorization"] = f"Bearer {token}"
    return h


def download(pin: dict[str, Any], path: Path) -> dict[str, Any]:
    aid = int(pin["asset_id"])
    expected_bytes = int(pin.get("size", pin.get("bytes")))
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    with urlopen(Request(API.format(asset_id=aid), headers=headers("application/octet-stream")), timeout=120) as r:
        payload = r.read()
    path.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    return {"asset_id": aid, "bytes": len(payload), "sha256": sha, "custody_verified": len(payload) == expected_bytes and sha == expected_sha}


def aggregate(games: list[dict[str, Any]]) -> dict[str, float] | None:
    if not games: return None
    sums = {k: sum(float(g[k]) for g in games) for k in ("fgm","fga","pm3","pa3","fta","oreb","opp_dreb","tov")}
    if sums["fga"] <= 0 or sums["fga"] + 0.44*sums["fta"] + sums["tov"] <= 0 or sums["oreb"] + sums["opp_dreb"] <= 0:
        return None
    return {
        "efgPct": q((sums["fgm"] + 0.5*sums["pm3"]) / sums["fga"]),
        "tovPct": q(sums["tov"] / (sums["fga"] + 0.44*sums["fta"] + sums["tov"])),
        "orbPct": q(sums["oreb"] / (sums["oreb"] + sums["opp_dreb"])),
        "ftr": q(sums["fta"] / sums["fga"]),
        "threePointAttemptRate": q(sums["pa3"] / sums["fga"]),
    }


def state(team_id: str, target_date: date, target_gid: str, history: dict[str, list[dict[str, Any]]], ev: dict[str, Any]) -> dict[str, Any] | None:
    games = history.get(team_id, [])
    if not games: return None
    for g in games:
        if g["game_id"] == target_gid: ev["target_self_source_use_count"] += 1
        if g["date"] == target_date: ev["same_day_source_use_count"] += 1
        if g["date"] > target_date: ev["future_source_use_count"] += 1
    season_values = aggregate(games)
    recent = sorted(games, key=lambda x: (x["date"], x["game_id"]))[-10:]
    recent_values = aggregate(recent)
    if not season_values or not recent_values: return None
    max_prior = max(g["date"] for g in games)
    if not max_prior < target_date: ev["max_prior_date_violation_count"] += 1
    return {
        "priorGameCount": len(games),
        "maxPriorDate": max_prior.isoformat(),
        "season": season_values,
        "recent10": {"gameCount": len(recent), **recent_values},
    }


def valid_factor_ranges(side: dict[str, Any]) -> bool:
    for window in (side["season"], side["recent10"]):
        vals = [window[k] for k in ("efgPct","tovPct","orbPct","ftr","threePointAttemptRate")]
        if not all(math.isfinite(float(v)) for v in vals): return False
        if not (0 <= window["efgPct"] <= 1.5): return False
        if not (0 <= window["tovPct"] <= 1): return False
        if not (0 <= window["orbPct"] <= 1): return False
        if not (window["ftr"] >= 0): return False
        if not (0 <= window["threePointAttemptRate"] <= 1): return False
    return True


def canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    r1 = json.loads(R1_PINS.read_text())
    r20 = json.loads(R3_2020.read_text())
    specials = {int(y): set(ids) for y, ids in contract["historical_scope"]["known_non_regular_special_event_ids_excluded"].items()}
    pins: dict[int, dict[str, Any]] = {2020: r20["source"]["team_box_2020"]}
    for y in range(2021, 2026): pins[y] = r1["frozen_asset_pins"][f"{y}_team_box"]

    ev: dict[str, Any] = {
        "name":"WNBA_R3A2_STRICT_PREFIX_FEATURE_CONSTRUCTOR_EVIDENCE_V1",
        "contract":str(CONTRACT),
        "outcomes_opened":False,
        "score_or_winner_values_projected":False,
        "market_values_consumed":False,
        "injury_values_consumed":False,
        "manual_adjustment_values_consumed":False,
        "model_fit":False,
        "hit_rate_tested":False,
        "same_day_source_use_count":0,
        "future_source_use_count":0,
        "target_self_source_use_count":0,
        "max_prior_date_violation_count":0,
        "duplicate_emitted_game_id_count":0,
        "invalid_factor_range_side_count":0,
        "pair_or_date_identity_failure_count":0,
        "assets":{},
        "seasons":{},
    }
    lines: list[str] = []
    emitted_ids: set[str] = set()

    with tempfile.TemporaryDirectory(prefix="wnba-r3a2-") as td:
        root = Path(td)
        for season in SEASONS:
            path = root / f"team_box_{season}.parquet"
            asset = download(pins[season], path)
            ev["assets"][str(season)] = asset
            pf = pq.ParquetFile(path)
            missing = [c for c in COLS if c not in pf.schema_arrow.names]
            if missing: raise SystemExit(f"season {season} missing columns: {missing}")
            raw = pf.read(columns=COLS).to_pylist()
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for r in raw:
                try: y = int(r.get("season"))
                except (TypeError, ValueError): continue
                if y != season or not regular(r.get("season_type")): continue
                gid = norm_id(r.get("game_id"))
                if gid and gid not in specials.get(season, set()): grouped[gid].append(r)

            targets_by_date: dict[date, list[dict[str, Any]]] = defaultdict(list)
            validated_pairs: dict[str, tuple[dict[str, Any], dict[str, Any], date]] = {}
            pair_fail = 0
            for gid, pair in grouped.items():
                if len(pair) != 2:
                    pair_fail += 1; continue
                homes = [r for r in pair if norm_text(r.get("team_home_away")) == "home"]
                aways = [r for r in pair if norm_text(r.get("team_home_away")) == "away"]
                if len(homes) != 1 or len(aways) != 1:
                    pair_fail += 1; continue
                home, away = homes[0], aways[0]
                hid, aid = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
                if not hid or not aid or hid == aid or norm_id(home.get("opponent_team_id")) != aid or norm_id(away.get("opponent_team_id")) != hid:
                    pair_fail += 1; continue
                hd, ad = parse_date(home.get("game_date")), parse_date(away.get("game_date"))
                if not hd or hd != ad:
                    pair_fail += 1; continue
                validated_pairs[gid] = (home, away, hd)
                targets_by_date[hd].append({"game_id":gid,"date":hd,"home_id":hid,"away_id":aid})
            ev["pair_or_date_identity_failure_count"] += pair_fail

            history: dict[str, list[dict[str, Any]]] = defaultdict(list)
            season_emitted = 0
            cold_start = 0
            for d in sorted(targets_by_date):
                day_targets = sorted(targets_by_date[d], key=lambda x:x["game_id"])
                # Seal every target on date D before ingesting any date-D components.
                for target in day_targets:
                    hs = state(target["home_id"], d, target["game_id"], history, ev)
                    aws = state(target["away_id"], d, target["game_id"], history, ev)
                    if hs is None or aws is None:
                        cold_start += 1
                        continue
                    if not valid_factor_ranges(hs): ev["invalid_factor_range_side_count"] += 1
                    if not valid_factor_ranges(aws): ev["invalid_factor_range_side_count"] += 1
                    if target["game_id"] in emitted_ids: ev["duplicate_emitted_game_id_count"] += 1
                    emitted_ids.add(target["game_id"])
                    row = {
                        "season":season,
                        "gameId":target["game_id"],
                        "gameDate":d.isoformat(),
                        "homeTeamId":target["home_id"],
                        "awayTeamId":target["away_id"],
                        "home":hs,
                        "away":aws,
                        "provenance":{
                            "featureCutoffRule":"STRICTLY_PRIOR_OFFICIAL_DATE",
                            "sameDayExcluded":True,
                            "outcomeAttached":False,
                            "marketAttached":False,
                        }
                    }
                    lines.append(canonical(row)); season_emitted += 1

                # Only now may the full date-D slate enter history.
                for target in day_targets:
                    home, away, gd = validated_pairs[target["game_id"]]
                    for side, opp in ((home,away),(away,home)):
                        values = {
                            "fgm":finite(side.get("field_goals_made")), "fga":finite(side.get("field_goals_attempted")),
                            "pm3":finite(side.get("three_point_field_goals_made")), "pa3":finite(side.get("three_point_field_goals_attempted")),
                            "fta":finite(side.get("free_throws_attempted")), "oreb":finite(side.get("offensive_rebounds")),
                            "opp_dreb":finite(opp.get("defensive_rebounds")), "tov":finite(side.get("turnovers")),
                        }
                        if any(v is None for v in values.values()): raise SystemExit(f"missing factor component {season} {target['game_id']}")
                        history[norm_id(side.get("team_id"))].append({"game_id":target["game_id"],"date":gd,**values})

            ev["seasons"][str(season)] = {
                "acceptedRegularGames":len(validated_pairs),
                "expectedRegularGames":EXPECTED_REGULAR[season],
                "regularGameCountMatches":len(validated_pairs)==EXPECTED_REGULAR[season],
                "prefixRowsEmitted":season_emitted,
                "coldStartExclusions":cold_start,
                "pairOrDateFailures":pair_fail,
            }

    lines.sort(key=lambda s: (json.loads(s)["season"], json.loads(s)["gameDate"], json.loads(s)["gameId"]))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    OUT_ROWS.write_bytes(payload)
    ev["rowset"] = {"rows":len(lines),"bytes":len(payload),"sha256":hashlib.sha256(payload).hexdigest()}
    ev["asset_custody_all_verified"] = all(v["custody_verified"] for v in ev["assets"].values())
    ev["regular_game_counts_all_match"] = all(v["regularGameCountMatches"] for v in ev["seasons"].values())
    passed = all([
        ev["asset_custody_all_verified"], ev["regular_game_counts_all_match"],
        ev["pair_or_date_identity_failure_count"]==0, ev["same_day_source_use_count"]==0,
        ev["future_source_use_count"]==0, ev["target_self_source_use_count"]==0,
        ev["max_prior_date_violation_count"]==0, ev["duplicate_emitted_game_id_count"]==0,
        ev["invalid_factor_range_side_count"]==0, len(lines)>0,
    ])
    ev["decision"] = "PASS_STRICT_PRIOR_DATE_FOUR_FACTORS_PREFIX" if passed else "FAIL_STRICT_PREFIX_CERTIFICATION"
    ev["next_gate"] = contract["next_gate_on_pass"] if passed else "R3A2_REPAIR_REQUIRED"
    OUT_EVIDENCE.write_text(json.dumps(ev, indent=2, sort_keys=True)+"\n")
    print(json.dumps({"decision":ev["decision"],"rows":ev["rowset"]["rows"],"sha256":ev["rowset"]["sha256"],"seasons":ev["seasons"],"anti_leakage":{"same_day":ev["same_day_source_use_count"],"future":ev["future_source_use_count"],"self":ev["target_self_source_use_count"],"max_prior":ev["max_prior_date_violation_count"]}}, indent=2))
    if not passed: raise SystemExit("R3A2 strict prefix certification failed")

if __name__ == "__main__": main()
