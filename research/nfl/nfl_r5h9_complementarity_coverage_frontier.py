#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h8_interaction_contradiction_engine as r5h8

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H9_COMPLEMENTARITY_COVERAGE_FRONTIER"

# R5H9 keeps the same 17 sports-only rules and the R5H8 pair-interaction engine.
# The new layer explicitly rewards cross-family support while capping concentration in
# one semantic rule family. Selection remains within prior-learned confidence strata;
# reference-confidence magnitude never enters the sports-rule score itself.
FAMILIES = {
    "FORM_CORE": ["SCORING_FORM", "EPA_CORE", "SUCCESS_CORE", "OPPONENT_ADJUSTED_CORE"],
    "PASS": ["PASS_MATCHUP", "EXPLOSIVE_PASS_MATCHUP", "OPPONENT_ADJUSTED_PASS"],
    "RUSH": ["RUSH_MATCHUP", "EXPLOSIVE_RUSH_MATCHUP"],
    "PRESSURE": ["SACK_PRESSURE_MATCHUP"],
    "QB_EFFICIENCY": ["QB_EPA", "QB_CPOE"],
    "QB_PRESSURE": ["QB_SACK"],
    "QB_STATE": ["QB_UNCERTAINTY", "QB_AVAILABILITY_SWITCH"],
    "TEAM_STATE": ["TEAM_UNCERTAINTY"],
    "TEMPO": ["PACE_DRIVES"],
}
FAMILY_POWER = (0.5, 1.5)
MIN_SUPPORT_FAMILIES = (3, 4)
MAX_FAMILY_SHARE = (0.45, 0.60)
SYNERGY_FLOOR = (-0.01, 0.00, 0.01)
RULE_SELECTION_RATE = (0.20, 0.25, 0.30, 0.35)
CONFIDENCE_FLOOR_QUANTILE = (0.35, 0.50)
MIN_VALIDATION_SELECTIONS = 60
MIN_VALIDATION_PER_SEASON = 12
VALIDATION_SEASONS = 3
TARGET_COVERAGE_CENTER = 0.125


def _rule_support(df: pd.DataFrame, rule: str) -> np.ndarray:
    rp = np.asarray(df[f"p__{rule}"], dtype=float)
    ref = np.asarray(df.ref_p, dtype=float)
    return np.where((rp >= 0.5) == (ref >= 0.5), 1.0, 0.0)


def family_state(
    df: pd.DataFrame,
    shares: dict[str, np.ndarray],
    selected_rules: list[str],
) -> dict[str, np.ndarray]:
    n = len(df)
    family_shares = []
    family_support = []
    for _, members in FAMILIES.items():
        active = [r for r in members if r in selected_rules]
        if not active:
            family_shares.append(np.zeros(n, dtype=float))
            family_support.append(np.zeros(n, dtype=float))
            continue
        fs = np.zeros(n, dtype=float)
        ss = np.zeros(n, dtype=float)
        for r in active:
            sh = np.asarray(shares[r], dtype=float)
            fs += sh
            ss += sh * _rule_support(df, r)
        family_shares.append(fs)
        family_support.append(ss)

    F = np.column_stack(family_shares)
    S = np.column_stack(family_support)
    total = np.maximum(F.sum(axis=1), 1e-12)
    F = F / total[:, None]
    S = S / total[:, None]
    hhi = np.sum(F ** 2, axis=1)
    effective = 1.0 / np.maximum(hhi, 1e-12)
    possible = max(sum(any(r in selected_rules for r in members) for members in FAMILIES.values()), 1)
    diversity = np.clip((effective - 1.0) / max(possible - 1.0, 1.0), 0.0, 1.0)
    max_share = np.max(F, axis=1)

    support_ratio_by_family = np.divide(S, np.maximum(F, 1e-12))
    support_family = (F >= 0.03) & (support_ratio_by_family >= 0.60)
    support_count = support_family.sum(axis=1).astype(int)
    active_count = (F >= 0.03).sum(axis=1).astype(int)
    support_ratio = support_count / np.maximum(active_count, 1)
    return {
        "family_hhi": hhi,
        "effective_families": effective,
        "family_diversity": diversity,
        "max_family_share": max_share,
        "support_family_count": support_count,
        "active_family_count": active_count,
        "support_family_ratio": support_ratio,
    }


