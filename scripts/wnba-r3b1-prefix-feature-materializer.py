#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.dataset as pads
import pyarrow.parquet as pq

CONTRACT = Path("research/wnba/WNBA_R3B1_PREFIX_FEATURE_DEFINITION_CONTRACT.json")
CERT = Path("research/wnba/WNBA_R3A_SIGNAL_CUSTODY_CERTIFICATION.json")
SPECIAL = Path("research/wnba/WNBA_R1A4C2_SPECIAL_EVENT_EXCLUSION_AND_PREFIX_CUSTODY.json")
OUT_ROWS = Path("wnba-r3b1-prefix-feature-rowset.jsonl")
OUT_EVIDENCE = Path("wnba-r3b1-prefix-feature-evidence.json")
REPO = "rogelroque940830-bot/Prediccion-Elite-"
ASSET_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
ARTIFACT_API = "https://api.github.com/repos/%s/actions/artifacts/{artifact_id}/zip" % REPO
SEASONS = (2021, 2022, 2023, 2024, 2025)
IDENTITY_COLS = ["game_id", "season", "season_type", "game_date", "team_id", "team_home_away", "opponent_team_id"]
STAT_COLS = [
    "game_id", "team_id", "team_home_away", "opponent_team_id", "team_score", "opponent_team_score",
    "field_goals_made", "field_goals_attempted", "three_point_field_goals_made",
    "three_point_field_goals_attempted", "free_throws_attempted", "offensive_rebounds",
    "defensive_rebounds", "turnovers"
]
BASE_KEYS = [
    "netRtg", "offRtg", "defRtg", "pace", "daysRest", "winRate", "isB2B", "streak",
    "recentNetRtg", "recentOffRtg", "recentDefRtg", "recentWinPct", "gamesPlayed",
    "b2bWasRoad", "gamesLast7", "travelMiles"
]
EXPECTED_REGULAR = {2021:192, 2022:216, 2023:240, 2024:240, 2025:286}


def headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "Prediccion-Elite-WNBA-R3B1/1.0", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def norm_id(v: Any) -> str:
    s = str(v or "").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def norm_text(v: Any) -> str:
    return str(v or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def regular(v: Any) -> bool:
    return norm_text(v) in {"2", "regular", "regularseason"}


def parse_date(v: Any) -> date:
    if isinstance(v, datetime): return v.date()
    if isinstance(v, date): return v
    s = str(v or "").strip()
    try: return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError: return datetime.strptime(s[:10], "%Y-%m-%d").date()


def finite(v: Any) -> float:
    x = float(v)
    if not math.isfinite(x): raise ValueError(f"non-finite value {v}")
    return x


def safe_div(num: float, den: float) -> float | None:
    return None if den <= 0 else num / den


def mean(xs: list[float]) -> float | None:
    return None if not xs else sum(xs) / len(xs)


def download_backbone(contract: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cfg = contract["target_backbone"]
    payload = get_bytes(ARTIFACT_API.format(artifact_id=int(cfg["artifact_id"])), "application/vnd.github+json")
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        name = cfg["file"]
        if name not in zf.namelist():
            raise SystemExit(f"backbone file missing from artifact: {name}")
        raw = zf.read(name)
    got_sha = sha256_bytes(raw)
    if got_sha != cfg["sha256"]:
        raise SystemExit(f"backbone SHA mismatch {got_sha}")
    rows = [json.loads(x) for x in raw.decode("utf-8").splitlines() if x.strip()]
    if len(rows) != int(cfg["rows"]):
        raise SystemExit(f"backbone row mismatch {len(rows)}")
    ids = [str(r["gameId"]) for r in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate gameId in backbone")
    counts = Counter(int(r["season"]) for r in rows)
    expected = {int(k): int(v) for k, v in cfg["season_rows"].items()}
    if dict(sorted(counts.items())) != dict(sorted(expected.items())):
        raise SystemExit(f"backbone season count mismatch {counts}")
    return rows, {"artifact_id": cfg["artifact_id"], "file": cfg["file"], "bytes": len(raw), "sha256": got_sha, "rows": len(rows), "season_rows": dict(sorted(counts.items()))}


def download_team_box(pin: dict[str, Any], year: int, dst: Path) -> dict[str, Any]:
    payload = get_bytes(ASSET_API.format(asset_id=int(pin["asset_id"])), "application/octet-stream")
    dst.write_bytes(payload)
    got = sha256_bytes(payload)
    ok = len(payload) == int(pin["bytes"]) and got == pin["sha256"]
    if not ok: raise SystemExit(f"team box custody mismatch {year}")
    return {"asset_id": pin["asset_id"], "bytes": len(payload), "sha256": got, "custody_verified": True}


def read_stats(path: Path, game_ids: list[str]) -> list[dict[str, Any]]:
    ds = pads.dataset(str(path), format="parquet")
    field = ds.schema.field("game_id")
    vals = [int(float(x)) for x in game_ids] if pa.types.is_integer(field.type) else game_ids
    expr = pads.field("game_id").isin(pa.array(vals, type=field.type))
    return ds.to_table(columns=STAT_COLS, filter=expr).to_pylist()


def game_record(row: dict[str, Any], opp: dict[str, Any], season: int, d: date) -> dict[str, Any]:
    vals = {
        "pts": finite(row["team_score"]), "opp_pts": finite(row["opponent_team_score"]),
        "fgm": finite(row["field_goals_made"]), "fga": finite(row["field_goals_attempted"]),
        "tpm": finite(row["three_point_field_goals_made"]), "tpa": finite(row["three_point_field_goals_attempted"]),
        "fta": finite(row["free_throws_attempted"]), "oreb": finite(row["offensive_rebounds"]),
        "dreb": finite(row["defensive_rebounds"]), "tov": finite(row["turnovers"]),
        "opp_fgm": finite(opp["field_goals_made"]), "opp_fga": finite(opp["field_goals_attempted"]),
        "opp_tpm": finite(opp["three_point_field_goals_made"]), "opp_tpa": finite(opp["three_point_field_goals_attempted"]),
        "opp_fta": finite(opp["free_throws_attempted"]), "opp_oreb": finite(opp["offensive_rebounds"]),
        "opp_dreb": finite(opp["defensive_rebounds"]), "opp_tov": finite(opp["turnovers"]),
    }
    poss = vals["fga"] + 0.44*vals["fta"] - vals["oreb"] + vals["tov"]
    if poss <= 0: raise SystemExit(f"invalid possession denominator game {row['game_id']}")
    return {
        "game_id": norm_id(row["game_id"]), "season": season, "date": d,
        "team_id": norm_id(row["team_id"]), "opponent_id": norm_id(row["opponent_team_id"]),
        "is_home": norm_text(row["team_home_away"]) == "home", "poss": poss,
        "net_eff": 100.0*(vals["pts"]-vals["opp_pts"])/poss, **vals
    }


def aggregate_counts(games: list[dict[str, Any]]) -> dict[str, float]:
    keys = ["pts","opp_pts","poss","fgm","fga","tpm","tpa","fta","oreb","dreb","tov","opp_fgm","opp_fga","opp_tpm","opp_tpa","opp_fta","opp_oreb","opp_dreb","opp_tov"]
    return {k: sum(float(g[k]) for g in games) for k in keys}


def four_factors(games: list[dict[str, Any]]) -> dict[str, Any]:
    if not games: return {"status":"NO_PRIOR_GAMES"}
    s = aggregate_counts(games)
    out = {
        "status":"READY", "games":len(games),
        "efg": safe_div(s["fgm"]+0.5*s["tpm"], s["fga"]),
        "tovRate": safe_div(s["tov"], s["fga"]+0.44*s["fta"]+s["tov"]),
        "orbRate": safe_div(s["oreb"], s["oreb"]+s["opp_dreb"]),
        "ftr": safe_div(s["fta"], s["fga"]),
        "efgAllowed": safe_div(s["opp_fgm"]+0.5*s["opp_tpm"], s["opp_fga"]),
        "tovRateForced": safe_div(s["opp_tov"], s["opp_fga"]+0.44*s["opp_fta"]+s["opp_tov"]),
        "orbRateAllowed": safe_div(s["opp_oreb"], s["opp_oreb"]+s["dreb"]),
        "ftrAllowed": safe_div(s["opp_fta"], s["opp_fga"]),
    }
    if any(out[k] is None for k in ["efg","tovRate","orbRate","ftr","efgAllowed","tovRateForced","orbRateAllowed","ftrAllowed"]): out["status"]="INVALID_DENOMINATOR"
    return out


def shot_profile(games: list[dict[str, Any]]) -> dict[str, Any]:
    if not games: return {"status":"NO_PRIOR_GAMES"}
    s = aggregate_counts(games)
    a, b = safe_div(s["tpa"], s["fga"]), safe_div(s["opp_tpa"], s["opp_fga"])
    return {"status":"READY" if a is not None and b is not None else "INVALID_DENOMINATOR", "threePar":a, "threeParAllowed":b}


def prefix_net_eff(games: list[dict[str, Any]]) -> float | None:
    if not games: return None
    s = aggregate_counts(games)
    return safe_div(100.0*(s["pts"]-s["opp_pts"]), s["poss"])


def quality_form(games: list[dict[str, Any]], season_history: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    def window(n: int) -> dict[str, Any]:
        recent = games[-n:]
        raw = [float(g["net_eff"]) for g in recent]
        adjusted: list[float] = []
        for g in recent:
            opp_state = prefix_net_eff(season_history.get(g["opponent_id"], []))
            if opp_state is not None: adjusted.append(float(g["net_eff"]) - opp_state)
        return {"raw":mean(raw), "qualityAdjusted":mean(adjusted), "gamesUsed":len(raw), "adjustedGamesUsed":len(adjusted)}
    if not games: return {"status":"NO_PRIOR_GAMES"}
    w5, w10 = window(5), window(10)
    return {"status":"READY", "netEffL5":w5["raw"], "netEffL10":w10["raw"], "qualityAdjNetL5":w5["qualityAdjusted"], "qualityAdjNetL10":w10["qualityAdjusted"], "l5GamesUsed":w5["gamesUsed"], "l10GamesUsed":w10["gamesUsed"], "l5AdjustedGamesUsed":w5["adjustedGamesUsed"], "l10AdjustedGamesUsed":w10["adjustedGamesUsed"]}


def h2h(team_id: str, opp_id: str, season: int, global_history: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    allowed = {season, season-1} if season > 2021 else {2021}
    meetings = [g for g in global_history.get(team_id, []) if g["season"] in allowed and g["opponent_id"] == opp_id]
    n = len(meetings)
    return {"status":"READY", "historySeasonsAvailable":1 if season==2021 else 2, "meetingCount":n, "winShare":None if n==0 else sum(1 for g in meetings if g["pts"]>g["opp_pts"])/n, "avgMargin":None if n==0 else mean([g["pts"]-g["opp_pts"] for g in meetings])}


def fatigue(games: list[dict[str, Any]], target_date: date) -> dict[str, Any]:
    if not games: return {"status":"NO_PRIOR_GAMES"}
    last = games[-1]["date"]
    c4 = sum(1 for g in games if target_date-timedelta(days=4) <= g["date"] < target_date)
    c6 = sum(1 for g in games if target_date-timedelta(days=6) <= g["date"] < target_date)
    return {"status":"READY", "daysRest":max(0,(target_date-last).days), "priorGamesLast4Days":c4, "priorGamesLast6Days":c6, "threeInFive":int(c4>=2), "fourInSeven":int(c6>=3)}


def side_features(team_id: str, opp_id: str, season: int, d: date, season_history: dict[str,list[dict[str,Any]]], global_history: dict[str,list[dict[str,Any]]]) -> dict[str, Any]:
    games = season_history.get(team_id, [])
    ff = four_factors(games); sp = shot_profile(games)
    opp_ff = four_factors(season_history.get(opp_id, [])); opp_sp = shot_profile(season_history.get(opp_id, []))
    def edge(a: Any, b: Any) -> float | None:
        return None if a is None or b is None else float(a)-float(b)
    matchup = {
        "status":"READY" if ff.get("status")=="READY" and sp.get("status")=="READY" and opp_ff.get("status")=="READY" and opp_sp.get("status")=="READY" else "PARTIAL",
        "efgEdge":edge(ff.get("efg"), opp_ff.get("efgAllowed")),
        "orbEdge":edge(ff.get("orbRate"), opp_ff.get("orbRateAllowed")),
        "ftrEdge":edge(ff.get("ftr"), opp_ff.get("ftrAllowed")),
        "threeParStyleGap":edge(sp.get("threePar"), opp_sp.get("threeParAllowed"))
    }
    return {"fourFactors":ff, "shotProfile":{**sp, **matchup}, "qualityForm":quality_form(games, season_history), "h2h":h2h(team_id,opp_id,season,global_history), "fatigue":fatigue(games,d)}


def base_side(src: dict[str, Any]) -> dict[str, Any]:
    out = {k: src.get(k) for k in BASE_KEYS}
    out["sosOppAvgNetRtg"] = (src.get("sos") or {}).get("oppAvgNetRtg")
    return out


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    cert = json.loads(CERT.read_text())
    special = json.loads(SPECIAL.read_text())
    excluded = set().union(*[set(map(str,v)) for v in special["special_event_classification"]["excluded_game_ids_by_season"].values()])
    backbone, backbone_ev = download_backbone(contract)
    targets_by_season_date: dict[int, dict[date, list[dict[str,Any]]]] = defaultdict(lambda: defaultdict(list))
    backbone_map: dict[str,dict[str,Any]] = {}
    for r in backbone:
        gid = str(r["gameId"]); backbone_map[gid]=r
        targets_by_season_date[int(r["season"])][parse_date(r["targetDate"])].append(r)

    evidence: dict[str,Any] = {"name":"WNBA_R3B1_PREFIX_FEATURE_MATERIALIZATION_EVIDENCE_V1", "backbone":backbone_ev, "assets":{}, "season":{}, "gates":{}, "targetOutcomeFieldsInOutput":0, "marketFieldsInOutput":0, "availabilityFieldsInOutput":0}
    canonical_lines: list[str] = []
    global_history: dict[str,list[dict[str,Any]]] = defaultdict(list)
    same_date_use = future_use = self_use = special_ingest = identity_mismatch = base_days_rest_mismatch = 0

    with tempfile.TemporaryDirectory(prefix="wnba-r3b1-") as td:
        root = Path(td)
        for season in SEASONS:
            pin = cert["team_box_custody"][str(season)]
            path = root / f"team_box_{season}.parquet"
            evidence["assets"][str(season)] = download_team_box(pin, season, path)
            identities = pq.read_table(path, columns=IDENTITY_COLS).to_pylist()
            grouped: dict[str,list[dict[str,Any]]] = defaultdict(list)
            for r in identities:
                gid=norm_id(r["game_id"])
                if regular(r["season_type"]) and gid not in excluded: grouped[gid].append(r)
            game_meta: dict[str,dict[str,Any]] = {}
            by_date: dict[date,list[str]] = defaultdict(list)
            for gid,sides in grouped.items():
                if len(sides)!=2: raise SystemExit(f"identity sides !=2 {season} {gid}")
                side_map={norm_text(x["team_home_away"]):x for x in sides}
                if "home" not in side_map or "away" not in side_map: raise SystemExit(f"home-away identity failure {gid}")
                d=parse_date(sides[0]["game_date"])
                home_id=norm_id(side_map["home"]["team_id"]); away_id=norm_id(side_map["away"]["team_id"])
                game_meta[gid]={"date":d,"home_id":home_id,"away_id":away_id}
                by_date[d].append(gid)
            if len(game_meta)!=EXPECTED_REGULAR[season]: raise SystemExit(f"regular fixture count mismatch {season}: {len(game_meta)}")

            season_history: dict[str,list[dict[str,Any]]] = defaultdict(list)
            sealed=0; ingested=0
            all_dates=sorted(set(by_date)|set(targets_by_season_date.get(season,{})))
            for d in all_dates:
                for target in sorted(targets_by_season_date.get(season,{}).get(d,[]), key=lambda x:str(x["gameId"])):
                    gid=str(target["gameId"]); meta=game_meta.get(gid)
                    if meta is None or meta["date"]!=d or meta["home_id"]!=str(target["homeTeamId"]) or meta["away_id"]!=str(target["awayTeamId"]):
                        identity_mismatch += 1; continue
                    for tid in (meta["home_id"],meta["away_id"]):
                        for g in season_history.get(tid,[]):
                            if g["game_id"]==gid: self_use+=1
                            if g["date"]==d: same_date_use+=1
                            if g["date"]>d: future_use+=1
                    hf=side_features(meta["home_id"],meta["away_id"],season,d,season_history,global_history)
                    af=side_features(meta["away_id"],meta["home_id"],season,d,season_history,global_history)
                    bhome=base_side(target["home"]); baway=base_side(target["away"])
                    if hf["fatigue"].get("status")=="READY" and bhome.get("daysRest") is not None and int(hf["fatigue"]["daysRest"])!=int(bhome["daysRest"]): base_days_rest_mismatch+=1
                    if af["fatigue"].get("status")=="READY" and baway.get("daysRest") is not None and int(af["fatigue"]["daysRest"])!=int(baway["daysRest"]): base_days_rest_mismatch+=1
                    out={"schemaVersion":1,"gameId":gid,"season":season,"targetDate":d.isoformat(),"homeTeamId":meta["home_id"],"awayTeamId":meta["away_id"],"baseR2":{"home":bhome,"away":baway},"r3":{"home":hf,"away":af}}
                    canonical_lines.append(json.dumps(out,sort_keys=True,separators=(",",":")))
                    sealed+=1

                day_ids=sorted(by_date.get(d,[]))
                if day_ids:
                    stat_rows=read_stats(path,day_ids)
                    stats_by_gid: dict[str,list[dict[str,Any]]] = defaultdict(list)
                    for r in stat_rows: stats_by_gid[norm_id(r["game_id"])].append(r)
                    for gid in day_ids:
                        if gid in excluded: special_ingest+=1; continue
                        rows=stats_by_gid.get(gid,[])
                        if len(rows)!=2: raise SystemExit(f"stat sides !=2 {season} {gid}")
                        a,b=rows
                        if norm_id(a["opponent_team_id"])!=norm_id(b["team_id"]) or norm_id(b["opponent_team_id"])!=norm_id(a["team_id"]): raise SystemExit(f"pair identity failure {gid}")
                        ra=game_record(a,b,season,d); rb=game_record(b,a,season,d)
                        season_history[ra["team_id"]].append(ra); season_history[rb["team_id"]].append(rb)
                        global_history[ra["team_id"]].append(ra); global_history[rb["team_id"]].append(rb)
                        ingested+=1
            evidence["season"][str(season)]={"regularFixtures":len(game_meta),"targetRowsSealed":sealed,"regularGamesIngestedAfterDateSeal":ingested}

    if identity_mismatch: raise SystemExit(f"target identity mismatch count {identity_mismatch}")
    canonical_lines.sort(key=lambda s:(json.loads(s)["targetDate"],json.loads(s)["gameId"]))
    payload=("\n".join(canonical_lines)+"\n").encode("utf-8")
    OUT_ROWS.write_bytes(payload)
    output_ids=[json.loads(x)["gameId"] for x in canonical_lines]
    backbone_ids={str(r["gameId"]) for r in backbone}
    output_id_set=set(output_ids)
    evidence["rowset"]={"rows":len(canonical_lines),"bytes":len(payload),"sha256":sha256_bytes(payload)}
    evidence["gates"]={
        "backboneRowsExact":len(backbone)==1143,"backboneShaExact":backbone_ev["sha256"]==contract["target_backbone"]["sha256"],
        "outputRowsExact":len(canonical_lines)==1143,"duplicateGameIds":len(output_ids)-len(output_id_set),"membershipExact":output_id_set==backbone_ids,
        "specialEventHistoryRows":special_ingest,"sameDateHistoryUse":same_date_use,"futureHistoryUse":future_use,"targetSelfHistoryUse":self_use,
        "targetIdentityMismatch":identity_mismatch,"baseDaysRestMismatchSideCount":base_days_rest_mismatch,
        "teamBoxCustodyAll":all(x["custody_verified"] for x in evidence["assets"].values())
    }
    evidence["classification"]={"FOUR_FACTORS":"MATERIALIZED","SHOT_PROFILE_MATCHUP":"MATERIALIZED","QUALITY_ADJUSTED_FORM":"MATERIALIZED","H2H_PREFIX":"MATERIALIZED","FATIGUE_CORE":"MATERIALIZED","AVAILABILITY_STAR_POWER":"EXCLUDED_PROSPECTIVE_ONLY","TRAVEL_V2_ACTUAL_VENUE_SEQUENCE":"EXCLUDED_SOURCE_CUSTODY_BLOCK"}
    evidence["r3b2Authorized"] = all([
        evidence["gates"]["backboneRowsExact"],evidence["gates"]["backboneShaExact"],evidence["gates"]["outputRowsExact"],
        evidence["gates"]["duplicateGameIds"]==0,evidence["gates"]["membershipExact"],evidence["gates"]["specialEventHistoryRows"]==0,
        evidence["gates"]["sameDateHistoryUse"]==0,evidence["gates"]["futureHistoryUse"]==0,evidence["gates"]["targetSelfHistoryUse"]==0,
        evidence["gates"]["targetIdentityMismatch"]==0,evidence["gates"]["teamBoxCustodyAll"]
    ])
    OUT_EVIDENCE.write_text(json.dumps(evidence,indent=2,sort_keys=True)+"\n")
    print(json.dumps({"rowset":evidence["rowset"],"gates":evidence["gates"],"r3b2Authorized":evidence["r3b2Authorized"]},indent=2))
    if not evidence["r3b2Authorized"]: raise SystemExit("R3B1 materialization gates failed")


if __name__ == "__main__": main()
