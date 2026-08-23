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

MODEL = "R5H14_MARGINAL_EXPANSION_REPLICATION_CERTIFICATION"
SEED = 940830

# Frozen historical benchmark produced by the bounded R5H12 workflow.
EXPECTED_ALL_GAMES = 2117
EXPECTED_CORE_GAMES = 158
EXPECTED_CORE_WINS = 125
EXPECTED_H12_GAMES = 167
EXPECTED_H12_WINS = 133
EXPECTED_MARGINAL_GAMES = 9
EXPECTED_MARGINAL_WINS = 8

# Predeclared replication gates. These are deliberately stricter than simply
# observing a high pooled hit rate in one season.
MIN_DISTINCT_MARGINAL_SEASONS = 2
MIN_MEANINGFUL_MARGINAL_SEASONS = 2
MIN_MARGINAL_GAMES_PER_MEANINGFUL_SEASON = 3
MIN_TOTAL_MARGINAL_GAMES = 16
MAX_SINGLE_SEASON_SHARE = 0.70
MIN_MARGINAL_WILSON95_LOWER = 0.60
MIN_MEANINGFUL_SEASON_ACCURACY = 0.70
ALPHA = 0.05


def metric(df: pd.DataFrame, mask: np.ndarray) -> dict:
    return r5h6.metrics(df, np.asarray(mask, dtype=bool))


def safe_float(v):
    if v is None or not np.isfinite(v):
        return None
    return float(v)


def leave_one_season_out(pred: pd.DataFrame) -> pd.DataFrame:
    rows = []
    seasons = sorted(int(v) for v in pred.season.unique())
    for y in seasons:
        g = pred[pred.season != y].copy()
        sel = g.selected.to_numpy(dtype=bool)
        core = g.core_selected.to_numpy(dtype=bool)
        marg = g.marginal_selected.to_numpy(dtype=bool)
        matched = g.confidence_control_matched.to_numpy(dtype=bool)
        sm = metric(g, sel)
        cm = metric(g, core)
        mm = metric(g, marg)
        bm = metric(g, matched)
        rows.append({
            "excluded_season": int(y),
            "selected_games": sm["games"],
            "selected_accuracy": sm["accuracy"],
            "core_games": cm["games"],
            "core_accuracy": cm["accuracy"],
            "marginal_games": mm["games"],
            "marginal_accuracy": mm["accuracy"],
            "matched_conf_games": bm["games"],
            "matched_conf_accuracy": bm["accuracy"],
            "accuracy_delta_vs_core": float(sm["accuracy"] - cm["accuracy"]),
            "accuracy_delta_vs_matched_conf": float(sm["accuracy"] - bm["accuracy"]) if bm["games"] else np.nan,
        })
    return pd.DataFrame(rows)


