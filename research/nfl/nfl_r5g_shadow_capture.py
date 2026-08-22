#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5b_qb_identity_availability as r5b
import nfl_r5b_hybrid as hy


TARGET_SEASON = 2026
SOURCE_MODEL = "R5B2_HICONF_SWITCH"


def canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha_obj(obj) -> str:
    return hashlib.sha256(canon(obj)).hexdigest()


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_number(v):
    if v is None:
        return None
    try:
        z = float(v)
    except Exception:
        return None
    return z if np.isfinite(z) else None


def load_lock(path: Path) -> dict:
    lock = json.loads(path.read_text(encoding="utf-8"))
    expected = lock.get("payloadSha256")
    payload = dict(lock)
    payload.pop("payloadSha256", None)
    actual = sha_obj(payload)
    if expected != actual:
        raise RuntimeError(f"model lock hash mismatch expected={expected} actual={actual}")
    if lock.get("sourceModel") != SOURCE_MODEL or lock.get("featureSetFrozen") is not True:
        raise RuntimeError("unexpected R5G lock source or feature state")
    if lock.get("marketDataUsedAsFeatures") is not False or lock.get("oddsAllowed") is not False:
        raise RuntimeError("market boundary failed in R5G model lock")
    if lock.get("modelRefitDuring2026Shadow") is not False:
        raise RuntimeError("R5G lock allows shadow refit")
    return lock


def target_schedule(cache: Path, target_date: pd.Timestamp, dry_run: bool):
    raw_path = base.dl(base.GAMES_URL, cache / "games.csv")
    g = pd.read_csv(raw_path, low_memory=False)
    needed = {"game_id", "season", "game_type", "week", "gameday", "away_team", "home_team", "away_score", "home_score"}
    miss = sorted(needed - set(g.columns))
    if miss:
        raise RuntimeError(f"schedule missing columns {miss}")
    z = g[list(needed)].copy()
    z["season"] = pd.to_numeric(z.season, errors="coerce")
    z["week"] = pd.to_numeric(z.week, errors="coerce")
    z["gameday"] = pd.to_datetime(z.gameday, errors="coerce")
    z = z[z.season.notna() & z.week.notna() & z.gameday.notna() & z.game_type.eq("REG")].copy()
    z["season"] = z.season.astype(int)
    z["week"] = z.week.astype(int)

    td = target_date.tz_localize(None).normalize()
    target = z[z.gameday.dt.normalize().eq(td)].copy()
    if not dry_run:
        target = target[target.season.eq(TARGET_SEASON)]
    if target.empty:
        raise RuntimeError(f"no regular-season target games on {td.date()}")

    hist = z[
        z.gameday.lt(td)
        & z.home_score.notna()
        & z.away_score.notna()
        & z.season.between(2012, int(target.season.max()))
    ].copy()

    target["home_score"] = np.nan
    target["away_score"] = np.nan
    allg = pd.concat([hist, target], ignore_index=True)
    allg["margin"] = pd.to_numeric(allg.home_score, errors="coerce") - pd.to_numeric(allg.away_score, errors="coerce")
    allg["game_total"] = pd.to_numeric(allg.home_score, errors="coerce") + pd.to_numeric(allg.away_score, errors="coerce")
    allg["home_win"] = np.where(allg.margin > 0, 1, np.where(allg.margin < 0, 0, np.nan))
    allg = allg.sort_values(["gameday", "game_id"]).reset_index(drop=True)
    target = target.sort_values(["gameday", "game_id"]).reset_index(drop=True)
    return allg, target, raw_path, z


def pbp_seasons(schedule_full: pd.DataFrame, target_date: pd.Timestamp, target_year: int) -> list[int]:
    years = list(range(2012, target_year))
    current_completed = schedule_full[
        schedule_full.season.eq(target_year)
        & schedule_full.gameday.lt(target_date.tz_localize(None).normalize())
        & schedule_full.home_score.notna()
        & schedule_full.away_score.notna()
    ]
    if not current_completed.empty:
        years.append(target_year)
    return years


def file_url(path: Path) -> str | None:
    n = path.name
    if n == "games.csv":
        return base.GAMES_URL
    if n.startswith("play_by_play_") and n.endswith(".parquet"):
        y = n.removeprefix("play_by_play_").removesuffix(".parquet")
        return base.PBP_URL.format(y=y)
    if n.startswith("depth_charts_") and n.endswith(".parquet"):
        y = n.removeprefix("depth_charts_").removesuffix(".parquet")
        return r5b.DEPTH_URL.format(y=y)
    if n.startswith("injuries_") and n.endswith(".parquet"):
        y = n.removeprefix("injuries_").removesuffix(".parquet")
        return r5b.INJURY_URL.format(y=y)
    return None


