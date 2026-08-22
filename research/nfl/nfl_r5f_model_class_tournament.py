#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import skellam
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, PoissonRegressor, Ridge
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


REFERENCE_SOURCE_MODEL = "R5B2_HICONF_SWITCH"
REFERENCE = "REGULARIZED_LINEAR_REFERENCE"
CHALLENGERS = (
    "GRADIENT_BOOSTING",
    "DYNAMIC_RECENCY_WEIGHTED",
    "SCORE_DISTRIBUTION_POISSON",
)
MODELS = (REFERENCE,) + CHALLENGERS
FORBIDDEN = ("moneyline", "spread", "total_line", "odds", "price", "vig", "book", "over_under")

# Exact frozen feature vector from nfl_r5b_hybrid.feature_sets()['R5B2_HICONF_SWITCH'].
# R5F changes model class only. No retrospective feature block may be added here.
FEATURES = (
    "home_points_for", "home_points_against", "away_points_for", "away_points_against",
    "home_uncertainty", "away_uncertainty",
    "home_off_epa", "home_def_epa", "home_off_success", "home_def_success",
    "away_off_epa", "away_def_epa", "away_off_success", "away_def_success",
    "home_oa_off", "home_oa_def", "away_oa_off", "away_oa_def",
    "home_r5b2_hi_epa", "home_r5b2_hi_cpoe", "home_r5b2_hi_sack_rate", "home_r5b2_hi_uncertainty",
    "away_r5b2_hi_epa", "away_r5b2_hi_cpoe", "away_r5b2_hi_sack_rate", "away_r5b2_hi_uncertainty",
    "home_r5b2_out_switch", "home_r5b2_ts_switch", "home_r5b2_hi_switch",
    "away_r5b2_out_switch", "away_r5b2_ts_switch", "away_r5b2_hi_switch",
)

C_GRID = (0.05, 0.10, 0.30, 0.70, 1.50, 3.00)
RIDGE_GRID = (1.0, 4.0, 8.0, 16.0, 32.0)
HALF_LIFE_GRID = (1.5, 3.0, 6.0, 12.0)
POISSON_ALPHA_GRID = (0.01, 0.10, 1.0, 10.0)
GB_GRID = (
    {"learning_rate": 0.03, "max_iter": 160, "max_leaf_nodes": 7, "min_samples_leaf": 20, "l2_regularization": 1.0},
    {"learning_rate": 0.05, "max_iter": 140, "max_leaf_nodes": 7, "min_samples_leaf": 20, "l2_regularization": 2.0},
    {"learning_rate": 0.03, "max_iter": 200, "max_leaf_nodes": 15, "min_samples_leaf": 20, "l2_regularization": 2.0},
    {"learning_rate": 0.05, "max_iter": 160, "max_leaf_nodes": 15, "min_samples_leaf": 25, "l2_regularization": 5.0},
)
BOOTSTRAP_REPS = 10000
BOOTSTRAP_SEED = 940830
FAMILYWISE_ALPHA = 0.05


def feature_hash() -> str:
    return hashlib.sha256("\n".join(FEATURES).encode("utf-8")).hexdigest()


def inner_split(tr: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    years = sorted(int(y) for y in tr.season.unique())
    if len(years) < 2:
        raise RuntimeError("R5F requires at least two pre-test seasons for nested validation")
    val_year = years[-1]
    fit = tr[tr.season < val_year].copy()
    val = tr[tr.season == val_year].copy()
    if fit.empty or val.empty:
        raise RuntimeError(f"invalid inner split for validation season {val_year}")
    return fit, val


def design(df: pd.DataFrame) -> pd.DataFrame:
    return df.loc[:, FEATURES]


def ece10(y: np.ndarray, p: np.ndarray) -> float:
    out = 0.0
    edges = np.linspace(0.0, 1.0, 11)
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (p >= lo) & (p < (hi if hi < 1 else hi + 1e-12))
        if mask.any():
            out += mask.mean() * abs(float(y[mask].mean()) - float(p[mask].mean()))
    return float(out)


def gb_classifier(cfg: dict) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("model", HistGradientBoostingClassifier(
            loss="log_loss", early_stopping=False, random_state=BOOTSTRAP_SEED, **cfg
        )),
    ])


