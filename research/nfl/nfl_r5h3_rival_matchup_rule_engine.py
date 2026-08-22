#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss

import nfl_r5h_contextual_rule_weighting as r5h


REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H3_RIVAL_MATCHUP_RULE_ENGINE"


def expanded_rule_blocks() -> dict[str, list[str]]:
    return {
        "SCORING_FORM": [
            "home_points_for", "home_points_against", "away_points_for", "away_points_against",
        ],
        "TEAM_UNCERTAINTY": ["home_uncertainty", "away_uncertainty"],
        "EPA_CORE": ["home_off_epa", "home_def_epa", "away_off_epa", "away_def_epa"],
        "SUCCESS_CORE": ["home_off_success", "home_def_success", "away_off_success", "away_def_success"],
        "PASS_MATCHUP": [
            "home_pass_epa", "home_def_pass_epa", "away_pass_epa", "away_def_pass_epa",
            "home_pass_success", "home_def_pass_success", "away_pass_success", "away_def_pass_success",
        ],
        "RUSH_MATCHUP": [
            "home_rush_epa", "home_def_rush_epa", "away_rush_epa", "away_def_rush_epa",
            "home_rush_success", "home_def_rush_success", "away_rush_success", "away_def_rush_success",
        ],
        "SACK_PRESSURE_MATCHUP": [
            "home_sack_rate", "home_def_sack_rate", "away_sack_rate", "away_def_sack_rate",
        ],
        "EXPLOSIVE_PASS_MATCHUP": [
            "home_explosive_pass", "home_def_explosive_pass", "away_explosive_pass", "away_def_explosive_pass",
        ],
        "EXPLOSIVE_RUSH_MATCHUP": [
            "home_explosive_rush", "home_def_explosive_rush", "away_explosive_rush", "away_def_explosive_rush",
        ],
        "OPPONENT_ADJUSTED_CORE": ["home_oa_off", "home_oa_def", "away_oa_off", "away_oa_def"],
        "OPPONENT_ADJUSTED_PASS": [
            "home_oa_pass_off", "home_oa_pass_def", "away_oa_pass_off", "away_oa_pass_def",
        ],
        "PACE_DRIVES": ["home_plays", "home_drives", "away_plays", "away_drives"],
        "QB_EPA": ["home_r5b2_hi_epa", "away_r5b2_hi_epa"],
        "QB_CPOE": ["home_r5b2_hi_cpoe", "away_r5b2_hi_cpoe"],
        "QB_SACK": ["home_r5b2_hi_sack_rate", "away_r5b2_hi_sack_rate"],
        "QB_UNCERTAINTY": ["home_r5b2_hi_uncertainty", "away_r5b2_hi_uncertainty"],
        "QB_AVAILABILITY_SWITCH": [
            "home_r5b2_out_switch", "home_r5b2_ts_switch", "home_r5b2_hi_switch",
            "away_r5b2_out_switch", "away_r5b2_ts_switch", "away_r5b2_hi_switch",
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h3-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()

    blocks = expanded_rule_blocks()
    missing = {r: [c for c in cols if c not in x.columns] for r, cols in blocks.items()}
    missing = {r: cols for r, cols in missing.items() if cols}
    if missing:
        raise RuntimeError(f"R5H3 missing matchup inputs: {missing}")

    # Reuse the leakage-safe nested R5H mechanics, but swap in the broader sports-only rivalry rule library.
    r5h.rule_blocks = expanded_rule_blocks
    experts, tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)

    ref = pd.read_parquet(src / "nfl_r5b_hybrid_predictions.parquet")
    ref = ref[ref.model.eq(REFERENCE)][["game_id", "season", "week", "y", "p"]].copy()
    ref = ref.rename(columns={"p": "ref_p"})

    pred_rows, configs, thresholds = [], [], {}
    for y in range(a.test_start, a.end_season + 1):
        mt = experts[experts.season < y].copy()
        te = experts[experts.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, val_pred = r5h.choose_config(mt)
        p, grouped, shares = r5h.fit_predict_outer(mt, te, cfg)
        z = r5h.add_context(te, cfg["selectedRules"])
        elite = np.abs(p - .5) * 2.0 * (0.5 + 0.5 * z.ctx_raw_agreement.to_numpy(dtype=float))

        q = te[["game_id", "season", "week", "y"]].copy()
        q["model"] = MODEL
        q["p"] = p
        q["selected_rules"] = "+".join(cfg["selectedRules"])
        q["mode"] = cfg["mode"]
        q["agreement"] = z.ctx_raw_agreement.to_numpy(dtype=float)
        q["elite_score"] = elite
        for rr in blocks:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_selected__{rr}"] = int(rr in cfg["selectedRules"])
            q[f"rule_contribution__{rr}"] = grouped[rr] if rr in grouped else 0.0
            q[f"rule_weight_share__{rr}"] = shares[rr] if rr in shares else 0.0
        pred_rows.append(q)

        configs.append({
            "test_season": y,
            "mode": cfg["mode"],
            "C": cfg["C"],
            "selected_rules": "+".join(cfg["selectedRules"]),
            "n_rules": len(cfg["selectedRules"]),
            "inner_accuracy": cfg["accuracy"],
            "inner_log_loss": cfg["log_loss"],
            "inner_brier": cfg["brier"],
            "inner_fit_seasons": "+".join(map(str, cfg["innerFitSeasons"])),
            "inner_validation_seasons": "+".join(map(str, cfg["innerValidationSeasons"])),
        })

        vals = val_pred.elite_score.to_numpy(dtype=float)
        for target in r5h.COVERAGE_TARGETS:
            thresholds[(int(y), float(target))] = -np.inf if target >= 1 else float(np.quantile(vals, 1.0 - target))

    pred = pd.concat(pred_rows, ignore_index=True)
    joined = pred.merge(ref[["game_id", "ref_p"]], on="game_id", validate="one_to_one")
    cand = {
        "accuracy": float(accuracy_score(joined.y, joined.p >= .5)),
        "log_loss": float(log_loss(joined.y, joined.p)),
        "brier": float(brier_score_loss(joined.y, joined.p)),
    }
    rmet = {
        "accuracy": float(accuracy_score(joined.y, joined.ref_p >= .5)),
        "log_loss": float(log_loss(joined.y, joined.ref_p)),
        "brier": float(brier_score_loss(joined.y, joined.ref_p)),
    }
    boot = r5h.cluster_bootstrap_accuracy(joined)
    coverage = r5h.coverage_rows(pred, ref, thresholds)

    by = []
    for y, g in joined.groupby("season"):
        cc = ((g.p >= .5).astype(int) == g.y.astype(int))
        rc = ((g.ref_p >= .5).astype(int) == g.y.astype(int))
        by.append({
            "season": int(y), "games": int(len(g)),
            "candidate_accuracy": float(cc.mean()), "reference_accuracy": float(rc.mean()),
            "accuracy_delta": float(cc.mean() - rc.mean()),
            "candidate_log_loss": float(log_loss(g.y, g.p)), "reference_log_loss": float(log_loss(g.y, g.ref_p)),
        })

    cov_by = []
    for target in r5h.COVERAGE_TARGETS:
        for y, g in joined.groupby("season"):
            thr = thresholds[(int(y), float(target))]
            q = g if target >= 1 else g[g.elite_score >= thr]
            if q.empty:
                continue
            cc = ((q.p >= .5).astype(int) == q.y.astype(int))
            rc = ((q.ref_p >= .5).astype(int) == q.y.astype(int))
            cov_by.append({
                "target_coverage": float(target), "season": int(y), "games": int(len(q)),
                "candidate_accuracy": float(cc.mean()), "reference_accuracy_same_games": float(rc.mean()),
                "accuracy_delta_same_games": float(cc.mean() - rc.mean()),
            })

    freq = []
    cfgdf = pd.DataFrame(configs)
    for rr in blocks:
        n = int(cfgdf.selected_rules.fillna("").str.split("+").map(lambda z: rr in z).sum())
        freq.append({"rule": rr, "selected_outer_seasons": n, "selection_rate": float(n / len(cfgdf))})
    freqdf = pd.DataFrame(freq).sort_values(["selected_outer_seasons", "rule"], ascending=[False, True])

    summary = pd.DataFrame([
        {"model": REFERENCE, "games": len(joined), **rmet},
        {"model": MODEL, "games": len(joined), **cand},
    ])
    verdict = {
        "stage": "NFL-R5H3_RIVAL_MATCHUP_RULE_ENGINE",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "candidate": MODEL,
        "primaryObjective": "OUT_OF_SAMPLE_GAME_WIN_ACCURACY",
        "referenceAccuracy": rmet["accuracy"],
        "candidateAccuracy": cand["accuracy"],
        "accuracyDelta": cand["accuracy"] - rmet["accuracy"],
        "accuracyBootstrap": boot,
        "historicalAccuracyImproved": bool(cand["accuracy"] > rmet["accuracy"]),
        "historicalAccuracyImprovementSupported95": bool(boot["better95"]),
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(blocks),
        "automaticProductionPromotion": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h3-rival-matchup-rules.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "ruleBlockCount": len(blocks),
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerSelection": "latest two prior OOS seasons only; primary objective game-win accuracy",
        "coverageThresholdPolicy": "per-test-season threshold comes only from inner-validation elite-score distribution",
        "weightingMechanism": "nested rule experts plus game-specific contextual contribution weights; pass/rush/pressure/explosive/opponent-adjusted/QB blocks evaluate both teams and rival defense/offense within each game",
        "automaticProductionPromotion": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForMetaFit": "NO",
        "targetSeasonUsedForRuleCombinationSelection": "NO",
        "targetSeasonUsedForCoverageThreshold": "NO",
        "gameSpecificRuleWeighting": "PASS",
        "rivalSpecificMatchups": "PASS_PASS_RUSH_PRESSURE_EXPLOSIVE_AND_OPPONENT_ADJUSTED",
        "productionCodeTouched": False,
    }

    summary.to_csv(out / "nfl_r5h3_model_summary.csv", index=False)
    pd.DataFrame(by).to_csv(out / "nfl_r5h3_by_season.csv", index=False)
    coverage.to_csv(out / "nfl_r5h3_coverage_bands.csv", index=False)
    pd.DataFrame(cov_by).to_csv(out / "nfl_r5h3_coverage_by_season.csv", index=False)
    cfgdf.to_csv(out / "nfl_r5h3_config_by_season.csv", index=False)
    freqdf.to_csv(out / "nfl_r5h3_rule_selection_frequency.csv", index=False)
    tuning.to_csv(out / "nfl_r5h3_expert_tuning.csv", index=False)
    pred.to_parquet(out / "nfl_r5h3_predictions.parquet", index=False)
    (out / "nfl_r5h3_verdict.json").write_text(json.dumps(verdict, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h3_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h3_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H3_MODEL_SUMMARY")
    print(summary.to_string(index=False))
    print("NFL_R5H3_ACCURACY_BOOTSTRAP")
    print(json.dumps(boot, indent=2, sort_keys=True))
    print("NFL_R5H3_COVERAGE_BANDS")
    print(coverage.to_string(index=False))
    print("NFL_R5H3_RULE_SELECTION_FREQUENCY")
    print(freqdf.to_string(index=False))
    print("NFL_R5H3_COMPLETE")


if __name__ == "__main__":
    main()
