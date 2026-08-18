#!/usr/bin/env python3
import argparse
import contextlib
import gzip
import importlib.util
import io
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

SCHEMA = "courtedge-mlb-multi-market-coverage-expansion.v1"
CONTRACT_SCHEMA = "courtedge-mlb-multi-market-coverage-expansion-contract.v1"
PARENT_SCHEMA = "courtedge-p0-step12v69-confluence-frequency-quality-frontier.v1"
A_PLUS_ROUTE = "A_PLUS_D1_ROUTER"
PREMIUM_ROUTE = "PREMIUM_A_FULL_GAME_HOME"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_SEASONS = ("2022", "2023", *EVAL_SEASONS)


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def pct(n, d):
    return 100.0 * n / d if d else 0.0


def finite(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else math.nan
    except (TypeError, ValueError):
        return math.nan


def sigmoid_softmax(logits):
    z = logits - np.max(logits, axis=1, keepdims=True)
    e = np.exp(z)
    return e / np.sum(e, axis=1, keepdims=True)


def fit_matrix(rows, features):
    raw = np.asarray([[finite(row.get(key)) for key in features] for row in rows], dtype=float)
    med = np.nanmedian(raw, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    filled = np.where(np.isfinite(raw), raw, med)
    mean = np.mean(filled, axis=0)
    scale = np.std(filled, axis=0)
    scale = np.where(np.isfinite(scale) & (scale > 1e-12), scale, 1.0)
    return (filled - mean) / scale, {"features": list(features), "median": med, "mean": mean, "scale": scale}


def apply_matrix(rows, prep):
    raw = np.asarray([[finite(row.get(key)) for key in prep["features"]] for row in rows], dtype=float)
    filled = np.where(np.isfinite(raw), raw, prep["median"])
    return (filled - prep["mean"]) / prep["scale"]


def fit_multinomial(x, y, class_count, alpha=1.0, max_iter=12000):
    n, p = x.shape
    z = np.column_stack([np.ones(n), x])
    kfree = class_count - 1
    initial = np.zeros((kfree, p + 1), dtype=float).ravel()

    def objective(theta):
        w = theta.reshape(kfree, p + 1)
        logits = np.column_stack([z @ w.T, np.zeros(n)])
        prob = sigmoid_softmax(logits)
        picked = np.clip(prob[np.arange(n), y], 1e-12, 1.0)
        loss = -np.mean(np.log(picked)) + (alpha / (2.0 * n)) * np.sum(w[:, 1:] ** 2)
        onehot = np.zeros_like(prob)
        onehot[np.arange(n), y] = 1.0
        grad_full = ((prob - onehot).T @ z) / n
        grad = grad_full[:kfree]
        grad[:, 1:] += (alpha / n) * w[:, 1:]
        return loss, grad.ravel()

    result = minimize(lambda t: objective(t)[0], initial, jac=lambda t: objective(t)[1], method="L-BFGS-B", options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8})
    if not result.success:
        raise SystemExit(f"MULTI_MARKET_MULTINOMIAL_FIT_FAILED:{result.message}")
    return result.x.reshape(kfree, p + 1)


def predict_multinomial(x, weights, class_count):
    z = np.column_stack([np.ones(len(x)), x])
    logits = np.column_stack([z @ weights.T, np.zeros(len(x))])
    prob = sigmoid_softmax(logits)
    if prob.shape[1] != class_count:
        raise SystemExit("MULTI_MARKET_MULTINOMIAL_CLASS_DRIFT")
    return prob


def fit_poisson(x, y, alpha=1.0, max_iter=12000):
    n, p = x.shape
    z = np.column_stack([np.ones(n), x])
    initial = np.zeros(p + 1, dtype=float)
    initial[0] = math.log(max(float(np.mean(y)), 1e-6))

    def objective(theta):
        eta = np.clip(z @ theta, -12.0, 12.0)
        mu = np.exp(eta)
        loss = np.mean(mu - y * eta) + (alpha / (2.0 * n)) * np.sum(theta[1:] ** 2)
        grad = (z.T @ (mu - y)) / n
        grad[1:] += (alpha / n) * theta[1:]
        return loss, grad

    result = minimize(lambda t: objective(t)[0], initial, jac=lambda t: objective(t)[1], method="L-BFGS-B", options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8})
    if not result.success:
        raise SystemExit(f"MULTI_MARKET_POISSON_FIT_FAILED:{result.message}")
    return result.x


