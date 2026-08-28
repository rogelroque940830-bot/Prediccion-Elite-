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
CONTRACT_PATH = Path("research/wnba/WNBA_R3A_SIGNAL_CUSTODY_AUDIT_CONTRACT.json")
OUT_PATH = Path("wnba-r3a-signal-custody-evidence.json")
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)
EXPECTED_REGULAR_GAMES = {2021: 192, 2022: 216, 2023: 240, 2024: 240, 2025: 286}
SPECIAL_IDS = {
    "401341447", "401353913", "401455978", "401430112", "401558893",
    "401507376", "401620458", "401677672", "401781604", "401736430",
}
IDENTITY_FIELDS = ("game_id", "season_type", "team_id", "team_home_away", "opponent_team_id")
FEATURES = {
    "eFG_pct": ("field_goals_made", "three_point_field_goals_made", "field_goals_attempted"),
    "TOV_pct": ("turnovers", "field_goals_attempted", "free_throws_attempted"),
    "ORB_pct": ("offensive_rebounds", "defensive_rebounds"),
    "FTr": ("free_throws_attempted", "field_goals_attempted"),
    "three_point_attempt_rate": ("three_point_field_goals_attempted", "field_goals_attempted"),
}


def headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3A/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as response:
        return response.read()


def norm_id(value: Any) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


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


