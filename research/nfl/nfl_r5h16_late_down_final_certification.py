#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import binomtest

import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6

FAMILY = "LATE_DOWN_CONVERSION"
MODEL = "R5H16_LATE_DOWN_FINAL_CERTIFICATION"
SEED = 940830
R5H12_ACC = 0.7964071856287425
R5H12_GAMES = 167
R5H12_COVERAGE = 0.0788852158715163

# Final operational gate. This is intentionally finite: if the frozen R5H15
# late-down signal clears these robustness checks, the next action is production
# integration, not another historical reweighting stage.
MIN_MARGINAL_GAMES = 40
MIN_MARGINAL_ACC = 0.82
MIN_ACTIVE_SEASONS = 2
MIN_GAMES_PER_ACTIVE_SEASON = 15
MIN_ACTIVE_SEASON_ACC = 0.78
MIN_DELTA_EXACT_CONF = 0.03
MIN_COMBINED_ACC = R5H12_ACC
MIN_COMBINED_COVERAGE = R5H12_COVERAGE
MIN_THRESHOLD_SENSITIVITY_ACC = 0.78
MAX_TEAM_SHARE = 0.35
THRESHOLD_MULTIPLIERS = (0.95, 1.00, 1.05)


def correctness(df: pd.DataFrame) -> np.ndarray:
    return r5h6.correctness(df).astype(bool)


def metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    return r5h6.metrics(df, np.asarray(mask, dtype=bool))


