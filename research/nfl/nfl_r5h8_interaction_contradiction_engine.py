#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h5_stability_rule_value_certification as r5h5
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H8_INTERACTION_CONTRADICTION_ENGINE"
SEED = 940830

# R5H8 does not add market data or new sports features. It changes how the existing
# 17 rival-specific sports rules are combined. Redundant simultaneous rules are
# discounted, prior-only pair interactions can raise/lower support, and explicit
# contradiction states are penalized. All weights remain game-specific.
TOP_K = (8, 12, 17)
RELIABILITY_POWER = (0.5, 1.0)
CONVICTION_POWER = (0.5, 1.0)
REDUNDANCY_LAMBDA = (0.5, 1.5)
SYNERGY_LAMBDA = (0.5, 1.0)
AGREEMENT_FLOOR = (0.55, 0.65)
DIVERSITY_POWER = (0.0, 1.0)
CONFIDENCE_BINS = (4, 6)
CONFIDENCE_FLOOR_QUANTILE = (0.50, 0.65)
RULE_SELECTION_RATE = (0.10, 0.15, 0.20)
VALIDATION_SEASONS = 3
MIN_FIT_SEASONS = 2
MIN_VALIDATION_SELECTIONS = 45
MIN_VALIDATION_PER_SEASON = 10
PAIR_PRIOR_N = 24.0
PAIR_MIN_N = 12
STRONG_LOGIT = 0.20


