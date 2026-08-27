#!/usr/bin/env python3
"""R1A.4 outcome-blind audit of pinned static WNBA historical datasets.

This script audits source custody, schema and non-outcome structural coverage only.
It NEVER projects target-game score/winner/linescore values.  The Parquet schema may
be inspected to prove fields exist, but values are read only from explicit allowlists
frozen in the R1A.4 contract.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT_PATH = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_AUDIT.json")
OUTPUT_PATH = Path("wnba-r1a4-static-dataset-audit-evidence.json")
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)


def headers(accept: str) -> dict[str, str]:
    out = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R1A4/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        out["Authorization"] = f"Bearer {token}"
    return out


def request_bytes(url: str, accept: str, timeout: int = 45) -> bytes:
    req = Request(url, headers=headers(accept))
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def asset_metadata(asset_id: int) -> dict[str, Any]:
    raw = request_bytes(ASSET_API.format(asset_id=asset_id), "application/vnd.github+json")
    obj = json.loads(raw.decode("utf-8"))
    return {
        "id": obj.get("id"),
        "name": obj.get("name"),
        "size": obj.get("size"),
        "digest": obj.get("digest"),
        "created_at": obj.get("created_at"),
        "updated_at": obj.get("updated_at"),
    }


def download_asset(asset_id: int, destination: Path) -> dict[str, Any]:
    url = ASSET_API.format(asset_id=asset_id)
    started = time.time()
    payload = request_bytes(url, "application/octet-stream", timeout=90)
    destination.write_bytes(payload)
    return {
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "elapsed_ms": round((time.time() - started) * 1000),
    }


def normalized_expected_sha(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower().removeprefix("sha256:")


def verify_asset(pin: dict[str, Any], destination: Path) -> dict[str, Any]:
    asset_id = int(pin["asset_id"])
    result: dict[str, Any] = {
        "asset_id": asset_id,
        "expected_name": pin["name"],
        "expected_size": int(pin["size"]),
        "expected_sha256": normalized_expected_sha(pin.get("sha256")),
    }
    try:
        meta = asset_metadata(asset_id)
        result["metadata"] = meta
        result["metadata_name_match"] = meta.get("name") == pin["name"]
        result["metadata_size_match"] = int(meta.get("size") or -1) == int(pin["size"])
        got = download_asset(asset_id, destination)
        result.update(got)
        result["download_size_match"] = got["bytes"] == int(pin["size"])
        expected = result["expected_sha256"]
        result["sha256_match"] = None if expected is None else got["sha256"] == expected
        result["custody_verified"] = bool(
            result["metadata_name_match"]
            and result["metadata_size_match"]
            and result["download_size_match"]
            and (result["sha256_match"] is True if expected is not None else True)
        )
        return result
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["custody_verified"] = False
        return result


def schema_audit(path: Path, allowed: list[str], forbidden: set[str]) -> dict[str, Any]:
    parquet = pq.ParquetFile(path)
    names = parquet.schema_arrow.names
    missing_allowed = [col for col in allowed if col not in names]
    return {
        "schema_column_count": len(names),
        "allowed_columns_required": allowed,
        "allowed_columns_missing": missing_allowed,
        "forbidden_columns_present_in_schema": sorted(forbidden.intersection(names)),
        "forbidden_values_loaded": False,
        "projected_columns": allowed,
        "schema_pass": not missing_allowed,
    }


def safe_rows(path: Path, columns: list[str]) -> list[dict[str, Any]]:
    # This is the anti-leakage chokepoint: only contract-allowlisted columns reach memory.
    return pq.read_table(path, columns=columns).to_pylist()


def normalize_gid(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    return text


def main() -> None:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    forbidden = set(contract["forbidden_target_outcome_columns"])
    schedule_cols = list(contract["allowed_schedule_columns"])
    team_cols = list(contract["allowed_team_box_columns"])

    # Defensive assertion: a contract edit can never accidentally authorize an outcome field.
    overlap = forbidden.intersection(schedule_cols + team_cols)
    if overlap:
        raise SystemExit(f"ANTI_LEAKAGE_CONTRACT_VIOLATION: forbidden columns allowlisted: {sorted(overlap)}")

    evidence: dict[str, Any] = {
        "name": "WNBA_R1A4_STATIC_VERSIONED_DATASET_AUDIT_EVIDENCE_V1",
        "outcome_blind": True,
        "target_outcomes_opened": False,
        "forbidden_outcome_values_loaded": False,
        "source_repo": "sportsdataverse/sportsdataverse-data",
        "seasons": list(SEASONS),
        "assets": {},
        "season_audit": {},
        "advanced_asof": {
            "certified": False,
            "reason": "Published game-level team_box lacks off/def/net rating, pace and possessions; published WNBA Stats team_season_stats is season-level and no dated historical as-of snapshots were certified in R1A.4.",
            "production_exact_equivalence_claimed": False,
        },
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r1a4-") as tmp:
        root = Path(tmp)

        schedule_pin = contract["pinned_assets"]["schedule_master"]
        schedule_path = root / schedule_pin["name"]
        schedule_asset = verify_asset(schedule_pin, schedule_path)
        evidence["assets"]["schedule_master"] = schedule_asset
        if schedule_path.exists() and schedule_asset.get("custody_verified"):
            schedule_asset["schema"] = schema_audit(schedule_path, schedule_cols, forbidden)
            schedule = safe_rows(schedule_path, schedule_cols) if schedule_asset["schema"]["schema_pass"] else []
        else:
            schedule = []

        schedule_by_season: dict[int, set[str]] = {s: set() for s in SEASONS}
        schedule_team_box_by_season: dict[int, set[str]] = {s: set() for s in SEASONS}
        schedule_missing_identity: dict[int, int] = {s: 0 for s in SEASONS}
        for row in schedule:
            try:
                season = int(row.get("season"))
            except (TypeError, ValueError):
                continue
            if season not in schedule_by_season:
                continue
            gid = normalize_gid(row.get("game_id"))
            home = row.get("home_id")
            away = row.get("away_id")
            dt = row.get("game_date_time") or row.get("game_date")
            if not gid or home is None or away is None or dt is None:
                schedule_missing_identity[season] += 1
                continue
            schedule_by_season[season].add(gid)
            if row.get("team_box") is True:
                schedule_team_box_by_season[season].add(gid)

        team_pins = contract["pinned_assets"]["team_box_by_season"]
        all_structural_pass = True
        all_known_digest_pass = True
        all_asset_access_pass = bool(schedule_asset.get("custody_verified"))
        unknown_digest_seasons: list[int] = []

        for season in SEASONS:
            pin = team_pins[str(season)]
            path = root / pin["name"]
            asset = verify_asset(pin, path)
            evidence["assets"][f"team_box_{season}"] = asset
            all_asset_access_pass = all_asset_access_pass and bool(asset.get("custody_verified"))
            if asset.get("expected_sha256") is None:
                unknown_digest_seasons.append(season)
            elif asset.get("sha256_match") is not True:
                all_known_digest_pass = False

            rows: list[dict[str, Any]] = []
            if path.exists() and asset.get("custody_verified"):
                asset["schema"] = schema_audit(path, team_cols, forbidden)
                if asset["schema"]["schema_pass"]:
                    rows = safe_rows(path, team_cols)

            gids: list[str] = []
            missing_identity = 0
            for row in rows:
                gid = normalize_gid(row.get("game_id"))
                team = row.get("team_id")
                opponent = row.get("opponent_team_id")
                side = str(row.get("team_home_away") or "").lower()
                if not gid or team is None or opponent is None or side not in {"home", "away"}:
                    missing_identity += 1
                    continue
                gids.append(gid)

            counts = Counter(gids)
            unique_games = set(gids)
            exactly_two = sum(1 for count in counts.values() if count == 2)
            bad_side_count = sorted(gid for gid, count in counts.items() if count != 2)[:20]
            schedule_games = schedule_by_season[season]
            joined = unique_games.intersection(schedule_games)
            join_rate = (len(joined) / len(unique_games)) if unique_games else 0.0
            schedule_flagged = schedule_team_box_by_season[season]
            flagged_overlap = len(unique_games.intersection(schedule_flagged))

            structural_pass = bool(
                asset.get("custody_verified")
                and asset.get("schema", {}).get("schema_pass")
                and len(unique_games) >= 100
                and missing_identity == 0
                and exactly_two == len(unique_games)
                and join_rate >= 0.99
                and schedule_missing_identity[season] == 0
            )
            all_structural_pass = all_structural_pass and structural_pass

            evidence["season_audit"][str(season)] = {
                "team_box_rows_projected": len(rows),
                "team_box_unique_games": len(unique_games),
                "games_with_exactly_two_team_rows": exactly_two,
                "bad_two_side_game_ids_sample": bad_side_count,
                "team_box_missing_identity_rows": missing_identity,
                "schedule_unique_games": len(schedule_games),
                "schedule_team_box_flagged_games": len(schedule_flagged),
                "team_box_games_joined_to_schedule": len(joined),
                "team_box_to_schedule_join_rate": round(join_rate, 6),
                "team_box_games_matching_schedule_team_box_flag": flagged_overlap,
                "schedule_missing_identity_rows": schedule_missing_identity[season],
                "structural_pass": structural_pass,
            }

        schedule_schema_pass = bool(schedule_asset.get("schema", {}).get("schema_pass"))
        schedule_season_pass = all(len(schedule_by_season[s]) >= 100 for s in SEASONS)
        all_structural_pass = all_structural_pass and schedule_schema_pass and schedule_season_pass

        known_schedule_sha_pass = schedule_asset.get("sha256_match") is True
        all_known_digest_pass = all_known_digest_pass and known_schedule_sha_pass

        digest_freeze_pending = bool(unknown_digest_seasons)
        game_level_evidence_pass = bool(
            all_asset_access_pass and all_known_digest_pass and all_structural_pass
        )

        if not game_level_evidence_pass:
            decision = "NOT_CERTIFIED"
        elif digest_freeze_pending:
            decision = "EVIDENCE_READY_REQUIRES_2023_DIGEST_FREEZE"
        else:
            decision = "PARTIAL_CERTIFIED_GAME_LEVEL_STATIC_SOURCE_ADVANCED_ASOF_UNRESOLVED"

        evidence["gate"] = {
            "asset_access_pass": all_asset_access_pass,
            "known_frozen_digests_pass": all_known_digest_pass,
            "structural_game_level_pass": all_structural_pass,
            "unknown_digest_seasons_requiring_freeze": unknown_digest_seasons,
            "game_level_static_evidence_pass": game_level_evidence_pass,
            "decision": decision,
            "full_sports_only_v1_reconstruction_certified": False,
            "r1b_outcome_opening_authorized": False,
            "next_gate": "R1A4B_ADVANCED_ASOF_SEMANTICS_CERTIFICATION" if game_level_evidence_pass else "R1A4_STATIC_SOURCE_REPAIR",
        }

    OUTPUT_PATH.write_text(json.dumps(evidence, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2, default=str))


if __name__ == "__main__":
    main()