def exact_confidence_match(df: pd.DataFrame, selected: np.ndarray) -> np.ndarray:
    """Outcome-free 1:1 nearest-confidence control within each target season.

    Matches each selected residual game to one non-selected residual game using only
    |ref_p-0.5|, without replacement. This is stricter than H15's stratum diagnostic
    because the control has exactly the same game count in every active season.
    """
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
            raise RuntimeError(f"R5H16 season {y}: insufficient exact-confidence control pool")
        # Hardest-to-match first reduces greedy edge effects.
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
    arr = np.asarray(groups, dtype=float)
    rng = np.random.default_rng(SEED)
    vals = []
    for _ in range(reps):
        ii = rng.integers(0, len(arr), len(arr))
        a = arr[ii].sum(axis=0)
        if a[1] > 0 and a[3] > 0:
            vals.append(a[0] / a[1] - a[2] / a[3])
    v = np.asarray(vals, dtype=float)
    lo, hi = np.quantile(v, [0.025, 0.975])
    return {
        "reps": int(len(v)),
        "mean_delta": float(v.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "better95": bool(lo > 0),
    }


def threshold_sensitivity(df: pd.DataFrame, cfg: pd.DataFrame) -> pd.DataFrame:
    rows = []
    score_col = f"support_score__{FAMILY}"
    core = df.core_selected.to_numpy(dtype=bool)
    score = df[score_col].to_numpy(dtype=float)
    for mult in THRESHOLD_MULTIPLIERS:
        mask = np.zeros(len(df), dtype=bool)
        for y in sorted(df.season.unique()):
            r = cfg[(cfg.test_season == int(y)) & (cfg.family == FAMILY) & (cfg.enabled.astype(bool))]
            if r.empty:
                continue
            thr = float(r.iloc[0].threshold) * float(mult)
            iy = df.season.to_numpy(dtype=int) == int(y)
            eligible = iy & (~core) & np.isfinite(score) & (score > 0) & (score >= thr)
            # Preserve the original H15 10% per-target-season cap, ranking by frozen support score.
            cap = max(1, int(np.floor(0.10 * int(iy.sum()))))
            ix = np.flatnonzero(eligible)
            if len(ix) > cap:
                keep = ix[np.argsort(-score[ix], kind="stable")[:cap]]
                eligible[:] = False
                eligible[keep] = True
            mask |= eligible
        m = metrics(df, mask)
        rows.append({"threshold_multiplier": float(mult), **m})
    return pd.DataFrame(rows)


def leave_one_week_out(df: pd.DataFrame, selected: np.ndarray) -> pd.DataFrame:
    rows = []
    selected = np.asarray(selected, dtype=bool)
    for (y, w), _ in df[selected].groupby(["season", "week"], sort=True):
        keep = selected & ~((df.season.to_numpy(dtype=int) == int(y)) & (df.week.to_numpy(dtype=int) == int(w)))
        m = metrics(df, keep)
        rows.append({"left_out_season": int(y), "left_out_week": int(w), **m})
    return pd.DataFrame(rows)


def team_concentration(df: pd.DataFrame, selected: np.ndarray, source: pd.DataFrame) -> pd.DataFrame:
    z = df.loc[selected, ["game_id", "season", "week"]].merge(
        source[["game_id", "home_team", "away_team"]], on="game_id", how="left", validate="one_to_one"
    )
    rows = []
    n = len(z)
    for side in ("home_team", "away_team"):
        for team, g in z.groupby(side, dropna=True):
            rows.append({"team": str(team), "side": side, "games": int(len(g)), "share_of_marginal_games": float(len(g) / n) if n else 0.0})
    return pd.DataFrame(rows).sort_values(["games", "team"], ascending=[False, True]) if rows else pd.DataFrame(columns=["team", "side", "games", "share_of_marginal_games"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h15-dir", default="nfl-r5h15-output")
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h16-output")
    a = ap.parse_args()

    h15dir, hybrid, out = Path(a.h15_dir), Path(a.hybrid_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(h15dir / "nfl_r5h15_predictions.parquet").reset_index(drop=True)
    cfg = pd.read_csv(h15dir / "nfl_r5h15_config_by_season.csv")
    source = pd.read_parquet(hybrid / "nfl_r5b_hybrid_dataset.parquet")

    scol = f"selected__{FAMILY}"
    if scol not in df.columns:
        raise RuntimeError(f"R5H16 missing frozen H15 selection column {scol}")
    selected = df[scol].to_numpy(dtype=bool)
    core = df.core_selected.to_numpy(dtype=bool)
    if int(core.sum()) != 158:
        raise RuntimeError(f"R5H16 protected R5H8 core drifted: {int(core.sum())}")

    sm = metrics(df, selected)
    corem = metrics(df, core)
    combined = core | selected
    cm = metrics(df, combined)
    exact = exact_confidence_match(df, selected)
    em = metrics(df, exact)
    exact_delta = float(sm["accuracy"] - em["accuracy"])
    boot = cluster_bootstrap_delta(df, selected, exact)

    by_season = []
    active_seasons = []
    for y, g in df.groupby("season", sort=True):
        ix = df.index.get_indexer(g.index)
        ms = metrics(g, selected[ix])
        me = metrics(g, exact[ix])
        mc = metrics(g, combined[ix])
        if ms["games"]:
            active_seasons.append(int(y))
        by_season.append({
            "season": int(y),
            "marginal_games": ms["games"],
            "marginal_wins": ms["wins"],
            "marginal_losses": ms["losses"],
            "marginal_accuracy": ms["accuracy"],
            "exact_conf_games": me["games"],
            "exact_conf_accuracy": me["accuracy"],
            "delta_vs_exact_conf": (float(ms["accuracy"] - me["accuracy"]) if ms["games"] and me["games"] else np.nan),
            "combined_games": mc["games"],
            "combined_accuracy": mc["accuracy"],
        })
    bydf = pd.DataFrame(by_season)
    active = bydf[bydf.marginal_games > 0].copy()

    sens = threshold_sensitivity(df, cfg)
    loo = leave_one_week_out(df, selected)
    conc = team_concentration(df, selected, source)
    max_team_share = float(conc.share_of_marginal_games.max()) if len(conc) else 0.0

    # Frozen-signal exact binomial diagnostic versus protected-core historical accuracy.
    p_core = float(corem["accuracy"])
    exact_p = float(binomtest(sm["wins"], sm["games"], p=p_core, alternative="greater").pvalue)

    gates = {
        "marginalVolume": bool(sm["games"] >= MIN_MARGINAL_GAMES),
        "marginalAccuracy": bool(sm["accuracy"] >= MIN_MARGINAL_ACC),
        "multiSeason": bool(len(active) >= MIN_ACTIVE_SEASONS),
        "eachActiveSeasonVolume": bool(len(active) >= MIN_ACTIVE_SEASONS and (active.marginal_games >= MIN_GAMES_PER_ACTIVE_SEASON).all()),
        "eachActiveSeasonAccuracy": bool(len(active) >= MIN_ACTIVE_SEASONS and (active.marginal_accuracy >= MIN_ACTIVE_SEASON_ACC).all()),
        "positiveExactConfidenceDelta": bool(exact_delta >= MIN_DELTA_EXACT_CONF),
        "combinedBeatsR5H12Accuracy": bool(cm["accuracy"] >= MIN_COMBINED_ACC),
        "combinedBeatsR5H12Coverage": bool(cm["games"] / len(df) >= MIN_COMBINED_COVERAGE),
        "thresholdSensitivity": bool((sens.accuracy >= MIN_THRESHOLD_SENSITIVITY_ACC).all()),
        "teamConcentration": bool(max_team_share <= MAX_TEAM_SHARE),
    }
    operational_pass = bool(all(gates.values()))

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "family": FAMILY,
        "frozenFromR5H15": True,
        "allGames": int(len(df)),
        "r5h8CoreGames": corem["games"],
        "r5h8CoreWins": corem["wins"],
        "r5h8CoreLosses": corem["losses"],
        "r5h8CoreAccuracy": corem["accuracy"],
        "marginalGames": sm["games"],
        "marginalWins": sm["wins"],
        "marginalLosses": sm["losses"],
        "marginalAccuracy": sm["accuracy"],
        "marginalWilson95Lower": sm["wilson95_lower"],
        "activeSeasons": active_seasons,
        "exactConfidenceControlGames": em["games"],
        "exactConfidenceControlAccuracy": em["accuracy"],
        "deltaVsExactConfidenceControl": exact_delta,
        "clusterBootstrapVsExactConfidence": boot,
        "oneSidedExactPVsR5H8CoreRate": exact_p,
        "combinedGames": cm["games"],
        "combinedWins": cm["wins"],
        "combinedLosses": cm["losses"],
        "combinedAccuracy": cm["accuracy"],
        "combinedCoverage": float(cm["games"] / len(df)),
        "r5h12BenchmarkGames": R5H12_GAMES,
        "r5h12BenchmarkAccuracy": R5H12_ACC,
        "r5h12BenchmarkCoverage": R5H12_COVERAGE,
        "maxSingleTeamSideShare": max_team_share,
        "gates": gates,
        "operationalCertificationPass": operational_pass,
        "statistical95SuperiorityRequiredForOperationalGate": False,
        "automaticProductionPromotion": False,
        "nextAction": "PROMOTE_FROZEN_LATE_DOWN_ROUTE_TO_PRODUCTION_INTEGRATION_NO_MORE_HISTORICAL_REWEIGHTING" if operational_pass else "DO_NOT_PROMOTE_LATE_DOWN_ROUTE",
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonRetuning": "NONE_R5H15_SELECTIONS_AND_THRESHOLDS_FROZEN",
        "outcomesUsedToAlterFrozenSelections": "NO",
        "exactConfidenceControl": "OUTCOME_FREE_ONE_TO_ONE_WITHIN_TARGET_SEASON",
        "protectedCore": "PASS_R5H8_CORE_UNCHANGED",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h16-late-down-final-certification.v1",
        "family": FAMILY,
        "source": "frozen R5H15 OOS predictions and thresholds",
        "thresholdSensitivityMultipliers": list(THRESHOLD_MULTIPLIERS),
        "operationalGate": gates,
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "automaticProductionPromotion": False,
    }

    bydf.to_csv(out / "nfl_r5h16_by_season.csv", index=False)
    sens.to_csv(out / "nfl_r5h16_threshold_sensitivity.csv", index=False)
    loo.to_csv(out / "nfl_r5h16_leave_one_week_out.csv", index=False)
    conc.to_csv(out / "nfl_r5h16_team_concentration.csv", index=False)
    df.loc[selected, ["game_id", "season", "week", "ref_p", scol, f"support_score__{FAMILY}"]].to_csv(out / "nfl_r5h16_frozen_marginal_games.csv", index=False)
    (out / "nfl_r5h16_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h16_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h16_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H16_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H16_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H16_THRESHOLD_SENSITIVITY")
    print(sens.to_string(index=False))
    print("NFL_R5H16_TEAM_CONCENTRATION_TOP")
    print(conc.head(20).to_string(index=False))
    print("NFL_R5H16_COMPLETE")


if __name__ == "__main__":
    main()
