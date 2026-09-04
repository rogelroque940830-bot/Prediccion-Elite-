#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5b_qb_identity_availability as r5b

SCHEMA = "courtedge-nfl-r5h20-pregame-materializer-replay.v1"
TEAM_METRICS = [
    "off_epa", "off_success", "plays", "drives",
    "pass_epa", "pass_success", "rush_epa", "rush_success",
    "sack_rate", "explosive_pass", "explosive_rush",
]
REQUIRED_FEATURES = [
    "away_def_epa", "away_def_explosive_pass", "away_def_explosive_rush",
    "away_def_pass_epa", "away_def_pass_success", "away_def_rush_epa",
    "away_def_rush_success", "away_def_sack_rate", "away_def_success",
    "away_drives", "away_explosive_pass", "away_explosive_rush",
    "away_oa_def", "away_oa_off", "away_oa_pass_def", "away_oa_pass_off",
    "away_off_epa", "away_off_success", "away_pass_epa", "away_pass_success",
    "away_plays", "away_points_against", "away_points_for",
    "away_r5b2_hi_cpoe", "away_r5b2_hi_epa", "away_r5b2_hi_sack_rate",
    "away_r5b2_hi_switch", "away_r5b2_hi_uncertainty",
    "away_r5b2_out_switch", "away_r5b2_ts_switch", "away_rush_epa",
    "away_rush_success", "away_sack_rate", "away_uncertainty",
    "home_def_epa", "home_def_explosive_pass", "home_def_explosive_rush",
    "home_def_pass_epa", "home_def_pass_success", "home_def_rush_epa",
    "home_def_rush_success", "home_def_sack_rate", "home_def_success",
    "home_drives", "home_explosive_pass", "home_explosive_rush",
    "home_oa_def", "home_oa_off", "home_oa_pass_def", "home_oa_pass_off",
    "home_off_epa", "home_off_success", "home_pass_epa", "home_pass_success",
    "home_plays", "home_points_against", "home_points_for",
    "home_r5b2_hi_cpoe", "home_r5b2_hi_epa", "home_r5b2_hi_sack_rate",
    "home_r5b2_hi_switch", "home_r5b2_hi_uncertainty",
    "home_r5b2_out_switch", "home_r5b2_ts_switch", "home_rush_epa",
    "home_rush_success", "home_sack_rate", "home_uncertainty",
]
FORBIDDEN = ("moneyline", "spread", "total_line", "odds", "price", "vig", "book", "over_under")


def scalar(value):
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        value = float(value)
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if pd.isna(value):
        return None
    return value


def finite_map(row, keys):
    return {key: scalar(row.get(key)) for key in keys}


def canonical_digest(payload):
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def group_old_depth(old):
    rows = []
    if old.empty:
        return rows
    for (season, week, team), z in old.groupby(["season", "week", "team"], sort=False):
        q = z.sort_values(["rank", "qb_id"]).drop_duplicates("qb_id")
        rows.append({
            "season": int(season),
            "week": int(week),
            "team": str(team),
            "qbs": [{"qbId": str(r.qb_id), "rank": int(r.rank)} for r in q.itertuples(index=False)],
        })
    rows.sort(key=lambda r: (r["season"], r["week"], r["team"]))
    return rows


def group_new_depth(new):
    rows = []
    if new.empty:
        return rows
    for (team, dt), z in new.groupby(["team", "dt"], sort=False):
        q = z.sort_values(["rank", "qb_id"]).drop_duplicates("qb_id")
        rows.append({
            "season": int(q.iloc[0].season),
            "at": pd.Timestamp(dt).isoformat(),
            "team": str(team),
            "qbs": [{"qbId": str(r.qb_id), "rank": int(r.rank)} for r in q.itertuples(index=False)],
        })
    rows.sort(key=lambda r: (r["at"], r["team"]))
    return rows


