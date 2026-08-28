#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

PINS_PATH = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
OUT = Path("wnba-r3a1-four-factors-custody-evidence.json")
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)
EXPECTED_GAMES = {2021: 192, 2022: 216, 2023: 240, 2024: 240, 2025: 286}
SPECIAL_EVENTS = {
    2021: {"401341447", "401353913"},
    2022: {"401455978", "401430112"},
    2023: {"401558893", "401507376"},
    2024: {"401620458", "401677672"},
    2025: {"401781604", "401736430"},
}

IDENTITY_COLUMNS = [
    "game_id", "season", "season_type", "team_id", "team_home_away", "opponent_team_id"
]
COMPONENT_COLUMNS = [
    "field_goals_made",
    "field_goals_attempted",
    "three_point_field_goals_made",
    "three_point_field_goals_attempted",
    "free_throws_attempted",
    "offensive_rebounds",
    "defensive_rebounds",
    "turnovers",
]
PROJECTED_COLUMNS = IDENTITY_COLUMNS + COMPONENT_COLUMNS

FORMULAS = {
    "efg_pct": "(FGM + 0.5 * 3PM) / FGA",
    "tov_pct": "TOV / (FGA + 0.44 * FTA + TOV)",
    "orb_pct": "OREB / (OREB + opponent_DREB)",
    "ftr": "FTA / FGA",
    "three_point_attempt_rate": "3PA / FGA",
}


