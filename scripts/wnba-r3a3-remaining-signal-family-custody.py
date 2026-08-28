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

CONTRACT = Path("research/wnba/WNBA_R3A3_REMAINING_SIGNAL_FAMILY_CUSTODY_CONTRACT.json")
R1_PINS = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
R3_2020 = Path("research/wnba/WNBA_R3A1B_2020_FOUR_FACTORS_CUSTODY_CERTIFICATION.json")
R3A2_CONTRACT = Path("research/wnba/WNBA_R3A2_STRICT_PREFIX_FEATURE_CONSTRUCTOR_CONTRACT.json")
OUT = Path("wnba-r3a3-remaining-signal-family-custody-evidence.json")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2020, 2021, 2022, 2023, 2024, 2025)
EXPECTED_REGULAR = {2020:132, 2021:192, 2022:216, 2023:240, 2024:240, 2025:286}
COLS = [
    "game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id",
    "team_score", "opponent_team_score",
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
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v or "").strip()
    if not s:
        return None
    for candidate in (s, s[:10]):
        try:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00")).date()
        except ValueError:
            pass
    return None


def finite(v: Any) -> float | None:
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3A3/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def download(pin: dict[str, Any], path: Path) -> dict[str, Any]:
    aid = int(pin["asset_id"])
    expected_bytes = int(pin.get("size", pin.get("bytes")))
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    with urlopen(Request(API.format(asset_id=aid), headers=headers("application/octet-stream")), timeout=120) as r:
        payload = r.read()
    path.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    return {
        "asset_id": aid,
        "bytes": len(payload),
        "sha256": sha,
        "custody_verified": len(payload) == expected_bytes and sha == expected_sha,
    }


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    r1 = json.loads(R1_PINS.read_text())
    r20 = json.loads(R3_2020.read_text())
    r3a2 = json.loads(R3A2_CONTRACT.read_text())
    specials = {int(y): set(ids) for y, ids in r3a2["historical_scope"]["known_non_regular_special_event_ids_excluded"].items()}

    pins: dict[int, dict[str, Any]] = {2020: r20["source"]["team_box_2020"]}
    for y in range(2021, 2026):
        pins[y] = r1["frozen_asset_pins"][f"{y}_team_box"]

    ev: dict[str, Any] = {
        "name": "WNBA_R3A3_REMAINING_SIGNAL_FAMILY_CUSTODY_EVIDENCE_V1",
        "contract": str(CONTRACT),
        "target_outcome_scoring_performed": False,
        "model_fit_performed": False,
        "feature_weight_search_performed": False,
        "elite_threshold_search_performed": False,
        "market_values_consumed": False,
        "assets": {},
        "seasons": {},
        "totals": {
            "accepted_regular_games": 0,
            "side_rows": 0,
            "pair_failures": 0,
            "date_failures": 0,
            "score_component_failures": 0,
            "shot_component_failures": 0,
            "positive_possession_estimate_failures": 0,
        },
    }

    all_required_schema = True
    all_counts_match = True

    with tempfile.TemporaryDirectory(prefix="wnba-r3a3-") as td:
        root = Path(td)
        for season in SEASONS:
            path = root / f"team_box_{season}.parquet"
            asset = download(pins[season], path)
            ev["assets"][str(season)] = asset

            pf = pq.ParquetFile(path)
            missing = [c for c in COLS if c not in pf.schema_arrow.names]
            if missing:
                all_required_schema = False
                ev["seasons"][str(season)] = {"missing_columns": missing}
                continue

            raw = pf.read(columns=COLS).to_pylist()
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for r in raw:
                try:
                    y = int(r.get("season"))
                except (TypeError, ValueError):
                    continue
                if y != season or not regular(r.get("season_type")):
                    continue
                gid = norm_id(r.get("game_id"))
                if gid and gid not in specials.get(season, set()):
                    grouped[gid].append(r)

            accepted = 0
            side_rows = 0
            pair_fail = 0
            date_fail = 0
            score_fail = 0
            shot_fail = 0
            poss_fail = 0
            unique_teams: set[str] = set()

            for gid, pair in grouped.items():
                if len(pair) != 2:
                    pair_fail += 1
                    continue
                homes = [r for r in pair if norm_text(r.get("team_home_away")) == "home"]
                aways = [r for r in pair if norm_text(r.get("team_home_away")) == "away"]
                if len(homes) != 1 or len(aways) != 1:
                    pair_fail += 1
                    continue
                home, away = homes[0], aways[0]
                hid, aid = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
                if not hid or not aid or hid == aid:
                    pair_fail += 1
                    continue
                if norm_id(home.get("opponent_team_id")) != aid or norm_id(away.get("opponent_team_id")) != hid:
                    pair_fail += 1
                    continue
                hd, ad = parse_date(home.get("game_date")), parse_date(away.get("game_date"))
                if not hd or hd != ad:
                    date_fail += 1
                    continue

                accepted += 1
                side_rows += 2
                unique_teams.update((hid, aid))

                for side, opp in ((home, away), (away, home)):
                    score = finite(side.get("team_score"))
                    opp_score = finite(side.get("opponent_team_score"))
                    if score is None or opp_score is None:
                        score_fail += 1

                    vals = {
                        "fgm": finite(side.get("field_goals_made")),
                        "fga": finite(side.get("field_goals_attempted")),
                        "pm3": finite(side.get("three_point_field_goals_made")),
                        "pa3": finite(side.get("three_point_field_goals_attempted")),
                        "fta": finite(side.get("free_throws_attempted")),
                        "oreb": finite(side.get("offensive_rebounds")),
                        "dreb": finite(side.get("defensive_rebounds")),
                        "tov": finite(side.get("turnovers")),
                        "opp_fgm": finite(opp.get("field_goals_made")),
                        "opp_fga": finite(opp.get("field_goals_attempted")),
                        "opp_pm3": finite(opp.get("three_point_field_goals_made")),
                        "opp_pa3": finite(opp.get("three_point_field_goals_attempted")),
                        "opp_fta": finite(opp.get("free_throws_attempted")),
                        "opp_oreb": finite(opp.get("offensive_rebounds")),
                        "opp_dreb": finite(opp.get("defensive_rebounds")),
                        "opp_tov": finite(opp.get("turnovers")),
                    }
                    if any(v is None for v in vals.values()):
                        shot_fail += 1
                        continue
                    if vals["fga"] <= 0 or vals["opp_fga"] <= 0:
                        shot_fail += 1
                    if vals["oreb"] + vals["opp_dreb"] <= 0 or vals["opp_oreb"] + vals["dreb"] <= 0:
                        shot_fail += 1
                    poss = vals["fga"] + 0.44 * vals["fta"] - vals["oreb"] + vals["tov"]
                    if not math.isfinite(poss) or poss <= 0:
                        poss_fail += 1

            count_match = accepted == EXPECTED_REGULAR[season]
            all_counts_match = all_counts_match and count_match
            ev["seasons"][str(season)] = {
                "accepted_regular_games": accepted,
                "expected_regular_games": EXPECTED_REGULAR[season],
                "regular_game_count_matches": count_match,
                "side_rows": side_rows,
                "unique_teams": len(unique_teams),
                "pair_failures": pair_fail,
                "date_failures": date_fail,
                "score_component_failures": score_fail,
                "shot_component_failures": shot_fail,
                "positive_possession_estimate_failures": poss_fail,
                "required_schema_complete": True,
            }
            ev["totals"]["accepted_regular_games"] += accepted
            ev["totals"]["side_rows"] += side_rows
            ev["totals"]["pair_failures"] += pair_fail
            ev["totals"]["date_failures"] += date_fail
            ev["totals"]["score_component_failures"] += score_fail
            ev["totals"]["shot_component_failures"] += shot_fail
            ev["totals"]["positive_possession_estimate_failures"] += poss_fail

    custody_ok = all(v.get("custody_verified") for v in ev["assets"].values())
    component_ok = all(
        ev["totals"][k] == 0 for k in (
            "pair_failures", "date_failures", "score_component_failures",
            "shot_component_failures", "positive_possession_estimate_failures"
        )
    )

    ev["family_classification"] = {
        "SHOT_PROFILE_MATCHUP": {
            "status": "HISTORICALLY_RECONSTRUCTIBLE_PREFIX_REQUIRED" if component_ok else "BLOCKED_COMPONENT_FAILURE",
            "scope": "Offensive and opponent-allowed eFG/3PAr/FTr plus rebound matchup components from paired prior-game rows.",
        },
        "QUALITY_ADJUSTED_FORM": {
            "status": "HISTORICALLY_RECONSTRUCTIBLE_FORMULA_FREEZE_REQUIRED" if component_ok else "BLOCKED_COMPONENT_FAILURE",
            "scope": "Prior-game score margin and estimated possession efficiency are reconstructible; opponent-quality adjustment formula must be frozen before evaluation.",
        },
        "H2H_PREFIX": {
            "status": "HISTORICALLY_RECONSTRUCTIBLE_2021_2025__2020_NEEDS_2019_FOR_FULL_TWO_SEASON_WINDOW" if component_ok else "BLOCKED_COMPONENT_FAILURE",
            "scope": "Strictly prior meeting count, win share and margin from paired rows; no missing 2019 history may be silently imputed for 2020 targets.",
        },
        "FATIGUE_DATE_BASED_V2": {
            "status": "HISTORICALLY_RECONSTRUCTIBLE_PREFIX_REQUIRED" if component_ok else "BLOCKED_COMPONENT_FAILURE",
            "scope": "Days rest, B2B, 3-in-5 and 4-in-7 from prior official dates.",
        },
        "ACTUAL_TRAVEL_SEQUENCE_V2": {
            "status": "BLOCKED_PENDING_HISTORICAL_VENUE_COORDINATE_CUSTODY",
            "scope": "No actual trip-distance or timezone sequence authorized by this gate.",
        },
        "AVAILABILITY_STAR_POWER": {
            "status": "PROSPECTIVE_ONLY_HISTORICAL_TIMESTAMP_CUSTODY_NOT_CERTIFIED",
            "scope": "Historical unknown availability cannot be imputed to zero.",
        },
    }

    passed = custody_ok and all_required_schema and all_counts_match and component_ok
    ev["asset_custody_all_verified"] = custody_ok
    ev["required_schema_complete_all_seasons"] = all_required_schema
    ev["regular_game_counts_all_match"] = all_counts_match
    ev["reconstructible_component_integrity_pass"] = component_ok
    ev["decision"] = "PASS_REMAINING_SIGNAL_FAMILY_CUSTODY_CLASSIFICATION" if passed else "FAIL_REMAINING_SIGNAL_FAMILY_CUSTODY_AUDIT"
    ev["next_gate"] = contract["next_gate_on_pass"] if passed else "R3A3_REPAIR_REQUIRED"
    OUT.write_text(json.dumps(ev, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "decision": ev["decision"],
        "totals": ev["totals"],
        "family_classification": ev["family_classification"],
        "next_gate": ev["next_gate"],
    }, indent=2))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