def injury_rows(inj):
    if inj is None or inj.empty:
        return []
    rows = []
    z = inj.sort_values(["date_modified", "season", "week", "team", "qb_id"])
    for r in z.itertuples(index=False):
        rows.append({
            "season": int(r.season),
            "week": int(r.week),
            "team": str(r.team),
            "qbId": str(r.qb_id),
            "modifiedAt": pd.Timestamp(r.date_modified).isoformat(),
            "reportStatus": scalar(getattr(r, "report_status", None)),
            "practiceStatus": scalar(getattr(r, "practice_status", None)),
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--end-season", type=int, default=2025)
    ap.add_argument("--compare-seasons", default="2024,2025")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h20-output")
    args = ap.parse_args()

    seasons = list(range(args.start_season, args.end_season + 1))
    compare_seasons = sorted({int(x.strip()) for x in args.compare_seasons.split(",") if x.strip()})
    if not compare_seasons:
        raise RuntimeError("R5H20 requires at least one comparison season")
    if any(y < args.start_season or y > args.end_season for y in compare_seasons):
        raise RuntimeError("R5H20 comparison season outside replay range")
    if len(REQUIRED_FEATURES) != 68 or len(set(REQUIRED_FEATURES)) != 68:
        raise RuntimeError("R5H20 frozen runtime feature contract changed")
    if any(any(token in f.lower() for token in FORBIDDEN) for f in REQUIRED_FEATURES):
        raise RuntimeError("R5H20 market feature entered runtime contract")

    cache = Path(args.cache_dir)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    games = base.schedule(cache, seasons)
    team_games, qb_games, _ = base.pbp_games(cache, seasons)
    old_depth, new_depth, _ = r5b.load_depth(cache, seasons)
    injuries, _ = r5b.load_injuries(cache, seasons)

    team_lk = {(str(r.game_id), str(r.team)): r._asdict() for r in team_games.itertuples(index=False)}
    qb_lk = {
        (str(gid), str(team)): z.copy()
        for (gid, team), z in qb_games.groupby(["game_id", "team"], sort=False)
    }

    replay_games = []
    for g in games.sort_values(["gameday", "game_id"]).itertuples(index=False):
        home = str(g.home_team)
        away = str(g.away_team)
        hm = team_lk.get((str(g.game_id), home), {})
        am = team_lk.get((str(g.game_id), away), {})
        qbs = []
        for team in [home, away]:
            z = qb_lk.get((str(g.game_id), team))
            if z is None or z.empty:
                continue
            for qr in z.sort_values(["qb_dropbacks", "qb_id"], ascending=[False, True]).itertuples(index=False):
                qbs.append({
                    "team": team,
                    "qbId": str(qr.qb_id),
                    "qbEpa": scalar(qr.qb_epa),
                    "qbCpoe": scalar(qr.qb_cpoe),
                    "qbSackRate": scalar(qr.qb_sack_rate),
                    "qbDropbacks": int(qr.qb_dropbacks),
                })
        replay_games.append({
            "gameId": str(g.game_id),
            "season": int(g.season),
            "week": int(g.week),
            "gameday": pd.Timestamp(g.gameday).strftime("%Y-%m-%d"),
            "homeTeam": home,
            "awayTeam": away,
            "observation": {
                "homeScore": scalar(g.home_score),
                "awayScore": scalar(g.away_score),
                "homeMetrics": finite_map(hm, TEAM_METRICS),
                "awayMetrics": finite_map(am, TEAM_METRICS),
                "quarterbacks": qbs,
            },
        })

    old_replay = old_depth[(old_depth.season >= min(compare_seasons) - 1) & (old_depth.season <= max(compare_seasons))].copy()
    new_replay = new_depth[(new_depth.season >= min(compare_seasons)) & (new_depth.season <= max(compare_seasons))].copy()
    inj_replay = injuries[injuries.season.isin(compare_seasons)].copy() if injuries is not None and not injuries.empty else pd.DataFrame()

    hybrid_path = Path(args.hybrid_dir) / "nfl_r5b_hybrid_dataset.parquet"
    if not hybrid_path.exists():
        raise RuntimeError(f"R5H20 missing hybrid dataset: {hybrid_path}")
    hybrid = pd.read_parquet(hybrid_path)
    missing = [c for c in REQUIRED_FEATURES if c not in hybrid.columns]
    if missing:
        raise RuntimeError(f"R5H20 hybrid dataset missing runtime features: {missing}")
    expected = hybrid[hybrid.season.isin(compare_seasons)].copy().sort_values(["season", "week", "game_id"])
    expected_rows = []
    for r in expected.itertuples(index=False):
        d = r._asdict()
        expected_rows.append({
            "gameId": str(d["game_id"]),
            "season": int(d["season"]),
            "week": int(d["week"]),
            "features": finite_map(d, REQUIRED_FEATURES),
        })

    payload = {
        "schemaVersion": SCHEMA,
        "sport": "NFL",
        "replayStartSeason": args.start_season,
        "replayEndSeason": args.end_season,
        "compareSeasons": compare_seasons,
        "runtimeFeatures": REQUIRED_FEATURES,
        "stateParameters": {
            "teamEwmaAlpha": 0.22,
            "opponentAdjustmentK": 0.20,
            "qbEwmaAlpha": 0.18,
            "seasonTeamMetricDecay": 0.70,
            "seasonPointsRegressWeight": 0.30,
            "seasonPointsAnchor": 22.5,
            "seasonOpponentAdjustmentDecay": 0.75,
            "seasonQbMetricDecay": 0.80,
            "strictTargetGamedayUpdatesForbidden": True,
        },
        "marketDataUsedAsFeature": False,
        "sameGameObservationAppliedBeforePregameSnapshot": False,
        "games": replay_games,
        "oldWeeklyDepth": group_old_depth(old_replay),
        "timestampedDepth": group_new_depth(new_replay),
        "injuries": injury_rows(inj_replay),
        "expectedRows": expected_rows,
    }
    payload["semanticDigest"] = canonical_digest(payload)

    json_path = out / "nfl_r5h20_pregame_materializer_replay.json.gz"
    with gzip.open(json_path, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump(payload, fh, sort_keys=True, separators=(",", ":"), allow_nan=False)

    summary = {
        "schemaVersion": SCHEMA,
        "semanticDigest": payload["semanticDigest"],
        "replayGames": len(replay_games),
        "expectedRows": len(expected_rows),
        "compareSeasons": compare_seasons,
        "runtimeFeatureCount": len(REQUIRED_FEATURES),
        "oldWeeklyDepthSnapshots": len(payload["oldWeeklyDepth"]),
        "timestampedDepthSnapshots": len(payload["timestampedDepth"]),
        "injuryUpdates": len(payload["injuries"]),
        "marketDataUsedAsFeature": False,
        "sameGameObservationAppliedBeforePregameSnapshot": False,
        "nextAction": "RUN_TYPESCRIPT_PREGAME_MATERIALIZER_REPLAY_PARITY",
    }
    (out / "nfl_r5h20_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print("NFL_R5H20_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H20_COMPLETE")


if __name__ == "__main__":
    main()
