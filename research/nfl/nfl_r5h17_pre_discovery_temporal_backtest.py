#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import binomtest

import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6

FAMILY = "LATE_DOWN_CONVERSION"
MODEL = "R5H17_PRE_DISCOVERY_TEMPORAL_BACKTEST"
SEED = 940830
HOLDOUT_SEASONS = (2009, 2010, 2011)
ORIGINAL_R5_START = 2012
THRESHOLD_MULTIPLIERS = (0.95, 1.00, 1.05)

# Declared before reading H17 outcomes. This gate is deliberately operational,
# not a claim of guaranteed future accuracy.
MIN_MARGINAL_GAMES = 24
MIN_MARGINAL_ACC = 0.78
MIN_MARGINAL_WILSON = 0.60
MIN_ACTIVE_SEASONS = 2
MIN_GAMES_PER_ACTIVE_SEASON = 8
MIN_ACTIVE_SEASON_ACC = 0.70
MIN_DELTA_EXACT_CONF = 0.03
MIN_THRESHOLD_SENSITIVITY_ACC = 0.75
MAX_TEAM_SHARE = 0.35


def metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    return r5h6.metrics(df, np.asarray(mask, dtype=bool))


def correctness(df: pd.DataFrame) -> np.ndarray:
    return r5h6.correctness(df).astype(bool)


def exact_confidence_match(df: pd.DataFrame, selected: np.ndarray) -> np.ndarray:
    """Outcome-free 1:1 nearest-confidence control within each target season."""
    selected = np.asarray(selected, dtype=bool)
    out = np.zeros(len(df), dtype=bool)
    conf = np.abs(df.ref_p.to_numpy(dtype=float) - 0.5) * 2.0
    core = df.core_selected.to_numpy(dtype=bool)
    seasons = df.season.to_numpy(dtype=int)

    for y in sorted(np.unique(seasons)):
        sidx = np.flatnonzero((seasons == y) & selected)
        if len(sidx) == 0:
            continue
        pool = list(np.flatnonzero((seasons == y) & (~core) & (~selected)))
        if len(pool) < len(sidx):
            raise RuntimeError(f"R5H17 season {y}: insufficient exact-confidence control pool")
        sidx = sidx[np.argsort(-conf[sidx], kind="stable")]
        for i in sidx:
            arr = np.asarray(pool, dtype=int)
            j = int(np.argmin(np.abs(conf[arr] - conf[i])))
            chosen = int(arr[j])
            out[chosen] = True
            pool.remove(chosen)
    return out