def predict_poisson(x, theta):
    z = np.column_stack([np.ones(len(x)), x])
    return np.exp(np.clip(z @ theta, -12.0, 12.0))


def margin_class(diff, horizon):
    diff = int(diff)
    if horizon == "FG":
        if diff <= -2:
            return 0
        if diff == -1:
            return 1
        if diff == 1:
            return 2
        if diff >= 2:
            return 3
        raise SystemExit("MULTI_MARKET_FULL_GAME_TIE_UNEXPECTED")
    if diff <= -2:
        return 0
    if diff == -1:
        return 1
    if diff == 0:
        return 2
    if diff == 1:
        return 3
    return 4


def pair_probability(prob, horizon, variant):
    if horizon in ("F3", "F5"):
        p0, p1, p2, p3, p4 = [prob[:, i] for i in range(5)]
        if variant.endswith("_ML"):
            decisive = np.maximum(p0 + p1 + p3 + p4, 1e-12)
            return (p3 + p4) / decisive, (p0 + p1) / decisive
        if variant.endswith("HOME_MINUS_0_5"):
            return p3 + p4, p0 + p1 + p2
        if variant.endswith("HOME_PLUS_0_5"):
            return p2 + p3 + p4, p0 + p1
    if horizon == "FG":
        p0, p1, p2, p3 = [prob[:, i] for i in range(4)]
        if variant == "FG_ML":
            return p2 + p3, p0 + p1
        if variant == "FG_RL_HOME_MINUS_1_5":
            return p3, p0 + p1 + p2
        if variant == "FG_RL_HOME_PLUS_1_5":
            return p1 + p2 + p3, p0
    raise SystemExit(f"MULTI_MARKET_UNKNOWN_DIRECTIONAL_VARIANT:{variant}")


def home_settlement(diff, horizon, variant):
    diff = int(diff)
    if variant.endswith("_ML"):
        if horizon in ("F3", "F5") and diff == 0:
            return None
        return 1 if diff > 0 else 0
    if variant.endswith("HOME_MINUS_0_5"):
        return 1 if diff >= 1 else 0
    if variant.endswith("HOME_PLUS_0_5"):
        return 1 if diff >= 0 else 0
    if variant == "FG_RL_HOME_MINUS_1_5":
        return 1 if diff >= 2 else 0
    if variant == "FG_RL_HOME_PLUS_1_5":
        return 1 if diff >= -1 else 0
    raise SystemExit(f"MULTI_MARKET_UNKNOWN_SETTLEMENT_VARIANT:{variant}")


def brier(rows, probability_key="homeProbability"):
    decisive = [row for row in rows if row["homeOutcome"] is not None]
    if not decisive:
        return None
    return float(np.mean([(row[probability_key] - row["homeOutcome"]) ** 2 for row in decisive]))


def wilson(wins, n, z=1.959963984540054):
    if n <= 0:
        return {"lower": None, "upper": None}
    p = wins / n
    denom = 1.0 + z * z / n
    center = (p + z * z / (2.0 * n)) / denom
    margin = z * math.sqrt((p * (1.0 - p) / n) + z * z / (4.0 * n * n)) / denom
    return {"lower": max(0.0, center - margin), "upper": min(1.0, center + margin)}


def streak_summary(active_dates, eligible_dates):
    active = set(active_dates)
    runs = []
    current = 0
    for date in sorted(eligible_dates):
        if date not in active:
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    return {
        "maximumNoPlayEligibleDateStreak": max(runs) if runs else 0,
        "numberNoPlayStreaksAtLeast2": sum(run >= 2 for run in runs),
        "numberNoPlayStreaksAtLeast3": sum(run >= 3 for run in runs),
        "distribution": {str(k): v for k, v in sorted(Counter(runs).items())},
    }


