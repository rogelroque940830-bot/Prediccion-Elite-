#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT_PATH = Path("research/wnba/WNBA_R3B1_PER_SEASON_SCHEDULE_RECOVERY_CONTRACT.json")
R1_CERT_PATH = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
OUT = Path("wnba-r3b1-per-season-schedule-recovery-evidence.json")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
SEASONS = (2021, 2022, 2023, 2024, 2025)
TEAM_IDENTITY_COLS = ["game_id", "season", "season_type", "team_id", "team_home_away", "opponent_team_id"]


def headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3B1/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


def norm_id(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        return s[:-2]
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


def download_candidate(spec: dict[str, Any], dst: Path) -> dict[str, Any]:
    aid = int(spec["asset_id"])
    meta = json.loads(get_bytes(API.format(asset_id=aid), "application/vnd.github+json").decode())
    payload = get_bytes(API.format(asset_id=aid), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    provider_expected = spec.get("provider_digest")
    provider_actual = meta.get("digest")
    id_ok = int(meta.get("id", -1)) == aid
    name_ok = str(meta.get("name")) == str(spec["name"])
    size_ok = len(payload) == int(spec["size"]) == int(meta.get("size", -1))
    provider_ok = True
    if provider_expected:
        provider_ok = str(provider_actual) == str(provider_expected) and str(provider_expected).removeprefix("sha256:") == sha
    return {
        "asset_id": aid,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": sha,
        "provider_digest": provider_actual,
        "id_ok": id_ok,
        "name_ok": name_ok,
        "size_ok": size_ok,
        "provider_digest_ok_when_required": provider_ok,
        "custody_ok": id_ok and name_ok and size_ok and provider_ok,
    }


def download_frozen_team_box(spec: dict[str, Any], dst: Path) -> dict[str, Any]:
    aid = int(spec["asset_id"])
    meta = json.loads(get_bytes(API.format(asset_id=aid), "application/vnd.github+json").decode())
    payload = get_bytes(API.format(asset_id=aid), "application/octet-stream")
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected = str(spec["sha256"]).removeprefix("sha256:")
    ok = int(meta.get("id", -1)) == aid and len(payload) == int(spec["size"]) and sha == expected
    return {
        "asset_id": aid,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": sha,
        "expected_sha256": expected,
        "custody_ok": ok,
    }


def schedule_identity(path: Path, season: int, special: set[str], allowlisted: set[str]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    schema = pq.ParquetFile(path).schema_arrow
    schema_names = list(schema.names)
    required = {"game_id", "season_type", "home_id", "away_id"}
    missing = sorted(required - set(schema_names))
    if missing:
        raise RuntimeError(f"{path.name} missing schedule identity columns: {missing}")
    date_cols = [c for c in ("game_date_time", "game_date", "date", "start_date") if c in schema_names]
    if not date_cols:
        raise RuntimeError(f"{path.name} missing chronology column")
    projected = [c for c in schema_names if c in allowlisted]
    rows = pq.read_table(path, columns=projected).to_pylist()
    out: dict[str, dict[str, Any]] = {}
    duplicate = 0
    date_missing = 0
    for r in rows:
        if r.get("season") is not None:
            try:
                if int(r["season"]) != season:
                    continue
            except (TypeError, ValueError):
                continue
        if not regular(r.get("season_type")):
            continue
        gid = norm_id(r.get("game_id"))
        if not gid or gid in special:
            continue
        d = parse_date(*(r.get(c) for c in date_cols))
        if d is None:
            date_missing += 1
            continue
        if gid in out:
            duplicate += 1
            continue
        out[gid] = {
            "game_id": gid,
            "date": d.isoformat(),
            "home_id": norm_id(r.get("home_id")),
            "away_id": norm_id(r.get("away_id")),
        }
    return out, {
        "schema_column_count": len(schema_names),
        "projected_columns": projected,
        "projected_column_count": len(projected),
        "duplicate_regular_game_ids": duplicate,
        "missing_date_regular_rows": date_missing,
    }


def box_identity(path: Path, special: set[str]) -> tuple[dict[str, tuple[str, str]], dict[str, Any]]:
    schema = pq.ParquetFile(path).schema_arrow
    missing = sorted(set(TEAM_IDENTITY_COLS) - set(schema.names))
    if missing:
        raise RuntimeError(f"{path.name} missing team-box identity columns: {missing}")
    rows = pq.read_table(path, columns=TEAM_IDENTITY_COLS).to_pylist()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        if not regular(r.get("season_type")):
            continue
        gid = norm_id(r.get("game_id"))
        if gid and gid not in special:
            grouped[gid].append(r)
    out: dict[str, tuple[str, str]] = {}
    malformed = 0
    for gid, sides in grouped.items():
        if len(sides) != 2:
            malformed += 1
            continue
        sm = {norm_text(r.get("team_home_away")): r for r in sides}
        home, away = sm.get("home"), sm.get("away")
        if not home or not away:
            malformed += 1
            continue
        hid, aid = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
        if norm_id(home.get("opponent_team_id")) != aid or norm_id(away.get("opponent_team_id")) != hid:
            malformed += 1
            continue
        out[gid] = (hid, aid)
    return out, {"two_sided_identity_games": len(out), "malformed_games": malformed}


def main() -> None:
    contract = json.loads(CONTRACT_PATH.read_text())
    r1 = json.loads(R1_CERT_PATH.read_text())
    allowlisted = set(contract["allowlisted_schedule_columns"])
    forbidden = set(contract["forbidden_value_columns"])
    evidence: dict[str, Any] = {
        "name": "WNBA_R3B1_PER_SEASON_SCHEDULE_RECOVERY_EVIDENCE_V1",
        "contract": str(CONTRACT_PATH),
        "outcomes_opened": False,
        "forbidden_value_columns_projected": 0,
        "market_data_loaded": False,
        "injury_data_loaded": False,
        "performance_metrics_computed": False,
        "production_mutation": False,
        "seasons": {},
        "gates": {},
        "hard_failures": [],
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3b1-") as td:
        root = Path(td)
        for season in SEASONS:
            s = str(season)
            sched_spec = contract["candidate_schedule_assets"][s]
            box_spec = r1["frozen_asset_pins"][f"{season}_team_box"]
            sched_path = root / sched_spec["name"]
            box_path = root / f"team_box_{season}.parquet"
            sched_ev = download_candidate(sched_spec, sched_path)
            box_ev = download_frozen_team_box(box_spec, box_path)
            special = set(contract["special_event_ids"][s])
            schedule, schedule_meta = schedule_identity(sched_path, season, special, allowlisted)
            boxes, box_meta = box_identity(box_path, special)
            projected_forbidden = sorted(set(schedule_meta["projected_columns"]) & forbidden)
            evidence["forbidden_value_columns_projected"] += len(projected_forbidden)

            schedule_ids = set(schedule)
            box_ids = set(boxes)
            common = schedule_ids & box_ids
            identity_mismatch = 0
            for gid in common:
                if (schedule[gid]["home_id"], schedule[gid]["away_id"]) != boxes[gid]:
                    identity_mismatch += 1
            exact = int(contract["expected_regular_fixtures"][s])
            season_pass = (
                sched_ev["custody_ok"] and box_ev["custody_ok"]
                and len(schedule_ids) == exact and len(box_ids) == exact and len(common) == exact
                and schedule_meta["duplicate_regular_game_ids"] == 0
                and schedule_meta["missing_date_regular_rows"] == 0
                and box_meta["malformed_games"] == 0
                and identity_mismatch == 0
                and not projected_forbidden
            )
            evidence["seasons"][s] = {
                "schedule_asset": sched_ev,
                "team_box_asset": box_ev,
                "schedule_schema_audit": schedule_meta,
                "team_box_identity_audit": box_meta,
                "expected_regular_fixtures": exact,
                "schedule_regular_fixtures": len(schedule_ids),
                "team_box_regular_fixtures": len(box_ids),
                "joined_regular_fixtures": len(common),
                "schedule_only_game_ids": sorted(schedule_ids - box_ids),
                "team_box_only_game_ids": sorted(box_ids - schedule_ids),
                "home_away_identity_mismatch_count": identity_mismatch,
                "join_rate": round(len(common) / exact, 12) if exact else 0.0,
                "projected_forbidden_columns": projected_forbidden,
                "season_pass": season_pass,
            }
            if not season_pass:
                evidence["hard_failures"].append(f"{season} schedule recovery gate failed")

    gates = {
        "all_candidate_asset_metadata_exact": all(evidence["seasons"][str(s)]["schedule_asset"]["custody_ok"] for s in SEASONS),
        "all_frozen_team_box_hashes_match": all(evidence["seasons"][str(s)]["team_box_asset"]["custody_ok"] for s in SEASONS),
        "all_schedule_sha256_computed": all(len(evidence["seasons"][str(s)]["schedule_asset"]["sha256"]) == 64 for s in SEASONS),
        "all_regular_fixture_counts_exact": all(evidence["seasons"][str(s)]["schedule_regular_fixtures"] == int(contract["expected_regular_fixtures"][str(s)]) for s in SEASONS),
        "all_two_sided_box_counts_exact": all(evidence["seasons"][str(s)]["team_box_regular_fixtures"] == int(contract["expected_regular_fixtures"][str(s)]) for s in SEASONS),
        "all_join_rates_one": all(evidence["seasons"][str(s)]["join_rate"] == 1.0 for s in SEASONS),
        "all_home_away_identity_exact": all(evidence["seasons"][str(s)]["home_away_identity_mismatch_count"] == 0 for s in SEASONS),
        "forbidden_values_not_projected": evidence["forbidden_value_columns_projected"] == 0,
        "outcomes_remained_closed": evidence["outcomes_opened"] is False,
    }
    passed = all(gates.values()) and not evidence["hard_failures"]
    evidence["gates"] = gates
    evidence["decision"] = "CERTIFY_PER_SEASON_SCHEDULE_PINS_FOR_R3B_V2" if passed else "R3B1_RECOVERY_BLOCKED"
    evidence["computed_schedule_pins"] = {
        str(s): {
            "asset_id": evidence["seasons"][str(s)]["schedule_asset"]["asset_id"],
            "name": evidence["seasons"][str(s)]["schedule_asset"]["name"],
            "size": evidence["seasons"][str(s)]["schedule_asset"]["bytes"],
            "sha256": evidence["seasons"][str(s)]["schedule_asset"]["sha256"],
        }
        for s in SEASONS
    }
    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"decision": evidence["decision"], "computed_schedule_pins": evidence["computed_schedule_pins"], "gates": gates}, indent=2, sort_keys=True))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