def norm_id(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def norm_text(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def is_regular(value: Any) -> bool:
    return norm_text(value) in {"regular", "regularseason", "2"}


def finite(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def request_headers(accept: str) -> dict[str, str]:
    headers = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3A1/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def download_asset(pin: dict[str, Any], destination: Path) -> dict[str, Any]:
    asset_id = int(pin["asset_id"])
    url = ASSET_API.format(asset_id=asset_id)
    req = Request(url, headers=request_headers("application/octet-stream"))
    with urlopen(req, timeout=120) as response:
        payload = response.read()
    destination.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    size_match = len(payload) == int(pin["size"])
    sha_match = sha == expected_sha
    return {
        "asset_id": asset_id,
        "bytes": len(payload),
        "expected_bytes": int(pin["size"]),
        "sha256": sha,
        "expected_sha256": expected_sha,
        "size_match": size_match,
        "sha256_match": sha_match,
        "custody_verified": size_match and sha_match,
    }


def factor_status_template() -> dict[str, Any]:
    return {name: {"valid_side_rows": 0, "invalid_or_zero_denominator_rows": 0} for name in FORMULAS}


def audit_pair(rows: list[dict[str, Any]], factor_counts: dict[str, dict[str, int]]) -> tuple[bool, int]:
    if len(rows) != 2:
        return False, 0
    a, b = rows
    aid, bid = norm_id(a.get("team_id")), norm_id(b.get("team_id"))
    aopp, bopp = norm_id(a.get("opponent_team_id")), norm_id(b.get("opponent_team_id"))
    opponent_integrity = bool(aid and bid and aid != bid and aopp == bid and bopp == aid)
    valid_values = 0
    for side, opp in ((a, b), (b, a)):
        fgm = finite(side.get("field_goals_made"))
        fga = finite(side.get("field_goals_attempted"))
        pm3 = finite(side.get("three_point_field_goals_made"))
        pa3 = finite(side.get("three_point_field_goals_attempted"))
        fta = finite(side.get("free_throws_attempted"))
        oreb = finite(side.get("offensive_rebounds"))
        tov = finite(side.get("turnovers"))
        opp_dreb = finite(opp.get("defensive_rebounds"))

        checks = {
            "efg_pct": fgm is not None and pm3 is not None and fga is not None and fga > 0,
            "tov_pct": fga is not None and fta is not None and tov is not None and (fga + 0.44 * fta + tov) > 0,
            "orb_pct": oreb is not None and opp_dreb is not None and (oreb + opp_dreb) > 0,
            "ftr": fta is not None and fga is not None and fga > 0,
            "three_point_attempt_rate": pa3 is not None and fga is not None and fga > 0,
        }
        for name, ok in checks.items():
            if ok:
                factor_counts[name]["valid_side_rows"] += 1
                valid_values += 1
            else:
                factor_counts[name]["invalid_or_zero_denominator_rows"] += 1
    return opponent_integrity, valid_values


def main() -> None:
    pins = json.loads(PINS_PATH.read_text())
    evidence: dict[str, Any] = {
        "name": "WNBA_R3A1_FOUR_FACTORS_CUSTODY_EVIDENCE_V1",
        "branch": "research/wnba-r3-elite-signal-discovery",
        "parent_preregistered_contract": "research/wnba/WNBA_R3_ELITE_SIGNAL_DISCOVERY_CONTRACT.json",
        "audit_scope": "SOURCE_COMPONENT_AND_FORMULA_RECONSTRUCTIBILITY_ONLY",
        "elite_model_scored": False,
        "hit_rate_tested": False,
        "market_data_consumed": False,
        "winner_or_score_columns_projected": False,
        "same_game_values_used_for_prediction": False,
        "component_values_used_only_for_source_coverage_audit": True,
        "projected_columns": PROJECTED_COLUMNS,
        "frozen_formulas_before_model_testing": FORMULAS,
        "seasons": {},
        "factor_totals": factor_status_template(),
        "total_regular_games": 0,
        "total_side_rows": 0,
        "pair_integrity_failures": 0,
        "schema_complete_all_seasons": True,
        "asset_custody_all_verified": True,
        "expected_game_counts_match": True,
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3a1-") as temp_dir:
        root = Path(temp_dir)
        for season in SEASONS:
            pin = pins["frozen_asset_pins"][f"{season}_team_box"]
            path = root / f"team_box_{season}.parquet"
            custody = download_asset(pin, path)
            evidence["asset_custody_all_verified"] &= custody["custody_verified"]

            parquet = pq.ParquetFile(path)
            schema_names = parquet.schema_arrow.names
            missing = [column for column in PROJECTED_COLUMNS if column not in schema_names]
            schema_complete = not missing
            evidence["schema_complete_all_seasons"] &= schema_complete

            season_ev: dict[str, Any] = {
                "asset": custody,
                "schema_columns": schema_names,
                "required_columns_present": schema_complete,
                "missing_required_columns": missing,
                "regular_games": 0,
                "expected_regular_games": EXPECTED_GAMES[season],
                "side_rows": 0,
                "two_sided_games": 0,
                "bad_pair_count": 0,
                "opponent_integrity_failures": 0,
                "factor_counts": factor_status_template(),
            }

            if schema_complete:
                rows = parquet.read(columns=PROJECTED_COLUMNS).to_pylist()
                grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
                for row in rows:
                    if not is_regular(row.get("season_type")):
                        continue
                    game_id = norm_id(row.get("game_id"))
                    if not game_id or game_id in SPECIAL_EVENTS[season]:
                        continue
                    grouped[game_id].append(row)

                season_ev["regular_games"] = len(grouped)
                season_ev["side_rows"] = sum(len(v) for v in grouped.values())
                evidence["total_regular_games"] += len(grouped)
                evidence["total_side_rows"] += season_ev["side_rows"]
                game_count_match = len(grouped) == EXPECTED_GAMES[season]
                evidence["expected_game_counts_match"] &= game_count_match
                season_ev["expected_game_count_match"] = game_count_match

                for game_id, pair in grouped.items():
                    if len(pair) != 2:
                        season_ev["bad_pair_count"] += 1
                        evidence["pair_integrity_failures"] += 1
                        continue
                    season_ev["two_sided_games"] += 1
                    opponent_ok, _ = audit_pair(pair, season_ev["factor_counts"])
                    if not opponent_ok:
                        season_ev["opponent_integrity_failures"] += 1
                        evidence["pair_integrity_failures"] += 1

                for name in FORMULAS:
                    evidence["factor_totals"][name]["valid_side_rows"] += season_ev["factor_counts"][name]["valid_side_rows"]
                    evidence["factor_totals"][name]["invalid_or_zero_denominator_rows"] += season_ev["factor_counts"][name]["invalid_or_zero_denominator_rows"]

            evidence["seasons"][str(season)] = season_ev

    expected_total_games = sum(EXPECTED_GAMES.values())
    expected_side_rows = expected_total_games * 2
    exact_components = (
        evidence["asset_custody_all_verified"]
        and evidence["schema_complete_all_seasons"]
        and evidence["expected_game_counts_match"]
        and evidence["pair_integrity_failures"] == 0
        and evidence["total_regular_games"] == expected_total_games
        and evidence["total_side_rows"] == expected_side_rows
        and all(
            evidence["factor_totals"][name]["valid_side_rows"] == expected_side_rows
            and evidence["factor_totals"][name]["invalid_or_zero_denominator_rows"] == 0
            for name in FORMULAS
        )
    )

    evidence["expected_total_regular_games"] = expected_total_games
    evidence["expected_total_side_rows"] = expected_side_rows
    evidence["four_factors_source_decision"] = (
        "EXACT_COMPONENTS_AVAILABLE_FOR_PREFIX_RECONSTRUCTION"
        if exact_components
        else "PARTIAL_OR_BLOCKED_COMPONENT_CUSTODY"
    )
    evidence["shot_profile_source_decision"] = (
        "EXACT_3PAR_EFG_FTR_COMPONENTS_AVAILABLE_FOR_PREFIX_RECONSTRUCTION"
        if exact_components
        else "PARTIAL_OR_BLOCKED_SHOT_PROFILE_COMPONENT_CUSTODY"
    )
    evidence["prefix_timing_certified_here"] = False
    evidence["next_gate"] = (
        "R3A2_STRICT_PRIOR_DATE_PREFIX_FEATURE_CONSTRUCTOR"
        if exact_components
        else "R3A1_COMPONENT_GAP_RESOLUTION_BEFORE_PREFIX_CONSTRUCTION"
    )
    evidence["scientific_note"] = (
        "This audit establishes only whether exact completed-game component statistics exist and are internally usable. "
        "R3A2 must separately prove that every target-game feature is constructed strictly from finalized prior official dates."
    )

    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "decision": evidence["four_factors_source_decision"],
        "games": evidence["total_regular_games"],
        "side_rows": evidence["total_side_rows"],
        "next_gate": evidence["next_gate"],
    }, indent=2))

    if not evidence["asset_custody_all_verified"]:
        raise SystemExit("Frozen asset custody verification failed")


if __name__ == "__main__":
    main()