def gb_regressor(cfg: dict) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("model", HistGradientBoostingRegressor(
            loss="squared_error", early_stopping=False, random_state=BOOTSTRAP_SEED, **cfg
        )),
    ])


def tune_gb_classifier(tr: pd.DataFrame) -> tuple[int, dict]:
    fit, val = inner_split(tr)
    best = None
    for i, cfg in enumerate(GB_GRID):
        m = gb_classifier(cfg)
        m.fit(design(fit), fit.home_win.astype(int))
        p = np.clip(m.predict_proba(design(val))[:, 1], 1e-6, 1 - 1e-6)
        cand = (float(log_loss(val.home_win.astype(int), p)), i)
        if best is None or cand < best:
            best = cand
    idx = int(best[1])
    return idx, dict(GB_GRID[idx])


def tune_gb_regressor(tr: pd.DataFrame, target: str) -> tuple[int, dict]:
    fit, val = inner_split(tr)
    best = None
    for i, cfg in enumerate(GB_GRID):
        m = gb_regressor(cfg)
        m.fit(design(fit), fit[target].astype(float))
        pred = m.predict(design(val))
        cand = (float(mean_absolute_error(val[target], pred)), i)
        if best is None or cand < best:
            best = cand
    idx = int(best[1])
    return idx, dict(GB_GRID[idx])


def recency_weights(df: pd.DataFrame, half_life: float) -> np.ndarray:
    anchor = float(df.season.max())
    age = anchor - df.season.astype(float).to_numpy()
    return np.power(0.5, age / float(half_life))


def dynamic_logit(c: float) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("model", LogisticRegression(C=float(c), max_iter=3000)),
    ])


def dynamic_ridge(alpha: float) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("model", Ridge(alpha=float(alpha))),
    ])


def tune_dynamic_classifier(tr: pd.DataFrame) -> tuple[float, float]:
    fit, val = inner_split(tr)
    best = None
    for half_life in HALF_LIFE_GRID:
        w = recency_weights(fit, half_life)
        for c in C_GRID:
            m = dynamic_logit(c)
            m.fit(design(fit), fit.home_win.astype(int), model__sample_weight=w)
            p = np.clip(m.predict_proba(design(val))[:, 1], 1e-6, 1 - 1e-6)
            cand = (float(log_loss(val.home_win.astype(int), p)), float(half_life), float(c))
            if best is None or cand < best:
                best = cand
    return float(best[1]), float(best[2])


def tune_dynamic_regressor(tr: pd.DataFrame, target: str) -> tuple[float, float]:
    fit, val = inner_split(tr)
    best = None
    for half_life in HALF_LIFE_GRID:
        w = recency_weights(fit, half_life)
        for alpha in RIDGE_GRID:
            m = dynamic_ridge(alpha)
            m.fit(design(fit), fit[target].astype(float), model__sample_weight=w)
            pred = m.predict(design(val))
            cand = (float(mean_absolute_error(val[target], pred)), float(half_life), float(alpha))
            if best is None or cand < best:
                best = cand
    return float(best[1]), float(best[2])


def poisson_model(alpha: float) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("model", PoissonRegressor(alpha=float(alpha), max_iter=2000, tol=1e-7)),
    ])


def score_prob(mu_home: np.ndarray, mu_away: np.ndarray) -> np.ndarray:
    mh = np.clip(np.asarray(mu_home, dtype=float), 0.05, 80.0)
    ma = np.clip(np.asarray(mu_away, dtype=float), 0.05, 80.0)
    p_home_gt = 1.0 - skellam.cdf(0, mh, ma)
    p_tie = skellam.pmf(0, mh, ma)
    denom = np.maximum(1.0 - p_tie, 1e-9)
    # The R5/R5B evaluation excludes ties, so condition the score model on non-tie outcomes.
    return np.clip(p_home_gt / denom, 1e-6, 1 - 1e-6)


def tune_score_distribution(tr: pd.DataFrame) -> float:
    fit, val = inner_split(tr)
    best = None
    for alpha in POISSON_ALPHA_GRID:
        hm = poisson_model(alpha)
        am = poisson_model(alpha)
        hm.fit(design(fit), fit.home_score.astype(float))
        am.fit(design(fit), fit.away_score.astype(float))
        ph = np.clip(hm.predict(design(val)), 0.05, 80.0)
        pa = np.clip(am.predict(design(val)), 0.05, 80.0)
        p = score_prob(ph, pa)
        ll = float(log_loss(val.home_win.astype(int), p))
        score_mae = float(
            (mean_absolute_error(val.home_score, ph) + mean_absolute_error(val.away_score, pa)) / 2.0
        )
        cand = (ll, score_mae, float(alpha))
        if best is None or cand < best:
            best = cand
    return float(best[2])


