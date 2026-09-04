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
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H7_FAILURE_REGIME_STABILITY_GATE"
SEED = 940830

# R5H7 starts from the leakage-safe R5H6 residual rule engine and learns transparent
# failure vetoes only from prior validation seasons. The veto never changes the winner
# direction; it only decides when the dynamic rule combination is too unstable to recommend.
SCORE_KEEP_QUANTILE = (0.00, 0.15, 0.30, 0.45)
MIN_AGREEMENT = (0.50, 0.95, 0.98, 0.995)
MAX_TOP1_SHARE = (1.00, 0.30, 0.24, 0.20)
REGIME_MODE = ("NONE", "STRATUM", "STRATUM_PHASE")
BAD_DELTA_TRIGGER = (0.00, -0.03, -0.06)
MIN_REGIME_GAMES = (6, 10, 14)
MIN_VALIDATION_SELECTIONS = 35
MIN_VALIDATION_PER_SEASON = 9


def correctness(df: pd.DataFrame) -> np.ndarray:
    return r5h6.correctness(df)


def metrics(df: pd.DataFrame, mask: np.ndarray) -> dict:
    return r5h6.metrics(df, mask)


def phase_bucket(df: pd.DataFrame) -> np.ndarray:
    w = pd.to_numeric(df.week, errors="coerce").fillna(0).to_numpy(dtype=float)
    return np.where(w <= 4, 0, np.where(w <= 12, 1, 2)).astype(int)


def support_shape(shares: dict[str, np.ndarray], rules: list[str]) -> tuple[np.ndarray, np.ndarray]:
    m = np.column_stack([np.asarray(shares[r], dtype=float) for r in rules])
    top1 = np.max(m, axis=1)
    hhi = np.sum(m * m, axis=1)
    return top1, hhi


def regime_labels(bins: np.ndarray, phases: np.ndarray, mode: str) -> np.ndarray:
    if mode == "NONE":
        return np.asarray(["ALL"] * len(bins), dtype=object)
    if mode == "STRATUM":
        return np.asarray([f"B{int(b)}" for b in bins], dtype=object)
    if mode == "STRATUM_PHASE":
        return np.asarray([f"B{int(b)}_P{int(p)}" for b, p in zip(bins, phases)], dtype=object)
    raise ValueError(mode)


def matched_confidence_within_regimes(
    df: pd.DataFrame,
    candidate: np.ndarray,
    bins: np.ndarray,
    phases: np.ndarray,
    mode: str,
    floor: float,
) -> np.ndarray:
    conf = r5h6.conf_score(df)
    active = conf >= float(floor)
    labels = regime_labels(bins, phases, mode)
    out = np.zeros(len(df), dtype=bool)
    for lab in np.unique(labels):
        idx = np.flatnonzero((labels == lab) & active)
        k = int((candidate & (labels == lab) & active).sum())
        if k <= 0 or len(idx) == 0:
            continue
        order = idx[np.argsort(-conf[idx], kind="stable")]
        out[order[: min(k, len(order))]] = True
    return out


def initial_filter(
    base_selected: np.ndarray,
    score: np.ndarray,
    agreement: np.ndarray,
    top1: np.ndarray,
    score_threshold: float,
    min_agreement: float,
    max_top1: float,
) -> np.ndarray:
    return (
        base_selected
        & (score >= float(score_threshold))
        & (agreement >= float(min_agreement))
        & (top1 <= float(max_top1) + 1e-12)
    )


def learn_vetoes(
    val: pd.DataFrame,
    selected: np.ndarray,
    matched: np.ndarray,
    bins: np.ndarray,
    phases: np.ndarray,
    mode: str,
    min_games: int,
    bad_delta_trigger: float,
) -> tuple[set[str], pd.DataFrame]:
    if mode == "NONE":
        return set(), pd.DataFrame([{"regime": "ALL", "veto": False}])
    labels = regime_labels(bins, phases, mode)
    rows = []
    vetoes: set[str] = set()
    for lab in sorted(np.unique(labels)):
        im = labels == lab
        a = metrics(val, selected & im)
        b = metrics(val, matched & im)
        delta = np.nan
        veto = False
        if a["games"] > 0 and b["games"] > 0:
            delta = float(a["accuracy"] - b["accuracy"])
            # Only prior-validation regimes with enough evidence and clearly negative residual
            # value are vetoed. Sparse regimes remain eligible rather than being guessed away.
            veto = bool(
                a["games"] >= int(min_games)
                and b["games"] >= int(min_games)
                and delta <= float(bad_delta_trigger)
                and a["accuracy"] < 0.72
            )
        if veto:
            vetoes.add(str(lab))
        rows.append({
            "regime": str(lab),
            "candidate_games": a["games"],
            "candidate_accuracy": a["accuracy"],
            "control_games": b["games"],
            "control_accuracy": b["accuracy"],
            "delta_vs_control": delta,
            "veto": veto,
        })
    return vetoes, pd.DataFrame(rows)