def load_custody(path):
    result = []
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                result.append(json.loads(line))
    return result


def load_joined_rows(root, custody_rows):
    custody = {(str(row["season"]), int(row["gamePk"])): row for row in custody_rows}
    if len(custody) != len(custody_rows):
        raise SystemExit("MULTI_MARKET_DUPLICATE_CUSTODY_IDENTITY")
    joined = []
    dates_by_season = defaultdict(set)
    for season in ALL_SEASONS:
        table = load(os.path.join(root, season, "game-anatomy-feature-table.json"))
        for source in table["rows"]:
            if source.get("t5PregameValid") is not True:
                continue
            key = (season, int(source["gamePk"]))
            if key not in custody:
                raise SystemExit(f"MULTI_MARKET_CUSTODY_JOIN_MISSING:{season}:{source['gamePk']}")
            c = custody[key]
            if str(c["officialDate"]) != str(source["officialDate"]):
                raise SystemExit(f"MULTI_MARKET_DATE_JOIN_DRIFT:{season}:{source['gamePk']}")
            if int(c["homeTeamId"]) != int(source["homeTeamId"]) or int(c["awayTeamId"]) != int(source["awayTeamId"]):
                raise SystemExit(f"MULTI_MARKET_TEAM_JOIN_DRIFT:{season}:{source['gamePk']}")
            row = dict(c)
            row["season"] = season
            row["officialDate"] = str(source["officialDate"])
            for horizon, outcome_key in (("F3", "FIRST_3"), ("F5", "FIRST_5"), ("FG", "FULL_GAME")):
                outcome = source["outcomes"][outcome_key]
                home = int(outcome["homeRuns"])
                away = int(outcome["awayRuns"])
                row[f"{horizon}_homeRuns"] = home
                row[f"{horizon}_awayRuns"] = away
                row[f"{horizon}_diff"] = home - away
                row[f"{horizon}_total"] = home + away
            joined.append(row)
            if season in EVAL_SEASONS:
                dates_by_season[season].add(row["officialDate"])
    if len(joined) != len(custody_rows):
        raise SystemExit(f"MULTI_MARKET_JOIN_COUNT_DRIFT:{len(joined)}:{len(custody_rows)}")
    expected = {"2022": 2398, "2023": 2399, "2024": 2406, "2025": 2423, "2026_YTD": 1781}
    counts = Counter(row["season"] for row in joined)
    if dict(counts) != expected:
        raise SystemExit(f"MULTI_MARKET_SEASON_COUNT_DRIFT:{dict(counts)}")
    return joined, dates_by_season


