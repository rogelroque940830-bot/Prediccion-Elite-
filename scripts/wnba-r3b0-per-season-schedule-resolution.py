#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT_PATH = Path("research/wnba/WNBA_R3B0_H2H_SUPPORT_CUSTODY_CONTRACT_V3.json")
OUT_PATH = Path("wnba-r3b0-v3-per-season-schedule-evidence.json")
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
TEAM_FIELDS = ["game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id"]
SCHEDULE_REQUIRED = ["game_id", "season_type", "home_id", "away_id"]
SCHEDULE_DATE_CANDIDATES = ["game_date_time", "game_date"]
LOW_FREQ_SPECIAL_TEAMS = {"111719", "112530"}


def headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3B0-V3/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as response:
        return response.read()


def download_asset(spec: dict[str, Any], dst: Path, expected_sha: str | None) -> dict[str, Any]:
    asset_id = int(spec["asset_id"])
    meta = json.loads(get_bytes(ASSET_API.format(asset_id=asset_id), "application/vnd.github+json").decode())
    payload = get_bytes(ASSET_API.format(asset_id=asset_id), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    identity_ok = (
        int(meta.get("id", -1)) == asset_id
        and str(meta.get("name", "")) == str(spec["name"])
        and len(payload) == int(spec["size"])
    )
    sha_ok = True if expected_sha is None else sha == expected_sha.removeprefix("sha256:")
    return {
        "asset_id": asset_id,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": sha,
        "metadata_digest": meta.get("digest"),
        "identity_size_verified": identity_ok,
        "expected_sha256": expected_sha,
        "expected_sha256_verified": sha_ok,
        "custody_verified": identity_ok and sha_ok,
    }


def norm_id(value: Any) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        return s[:-2]
    return s


def norm_text(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def regular(value: Any) -> bool:
    return norm_text(value) in {"regular", "regularseason", "2"}


def parse_date(*values: Any) -> date | None:
    for value in values:
        if value is None:
            continue
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        s = str(value).strip()
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


def exact_home_away(sides: list[dict[str, Any]]) -> tuple[str, str] | None:
    home = [r for r in sides if norm_text(r.get("team_home_away")) == "home"]
    away = [r for r in sides if norm_text(r.get("team_home_away")) == "away"]
    if len(home) != 1 or len(away) != 1:
        return None
    return norm_id(home[0].get("team_id")), norm_id(away[0].get("team_id"))


def main() -> None:
    contract = json.loads(CONTRACT_PATH.read_text())
    assets = contract["frozen_assets"]
    evidence: dict[str, Any] = {
        "name": "WNBA_R3B0_V3_PER_SEASON_SCHEDULE_RESOLUTION_EVIDENCE_V1",
        "contract": str(CONTRACT_PATH),
        "target_outcome_values_loaded": False,
        "score_winner_columns_projected": False,
        "market_data_loaded": False,
        "performance_metrics_computed": False,
        "assets": {},
        "seasons": {},
        "hard_failures": [],
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3b0-v3-") as td:
        root = Path(td)
        paths: dict[str, Path] = {}
        for key in ("2019_team_box", "2020_team_box", "2019_schedule", "2020_schedule"):
            spec = assets[key]
            path = root / spec["name"]
            expected_sha = spec.get("sha256")
            ev = download_asset(spec, path, expected_sha)
            evidence["assets"][key] = ev
            paths[key] = path
            if not ev["custody_verified"]:
                evidence["hard_failures"].append(f"{key}: asset id/name/size/hash custody failure")

        if evidence["hard_failures"]:
            OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            raise SystemExit(2)

        team_games_by_year: dict[int, dict[str, list[dict[str, Any]]]] = {}
        for season in (2019, 2020):
            path = paths[f"{season}_team_box"]
            schema = pq.ParquetFile(path).schema_arrow
            missing = [c for c in TEAM_FIELDS if c not in schema.names]
            if missing:
                evidence["hard_failures"].append(f"{season} team_box missing allowlisted identity fields: {missing}")
                continue
            rows = pq.read_table(path, columns=TEAM_FIELDS).to_pylist()
            regular_rows = [r for r in rows if regular(r.get("season_type"))]
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in regular_rows:
                gid = norm_id(row.get("game_id"))
                if gid:
                    grouped[gid].append(row)
            malformed = {gid: len(sides) for gid, sides in grouped.items() if len(sides) != 2}
            if malformed:
                evidence["hard_failures"].append(f"{season} malformed two-sided type-2 groups: {malformed}")
            team_games_by_year[season] = {gid: sides for gid, sides in grouped.items() if len(sides) == 2}

        if evidence["hard_failures"]:
            OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            raise SystemExit(2)

        # Identity-only 2019 special-event classification; no score/winner fields exist in memory.
        special_candidates: list[str] = []
        for gid, sides in team_games_by_year[2019].items():
            team_ids = {norm_id(r.get("team_id")) for r in sides}
            if team_ids == LOW_FREQ_SPECIAL_TEAMS:
                special_candidates.append(gid)
        if len(special_candidates) != 1:
            evidence["hard_failures"].append(
                f"2019 identity-only special-event rule expected exactly one 111719-vs-112530 game, found {special_candidates}"
            )
            special_id = None
        else:
            special_id = special_candidates[0]

        franchise_2019 = {
            gid: sides for gid, sides in team_games_by_year[2019].items()
            if gid != special_id
        }
        franchise_2020 = dict(team_games_by_year[2020])

        def team_counts(games: dict[str, list[dict[str, Any]]]) -> Counter[str]:
            counts: Counter[str] = Counter()
            for sides in games.values():
                for row in sides:
                    counts[norm_id(row.get("team_id"))] += 1
            return counts

        counts_2019 = team_counts(franchise_2019)
        counts_2020 = team_counts(franchise_2020)
        if len(franchise_2019) != 204 or len(counts_2019) != 12 or set(counts_2019.values()) != {34}:
            evidence["hard_failures"].append(
                f"2019 franchise identity closure failed: games={len(franchise_2019)}, teams={len(counts_2019)}, counts={dict(sorted(counts_2019.items()))}"
            )
        if len(franchise_2020) != 132 or len(counts_2020) != 12 or set(counts_2020.values()) != {22}:
            evidence["hard_failures"].append(
                f"2020 franchise identity closure failed: games={len(franchise_2020)}, teams={len(counts_2020)}, counts={dict(sorted(counts_2020.items()))}"
            )

        for season, games in ((2019, franchise_2019), (2020, franchise_2020)):
            schedule_path = paths[f"{season}_schedule"]
            pf = pq.ParquetFile(schedule_path)
            schema_names = list(pf.schema_arrow.names)
            missing_required = [c for c in SCHEDULE_REQUIRED if c not in schema_names]
            date_fields = [c for c in SCHEDULE_DATE_CANDIDATES if c in schema_names]
            if missing_required:
                evidence["hard_failures"].append(f"{season} schedule missing required fields: {missing_required}")
                continue
            if not date_fields:
                evidence["hard_failures"].append(f"{season} schedule has no allowlisted date field")
                continue

            projected = SCHEDULE_REQUIRED + date_fields
            if "season" in schema_names:
                projected.append("season")
            schedule_rows = pq.read_table(schedule_path, columns=projected).to_pylist()
            by_gid: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in schedule_rows:
                gid = norm_id(row.get("game_id"))
                if gid:
                    by_gid[gid].append(row)

            joined = 0
            exact_identity = 0
            valid_date = 0
            duplicate_schedule_ids: list[str] = []
            missing_ids: list[str] = []
            identity_mismatch_ids: list[str] = []
            invalid_date_ids: list[str] = []
            matched_season_type_counts: Counter[str] = Counter()

            for gid, sides in sorted(games.items()):
                matches = by_gid.get(gid, [])
                if len(matches) == 0:
                    missing_ids.append(gid)
                    continue
                if len(matches) != 1:
                    duplicate_schedule_ids.append(gid)
                    continue
                sched = matches[0]
                joined += 1
                matched_season_type_counts[str(sched.get("season_type"))] += 1
                team_identity = exact_home_away(sides)
                if team_identity is None:
                    identity_mismatch_ids.append(gid)
                else:
                    home_id, away_id = team_identity
                    if home_id == norm_id(sched.get("home_id")) and away_id == norm_id(sched.get("away_id")):
                        exact_identity += 1
                    else:
                        identity_mismatch_ids.append(gid)
                if parse_date(*(sched.get(field) for field in date_fields)) is not None:
                    valid_date += 1
                else:
                    invalid_date_ids.append(gid)

            expected = 204 if season == 2019 else 132
            if joined != expected:
                evidence["hard_failures"].append(f"{season} per-season schedule joins {joined}/{expected}")
            if exact_identity != expected:
                evidence["hard_failures"].append(f"{season} exact home-away identity {exact_identity}/{expected}")
            if valid_date != expected:
                evidence["hard_failures"].append(f"{season} valid chronology dates {valid_date}/{expected}")
            if duplicate_schedule_ids:
                evidence["hard_failures"].append(f"{season} duplicate schedule game ids: {duplicate_schedule_ids}")

            evidence["seasons"][str(season)] = {
                "team_box_type2_games_before_special_rule": len(team_games_by_year[season]),
                "identity_only_special_event_game_id": special_id if season == 2019 else None,
                "franchise_games_after_frozen_special_rule": len(games),
                "franchise_team_game_counts": dict(sorted((counts_2019 if season == 2019 else counts_2020).items())),
                "schedule_parquet_rows": pf.metadata.num_rows,
                "schedule_schema_names": schema_names,
                "schedule_projected_fields": projected,
                "schedule_joined_franchise_games": joined,
                "schedule_exact_home_away_matches": exact_identity,
                "schedule_valid_date_games": valid_date,
                "matched_schedule_season_type_counts": dict(sorted(matched_season_type_counts.items())),
                "missing_franchise_game_ids": missing_ids,
                "duplicate_schedule_game_ids": duplicate_schedule_ids,
                "identity_mismatch_game_ids": identity_mismatch_ids,
                "invalid_date_game_ids": invalid_date_ids,
            }

        # Diagnose exactly the three V2 aggregate misses without using scores/winners.
        v2_missing = {
            2019: ["401105109", "401156333"],
            2020: ["401241311"],
        }
        diagnosis: dict[str, Any] = {}
        for season, ids in v2_missing.items():
            schedule_path = paths[f"{season}_schedule"]
            schema_names = list(pq.ParquetFile(schedule_path).schema_arrow.names)
            cols = [c for c in ["game_id", "season_type", "game_date", "game_date_time", "home_id", "away_id"] if c in schema_names]
            rows = pq.read_table(schedule_path, columns=cols).to_pylist()
            map_rows = {norm_id(r.get("game_id")): r for r in rows if norm_id(r.get("game_id")) in ids}
            diagnosis[str(season)] = {
                gid: {
                    "present_in_per_season_schedule": gid in map_rows,
                    "is_identity_only_special_event": (season == 2019 and gid == special_id),
                    "schedule_identity": ({
                        "season_type": map_rows[gid].get("season_type"),
                        "home_id": norm_id(map_rows[gid].get("home_id")),
                        "away_id": norm_id(map_rows[gid].get("away_id")),
                        "date_valid": parse_date(map_rows[gid].get("game_date_time"), map_rows[gid].get("game_date")) is not None,
                    } if gid in map_rows else None),
                }
                for gid in ids
            }
        evidence["v2_missing_id_diagnosis"] = diagnosis

    passed = len(evidence["hard_failures"]) == 0
    evidence["summary"] = {
        "audit_pass": passed,
        "2019_special_event_id": special_id,
        "2019_franchise_games_certified": 204 if passed else None,
        "2020_franchise_games_certified": 132 if passed else None,
        "per_season_schedule_sha256_ready_to_freeze": passed,
        "target_outcome_values_loaded": False,
        "market_data_loaded": False,
        "next_gate": "R3B0_V3_CERTIFICATION_THEN_R3B_STRICT_PREFIX_FEATURE_FORGE" if passed else "R3B0_V3_REPAIR",
    }
    OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps(evidence["summary"], indent=2, sort_keys=True))
    print(json.dumps(evidence["v2_missing_id_diagnosis"], indent=2, sort_keys=True))
    if evidence["hard_failures"]:
        print(json.dumps({"hard_failures": evidence["hard_failures"]}, indent=2, sort_keys=True))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