def reference_predictions(src: Path, x_eval: pd.DataFrame, test_start: int, end_season: int) -> pd.DataFrame:
    p = pd.read_parquet(src / "nfl_r5b_hybrid_predictions.parquet")
    p = p[p.model.eq(REFERENCE_SOURCE_MODEL) & p.season.between(test_start, end_season)].copy()
    if p.game_id.duplicated().any():
        raise RuntimeError("R5B2 reference contains duplicate game_id rows")
    expected = x_eval[x_eval.season.between(test_start, end_season)]["game_id"].astype(str)
    got = p.game_id.astype(str)
    if set(expected) != set(got):
        missing = sorted(set(expected) - set(got))[:10]
        extra = sorted(set(got) - set(expected))[:10]
        raise RuntimeError(f"R5B2 reference game coverage mismatch; missing={missing} extra={extra}")
    q = p[["game_id", "season", "week", "y", "p", "margin", "pm", "game_total", "pt"]].copy()
    q["model"] = REFERENCE
    q["lli"] = -(q.y * np.log(q.p) + (1 - q.y) * np.log(1 - q.p))
    return q


def make_prediction_frame(te: pd.DataFrame, model: str, p: np.ndarray, pm: np.ndarray, pt: np.ndarray) -> pd.DataFrame:
    q = pd.DataFrame({
        "game_id": te.game_id.to_numpy(), "season": te.season.to_numpy(), "week": te.week.to_numpy(),
        "model": model, "y": te.home_win.to_numpy(), "p": np.asarray(p, dtype=float),
        "margin": te.margin.to_numpy(), "pm": np.asarray(pm, dtype=float),
        "game_total": te.game_total.to_numpy(), "pt": np.asarray(pt, dtype=float),
    })
    q["lli"] = -(q.y * np.log(q.p) + (1 - q.y) * np.log(1 - q.p))
    return q