def verify_download(pin: dict[str, Any], dst: Path) -> dict[str, Any]:
    asset_id = int(pin["asset_id"])
    meta = json.loads(get_bytes(ASSET_API.format(asset_id=asset_id), "application/vnd.github+json").decode())
    payload = get_bytes(ASSET_API.format(asset_id=asset_id), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    expected_size = int(pin["size"])
    ok = int(meta.get("id", -1)) == asset_id and len(payload) == expected_size and sha == expected_sha
    return {
        "asset_id": asset_id,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": sha,
        "expected_bytes": expected_size,
        "expected_sha256": expected_sha,
        "custody_verified": ok,
    }


def valid_formula_row(feature: str, row: dict[str, Any], opponent_row: dict[str, Any] | None) -> bool:
    if feature == "eFG_pct":
        fgm = finite(row.get("field_goals_made"))
        pm3 = finite(row.get("three_point_field_goals_made"))
        fga = finite(row.get("field_goals_attempted"))
        return fgm is not None and pm3 is not None and fga is not None and fga > 0
    if feature == "TOV_pct":
        tov = finite(row.get("turnovers"))
        fga = finite(row.get("field_goals_attempted"))
        fta = finite(row.get("free_throws_attempted"))
        return tov is not None and fga is not None and fta is not None and (fga + 0.44 * fta + tov) > 0
    if feature == "ORB_pct":
        oreb = finite(row.get("offensive_rebounds"))
        opp_dreb = finite((opponent_row or {}).get("defensive_rebounds"))
        return oreb is not None and opp_dreb is not None and (oreb + opp_dreb) > 0
    if feature == "FTr":
        fta = finite(row.get("free_throws_attempted"))
        fga = finite(row.get("field_goals_attempted"))
        return fta is not None and fga is not None and fga > 0
    if feature == "three_point_attempt_rate":
        pa3 = finite(row.get("three_point_field_goals_attempted"))
        fga = finite(row.get("field_goals_attempted"))
        return pa3 is not None and fga is not None and fga > 0
    raise KeyError(feature)


def classification(required_present_all_seasons: bool, valid_rows: int, total_rows: int) -> str:
    if required_present_all_seasons and total_rows > 0 and valid_rows == total_rows:
        return "HISTORICAL_EXACT_RECONSTRUCTIBLE"
    if valid_rows > 0:
        return "HISTORICAL_PARTIAL_OR_PROXY_ONLY"
    return "BLOCKED_EXACT_RECONSTRUCTION"


def main() -> None:
    pins = json.loads(PINS_PATH.read_text())
    contract = json.loads(CONTRACT_PATH.read_text())

    evidence: dict[str, Any] = {
        "name": "WNBA_R3A_SIGNAL_CUSTODY_AUDIT_EVIDENCE_V1",
        "contract": str(CONTRACT_PATH),
        "parent_r3_contract": contract["parent_contract"],
        "performance_labels_used_for_signal_selection": False,
        "target_outcome_values_loaded": False,
        "market_data_loaded": False,
        "feature_formulas_mutated_after_schema_inspection": False,
        "assets": {},
        "seasons": {},
        "feature_custody": {},
        "preclassified_non_schema_signals": contract["preclassified_non_schema_signals"],
        "hard_failures": [],
    }

    all_custody_ok = True
    total_regular_games = 0
    total_regular_rows = 0
    feature_valid_total = defaultdict(int)
    feature_required_present_all = {name: True for name in FEATURES}

    with tempfile.TemporaryDirectory(prefix="wnba-r3a-") as td:
        root = Path(td)
        for season in SEASONS:
            pin = pins["frozen_asset_pins"][f"{season}_team_box"]
            parquet_path = root / f"team_box_{season}.parquet"
            asset_ev = verify_download(pin, parquet_path)
            evidence["assets"][str(season)] = asset_ev
            all_custody_ok = all_custody_ok and bool(asset_ev["custody_verified"])
            if not asset_ev["custody_verified"]:
                evidence["hard_failures"].append(f"{season}: frozen asset custody mismatch")
                continue

            pf = pq.ParquetFile(parquet_path)
            schema = pf.schema_arrow
            schema_names = list(schema.names)
            schema_types = {field.name: str(field.type) for field in schema}

            missing_identity = [f for f in IDENTITY_FIELDS if f not in schema_names]
            if missing_identity:
                evidence["hard_failures"].append(f"{season}: missing identity fields {missing_identity}")
                evidence["seasons"][str(season)] = {
                    "schema_names": schema_names,
                    "schema_types": schema_types,
                    "missing_identity_fields": missing_identity,
                }
                continue

            candidate_stat_fields = sorted({f for fields in FEATURES.values() for f in fields if f != "defensive_rebounds"} | {"defensive_rebounds"})
            projected = list(IDENTITY_FIELDS) + [f for f in candidate_stat_fields if f in schema_names]
            table = pq.read_table(parquet_path, columns=projected)
            rows = table.to_pylist()

            regular_rows = [r for r in rows if is_regular(r.get("season_type")) and norm_id(r.get("game_id")) not in SPECIAL_IDS]
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in regular_rows:
                gid = norm_id(row.get("game_id"))
                if gid:
                    grouped[gid].append(row)
            two_sided = {gid: sides for gid, sides in grouped.items() if len(sides) == 2}
            valid_rows_pool = [row for sides in two_sided.values() for row in sides]

            expected_games = EXPECTED_REGULAR_GAMES[season]
            if len(two_sided) != expected_games:
                evidence["hard_failures"].append(
                    f"{season}: expected {expected_games} two-sided regular games after special-event exclusion, found {len(two_sided)}"
                )

            missing_by_feature: dict[str, list[str]] = {}
            valid_by_feature: dict[str, int] = {}
            total_by_feature: dict[str, int] = {}
            for feature, required in FEATURES.items():
                actual_required = ["defensive_rebounds" if f == "defensive_rebounds" else f for f in required]
                missing = [f for f in actual_required if f not in schema_names]
                missing_by_feature[feature] = missing
                if missing:
                    feature_required_present_all[feature] = False
                    valid_by_feature[feature] = 0
                    total_by_feature[feature] = len(valid_rows_pool)
                    continue

                valid_count = 0
                for gid, sides in two_sided.items():
                    a, b = sides
                    if valid_formula_row(feature, a, b):
                        valid_count += 1
                    if valid_formula_row(feature, b, a):
                        valid_count += 1
                valid_by_feature[feature] = valid_count
                total_by_feature[feature] = len(valid_rows_pool)
                feature_valid_total[feature] += valid_count

            total_regular_games += len(two_sided)
            total_regular_rows += len(valid_rows_pool)
            evidence["seasons"][str(season)] = {
                "schema_names": schema_names,
                "schema_types": schema_types,
                "parquet_rows_all_season_types": pf.metadata.num_rows,
                "regular_rows_after_special_event_exclusion": len(regular_rows),
                "two_sided_regular_games": len(two_sided),
                "expected_two_sided_regular_games": expected_games,
                "two_sided_regular_rows": len(valid_rows_pool),
                "feature_missing_required_fields": missing_by_feature,
                "feature_valid_rows": valid_by_feature,
                "feature_total_rows": total_by_feature,
                "outcome_columns_visible_as_schema_names_only": [
                    c for c in schema_names if c in {
                        "team_score", "opponent_team_score", "team_winner", "winner", "home_score", "away_score"
                    }
                ],
            }

    for feature in FEATURES:
        valid_rows = int(feature_valid_total[feature])
        cls = classification(feature_required_present_all[feature], valid_rows, total_regular_rows)
        evidence["feature_custody"][feature] = {
            "classification": cls,
            "required_fields_present_all_seasons": feature_required_present_all[feature],
            "valid_rows": valid_rows,
            "total_two_sided_regular_rows": total_regular_rows,
            "valid_row_rate": (valid_rows / total_regular_rows) if total_regular_rows else 0.0,
            "frozen_formula": contract["frozen_feature_definitions"][feature]["formula"],
        }

    factor_classes = [evidence["feature_custody"][x]["classification"] for x in ("eFG_pct", "TOV_pct", "ORB_pct", "FTr")]
    shot_classes = [evidence["feature_custody"][x]["classification"] for x in ("eFG_pct", "FTr", "three_point_attempt_rate")]
    evidence["signal_family_summary"] = {
        "FOUR_FACTORS": (
            "HISTORICAL_EXACT_RECONSTRUCTIBLE" if all(x == "HISTORICAL_EXACT_RECONSTRUCTIBLE" for x in factor_classes)
            else "HISTORICAL_PARTIAL_OR_PROXY_ONLY"
        ),
        "SHOT_PROFILE_MATCHUP": (
            "HISTORICAL_EXACT_RECONSTRUCTIBLE" if all(x == "HISTORICAL_EXACT_RECONSTRUCTIBLE" for x in shot_classes)
            else "HISTORICAL_PARTIAL_OR_PROXY_ONLY"
        ),
        "QUALITY_ADJUSTED_FORM": "HISTORICAL_EXACT_RECONSTRUCTIBLE_FROM_STRICT_PRIOR_GAME_PREFIX",
        "H2H_PREFIX": contract["preclassified_non_schema_signals"]["H2H_PREFIX"]["classification"],
        "FATIGUE_CALENDAR": contract["preclassified_non_schema_signals"]["FATIGUE_CALENDAR"]["classification"],
        "TRAVEL_DEPLOYED_STATIC_SEMANTICS": contract["preclassified_non_schema_signals"]["TRAVEL_DEPLOYED_STATIC_SEMANTICS"]["classification"],
        "TRAVEL_ACTUAL_LOCATION_SEQUENCE": contract["preclassified_non_schema_signals"]["TRAVEL_ACTUAL_LOCATION_SEQUENCE"]["classification"],
        "AVAILABILITY_STAR_POWER": contract["preclassified_non_schema_signals"]["AVAILABILITY_STAR_POWER"]["classification"],
    }

    evidence["summary"] = {
        "all_frozen_assets_verified": all_custody_ok,
        "two_sided_regular_games": total_regular_games,
        "expected_two_sided_regular_games": sum(EXPECTED_REGULAR_GAMES.values()),
        "two_sided_regular_rows": total_regular_rows,
        "schema_audit_pass": all_custody_ok and not evidence["hard_failures"],
        "combination_performance_testing_performed": False,
        "next_gate": "R3B_STRICT_PREFIX_FEATURE_FORGE" if all_custody_ok and not evidence["hard_failures"] else "R3A_REPAIR",
    }

    OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps(evidence["summary"], indent=2, sort_keys=True))
    print(json.dumps(evidence["signal_family_summary"], indent=2, sort_keys=True))
    if evidence["hard_failures"]:
        print(json.dumps({"hard_failures": evidence["hard_failures"]}, indent=2))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