def clip_p(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def logit(p):
    p = clip_p(p)
    return np.log(p / (1.0 - p))


def ref_sign(df: pd.DataFrame) -> np.ndarray:
    return np.where(df.ref_p.to_numpy(dtype=float) >= 0.5, 1.0, -1.0)


def ref_correct(df: pd.DataFrame) -> np.ndarray:
    return r5h6.correctness(df).astype(float)


def shrunk_accuracy(correct: np.ndarray, mask: np.ndarray, prior_mean: float, prior_n: float = PAIR_PRIOR_N) -> tuple[float, int]:
    n = int(mask.sum())
    if n <= 0:
        return float(prior_mean), 0
    wins = float(correct[mask].sum())
    return float((wins + prior_n * prior_mean) / (n + prior_n)), n


def safe_logit_prob(p: float) -> float:
    q = min(max(float(p), 1e-5), 1.0 - 1e-5)
    return float(math.log(q / (1.0 - q)))


def learn_pair_structure(fit: pd.DataFrame, rules: list[str]) -> pd.DataFrame:
    correct = ref_correct(fit)
    global_acc = float(correct.mean())
    rs = ref_sign(fit)
    logits = {r: np.clip(logit(fit[f"p__{r}"].to_numpy(dtype=float)), -4.0, 4.0) for r in rules}
    support = {r: np.sign(logits[r]) * rs for r in rules}
    strong = {r: np.abs(logits[r]) >= STRONG_LOGIT for r in rules}

    rows = []
    for a, b in combinations(rules, 2):
        la, lb = logits[a], logits[b]
        if np.std(la) < 1e-9 or np.std(lb) < 1e-9:
            corr = 0.0
        else:
            corr = float(np.corrcoef(la, lb)[0, 1])
            if not np.isfinite(corr):
                corr = 0.0
        corr_abs = abs(corr)

        ma = (support[a] > 0) & strong[a]
        mb = (support[b] > 0) & strong[b]
        both = ma & mb
        disagree = (support[a] * support[b] < 0) & strong[a] & strong[b]

        aa, na = shrunk_accuracy(correct, ma, global_acc)
        ab, nb = shrunk_accuracy(correct, mb, global_acc)
        pair_acc, npair = shrunk_accuracy(correct, both, global_acc)
        disagree_acc, ndis = shrunk_accuracy(correct, disagree, global_acc)

        # Excess log-odds when both rules support the reference versus their average
        # individual support value. Shrink hard when the state is rare.
        raw_lift = safe_logit_prob(pair_acc) - 0.5 * (safe_logit_prob(aa) + safe_logit_prob(ab))
        shrink = npair / (npair + 36.0)
        lift = float(np.clip(raw_lift * shrink, -0.75, 0.75)) if npair >= PAIR_MIN_N else 0.0

        # Discordance reliability is diagnostic and contributes to the contradiction state.
        discord_risk = float(np.clip(global_acc - disagree_acc, -0.25, 0.25)) if ndis >= PAIR_MIN_N else 0.0
        rows.append({
            "rule_a": a,
            "rule_b": b,
            "corr": corr,
            "corr_abs": corr_abs,
            "both_support_n": npair,
            "both_support_accuracy_shrunk": pair_acc,
            "pair_logodds_lift": lift,
            "disagreement_n": ndis,
            "disagreement_accuracy_shrunk": disagree_acc,
            "discord_risk": discord_risk,
        })
    return pd.DataFrame(rows)


def score_games(
    df: pd.DataFrame,
    rel: pd.DataFrame,
    pair: pd.DataFrame,
    cfg: dict,
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray], dict[str, np.ndarray]]:
    k = min(int(cfg["top_k"]), len(rel))
    chosen = rel.head(k).copy()
    rules = chosen.rule.tolist()
    n = len(df)
    rs = ref_sign(df)
    base_w = np.power(np.maximum(chosen.reliability.to_numpy(dtype=float), 1e-8), float(cfg["reliability_power"]))

    logits = []
    raw_mass = []
    supports = []
    for j, rr in enumerate(rules):
        z = np.clip(logit(df[f"p__{rr}"].to_numpy(dtype=float)), -4.0, 4.0)
        conv = np.power(np.abs(z) + 1e-8, float(cfg["conviction_power"]))
        logits.append(z)
        raw_mass.append(base_w[j] * conv)
        supports.append(np.sign(z) * rs)
    Z = np.column_stack(logits)
    M0 = np.column_stack(raw_mass)
    SUP = np.column_stack(supports)

    # Per-game redundancy exposure. Highly correlated rules only get heavily discounted
    # when both are simultaneously active in this specific matchup.
    corr = np.zeros((k, k), dtype=float)
    lift = np.zeros((k, k), dtype=float)
    drisk = np.zeros((k, k), dtype=float)
    pidx = {(r.rule_a, r.rule_b): r for _, r in pair.iterrows()}
    pidx.update({(r.rule_b, r.rule_a): r for _, r in pair.iterrows()})
    for i, a in enumerate(rules):
        for j, b in enumerate(rules):
            if i == j:
                continue
            row = pidx.get((a, b))
            if row is not None:
                corr[i, j] = float(row.corr_abs)
                lift[i, j] = float(row.pair_logodds_lift)
                drisk[i, j] = float(row.discord_risk)

    act = np.abs(Z) / 4.0
    exposure = np.zeros_like(M0)
    denom_pairs = max(k - 1, 1)
    for i in range(k):
        e = np.zeros(n, dtype=float)
        for j in range(k):
            if i == j:
                continue
            e += corr[i, j] * np.minimum(act[:, i], act[:, j])
        exposure[:, i] = e / denom_pairs
    M = M0 / (1.0 + float(cfg["redundancy_lambda"]) * exposure)

    total = np.maximum(M.sum(axis=1), 1e-12)
    support_mask = SUP > 0
    agree_mass = (M * support_mask).sum(axis=1)
    agreement = agree_mass / total
    signed_consensus = (M * np.where(support_mask, 1.0, -1.0)).sum(axis=1) / total

    # Pair interaction value is only activated by the state actually present in the game.
    synergy = np.zeros(n, dtype=float)
    contradiction_pair_risk = np.zeros(n, dtype=float)
    for i in range(k):
        for j in range(i + 1, k):
            pair_mass = np.minimum(M[:, i], M[:, j]) / total
            both_support = support_mask[:, i] & support_mask[:, j] & (np.abs(Z[:, i]) >= STRONG_LOGIT) & (np.abs(Z[:, j]) >= STRONG_LOGIT)
            disagree = (support_mask[:, i] != support_mask[:, j]) & (np.abs(Z[:, i]) >= STRONG_LOGIT) & (np.abs(Z[:, j]) >= STRONG_LOGIT)
            synergy += pair_mass * lift[i, j] * both_support
            contradiction_pair_risk += pair_mass * np.maximum(drisk[i, j], 0.0) * disagree

    support_M = M * support_mask
    support_total = np.maximum(support_M.sum(axis=1), 1e-12)
    support_share = support_M / support_total[:, None]
    hhi = np.sum(support_share ** 2, axis=1)
    max_div = 1.0 - 1.0 / max(k, 1)
    diversity = np.where(max_div > 0, np.clip((1.0 - hhi) / max_div, 0.0, 1.0), 0.0)
    mean_exposure = np.sum((M0 / np.maximum(M0.sum(axis=1), 1e-12)[:, None]) * exposure, axis=1)

    eligible = (signed_consensus > 0.0) & (agreement >= float(cfg["agreement_floor"]))
    interaction_multiplier = np.exp(np.clip(float(cfg["synergy_lambda"]) * synergy - contradiction_pair_risk, -1.5, 1.5))
    score = (
        np.power(np.maximum(agreement, 1e-8), 2.0)
        * (0.5 + 0.5 * np.maximum(signed_consensus, 0.0))
        * interaction_multiplier
        * np.power(0.5 + 0.5 * diversity, float(cfg["diversity_power"]))
    )
    score = np.where(eligible, score, 0.0)

    shares = {r: np.zeros(n, dtype=float) for r in rel.rule.tolist()}
    for i, rr in enumerate(rules):
        shares[rr] = M[:, i] / total
    state = {
        "signed_consensus": signed_consensus,
        "synergy": synergy,
        "contradiction_pair_risk": contradiction_pair_risk,
        "diversity": diversity,
        "hhi": hhi,
        "redundancy_exposure": mean_exposure,
    }
    return score, agreement, shares, state


