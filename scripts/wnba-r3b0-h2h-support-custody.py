#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT_PATH = Path("research/wnba/WNBA_R3B0_H2H_SUPPORT_CUSTODY_CONTRACT.json")
OUT_PATH = Path("wnba-r3b0-h2h-support-custody-evidence.json")
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"

TEAM_IDENTITY = ["game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id"]
STAT_FIELDS = [
    "field_goals_made",
    "field_goals_attempted",
    "three_point_field_goals_made",
    "three_point_field_goals_attempted",
    "free_throws_attempted",
    "offensive_rebounds",
    "defensive_rebounds",
    "turnovers",
]
SCHEDULE_FIELDS = ["game_id", "season", "season_type", "game_date_time", "game_date", "home_id", "away_id", "team_box", "time_valid"]


def headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3B0/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as response:
        return response.read()


def verify_download(spec: dict[str, Any], dst: Path) -> dict[str, Any]:
    asset_id = int(spec["asset_id"])
    meta = json.loads(get_bytes(ASSET_API.format(asset_id=asset_id), "application/vnd.github+json").decode())
    payload = get_bytes(ASSET_API.format(asset_id=asset_id), "application/octet-stream")
    dst.write_bytes(payload)
    actual_sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(spec["expected_sha256"]).removeprefix("sha256:")
    expected_size = int(spec["size"])
    ok = (
        int(meta.get("id", -1)) == asset_id
        and str(meta.get("name", "")) == str(spec["name"])
        and len(payload) == expected_size
        and actual_sha == expected_sha
    )
    return {
        "asset_id": asset_id,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": actual_sha,
        "expected_bytes": expected_size,
        "expected_sha256": expected_sha,
        "custody_verified": ok,
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


def finite(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def formula_valid(row: dict[str, Any], opp: dict[str, Any]) -> dict[str, bool]:
    fgm = finite(row.get("field_goals_made"))
    fga = finite(row.get("field_goals_attempted"))
    p3m = finite(row.get("three_point_field_goals_made"))
    p3a = finite(row.get("three_point_field_goals_attempted"))
    fta = finite(row.get("free_throws_attempted"))
    oreb = finite(row.get("offensive_rebounds"))
    opp_dreb = finite(opp.get("defensive_rebounds"))
    tov = finite(row.get("turnovers"))
    return {
        "eFG_pct": fgm is not None and p3m is not None and fga is not None and fga > 0,
        "TOV_pct": tov is not None and fga is not None and fta is not None and (fga + 0.44 * fta + tov) > 0,
        "ORB_pct": oreb is not None and opp_dreb is not None and (oreb + opp_dreb) > 0,
        "FTr": fta is not None and fga is not None and fga > 0,
        "three_point_attempt_rate": p3a is not None and fga is not None and fga > 0,
    }


def main() -> None:
    contract = json.loads(CONTRACT_PATH.read_text())
    specs = contract["frozen_support_assets_from_release_metadata"]
    evidence: dict[str, Any] = {
        "name": "WNBA_R3B0_H2H_SUPPORT_CUSTODY_EVIDENCE_V1",
        "contract": str(CONTRACT_PATH),
        "target_outcome_values_loaded": False,
        "market_data_loaded": False,
        "assets": {},
        "seasons": {},
        "hard_failures": [],
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3b0-") as td:
        root = Path(td)
        schedule_path = root / "schedule.parquet"
        schedule_ev = verify_download(specs["schedule_master"], schedule_path)
        evidence["assets"]["schedule_master"] = schedule_ev
        if not schedule_ev["custody_verified"]:
            evidence["hard_failures"].append("schedule_master custody mismatch")

        team_paths: dict[int, Path] = {}
        for season in (2019, 2020):
            key = f"{season}_team_box"
            path = root / f"team_box_{season}.parquet"
            ev = verify_download(specs[key], path)
            evidence["assets"][key] = ev
            team_paths[season] = path
            if not ev["custody_verified"]:
                evidence["hard_failures"].append(f"{key} custody mismatch")

        if evidence["hard_failures"]:
            OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            raise SystemExit(2)

        schedule_schema = pq.ParquetFile(schedule_path).schema_arrow
        missing_sched = [c for c in SCHEDULE_FIELDS if c not in schedule_schema.names]
        if missing_sched:
            evidence["hard_failures"].append(f"schedule missing fields: {missing_sched}")
            schedule_rows: list[dict[str, Any]] = []
        else:
            schedule_rows = pq.read_table(schedule_path, columns=SCHEDULE_FIELDS).to_pylist()

        schedule_by_season_game: dict[tuple[int, str], dict[str, Any]] = {}
        schedule_type_counts: dict[int, Counter[str]] = {2019: Counter(), 2020: Counter()}
        schedule_regular_counts: dict[int, int] = {2019: 0, 2020: 0}
        schedule_valid_date_counts: dict[int, int] = {2019: 0, 2020: 0}
        for row in schedule_rows:
            try:
                season = int(row.get("season"))
            except (TypeError, ValueError):
                continue
            if season not in (2019, 2020):
                continue
            schedule_type_counts[season][str(row.get("season_type"))] += 1
            if not regular(row.get("season_type")):
                continue
            gid = norm_id(row.get("game_id"))
            if not gid:
                continue
            schedule_regular_counts[season] += 1
            if parse_date(row.get("game_date_time"), row.get("game_date")) is not None:
                schedule_valid_date_counts[season] += 1
            schedule_by_season_game[(season, gid)] = row

        for season in (2019, 2020):
            path = team_paths[season]
            pf = pq.ParquetFile(path)
            schema = pf.schema_arrow
            schema_names = list(schema.names)
            missing_identity = [c for c in TEAM_IDENTITY if c not in schema_names]
            missing_stats = [c for c in STAT_FIELDS if c not in schema_names]
            if missing_identity:
                evidence["hard_failures"].append(f"{season} missing identity fields: {missing_identity}")
            if missing_stats:
                evidence["hard_failures"].append(f"{season} missing required feature fields: {missing_stats}")
            if missing_identity or missing_stats:
                evidence["seasons"][str(season)] = {
                    "schema_names": schema_names,
                    "missing_identity_fields": missing_identity,
                    "missing_feature_fields": missing_stats,
                }
                continue

            rows = pq.read_table(path, columns=TEAM_IDENTITY + STAT_FIELDS).to_pylist()
            type_counts = Counter(str(r.get("season_type")) for r in rows)
            regular_rows = [r for r in rows if regular(r.get("season_type"))]
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in regular_rows:
                gid = norm_id(row.get("game_id"))
                if gid:
                    grouped[gid].append(row)

            malformed = {gid: len(sides) for gid, sides in grouped.items() if len(sides) != 2}
            two_sided = {gid: sides for gid, sides in grouped.items() if len(sides) == 2}
            if malformed:
                evidence["hard_failures"].append(f"{season} malformed regular game groups: {len(malformed)}")

            feature_valid = Counter()
            identity_reciprocal_fail = 0
            schedule_joined = 0
            schedule_identity_match = 0
            valid_date_join = 0
            schedule_missing_ids: list[str] = []
            schedule_identity_mismatch_ids: list[str] = []
            team_game_counts = Counter()

            for gid, sides in two_sided.items():
                a, b = sides
                aid, bid = norm_id(a.get("team_id")), norm_id(b.get("team_id"))
                if norm_id(a.get("opponent_team_id")) != bid or norm_id(b.get("opponent_team_id")) != aid:
                    identity_reciprocal_fail += 1
                team_game_counts[aid] += 1
                team_game_counts[bid] += 1

                for row, opp in ((a, b), (b, a)):
                    for name, ok in formula_valid(row, opp).items():
                        if ok:
                            feature_valid[name] += 1

                sched = schedule_by_season_game.get((season, gid))
                if sched is None:
                    schedule_missing_ids.append(gid)
                    continue
                schedule_joined += 1
                home_rows = [r for r in sides if norm_text(r.get("team_home_away")) == "home"]
                away_rows = [r for r in sides if norm_text(r.get("team_home_away")) == "away"]
                if len(home_rows) == 1 and len(away_rows) == 1:
                    home_id = norm_id(home_rows[0].get("team_id"))
                    away_id = norm_id(away_rows[0].get("team_id"))
                    if home_id == norm_id(sched.get("home_id")) and away_id == norm_id(sched.get("away_id")):
                        schedule_identity_match += 1
                    else:
                        schedule_identity_mismatch_ids.append(gid)
                else:
                    schedule_identity_mismatch_ids.append(gid)
                if parse_date(sched.get("game_date_time"), sched.get("game_date")) is not None:
                    valid_date_join += 1

            total_two_sided_rows = 2 * len(two_sided)
            incomplete_features = {
                name: {"valid_rows": int(count), "total_rows": total_two_sided_rows}
                for name, count in feature_valid.items()
                if count != total_two_sided_rows
            }
            if incomplete_features:
                evidence["hard_failures"].append(f"{season} incomplete exact feature coverage: {incomplete_features}")
            if identity_reciprocal_fail:
                evidence["hard_failures"].append(f"{season} reciprocal identity failures: {identity_reciprocal_fail}")
            if schedule_joined != len(two_sided):
                evidence["hard_failures"].append(f"{season} schedule joins {schedule_joined}/{len(two_sided)}")
            if schedule_identity_match != len(two_sided):
                evidence["hard_failures"].append(f"{season} schedule home-away identity matches {schedule_identity_match}/{len(two_sided)}")
            if valid_date_join != len(two_sided):
                evidence["hard_failures"].append(f"{season} valid schedule dates {valid_date_join}/{len(two_sided)}")

            low_frequency_team_ids = sorted([tid for tid, n in team_game_counts.items() if n < 5])
            evidence["seasons"][str(season)] = {
                "parquet_rows_all_season_types": pf.metadata.num_rows,
                "team_box_season_type_row_counts": dict(sorted(type_counts.items())),
                "regular_rows": len(regular_rows),
                "regular_game_groups": len(grouped),
                "two_sided_regular_games": len(two_sided),
                "two_sided_regular_rows": total_two_sided_rows,
                "malformed_regular_groups": len(malformed),
                "reciprocal_identity_failures": identity_reciprocal_fail,
                "schedule_season_type_row_counts": dict(sorted(schedule_type_counts[season].items())),
                "schedule_regular_rows": schedule_regular_counts[season],
                "schedule_regular_rows_with_valid_date": schedule_valid_date_counts[season],
                "schedule_joined_games": schedule_joined,
                "schedule_home_away_identity_matches": schedule_identity_match,
                "schedule_joined_games_with_valid_date": valid_date_join,
                "schedule_missing_game_ids": schedule_missing_ids,
                "schedule_identity_mismatch_game_ids": schedule_identity_mismatch_ids,
                "feature_valid_rows": dict(sorted(feature_valid.items())),
                "feature_total_rows": total_two_sided_rows,
                "team_ids": sorted(team_game_counts),
                "team_game_counts": dict(sorted(team_game_counts.items())),
                "low_frequency_team_ids_lt5_games": low_frequency_team_ids,
                "outcome_columns_visible_as_schema_names_only": [
                    c for c in schema_names if c in {"team_score", "opponent_team_score", "team_winner", "winner", "home_score", "away_score"}
                ],
            }

    pass_audit = len(evidence["hard_failures"]) == 0
    evidence["summary"] = {
        "audit_pass": pass_audit,
        "2019_role": "SUPPORT_ONLY",
        "2020_target_eligible_by_custody": pass_audit,
        "target_outcome_values_loaded": False,
        "market_data_loaded": False,
        "next_gate": "R3B_STRICT_PREFIX_FEATURE_FORGE_2020_2025" if pass_audit else "R3B0_REPAIR_OR_SCOPE_FREEZE",
    }
    OUT_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps(evidence["summary"], indent=2, sort_keys=True))
    for season in (2019, 2020):
        s = evidence["seasons"].get(str(season), {})
        print(json.dumps({
            "season": season,
            "two_sided_regular_games": s.get("two_sided_regular_games"),
            "schedule_joined_games": s.get("schedule_joined_games"),
            "schedule_home_away_identity_matches": s.get("schedule_home_away_identity_matches"),
            "feature_valid_rows": s.get("feature_valid_rows"),
            "low_frequency_team_ids_lt5_games": s.get("low_frequency_team_ids_lt5_games"),
        }, indent=2, sort_keys=True))
    if evidence["hard_failures"]:
        print(json.dumps({"hard_failures": evidence["hard_failures"]}, indent=2))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
