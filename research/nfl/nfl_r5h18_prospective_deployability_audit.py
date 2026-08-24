#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h16_late_down_final_certification as r5h16

FAMILY = "LATE_DOWN_CONVERSION"
MODEL = "R5H18_PROSPECTIVE_DEPLOYABILITY_AUDIT"
POLICY = "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING"

THRESHOLD_MULTIPLIERS = (0.95, 1.00, 1.05)

# Reuse the already-declared H16 operational gate. H18 does not retune thresholds,
# invent a new signal, or optimize against target outcomes. It changes only the
# execution semantics that cannot exist prospectively: full-season top-score ranking.
MIN_MARGINAL_GAMES = r5h16.MIN_MARGINAL_GAMES
MIN_MARGINAL_ACC = r5h16.MIN_MARGINAL_ACC
MIN_ACTIVE_SEASONS = r5h16.MIN_ACTIVE_SEASONS
MIN_GAMES_PER_ACTIVE_SEASON = r5h16.MIN_GAMES_PER_ACTIVE_SEASON
MIN_ACTIVE_SEASON_ACC = r5h16.MIN_ACTIVE_SEASON_ACC
MIN_DELTA_EXACT_CONF = r5h16.MIN_DELTA_EXACT_CONF
MIN_COMBINED_ACC = r5h16.MIN_COMBINED_ACC
MIN_COMBINED_COVERAGE = r5h16.MIN_COMBINED_COVERAGE
MIN_THRESHOLD_SENSITIVITY_ACC = r5h16.MIN_THRESHOLD_SENSITIVITY_ACC
MAX_TEAM_SHARE = r5h16.MAX_TEAM_SHARE