def source_manifest(cache: Path, cutoff: datetime, live: bool) -> dict:
    rows = []
    for p in sorted(cache.rglob("*")):
        if not p.is_file() or p.suffix not in {".csv", ".parquet"}:
            continue
        url = file_url(p)
        if url is None:
            continue
        mt = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        rows.append({
            "file": str(p.relative_to(cache)),
            "url": url,
            "retrievedAtUtcApprox": iso_utc(mt),
            "bytes": int(p.stat().st_size),
            "sha256": sha_file(p),
            "retrievedBeforeCutoff": bool(mt < cutoff),
        })
    if not rows:
        raise RuntimeError("no source custody files recorded")
    if live and not all(r["retrievedBeforeCutoff"] for r in rows):
        bad = [r["file"] for r in rows if not r["retrievedBeforeCutoff"]]
        raise RuntimeError(f"source retrieval after cutoff: {bad}")
    payload = {"sources": rows}
    payload["manifestSha256"] = sha_obj(payload)
    return payload


def apply_locked_model(spec: dict, raw: np.ndarray, probability: bool) -> float:
    x = np.asarray(raw, dtype=float).copy()
    med = np.asarray(spec["imputerMedian"], dtype=float)
    mean = np.asarray(spec["scalerMean"], dtype=float)
    scale = np.asarray(spec["scalerScale"], dtype=float)
    coef = np.asarray(spec["coefficient"], dtype=float)
    intercept = float(spec["intercept"][0])
    if not (len(x) == len(med) == len(mean) == len(scale) == len(coef)):
        raise RuntimeError("locked model dimension mismatch")
    miss = ~np.isfinite(x)
    x[miss] = med[miss]
    z = (x - mean) / scale
    raw_pred = float(np.dot(z, coef) + intercept)
    if probability:
        if raw_pred >= 0:
            e = math.exp(-raw_pred)
            return 1.0 / (1.0 + e)
        e = math.exp(raw_pred)
        return e / (1.0 + e)
    return raw_pred


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-date", required=True, help="YYYY-MM-DD target gameday")
    ap.add_argument("--model-lock", default="research/nfl/locks/nfl_r5g_2026_model_lock.json")
    ap.add_argument("--cache-dir", default=".cache/nfl-r5g-shadow")
    ap.add_argument("--out-dir", default="nfl-r5g-shadow-output")
    ap.add_argument("--dry-run", action="store_true", help="mechanical historical test only; never canonical")
    ap.add_argument("--code-commit", default=None)
    a = ap.parse_args()

    target_date = pd.Timestamp(a.target_date)
    if pd.isna(target_date):
        raise RuntimeError("invalid target date")
    cutoff = target_date.tz_localize("UTC").to_pydatetime()
    start = datetime.now(timezone.utc)
    live = not a.dry_run
    if live and start >= cutoff:
        raise RuntimeError("canonical R5G capture started at/after target-gameday cutoff")

    cache = Path(a.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    lock = load_lock(Path(a.model_lock))
    features = list(lock["features"])
    if len(features) != 32 or features != list(hy.feature_sets()[SOURCE_MODEL]):
        raise RuntimeError("R5G shadow feature vector differs from frozen R5B2 vector")

    games, target_games, schedule_path, schedule_full = target_schedule(cache, target_date, a.dry_run)
    target_year = int(target_games.season.max())
    if live and target_year != TARGET_SEASON:
        raise RuntimeError(f"live R5G shadow only supports {TARGET_SEASON}")

    pyears = pbp_seasons(schedule_full, target_date, target_year)
    team_games, qb_games, _ = base.pbp_games(cache, pyears)
    base_x = base.dataset(games, team_games, qb_games)

    depth_years = list(range(2012, target_year + 1))
    old_depth, new_depth, _ = r5b.load_depth(cache, depth_years)
    injuries, _ = r5b.load_injuries(cache, depth_years)
    qf = r5b.qb_features(games, qb_games, old_depth, new_depth, injuries)
    x = base_x.merge(qf, on=["game_id", "season", "week"], how="left", validate="one_to_one")
    x = hy.build_hybrids(x)

    ids = set(target_games.game_id.astype(str))
    tx = x[x.game_id.astype(str).isin(ids)].copy()
    if set(tx.game_id.astype(str)) != ids:
        missing = sorted(ids - set(tx.game_id.astype(str)))
        raise RuntimeError(f"target feature rows missing: {missing}")
    if any(c not in tx.columns for c in features):
        raise RuntimeError("target feature frame missing frozen features")

    meta = target_games[["game_id", "season", "week", "gameday", "home_team", "away_team"]].copy()
    tx["game_id"] = tx.game_id.astype(str)
    meta["game_id"] = meta.game_id.astype(str)
    tx = tx.merge(meta, on=["game_id", "season", "week"], how="left", validate="one_to_one")

    finished = datetime.now(timezone.utc)
    if live and finished >= cutoff:
        raise RuntimeError("R5G feature construction crossed target-gameday cutoff; canonical output forbidden")

    src = source_manifest(cache, cutoff, live)
    commit_sha = a.code_commit or os.environ.get("GITHUB_SHA") or "LOCAL_UNSPECIFIED"
    predictions = []
    qb_custody = []
    for r in tx.sort_values("game_id").itertuples(index=False):
        vals = np.array([safe_number(getattr(r, c)) if safe_number(getattr(r, c)) is not None else np.nan for c in features], dtype=float)
        p = apply_locked_model(lock["models"]["homeWinProbability"], vals, probability=True)
        pm = apply_locked_model(lock["models"]["margin"], vals, probability=False)
        pt = apply_locked_model(lock["models"]["gameTotal"], vals, probability=False)
        generated = datetime.now(timezone.utc)
        if live and generated >= cutoff:
            raise RuntimeError("R5G prediction generation crossed cutoff; canonical output forbidden")

        feature_map = {c: safe_number(getattr(r, c)) for c in features}
        payload = {
            "game_id": str(r.game_id),
            "season": int(r.season),
            "week": int(r.week),
            "gameday": str(pd.Timestamp(r.gameday).date()),
            "home_team": str(r.home_team),
            "away_team": str(r.away_team),
            "generated_at_utc": iso_utc(generated),
            "cutoff_utc": iso_utc(cutoff),
            "model_lock_sha256": lock["payloadSha256"],
            "code_commit_sha": commit_sha,
            "source_manifest_sha256": src["manifestSha256"],
            "home_win_probability": float(p),
            "predicted_margin": float(pm),
            "predicted_game_total": float(pt),
            "feature_vector": feature_map,
            "canonicalEligible": bool(live),
            "mode": "PROSPECTIVE_SHADOW" if live else "MECHANICAL_DRY_RUN_NOT_PROSPECTIVE",
        }
        payload["predictionPayloadSha256"] = sha_obj(payload)
        predictions.append(payload)

        qb_custody.append({
            "game_id": str(r.game_id),
            "home": {
                "qb_id": getattr(r, "home_r5b_qb_id", None),
                "source": getattr(r, "home_r5b_source", None),
                "source_asof": getattr(r, "home_r5b_source_asof", None),
                "qb1_out": int(getattr(r, "home_r5b_qb1_out", 0) or 0),
                "replacement_used": int(getattr(r, "home_r5b_replacement_used", 0) or 0),
                "changed_vs_last": int(getattr(r, "home_r5b_changed_vs_last", 0) or 0),
            },
            "away": {
                "qb_id": getattr(r, "away_r5b_qb_id", None),
                "source": getattr(r, "away_r5b_source", None),
                "source_asof": getattr(r, "away_r5b_source_asof", None),
                "qb1_out": int(getattr(r, "away_r5b_qb1_out", 0) or 0),
                "replacement_used": int(getattr(r, "away_r5b_replacement_used", 0) or 0),
                "changed_vs_last": int(getattr(r, "away_r5b_changed_vs_last", 0) or 0),
            },
        })

    batch = {
        "schemaVersion": "courtedge-nfl-r5g-shadow-batch.v1",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionUsed": False,
        "targetDate": str(target_date.date()),
        "cutoffUtc": iso_utc(cutoff),
        "modelLockSha256": lock["payloadSha256"],
        "sourceManifestSha256": src["manifestSha256"],
        "codeCommitSha": commit_sha,
        "canonicalEligible": bool(live),
        "mode": "PROSPECTIVE_SHADOW" if live else "MECHANICAL_DRY_RUN_NOT_PROSPECTIVE",
        "predictionCount": len(predictions),
        "predictions": predictions,
    }
    batch["batchPayloadSha256"] = sha_obj(batch)

    (out / "nfl_r5g_shadow_batch.json").write_text(json.dumps(batch, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5g_shadow_source_manifest.json").write_text(json.dumps(src, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5g_shadow_qb_custody.json").write_text(json.dumps(qb_custody, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("NFL_R5G_SHADOW_CAPTURE")
    print(json.dumps({
        "targetDate": batch["targetDate"],
        "mode": batch["mode"],
        "canonicalEligible": batch["canonicalEligible"],
        "predictionCount": batch["predictionCount"],
        "modelLockSha256": batch["modelLockSha256"],
        "sourceManifestSha256": batch["sourceManifestSha256"],
        "batchPayloadSha256": batch["batchPayloadSha256"],
    }, indent=2, sort_keys=True))
    print("NFL_R5G_SHADOW_CAPTURE_COMPLETE")


if __name__ == "__main__":
    main()
