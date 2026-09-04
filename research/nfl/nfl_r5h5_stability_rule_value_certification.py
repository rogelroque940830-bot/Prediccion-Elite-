#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score

import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H5_STABILITY_RULE_VALUE_GATE"
SEED = 940830
TOP_K = (3, 5, 8, 12, 17)
RELIABILITY_POWER = (0.5, 1.0, 2.0)
CONVICTION_POWER = (0.5, 1.0, 1.5)
REF_POWER = (0.5, 1.0, 2.0)
AGREEMENT_POWER = (1.0, 2.0, 3.0)
TARGET_COVERAGE = (0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40)
MIN_VALIDATION_SELECTIONS = 50
MIN_VALIDATION_PER_SEASON = 18


def clip_p(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def conf_score(df: pd.DataFrame) -> np.ndarray:
    return np.abs(clip_p(df.ref_p.to_numpy()) - 0.5) * 2.0


def quantile_threshold(v: np.ndarray, target: float) -> float:
    if len(v) == 0:
        return float("inf")
    return float(np.quantile(v, max(0.0, min(1.0, 1.0 - float(target)))))


def correctness(df: pd.DataFrame) -> np.ndarray:
    return ((df.ref_p.to_numpy() >= 0.5).astype(int) == df.y.to_numpy(dtype=int))


def selection_metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    n = int(mask.sum())
    if n == 0:
        return {"games": 0, "wins": 0, "losses": 0, "accuracy": float("nan"), "wilson95_lower": 0.0}
    c = correctness(df)[mask]
    w = int(c.sum())
    return {
        "games": n,
        "wins": w,
        "losses": n - w,
        "accuracy": float(w / n),
        "wilson95_lower": r5h4.wilson_lower(w, n),
    }


def score_candidate(val: pd.DataFrame, rel: pd.DataFrame, cfg: dict, target: float):
    score, agreement, shares = r5h4.score_games(val, rel, cfg)
    threshold = quantile_threshold(score, target)
    selected = (score > 0) & (score >= threshold)
    return score, agreement, shares, threshold, selected


def score_conf_control(val: pd.DataFrame, target: float):
    c = conf_score(val)
    threshold = quantile_threshold(c, target)
    return c, threshold, c >= threshold


def select_stable_config(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < 4:
        raise RuntimeError("R5H5 insufficient meta history")
    val_years = years[-2:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    rel = r5h4.reliability_table(fit, rules)

    best = None
    search_rows = []
    for k in TOP_K:
        for rp in RELIABILITY_POWER:
            for cp in CONVICTION_POWER:
                for fp in REF_POWER:
                    for ap in AGREEMENT_POWER:
                        cfg = {
                            "top_k": int(k),
                            "reliability_power": float(rp),
                            "conviction_power": float(cp),
                            "ref_power": float(fp),
                            "agreement_power": float(ap),
                        }
                        score, agreement, _, = r5h4.score_games(val, rel, cfg)
                        for target in TARGET_COVERAGE:
                            threshold = quantile_threshold(score, target)
                            selected = (score > 0) & (score >= threshold)
                            sm = selection_metrics(val, selected)
                            if sm["games"] < MIN_VALIDATION_SELECTIONS:
                                continue

                            _, conf_thr, conf_sel = score_conf_control(val, target)
                            cm = selection_metrics(val, conf_sel)
                            annual = []
                            valid = True
                            for vy in val_years:
                                iy = val.season.to_numpy(dtype=int) == vy
                                ns = int((selected & iy).sum())
                                if ns < MIN_VALIDATION_PER_SEASON:
                                    valid = False
                                    break
                                sy = selection_metrics(val, selected & iy)
                                cy = selection_metrics(val, conf_sel & iy)
                                annual.append((vy, sy, cy))
                            if not valid:
                                continue

                            min_acc = min(v[1]["accuracy"] for v in annual)
                            min_wilson = min(v[1]["wilson95_lower"] for v in annual)
                            min_delta_conf = min(v[1]["accuracy"] - v[2]["accuracy"] for v in annual)
                            pooled_delta_conf = sm["accuracy"] - cm["accuracy"]
                            coverage = sm["games"] / len(val)
                            row = {
                                **cfg,
                                "target_coverage": float(target),
                                "threshold": float(threshold),
                                "confidence_control_threshold": float(conf_thr),
                                "validation_games": sm["games"],
                                "validation_coverage": float(coverage),
                                "validation_wins": sm["wins"],
                                "validation_losses": sm["losses"],
                                "validation_accuracy": sm["accuracy"],
                                "validation_wilson95_lower": sm["wilson95_lower"],
                                "validation_confidence_accuracy": cm["accuracy"],
                                "validation_delta_vs_confidence": float(pooled_delta_conf),
                                "validation_min_season_accuracy": float(min_acc),
                                "validation_min_season_wilson95_lower": float(min_wilson),
                                "validation_min_season_delta_vs_confidence": float(min_delta_conf),
                                "mean_agreement_selected": float(agreement[selected].mean()),
                            }
                            search_rows.append(row)

                            # Stability first. Then require/encourage incremental rule value over confidence-only,
                            # then pooled robustness, raw accuracy, and coverage. All quantities are prior-validation only.
                            positive_value = 1 if pooled_delta_conf > 0 else 0
                            key = (
                                min_wilson,
                                positive_value,
                                min_delta_conf,
                                pooled_delta_conf,
                                sm["wilson95_lower"],
                                sm["accuracy"],
                                coverage,
                                -int(k),
                            )
                            if best is None or key > best[0]:
                                best = (key, row)

    if best is None:
        raise RuntimeError("R5H5 found no stability configuration meeting sample requirements")
    out = dict(best[1])
    out["inner_fit_seasons"] = sorted(int(v) for v in fit.season.unique())
    out["inner_validation_seasons"] = val_years
    out["selection_objective"] = (
        "MAXIMIZE_MIN_SEASON_WILSON95_THEN_INCREMENTAL_RULE_VALUE_VS_CONFIDENCE_"
        "THEN_POOLED_WILSON_ACCURACY_COVERAGE"
    )
    return out, rel, pd.DataFrame(search_rows)


def matched_confidence_mask(df: pd.DataFrame, n: int) -> np.ndarray:
    # Diagnostic only: same number of target-season games, ranked by reference confidence.
    # It uses no outcomes, but unlike the canonical gate it sees the target-season confidence distribution.
    n = max(0, min(int(n), len(df)))
    mask = np.zeros(len(df), dtype=bool)
    if n == 0:
        return mask
    order = np.argsort(-conf_score(df), kind="stable")
    mask[order[:n]] = True
    return mask


def bootstrap_difference(pred: pd.DataFrame, a_col: str, b_col: str, reps: int = 10000) -> dict:
    groups = []
    for _, g in pred.groupby(["season", "week"], sort=False):
        c = correctness(g)
        a = g[a_col].to_numpy(dtype=bool)
        b = g[b_col].to_numpy(dtype=bool)
        groups.append((float(c[a].sum()), int(a.sum()), float(c[b].sum()), int(b.sum())))
    rng = np.random.default_rng(SEED)
    vals = []
    for _ in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        aw = an = bw = bn = 0.0
        for j in ix:
            x = groups[j]
            aw += x[0]; an += x[1]; bw += x[2]; bn += x[3]
        if an > 0 and bn > 0:
            vals.append(aw / an - bw / bn)
    arr = np.asarray(vals, dtype=float)
    lo, hi = np.quantile(arr, [0.025, 0.975])
    return {
        "mean_accuracy_delta": float(arr.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "better95": bool(lo > 0),
        "worse95": bool(hi < 0),
        "reps": int(len(arr)),
    }


def rule_value_table(pred: pd.DataFrame, rules: list[str]) -> pd.DataFrame:
    rows = []
    s = pred[pred.selected.eq(1)].copy()
    if s.empty:
        return pd.DataFrame()
    ref_sign = np.where(s.ref_p.to_numpy() >= 0.5, 1, -1)
    corr = correctness(s)
    for rr in rules:
        rp = s[f"rule_p__{rr}"].to_numpy(dtype=float)
        agree = np.where(rp >= 0.5, 1, -1) == ref_sign
        w = s[f"rule_weight_share__{rr}"].to_numpy(dtype=float)
        active = w > 0
        if active.any():
            rows.append({
                "rule": rr,
                "selected_active_games": int(active.sum()),
                "mean_weight_share_when_active": float(w[active].mean()),
                "weighted_support_mass": float(w.sum()),
                "agreement_rate_when_active": float(agree[active].mean()),
                "accuracy_when_rule_agrees": float(corr[active & agree].mean()) if (active & agree).any() else np.nan,
                "accuracy_when_rule_disagrees": float(corr[active & ~agree].mean()) if (active & ~agree).any() else np.nan,
            })
    return pd.DataFrame(rows).sort_values(["weighted_support_mass", "rule"], ascending=[False, True])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h5-output")
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
    missing = {r: [c for c in cols if c not in x.columns] for r, cols in blocks.items()}
    missing = {r: cols for r, cols in missing.items() if cols}
    if missing:
        raise RuntimeError(f"R5H5 missing sports inputs: {missing}")

    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, expert_tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ref = r5h4.reference_oos(x, a.expert_oos_start, a.end_season)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    rows, cfg_rows, rel_rows, search_rows = [], [], [], []
    for y in range(a.test_start, a.end_season + 1):
        mt = meta[meta.season < y].copy()
        te = meta[meta.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, rel, search = select_stable_config(mt, rules)
        score, agreement, shares = r5h4.score_games(te, rel, cfg)
        selected = (score > 0) & (score >= float(cfg["threshold"]))

        cscore = conf_score(te)
        conf_safe = cscore >= float(cfg["confidence_control_threshold"])
        conf_matched = matched_confidence_mask(te, int(selected.sum()))

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["elite_score"] = score
        q["agreement"] = agreement
        q["selected"] = selected.astype(int)
        q["confidence_control_safe"] = conf_safe.astype(int)
        q["confidence_control_matched"] = conf_matched.astype(int)
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = shares[rr]
        rows.append(q)

        sm = selection_metrics(te, selected)
        cs = selection_metrics(te, conf_safe)
        cm = selection_metrics(te, conf_matched)
        cfg_rows.append({
            "test_season": int(y), **cfg,
            "test_selected_games": sm["games"], "test_selected_accuracy": sm["accuracy"],
            "test_conf_safe_games": cs["games"], "test_conf_safe_accuracy": cs["accuracy"],
            "test_conf_matched_games": cm["games"], "test_conf_matched_accuracy": cm["accuracy"],
        })
        r = rel.copy(); r["test_season"] = int(y); rel_rows.append(r)
        search["test_season"] = int(y); search_rows.append(search)

    pred = pd.concat(rows, ignore_index=True)
    sel = pred.selected.to_numpy(dtype=bool)
    safe = pred.confidence_control_safe.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched.to_numpy(dtype=bool)
    sm = selection_metrics(pred, sel)
    cs = selection_metrics(pred, safe)
    cm = selection_metrics(pred, matched)

    by = []
    for y, g in pred.groupby("season"):
        sy = g.selected.to_numpy(dtype=bool)
        cy = g.confidence_control_safe.to_numpy(dtype=bool)
        my = g.confidence_control_matched.to_numpy(dtype=bool)
        a = selection_metrics(g, sy); b = selection_metrics(g, cy); c = selection_metrics(g, my)
        by.append({
            "season": int(y), "all_games": int(len(g)),
            "selected_games": a["games"], "selected_accuracy": a["accuracy"],
            "safe_conf_games": b["games"], "safe_conf_accuracy": b["accuracy"],
            "matched_conf_games": c["games"], "matched_conf_accuracy": c["accuracy"],
            "delta_vs_safe_conf": float(a["accuracy"] - b["accuracy"]) if b["games"] else np.nan,
            "delta_vs_matched_conf": float(a["accuracy"] - c["accuracy"]) if c["games"] else np.nan,
        })
    bydf = pd.DataFrame(by)

    boot_safe = bootstrap_difference(pred, "selected", "confidence_control_safe")
    boot_matched = bootstrap_difference(pred, "selected", "confidence_control_matched")
    rule_values = rule_value_table(pred, rules)

    # Certification is deliberately strict: the sports-rule gate must beat both a prospective-safe
    # confidence threshold and an equal-count confidence-only diagnostic, with positive direction
    # in at least 5 of 8 outer seasons. Statistical support is reported separately.
    positive_safe = int((bydf.delta_vs_safe_conf > 0).sum())
    positive_matched = int((bydf.delta_vs_matched_conf > 0).sum())
    value_certified_direction = bool(
        sm["accuracy"] > cs["accuracy"] and sm["accuracy"] > cm["accuracy"]
        and positive_safe >= 5 and positive_matched >= 5
    )
    value_certified_95 = bool(boot_safe["better95"] and boot_matched["better95"])

    summary = {
        "stage": "NFL-R5H5_STABILITY_RULE_VALUE_CERTIFICATION",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(pred)),
        "selectedGames": sm["games"],
        "selectedCoverage": float(sm["games"] / len(pred)),
        "selectedWins": sm["wins"],
        "selectedLosses": sm["losses"],
        "selectedAccuracy": sm["accuracy"],
        "selectedWilson95Lower": sm["wilson95_lower"],
        "safeConfidenceControlGames": cs["games"],
        "safeConfidenceControlAccuracy": cs["accuracy"],
        "matchedConfidenceControlGames": cm["games"],
        "matchedConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsSafeConfidence": float(sm["accuracy"] - cs["accuracy"]),
        "accuracyDeltaVsMatchedConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsSafeConfidence": boot_safe,
        "bootstrapDeltaVsMatchedConfidence": boot_matched,
        "positiveOuterSeasonsVsSafeConfidence": positive_safe,
        "positiveOuterSeasonsVsMatchedConfidence": positive_matched,
        "ruleValueCertifiedDirectional": value_certified_direction,
        "ruleValueCertified95": value_certified_95,
        "worstSeasonAccuracy": float(bydf.selected_accuracy.min()),
        "medianSeasonAccuracy": float(bydf.selected_accuracy.median()),
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(rules),
        "targetSeasonUsedForConfigurationSelection": False,
        "targetSeasonUsedForThresholdSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "automaticProductionPromotion": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h5-stability-rule-value.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlockCount": len(rules),
        "ruleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerSelection": "latest two prior OOS seasons only",
        "selectionObjective": "stability first using minimum validation-season Wilson lower bound, then incremental value over confidence-only control",
        "confidenceControls": {
            "prospectiveSafe": "threshold learned only on prior validation reference-confidence distribution",
            "equalCountDiagnostic": "same target-season count ranked only by reference confidence; no outcomes used; diagnostic only",
        },
        "automaticProductionPromotion": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForReliabilityWeights": "NO",
        "targetSeasonUsedForConfigurationSelection": "NO",
        "targetSeasonUsedForSelectionThreshold": "NO",
        "gameSpecificRuleWeighting": "PASS_DYNAMIC_RELIABILITY_X_CONVICTION_SHARES",
        "rivalSpecificMatchups": "PASS_17_SPORTS_RULE_BLOCKS",
        "confidenceOnlyControl": "PASS_PROSPECTIVE_SAFE_PLUS_EQUAL_COUNT_DIAGNOSTIC",
        "productionCodeTouched": False,
    }

    pred.to_parquet(out / "nfl_r5h5_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h5_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h5_config_by_season.csv", index=False)
    pd.concat(rel_rows, ignore_index=True).to_csv(out / "nfl_r5h5_reliability_by_season.csv", index=False)
    pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h5_search_audit.csv", index=False)
    rule_values.to_csv(out / "nfl_r5h5_rule_value_table.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h5_expert_tuning.csv", index=False)
    (out / "nfl_r5h5_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h5_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h5_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H5_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H5_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H5_RULE_VALUE")
    print(rule_values.to_string(index=False))
    print("NFL_R5H5_COMPLETE")


if __name__ == "__main__":
    main()