def state_label(agreement, synergy, redundancy, contradiction):
    out = []
    for a, s, r, c in zip(agreement, synergy, redundancy, contradiction):
        if c > 0.01 or a < 0.65:
            out.append("CONTRADICTION")
        elif s < -0.01:
            out.append("FALSE_CONSENSUS_RISK")
        elif r >= 0.30:
            out.append("REDUNDANT_CONSENSUS")
        elif s > 0.01:
            out.append("POSITIVE_INTERACTION")
        else:
            out.append("DIVERSE_CONSENSUS")
    return np.asarray(out, dtype=object)


def select_config(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < VALIDATION_SEASONS + MIN_FIT_SEASONS:
        raise RuntimeError("R5H8 insufficient meta history")
    val_years = years[-VALIDATION_SEASONS:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    rel = r5h4.reliability_table(fit, rules)
    pair = learn_pair_structure(fit, rules)
    fit_conf = r5h6.conf_score(fit)

    best = None
    search_rows = []
    for k in TOP_K:
        for rp in RELIABILITY_POWER:
            for cp in CONVICTION_POWER:
                for red in REDUNDANCY_LAMBDA:
                    for syn in SYNERGY_LAMBDA:
                        for af in AGREEMENT_FLOOR:
                            for dp in DIVERSITY_POWER:
                                base_cfg = {
                                    "top_k": int(k),
                                    "reliability_power": float(rp),
                                    "conviction_power": float(cp),
                                    "redundancy_lambda": float(red),
                                    "synergy_lambda": float(syn),
                                    "agreement_floor": float(af),
                                    "diversity_power": float(dp),
                                }
                                score, agreement, _, state = score_games(val, rel, pair, base_cfg)
                                for nb in CONFIDENCE_BINS:
                                    edges = r5h6.make_edges(fit_conf, nb)
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
                                            cm = r5h6.metrics(val, matched)
                                            cs = r5h6.metrics(val, safe)
                                            if cm["games"] <= 0 or cs["games"] <= 0:
                                                continue

                                            annual = []
                                            valid = True
                                            for vy in val_years:
                                                iy = val.season.to_numpy(dtype=int) == vy
                                                nsel = int((selected & iy).sum())
                                                if nsel < MIN_VALIDATION_PER_SEASON:
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

                                            pooled_delta = float(sm["accuracy"] - cm["accuracy"])
                                            safe_delta = float(sm["accuracy"] - cs["accuracy"])
                                            min_acc = min(v[1]["accuracy"] for v in annual)
                                            min_delta = min(v[1]["accuracy"] - v[2]["accuracy"] for v in annual)
                                            min_wilson = min(v[1]["wilson95_lower"] for v in annual)
                                            coverage = sm["games"] / len(val)
                                            stable_gate = int(min_acc >= 0.68 and min_delta >= -0.05)
                                            positive_gate = int(pooled_delta > 0 and safe_delta > 0)
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
                                                "validation_matched_accuracy": cm["accuracy"],
                                                "validation_safe_accuracy": cs["accuracy"],
                                                "validation_delta_vs_matched": pooled_delta,
                                                "validation_delta_vs_safe": safe_delta,
                                                "validation_min_season_accuracy": float(min_acc),
                                                "validation_min_season_delta_vs_matched": float(min_delta),
                                                "validation_min_season_wilson": float(min_wilson),
                                                "validation_mean_synergy_selected": float(state["synergy"][selected].mean()),
                                                "validation_mean_redundancy_selected": float(state["redundancy_exposure"][selected].mean()),
                                                "bin_edges": json.dumps([None if not np.isfinite(v) else float(v) for v in edges]),
                                                "rule_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in rule_thr.items()}, sort_keys=True),
                                                "safe_conf_thresholds": json.dumps({str(b): (None if not np.isfinite(t) else float(t)) for b, t in safe_thr.items()}, sort_keys=True),
                                            }
                                            search_rows.append(row)
                                            key = (
                                                stable_gate,
                                                positive_gate,
                                                min_wilson,
                                                min_delta,
                                                pooled_delta,
                                                sm["wilson95_lower"],
                                                sm["accuracy"],
                                                coverage,
                                                -int(k),
                                            )
                                            if best is None or key > best[0]:
                                                best = (key, row)
    if best is None:
        raise RuntimeError("R5H8 found no configuration meeting robust validation requirements")
    cfg = dict(best[1])
    cfg["inner_fit_seasons"] = sorted(int(v) for v in fit.season.unique())
    cfg["inner_validation_seasons"] = val_years
    cfg["selection_objective"] = (
        "ROBUST_3_SEASON_INTERACTION_VALUE:STABILITY_GATE_THEN_POSITIVE_MATCHED_CONFIDENCE_VALUE_"
        "THEN_MIN_WILSON_MIN_DELTA_POOLED_DELTA_ACCURACY_COVERAGE"
    )
    return cfg, rel, pair, pd.DataFrame(search_rows)


def decode_edges(text: str) -> np.ndarray:
    return r5h6.decode_edges(text)


def decode_thresholds(text: str) -> dict[int, float]:
    return r5h6.decode_thresholds(text)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h8-output")
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
        raise RuntimeError(f"R5H8 missing sports inputs: {missing}")

    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, expert_tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ref = r5h4.reference_oos(x, a.expert_oos_start, a.end_season)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    rows, cfg_rows, rel_rows, pair_rows, search_rows = [], [], [], [], []
    for y in range(a.test_start, a.end_season + 1):
        mt = meta[meta.season < y].copy()
        te = meta[meta.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, rel, pair, search = select_config(mt, rules)
        score, agreement, shares, state = score_games(te, rel, pair, cfg)
        edges = decode_edges(cfg["bin_edges"])
        floor = float(cfg["confidence_floor"])
        rule_thr = decode_thresholds(cfg["rule_thresholds"])
        safe_thr = decode_thresholds(cfg["safe_conf_thresholds"])
        selected, bins = r5h6.apply_rule_thresholds(te, score, edges, floor, rule_thr)
        safe, _ = r5h6.apply_safe_conf(te, edges, floor, safe_thr)
        matched = r5h6.matched_confidence_within_bins(te, selected, edges, floor)

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["interaction_score"] = score
        q["agreement"] = agreement
        q["confidence_score"] = r5h6.conf_score(te)
        q["confidence_stratum"] = bins
        q["selected"] = selected.astype(int)
        q["confidence_control_safe"] = safe.astype(int)
        q["confidence_control_matched"] = matched.astype(int)
        for name, vals in state.items():
            q[name] = vals
        q["interaction_state"] = state_label(agreement, state["synergy"], state["redundancy_exposure"], state["contradiction_pair_risk"])
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = shares[rr]
        rows.append(q)

        sm = r5h6.metrics(te, selected)
        cs = r5h6.metrics(te, safe)
        cm = r5h6.metrics(te, matched)
        cfg_rows.append({
            "test_season": int(y), **cfg,
            "test_selected_games": sm["games"], "test_selected_accuracy": sm["accuracy"],
            "test_safe_conf_games": cs["games"], "test_safe_conf_accuracy": cs["accuracy"],
            "test_matched_conf_games": cm["games"], "test_matched_conf_accuracy": cm["accuracy"],
            "test_delta_vs_safe_conf": float(sm["accuracy"] - cs["accuracy"]) if cs["games"] else np.nan,
            "test_delta_vs_matched_conf": float(sm["accuracy"] - cm["accuracy"]) if cm["games"] else np.nan,
        })
        rr = rel.copy(); rr["test_season"] = int(y); rel_rows.append(rr)
        pp = pair.copy(); pp["test_season"] = int(y); pair_rows.append(pp)
        search["test_season"] = int(y); search_rows.append(search)

    pred = pd.concat(rows, ignore_index=True)
    sel = pred.selected.to_numpy(dtype=bool)
    safe = pred.confidence_control_safe.to_numpy(dtype=bool)
    matched = pred.confidence_control_matched.to_numpy(dtype=bool)
    sm = r5h6.metrics(pred, sel); cs = r5h6.metrics(pred, safe); cm = r5h6.metrics(pred, matched)
    boot_safe = r5h6.bootstrap_difference(pred, "selected", "confidence_control_safe")
    boot_matched = r5h6.bootstrap_difference(pred, "selected", "confidence_control_matched")

    by = []
    for y, g in pred.groupby("season"):
        ma = r5h6.metrics(g, g.selected.to_numpy(dtype=bool))
        ms = r5h6.metrics(g, g.confidence_control_safe.to_numpy(dtype=bool))
        mm = r5h6.metrics(g, g.confidence_control_matched.to_numpy(dtype=bool))
        by.append({
            "season": int(y), "all_games": int(len(g)),
            "selected_games": ma["games"], "selected_accuracy": ma["accuracy"],
            "safe_conf_games": ms["games"], "safe_conf_accuracy": ms["accuracy"],
            "matched_conf_games": mm["games"], "matched_conf_accuracy": mm["accuracy"],
            "delta_vs_safe_conf": float(ma["accuracy"] - ms["accuracy"]) if ms["games"] else np.nan,
            "delta_vs_matched_conf": float(ma["accuracy"] - mm["accuracy"]) if mm["games"] else np.nan,
        })
    bydf = pd.DataFrame(by)

    state_rows = []
    for st, g in pred[sel].groupby("interaction_state"):
        m = r5h6.metrics(g, np.ones(len(g), dtype=bool))
        state_rows.append({
            "interaction_state": st, "games": m["games"], "wins": m["wins"],
            "accuracy": m["accuracy"], "mean_synergy": float(g.synergy.mean()),
            "mean_redundancy_exposure": float(g.redundancy_exposure.mean()),
            "mean_agreement": float(g.agreement.mean()),
        })
    statedf = pd.DataFrame(state_rows).sort_values(["games", "interaction_state"], ascending=[False, True])

    rule_values = r5h5.rule_value_table(pred, rules)
    positive_matched = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative_matched = int((bydf.delta_vs_matched_conf >= 0).sum())
    positive_safe = int((bydf.delta_vs_safe_conf > 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())
    directional = bool(sm["accuracy"] > cm["accuracy"] and sm["accuracy"] > cs["accuracy"] and positive_matched >= 5)
    certified95 = bool(directional and boot_matched["better95"] and boot_safe["better95"])
    r5h4_acc = 0.7726161369193154
    r5h6_acc = 0.7635658914728682
    supersedes_r5h4 = bool(certified95 and sm["accuracy"] > r5h4_acc and worst >= 0.70)
    improves_r5h6 = bool(sm["accuracy"] > r5h6_acc and worst > 0.6086956521739131 and sm["accuracy"] > cm["accuracy"])

    summary = {
        "stage": "NFL-R5H8_INTERACTION_CONTRADICTION_ENGINE",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(pred)),
        "selectedGames": sm["games"], "selectedWins": sm["wins"], "selectedLosses": sm["losses"],
        "selectedAccuracy": sm["accuracy"], "selectedCoverage": float(sm["games"] / len(pred)),
        "selectedWilson95Lower": sm["wilson95_lower"],
        "safeConfidenceControlGames": cs["games"], "safeConfidenceControlAccuracy": cs["accuracy"],
        "matchedConfidenceControlGames": cm["games"], "matchedConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsSafeConfidence": float(sm["accuracy"] - cs["accuracy"]),
        "accuracyDeltaVsMatchedConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsSafeConfidence": boot_safe,
        "bootstrapDeltaVsMatchedConfidence": boot_matched,
        "positiveOuterSeasonsVsSafeConfidence": positive_safe,
        "positiveOuterSeasonsVsMatchedConfidence": positive_matched,
        "nonnegativeOuterSeasonsVsMatchedConfidence": nonnegative_matched,
        "worstSeasonAccuracy": worst, "medianSeasonAccuracy": median,
        "ruleValueCertifiedDirectional": directional, "ruleValueCertified95": certified95,
        "r5h4HistoricalEliteAccuracy": r5h4_acc, "r5h6HistoricalAccuracy": r5h6_acc,
        "improvesR5H6AccuracyAndStability": improves_r5h6,
        "supersedesR5H4": supersedes_r5h4,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(rules),
        "pairInteractionLearningPriorOnly": True,
        "redundancyPenaltyGameSpecific": True,
        "contradictionStateModeled": True,
        "targetSeasonUsedForConfigurationSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "targetSeasonUsedForPairInteractionLearning": False,
        "targetSeasonUsedForThresholdSelection": False,
        "automaticProductionPromotion": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h8-interaction-contradiction.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "ruleBlockCount": len(rules),
        "outerValidation": "expanding-season OOS 2018-2025",
        "innerValidation": "latest three prior OOS seasons; pair/redundancy structure fit only on earlier prior seasons",
        "interactionDesign": (
            "per-game rule mass = prior reliability x matchup conviction, discounted by simultaneous pair correlation; "
            "prior-only pair log-odds lift adjusts false/positive consensus; contradiction pair risk and support diversity enter the game score"
        ),
        "confidenceUse": "reference confidence magnitude is excluded from rule score; prior-only confidence strata/floors and matched controls only",
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
        "gameSpecificRuleWeighting": "PASS_DYNAMIC_RELIABILITY_X_CONVICTION_X_REDUNDANCY_ADJUSTMENT",
        "pairInteractionModel": "PASS_PRIOR_ONLY_PAIR_LIFT_AND_DISCORD_RISK",
        "contradictionStateModel": "PASS",
        "rivalSpecificMatchups": "PASS_17_SPORTS_RULE_BLOCKS",
        "productionCodeTouched": False,
    }

    pred.to_parquet(out / "nfl_r5h8_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h8_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h8_config_by_season.csv", index=False)
    pd.concat(rel_rows, ignore_index=True).to_csv(out / "nfl_r5h8_reliability_by_season.csv", index=False)
    pd.concat(pair_rows, ignore_index=True).to_csv(out / "nfl_r5h8_pair_structure_by_season.csv", index=False)
    pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h8_inner_search.csv", index=False)
    statedf.to_csv(out / "nfl_r5h8_selected_interaction_states.csv", index=False)
    rule_values.to_csv(out / "nfl_r5h8_rule_value_table.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h8_expert_tuning.csv", index=False)
    (out / "nfl_r5h8_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h8_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h8_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H8_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H8_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H8_INTERACTION_STATES")
    print(statedf.to_string(index=False))
    print("NFL_R5H8_TOP_PAIR_LIFTS")
    pp = pd.concat(pair_rows, ignore_index=True)
    print(pp.groupby(["rule_a", "rule_b"], as_index=False).agg(mean_lift=("pair_logodds_lift", "mean"), mean_corr=("corr_abs", "mean"), seasons=("test_season", "nunique")).sort_values("mean_lift", ascending=False).head(15).to_string(index=False))
    print("NFL_R5H8_COMPLETE")


if __name__ == "__main__":
    main()