def apply_vetoes(selected: np.ndarray, bins: np.ndarray, phases: np.ndarray, mode: str, vetoes: set[str]) -> np.ndarray:
    if not vetoes or mode == "NONE":
        return selected.copy()
    labels = regime_labels(bins, phases, mode)
    bad = np.isin(labels, list(vetoes))
    return selected & ~bad


def season_stability(val: pd.DataFrame, selected: np.ndarray, matched: np.ndarray, years: list[int]) -> tuple[bool, dict]:
    annual = []
    valid = True
    for y in years:
        iy = val.season.to_numpy(dtype=int) == int(y)
        a = metrics(val, selected & iy)
        b = metrics(val, matched & iy)
        if a["games"] < MIN_VALIDATION_PER_SEASON or b["games"] < MIN_VALIDATION_PER_SEASON:
            valid = False
            break
        annual.append({
            "season": int(y),
            "candidate_games": a["games"],
            "candidate_accuracy": a["accuracy"],
            "candidate_wilson": a["wilson95_lower"],
            "control_accuracy": b["accuracy"],
            "delta": float(a["accuracy"] - b["accuracy"]),
        })
    if not valid:
        return False, {}
    return True, {
        "annual": annual,
        "min_accuracy": float(min(r["candidate_accuracy"] for r in annual)),
        "min_wilson": float(min(r["candidate_wilson"] for r in annual)),
        "min_delta": float(min(r["delta"] for r in annual)),
    }


