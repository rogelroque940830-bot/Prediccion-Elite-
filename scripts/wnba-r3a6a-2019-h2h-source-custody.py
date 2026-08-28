#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT = Path("research/wnba/WNBA_R3A6A_2019_H2H_SOURCE_CUSTODY_CONTRACT.json")
OUT = Path("wnba-r3a6a-2019-h2h-source-custody-evidence.json")


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


def download_asset(asset_id: int, token: str) -> bytes:
    conn = http.client.HTTPSConnection("api.github.com", timeout=120)
    headers = {
        "Accept": "application/octet-stream",
        "User-Agent": "Prediccion-Elite-WNBA-R3A6A/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("GET", f"/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}", headers=headers)
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
        raise RuntimeError(f"release asset endpoint failed status={status}")
    if urlparse(location).scheme != "https":
        raise RuntimeError("release asset redirect is not HTTPS")
    with urlopen(Request(location, headers={"User-Agent": "Prediccion-Elite-WNBA-R3A6A/1.0"}), timeout=120) as signed:
        return signed.read()


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    source = contract["source"]
    token = os.getenv("GITHUB_TOKEN", "").strip()
    payload = download_asset(int(source["asset_id"]), token)
    actual_sha = sha256_bytes(payload)
    custody_ok = len(payload) == int(source["bytes"]) and actual_sha == str(source["sha256"])

    evidence: dict[str, Any] = {
        "name": "WNBA_R3A6A_2019_H2H_SOURCE_CUSTODY_EVIDENCE_V1",
        "contract": str(CONTRACT),
        "r3TargetOutcomeScoringPerformed": False,
        "h2hFeatureConstructionPerformed": False,
        "modelFitPerformed": False,
        "featureWeightSearchPerformed": False,
        "eliteThresholdSearchPerformed": False,
        "marketFeatureUse": False,
        "source": {
            "assetId": int(source["asset_id"]),
            "bytes": len(payload),
            "sha256": actual_sha,
            "custodyVerified": custody_ok,
        },
    }

    with tempfile.TemporaryDirectory(prefix="wnba-r3a6a-") as td:
        path = Path(td) / "team_box_2019.parquet"
        path.write_bytes(payload)
        pf = pq.ParquetFile(path)
        schema_names = pf.schema_arrow.names
        allow = list(contract["allowlisted_columns"])
        missing = [column for column in allow if column not in schema_names]
        evidence["schema"] = {
            "allowlistedColumns": allow,
            "missingAllowlistedColumns": missing,
            "complete": not missing,
        }
        if missing:
            OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            raise SystemExit(2)

        rows = pf.read(columns=allow).to_pylist()
        season_type_values = Counter(str(row.get("season_type")) for row in rows if str(row.get("season")) in {"2019", "2019.0"})
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            try:
                season = int(float(str(row.get("season"))))
            except (TypeError, ValueError):
                continue
            if season != 2019 or not regular(row.get("season_type")):
                continue
            gid = norm_id(row.get("game_id"))
            if gid:
                grouped[gid].append(row)

        pair_failures: list[dict[str, Any]] = []
        score_failures: list[str] = []
        valid_games: list[dict[str, Any]] = []
        team_occurrences: Counter[str] = Counter()
        dates: list[date] = []

        for gid, pair in sorted(grouped.items()):
            if len(pair) != 2:
                pair_failures.append({"gameId": gid, "reason": "ROW_COUNT", "rows": len(pair)})
                continue
            homes = [row for row in pair if norm_text(row.get("team_home_away")) == "home"]
            aways = [row for row in pair if norm_text(row.get("team_home_away")) == "away"]
            if len(homes) != 1 or len(aways) != 1:
                pair_failures.append({"gameId": gid, "reason": "HOME_AWAY_COUNT", "homeRows": len(homes), "awayRows": len(aways)})
                continue
            home, away = homes[0], aways[0]
            hid, aid = norm_id(home.get("team_id")), norm_id(away.get("team_id"))
            d1, d2 = parse_date(home.get("game_date")), parse_date(away.get("game_date"))
            if (
                not hid or not aid or hid == aid
                or norm_id(home.get("opponent_team_id")) != aid
                or norm_id(away.get("opponent_team_id")) != hid
                or d1 is None or d1 != d2
            ):
                pair_failures.append({"gameId": gid, "reason": "IDENTITY_OR_DATE", "homeId": hid, "awayId": aid, "homeDate": str(d1), "awayDate": str(d2)})
                continue
            hs = finite(home.get("team_score"))
            ha = finite(home.get("opponent_team_score"))
            aws = finite(away.get("team_score"))
            awa = finite(away.get("opponent_team_score"))
            if hs is None or ha is None or aws is None or awa is None or hs != awa or ha != aws or hs == ha:
                score_failures.append(gid)
                continue
            team_occurrences[hid] += 1
            team_occurrences[aid] += 1
            dates.append(d1)
            valid_games.append({
                "gameId": gid,
                "gameDate": d1.isoformat(),
                "homeTeamId": hid,
                "awayTeamId": aid,
                "homeScore": hs,
                "awayScore": ha,
            })

        low_frequency_ids = sorted([team_id for team_id, count in team_occurrences.items() if count <= 2])
        low_frequency_games = [
            game for game in valid_games
            if game["homeTeamId"] in low_frequency_ids or game["awayTeamId"] in low_frequency_ids
        ]
        common_franchise_ids = sorted([team_id for team_id, count in team_occurrences.items() if count >= 10])

        evidence["2019SeasonType2Audit"] = {
            "seasonTypeValuesObserved": dict(sorted(season_type_values.items())),
            "candidateGameIdsBeforeSpecialEventClassification": len(grouped),
            "validTwoSidedReciprocalGames": len(valid_games),
            "pairIdentityDateFailures": pair_failures,
            "scoreReciprocityOrTieFailures": score_failures,
            "distinctTeamIds": len(team_occurrences),
            "teamOccurrenceCounts": dict(sorted(team_occurrences.items(), key=lambda item: (item[1], item[0]))),
            "commonFranchiseCandidateTeamIdsCountAtLeast10Occurrences": common_franchise_ids,
            "lowFrequencyTeamIdsAtMost2Occurrences": low_frequency_ids,
            "gamesContainingLowFrequencyTeamIds": low_frequency_games,
            "minOfficialDate": min(dates).isoformat() if dates else None,
            "maxOfficialDate": max(dates).isoformat() if dates else None,
        }
        evidence["specialEventDiscovery"] = {
            "automaticExclusionPerformed": False,
            "candidateAnomalousGameIds": [game["gameId"] for game in low_frequency_games],
            "candidateAnomalousTeamIds": low_frequency_ids,
            "note": "These are reported for subsequent frozen classification only; R3A6A does not remove them."
        }

    clean = bool(
        custody_ok
        and evidence["schema"]["complete"]
        and not evidence["2019SeasonType2Audit"]["pairIdentityDateFailures"]
        and not evidence["2019SeasonType2Audit"]["scoreReciprocityOrTieFailures"]
        and evidence["2019SeasonType2Audit"]["validTwoSidedReciprocalGames"] > 0
    )
    evidence["decision"] = "PASS_2019_H2H_SOURCE_CUSTODY_SPECIAL_EVENT_CLASSIFICATION_REQUIRED" if clean else "FAIL_2019_H2H_SOURCE_CUSTODY"
    evidence["nextGate"] = contract["next_gate_on_clean_source"] if clean else contract["next_gate_on_failure"]
    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "decision": evidence["decision"],
        "source": evidence["source"],
        "schema": evidence["schema"],
        "audit": evidence["2019SeasonType2Audit"],
        "specialEventDiscovery": evidence["specialEventDiscovery"],
        "nextGate": evidence["nextGate"],
    }, indent=2))
    if not clean:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