def complementarity_score(
    df: pd.DataFrame,
    rel: pd.DataFrame,
    pair: pd.DataFrame,
    base_cfg: dict,
    overlay_cfg: dict,
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray], dict[str, np.ndarray], dict[str, np.ndarray]]:
    base_score, agreement, shares, state = r5h8.score_games(df, rel, pair, base_cfg)
    chosen = rel.head(min(int(base_cfg["top_k"]), len(rel))).rule.tolist()
    fam = family_state(df, shares, chosen)

    comp = (
        np.power(0.55 + 0.45 * fam["family_diversity"], float(overlay_cfg["family_power"]))
        * (0.70 + 0.30 * fam["support_family_ratio"])
        * np.exp(np.clip(np.maximum(state["synergy"], 0.0), 0.0, 0.75))
    )
    eligible = (
        (base_score > 0)
        & (fam["support_family_count"] >= int(overlay_cfg["min_support_families"]))
        & (fam["max_family_share"] <= float(overlay_cfg["max_family_share"]))
        & (state["synergy"] >= float(overlay_cfg["synergy_floor"]))
    )
    score = np.where(eligible, base_score * comp, 0.0)
    return score, agreement, shares, state, fam


def _validation_split(meta_train: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, list[int]]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < VALIDATION_SEASONS + 2:
        raise RuntimeError("R5H9 insufficient prior OOS seasons")
    val_years = years[-VALIDATION_SEASONS:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    return fit, val, val_years


def select_overlay(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, dict, pd.DataFrame]:
    # Base interaction architecture/config is selected exactly as in R5H8 using prior data only.
    base_cfg, rel, pair, _ = r5h8.select_config(meta_train, rules)
    fit, val, val_years = _validation_split(meta_train)
    fit_conf = r5h6.conf_score(fit)
    nb = int(base_cfg["confidence_bins"])
    edges = r5h6.make_edges(fit_conf, nb)

    best = None
    rows = []
    for fp in FAMILY_POWER:
        for mf in MIN_SUPPORT_FAMILIES:
            for mx in MAX_FAMILY_SHARE:
                for sf in SYNERGY_FLOOR:
                    overlay = {
                        "family_power": float(fp),
                        "min_support_families": int(mf),
                        "max_family_share": float(mx),
                        "synergy_floor": float(sf),
                    }
                    score, _, _, _, fam = complementarity_score(val, rel, pair, base_cfg, overlay)
                    for fq in CONFIDENCE_FLOOR_QUANTILE:
                        floor = r5h6.prior_floor(fit_conf, fq)
                        for rate in RULE_SELECTION_RATE:
                            rule_thr, selected, _ = r5h6.learn_stratified_thresholds(val, score, edges, floor, rate)
                            sm = r5h6.metrics(val, selected)
                            if sm["games"] < MIN_VALIDATION_SELECTIONS:
                                continue
                            safe_thr = r5h6.learn_safe_conf_thresholds(val, selected, edges, floor)
                            safe, _ = r5h6.apply_safe_conf(val, edges, floor, safe_thr)
                            matched = r5h6.matched_confidence_within_bins(val, selected, edges, floor)
                            cs = r5h6.metrics(val, safe)
                            cm = r5h6.metrics(val, matched)
                            if cs["games"] <= 0 or cm["games"] <= 0:
                                continue

                            annual = []
                            valid = True
                            for vy in val_years:
                                iy = val.season.to_numpy(dtype=int) == vy
                                if int((selected & iy).sum()) < MIN_VALIDATION_PER_SEASON:
                                    valid = False
                                    break
                                ma = r5h6.metrics(val, selected & iy)
                                mc = r5h6.metrics(val, matched & iy)
                                ms = r5h6.metrics(val, safe & iy)
                                if mc["games"] <= 0 or ms["games"] <= 0:
                                    valid = False
                                    break
                                annual.append((vy, ma, mc, ms))
                            if not valid:
                                continue

                            coverage = sm["games"] / len(val)
                            pooled_delta = float(sm["accuracy"] - cm["accuracy"])
                            safe_delta = float(sm["accuracy"] - cs["accuracy"])
                            min_acc = min(v[1]["accuracy"] for v in annual)
                            min_delta = min(v[1]["accuracy"] - v[2]["accuracy"] for v in annual)
                            nonneg = sum(v[1]["accuracy"] >= v[2]["accuracy"] for v in annual)
                            coverage_gate = int(0.09 <= coverage <= 0.17)
                            stability_gate = int(min_acc >= 0.70)
                            value_gate = int(pooled_delta > 0 and safe_delta > 0)
                            row = {
                                **overlay,
                                "confidence_bins": nb,
                                "confidence_floor_quantile": float(fq),
                                "confidence_floor": float(floor),
                                "rule_selection_rate": float(rate),
                                "validation_games": sm["games"],
                                "validation_coverage": float(coverage),
                                "validation_accuracy": sm["accuracy"],
                                "validation_wilson95_lower": sm["wilson95_lower"],
                                "validation_matched_conf_accuracy": cm["accuracy"],
                                "validation_safe_conf_accuracy": cs["accuracy"],
                                "validation_delta_vs_matched_conf": pooled_delta,
                                "validation_delta_vs_safe_conf": safe_delta,
                                "validation_min_season_accuracy": float(min_acc),
                                "validation_min_season_delta_vs_matched_conf": float(min_delta),
                                "validation_nonnegative_seasons_vs_matched": int(nonneg),
                                "mean_family_diversity_selected": float(fam["family_diversity"][selected].mean()),
                                "mean_support_families_selected": float(fam["support_family_count"][selected].mean()),
                                "mean_max_family_share_selected": float(fam["max_family_share"][selected].mean()),
                                "rule_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in rule_thr.items()}, sort_keys=True),
                                "safe_conf_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in safe_thr.items()}, sort_keys=True),
                            }
                            rows.append(row)
                            key = (
                                coverage_gate,
                                stability_gate,
                                value_gate,
                                float(min_acc),
                                float(sm["wilson95_lower"]),
                                float(pooled_delta),
                                int(nonneg),
                                float(sm["accuracy"]),
                                -abs(float(coverage) - TARGET_COVERAGE_CENTER),
                            )
                            if best is None or key > best[0]:
                                best = (key, row)

    if best is None:
        raise RuntimeError("R5H9 found no complementarity configuration meeting validation sample requirements")
    cfg = dict(best[1])
    cfg["inner_validation_seasons"] = val_years
    cfg["selection_objective"] = (
        "TARGET_10_15_PERCENT_COVERAGE_WITH_COMPLEMENTARY_RULE_SUPPORT_THEN_"
        "STABILITY_WILSON_MATCHED_CONFIDENCE_DELTA"
    )
    return base_cfg, cfg, pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h9-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()

    blocks = r5h3.expanded_rule_blocks()
    rules = list(blocks)
    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, expert_tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ref = r5h4.reference_oos(x, a.expert_oos_start, a.end_season)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    pred_rows, cfg_rows, search_rows = [], [], []
    for y in range(a.test_start, a.end_season + 1):
        mt = meta[meta.season < y].copy()
        te = meta[meta.season == y].copy()
        if mt.empty or te.empty:
            continue

        base_cfg, overlay_cfg, search = select_overlay(mt, rules)
        search["test_season"] = int(y)
        search_rows.append(search)

        # After configuration selection, re-estimate reliability and interaction structure on
        # every available prior OOS season. Target-season outcomes remain completely untouched.
        rel_all = r5h4.reliability_table(mt, rules)
        pair_all = r5h8.learn_pair_structure(mt, rules)
        train_score, _, _, _, _ = complementarity_score(mt, rel_all, pair_all, base_cfg, overlay_cfg)
        test_score, agreement, shares, state, fam = complementarity_score(te, rel_all, pair_all, base_cfg, overlay_cfg)

        nb = int(overlay_cfg["confidence_bins"])
        train_conf = r5h6.conf_score(mt)
        edges = r5h6.make_edges(train_conf, nb)
        floor = r5h6.prior_floor(train_conf, float(overlay_cfg["confidence_floor_quantile"]))
        rule_thr, train_selected, _ = r5h6.learn_stratified_thresholds(
            mt, train_score, edges, floor, float(overlay_cfg["rule_selection_rate"])
        )
        selected, bins = r5h6.apply_rule_thresholds(te, test_score, edges, floor, rule_thr)
        safe_thr = r5h6.learn_safe_conf_thresholds(mt, train_selected, edges, floor)
        safe, _ = r5h6.apply_safe_conf(te, edges, floor, safe_thr)
        matched = r5h6.matched_confidence_within_bins(te, selected, edges, floor)

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["model"] = MODEL
        q["selected"] = selected
        q["confidence_control_safe"] = safe
        q["confidence_control_matched"] = matched
        q["score"] = test_score
        q["agreement"] = agreement
        q["confidence_bin"] = bins
        q["synergy"] = state["synergy"]
        q["contradiction_pair_risk"] = state["contradiction_pair_risk"]
        q["redundancy_exposure"] = state["redundancy_exposure"]
        q["family_diversity"] = fam["family_diversity"]
        q["support_family_count"] = fam["support_family_count"]
        q["max_family_share"] = fam["max_family_share"]
        for rr in rules:
            q[f"rule_weight_share__{rr}"] = shares[rr]
        pred_rows.append(q)

        cfg_rows.append({
            "test_season": int(y),
            "base_config": json.dumps({k: v for k, v in base_cfg.items() if isinstance(v, (int, float, str, bool))}, sort_keys=True),
            **{k: v for k, v in overlay_cfg.items() if k not in {"rule_thresholds", "safe_conf_thresholds"}},
        })

    pred = pd.concat(pred_rows, ignore_index=True)
    selected = pred.selected.to_numpy(dtype=bool)
    safe = pred.confidence_control_safe.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched.to_numpy(dtype=bool)
    sm = r5h6.metrics(pred, selected)
    cs = r5h6.metrics(pred, safe)
    cm = r5h6.metrics(pred, matched)
    boot_safe = r5h6.bootstrap_difference(pred, "selected", "confidence_control_safe")
    boot_matched = r5h6.bootstrap_difference(pred, "selected", "confidence_control_matched")

    by = []
    for y, g in pred.groupby("season"):
        ma = r5h6.metrics(g, g.selected.to_numpy(dtype=bool))
        ms = r5h6.metrics(g, g.confidence_control_safe.to_numpy(dtype=bool))
        mc = r5h6.metrics(g, g.confidence_control_matched.to_numpy(dtype=bool))
        by.append({
            "season": int(y),
            "all_games": int(len(g)),
            "selected_games": ma["games"],
            "selected_accuracy": ma["accuracy"],
            "safe_conf_games": ms["games"],
            "safe_conf_accuracy": ms["accuracy"],
            "matched_conf_games": mc["games"],
            "matched_conf_accuracy": mc["accuracy"],
            "delta_vs_safe_conf": float(ma["accuracy"] - ms["accuracy"]) if ms["games"] else float("nan"),
            "delta_vs_matched_conf": float(ma["accuracy"] - mc["accuracy"]) if mc["games"] else float("nan"),
        })
    bydf = pd.DataFrame(by)
    positive_matched = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative_matched = int((bydf.delta_vs_matched_conf >= 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())
    directional = bool(positive_matched >= 5 and sm["accuracy"] > cm["accuracy"])
    certified95 = bool(boot_matched["better95"])

    selected_rows = pred[pred.selected].copy()
    family_summary = {
        "meanFamilyDiversity": float(selected_rows.family_diversity.mean()) if len(selected_rows) else None,
        "meanSupportFamilyCount": float(selected_rows.support_family_count.mean()) if len(selected_rows) else None,
        "meanMaxFamilyShare": float(selected_rows.max_family_share.mean()) if len(selected_rows) else None,
        "meanSynergy": float(selected_rows.synergy.mean()) if len(selected_rows) else None,
    }

    summary = {
        "stage": "NFL-R5H9_COMPLEMENTARITY_COVERAGE_FRONTIER",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(pred)),
        "selectedGames": sm["games"],
        "selectedWins": sm["wins"],
        "selectedLosses": sm["losses"],
        "selectedAccuracy": sm["accuracy"],
        "selectedCoverage": float(sm["games"] / len(pred)),
        "selectedWilson95Lower": sm["wilson95_lower"],
        "safeConfidenceControlGames": cs["games"],
        "safeConfidenceControlAccuracy": cs["accuracy"],
        "matchedConfidenceControlGames": cm["games"],
        "matchedConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsSafeConfidence": float(sm["accuracy"] - cs["accuracy"]),
        "accuracyDeltaVsMatchedConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsSafeConfidence": boot_safe,
        "bootstrapDeltaVsMatchedConfidence": boot_matched,
        "positiveOuterSeasonsVsMatchedConfidence": positive_matched,
        "nonnegativeOuterSeasonsVsMatchedConfidence": nonnegative_matched,
        "worstSeasonAccuracy": worst,
        "medianSeasonAccuracy": median,
        "ruleValueCertifiedDirectional": directional,
        "ruleValueCertified95": certified95,
        "ruleWeightsGameSpecific": True,
        "pairInteractionLearningPriorOnly": True,
        "familyComplementarityModeled": True,
        "familyConcentrationCapGameSpecific": True,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleBlockCount": len(rules),
        "targetSeasonUsedForConfigurationSelection": False,
        "targetSeasonUsedForPairInteractionLearning": False,
        "targetSeasonUsedForThresholdSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "r5h8HistoricalAccuracy": 0.7911392405063291,
        "r5h8HistoricalCoverage": 0.07463391591875296,
        "r5h4HistoricalEliteAccuracy": 0.7726161369193154,
        "targetCoverageBand": [0.10, 0.15],
        "familySummary": family_summary,
        "automaticProductionPromotion": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h9-complementarity-coverage.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "ruleFamilies": FAMILIES,
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerValidation": "latest three prior OOS seasons",
        "weightingMechanism": "R5H8 dynamic reliability x conviction x redundancy adjustment plus prior-only pair interaction lift, then cross-family complementarity reward and per-game family concentration cap",
        "coverageObjective": "seek roughly 10-15% selective coverage without using target-season outcomes",
        "automaticProductionPromotion": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForReliabilityWeights": "NO",
        "targetSeasonUsedForPairInteractionLearning": "NO",
        "targetSeasonUsedForConfigurationSelection": "NO",
        "targetSeasonUsedForSelectionThreshold": "NO",
        "referenceConfidenceMagnitudeInRuleScore": "REMOVED",
        "gameSpecificRuleWeighting": "PASS_DYNAMIC_RELIABILITY_X_CONVICTION_X_REDUNDANCY_X_FAMILY_COMPLEMENTARITY",
        "pairInteractionModel": "PASS_PRIOR_ONLY_PAIR_LIFT_AND_DISCORD_RISK",
        "familyComplementarityModel": "PASS_CROSS_FAMILY_SUPPORT_AND_CONCENTRATION_CAP",
        "rivalSpecificMatchups": "PASS_17_SPORTS_RULE_BLOCKS",
        "productionCodeTouched": False,
    }

    pred.to_parquet(out / "nfl_r5h9_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h9_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h9_config_by_season.csv", index=False)
    pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h9_inner_search.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h9_expert_tuning.csv", index=False)
    (out / "nfl_r5h9_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h9_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h9_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H9_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H9_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H9_COMPLETE")


if __name__ == "__main__":
    main()
