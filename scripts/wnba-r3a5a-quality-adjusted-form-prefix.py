#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import io
import json
import math
import os
import tempfile
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zipfile import ZipFile

import pyarrow.parquet as pq

CONTRACT = Path("research/wnba/WNBA_R3A5A_QUALITY_ADJUSTED_FORM_PREFIX_CONTRACT.json")
R1_PINS = Path("research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json")
R3_2020 = Path("research/wnba/WNBA_R3A1B_2020_FOUR_FACTORS_CUSTODY_CERTIFICATION.json")
R3A2_CERT = Path("research/wnba/WNBA_R3A2_STRICT_PREFIX_FEATURE_CONSTRUCTOR_CERTIFICATION.json")
OUT_ROWS = Path("wnba-r3a5a-quality-adjusted-form-prefix.jsonl")
OUT_EVIDENCE = Path("wnba-r3a5a-quality-adjusted-form-prefix-evidence.json")
SEASONS = (2020, 2021, 2022, 2023, 2024, 2025)
COLS = [
    "game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id",
    "team_score", "opponent_team_score", "field_goals_attempted", "free_throws_attempted", "offensive_rebounds", "turnovers"
]


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


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


def q(v: float) -> float:
    return round(float(v), 12)


def canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def github_signed_bytes(host: str, path: str, token: str, accept: str, user_agent: str) -> bytes:
    conn = http.client.HTTPSConnection(host, timeout=120)
    headers = {
        "Accept": accept,
        "User-Agent": user_agent,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("GET", path, headers=headers)
    response = conn.getresponse()
    status = response.status
    location = response.getheader("Location")
    if status == 200:
        payload = response.read()
        conn.close()
        return payload
    response.read()
    conn.close()
    if status not in (301, 302, 303, 307, 308) or not location:
        raise RuntimeError(f"GitHub binary endpoint failed status={status} path={path}")
    parsed = urlparse(location)
    if parsed.scheme != "https":
        raise RuntimeError("signed binary redirect is not HTTPS")
    with urlopen(Request(location, headers={"User-Agent": user_agent}), timeout=120) as signed:
        return signed.read()


def download_release_asset(asset_id: int, token: str) -> bytes:
    return github_signed_bytes(
        "api.github.com",
        f"/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}",
        token,
        "application/octet-stream",
        "Prediccion-Elite-WNBA-R3A5A/1.0",
    )


def download_workflow_artifact(repository: str, artifact_id: int, token: str) -> bytes:
    return github_signed_bytes(
        "api.github.com",
        f"/repos/{repository}/actions/artifacts/{artifact_id}/zip",
        token,
        "application/vnd.github+json",
        "Prediccion-Elite-WNBA-R3A5A/1.0",
    )


def verify_asset(pin: dict[str, Any], payload: bytes) -> dict[str, Any]:
    expected_bytes = int(pin.get("size", pin.get("bytes")))
    expected_sha = str(pin["sha256"]).removeprefix("sha256:")
    actual_sha = sha256_bytes(payload)
    return {
        "asset_id": int(pin["asset_id"]),
        "bytes": len(payload),
        "sha256": actual_sha,
        "custody_verified": len(payload) == expected_bytes and actual_sha == expected_sha,
    }


def net_efficiency(games: list[dict[str, Any]]) -> float | None:
    if not games:
        return None
    possessions = sum(float(g["poss"]) for g in games)
    if not math.isfinite(possessions) or possessions <= 0:
        return None
    scored = sum(float(g["scored"]) for g in games)
    allowed = sum(float(g["allowed"]) for g in games)
    return 100.0 * (scored - allowed) / possessions


def margin_per_game(games: list[dict[str, Any]]) -> float | None:
    if not games:
        return None
    return sum(float(g["scored"]) - float(g["allowed"]) for g in games) / len(games)


def audit_history(games: list[dict[str, Any]], target_date: date, target_gid: str, evidence: dict[str, Any]) -> None:
    for game in games:
        if game["game_id"] == target_gid:
            evidence["target_self_source_use_count"] += 1
        if game["date"] == target_date:
            evidence["same_day_source_use_count"] += 1
        if game["date"] > target_date:
            evidence["future_source_use_count"] += 1


def recent_state(
    recent_games: list[dict[str, Any]],
    target_date: date,
    target_gid: str,
    history: dict[str, list[dict[str, Any]]],
    evidence: dict[str, Any],
) -> dict[str, Any] | None:
    recent_net = net_efficiency(recent_games)
    recent_margin = margin_per_game(recent_games)
    if recent_net is None or recent_margin is None:
        return None
    opponent_strengths: list[float] = []
    for occurrence in recent_games:
        opponent_id = str(occurrence["opponent_id"])
        opponent_history = history.get(opponent_id, [])
        audit_history(opponent_history, target_date, target_gid, evidence)
        opponent_net = net_efficiency(opponent_history)
        if opponent_net is None:
            evidence["missing_recent_opponent_target_date_state_count"] += 1
            return None
        opponent_strengths.append(opponent_net)
    opponent_avg = sum(opponent_strengths) / len(opponent_strengths)
    return {
        "gameCount": len(recent_games),
        "netEfficiency": q(recent_net),
        "marginPerGame": q(recent_margin),
        "opponentAvgSeasonNetEfficiency": q(opponent_avg),
        "qualityAdjustedNetEfficiency": q(recent_net + opponent_avg),
    }


def side_state(
    team_id: str,
    target_date: date,
    target_gid: str,
    history: dict[str, list[dict[str, Any]]],
    evidence: dict[str, Any],
) -> dict[str, Any] | None:
    games = history.get(team_id, [])
    if not games:
        return None
    audit_history(games, target_date, target_gid, evidence)
    max_prior = max(game["date"] for game in games)
    if not max_prior < target_date:
        evidence["max_prior_date_violation_count"] += 1
    season_net = net_efficiency(games)
    if season_net is None:
        return None
    ordered = sorted(games, key=lambda g: (g["date"], g["game_id"]))
    recent5_games = ordered[-5:]
    recent10_games = ordered[-10:]
    r5 = recent_state(recent5_games, target_date, target_gid, history, evidence)
    r10 = recent_state(recent10_games, target_date, target_gid, history, evidence)
    if r5 is None or r10 is None:
        return None
    return {
        "priorGameCount": len(games),
        "maxPriorDate": max_prior.isoformat(),
        "seasonNetEfficiency": q(season_net),
        "recent5GameCount": r5["gameCount"],
        "recent5NetEfficiency": r5["netEfficiency"],
        "recent5EfficiencyDeltaVsSeason": q(float(r5["netEfficiency"]) - season_net),
        "recent5MarginPerGame": r5["marginPerGame"],
        "recent5OpponentAvgSeasonNetEfficiency": r5["opponentAvgSeasonNetEfficiency"],
        "recent5QualityAdjustedNetEfficiency": r5["qualityAdjustedNetEfficiency"],
        "recent10GameCount": r10["gameCount"],
        "recent10NetEfficiency": r10["netEfficiency"],
        "recent10EfficiencyDeltaVsSeason": q(float(r10["netEfficiency"]) - season_net),
        "recent10MarginPerGame": r10["marginPerGame"],
        "recent10OpponentAvgSeasonNetEfficiency": r10["opponentAvgSeasonNetEfficiency"],
        "recent10QualityAdjustedNetEfficiency": r10["qualityAdjustedNetEfficiency"],
    }


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    r1 = json.loads(R1_PINS.read_text())
    r20 = json.loads(R3_2020.read_text())
    r3a2_cert = json.loads(R3A2_CERT.read_text())
    repository = os.getenv("GITHUB_REPOSITORY", "rogelroque940830-bot/Prediccion-Elite-").strip()
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")

    expected_regular = {int(k): int(v) for k, v in contract["historical_scope"]["expected_regular_games"].items()}
    expected_prefix = {int(k): int(v) for k, v in contract["historical_scope"]["expected_prefix_rows"].items() if k != "total"}
    specials = {int(k): set(v) for k, v in contract["historical_scope"]["known_non_regular_special_event_ids_excluded"].items()}
    pins: dict[int, dict[str, Any]] = {2020: r20["source"]["team_box_2020"]}
    for season in range(2021, 2026):
        pins[season] = r1["frozen_asset_pins"][f"{season}_team_box"]

    r3a2_zip = download_workflow_artifact(repository, int(r3a2_cert["execution"]["artifact_id"]), token)
    expected_r3a2_zip_sha = str(r3a2_cert["execution"]["artifact_digest"]).removeprefix("sha256:")
    if sha256_bytes(r3a2_zip) != expected_r3a2_zip_sha:
        raise RuntimeError("R3A2 reference artifact ZIP SHA mismatch")
    with ZipFile(io.BytesIO(r3a2_zip)) as zf:
        ref_name = str(r3a2_cert["execution"]["rowset_file"])
        ref_payload = zf.read(ref_name)
    if sha256_bytes(ref_payload) != str(r3a2_cert["rowset"]["sha256"]):
        raise RuntimeError("R3A2 reference rowset SHA mismatch")
    reference_ids = {
        (int(row["season"]), str(row["gameId"]))
        for row in (json.loads(line) for line in ref_payload.decode("utf-8").splitlines() if line.strip())
    }

    evidence: dict[str, Any] = {
        "name": "WNBA_R3A5A_QUALITY_ADJUSTED_FORM_PREFIX_EVIDENCE_V1",
        "contract": str(CONTRACT),
        "target_outcomes_scored": False,
        "model_fit": False,
        "feature_weight_search": False,
        "elite_threshold_search": False,
        "market_values_consumed": False,
        "same_day_source_use_count": 0,
        "future_source_use_count": 0,
        "target_self_source_use_count": 0,
        "max_prior_date_violation_count": 0,
        "missing_recent_opponent_target_date_state_count": 0,
        "pair_or_date_identity_failure_count": 0,
        "invalid_ingested_possession_count": 0,
        "duplicate_emitted_game_id_count": 0,
        "assets": {},
        "seasons": {},
        "r3a2Reference": {
            "artifactId": int(r3a2_cert["execution"]["artifact_id"]),
            "artifactZipSha256": sha256_bytes(r3a2_zip),
            "rowsetSha256": sha256_bytes(ref_payload),
            "identityRows": len(reference_ids),
        },
    }
    lines: list[str] = []
    emitted_ids: set[tuple[int, str]] = set()

    with tempfile.TemporaryDirectory(prefix="wnba-r3a5a-") as td:
        root = Path(td)
        for season in SEASONS:
            payload = download_release_asset(int(pins[season]["asset_id"]), token)
            asset_ev = verify_asset(pins[season], payload)
            evidence["assets"][str(season)] = asset_ev
            path = root / f"team_box_{season}.parquet"
            path.write_bytes(payload)
            if not asset_ev["custody_verified"]:
                raise RuntimeError(f"source custody mismatch season {season}")
            pf = pq.ParquetFile(path)
            missing_columns = [column for column in COLS if column not in pf.schema_arrow.names]
            if missing_columns:
                raise RuntimeError(f"season {season} missing columns {missing_columns}")
            raw = pf.read(columns=COLS).to_pylist()

            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in raw:
                try:
                    row_season = int(row.get("season"))
                except (TypeError, ValueError):
                    continue
                if row_season != season or not regular(row.get("season_type")):
                    continue
                gid = norm_id(row.get("game_id"))
                if gid and gid not in specials.get(season, set()):
                    grouped[gid].append(row)

            validated: dict[str, tuple[dict[str, Any], dict[str, Any], date]] = {}
            targets_by_date: dict[date, list[dict[str, Any]]] = defaultdict(list)
            pair_failures = 0
            for gid, pair in grouped.items():
                if len(pair) != 2:
                    pair_failures += 1
                    continue
                home_rows = [row for row in pair if norm_text(row.get("team_home_away")) == "home"]
                away_rows = [row for row in pair if norm_text(row.get("team_home_away")) == "away"]
                if len(home_rows) != 1 or len(away_rows) != 1:
                    pair_failures += 1
                    continue
                home, away = home_rows[0], away_rows[0]
                home_id, away_id = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
                home_date, away_date = parse_date(home.get("game_date")), parse_date(away.get("game_date"))
                if (
                    not home_id or not away_id or home_id == away_id
                    or norm_id(home.get("opponent_team_id")) != away_id
                    or norm_id(away.get("opponent_team_id")) != home_id
                    or home_date is None or home_date != away_date
                ):
                    pair_failures += 1
                    continue
                validated[gid] = (home, away, home_date)
                targets_by_date[home_date].append({"game_id": gid, "date": home_date, "home_id": home_id, "away_id": away_id})
            evidence["pair_or_date_identity_failure_count"] += pair_failures

            history: dict[str, list[dict[str, Any]]] = defaultdict(list)
            emitted = 0
            cold_start = 0
            for target_date in sorted(targets_by_date):
                day_targets = sorted(targets_by_date[target_date], key=lambda row: row["game_id"])
                # Phase 1: all date-D targets are sealed before any date-D score or boxscore component enters history.
                for target in day_targets:
                    home_state = side_state(target["home_id"], target_date, target["game_id"], history, evidence)
                    away_state = side_state(target["away_id"], target_date, target["game_id"], history, evidence)
                    if home_state is None or away_state is None:
                        cold_start += 1
                        continue
                    identity = (season, target["game_id"])
                    if identity in emitted_ids:
                        evidence["duplicate_emitted_game_id_count"] += 1
                    emitted_ids.add(identity)
                    row = {
                        "season": season,
                        "gameId": target["game_id"],
                        "gameDate": target_date.isoformat(),
                        "homeTeamId": target["home_id"],
                        "awayTeamId": target["away_id"],
                        "home": home_state,
                        "away": away_state,
                        "provenance": {
                            "featureCutoffRule": "STRICTLY_PRIOR_OFFICIAL_DATE",
                            "sameDayExcluded": True,
                            "targetOutcomeUsed": False,
                            "marketAttached": False,
                        },
                    }
                    lines.append(canonical(row))
                    emitted += 1

                # Phase 2: only after every target on date D is sealed do date-D finalized values enter history.
                for target in day_targets:
                    home, away, game_date = validated[target["game_id"]]
                    for side in (home, away):
                        fga = finite(side.get("field_goals_attempted"))
                        fta = finite(side.get("free_throws_attempted"))
                        oreb = finite(side.get("offensive_rebounds"))
                        tov = finite(side.get("turnovers"))
                        scored = finite(side.get("team_score"))
                        allowed = finite(side.get("opponent_team_score"))
                        if any(value is None for value in (fga, fta, oreb, tov, scored, allowed)):
                            raise RuntimeError(f"missing form component season={season} game={target['game_id']}")
                        poss = float(fga) + 0.44 * float(fta) - float(oreb) + float(tov)
                        if not math.isfinite(poss) or poss <= 0:
                            evidence["invalid_ingested_possession_count"] += 1
                            raise RuntimeError(f"invalid possession estimate season={season} game={target['game_id']}")
                        history[norm_id(side.get("team_id"))].append({
                            "game_id": target["game_id"],
                            "date": game_date,
                            "opponent_id": norm_id(side.get("opponent_team_id")),
                            "scored": float(scored),
                            "allowed": float(allowed),
                            "poss": poss,
                        })

            evidence["seasons"][str(season)] = {
                "acceptedRegularGames": len(validated),
                "expectedRegularGames": expected_regular[season],
                "regularGameCountMatches": len(validated) == expected_regular[season],
                "prefixRowsEmitted": emitted,
                "expectedPrefixRows": expected_prefix[season],
                "prefixRowCountMatches": emitted == expected_prefix[season],
                "coldStartExclusions": cold_start,
                "pairOrDateFailures": pair_failures,
            }

    lines.sort(key=lambda line: (json.loads(line)["season"], json.loads(line)["gameDate"], json.loads(line)["gameId"]))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    OUT_ROWS.write_bytes(payload)
    output_ids = {(int(row["season"]), str(row["gameId"])) for row in (json.loads(line) for line in lines)}
    evidence["populationParity"] = {
        "r3a2IdentityRows": len(reference_ids),
        "r3a5aIdentityRows": len(output_ids),
        "commonRows": len(reference_ids & output_ids),
        "r3a2OnlyRows": len(reference_ids - output_ids),
        "r3a5aOnlyRows": len(output_ids - reference_ids),
        "exact": reference_ids == output_ids,
    }
    evidence["rowset"] = {
        "rows": len(lines),
        "bytes": len(payload),
        "sha256": sha256_bytes(payload),
    }
    evidence["assetCustodyAllVerified"] = all(item["custody_verified"] for item in evidence["assets"].values())
    evidence["regularGameCountsAllMatch"] = all(item["regularGameCountMatches"] for item in evidence["seasons"].values())
    evidence["prefixRowCountsAllMatch"] = all(item["prefixRowCountMatches"] for item in evidence["seasons"].values())
    passed = all([
        evidence["assetCustodyAllVerified"],
        evidence["regularGameCountsAllMatch"],
        evidence["prefixRowCountsAllMatch"],
        evidence["pair_or_date_identity_failure_count"] == 0,
        evidence["same_day_source_use_count"] == 0,
        evidence["future_source_use_count"] == 0,
        evidence["target_self_source_use_count"] == 0,
        evidence["max_prior_date_violation_count"] == 0,
        evidence["missing_recent_opponent_target_date_state_count"] == 0,
        evidence["invalid_ingested_possession_count"] == 0,
        evidence["duplicate_emitted_game_id_count"] == 0,
        evidence["populationParity"]["exact"],
        len(lines) == int(contract["historical_scope"]["expected_prefix_rows"]["total"]),
    ])
    evidence["decision"] = "PASS_QUALITY_ADJUSTED_FORM_STRICT_PREFIX" if passed else "FAIL_QUALITY_ADJUSTED_FORM_STRICT_PREFIX"
    evidence["nextGate"] = contract["next_gate_on_pass"] if passed else contract["next_gate_on_fail"]
    OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "decision": evidence["decision"],
        "rowset": evidence["rowset"],
        "populationParity": evidence["populationParity"],
        "antiLeakage": {
            "sameDay": evidence["same_day_source_use_count"],
            "future": evidence["future_source_use_count"],
            "targetSelf": evidence["target_self_source_use_count"],
            "maxPriorDate": evidence["max_prior_date_violation_count"],
            "missingOpponentState": evidence["missing_recent_opponent_target_date_state_count"],
        },
        "seasons": evidence["seasons"],
        "nextGate": evidence["nextGate"],
    }, indent=2))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