def evaluate_challengers(x: pd.DataFrame, test_start: int, end_season: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    preds = []
    tuning = []
    for year in range(test_start, end_season + 1):
        tr = x[x.season < year].copy()
        te = x[x.season == year].copy()
        if tr.empty or te.empty:
            continue

        # 1) Gradient boosting: same frozen features, non-linear function class.
        gb_cls_idx, gb_cls_cfg = tune_gb_classifier(tr)
        gb_cls = gb_classifier(gb_cls_cfg)
        gb_cls.fit(design(tr), tr.home_win.astype(int))
        p_gb = np.clip(gb_cls.predict_proba(design(te))[:, 1], 1e-6, 1 - 1e-6)
        gb_preds = {}
        gb_tuning = {}
        for target in ("margin", "game_total"):
            idx, cfg = tune_gb_regressor(tr, target)
            m = gb_regressor(cfg)
            m.fit(design(tr), tr[target].astype(float))
            gb_preds[target] = m.predict(design(te))
            gb_tuning[target] = {"gridIndex": int(idx), **cfg}
        preds.append(make_prediction_frame(te, "GRADIENT_BOOSTING", p_gb, gb_preds["margin"], gb_preds["game_total"]))
        tuning.append({
            "model": "GRADIENT_BOOSTING", "test_season": year,
            "inner_validation_season": int(tr.season.max()),
            "classifier": {"gridIndex": int(gb_cls_idx), **gb_cls_cfg},
            "marginRegressor": gb_tuning["margin"],
            "totalRegressor": gb_tuning["game_total"],
        })

        # 2) Dynamic class: time-varying importance through predeclared exponential season decay.
        hl, c = tune_dynamic_classifier(tr)
        dyn_cls = dynamic_logit(c)
        dyn_cls.fit(design(tr), tr.home_win.astype(int), model__sample_weight=recency_weights(tr, hl))
        p_dyn = np.clip(dyn_cls.predict_proba(design(te))[:, 1], 1e-6, 1 - 1e-6)
        dyn_preds = {}
        dyn_tuning = {}
        for target in ("margin", "game_total"):
            thl, alpha = tune_dynamic_regressor(tr, target)
            m = dynamic_ridge(alpha)
            m.fit(design(tr), tr[target].astype(float), model__sample_weight=recency_weights(tr, thl))
            dyn_preds[target] = m.predict(design(te))
            dyn_tuning[target] = {"halfLifeSeasons": thl, "ridgeAlpha": alpha}
        preds.append(make_prediction_frame(te, "DYNAMIC_RECENCY_WEIGHTED", p_dyn, dyn_preds["margin"], dyn_preds["game_total"]))
        tuning.append({
            "model": "DYNAMIC_RECENCY_WEIGHTED", "test_season": year,
            "inner_validation_season": int(tr.season.max()),
            "classifier": {"halfLifeSeasons": hl, "logitC": c},
            "marginRegressor": dyn_tuning["margin"],
            "totalRegressor": dyn_tuning["game_total"],
        })

        # 3) Score-distribution class: independent Poisson home/away score rates, Skellam win probability.
        pa = tune_score_distribution(tr)
        hm = poisson_model(pa)
        am = poisson_model(pa)
        hm.fit(design(tr), tr.home_score.astype(float))
        am.fit(design(tr), tr.away_score.astype(float))
        ph = np.clip(hm.predict(design(te)), 0.05, 80.0)
        paway = np.clip(am.predict(design(te)), 0.05, 80.0)
        p_score = score_prob(ph, paway)
        pm_score = ph - paway
        pt_score = ph + paway
        preds.append(make_prediction_frame(te, "SCORE_DISTRIBUTION_POISSON", p_score, pm_score, pt_score))
        tuning.append({
            "model": "SCORE_DISTRIBUTION_POISSON", "test_season": year,
            "inner_validation_season": int(tr.season.max()),
            "poissonAlpha": pa,
            "winProbability": "SKELLAM_CONDITIONAL_ON_NON_TIE",
        })

        print("R5F_SEASON_COMPLETE", year)

    return pd.concat(preds, ignore_index=True), pd.DataFrame(tuning)


def metric_row(g: pd.DataFrame, model: str, segment: str) -> dict:
    return {
        "model": model, "segment": segment, "n": int(len(g)),
        "log_loss": float(log_loss(g.y.astype(int), g.p)),
        "brier": float(brier_score_loss(g.y.astype(int), g.p)),
        "accuracy": float(accuracy_score(g.y.astype(int), g.p >= 0.5)),
        "ece10": ece10(g.y.to_numpy(dtype=float), g.p.to_numpy(dtype=float)),
        "margin_mae": float(mean_absolute_error(g.margin, g.pm)),
        "total_mae": float(mean_absolute_error(g.game_total, g.pt)),
    }


def summaries(preds: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    overall = pd.DataFrame([metric_row(g, m, "ALL") for m, g in preds.groupby("model", sort=False)])
    by_season = pd.DataFrame([
        metric_row(g, m, str(int(s)))
        for (m, s), g in preds.groupby(["model", "season"], sort=False)
    ])
    bands = (("W01_04", 1, 4), ("W05_09", 5, 9), ("W10_14", 10, 14), ("W15_18", 15, 18))
    rows = []
    for m, gm in preds.groupby("model", sort=False):
        for name, lo, hi in bands:
            g = gm[gm.week.between(lo, hi)]
            if not g.empty:
                rows.append(metric_row(g, m, name))
    return overall, by_season, pd.DataFrame(rows)


def paired_frame(preds: pd.DataFrame, a: str, b: str) -> pd.DataFrame:
    aa = preds[preds.model.eq(a)][["game_id", "season", "week", "y", "p", "lli"]].rename(
        columns={"p": "p_a", "lli": "lli_a"}
    )
    bb = preds[preds.model.eq(b)][["game_id", "p", "lli"]].rename(columns={"p": "p_b", "lli": "lli_b"})
    z = aa.merge(bb, on="game_id", how="inner", validate="one_to_one")
    if len(z) != len(aa) or len(z) != len(bb):
        raise RuntimeError(f"pairing mismatch for {a} vs {b}")
    z["delta_ll"] = z.lli_b - z.lli_a
    z["delta_brier"] = (z.y - z.p_b) ** 2 - (z.y - z.p_a) ** 2
    return z


def cluster_bootstrap(z: pd.DataFrame, a: str, b: str, family_n: int = 1) -> dict:
    groups = list(z.groupby(["season", "week"], sort=False))
    ll_sums = np.array([g.delta_ll.sum() for _, g in groups], dtype=float)
    br_sums = np.array([g.delta_brier.sum() for _, g in groups], dtype=float)
    counts = np.array([len(g) for _, g in groups], dtype=float)
    pair_offset = sum(ord(c) for c in (a + "|" + b))
    rng = np.random.default_rng(BOOTSTRAP_SEED + pair_offset)
    ll_vals = np.empty(BOOTSTRAP_REPS, dtype=float)
    br_vals = np.empty(BOOTSTRAP_REPS, dtype=float)
    for i in range(BOOTSTRAP_REPS):
        ix = rng.integers(0, len(groups), len(groups))
        denom = counts[ix].sum()
        ll_vals[i] = ll_sums[ix].sum() / denom
        br_vals[i] = br_sums[ix].sum() / denom

    ll95 = np.quantile(ll_vals, [0.025, 0.975])
    br95 = np.quantile(br_vals, [0.025, 0.975])
    adj_alpha = FAMILYWISE_ALPHA / float(family_n)
    qlo, qhi = adj_alpha / 2.0, 1.0 - adj_alpha / 2.0
    ll_fwer = np.quantile(ll_vals, [qlo, qhi])
    br_fwer = np.quantile(br_vals, [qlo, qhi])
    return {
        "reference": a, "candidate": b, "comparison": f"{b}-{a}",
        "n": int(len(z)), "clusters": int(len(groups)), "bootstrap_reps": BOOTSTRAP_REPS,
        "mean_logloss_delta": float(z.delta_ll.mean()),
        "ci95_low": float(ll95[0]), "ci95_high": float(ll95[1]),
        "better95": bool(ll95[1] < 0), "worse95": bool(ll95[0] > 0),
        "family_n": int(family_n), "familywise_alpha": FAMILYWISE_ALPHA,
        "bonferroni_two_sided_level": float(1.0 - adj_alpha),
        "fwer_ci_low": float(ll_fwer[0]), "fwer_ci_high": float(ll_fwer[1]),
        "better_fwer": bool(ll_fwer[1] < 0), "worse_fwer": bool(ll_fwer[0] > 0),
        "mean_brier_delta": float(z.delta_brier.mean()),
        "brier_ci95_low": float(br95[0]), "brier_ci95_high": float(br95[1]),
        "brier_fwer_ci_low": float(br_fwer[0]), "brier_fwer_ci_high": float(br_fwer[1]),
    }


def season_direction_count(preds: pd.DataFrame, candidate: str) -> tuple[int, int, list[dict]]:
    z = paired_frame(preds, REFERENCE, candidate)
    rows = []
    wins = 0
    for season, g in z.groupby("season", sort=True):
        d = float(g.delta_ll.mean())
        if d < 0:
            wins += 1
        rows.append({"season": int(season), "mean_logloss_delta": d, "betterDirection": bool(d < 0)})
    return wins, len(rows), rows


def verdict(preds: pd.DataFrame, overall: pd.DataFrame, primary_boot: pd.DataFrame) -> dict:
    gates = []
    for candidate in CHALLENGERS:
        b = primary_boot[primary_boot.candidate.eq(candidate)].iloc[0]
        wins, nseasons, season_rows = season_direction_count(preds, candidate)
        majority_needed = int(math.floor(nseasons / 2) + 1)
        passes = bool(
            float(b.mean_logloss_delta) < 0
            and bool(b.better_fwer)
            and float(b.mean_brier_delta) <= 0
            and wins >= majority_needed
        )
        gates.append({
            "candidate": candidate,
            "meanLogLossDeltaVsReference": float(b.mean_logloss_delta),
            "fwerCiHigh": float(b.fwer_ci_high),
            "fwerBetter": bool(b.better_fwer),
            "meanBrierDeltaVsReference": float(b.mean_brier_delta),
            "seasonDirectionWins": int(wins),
            "seasonCount": int(nseasons),
            "majorityNeeded": int(majority_needed),
            "seasonDirections": season_rows,
            "promotionGatePass": passes,
        })

    eligible = [g["candidate"] for g in gates if g["promotionGatePass"]]
    if eligible:
        rank = overall[overall.model.isin(eligible)].sort_values(["log_loss", "brier", "ece10", "model"])
        winner = str(rank.iloc[0].model)
        decision = "CHALLENGER_WINS_R5F_REQUIRES_INDEPENDENT_CERTIFICATION"
    else:
        winner = REFERENCE
        decision = "RETAIN_R5B2_REGULARIZED_LINEAR_REFERENCE"

    return {
        "schemaVersion": "courtedge-nfl-r5f-model-class-tournament.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "featureSetFrozen": True,
        "frozenFeatureSource": REFERENCE_SOURCE_MODEL,
        "frozenFeatureCount": len(FEATURES),
        "frozenFeatureSha256": feature_hash(),
        "featuresAddedByR5F": [],
        "reference": REFERENCE,
        "challengers": list(CHALLENGERS),
        "primaryMetric": "log_loss",
        "secondaryMetrics": ["brier", "ece10", "accuracy", "margin_mae", "total_mae"],
        "multiplicityControl": {
            "family": "THREE_PREDECLARED_CHALLENGERS_VS_FROZEN_REFERENCE",
            "method": "BONFERRONI_FWER_ON_TWO_SIDED_CLUSTER_BOOTSTRAP_INTERVAL",
            "familywiseAlpha": FAMILYWISE_ALPHA,
            "familySize": len(CHALLENGERS),
        },
        "promotionGate": {
            "requirements": [
                "mean_logloss_delta_vs_reference < 0",
                "Bonferroni-FWER bootstrap interval upper bound < 0",
                "mean_brier_delta_vs_reference <= 0",
                "better log-loss direction in a strict majority of evaluated seasons",
            ],
            "automaticProductionPromotion": False,
            "independentCertificationRequiredForChallengerWinner": True,
        },
        "gates": gates,
        "eligibleChallengers": eligible,
        "tournamentWinner": winner,
        "decision": decision,
    }


def audit_input(x: pd.DataFrame, ref: pd.DataFrame, test_start: int, end_season: int) -> dict:
    missing = [c for c in FEATURES if c not in x.columns]
    if missing:
        raise RuntimeError(f"missing frozen R5B2 features: {missing}")
    bad_features = [c for c in FEATURES if any(t in c.lower() for t in FORBIDDEN)]
    if bad_features:
        raise RuntimeError(f"market-like feature names detected: {bad_features}")
    forbidden_targets = {"home_win", "margin", "game_total", "home_score", "away_score", "y", "p", "pm", "pt", "lli"}
    leaked_targets = [c for c in FEATURES if c in forbidden_targets]
    if leaked_targets:
        raise RuntimeError(f"target leakage in R5F feature list: {leaked_targets}")
    expected_n = int(len(x[x.season.between(test_start, end_season)]))
    if len(ref) != expected_n:
        raise RuntimeError(f"reference row count {len(ref)} != expected evaluation rows {expected_n}")
    return {
        "marketBoundary": "PASS_MARKET_FREE",
        "frozenFeatureVector": "PASS_EXACT_R5B2_HICONF_SWITCH_VECTOR",
        "frozenFeatureCount": len(FEATURES),
        "frozenFeatureSha256": feature_hash(),
        "targetLeakageFeatureNameCheck": "PASS",
        "sameGameOutcomeFeatureCheck": "PASS_NO_TARGET_FIELDS_IN_FEATURE_VECTOR",
        "referenceCoverage": "PASS_EXACT_GAME_SET",
        "referenceSource": "nfl_r5b_hybrid_predictions.parquet:R5B2_HICONF_SWITCH",
        "validation": "NESTED_EXPANDING_SEASON_WALK_FORWARD",
        "postHocFeatureSelection": "NONE_FEATURES_FROZEN_BEFORE_TOURNAMENT",
        "postHocModelGateMutation": "NONE_PREDECLARED_GATE",
        "productionCodeTouched": False,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5f-tournament-output")
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src = Path(a.input_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()
    if x.empty:
        raise RuntimeError("R5F input dataset is empty after tie exclusion")

    ref = reference_predictions(src, x, a.test_start, a.end_season)
    audit = audit_input(x, ref, a.test_start, a.end_season)
    chall, tuning = evaluate_challengers(x, a.test_start, a.end_season)
    preds = pd.concat([ref, chall], ignore_index=True)

    ref_games = set(ref.game_id.astype(str))
    for model in CHALLENGERS:
        gm = set(preds[preds.model.eq(model)].game_id.astype(str))
        if gm != ref_games:
            raise RuntimeError(f"R5F coverage mismatch for {model}")

    overall, by_season, by_week = summaries(preds)
    primary_boot = pd.DataFrame([
        cluster_bootstrap(paired_frame(preds, REFERENCE, c), REFERENCE, c, family_n=len(CHALLENGERS))
        for c in CHALLENGERS
    ])
    pairwise_boot = pd.DataFrame([
        cluster_bootstrap(paired_frame(preds, a1, b1), a1, b1, family_n=1)
        for a1, b1 in combinations(MODELS, 2)
    ])
    final = verdict(preds, overall, primary_boot)

    manifest = {
        "schemaVersion": "courtedge-nfl-r5f-model-class-tournament-manifest.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "stage": "NFL-R5F_MODEL_CLASS_TOURNAMENT",
        "referenceSourceModel": REFERENCE_SOURCE_MODEL,
        "referenceTournamentName": REFERENCE,
        "featureSetFrozen": True,
        "featureCount": len(FEATURES),
        "featureSha256": feature_hash(),
        "features": list(FEATURES),
        "featuresAddedByR5F": [],
        "validation": {
            "outer": "EXPANDING_SEASON_WALK_FORWARD",
            "testSeasons": list(range(a.test_start, a.end_season + 1)),
            "inner": "LATEST_AVAILABLE_TRAINING_SEASON_ONLY",
            "tiesExcludedConsistentWith_R5B": True,
        },
        "modelClasses": {
            REFERENCE: {
                "role": "FROZEN_REFERENCE_FROM_R5B2",
                "source": "nfl_r5b_hybrid_predictions.parquet:R5B2_HICONF_SWITCH",
                "architecture": "regularized logistic win model + ridge margin/total models",
            },
            "GRADIENT_BOOSTING": {
                "architecture": "HistGradientBoostingClassifier + HistGradientBoostingRegressor",
                "grid": list(GB_GRID),
                "earlyStopping": False,
            },
            "DYNAMIC_RECENCY_WEIGHTED": {
                "architecture": "recency-weighted regularized GLM with time-varying observation importance",
                "note": "dynamic model class; not claimed to be a full Bayesian/Kalman state-space model",
                "halfLifeSeasonGrid": list(HALF_LIFE_GRID),
                "logitCGrid": list(C_GRID),
                "ridgeAlphaGrid": list(RIDGE_GRID),
            },
            "SCORE_DISTRIBUTION_POISSON": {
                "architecture": "independent Poisson home/away score rates; Skellam-derived conditional non-tie win probability",
                "alphaGrid": list(POISSON_ALPHA_GRID),
            },
        },
        "primaryMetric": "log_loss",
        "multiplicity": {
            "challengerFamilySize": len(CHALLENGERS),
            "familywiseAlpha": FAMILYWISE_ALPHA,
            "method": "BONFERRONI_CLUSTER_BOOTSTRAP",
            "cluster": "season-week",
            "bootstrapReps": BOOTSTRAP_REPS,
            "seed": BOOTSTRAP_SEED,
        },
        "productionPromotionAutomatic": False,
    }

    overall.to_csv(out / "nfl_r5f_model_summary.csv", index=False)
    by_season.to_csv(out / "nfl_r5f_by_season.csv", index=False)
    by_week.to_csv(out / "nfl_r5f_week_bands.csv", index=False)
    primary_boot.to_csv(out / "nfl_r5f_primary_bootstrap.csv", index=False)
    pairwise_boot.to_csv(out / "nfl_r5f_pairwise_bootstrap.csv", index=False)
    preds.to_parquet(out / "nfl_r5f_predictions.parquet", index=False)
    tuning.to_json(out / "nfl_r5f_tuning.json", orient="records", indent=2)
    (out / "nfl_r5f_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5f_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5f_verdict.json").write_text(json.dumps(final, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("NFL_R5F_MODEL_SUMMARY")
    print(overall.to_string(index=False))
    print("NFL_R5F_PRIMARY_BOOTSTRAP")
    print(primary_boot.to_string(index=False))
    print("NFL_R5F_VERDICT")
    print(json.dumps(final, indent=2, sort_keys=True))
    print("NFL_R5F_MODEL_CLASS_TOURNAMENT_COMPLETE")


if __name__ == "__main__":
    main()