def cluster_bootstrap_marginal_accuracy(pred: pd.DataFrame, reps: int = 10000) -> dict:
    z = pred[pred.marginal_selected.astype(bool)].copy()
    if z.empty:
        return {"games": 0, "clusters": 0, "accuracy": None, "ci95_low": None, "ci95_high": None, "reps": 0}
    z["correct"] = r5h6.correctness(z).astype(float)
    groups = [g.correct.to_numpy(dtype=float) for _, g in z.groupby(["season", "week"], sort=False)]
    sums = np.asarray([a.sum() for a in groups], dtype=float)
    ns = np.asarray([len(a) for a in groups], dtype=float)
    rng = np.random.default_rng(SEED)
    vals = np.empty(reps, dtype=float)
    for i in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        vals[i] = sums[ix].sum() / ns[ix].sum()
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {
        "games": int(len(z)),
        "clusters": int(len(groups)),
        "accuracy": float(z.correct.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "reps": int(reps),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h12-dir", default="nfl-r5h12-output")
    ap.add_argument("--out-dir", default="nfl-r5h14-output")
    a = ap.parse_args()

    src = Path(a.h12_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    pred = pd.read_parquet(src / "nfl_r5h12_predictions.parquet")
    h12_summary = json.loads((src / "nfl_r5h12_summary.json").read_text())
    h12_audit = json.loads((src / "nfl_r5h12_audit.json").read_text())
    h12_cfg = pd.read_csv(src / "nfl_r5h12_config_by_season.csv")

    required = {
        "season", "week", "y", "ref_p", "selected", "core_selected",
        "marginal_selected", "confidence_control_matched",
    }
    missing = sorted(required - set(pred.columns))
    if missing:
        raise RuntimeError(f"R5H14 missing R5H12 prediction columns: {missing}")

    sel = pred.selected.to_numpy(dtype=bool)
    core = pred.core_selected.to_numpy(dtype=bool)
    marg = pred.marginal_selected.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched.to_numpy(dtype=bool)
    sm = metric(pred, sel)
    cm = metric(pred, core)
    mm = metric(pred, marg)
    bm = metric(pred, matched)

    benchmark_exact = bool(
        len(pred) == EXPECTED_ALL_GAMES
        and cm["games"] == EXPECTED_CORE_GAMES
        and cm["wins"] == EXPECTED_CORE_WINS
        and sm["games"] == EXPECTED_H12_GAMES
        and sm["wins"] == EXPECTED_H12_WINS
        and mm["games"] == EXPECTED_MARGINAL_GAMES
        and mm["wins"] == EXPECTED_MARGINAL_WINS
    )
    if not benchmark_exact:
        raise RuntimeError(
            "R5H14 refused certification because the frozen R5H12 benchmark did not reproduce exactly: "
            f"all={len(pred)} core={cm} selected={sm} marginal={mm}"
        )

    if h12_audit.get("marketBoundary") != "PASS_MARKET_FREE":
        raise RuntimeError("R5H14 requires market-free R5H12 evidence")
    if bool(h12_summary.get("productionChanged")):
        raise RuntimeError("R5H14 requires research-only R5H12 evidence")

    season_rows = []
    for y, g in pred.groupby("season"):
        gm = metric(g, g.marginal_selected.to_numpy(dtype=bool))
        gc = metric(g, g.core_selected.to_numpy(dtype=bool))
        gs = metric(g, g.selected.to_numpy(dtype=bool))
        season_rows.append({
            "season": int(y),
            "marginal_games": gm["games"],
            "marginal_wins": gm["wins"],
            "marginal_losses": gm["losses"],
            "marginal_accuracy": gm["accuracy"],
            "core_games": gc["games"],
            "core_accuracy": gc["accuracy"],
            "combined_games": gs["games"],
            "combined_accuracy": gs["accuracy"],
        })
    by_season = pd.DataFrame(season_rows)

    active = by_season[by_season.marginal_games > 0].copy()
    meaningful = active[active.marginal_games >= MIN_MARGINAL_GAMES_PER_MEANINGFUL_SEASON].copy()
    distinct_seasons = int(len(active))
    meaningful_seasons = int(len(meaningful))
    if mm["games"] > 0:
        shares = active.marginal_games.to_numpy(dtype=float) / mm["games"]
        max_season_share = float(shares.max())
        season_hhi = float(np.square(shares).sum())
    else:
        max_season_share = 1.0
        season_hhi = 1.0

    marginal_wilson = float(r5h4.wilson_lower(mm["wins"], mm["games"]))
    core_accuracy = float(cm["accuracy"])
    exact_vs_core = binomtest(mm["wins"], mm["games"], p=core_accuracy, alternative="greater")
    marginal_boot = cluster_bootstrap_marginal_accuracy(pred)

    meaningful_accuracy_pass = bool(
        meaningful_seasons >= MIN_MEANINGFUL_MARGINAL_SEASONS
        and (meaningful.marginal_accuracy >= MIN_MEANINGFUL_SEASON_ACCURACY).all()
    )
    replication_volume_pass = bool(
        distinct_seasons >= MIN_DISTINCT_MARGINAL_SEASONS
        and meaningful_seasons >= MIN_MEANINGFUL_MARGINAL_SEASONS
        and mm["games"] >= MIN_TOTAL_MARGINAL_GAMES
    )
    concentration_pass = bool(max_season_share <= MAX_SINGLE_SEASON_SHARE)
    precision_pass = bool(marginal_wilson >= MIN_MARGINAL_WILSON95_LOWER)
    statistical_increment_pass = bool(float(exact_vs_core.pvalue) < ALPHA)

    replication_certified = bool(
        replication_volume_pass
        and concentration_pass
        and precision_pass
        and meaningful_accuracy_pass
        and statistical_increment_pass
    )

    loo = leave_one_season_out(pred)
    expansion_seasons = active.season.astype(int).tolist()
    loo_without_expansion = loo[loo.excluded_season.isin(expansion_seasons)]
    if len(loo_without_expansion):
        max_abs_lift_without_expansion = float(np.abs(loo_without_expansion.accuracy_delta_vs_core).max())
    else:
        max_abs_lift_without_expansion = np.nan

    ready_rows = h12_cfg[h12_cfg.get("calibration_ready", False) == True] if "calibration_ready" in h12_cfg.columns else pd.DataFrame()
    calibration_ready_seasons = int(len(ready_rows))
    target_addition_seasons = distinct_seasons
    activation_rate = float(target_addition_seasons / calibration_ready_seasons) if calibration_ready_seasons else 0.0

    verdict = "EXPANSION_REPLICATION_CERTIFIED" if replication_certified else "SINGLE_SEASON_PROMISING_NOT_REPLICATION_CERTIFIED"
    next_action = (
        "FREEZE_R5H12_AS_RESEARCH_LEADER_AND_REQUIRE_NEW_SEASON_REPLICATION_BEFORE_PROMOTION"
        if not replication_certified
        else "ELIGIBLE_FOR_INDEPENDENT_FINAL_CERTIFICATION"
    )

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "r5h12BenchmarkReproducedExactly": benchmark_exact,
        "allGames": int(len(pred)),
        "r5h8CoreGames": cm["games"],
        "r5h8CoreWins": cm["wins"],
        "r5h8CoreLosses": cm["losses"],
        "r5h8CoreAccuracy": cm["accuracy"],
        "r5h12SelectedGames": sm["games"],
        "r5h12SelectedWins": sm["wins"],
        "r5h12SelectedLosses": sm["losses"],
        "r5h12SelectedAccuracy": sm["accuracy"],
        "r5h12SelectedCoverage": float(sm["games"] / len(pred)),
        "matchedConfidenceControlGames": bm["games"],
        "matchedConfidenceControlAccuracy": bm["accuracy"],
        "marginalGames": mm["games"],
        "marginalWins": mm["wins"],
        "marginalLosses": mm["losses"],
        "marginalAccuracy": mm["accuracy"],
        "marginalWilson95Lower": marginal_wilson,
        "marginalClusterBootstrap": marginal_boot,
        "marginalExactOneSidedPValueVsCoreAccuracy": float(exact_vs_core.pvalue),
        "distinctOuterSeasonsWithMarginalAdds": distinct_seasons,
        "meaningfulOuterSeasonsWithAtLeast3MarginalAdds": meaningful_seasons,
        "largestSingleSeasonShareOfMarginalAdds": max_season_share,
        "marginalSeasonConcentrationHHI": season_hhi,
        "calibrationReadyOuterSeasons": calibration_ready_seasons,
        "outerSeasonsActuallyAddingGames": target_addition_seasons,
        "expansionActivationRateWhenCalibrationReady": activation_rate,
        "expansionSeasons": expansion_seasons,
        "replicationVolumeGate": replication_volume_pass,
        "concentrationGate": concentration_pass,
        "marginalPrecisionGate": precision_pass,
        "meaningfulSeasonAccuracyGate": meaningful_accuracy_pass,
        "statisticalIncrementGateVsCore": statistical_increment_pass,
        "replicationCertified": replication_certified,
        "leaveOneExpansionSeasonOutMaxAbsAccuracyLiftVsCore": safe_float(max_abs_lift_without_expansion),
        "verdict": verdict,
        "nextAction": next_action,
        "targetSeasonOutcomesUsedForModelOrThresholdSelection": False,
        "automaticProductionPromotion": False,
    }

    gates = pd.DataFrame([
        {"gate": "DISTINCT_MARGINAL_SEASONS", "required": f">={MIN_DISTINCT_MARGINAL_SEASONS}", "observed": distinct_seasons, "pass": distinct_seasons >= MIN_DISTINCT_MARGINAL_SEASONS},
        {"gate": "MEANINGFUL_MARGINAL_SEASONS", "required": f">={MIN_MEANINGFUL_MARGINAL_SEASONS} seasons with >={MIN_MARGINAL_GAMES_PER_MEANINGFUL_SEASON} games", "observed": meaningful_seasons, "pass": meaningful_seasons >= MIN_MEANINGFUL_MARGINAL_SEASONS},
        {"gate": "TOTAL_MARGINAL_GAMES", "required": f">={MIN_TOTAL_MARGINAL_GAMES}", "observed": mm["games"], "pass": mm["games"] >= MIN_TOTAL_MARGINAL_GAMES},
        {"gate": "MAX_SINGLE_SEASON_SHARE", "required": f"<={MAX_SINGLE_SEASON_SHARE}", "observed": max_season_share, "pass": concentration_pass},
        {"gate": "MARGINAL_WILSON95_LOWER", "required": f">={MIN_MARGINAL_WILSON95_LOWER}", "observed": marginal_wilson, "pass": precision_pass},
        {"gate": "MEANINGFUL_SEASON_ACCURACY", "required": f"all >={MIN_MEANINGFUL_SEASON_ACCURACY}", "observed": safe_float(float(meaningful.marginal_accuracy.min())) if len(meaningful) else None, "pass": meaningful_accuracy_pass},
        {"gate": "EXACT_INCREMENT_VS_CORE", "required": f"one-sided p<{ALPHA}", "observed": float(exact_vs_core.pvalue), "pass": statistical_increment_pass},
    ])

    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "inputStage": "R5H12_PROTOTYPE_SPECIFIC_ACCEPTANCE_BOUNDED_SEARCH",
        "r5h12BenchmarkExactReproduction": "PASS",
        "newModelFittingPerformedByR5H14": False,
        "newThresholdSearchPerformedByR5H14": False,
        "targetSeasonOutcomesUsedForModelSelection": "NO",
        "targetSeasonOutcomesUsedForThresholdSelection": "NO",
        "certificationUsesFrozenOutOfSamplePredictionsOnly": True,
        "replicationGatePredeclared": True,
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h14-marginal-replication-certification.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "input": "nfl_r5h12_predictions.parquet plus frozen R5H12 audit/config",
        "design": (
            "No new selector is fit. R5H14 stress-tests the frozen R5H12 marginal expansion for cross-season replication, "
            "sample precision, concentration, leave-one-season-out dependence, and exact incremental evidence versus the R5H8 core accuracy."
        ),
        "automaticProductionPromotion": False,
    }

    by_season.to_csv(out / "nfl_r5h14_marginal_by_season.csv", index=False)
    loo.to_csv(out / "nfl_r5h14_leave_one_season_out.csv", index=False)
    gates.to_csv(out / "nfl_r5h14_replication_gates.csv", index=False)
    (out / "nfl_r5h14_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h14_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h14_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H14_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H14_MARGINAL_BY_SEASON")
    print(by_season.to_string(index=False))
    print("NFL_R5H14_REPLICATION_GATES")
    print(gates.to_string(index=False))
    print("NFL_R5H14_LEAVE_ONE_SEASON_OUT")
    print(loo.to_string(index=False))
    print("NFL_R5H14_COMPLETE")


if __name__ == "__main__":
    main()
