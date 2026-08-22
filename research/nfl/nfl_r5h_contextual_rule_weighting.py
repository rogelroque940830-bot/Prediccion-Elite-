#!/usr/bin/env python3
from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy


REFERENCE = "R5B2_HICONF_SWITCH"
R5H_MODEL = "R5H_CONTEXTUAL_RULE_ENGINE"
META_C_GRID = (0.01, 0.03, 0.05, 0.10, 0.30, 0.70, 1.50)
MODES = ("CONVICTION", "FULL_CONTEXT")
COVERAGE_TARGETS = (1.00, 0.80, 0.60, 0.50, 0.40, 0.30, 0.25, 0.20)
SEED = 940830


def rule_blocks() -> dict[str, list[str]]:
    return {
        "SCORING_FORM": [
            "home_points_for", "home_points_against", "away_points_for", "away_points_against",
        ],
        "TEAM_UNCERTAINTY": ["home_uncertainty", "away_uncertainty"],
        "EPA_EFFICIENCY": ["home_off_epa", "home_def_epa", "away_off_epa", "away_def_epa"],
        "SUCCESS_RATE": ["home_off_success", "home_def_success", "away_off_success", "away_def_success"],
        "OPPONENT_ADJUSTED": ["home_oa_off", "home_oa_def", "away_oa_off", "away_oa_def"],
        "QB_EPA": ["home_r5b2_hi_epa", "away_r5b2_hi_epa"],
        "QB_CPOE": ["home_r5b2_hi_cpoe", "away_r5b2_hi_cpoe"],
        "QB_SACK": ["home_r5b2_hi_sack_rate", "away_r5b2_hi_sack_rate"],
        "QB_UNCERTAINTY": ["home_r5b2_hi_uncertainty", "away_r5b2_hi_uncertainty"],
        "QB_AVAILABILITY_SWITCH": [
            "home_r5b2_out_switch", "home_r5b2_ts_switch", "home_r5b2_hi_switch",
            "away_r5b2_out_switch", "away_r5b2_ts_switch", "away_r5b2_hi_switch",
        ],
    }


def clip_p(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def logit(p):
    p = clip_p(p)
    return np.log(p / (1 - p))


def pipe(c: float) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("model", LogisticRegression(C=float(c), max_iter=4000)),
    ])


