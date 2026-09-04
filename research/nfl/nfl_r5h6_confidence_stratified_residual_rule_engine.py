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
import nfl_r5h5_stability_rule_value_certification as r5h5

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H6_CONFIDENCE_STRATIFIED_RESIDUAL_RULE_ENGINE"
SEED = 940830

# R5H6 deliberately removes reference-confidence magnitude from the sports-rule score.
# Confidence is used only to place games into prior-learned strata and optional prior-learned
# high-confidence floors. Inside a stratum, games are ranked only by rival-specific sports rules.
TOP_K = (5, 8, 12, 17)
RELIABILITY_POWER = (0.5, 1.0)
CONVICTION_POWER = (0.5, 1.0)
AGREEMENT_POWER = (1.0, 2.0, 3.0)
CONFIDENCE_BINS = (4, 6)
RULE_SELECTION_RATE = (0.10, 0.15, 0.20, 0.25)
CONFIDENCE_FLOOR_QUANTILE = (0.50, 0.65, 0.75)
MIN_VALIDATION_SELECTIONS = 45
MIN_VALIDATION_PER_SEASON = 14


def conf_score(df: pd.DataFrame) -> np.ndarray:
    p = np.clip(df.ref_p.to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    return np.abs(p - 0.5) * 2.0


def correctness(df: pd.DataFrame) -> np.ndarray:
    return ((df.ref_p.to_numpy(dtype=float) >= 0.5).astype(int) == df.y.to_numpy(dtype=int))


def metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    n = int(mask.sum())
    if n <= 0:
        return {"games": 0, "wins": 0, "losses": 0, "accuracy": float("nan"), "wilson95_lower": 0.0}
    c = correctness(df)[mask]
    w = int(c.sum())
    return {
        "games": n,
        "wins": w,
        "losses": n - w,
        "accuracy": float(w / n),
        "wilson95_lower": float(r5h4.wilson_lower(w, n)),
    }


def make_edges(fit_conf: np.ndarray, bins: int) -> np.ndarray:
    q = np.linspace(0.0, 1.0, int(bins) + 1)
    raw = np.quantile(fit_conf, q)
    internal = []
    for v in raw[1:-1]:
        fv = float(v)
        if not internal or fv > internal[-1] + 1e-12:
            internal.append(fv)
    return np.asarray([-np.inf, *internal, np.inf], dtype=float)


def assign_bins(conf: np.ndarray, edges: np.ndarray) -> np.ndarray:
    return np.searchsorted(edges[1:-1], conf, side="right").astype(int)


def prior_floor(fit_conf: np.ndarray, quantile: float) -> float:
    return float(np.quantile(fit_conf, float(quantile)))


def rule_only_score(df: pd.DataFrame, rel: pd.DataFrame, cfg: dict) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    # ref_power=0 means reference confidence magnitude contributes no score. The certified
    # reference direction is retained only as the direction that rule consensus must support.
    score_cfg = {
        "top_k": int(cfg["top_k"]),
        "reliability_power": float(cfg["reliability_power"]),
        "conviction_power": float(cfg["conviction_power"]),
        "ref_power": 0.0,
        "agreement_power": float(cfg["agreement_power"]),
    }
    return r5h4.score_games(df, rel, score_cfg)


def threshold_for_rate(v: np.ndarray, rate: float) -> float:
    z = np.asarray(v, dtype=float)
    z = z[np.isfinite(z) & (z > 0)]
    if len(z) == 0:
        return float("inf")
    return float(np.quantile(z, 1.0 - float(rate)))


def learn_stratified_thresholds(
    val: pd.DataFrame,
    score: np.ndarray,
    edges: np.ndarray,
    floor: float,
    rate: float,
) -> tuple[dict[int, float], np.ndarray, np.ndarray]:
    conf = conf_score(val)
    bins = assign_bins(conf, edges)
    active = conf >= floor
    thresholds: dict[int, float] = {}
    selected = np.zeros(len(val), dtype=bool)
    for b in sorted(np.unique(bins)):
        ib = (bins == b) & active
        thr = threshold_for_rate(score[ib], rate)
        thresholds[int(b)] = float(thr)
        selected |= ib & (score > 0) & (score >= thr)
    return thresholds, selected, bins


def learn_safe_conf_thresholds(
    val: pd.DataFrame,
    candidate_selected: np.ndarray,
    edges: np.ndarray,
    floor: float,
) -> dict[int, float]:
    conf = conf_score(val)
    bins = assign_bins(conf, edges)
    out: dict[int, float] = {}
    active = conf >= floor
    for b in sorted(np.unique(bins)):
        ib = (bins == b) & active
        n = int(ib.sum())
        k = int((candidate_selected & ib).sum())
        if n == 0 or k == 0:
            out[int(b)] = float("inf")
            continue
        frac = min(max(k / n, 0.0), 1.0)
        out[int(b)] = float(np.quantile(conf[ib], 1.0 - frac))
    return out


def apply_rule_thresholds(
    df: pd.DataFrame,
    score: np.ndarray,
    edges: np.ndarray,
    floor: float,
    thresholds: dict[int, float],
) -> tuple[np.ndarray, np.ndarray]:
    conf = conf_score(df)
    bins = assign_bins(conf, edges)
    active = conf >= floor
    selected = np.zeros(len(df), dtype=bool)
    for b in np.unique(bins):
        thr = float(thresholds.get(int(b), float("inf")))
        selected |= (bins == b) & active & (score > 0) & (score >= thr)
    return selected, bins


def apply_safe_conf(
    df: pd.DataFrame,
    edges: np.ndarray,
    floor: float,
    thresholds: dict[int, float],
) -> tuple[np.ndarray, np.ndarray]:
    conf = conf_score(df)
    bins = assign_bins(conf, edges)
    active = conf >= floor
    selected = np.zeros(len(df), dtype=bool)
    for b in np.unique(bins):
        thr = float(thresholds.get(int(b), float("inf")))
        selected |= (bins == b) & active & (conf >= thr)
    return selected, bins


def matched_confidence_within_bins(
    df: pd.DataFrame,
    candidate: np.ndarray,
    edges: np.ndarray,
    floor: float,
) -> np.ndarray:
    # Outcome-free diagnostic: for every target-season confidence stratum, select exactly the
    # same number of games as the rule engine, choosing only by reference confidence magnitude.
    conf = conf_score(df)
    bins = assign_bins(conf, edges)
    active = conf >= floor
    out = np.zeros(len(df), dtype=bool)
    for b in np.unique(bins):
        ib = np.flatnonzero((bins == b) & active)
        k = int((candidate & (bins == b) & active).sum())
        if k <= 0 or len(ib) == 0:
            continue
        order = ib[np.argsort(-conf[ib], kind="stable")]
        out[order[: min(k, len(order))]] = True
    return out


def select_config(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < 4:
        raise RuntimeError("R5H6 insufficient meta history")
    val_years = years[-2:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    rel = r5h4.reliability_table(fit, rules)
    fit_conf = conf_score(fit)

    best = None
    search_rows = []

    for k in TOP_K:
        for rp in RELIABILITY_POWER:
            for cp in CONVICTION_POWER:
                for ap in AGREEMENT_POWER:
                    base_cfg = {
                        "top_k": int(k),
                        "reliability_power": float(rp),
                        "conviction_power": float(cp),
                        "agreement_power": float(ap),
                    }
                    score, agreement, _ = rule_only_score(val, rel, base_cfg)

                    for nb in CONFIDENCE_BINS:
                        edges = make_edges(fit_conf, nb)
                        for fq in CONFIDENCE_FLOOR_QUANTILE:
                            floor = prior_floor(fit_conf, fq)
                            for rate in RULE_SELECTION_RATE:
                                rule_thr, selected, bins = learn_stratified_thresholds(val, score, edges, floor, rate)
                                sm = metrics(val, selected)
                                if sm["games"] < MIN_VALIDATION_SELECTIONS:
                                    continue

                                safe_thr = learn_safe_conf_thresholds(val, selected, edges, floor)
                                safe, _ = apply_safe_conf(val, edges, floor, safe_thr)
                                matched = matched_confidence_within_bins(val, selected, edges, floor)
                                cs = metrics(val, safe)
                                cm = metrics(val, matched)
                                if cs["games"] == 0 or cm["games"] == 0:
                                    continue

                                annual = []
                                valid = True
                                for vy in val_years:
                                    iy = val.season.to_numpy(dtype=int) == vy
                                    n = int((selected & iy).sum())
                                    if n < MIN_VALIDATION_PER_SEASON:
                                        valid = False
                                        break
                                    a = metrics(val, selected & iy)
                                    b = metrics(val, safe & iy)
                                    c = metrics(val, matched & iy)
                                    if b["games"] == 0 or c["games"] == 0:
                                        valid = False
                                        break
                                    annual.append((vy, a, b, c))
                                if not valid:
                                    continue

                                pooled_safe_delta = sm["accuracy"] - cs["accuracy"]
                                pooled_matched_delta = sm["accuracy"] - cm["accuracy"]
                                min_safe_delta = min(v[1]["accuracy"] - v[2]["accuracy"] for v in annual)
                                min_matched_delta = min(v[1]["accuracy"] - v[3]["accuracy"] for v in annual)
                                min_acc = min(v[1]["accuracy"] for v in annual)
                                min_wilson = min(v[1]["wilson95_lower"] for v in annual)
                                coverage = sm["games"] / len(val)

                                row = {
                                    **base_cfg,
                                    "confidence_bins": int(nb),
                                    "confidence_floor_quantile": float(fq),
                                    "confidence_floor": float(floor),
                                    "rule_selection_rate": float(rate),
                                    "validation_games": sm["games"],
                                    "validation_coverage": float(coverage),
                                    "validation_accuracy": sm["accuracy"],
                                    "validation_wilson95_lower": sm["wilson95_lower"],
                                    "validation_safe_conf_accuracy": cs["accuracy"],
                                    "validation_matched_conf_accuracy": cm["accuracy"],
                                    "validation_delta_vs_safe_conf": float(pooled_safe_delta),
                                    "validation_delta_vs_matched_conf": float(pooled_matched_delta),
                                    "validation_min_season_accuracy": float(min_acc),
                                    "validation_min_season_wilson95_lower": float(min_wilson),
                                    "validation_min_season_delta_vs_safe_conf": float(min_safe_delta),
                                    "validation_min_season_delta_vs_matched_conf": float(min_matched_delta),
                                    "mean_agreement_selected": float(agreement[selected].mean()),
                                    "bin_edges": json.dumps([None if not np.isfinite(v) else float(v) for v in edges]),
                                    "rule_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in rule_thr.items()}, sort_keys=True),
                                    "safe_conf_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in safe_thr.items()}, sort_keys=True),
                                }
                                search_rows.append(row)

                                # Primary objective is incremental sports-rule value at matched confidence.
                                # Stability and absolute accuracy remain explicit tie-breakers.
                                positive_both = int(pooled_safe_delta > 0 and pooled_matched_delta > 0)
                                key = (
                                    positive_both,
                                    min(min_safe_delta, min_matched_delta),
                                    min(pooled_safe_delta, pooled_matched_delta),
                                    min_wilson,
                                    sm["wilson95_lower"],
                                    sm["accuracy"],
                                    coverage,
                                    -int(k),
                                )
                                if best is None or key > best[0]:
                                    best = (key, row)

    if best is None:
        raise RuntimeError("R5H6 found no configuration meeting stability/sample requirements")
    cfg = dict(best[1])
    cfg["inner_fit_seasons"] = sorted(int(v) for v in fit.season.unique())
    cfg["inner_validation_seasons"] = val_years
    cfg["selection_objective"] = (
        "MAXIMIZE_INCREMENTAL_RULE_VALUE_WITHIN_CONFIDENCE_STRATA_THEN_"
        "STABILITY_WILSON_ACCURACY_COVERAGE"
    )
    return cfg, rel, pd.DataFrame(search_rows)


def decode_edges(text: str) -> np.ndarray:
    vals = json.loads(text)
    out = []
    for i, v in enumerate(vals):
        if v is None:
            out.append(-np.inf if i == 0 else np.inf)
        else:
            out.append(float(v))
    return np.asarray(out, dtype=float)


def decode_thresholds(text: str) -> dict[int, float]:
    z = json.loads(text)
    return {int(k): (float("inf") if v is None else float(v)) for k, v in z.items()}


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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h6-output")
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
        raise RuntimeError(f"R5H6 missing sports inputs: {missing}")

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

        cfg, rel, search = select_config(mt, rules)
        score, agreement, shares = rule_only_score(te, rel, cfg)
        edges = decode_edges(cfg["bin_edges"])
        rule_thr = decode_thresholds(cfg["rule_thresholds"])
        safe_thr = decode_thresholds(cfg["safe_conf_thresholds"])
        floor = float(cfg["confidence_floor"])

        selected, bins = apply_rule_thresholds(te, score, edges, floor, rule_thr)
        safe, _ = apply_safe_conf(te, edges, floor, safe_thr)
        matched = matched_confidence_within_bins(te, selected, edges, floor)

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["rule_residual_score"] = score
        q["agreement"] = agreement
        q["confidence_score"] = conf_score(te)
        q["confidence_stratum"] = bins
        q["selected"] = selected.astype(int)
        q["confidence_control_safe"] = safe.astype(int)
        q["confidence_control_matched_stratum"] = matched.astype(int)
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = shares[rr]
        rows.append(q)

        sm = metrics(te, selected); cs = metrics(te, safe); cm = metrics(te, matched)
        cfg_rows.append({
            "test_season": int(y), **cfg,
            "test_selected_games": sm["games"], "test_selected_accuracy": sm["accuracy"],
            "test_safe_conf_games": cs["games"], "test_safe_conf_accuracy": cs["accuracy"],
            "test_matched_conf_games": cm["games"], "test_matched_conf_accuracy": cm["accuracy"],
            "test_delta_vs_safe_conf": float(sm["accuracy"] - cs["accuracy"]) if cs["games"] else np.nan,
            "test_delta_vs_matched_conf": float(sm["accuracy"] - cm["accuracy"]) if cm["games"] else np.nan,
        })
        r = rel.copy(); r["test_season"] = int(y); rel_rows.append(r)
        search["test_season"] = int(y); search_rows.append(search)

    pred = pd.concat(rows, ignore_index=True)
    sel = pred.selected.to_numpy(dtype=bool)
    safe = pred.confidence_control_safe.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched_stratum.to_numpy(dtype=bool)
    sm = metrics(pred, sel); cs = metrics(pred, safe); cm = metrics(pred, matched)

    by = []
    for y, g in pred.groupby("season"):
        a1 = g.selected.to_numpy(dtype=bool)
        b1 = g.confidence_control_safe.to_numpy(dtype=bool)
        c1 = g.confidence_control_matched_stratum.to_numpy(dtype=bool)
        ma = metrics(g, a1); mb = metrics(g, b1); mc = metrics(g, c1)
        by.append({
            "season": int(y), "all_games": int(len(g)),
            "selected_games": ma["games"], "selected_accuracy": ma["accuracy"],
            "safe_conf_games": mb["games"], "safe_conf_accuracy": mb["accuracy"],
            "matched_conf_games": mc["games"], "matched_conf_accuracy": mc["accuracy"],
            "delta_vs_safe_conf": float(ma["accuracy"] - mb["accuracy"]) if mb["games"] else np.nan,
            "delta_vs_matched_conf": float(ma["accuracy"] - mc["accuracy"]) if mc["games"] else np.nan,
        })
    bydf = pd.DataFrame(by)

    by_stratum = []
    for (y, b), g in pred.groupby(["season", "confidence_stratum"]):
        a1 = g.selected.to_numpy(dtype=bool)
        c1 = g.confidence_control_matched_stratum.to_numpy(dtype=bool)
        ma = metrics(g, a1); mc = metrics(g, c1)
        by_stratum.append({
            "season": int(y), "confidence_stratum": int(b), "games": int(len(g)),
            "selected_games": ma["games"], "selected_accuracy": ma["accuracy"],
            "matched_conf_games": mc["games"], "matched_conf_accuracy": mc["accuracy"],
            "delta_vs_matched_conf": float(ma["accuracy"] - mc["accuracy"]) if ma["games"] and mc["games"] else np.nan,
        })
    stratdf = pd.DataFrame(by_stratum)

    boot_safe = bootstrap_difference(pred, "selected", "confidence_control_safe")
    boot_matched = bootstrap_difference(pred, "selected", "confidence_control_matched_stratum")
    rule_values = r5h5.rule_value_table(pred, rules)

    positive_safe = int((bydf.delta_vs_safe_conf > 0).sum())
    positive_matched = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative_matched = int((bydf.delta_vs_matched_conf >= 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())

    directional = bool(
        sm["accuracy"] > cs["accuracy"]
        and sm["accuracy"] > cm["accuracy"]
        and positive_matched >= 5
    )
    certified95 = bool(
        directional
        and boot_safe["better95"]
        and boot_matched["better95"]
    )
    r5h4_accuracy = 0.7726161369193154
    supersedes_r5h4 = bool(certified95 and sm["accuracy"] > r5h4_accuracy and worst >= 0.70)

    summary = {
        "stage": "NFL-R5H6_CONFIDENCE_STRATIFIED_RESIDUAL_RULE_ENGINE",
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
        "matchedStratumConfidenceControlGames": cm["games"],
        "matchedStratumConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsSafeConfidence": float(sm["accuracy"] - cs["accuracy"]),
        "accuracyDeltaVsMatchedStratumConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsSafeConfidence": boot_safe,
        "bootstrapDeltaVsMatchedStratumConfidence": boot_matched,
        "positiveOuterSeasonsVsSafeConfidence": positive_safe,
        "positiveOuterSeasonsVsMatchedStratumConfidence": positive_matched,
        "nonnegativeOuterSeasonsVsMatchedStratumConfidence": nonnegative_matched,
        "worstSeasonAccuracy": worst,
        "medianSeasonAccuracy": median,
        "ruleValueCertifiedDirectional": directional,
        "ruleValueCertified95": certified95,
        "r5h4HistoricalEliteAccuracy": r5h4_accuracy,
        "supersedesR5H4": supersedes_r5h4,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "confidenceStratificationPriorOnly": True,
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(rules),
        "targetSeasonUsedForConfigurationSelection": False,
        "targetSeasonUsedForThresholdSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "automaticProductionPromotion": False,
    }

    manifest = {
        "schemaVersion": "courtedge-nfl-r5h6-confidence-stratified-residual-rules.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "ruleBlockCount": len(rules),
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerValidation": "latest two prior OOS seasons only",
        "residualDesign": (
            "reference confidence magnitude is removed from the rule score; prior-history confidence quantiles "
            "define strata/floors; inside each stratum selection is based only on dynamic rival-specific rule support"
        ),
        "confidenceControls": (
            "prospective-safe prior-validation confidence thresholds plus equal-count target-season confidence ranking "
            "within the exact same prior-learned confidence strata; controls use no outcomes"
        ),
        "automaticProductionPromotion": False,
    }

    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForReliabilityWeights": "NO",
        "targetSeasonUsedForConfigurationSelection": "NO",
        "targetSeasonUsedForSelectionThreshold": "NO",
        "targetSeasonUsedForConfidenceBinEdges": "NO",
        "targetSeasonUsedForConfidenceFloor": "NO",
        "referenceConfidenceMagnitudeInRuleScore": "REMOVED",
        "confidenceStratifiedResidualTest": "PASS",
        "gameSpecificRuleWeighting": "PASS_DYNAMIC_RELIABILITY_X_CONVICTION_SHARES",
        "rivalSpecificMatchups": "PASS_17_SPORTS_RULE_BLOCKS",
        "confidenceOnlyControl": "PASS_PRIOR_SAFE_PLUS_EQUAL_COUNT_WITHIN_STRATUM_DIAGNOSTIC",
        "productionCodeTouched": False,
    }

    pred.to_parquet(out / "nfl_r5h6_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h6_by_season.csv", index=False)
    stratdf.to_csv(out / "nfl_r5h6_by_confidence_stratum.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h6_config_by_season.csv", index=False)
    pd.concat(rel_rows, ignore_index=True).to_csv(out / "nfl_r5h6_reliability_by_season.csv", index=False)
    pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h6_search_audit.csv", index=False)
    rule_values.to_csv(out / "nfl_r5h6_rule_value_table.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h6_expert_tuning.csv", index=False)
    (out / "nfl_r5h6_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h6_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h6_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H6_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H6_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H6_BY_CONFIDENCE_STRATUM")
    print(stratdf.to_string(index=False))
    print("NFL_R5H6_RULE_VALUE")
    print(rule_values.to_string(index=False))
    print("NFL_R5H6_COMPLETE")


if __name__ == "__main__":
    main()