def cluster_bootstrap_delta(df: pd.DataFrame, selected: np.ndarray, control: np.ndarray, reps: int = 20000) -> dict:
    selected = np.asarray(selected, dtype=bool)
    control = np.asarray(control, dtype=bool)
    corr = correctness(df).astype(float)
    groups = []
    for _, g in df.groupby(["season", "week"], sort=False):
        ix = df.index.get_indexer(g.index)
        groups.append((corr[ix][selected[ix]].sum(), selected[ix].sum(), corr[ix][control[ix]].sum(), control[ix].sum()))
    if not groups:
        return {"reps": 0, "mean_delta": None, "ci95_low": None, "ci95_high": None, "better95": False}
    arr = np.asarray(groups, dtype=float)
    rng = np.random.default_rng(SEED)
    vals = []
    for _ in range(reps):
        ii = rng.integers(0, len(arr), len(arr))
        a = arr[ii].sum(axis=0)
        if a[1] > 0 and a[3] > 0:
            vals.append(a[0] / a[1] - a[2] / a[3])
    if not vals:
        return {"reps": 0, "mean_delta": None, "ci95_low": None, "ci95_high": None, "better95": False}
    v = np.asarray(vals, dtype=float)
    lo, hi = np.quantile(v, [0.025, 0.975])
    return {
        "reps": int(len(v)),
        "mean_delta": float(v.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "better95": bool(lo > 0),
    }


def _enabled(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes"}
    if pd.isna(v):
        return False
    return bool(v)


def threshold_sensitivity(df: pd.DataFrame, cfg: pd.DataFrame) -> pd.DataFrame:
    rows = []
    score_col = f"support_score__{FAMILY}"
    score = df[score_col].to_numpy(dtype=float)
    core = df.core_selected.to_numpy(dtype=bool)
    seasons = df.season.to_numpy(dtype=int)

    for mult in THRESHOLD_MULTIPLIERS:
        mask = np.zeros(len(df), dtype=bool)
        for y in sorted(df.season.unique()):
            r = cfg[(cfg.test_season == int(y)) & (cfg.family == FAMILY)]
            if r.empty or not _enabled(r.iloc[0].enabled):
                continue
            thr = float(r.iloc[0].threshold) * float(mult)
            iy = seasons == int(y)
            eligible = iy & (~core) & np.isfinite(score) & (score > 0) & (score >= thr)
            cap = max(1, int(np.floor(0.10 * int(iy.sum()))))
            ix = np.flatnonzero(eligible)
            if len(ix) > cap:
                keep = ix[np.argsort(-score[ix], kind="stable")[:cap]]
                eligible[:] = False
                eligible[keep] = True
            mask |= eligible
        rows.append({"threshold_multiplier": float(mult), **metrics(df, mask)})
    return pd.DataFrame(rows)


def team_concentration(df: pd.DataFrame, selected: np.ndarray, source: pd.DataFrame) -> pd.DataFrame:
    z = df.loc[selected, ["game_id", "season", "week"]].merge(
        source[["game_id", "home_team", "away_team"]],
        on="game_id",
        how="left",
        validate="one_to_one",
    )
    rows = []
    n = len(z)
    for side in ("home_team", "away_team"):
        for team, g in z.groupby(side, dropna=True):
            rows.append({
                "team": str(team),
                "side": side,
                "games": int(len(g)),
                "share_of_marginal_games": float(len(g) / n) if n else 0.0,
            })
    if not rows:
        return pd.DataFrame(columns=["team", "side", "games", "share_of_marginal_games"])
    return pd.DataFrame(rows).sort_values(["games", "team"], ascending=[False, True])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h15-dir", default="nfl-r5h17-h15-output")
    ap.add_argument("--hybrid-dir", default="nfl-r5h17-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h17-output")
    a = ap.parse_args()

    h15dir = Path(a.h15_dir)
    hybrid = Path(a.hybrid_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_parquet(h15dir / "nfl_r5h15_predictions.parquet").reset_index(drop=True)
    cfg = pd.read_csv(h15dir / "nfl_r5h15_config_by_season.csv")
    source = pd.read_parquet(hybrid / "nfl_r5b_hybrid_dataset.parquet")

    actual_seasons = tuple(sorted(int(v) for v in df.season.unique()))
    if actual_seasons != HOLDOUT_SEASONS:
        raise RuntimeError(f"R5H17 expected untouched holdout {HOLDOUT_SEASONS}, got {actual_seasons}")

    scol = f"selected__{FAMILY}"
    score_col = f"support_score__{FAMILY}"
    for col in (scol, score_col, "core_selected", "ref_p"):
        if col not in df.columns:
            raise RuntimeError(f"R5H17 missing required H15 column: {col}")

    selected = df[scol].to_numpy(dtype=bool)
    core = df.core_selected.to_numpy(dtype=bool)
    combined = core | selected
    exact = exact_confidence_match(df, selected)

    sm = metrics(df, selected)
    corem = metrics(df, core)
    cm = metrics(df, combined)
    em = metrics(df, exact)
    exact_delta = float(sm["accuracy"] - em["accuracy"]) if sm["games"] and em["games"] else float("nan")
    boot = cluster_bootstrap_delta(df, selected, exact)

    rows = []
    active = []
    for y, g in df.groupby("season", sort=True):
        ix = df.index.get_indexer(g.index)
        ms = metrics(g, selected[ix])
        mc = metrics(g, core[ix])
        mx = metrics(g, exact[ix])
        mz = metrics(g, combined[ix])
        if ms["games"]:
            active.append(int(y))
        rows.append({
            "season": int(y),
            "marginal_games": ms["games"],
            "marginal_wins": ms["wins"],
            "marginal_losses": ms["losses"],
            "marginal_accuracy": ms["accuracy"],
            "core_games": mc["games"],
            "core_accuracy": mc["accuracy"],
            "exact_conf_games": mx["games"],
            "exact_conf_accuracy": mx["accuracy"],
            "delta_vs_exact_conf": (float(ms["accuracy"] - mx["accuracy"]) if ms["games"] and mx["games"] else np.nan),
            "combined_games": mz["games"],
            "combined_accuracy": mz["accuracy"],
        })
    by = pd.DataFrame(rows)
    active_df = by[by.marginal_games > 0].copy()

    sens = threshold_sensitivity(df, cfg)
    conc = team_concentration(df, selected, source)
    max_team_share = float(conc.share_of_marginal_games.max()) if len(conc) else 0.0

    p_core = float(corem["accuracy"]) if corem["games"] else 0.5
    exact_p = float(binomtest(sm["wins"], sm["games"], p=p_core, alternative="greater").pvalue) if sm["games"] else None

    gates = {
        "marginalVolume": bool(sm["games"] >= MIN_MARGINAL_GAMES),
        "marginalAccuracy": bool(sm["games"] > 0 and sm["accuracy"] >= MIN_MARGINAL_ACC),
        "marginalWilsonLower": bool(sm["games"] > 0 and sm["wilson95_lower"] >= MIN_MARGINAL_WILSON),
        "multiSeason": bool(len(active_df) >= MIN_ACTIVE_SEASONS),
        "eachActiveSeasonVolume": bool(len(active_df) >= MIN_ACTIVE_SEASONS and (active_df.marginal_games >= MIN_GAMES_PER_ACTIVE_SEASON).all()),
        "eachActiveSeasonAccuracy": bool(len(active_df) >= MIN_ACTIVE_SEASONS and (active_df.marginal_accuracy >= MIN_ACTIVE_SEASON_ACC).all()),
        "positiveExactConfidenceDelta": bool(np.isfinite(exact_delta) and exact_delta >= MIN_DELTA_EXACT_CONF),
        "combinedNonDegradingAccuracy": bool(corem["games"] > 0 and cm["accuracy"] >= corem["accuracy"]),
        "combinedExpandsCoverage": bool(cm["games"] > corem["games"]),
        "thresholdSensitivity": bool(len(sens) == len(THRESHOLD_MULTIPLIERS) and (sens.games > 0).all() and (sens.accuracy >= MIN_THRESHOLD_SENSITIVITY_ACC).all()),
        "teamConcentration": bool(max_team_share <= MAX_TEAM_SHARE),
    }
    historical_pass = bool(all(gates.values()))

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "family": FAMILY,
        "preDiscoveryHoldout": True,
        "holdoutSeasons": list(HOLDOUT_SEASONS),
        "originalR5UniverseStartSeason": ORIGINAL_R5_START,
        "holdoutOutcomesUsedByR5H15Discovery": False,
        "allGames": int(len(df)),
        "activeSeasons": active,
        "coreGames": corem["games"],
        "coreWins": corem["wins"],
        "coreLosses": corem["losses"],
        "coreAccuracy": corem["accuracy"],
        "marginalGames": sm["games"],
        "marginalWins": sm["wins"],
        "marginalLosses": sm["losses"],
        "marginalAccuracy": sm["accuracy"],
        "marginalWilson95Lower": sm["wilson95_lower"],
        "exactConfidenceControlGames": em["games"],
        "exactConfidenceControlAccuracy": em["accuracy"],
        "deltaVsExactConfidenceControl": exact_delta,
        "clusterBootstrapVsExactConfidence": boot,
        "oneSidedExactPVsEraCoreRate": exact_p,
        "combinedGames": cm["games"],
        "combinedWins": cm["wins"],
        "combinedLosses": cm["losses"],
        "combinedAccuracy": cm["accuracy"],
        "combinedCoverage": float(cm["games"] / len(df)) if len(df) else 0.0,
        "coreCoverage": float(corem["games"] / len(df)) if len(df) else 0.0,
        "maxSingleTeamSideShare": max_team_share,
        "gates": gates,
        "historicalProductionReadinessPass": historical_pass,
        "automaticProductionPromotion": False,
        "nextAction": (
            "OPEN_SEPARATE_PRODUCTION_INTEGRATION_STAGE_FOR_FROZEN_R5H16_ROUTE"
            if historical_pass
            else "DO_NOT_PROMOTE_R5H16_ROUTE_FROM_H17_BACKTEST"
        ),
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "holdoutBoundary": "PASS_2009_2011_PRECEDES_ORIGINAL_R5_START_2012",
        "targetSeasonTraining": "EXPANDING_PRIOR_SEASONS_ONLY",
        "targetSeasonThresholdCalibration": "LATEST_TWO_PRIOR_OOS_SEASONS_ONLY",
        "sameGameFeatureLeakage": "FORBIDDEN_BY_H15_PREGAME_SNAPSHOT_CUSTODY",
        "injuryAvailability": "NFLVERSE_INJURY_REPORTS_USED_2009_PLUS_ONLY_NO_PRE2009_INJURY_DATA_INVENTED",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h17-pre-discovery-temporal-backtest.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "holdoutSeasons": list(HOLDOUT_SEASONS),
        "historyStartSeason": 2001,
        "expertOosStartSeason": 2004,
        "family": FAMILY,
        "thresholdSensitivityMultipliers": list(THRESHOLD_MULTIPLIERS),
        "automaticProductionPromotion": False,
    }

    by.to_csv(out / "nfl_r5h17_by_season.csv", index=False)
    sens.to_csv(out / "nfl_r5h17_threshold_sensitivity.csv", index=False)
    conc.to_csv(out / "nfl_r5h17_team_concentration.csv", index=False)
    df.loc[selected, ["game_id", "season", "week", "ref_p", scol, score_col]].to_csv(out / "nfl_r5h17_marginal_games.csv", index=False)
    (out / "nfl_r5h17_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h17_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h17_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H17_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H17_BY_SEASON")
    print(by.to_string(index=False))
    print("NFL_R5H17_THRESHOLD_SENSITIVITY")
    print(sens.to_string(index=False))
    print("NFL_R5H17_COMPLETE")


if __name__ == "__main__":
    main()