def expert_oos(x: pd.DataFrame, start: int, end: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    blocks = rule_blocks()
    rows, tune = [], []
    for y in range(start, end + 1):
        tr = x[x.season < y]
        te = x[x.season == y]
        if tr.empty or te.empty:
            continue
        q = te[["game_id", "season", "week", "home_win", "home_uncertainty", "away_uncertainty",
                "home_r5b2_hi_uncertainty", "away_r5b2_hi_uncertainty",
                "home_r5b2_hi_switch", "away_r5b2_hi_switch"]].copy()
        q = q.rename(columns={"home_win": "y"})
        for name, cols in blocks.items():
            c = base.tune_logit(tr, cols)
            m = base.pipe("logit", c)
            m.fit(tr[cols], tr.home_win.astype(int))
            p = clip_p(m.predict_proba(te[cols])[:, 1])
            q[f"p__{name}"] = p
            tune.append({"expert": name, "test_season": y, "C": float(c),
                         "training_through": int(tr.season.max())})
        rows.append(q)
    if not rows:
        raise RuntimeError("R5H could not create expert OOS predictions")
    return pd.concat(rows, ignore_index=True), pd.DataFrame(tune)


def add_context(z: pd.DataFrame, selected: list[str]) -> pd.DataFrame:
    z = z.copy()
    scores = np.column_stack([logit(z[f"p__{r}"].to_numpy()) for r in selected])
    z["ctx_team_uncertainty"] = (
        pd.to_numeric(z.home_uncertainty, errors="coerce").fillna(0.5)
        + pd.to_numeric(z.away_uncertainty, errors="coerce").fillna(0.5)
    ) / 2.0
    z["ctx_qb_uncertainty"] = (
        pd.to_numeric(z.home_r5b2_hi_uncertainty, errors="coerce").fillna(1.0)
        + pd.to_numeric(z.away_r5b2_hi_uncertainty, errors="coerce").fillna(1.0)
    ) / 2.0
    hs = pd.to_numeric(z.home_r5b2_hi_switch, errors="coerce").fillna(0.0)
    aws = pd.to_numeric(z.away_r5b2_hi_switch, errors="coerce").fillna(0.0)
    z["ctx_any_switch"] = ((hs + aws) > 0).astype(float)
    z["ctx_switch_balance"] = hs - aws
    z["ctx_disagreement"] = np.std(scores, axis=1) if len(selected) > 1 else 0.0
    signs = scores >= 0
    z["ctx_raw_agreement"] = np.maximum(signs.mean(axis=1), 1.0 - signs.mean(axis=1))
    return z


def meta_design(z0: pd.DataFrame, selected: list[str], mode: str) -> tuple[pd.DataFrame, dict[str, str]]:
    z = add_context(z0, selected)
    d, owner = {}, {}
    for r in selected:
        s = logit(z[f"p__{r}"].to_numpy())
        conv = np.minimum(np.abs(s), 4.0)
        c = f"{r}__score"
        d[c] = s
        owner[c] = r
        c = f"{r}__x_conviction"
        d[c] = s * conv
        owner[c] = r
        if mode == "FULL_CONTEXT":
            for ctx in ["ctx_team_uncertainty", "ctx_qb_uncertainty", "ctx_any_switch",
                        "ctx_switch_balance", "ctx_disagreement"]:
                c = f"{r}__x_{ctx.removeprefix('ctx_')}"
                d[c] = s * z[ctx].to_numpy(dtype=float)
                owner[c] = r
    return pd.DataFrame(d, index=z.index), owner


def metrics(y, p):
    y = np.asarray(y, dtype=int)
    p = clip_p(p)
    return {
        "accuracy": float(accuracy_score(y, p >= 0.5)),
        "log_loss": float(log_loss(y, p)),
        "brier": float(brier_score_loss(y, p)),
    }


def eval_config(fit: pd.DataFrame, val: pd.DataFrame, selected: list[str], mode: str, c: float):
    xf, _ = meta_design(fit, selected, mode)
    xv, _ = meta_design(val, selected, mode)
    m = pipe(c)
    m.fit(xf, fit.y.astype(int))
    p = clip_p(m.predict_proba(xv)[:, 1])
    met = metrics(val.y, p)
    return met, p


def objective_tuple(met: dict, mode: str, selected: list[str], c: float):
    # Accuracy is the explicit R5H primary objective. Tie breaks reward calibration and parsimony.
    return (met["accuracy"], -met["log_loss"], -met["brier"],
            -len(selected), 1 if mode == "CONVICTION" else 0, -float(c))


def choose_config(meta_train: pd.DataFrame) -> tuple[dict, pd.DataFrame]:
    years = sorted(int(v) for v in meta_train.season.unique())
    if len(years) < 4:
        raise RuntimeError("R5H meta-training history too short")
    val_years = years[-2:]
    fit = meta_train[~meta_train.season.isin(val_years)].copy()
    val = meta_train[meta_train.season.isin(val_years)].copy()
    rules = list(rule_blocks())
    search_rows = []

    def best_for_subset(subset):
        local = None
        for mode in MODES:
            for c in META_C_GRID:
                met, p = eval_config(fit, val, list(subset), mode, c)
                row = {"selectedRules": list(subset), "mode": mode, "C": float(c), **met}
                search_rows.append({"rules": "+".join(subset), "mode": mode, "C": float(c), **met})
                key = objective_tuple(met, mode, list(subset), c)
                if local is None or key > local[0]:
                    local = (key, row, p)
        return local

    best = None
    for pair in itertools.combinations(rules, 2):
        cand = best_for_subset(pair)
        if best is None or cand[0] > best[0]:
            best = cand

    selected = list(best[1]["selectedRules"])
    while len(selected) < len(rules):
        current = best
        add_best = None
        for r in rules:
            if r in selected:
                continue
            subset = selected + [r]
            cand = best_for_subset(subset)
            if add_best is None or cand[0] > add_best[0]:
                add_best = cand
        # Require a strict validation-accuracy improvement; if equal, stop to avoid post-hoc complexity.
        if add_best is None or add_best[1]["accuracy"] <= current[1]["accuracy"] + 1e-12:
            break
        best = add_best
        selected = list(best[1]["selectedRules"])

    cfg = dict(best[1])
    cfg["innerFitSeasons"] = sorted(int(v) for v in fit.season.unique())
    cfg["innerValidationSeasons"] = val_years
    cfg["searchPrimaryObjective"] = "MAXIMIZE_ACCURACY"
    cfg["tieBreaks"] = ["MIN_LOG_LOSS", "MIN_BRIER", "PARSIMONY"]

    # Recreate validation predictions under the chosen configuration for prospective threshold selection.
    _, vp = eval_config(fit, val, cfg["selectedRules"], cfg["mode"], cfg["C"])
    vz = add_context(val, cfg["selectedRules"])
    vz = vz[["game_id", "season", "week", "y", "ctx_raw_agreement"]].copy()
    vz["p"] = vp
    vz["elite_score"] = np.abs(vp - 0.5) * 2.0 * (0.5 + 0.5 * vz.ctx_raw_agreement.to_numpy())
    return cfg, vz


def fit_predict_outer(meta_train: pd.DataFrame, test: pd.DataFrame, cfg: dict):
    selected, mode, c = cfg["selectedRules"], cfg["mode"], cfg["C"]
    xt, owner = meta_design(meta_train, selected, mode)
    xe, _ = meta_design(test, selected, mode)
    m = pipe(c)
    m.fit(xt, meta_train.y.astype(int))
    p = clip_p(m.predict_proba(xe)[:, 1])

    # Per-game rule contributions in standardized meta space. Absolute shares sum to 1 across rules.
    imp = m.named_steps["impute"]
    scale = m.named_steps["scale"]
    lm = m.named_steps["model"]
    xi = imp.transform(xe)
    xs = scale.transform(xi)
    coef = np.asarray(lm.coef_, dtype=float).reshape(-1)
    contrib = xs * coef.reshape(1, -1)
    cols = list(xe.columns)
    grouped = {r: np.zeros(len(test), dtype=float) for r in selected}
    for j, col in enumerate(cols):
        grouped[owner[col]] += contrib[:, j]
    denom = np.sum(np.column_stack([np.abs(grouped[r]) for r in selected]), axis=1)
    denom = np.where(denom > 1e-12, denom, 1.0)
    shares = {r: np.abs(grouped[r]) / denom for r in selected}
    return p, grouped, shares


def cluster_bootstrap_accuracy(joined: pd.DataFrame, reps=10000, seed=SEED):
    z = joined.copy()
    z["cand_correct"] = ((z.p >= 0.5).astype(int) == z.y.astype(int)).astype(float)
    z["ref_correct"] = ((z.ref_p >= 0.5).astype(int) == z.y.astype(int)).astype(float)
    z["d"] = z.cand_correct - z.ref_correct
    groups = [g.d.to_numpy() for _, g in z.groupby(["season", "week"], sort=False)]
    sums = np.array([g.sum() for g in groups], dtype=float)
    counts = np.array([len(g) for g in groups], dtype=float)
    rng = np.random.default_rng(seed)
    vals = np.empty(reps)
    for i in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        vals[i] = sums[ix].sum() / counts[ix].sum()
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {
        "mean_accuracy_delta": float(z.d.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "better95": bool(lo > 0),
        "worse95": bool(hi < 0),
        "games": int(len(z)),
        "clusters": int(len(groups)),
    }


def coverage_rows(pred: pd.DataFrame, ref: pd.DataFrame, thresholds: dict[tuple[int, float], float]):
    z = pred.merge(ref[["game_id", "ref_p"]], on="game_id", validate="one_to_one")
    out = []
    for target in COVERAGE_TARGETS:
        parts = []
        for y, g in z.groupby("season"):
            thr = thresholds[(int(y), float(target))]
            q = g[g.elite_score >= thr].copy() if target < 1 else g.copy()
            parts.append(q)
        q = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
        if q.empty:
            continue
        cand_correct = ((q.p >= .5).astype(int) == q.y.astype(int))
        ref_correct = ((q.ref_p >= .5).astype(int) == q.y.astype(int))
        out.append({
            "target_coverage": float(target),
            "games": int(len(q)),
            "actual_coverage": float(len(q) / len(z)),
            "candidate_accuracy": float(cand_correct.mean()),
            "candidate_wins": int(cand_correct.sum()),
            "candidate_losses": int((~cand_correct).sum()),
            "reference_accuracy_same_games": float(ref_correct.mean()),
            "accuracy_delta_same_games": float(cand_correct.mean() - ref_correct.mean()),
            "candidate_log_loss": float(log_loss(q.y, q.p)),
            "candidate_brier": float(brier_score_loss(q.y, q.p)),
        })
    return pd.DataFrame(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()
    frozen = list(hy.feature_sets()[REFERENCE])
    blocks = rule_blocks()
    used = [c for cols in blocks.values() for c in cols]
    if len(frozen) != 32:
        raise RuntimeError("R5H expected exact 32-feature R5B2 vector")
    if sorted(used) != sorted(frozen):
        raise RuntimeError("R5H rules must partition the exact frozen R5B2 feature vector")
    if len(used) != len(set(used)):
        raise RuntimeError("R5H rule blocks overlap")
    if any(any(t in c.lower() for t in base.FORBIDDEN) for c in used):
        raise RuntimeError("R5H market-like feature detected")

    experts, expert_tuning = expert_oos(x, a.expert_oos_start, a.end_season)
    refp = pd.read_parquet(src / "nfl_r5b_hybrid_predictions.parquet")
    refp = refp[refp.model.eq(REFERENCE) & refp.season.between(a.test_start, a.end_season)][["game_id", "season", "week", "y", "p"]].copy()
    refp = refp.rename(columns={"p": "ref_p"})

    pred_rows, cfg_rows, val_search_rows = [], [], []
    thresholds = {}
    for y in range(a.test_start, a.end_season + 1):
        mt = experts[experts.season < y].copy()
        te = experts[experts.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, vp = choose_config(mt)
        cfg_rows.append({
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
        p, contrib, shares = fit_predict_outer(mt, te, cfg)
        tz = add_context(te, cfg["selectedRules"])
        q = te[["game_id", "season", "week", "y"]].copy()
        q["model"] = R5H_MODEL
        q["p"] = p
        q["selected_rules"] = "+".join(cfg["selectedRules"])
        q["mode"] = cfg["mode"]
        q["agreement"] = tz.ctx_raw_agreement.to_numpy()
        q["elite_score"] = np.abs(p - 0.5) * 2.0 * (0.5 + 0.5 * q.agreement.to_numpy())
        for r in blocks:
            q[f"rule_p__{r}"] = te[f"p__{r}"].to_numpy()
            q[f"rule_selected__{r}"] = int(r in cfg["selectedRules"])
            q[f"rule_contribution__{r}"] = contrib[r] if r in contrib else 0.0
            q[f"rule_weight_share__{r}"] = shares[r] if r in shares else 0.0
        pred_rows.append(q)

        for target in COVERAGE_TARGETS:
            if target >= 1:
                thresholds[(y, float(target))] = -np.inf
            else:
                thresholds[(y, float(target))] = float(np.quantile(vp.elite_score.to_numpy(), 1.0 - target))

    pred = pd.concat(pred_rows, ignore_index=True)
    joined = pred.merge(refp[["game_id", "ref_p"]], on="game_id", validate="one_to_one")
    if len(joined) != len(pred) or len(joined) != len(refp):
        raise RuntimeError("R5H/reference exact OOS game coverage mismatch")

    cand_met = metrics(joined.y, joined.p)
    ref_met = metrics(joined.y, joined.ref_p)
    boot = cluster_bootstrap_accuracy(joined)
    by_season = []
    for y, g in joined.groupby("season"):
        cm, rm = metrics(g.y, g.p), metrics(g.y, g.ref_p)
        by_season.append({
            "season": int(y), "games": int(len(g)),
            "candidate_accuracy": cm["accuracy"], "reference_accuracy": rm["accuracy"],
            "accuracy_delta": cm["accuracy"] - rm["accuracy"],
            "candidate_log_loss": cm["log_loss"], "reference_log_loss": rm["log_loss"],
            "candidate_brier": cm["brier"], "reference_brier": rm["brier"],
        })

    cov = coverage_rows(pred, refp, thresholds)
    summary = pd.DataFrame([
        {"model": REFERENCE, "games": len(joined), **ref_met},
        {"model": R5H_MODEL, "games": len(joined), **cand_met},
    ])
    cfgdf = pd.DataFrame(cfg_rows)
    freq = []
    for r in blocks:
        n = int(cfgdf.selected_rules.str.split("+").apply(lambda xs: r in xs).sum())
        freq.append({"rule": r, "selected_outer_seasons": n, "selection_rate": n / len(cfgdf)})
    freq = pd.DataFrame(freq).sort_values(["selected_outer_seasons", "rule"], ascending=[False, True])

    verdict = {
        "stage": "NFL-R5H_CONTEXTUAL_RULE_WEIGHTING",
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "candidate": R5H_MODEL,
        "primaryObjective": "OUT_OF_SAMPLE_GAME_WIN_ACCURACY",
        "referenceAccuracy": ref_met["accuracy"],
        "candidateAccuracy": cand_met["accuracy"],
        "accuracyDelta": cand_met["accuracy"] - ref_met["accuracy"],
        "accuracyBootstrap": boot,
        "candidateLogLoss": cand_met["log_loss"],
        "referenceLogLoss": ref_met["log_loss"],
        "candidateBrier": cand_met["brier"],
        "referenceBrier": ref_met["brier"],
        "historicalAccuracyImproved": bool(cand_met["accuracy"] > ref_met["accuracy"]),
        "historicalAccuracyImprovementSupported95": bool(boot["better95"]),
        "automaticProductionPromotion": False,
        "featureVectorChanged": False,
        "ruleWeightsGameSpecific": True,
        "selectionUsesOnlyPriorSeasons": True,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h-contextual-rules.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceFeatureModel": REFERENCE,
        "frozenFeatureCount": len(frozen),
        "featureVectorChanged": False,
        "ruleBlocks": blocks,
        "ruleBlockCount": len(blocks),
        "weightingMechanism": "nested OOS rule experts -> accuracy-selected regularized contextual meta-model; each rule contribution varies by game through conviction, uncertainty, QB-switch and committee-disagreement interactions",
        "outerValidation": f"expanding-season OOS {a.test_start}-{a.end_season}",
        "innerConfigSelection": "latest two prior OOS seasons; primary objective accuracy; no target-season outcomes used",
        "coverageThresholdPolicy": "threshold for each test season derived only from its inner-validation elite-score distribution",
        "coverageTargets": list(COVERAGE_TARGETS),
        "productionPromotionAutomatic": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "featurePartition": "PASS_EXACT_32_FEATURE_R5B2_VECTOR_NO_OVERLAP",
        "targetSeasonUsedForRuleExpertFit": "NO",
        "targetSeasonUsedForMetaFit": "NO",
        "targetSeasonUsedForRuleCombinationSelection": "NO",
        "targetSeasonUsedForCoverageThreshold": "NO",
        "gameSpecificRuleWeighting": "PASS_PER_GAME_CONTEXTUAL_CONTRIBUTION_SHARES",
        "referenceCoverage": "PASS_EXACT_GAME_SET",
        "productionCodeTouched": False,
    }

    summary.to_csv(out / "nfl_r5h_model_summary.csv", index=False)
    pd.DataFrame(by_season).to_csv(out / "nfl_r5h_by_season.csv", index=False)
    cov.to_csv(out / "nfl_r5h_coverage_bands.csv", index=False)
    cfgdf.to_csv(out / "nfl_r5h_config_by_season.csv", index=False)
    freq.to_csv(out / "nfl_r5h_rule_selection_frequency.csv", index=False)
    expert_tuning.to_csv(out / "nfl_r5h_expert_tuning.csv", index=False)
    pred.to_parquet(out / "nfl_r5h_predictions.parquet", index=False)
    (out / "nfl_r5h_verdict.json").write_text(json.dumps(verdict, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H_MODEL_SUMMARY")
    print(summary.to_string(index=False))
    print("NFL_R5H_ACCURACY_BOOTSTRAP")
    print(json.dumps(boot, indent=2, sort_keys=True))
    print("NFL_R5H_COVERAGE_BANDS")
    print(cov.to_string(index=False))
    print("NFL_R5H_RULE_SELECTION_FREQUENCY")
    print(freq.to_string(index=False))
    print("NFL_R5H_VERDICT")
    print(json.dumps(verdict, indent=2, sort_keys=True))
    print("NFL_R5H_COMPLETE")


if __name__ == "__main__":
    main()