def select_failure_gate(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    # First learn the R5H6 base only from prior history.
    base_cfg, rel, _ = r5h6.select_config(meta_train, rules)
    val_years = [int(v) for v in base_cfg["inner_validation_seasons"]]
    val = meta_train[meta_train.season.isin(val_years)].copy()

    score, agreement, shares = r5h6.rule_only_score(val, rel, base_cfg)
    edges = r5h6.decode_edges(base_cfg["bin_edges"])
    rule_thr = r5h6.decode_thresholds(base_cfg["rule_thresholds"])
    floor = float(base_cfg["confidence_floor"])
    base_selected, bins = r5h6.apply_rule_thresholds(val, score, edges, floor, rule_thr)
    phases = phase_bucket(val)
    top1, hhi = support_shape(shares, rules)

    best = None
    search_rows = []
    regime_rows = []

    positive_scores = score[base_selected & np.isfinite(score)]
    if len(positive_scores) == 0:
        raise RuntimeError("R5H7 base R5H6 selected no prior-validation games")

    for sq in SCORE_KEEP_QUANTILE:
        score_threshold = float(np.quantile(positive_scores, float(sq)))
        for amin in MIN_AGREEMENT:
            for tmax in MAX_TOP1_SHARE:
                initial = initial_filter(base_selected, score, agreement, top1, score_threshold, amin, tmax)
                if int(initial.sum()) < MIN_VALIDATION_SELECTIONS:
                    continue
                for mode in REGIME_MODE:
                    for bd in BAD_DELTA_TRIGGER:
                        for min_n in MIN_REGIME_GAMES:
                            pre_match = matched_confidence_within_regimes(val, initial, bins, phases, mode, floor)
                            vetoes, vr = learn_vetoes(val, initial, pre_match, bins, phases, mode, min_n, bd)
                            selected = apply_vetoes(initial, bins, phases, mode, vetoes)
                            if int(selected.sum()) < MIN_VALIDATION_SELECTIONS:
                                continue
                            matched = matched_confidence_within_regimes(val, selected, bins, phases, mode, floor)
                            a = metrics(val, selected)
                            b = metrics(val, matched)
                            if b["games"] == 0:
                                continue
                            stable, stab = season_stability(val, selected, matched, val_years)
                            if not stable:
                                continue
                            delta = float(a["accuracy"] - b["accuracy"])
                            coverage = float(a["games"] / len(val))
                            row = {
                                "score_keep_quantile": float(sq),
                                "score_threshold": float(score_threshold),
                                "min_agreement": float(amin),
                                "max_top1_share": float(tmax),
                                "regime_mode": mode,
                                "bad_delta_trigger": float(bd),
                                "min_regime_games": int(min_n),
                                "validation_games": a["games"],
                                "validation_accuracy": a["accuracy"],
                                "validation_wilson95_lower": a["wilson95_lower"],
                                "validation_matched_accuracy": b["accuracy"],
                                "validation_delta_vs_matched": delta,
                                "validation_min_season_accuracy": stab["min_accuracy"],
                                "validation_min_season_wilson": stab["min_wilson"],
                                "validation_min_season_delta": stab["min_delta"],
                                "validation_coverage": coverage,
                                "veto_count": int(len(vetoes)),
                                "veto_regimes": json.dumps(sorted(vetoes)),
                                "mean_top1_share_selected": float(top1[selected].mean()),
                                "mean_hhi_selected": float(hhi[selected].mean()),
                            }
                            search_rows.append(row)
                            if not vr.empty:
                                z = vr.copy()
                                z["candidate_score_keep_quantile"] = float(sq)
                                z["candidate_min_agreement"] = float(amin)
                                z["candidate_max_top1_share"] = float(tmax)
                                z["candidate_regime_mode"] = mode
                                z["candidate_bad_delta_trigger"] = float(bd)
                                z["candidate_min_regime_games"] = int(min_n)
                                regime_rows.append(z)

                            # Stability first: avoid another 2025-style collapse. Then reward residual
                            # value versus confidence-matched controls, robust lower bound, accuracy, coverage.
                            floor70 = int(stab["min_accuracy"] >= 0.70)
                            nonnegative_all = int(stab["min_delta"] >= 0.0)
                            key = (
                                floor70,
                                stab["min_accuracy"],
                                nonnegative_all,
                                stab["min_delta"],
                                delta,
                                a["wilson95_lower"],
                                a["accuracy"],
                                coverage,
                                -int(len(vetoes)),
                            )
                            if best is None or key > best[0]:
                                best = (key, row)

    if best is None:
        raise RuntimeError("R5H7 found no failure-gate configuration meeting stability/sample requirements")

    cfg = dict(best[1])
    cfg["inner_validation_seasons"] = val_years
    cfg["inner_fit_seasons"] = [int(v) for v in base_cfg["inner_fit_seasons"]]
    cfg["base_r5h6_config"] = base_cfg
    cfg["selection_objective"] = (
        "MAXIMIZE_WORST_SEASON_ACCURACY_THEN_NONNEGATIVE_RESIDUAL_VALUE_"
        "THEN_MATCHED_CONFIDENCE_DELTA_WILSON_ACCURACY_COVERAGE"
    )
    return cfg, rel, pd.DataFrame(search_rows)


def apply_config(df: pd.DataFrame, rel: pd.DataFrame, cfg: dict, rules: list[str]):
    base_cfg = cfg["base_r5h6_config"]
    score, agreement, shares = r5h6.rule_only_score(df, rel, base_cfg)
    edges = r5h6.decode_edges(base_cfg["bin_edges"])
    rule_thr = r5h6.decode_thresholds(base_cfg["rule_thresholds"])
    floor = float(base_cfg["confidence_floor"])
    base_selected, bins = r5h6.apply_rule_thresholds(df, score, edges, floor, rule_thr)
    phases = phase_bucket(df)
    top1, hhi = support_shape(shares, rules)
    initial = initial_filter(
        base_selected,
        score,
        agreement,
        top1,
        float(cfg["score_threshold"]),
        float(cfg["min_agreement"]),
        float(cfg["max_top1_share"]),
    )
    vetoes = set(json.loads(cfg["veto_regimes"]))
    selected = apply_vetoes(initial, bins, phases, str(cfg["regime_mode"]), vetoes)
    matched = matched_confidence_within_regimes(df, selected, bins, phases, str(cfg["regime_mode"]), floor)
    return {
        "score": score,
        "agreement": agreement,
        "shares": shares,
        "edges": edges,
        "floor": floor,
        "bins": bins,
        "phases": phases,
        "top1": top1,
        "hhi": hhi,
        "base_selected": base_selected,
        "initial_selected": initial,
        "selected": selected,
        "matched": matched,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h7-output")
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
        raise RuntimeError(f"R5H7 missing sports inputs: {missing}")

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

        cfg, rel, search = select_failure_gate(mt, rules)
        z = apply_config(te, rel, cfg, rules)
        selected = z["selected"]
        matched = z["matched"]

        # Prospective-safe confidence control is learned only from the same prior-validation seasons,
        # matching the final R5H7 selection counts by the R5H6 confidence strata.
        val_years = [int(v) for v in cfg["inner_validation_seasons"]]
        val = mt[mt.season.isin(val_years)].copy()
        zv = apply_config(val, rel, cfg, rules)
        safe_thr = r5h6.learn_safe_conf_thresholds(val, zv["selected"], zv["edges"], zv["floor"])
        safe, _ = r5h6.apply_safe_conf(te, z["edges"], z["floor"], safe_thr)

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["rule_residual_score"] = z["score"]
        q["agreement"] = z["agreement"]
        q["confidence_score"] = r5h6.conf_score(te)
        q["confidence_stratum"] = z["bins"]
        q["phase_bucket"] = z["phases"]
        q["top1_rule_weight_share"] = z["top1"]
        q["rule_weight_hhi"] = z["hhi"]
        q["r5h6_base_selected"] = z["base_selected"].astype(int)
        q["pre_veto_selected"] = z["initial_selected"].astype(int)
        q["selected"] = selected.astype(int)
        q["confidence_control_safe"] = safe.astype(int)
        q["confidence_control_matched_regime"] = matched.astype(int)
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = z["shares"][rr]
        rows.append(q)

        sm = metrics(te, selected); cs = metrics(te, safe); cm = metrics(te, matched)
        cfg_rows.append({
            "test_season": int(y),
            **{k: v for k, v in cfg.items() if k != "base_r5h6_config"},
            "base_r5h6_config": json.dumps(cfg["base_r5h6_config"], sort_keys=True),
            "test_selected_games": sm["games"],
            "test_selected_accuracy": sm["accuracy"],
            "test_safe_conf_games": cs["games"],
            "test_safe_conf_accuracy": cs["accuracy"],
            "test_matched_regime_games": cm["games"],
            "test_matched_regime_accuracy": cm["accuracy"],
            "test_delta_vs_safe_conf": float(sm["accuracy"] - cs["accuracy"]) if cs["games"] else np.nan,
            "test_delta_vs_matched_regime": float(sm["accuracy"] - cm["accuracy"]) if cm["games"] else np.nan,
        })
        rr = rel.copy(); rr["test_season"] = int(y); rel_rows.append(rr)
        search["test_season"] = int(y); search_rows.append(search)

    pred = pd.concat(rows, ignore_index=True)
    sel = pred.selected.to_numpy(dtype=bool)
    safe = pred.confidence_control_safe.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched_regime.to_numpy(dtype=bool)
    sm = metrics(pred, sel); cs = metrics(pred, safe); cm = metrics(pred, matched)

    by = []
    for y, g in pred.groupby("season"):
        a1 = g.selected.to_numpy(dtype=bool)
        b1 = g.confidence_control_safe.to_numpy(dtype=bool)
        c1 = g.confidence_control_matched_regime.to_numpy(dtype=bool)
        ma = metrics(g, a1); mb = metrics(g, b1); mc = metrics(g, c1)
        by.append({
            "season": int(y), "all_games": int(len(g)),
            "selected_games": ma["games"], "selected_accuracy": ma["accuracy"],
            "safe_conf_games": mb["games"], "safe_conf_accuracy": mb["accuracy"],
            "matched_regime_games": mc["games"], "matched_regime_accuracy": mc["accuracy"],
            "delta_vs_safe_conf": float(ma["accuracy"] - mb["accuracy"]) if mb["games"] else np.nan,
            "delta_vs_matched_regime": float(ma["accuracy"] - mc["accuracy"]) if mc["games"] else np.nan,
        })
    bydf = pd.DataFrame(by)

    boot_safe = r5h6.bootstrap_difference(pred, "selected", "confidence_control_safe")
    boot_matched = r5h6.bootstrap_difference(pred, "selected", "confidence_control_matched_regime")
    rule_values = r5h5.rule_value_table(pred, rules)

    positive_safe = int((bydf.delta_vs_safe_conf > 0).sum())
    positive_matched = int((bydf.delta_vs_matched_regime > 0).sum())
    nonnegative_matched = int((bydf.delta_vs_matched_regime >= 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())

    directional = bool(
        sm["accuracy"] > cs["accuracy"]
        and sm["accuracy"] > cm["accuracy"]
        and positive_matched >= 5
    )
    certified95 = bool(directional and boot_safe["better95"] and boot_matched["better95"])
    r5h6_accuracy = 0.7635658914728682
    r5h6_worst = 0.6086956521739131
    r5h4_accuracy = 0.7726161369193154
    improves_stability = bool(worst > r5h6_worst)
    supersedes_r5h6 = bool(
        improves_stability
        and sm["accuracy"] >= r5h6_accuracy
        and sm["accuracy"] > cm["accuracy"]
    )
    supersedes_r5h4 = bool(certified95 and sm["accuracy"] > r5h4_accuracy and worst >= 0.70)

    summary = {
        "stage": "NFL-R5H7_FAILURE_REGIME_STABILITY_GATE",
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
        "matchedRegimeConfidenceControlGames": cm["games"],
        "matchedRegimeConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsSafeConfidence": float(sm["accuracy"] - cs["accuracy"]),
        "accuracyDeltaVsMatchedRegimeConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsSafeConfidence": boot_safe,
        "bootstrapDeltaVsMatchedRegimeConfidence": boot_matched,
        "positiveOuterSeasonsVsSafeConfidence": positive_safe,
        "positiveOuterSeasonsVsMatchedRegimeConfidence": positive_matched,
        "nonnegativeOuterSeasonsVsMatchedRegimeConfidence": nonnegative_matched,
        "worstSeasonAccuracy": worst,
        "medianSeasonAccuracy": median,
        "ruleValueCertifiedDirectional": directional,
        "ruleValueCertified95": certified95,
        "r5h6HistoricalAccuracy": r5h6_accuracy,
        "r5h6HistoricalWorstSeasonAccuracy": r5h6_worst,
        "r5h4HistoricalEliteAccuracy": r5h4_accuracy,
        "improvesStabilityVsR5H6": improves_stability,
        "supersedesR5H6": supersedes_r5h6,
        "supersedesR5H4": supersedes_r5h4,
        "failureVetoLearnedPriorOnly": True,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(rules),
        "targetSeasonUsedForFailureVetoLearning": False,
        "targetSeasonUsedForConfigurationSelection": False,
        "targetSeasonUsedForThresholdSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "automaticProductionPromotion": False,
    }

    manifest = {
        "schemaVersion": "courtedge-nfl-r5h7-failure-regime-stability-gate.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "ruleBlockCount": len(rules),
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerValidation": "latest two prior OOS seasons only",
        "design": (
            "R5H6 residual rule selection plus transparent prior-learned stability filters and failure-regime vetoes. "
            "Failure regimes use confidence stratum and optional season phase; rule-score floor, agreement floor, "
            "and maximum single-rule weight share are all chosen on prior validation only."
        ),
        "controls": (
            "prospective-safe confidence thresholds learned on prior validation plus equal-count confidence controls "
            "inside the exact same target confidence/phase regimes; no target outcomes are used"
        ),
        "automaticProductionPromotion": False,
    }

    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForReliabilityWeights": "NO",
        "targetSeasonUsedForConfigurationSelection": "NO",
        "targetSeasonUsedForSelectionThreshold": "NO",
        "targetSeasonUsedForFailureVetoLearning": "NO",
        "referenceConfidenceMagnitudeInRuleScore": "REMOVED",
        "failureRegimeGate": "PASS_PRIOR_ONLY_TRANSPARENT_VETO",
        "gameSpecificRuleWeighting": "PASS_DYNAMIC_RELIABILITY_X_CONVICTION_SHARES",
        "rivalSpecificMatchups": "PASS_17_SPORTS_RULE_BLOCKS",
        "productionCodeTouched": False,
    }

    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h7_config_by_season.csv", index=False)
    pd.concat(rel_rows, ignore_index=True).to_csv(out / "nfl_r5h7_reliability_by_season.csv", index=False)
    pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h7_search_by_season.csv", index=False)
    bydf.to_csv(out / "nfl_r5h7_by_season.csv", index=False)
    rule_values.to_csv(out / "nfl_r5h7_rule_value_table.csv", index=False)
    pred.to_parquet(out / "nfl_r5h7_predictions.parquet", index=False)
    pred.to_csv(out / "nfl_r5h7_predictions.csv", index=False)
    (out / "nfl_r5h7_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    (out / "nfl_r5h7_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    (out / "nfl_r5h7_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True), encoding="utf-8")

    print("NFL_R5H7_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H7_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H7_RULE_VALUE")
    print(rule_values.to_string(index=False))
    print("NFL_R5H7_COMPLETE")


if __name__ == "__main__":
    main()