def _enabled(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    if pd.isna(value):
        return False
    return bool(value)


def metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    return r5h6.metrics(df, np.asarray(mask, dtype=bool))


def threshold_only_mask(df: pd.DataFrame, cfg: pd.DataFrame, multiplier: float = 1.0) -> np.ndarray:
    """Apply only prior-season-frozen H15 thresholds; never rank against future target games."""
    score_col = f"support_score__{FAMILY}"
    score = df[score_col].to_numpy(dtype=float)
    core = df.core_selected.to_numpy(dtype=bool)
    seasons = df.season.to_numpy(dtype=int)
    out = np.zeros(len(df), dtype=bool)

    for y in sorted(int(v) for v in df.season.unique()):
        r = cfg[(cfg.test_season == y) & (cfg.family == FAMILY)]
        if r.empty or not _enabled(r.iloc[0].enabled):
            continue
        threshold = float(r.iloc[0].threshold) * float(multiplier)
        iy = seasons == y
        out |= iy & (~core) & np.isfinite(score) & (score > 0) & (score >= threshold)
    return out


def online_season_quota_mask(df: pd.DataFrame, cfg: pd.DataFrame, source: pd.DataFrame) -> np.ndarray:
    """Diagnostic only: first qualifying games chronologically until the known season quota is full.

    This is non-anticipative because no future game's support score participates in the choice.
    It is *not* the primary deployment policy and cannot rescue a failing threshold-only audit.
    """
    eligible = threshold_only_mask(df, cfg)
    joined = (
        df[["game_id", "season", "week"]]
        .reset_index(names="_row")
        .merge(source[["game_id", "gameday"]], on="game_id", how="left", validate="one_to_one")
    )
    if joined.gameday.isna().any():
        raise RuntimeError("R5H18 missing gameday for chronological quota audit")
    joined["gameday"] = pd.to_datetime(joined.gameday, errors="raise", utc=True)
    out = np.zeros(len(df), dtype=bool)

    for y in sorted(int(v) for v in df.season.unique()):
        iy = df.season.to_numpy(dtype=int) == y
        cap = max(1, int(np.floor(0.10 * int(iy.sum()))))
        candidates = joined[eligible[joined._row.to_numpy(dtype=int)] & joined.season.eq(y)].copy()
        candidates = candidates.sort_values(["gameday", "week", "game_id"], kind="stable")
        keep = candidates.head(cap)._row.to_numpy(dtype=int)
        out[keep] = True
    return out


def threshold_sensitivity(df: pd.DataFrame, cfg: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for mult in THRESHOLD_MULTIPLIERS:
        mask = threshold_only_mask(df, cfg, mult)
        rows.append({"threshold_multiplier": float(mult), **metrics(df, mask)})
    return pd.DataFrame(rows)


def by_season(df: pd.DataFrame, selected: np.ndarray, core: np.ndarray, exact: np.ndarray) -> pd.DataFrame:
    rows = []
    for y, g in df.groupby("season", sort=True):
        ix = df.index.get_indexer(g.index)
        ms = metrics(g, selected[ix])
        mc = metrics(g, core[ix])
        me = metrics(g, exact[ix])
        combined = core[ix] | selected[ix]
        mz = metrics(g, combined)
        rows.append({
            "season": int(y),
            "marginal_games": ms["games"],
            "marginal_wins": ms["wins"],
            "marginal_losses": ms["losses"],
            "marginal_accuracy": ms["accuracy"],
            "core_games": mc["games"],
            "core_accuracy": mc["accuracy"],
            "exact_conf_games": me["games"],
            "exact_conf_accuracy": me["accuracy"],
            "delta_vs_exact_conf": (
                float(ms["accuracy"] - me["accuracy"])
                if ms["games"] and me["games"] else np.nan
            ),
            "combined_games": mz["games"],
            "combined_accuracy": mz["accuracy"],
        })
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h15-dir", default="nfl-r5h15-output")
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h18-output")
    a = ap.parse_args()

    h15dir = Path(a.h15_dir)
    hybrid = Path(a.hybrid_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_parquet(h15dir / "nfl_r5h15_predictions.parquet").reset_index(drop=True)
    cfg = pd.read_csv(h15dir / "nfl_r5h15_config_by_season.csv")
    source = pd.read_parquet(hybrid / "nfl_r5b_hybrid_dataset.parquet")

    score_col = f"support_score__{FAMILY}"
    historical_col = f"selected__{FAMILY}"
    for col in ("game_id", "season", "week", "ref_p", "core_selected", score_col, historical_col):
        if col not in df.columns:
            raise RuntimeError(f"R5H18 missing required column {col}")

    core = df.core_selected.to_numpy(dtype=bool)
    historical_global_cap = df[historical_col].to_numpy(dtype=bool)
    deployable = threshold_only_mask(df, cfg)
    online_quota = online_season_quota_mask(df, cfg, source)

    # Custody assertions: H18 must start from the already-certified frozen chain.
    if int(core.sum()) != 158:
        raise RuntimeError(f"R5H18 protected R5H8 core drifted: {int(core.sum())}")
    if int(historical_global_cap.sum()) != 46:
        raise RuntimeError(
            f"R5H18 frozen H15/R5H16 marginal set drifted: {int(historical_global_cap.sum())}"
        )

    exact = r5h16.exact_confidence_match(df, deployable)
    sm = metrics(df, deployable)
    corem = metrics(df, core)
    em = metrics(df, exact)
    combined = core | deployable
    cm = metrics(df, combined)
    exact_delta = (
        float(sm["accuracy"] - em["accuracy"])
        if sm["games"] and em["games"] else float("nan")
    )
    boot = r5h16.cluster_bootstrap_delta(df, deployable, exact)

    by = by_season(df, deployable, core, exact)
    active = by[by.marginal_games > 0].copy()
    sens = threshold_sensitivity(df, cfg)
    conc = r5h16.team_concentration(df, deployable, source)
    max_team_share = float(conc.share_of_marginal_games.max()) if len(conc) else 0.0

    histm = metrics(df, historical_global_cap)
    onlinem = metrics(df, online_quota)
    overlap_hist = int((deployable & historical_global_cap).sum())
    only_deployable = int((deployable & ~historical_global_cap).sum())
    historical_not_deployable = int((historical_global_cap & ~deployable).sum())

    gates = {
        "marginalVolume": bool(sm["games"] >= MIN_MARGINAL_GAMES),
        "marginalAccuracy": bool(sm["games"] > 0 and sm["accuracy"] >= MIN_MARGINAL_ACC),
        "multiSeason": bool(len(active) >= MIN_ACTIVE_SEASONS),
        "eachActiveSeasonVolume": bool(
            len(active) >= MIN_ACTIVE_SEASONS
            and (active.marginal_games >= MIN_GAMES_PER_ACTIVE_SEASON).all()
        ),
        "eachActiveSeasonAccuracy": bool(
            len(active) >= MIN_ACTIVE_SEASONS
            and (active.marginal_accuracy >= MIN_ACTIVE_SEASON_ACC).all()
        ),
        "positiveExactConfidenceDelta": bool(
            np.isfinite(exact_delta) and exact_delta >= MIN_DELTA_EXACT_CONF
        ),
        "combinedBeatsR5H12Accuracy": bool(cm["accuracy"] >= MIN_COMBINED_ACC),
        "combinedBeatsR5H12Coverage": bool(
            cm["games"] / len(df) >= MIN_COMBINED_COVERAGE
        ),
        "thresholdSensitivity": bool(
            len(sens) == len(THRESHOLD_MULTIPLIERS)
            and (sens.games > 0).all()
            and (sens.accuracy >= MIN_THRESHOLD_SENSITIVITY_ACC).all()
        ),
        "teamConcentration": bool(max_team_share <= MAX_TEAM_SHARE),
        "noFutureTargetSeasonScoreRanking": True,
    }
    deployability_pass = bool(all(gates.values()))

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "family": FAMILY,
        "frozenFromR5H16": True,
        "productionPolicy": POLICY,
        "futureTargetSeasonFeatureRankingUsed": False,
        "historicalR5H15GlobalTopCapUsesWholeTargetSeasonScoreRanking": True,
        "r5h8CoreGames": corem["games"],
        "r5h8CoreWins": corem["wins"],
        "r5h8CoreLosses": corem["losses"],
        "r5h8CoreAccuracy": corem["accuracy"],
        "historicalFrozenMarginalGames": histm["games"],
        "historicalFrozenMarginalAccuracy": histm["accuracy"],
        "deployableMarginalGames": sm["games"],
        "deployableMarginalWins": sm["wins"],
        "deployableMarginalLosses": sm["losses"],
        "deployableMarginalAccuracy": sm["accuracy"],
        "deployableMarginalWilson95Lower": sm["wilson95_lower"],
        "exactConfidenceControlGames": em["games"],
        "exactConfidenceControlAccuracy": em["accuracy"],
        "deltaVsExactConfidenceControl": exact_delta,
        "clusterBootstrapVsExactConfidence": boot,
        "combinedGames": cm["games"],
        "combinedWins": cm["wins"],
        "combinedLosses": cm["losses"],
        "combinedAccuracy": cm["accuracy"],
        "combinedCoverage": float(cm["games"] / len(df)),
        "historicalOverlapGames": overlap_hist,
        "thresholdOnlyAdditionalGamesVsHistoricalCap": only_deployable,
        "historicalCapGamesMissingFromThresholdOnly": historical_not_deployable,
        "onlineQuotaDiagnosticGames": onlinem["games"],
        "onlineQuotaDiagnosticAccuracy": onlinem["accuracy"],
        "maxSingleTeamSideShare": max_team_share,
        "gates": gates,
        "prospectiveDeployabilityPass": deployability_pass,
        "automaticProductionPromotion": False,
        "nextAction": (
            "OPEN_PRODUCTION_INTEGRATION_FOR_R5H8_PLUS_THRESHOLD_ONLY_LATE_DOWN"
            if deployability_pass
            else "PRODUCTION_MAY_INTEGRATE_R5H8_CORE_ONLY_LATE_DOWN_REMAINS_SHADOW"
        ),
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "r5h8Core": "PASS_PROTECTED_158_GAMES",
        "r5h16FrozenMarginalCustody": "PASS_46_GAMES",
        "thresholdRetuning": "NONE",
        "targetOutcomeUsedForSelection": "NO",
        "futureTargetSeasonFeatureRanking": "REMOVED",
        "primaryDeploymentPolicy": POLICY,
        "onlineQuotaPolicy": "DIAGNOSTIC_ONLY_NOT_USED_TO_RESCUE_PRIMARY_GATE",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h18-prospective-deployability.v1",
        "family": FAMILY,
        "source": "frozen R5H15 predictions/config plus R5H16 operational gates",
        "primaryDeploymentPolicy": POLICY,
        "thresholdSensitivityMultipliers": list(THRESHOLD_MULTIPLIERS),
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "futureTargetSeasonFeatureRankingUsed": False,
        "automaticProductionPromotion": False,
    }

    by.to_csv(out / "nfl_r5h18_by_season.csv", index=False)
    sens.to_csv(out / "nfl_r5h18_threshold_sensitivity.csv", index=False)
    conc.to_csv(out / "nfl_r5h18_team_concentration.csv", index=False)
    df.loc[
        deployable,
        ["game_id", "season", "week", "ref_p", "core_selected", score_col, historical_col],
    ].to_csv(out / "nfl_r5h18_deployable_marginal_games.csv", index=False)
    (out / "nfl_r5h18_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )
    (out / "nfl_r5h18_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n"
    )
    (out / "nfl_r5h18_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )

    print("NFL_R5H18_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H18_BY_SEASON")
    print(by.to_string(index=False))
    print("NFL_R5H18_THRESHOLD_SENSITIVITY")
    print(sens.to_string(index=False))
    print("NFL_R5H18_COMPLETE")


if __name__ == "__main__":
    main()
