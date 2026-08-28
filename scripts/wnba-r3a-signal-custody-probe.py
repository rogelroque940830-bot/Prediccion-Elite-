#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

PINS = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
AUDIT = Path("research/wnba/WNBA_R3A_SIGNAL_CUSTODY_AUDIT.json")
OUT = Path("wnba-r3a-signal-custody-probe-evidence.json")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)


def headers(accept: str) -> dict[str, str]:
    out = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3A/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        out["Authorization"] = f"Bearer {token}"
    return out


def get_bytes(url: str, accept: str, timeout: int = 90) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as resp:
        return resp.read()


def download_and_verify(pin: dict[str, Any], dst: Path) -> dict[str, Any]:
    asset_id = int(pin["asset_id"])
    meta = json.loads(get_bytes(API.format(asset_id=asset_id), "application/vnd.github+json").decode("utf-8"))
    payload = get_bytes(API.format(asset_id=asset_id), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    expected_name = pin.get("name") or meta.get("name")
    ok = (
        int(meta.get("id", -1)) == asset_id
        and meta.get("name") == expected_name
        and len(payload) == int(pin["size"])
        and sha == expected_sha
    )
    return {
        "asset_id": asset_id,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": sha,
        "expected_sha256": expected_sha,
        "custody_verified": ok,
    }


def schema_only(path: Path) -> dict[str, Any]:
    pf = pq.ParquetFile(path)
    names = list(pf.schema_arrow.names)
    return {
        "column_count": len(names),
        "columns": names,
        "metadata_row_count": pf.metadata.num_rows,
        "values_projected": False,
    }


def requirements_status(names: set[str], req: Any) -> Any:
    if isinstance(req, list):
        missing = [x for x in req if x not in names]
        return {"required": req, "missing": missing, "ready": not missing}
    if isinstance(req, dict):
        return {k: requirements_status(names, v) for k, v in req.items()}
    raise TypeError(type(req))


def main() -> None:
    pins = json.loads(PINS.read_text())
    audit = json.loads(AUDIT.read_text())
    evidence: dict[str, Any] = {
        "name": "WNBA_R3A_SIGNAL_CUSTODY_SCHEMA_PROBE_EVIDENCE_V1",
        "outcome_blind": True,
        "target_outcome_values_loaded": False,
        "parquet_values_projected": False,
        "production_mutation": False,
        "assets": {},
        "team_box_seasons": {},
        "cross_season": {},
        "schedule": {},
        "classification": {},
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3a-") as td:
        root = Path(td)

        schedule_pin = dict(pins["frozen_asset_pins"]["schedule_master"])
        schedule_path = root / "schedule.parquet"
        sev = download_and_verify(schedule_pin, schedule_path)
        evidence["assets"]["schedule_master"] = sev
        if not sev["custody_verified"]:
            raise SystemExit("schedule custody mismatch")
        s_schema = schema_only(schedule_path)
        s_names = set(s_schema["columns"])
        hints = audit["schedule_schema_hints_for_travel_v2"]
        matched_hints = sorted([c for c in s_names if any(h in c.lower() for h in hints)])
        evidence["schedule"] = {
            **s_schema,
            "travel_location_columns_matching_hints": matched_hints,
            "actual_venue_sequence_schema_candidate": bool(matched_hints),
        }

        common: set[str] | None = None
        union: set[str] = set()
        all_custody = True
        all_four_factor_ready = True
        all_shot_ready = True
        all_quality_ready = True
        all_h2h_ready = True
        year_column_sets: dict[int, set[str]] = {}

        for year in SEASONS:
            pin = dict(pins["frozen_asset_pins"][f"{year}_team_box"])
            # Older certification omitted name for some season pins; frozen filename is deterministic.
            pin.setdefault("name", f"team_box_{year}.parquet")
            path = root / f"team_box_{year}.parquet"
            ev = download_and_verify(pin, path)
            evidence["assets"][f"team_box_{year}"] = ev
            all_custody &= bool(ev["custody_verified"])
            if not ev["custody_verified"]:
                continue
            sch = schema_only(path)
            names = set(sch["columns"])
            year_column_sets[year] = names
            union |= names
            common = names.copy() if common is None else common & names
            req = requirements_status(names, audit["team_box_requirements"])
            four = req["FOUR_FACTORS"]
            four_ready = all(x["ready"] for x in four.values())
            shot_ready = req["SHOT_PROFILE_MATCHUP"]["ready"]
            quality_ready = req["QUALITY_ADJUSTED_FORM_PREFIX"]["ready"]
            h2h_ready = req["H2H_PREFIX"]["ready"]
            all_four_factor_ready &= four_ready
            all_shot_ready &= shot_ready
            all_quality_ready &= quality_ready
            all_h2h_ready &= h2h_ready
            evidence["team_box_seasons"][str(year)] = {
                **sch,
                "requirements": req,
                "four_factors_complete": four_ready,
                "shot_profile_matchup_complete": shot_ready,
                "quality_adjusted_form_prefix_complete": quality_ready,
                "h2h_prefix_complete": h2h_ready,
            }

        if not all_custody:
            raise SystemExit("one or more team-box custody mismatches")

        common = common or set()
        evidence["cross_season"] = {
            "common_columns": sorted(common),
            "union_columns": sorted(union),
            "schema_identical_all_years": len({tuple(sorted(v)) for v in year_column_sets.values()}) == 1,
            "all_five_seasons_custody_verified": all_custody,
        }

        fatigue_core = {"game_date", "team_id", "team_home_away"}.issubset(common)
        evidence["classification"] = {
            "BASE_R2": "READY_HISTORICAL_PREFIX",
            "FOUR_FACTORS": "READY_HISTORICAL_PREFIX" if all_four_factor_ready else "PARTIAL_HISTORICAL_PREFIX",
            "SHOT_PROFILE_MATCHUP": "READY_HISTORICAL_PREFIX" if all_shot_ready else "PARTIAL_HISTORICAL_PREFIX",
            "QUALITY_ADJUSTED_FORM": "READY_HISTORICAL_PREFIX" if all_quality_ready else "PARTIAL_HISTORICAL_PREFIX",
            "H2H_PREFIX": "READY_HISTORICAL_PREFIX" if all_h2h_ready else "PARTIAL_HISTORICAL_PREFIX",
            "FATIGUE_CORE": "READY_HISTORICAL_PREFIX" if fatigue_core else "PARTIAL_HISTORICAL_PREFIX",
            "TRAVEL_V2_ACTUAL_VENUE_SEQUENCE": "PARTIAL_HISTORICAL_PREFIX" if matched_hints else "BLOCKED_SOURCE_CUSTODY",
            "AVAILABILITY_STAR_POWER": "PROSPECTIVE_ONLY",
        }
        evidence["scientific_boundary"] = {
            "schema_presence_is_not_value_quality_certification": True,
            "later_prefix_constructor_required": True,
            "target_row_scores_still_forbidden_in_feature_construction": True,
            "current_or_end_of_season_aggregates_backfilled": False,
            "combination_testing_authorized_by_this_probe": False,
        }

    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "classification": evidence["classification"],
        "schedule_location_hints": evidence["schedule"]["travel_location_columns_matching_hints"],
        "target_outcome_values_loaded": False,
        "evidence": str(OUT),
    }, indent=2))


if __name__ == "__main__":
    main()