def load_module(path):
    spec = importlib.util.spec_from_file_location("multi_market_v69_parent", path)
    if spec is None or spec.loader is None:
        raise SystemExit("MULTI_MARKET_PARENT_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reconstruct_parent_active_dates(args, eligible_dates):
    parent = load_module(args.v69_scorer)
    captured = []
    original_make_opp = parent.make_opp

    def capture(*call_args, **call_kwargs):
        row = original_make_opp(*call_args, **call_kwargs)
        captured.append(dict(row))
        return row

    parent.make_opp = capture
    parent_out = args.out + ".parent-v69.json"
    old_argv = sys.argv[:]
    sys.argv = [
        args.v69_scorer,
        "--root", args.root,
        "--custody", args.custody,
        "--v16-manifest", args.v16_manifest,
        "--v68-contract", args.v68_contract,
        "--classifier-source", args.classifier_source,
        "--router-source", args.router_source,
        "--contract", args.v69_contract,
        "--out", parent_out,
    ]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            parent.main()
    finally:
        sys.argv = old_argv
        parent.make_opp = original_make_opp
    report = load(parent_out)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass
    if report.get("schemaVersion") != PARENT_SCHEMA:
        raise SystemExit("MULTI_MARKET_PARENT_SCHEMA_DRIFT")
    a_plus = [row for row in captured if row.get("route") == A_PLUS_ROUTE]
    premium = [row for row in captured if row.get("route") == PREMIUM_ROUTE]
    a_keys = {(row["date"], int(row["gamePk"])) for row in a_plus}
    p_keys = {(row["date"], int(row["gamePk"])) for row in premium}
    if not a_keys.issubset(p_keys):
        raise SystemExit("MULTI_MARKET_PARENT_A_PLUS_NOT_PREMIUM_SUBSET")
    active = {str(row["date"]) for row in premium}
    if len(eligible_dates) != 505 or len(active) != 200 or len(eligible_dates - active) != 305:
        raise SystemExit(f"MULTI_MARKET_PARENT_COVERAGE_DRIFT:{len(eligible_dates)}:{len(active)}:{len(eligible_dates-active)}")
    return active, eligible_dates - active


def directional_variant_rows(rows_by_season, horizon, variant, probabilities, baseline_home):
    result = {}
    for season, source_rows in rows_by_season.items():
        ph, pa = pair_probability(probabilities[season], horizon, variant)
        materialized = []
        for i, source in enumerate(source_rows):
            y = home_settlement(source[f"{horizon}_diff"], horizon, variant)
            materialized.append({
                "season": season,
                "officialDate": source["officialDate"],
                "gamePk": int(source["gamePk"]),
                "homeProbability": float(ph[i]),
                "awayProbability": float(pa[i]),
                "homeOutcome": y,
                "baselineHomeProbability": float(baseline_home),
                "baselineAwayProbability": float(1.0 - baseline_home),
            })
        result[season] = materialized
    return result


def total_variant_rows(rows_by_season, horizon, line, means, baseline_over):
    result = {}
    cutoff = int(math.floor(line))
    for season, source_rows in rows_by_season.items():
        over = poisson.sf(cutoff, means[season])
        materialized = []
        for i, source in enumerate(source_rows):
            y = 1 if source[f"{horizon}_total"] > line else 0
            materialized.append({
                "season": season,
                "officialDate": source["officialDate"],
                "gamePk": int(source["gamePk"]),
                "homeProbability": float(over[i]),
                "awayProbability": float(1.0 - over[i]),
                "homeOutcome": y,
                "baselineHomeProbability": float(baseline_over),
                "baselineAwayProbability": float(1.0 - baseline_over),
            })
        result[season] = materialized
    return result


def candidate_materialization(rows, threshold, min_probability):
    candidates = []
    for row in rows:
        home_score = row["homeProbability"] - row["baselineHomeProbability"]
        away_score = row["awayProbability"] - row["baselineAwayProbability"]
        if home_score >= away_score:
            side = "HOME_OR_OVER"
            score = home_score
            model_probability = row["homeProbability"]
            if row["homeOutcome"] is None:
                outcome = "PUSH"
            else:
                outcome = "WIN" if row["homeOutcome"] == 1 else "LOSS"
        else:
            side = "AWAY_OR_UNDER"
            score = away_score
            model_probability = row["awayProbability"]
            if row["homeOutcome"] is None:
                outcome = "PUSH"
            else:
                outcome = "WIN" if row["homeOutcome"] == 0 else "LOSS"
        if score <= 0 or model_probability < min_probability or score + 1e-15 < threshold:
            continue
        candidates.append({
            "season": row["season"],
            "officialDate": row["officialDate"],
            "gamePk": row["gamePk"],
            "side": side,
            "qualityScore": float(score),
            "modelProbability": float(model_probability),
            "outcome": outcome,
        })
    return candidates


def candidate_stats(candidates, no_play_dates):
    decisive = [row for row in candidates if row["outcome"] != "PUSH"]
    wins = sum(row["outcome"] == "WIN" for row in decisive)
    losses = sum(row["outcome"] == "LOSS" for row in decisive)
    pushes = sum(row["outcome"] == "PUSH" for row in candidates)
    dates = {row["officialDate"] for row in candidates}
    rescue = dates & no_play_dates
    mean_p = float(np.mean([row["modelProbability"] for row in decisive])) if decisive else None
    hit = wins / len(decisive) if decisive else None
    return {
        "candidates": len(candidates),
        "distinctCandidateDates": len(dates),
        "rescuedParentNoPlayDates": len(rescue),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "decisive": len(decisive),
        "hitRate": hit,
        "wilson95": wilson(wins, len(decisive)),
        "meanPredictedProbabilityOnDecisive": mean_p,
        "absoluteCalibrationGap": abs(hit - mean_p) if hit is not None and mean_p is not None else None,
        "candidateDates": sorted(dates),
        "rescuedDates": sorted(rescue),
    }


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source",
        "router-source", "v69-contract", "v69-scorer", "contract", "market-registry", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MULTI_MARKET_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "RETROSPECTIVE_MULTI_MARKET_DISCOVERY_WITH_PREDECLARED_MODELS_AND_FRONTIERS_NOT_PRICE_VALIDATION":
        raise SystemExit("MULTI_MARKET_CONTRACT_STATUS_INVALID")
    requested = contract["requestedMarketFamiliesExactly"]
    if requested != ["FG_ML", "F5_ML", "FG_RUN_LINE", "F5_RUN_LINE", "FG_TOTAL", "F5_TOTAL", "F3_RUN_LINE", "F3_TOTAL"]:
        raise SystemExit("MULTI_MARKET_REQUESTED_MARKET_DRIFT")
    registry_text = open(args.market_registry, encoding="utf-8").read()
    for provider_key in ("h2h", "h2h_1st_5_innings", "spreads", "spreads_1st_5_innings", "totals", "totals_1st_5_innings", "spreads_1st_3_innings", "totals_1st_3_innings"):
        if provider_key not in registry_text:
            raise SystemExit(f"MULTI_MARKET_REGISTRY_MAPPING_MISSING:{provider_key}")

    joined, dates_by_season = load_joined_rows(args.root, load_custody(args.custody))
    by_season = {season: [row for row in joined if row["season"] == season] for season in ALL_SEASONS}
    eligible_dates = set().union(*(dates_by_season[season] for season in EVAL_SEASONS))
    parent_active_dates, parent_no_play_dates = reconstruct_parent_active_dates(args, eligible_dates)

    direction_features = contract["directionalMarginModels"]["features"]
    margin_prob = defaultdict(dict)
    margin_baseline_class = {}
    margin_model_diagnostics = {}
    for horizon in ("F3", "F5", "FG"):
        train = by_season["2022"]
        x_train, prep = fit_matrix(train, direction_features[horizon])
        y_train = np.asarray([margin_class(row[f"{horizon}_diff"], horizon) for row in train], dtype=int)
        class_count = 4 if horizon == "FG" else 5
        weights = fit_multinomial(x_train, y_train, class_count, contract["directionalMarginModels"]["l2Strength"], contract["directionalMarginModels"]["maxIter"])
        base_counts = np.bincount(y_train, minlength=class_count).astype(float)
        margin_baseline_class[horizon] = base_counts / np.sum(base_counts)
        for season in ALL_SEASONS[1:]:
            margin_prob[horizon][season] = predict_multinomial(apply_matrix(by_season[season], prep), weights, class_count)
        margin_model_diagnostics[horizon] = {
            "trainingRows": len(train),
            "featureCount": len(direction_features[horizon]),
            "classCount": class_count,
            "optimizerParameterCount": int(weights.size),
        }

    total_features = contract["totalModels"]["features"]
    total_means = defaultdict(dict)
    total_baseline_mean = {}
    total_model_diagnostics = {}
    for horizon in ("F3", "F5", "FG"):
        train = by_season["2022"]
        x_train, prep = fit_matrix(train, total_features[horizon])
        y_train = np.asarray([row[f"{horizon}_total"] for row in train], dtype=float)
        theta = fit_poisson(x_train, y_train, contract["totalModels"]["alpha"], contract["totalModels"]["maxIter"])
        total_baseline_mean[horizon] = float(np.mean(y_train))
        for season in ALL_SEASONS[1:]:
            total_means[horizon][season] = predict_poisson(apply_matrix(by_season[season], prep), theta)
        total_model_diagnostics[horizon] = {
            "trainingRows": len(train),
            "featureCount": len(total_features[horizon]),
            "optimizerParameterCount": int(theta.size),
            "formalBaselineMean": total_baseline_mean[horizon],
        }

    variants = {}
    directional_defs = [
        ("FG_ML", "FG_ML", "FG"),
        ("F5_ML", "F5_ML", "F5"),
        ("FG_RUN_LINE", "FG_RL_HOME_MINUS_1_5", "FG"),
        ("FG_RUN_LINE", "FG_RL_HOME_PLUS_1_5", "FG"),
        ("F5_RUN_LINE", "F5_RL_HOME_MINUS_0_5", "F5"),
        ("F5_RUN_LINE", "F5_RL_HOME_PLUS_0_5", "F5"),
        ("F3_RUN_LINE", "F3_RL_HOME_MINUS_0_5", "F3"),
        ("F3_RUN_LINE", "F3_RL_HOME_PLUS_0_5", "F3"),
    ]
    for family, variant, horizon in directional_defs:
        train_y = [home_settlement(row[f"{horizon}_diff"], horizon, variant) for row in by_season["2022"]]
        decisive = [value for value in train_y if value is not None]
        baseline_home = sum(value == 1 for value in decisive) / len(decisive)
        rows_by_s = directional_variant_rows({season: by_season[season] for season in ALL_SEASONS[1:]}, horizon, variant, margin_prob[horizon], baseline_home)
        variants[variant] = {"family": family, "horizon": horizon, "rows": rows_by_s, "baselineHomeProbability": baseline_home}

    for family, horizon in (("F3_TOTAL", "F3"), ("F5_TOTAL", "F5"), ("FG_TOTAL", "FG")):
        for line in contract["totalModels"]["fixedHalfRunLines"][family]:
            variant = f"{family}_{str(line).replace('.', 'p')}"
            baseline_over = sum(row[f"{horizon}_total"] > line for row in by_season["2022"]) / len(by_season["2022"])
            rows_by_s = total_variant_rows({season: by_season[season] for season in ALL_SEASONS[1:]}, horizon, float(line), total_means[horizon], baseline_over)
            variants[variant] = {"family": family, "horizon": horizon, "line": float(line), "rows": rows_by_s, "baselineHomeProbability": baseline_over}

    validation = {}
    for variant, info in variants.items():
        rows_2023 = info["rows"]["2023"]
        model_brier = brier(rows_2023)
        baseline_brier = brier(rows_2023, "baselineHomeProbability")
        improvement = baseline_brier - model_brier
        validation[variant] = {
            "family": info["family"],
            "modelBrier": model_brier,
            "baselineBrier": baseline_brier,
            "brierImprovement": improvement,
            "variantPositiveBrierImprovement": improvement > 0,
        }

    total_family_gate = {}
    for family in ("F3_TOTAL", "F5_TOTAL", "FG_TOTAL"):
        members = [variant for variant, info in variants.items() if info["family"] == family]
        avg = float(np.mean([validation[variant]["brierImprovement"] for variant in members]))
        total_family_gate[family] = {"averageFixedLineBrierImprovement": avg, "validationQualified": avg > 0, "variants": members}
    for variant, info in variants.items():
        if info["family"] in total_family_gate:
            validation[variant]["validationQualified"] = total_family_gate[info["family"]]["validationQualified"]
        else:
            validation[variant]["validationQualified"] = validation[variant]["variantPositiveBrierImprovement"]

    quantiles = contract["qualityVolumeFrontier"]["quantilesExactly"]
    min_probability = contract["qualityVolumeFrontier"]["minimumSelectedSideModelProbability"]
    thresholds = {}
    for variant, info in variants.items():
        scores = []
        for row in info["rows"]["2023"]:
            home_score = row["homeProbability"] - row["baselineHomeProbability"]
            away_score = row["awayProbability"] - row["baselineAwayProbability"]
            score = max(home_score, away_score)
            selected_probability = row["homeProbability"] if home_score >= away_score else row["awayProbability"]
            if score > 0 and selected_probability >= min_probability:
                scores.append(score)
        if not scores:
            thresholds[variant] = {f"Q{int(q*100)}": None for q in quantiles}
        else:
            thresholds[variant] = {f"Q{int(q*100)}": float(np.quantile(scores, q, method="linear")) for q in quantiles}

    variant_results = {}
    oos_variant_brier = {}
    for variant, info in variants.items():
        all_eval = [row for season in EVAL_SEASONS for row in info["rows"][season]]
        model_combined = brier(all_eval)
        baseline_combined = brier(all_eval, "baselineHomeProbability")
        by_eval_season = {}
        positive_seasons = 0
        for season in EVAL_SEASONS:
            model_score = brier(info["rows"][season])
            base_score = brier(info["rows"][season], "baselineHomeProbability")
            improve = base_score - model_score
            positive_seasons += improve > 0
            by_eval_season[season] = {"modelBrier": model_score, "baselineBrier": base_score, "brierImprovement": improve}
        combined_improvement = baseline_combined - model_combined
        oos_variant_brier[variant] = {
            "combinedModelBrier": model_combined,
            "combinedBaselineBrier": baseline_combined,
            "combinedBrierImprovement": combined_improvement,
            "positiveEvaluationSeasons": positive_seasons,
            "stableAcrossEvaluation": combined_improvement > 0 and positive_seasons >= 2,
            "bySeason": by_eval_season,
        }
        frontiers = {}
        for q in quantiles:
            qkey = f"Q{int(q*100)}"
            threshold = thresholds[variant][qkey]
            if threshold is None or not validation[variant]["validationQualified"]:
                candidates = []
            else:
                candidates = candidate_materialization(all_eval, threshold, min_probability)
            stats = candidate_stats(candidates, parent_no_play_dates)
            stats["threshold"] = threshold
            stats["validationQualified"] = validation[variant]["validationQualified"]
            stats["bySeason"] = {}
            for season in EVAL_SEASONS:
                season_candidates = [row for row in candidates if row["season"] == season]
                season_no_play = parent_no_play_dates & dates_by_season[season]
                season_stats = candidate_stats(season_candidates, season_no_play)
                season_stats.pop("candidateDates", None)
                season_stats.pop("rescuedDates", None)
                stats["bySeason"][season] = season_stats
            frontiers[qkey] = stats
        variant_results[variant] = {
            "family": info["family"],
            "horizon": info["horizon"],
            "line": info.get("line"),
            "baselineHomeOrOverProbability": info["baselineHomeProbability"],
            "validation": validation[variant],
            "thresholdsDerivedFrom2023ScoreDistributionOnly": thresholds[variant],
            "outOfSampleBrier": oos_variant_brier[variant],
            "frontiers": frontiers,
        }

    family_results = {}
    all_families = ["FG_ML", "F5_ML", "FG_RUN_LINE", "F5_RUN_LINE", "FG_TOTAL", "F5_TOTAL", "F3_RUN_LINE", "F3_TOTAL"]
    for family in all_families:
        members = [variant for variant, info in variants.items() if info["family"] == family]
        family_results[family] = {"variants": members, "frontiers": {}}
        if family in total_family_gate:
            family_results[family]["validationGate"] = total_family_gate[family]
        for q in quantiles:
            qkey = f"Q{int(q*100)}"
            candidate_dates = set()
            rescue_dates = set()
            for variant in members:
                candidate_dates.update(variant_results[variant]["frontiers"][qkey]["candidateDates"])
                rescue_dates.update(variant_results[variant]["frontiers"][qkey]["rescuedDates"])
            family_results[family]["frontiers"][qkey] = {
                "candidateDates": len(candidate_dates),
                "rescuedParentNoPlayDates": len(rescue_dates),
                "rescuedDates": sorted(rescue_dates),
                "incrementalCoveragePctOfEligibleDates": pct(len(rescue_dates), len(eligible_dates)),
                "shareOfParentNoPlayDatesRescuedPct": pct(len(rescue_dates), len(parent_no_play_dates)),
            }

    overall_frontiers = {}
    cross_market_overlap = {}
    for q in quantiles:
        qkey = f"Q{int(q*100)}"
        family_rescue = {family: set(family_results[family]["frontiers"][qkey]["rescuedDates"]) for family in all_families}
        union_rescue = set().union(*family_rescue.values())
        combined_active = parent_active_dates | union_rescue
        unique = {family: len(dates - set().union(*(family_rescue[other] for other in all_families if other != family))) for family, dates in family_rescue.items()}
        overlaps = {}
        for i, left in enumerate(all_families):
            for right in all_families[i+1:]:
                overlaps[f"{left}__{right}"] = len(family_rescue[left] & family_rescue[right])
        cross_market_overlap[qkey] = overlaps
        by_s = {}
        for season in EVAL_SEASONS:
            season_dates = dates_by_season[season]
            base_active = parent_active_dates & season_dates
            rescued = union_rescue & season_dates
            by_s[season] = {
                "eligibleSlateDates": len(season_dates),
                "parentRouteActiveDates": len(base_active),
                "rescuedNoPlayDates": len(rescued),
                "combinedOpportunityDates": len(base_active | rescued),
                "combinedOpportunityCoveragePct": pct(len(base_active | rescued), len(season_dates)),
                "remainingNoPlayDates": len(season_dates - (base_active | rescued)),
                "remainingNoPlayStreaks": streak_summary(base_active | rescued, season_dates),
            }
        overall_frontiers[qkey] = {
            "parentRouteActiveDates": len(parent_active_dates),
            "parentRouteNoPlayDates": len(parent_no_play_dates),
            "rescuedParentNoPlayDates": len(union_rescue),
            "shareOfParentNoPlayDatesRescuedPct": pct(len(union_rescue), len(parent_no_play_dates)),
            "combinedOpportunityDates": len(combined_active),
            "combinedOpportunityCoveragePct": pct(len(combined_active), len(eligible_dates)),
            "remainingNoPlayDates": len(eligible_dates - combined_active),
            "remainingNoPlayPct": pct(len(eligible_dates - combined_active), len(eligible_dates)),
            "uniqueRescueDatesByFamily": unique,
            "remainingNoPlayStreaksAcrossCombinedEligibleSequence": streak_summary(combined_active, eligible_dates),
            "bySeason": by_s,
            "rescuedDates": sorted(union_rescue),
        }

    result = {
        "schemaVersion": SCHEMA,
        "classification": "MULTI_MARKET_NO_PLAY_RESCUE_DISCOVERY_COMPLETE_NOT_PRICE_VALIDATED_NOT_PRODUCTION_PROMOTED",
        "sample": {
            "trainingRows2022": len(by_season["2022"]),
            "validationRows2023": len(by_season["2023"]),
            "evaluationRows": sum(len(by_season[season]) for season in EVAL_SEASONS),
            "eligibleSlateDates": len(eligible_dates),
            "parentRouteActiveDates": len(parent_active_dates),
            "parentRouteNoPlayDates": len(parent_no_play_dates),
        },
        "modelDiagnostics": {"directionalMargin": margin_model_diagnostics, "totals": total_model_diagnostics},
        "validationGates": {"variants": validation, "totalFamilies": total_family_gate},
        "variantResults": variant_results,
        "familyResults": family_results,
        "overallNoPlayRescueFrontier": overall_frontiers,
        "crossMarketRescueOverlap": cross_market_overlap,
        "scientificBoundary": {
            "allEightRequestedMarketFamiliesStudied": True,
            "frontiersReportedWithoutPostOutcomeSelection": True,
            "currentAPlusPremiumHierarchyChanged": False,
            "currentAPlusPremiumDatesReplacedByNewMarkets": False,
            "unionCoverageIsOpportunityCeilingNotOnePickDailyRecommendationRate": True,
            "exactHistoricalHardRockLineAvailabilityKnown": False,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "highHitRateAloneEstablishesBettingEdge": False,
            "independentProspectiveConfirmationStillRequired": True,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
            "productionChanged": False,
        },
    }
    dump(args.out, result)
    print(json.dumps({
        "classification": result["classification"],
        "sample": result["sample"],
        "validationQualifiedVariants": [variant for variant, gate in validation.items() if gate["validationQualified"]],
        "overallNoPlayRescueFrontier": overall_frontiers,
    }, indent=2))


if __name__ == "__main__":
    main()
