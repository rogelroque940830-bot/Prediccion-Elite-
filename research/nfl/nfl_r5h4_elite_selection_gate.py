#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, log_loss

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy
import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H4_ELITE_SELECTION_GATE"
SEED = 940830
TOP_K = (3, 5, 8, 12, 17)
RELIABILITY_POWER = (0.5, 1.0, 2.0)
CONVICTION_POWER = (0.5, 1.0, 1.5)
REF_POWER = (0.5, 1.0, 2.0)
AGREEMENT_POWER = (1.0, 2.0, 3.0)
TARGET_COVERAGE = (0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50)
MIN_VALIDATION_SELECTIONS = 50


def clip_p(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def logit(p):
    p = clip_p(p)
    return np.log(p / (1.0 - p))


def wilson_lower(wins: int, n: int, z: float = 1.96) -> float:
    if n <= 0:
        return 0.0
    phat = wins / n
    den = 1.0 + z * z / n
    center = phat + z * z / (2.0 * n)
    adj = z * math.sqrt((phat * (1.0 - phat) + z * z / (4.0 * n)) / n)
    return float((center - adj) / den)


def reference_oos(x: pd.DataFrame, start: int, end: int) -> pd.DataFrame:
    cols = list(hy.feature_sets()[REFERENCE])
    rows = []
    for y in range(start, end + 1):
        tr, te = x[x.season < y], x[x.season == y]
        if tr.empty or te.empty:
            continue
        c = base.tune_logit(tr, cols)
        m = base.pipe("logit", c)
        m.fit(tr[cols], tr.home_win.astype(int))
        p = clip_p(m.predict_proba(te[cols])[:, 1])
        rows.append(pd.DataFrame({
            "game_id": te.game_id.to_numpy(),
            "season": y,
            "week": te.week.to_numpy(),
            "ref_p": p,
        }))
    if not rows:
        raise RuntimeError("R5H4 could not create reference OOS predictions")
    return pd.concat(rows, ignore_index=True)


def reliability_table(fit: pd.DataFrame, rules: list[str]) -> pd.DataFrame:
    rows = []
    for rr in rules:
        p = clip_p(fit[f"p__{rr}"].to_numpy())
        y = fit.y.to_numpy(dtype=int)
        acc = float(accuracy_score(y, p >= .5))
        ll = float(log_loss(y, p))
        skill_ll = max(math.log(2.0) - ll, 1e-5)
        skill_acc = max(acc - 0.5, 1e-5)
        # Both discrimination and probability quality must contribute to a rule's prior reliability.
        reliability = math.sqrt(skill_ll * skill_acc)
        rows.append({"rule": rr, "fit_accuracy": acc, "fit_log_loss": ll, "reliability": reliability})
    return pd.DataFrame(rows).sort_values(["reliability", "rule"], ascending=[False, True]).reset_index(drop=True)


def score_games(df: pd.DataFrame, rel: pd.DataFrame, cfg: dict) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    k = min(int(cfg["top_k"]), len(rel))
    chosen = rel.head(k).copy()
    rules = chosen.rule.tolist()
    base_w = np.power(np.maximum(chosen.reliability.to_numpy(dtype=float), 1e-8), float(cfg["reliability_power"]))

    n = len(df)
    ref = clip_p(df.ref_p.to_numpy())
    ref_sign = np.where(ref >= .5, 1.0, -1.0)
    ref_conf = np.abs(ref - .5) * 2.0

    masses = []
    signed = []
    per_rule_mass = {}
    for j, rr in enumerate(rules):
        rp = clip_p(df[f"p__{rr}"].to_numpy())
        s = logit(rp)
        conv = np.power(np.minimum(np.abs(s), 4.0) + 1e-8, float(cfg["conviction_power"]))
        mass = base_w[j] * conv
        masses.append(mass)
        signed.append(mass * np.where(rp >= .5, 1.0, -1.0))
        per_rule_mass[rr] = mass

    M = np.column_stack(masses)
    S = np.column_stack(signed)
    total = np.maximum(M.sum(axis=1), 1e-12)
    consensus_signed = S.sum(axis=1) / total
    consensus_sign = np.where(consensus_signed >= 0, 1.0, -1.0)

    agree_mass = np.zeros(n, dtype=float)
    for j in range(len(rules)):
        agree_mass += M[:, j] * (np.sign(S[:, j]) == ref_sign)
    agreement = agree_mass / total
    eligible = (consensus_sign == ref_sign) & (agreement >= 0.5)

    score = (
        np.power(np.maximum(ref_conf, 1e-8), float(cfg["ref_power"]))
        * np.power(np.maximum(agreement, 1e-8), float(cfg["agreement_power"]))
        * (0.5 + 0.5 * np.abs(consensus_signed))
    )
    score = np.where(eligible, score, 0.0)

    shares = {}
    for rr in rel.rule.tolist():
        if rr not in per_rule_mass:
            shares[rr] = np.zeros(n, dtype=float)
        else:
            shares[rr] = per_rule_mass[rr] / total
    return score, agreement, shares


def threshold_for_target(scores: np.ndarray, eligible: np.ndarray, target: float) -> float:
    positive = scores[eligible & (scores > 0)]
    if len(positive) == 0:
        return float("inf")
    # Threshold is learned only from prior validation. It is never recomputed on the target season.
    q = max(0.0, min(1.0, 1.0 - float(target)))
    return float(np.quantile(scores, q))


def select_config(meta_train: pd.DataFrame, rules: list[str]) -> tuple[dict, pd.DataFrame]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < 4:
        raise RuntimeError("R5H4 insufficient meta history")
    val_years = years[-2:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    rel = reliability_table(fit, rules)

    y = val.y.to_numpy(dtype=int)
    ref = clip_p(val.ref_p.to_numpy())
    ref_pick = ref >= .5
    search_rows = []
    best = None

    for k in TOP_K:
        for rp in RELIABILITY_POWER:
            for cp in CONVICTION_POWER:
                for fp in REF_POWER:
                    for ap in AGREEMENT_POWER:
                        base_cfg = {
                            "top_k": int(k), "reliability_power": float(rp), "conviction_power": float(cp),
                            "ref_power": float(fp), "agreement_power": float(ap),
                        }
                        score, agreement, _ = score_games(val, rel, base_cfg)
                        eligible = score > 0
                        for target in TARGET_COVERAGE:
                            thr = threshold_for_target(score, eligible, target)
                            selected = eligible & (score >= thr)
                            n = int(selected.sum())
                            if n < MIN_VALIDATION_SELECTIONS:
                                continue
                            wins = int((ref_pick[selected] == y[selected]).sum())
                            acc = wins / n
                            wl = wilson_lower(wins, n)
                            coverage = n / len(val)
                            row = {
                                **base_cfg,
                                "target_coverage": float(target), "threshold": float(thr),
                                "validation_games": n, "validation_coverage": float(coverage),
                                "validation_wins": wins, "validation_losses": n - wins,
                                "validation_accuracy": float(acc), "validation_wilson95_lower": float(wl),
                                "mean_agreement_selected": float(agreement[selected].mean()),
                            }
                            search_rows.append(row)
                            # Primary: robust lower bound, then raw accuracy, then more coverage, then fewer rules.
                            key = (wl, acc, coverage, -int(k), -float(rp), -float(cp), -float(fp), -float(ap))
                            if best is None or key > best[0]:
                                best = (key, row)

    if best is None:
        raise RuntimeError("R5H4 found no validation configuration meeting minimum sample size")
    cfg = dict(best[1])
    cfg["inner_fit_seasons"] = sorted(int(v) for v in fit.season.unique())
    cfg["inner_validation_seasons"] = val_years
    cfg["selection_objective"] = "MAXIMIZE_WILSON95_LOWER_BOUND_THEN_ACCURACY_THEN_COVERAGE"
    return cfg, rel


def bootstrap_accuracy(selected: pd.DataFrame, reps: int = 10000) -> dict:
    if selected.empty:
        return {"games": 0, "clusters": 0, "accuracy": None, "ci95_low": None, "ci95_high": None}
    z = selected.copy()
    z["correct"] = ((z.ref_p >= .5).astype(int) == z.y.astype(int)).astype(float)
    groups = [g.correct.to_numpy() for _, g in z.groupby(["season", "week"], sort=False)]
    sums = np.array([v.sum() for v in groups], dtype=float)
    ns = np.array([len(v) for v in groups], dtype=float)
    rng = np.random.default_rng(SEED)
    vals = np.empty(reps)
    for i in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        vals[i] = sums[ix].sum() / ns[ix].sum()
    lo, hi = np.quantile(vals, [.025, .975])
    return {
        "games": int(len(z)), "clusters": int(len(groups)),
        "accuracy": float(z.correct.mean()), "ci95_low": float(lo), "ci95_high": float(hi),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h4-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()

    blocks = r5h3.expanded_rule_blocks()
    missing = {r: [c for c in cols if c not in x.columns] for r, cols in blocks.items()}
    missing = {r: cols for r, cols in missing.items() if cols}
    if missing:
        raise RuntimeError(f"R5H4 missing sports inputs: {missing}")

    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, expert_tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ref = reference_oos(x, a.expert_oos_start, a.end_season)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    rows, cfg_rows, rel_rows = [], [], []
    rules = list(blocks)
    for y in range(a.test_start, a.end_season + 1):
        mt = meta[meta.season < y].copy()
        te = meta[meta.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, rel = select_config(mt, rules)
        score, agreement, shares = score_games(te, rel, cfg)
        selected = (score > 0) & (score >= float(cfg["threshold"]))

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["elite_score"] = score
        q["agreement"] = agreement
        q["selected"] = selected.astype(int)
        q["reference_pick_home"] = (q.ref_p >= .5).astype(int)
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = shares[rr]
        rows.append(q)

        cfg_rows.append({
            "test_season": int(y),
            **cfg,
            "test_selected_games": int(selected.sum()),
            "test_coverage": float(selected.mean()),
        })
        r = rel.copy()
        r["test_season"] = int(y)
        rel_rows.append(r)

    pred = pd.concat(rows, ignore_index=True)
    selected = pred[pred.selected.eq(1)].copy()
    all_correct = ((pred.ref_p >= .5).astype(int) == pred.y.astype(int))
    sel_correct = ((selected.ref_p >= .5).astype(int) == selected.y.astype(int))

    by = []
    for y, g in pred.groupby("season"):
        s = g[g.selected.eq(1)]
        corr = ((s.ref_p >= .5).astype(int) == s.y.astype(int)) if len(s) else pd.Series(dtype=bool)
        by.append({
            "season": int(y), "all_games": int(len(g)), "selected_games": int(len(s)),
            "coverage": float(len(s) / len(g)),
            "wins": int(corr.sum()) if len(s) else 0,
            "losses": int((~corr).sum()) if len(s) else 0,
            "selected_accuracy": float(corr.mean()) if len(s) else np.nan,
            "reference_all_accuracy": float(((g.ref_p >= .5).astype(int) == g.y.astype(int)).mean()),
        })
    bydf = pd.DataFrame(by)

    boot = bootstrap_accuracy(selected)
    summary = {
        "stage": "NFL-R5H4_ELITE_SELECTION_GATE",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(pred)),
        "referenceAllAccuracy": float(all_correct.mean()),
        "selectedGames": int(len(selected)),
        "selectedCoverage": float(len(selected) / len(pred)),
        "selectedWins": int(sel_correct.sum()),
        "selectedLosses": int((~sel_correct).sum()),
        "selectedAccuracy": float(sel_correct.mean()),
        "accuracyLiftVsReferenceAll": float(sel_correct.mean() - all_correct.mean()),
        "selectedAccuracyBootstrap": boot,
        "ruleWeightsGameSpecific": True,
        "rivalSpecificRuleLibrary": True,
        "ruleBlockCount": len(rules),
        "targetSeasonUsedForThresholdSelection": False,
        "targetSeasonUsedForReliabilityWeights": False,
        "automaticProductionPromotion": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h4-elite-selection-gate.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "mechanism": "retain certified R5B2 winner direction; recommend only games where prior-season reliability-weighted rival-specific rule consensus agrees with the reference and clears a threshold chosen on the latest two prior OOS seasons",
        "dynamicWeight": "historical rule reliability x game-specific rule conviction, normalized to per-game rule weight shares",
        "selectionObjective": "maximize prior-validation Wilson 95% lower bound of game-win accuracy, then raw accuracy, then coverage",
        "targetSeasonDistributionUsedForThreshold": False,
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
        "referenceDirectionDefault": "PASS_R5B2_DIRECTION_RETAINED",
        "productionCodeTouched": False,
    }

    pred.to_parquet(out / "nfl_r5h4_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h4_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h4_config_by_season.csv", index=False)
    pd.concat(rel_rows, ignore_index=True).to_csv(out / "nfl_r5h4_rule_reliability_by_season.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h4_expert_tuning.csv", index=False)
    (out / "nfl_r5h4_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h4_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h4_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H4_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H4_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H4_CONFIG_BY_SEASON")
    print(pd.DataFrame(cfg_rows).to_string(index=False))
    print("NFL_R5H4_COMPLETE")


if __name__ == "__main__":
    main()
