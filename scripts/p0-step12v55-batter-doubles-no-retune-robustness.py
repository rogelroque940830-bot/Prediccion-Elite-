#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-p0-step12v55-batter-doubles-no-retune-robustness.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v55-batter-doubles-no-retune-robustness-contract.v1"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_v54(path):
    spec = importlib.util.spec_from_file_location("courtedge_v54_batter_doubles", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V55_V54_MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close(label, actual, expected, tolerance):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
        raise SystemExit(f"V55_PARITY_NONFINITE:{label}:{actual}:{expected}")
    if abs(float(actual) - float(expected)) > tolerance:
        raise SystemExit(f"V55_V54_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tolerance}")


def poisson_deviance_per_row(y, mu):
    y = np.asarray(y, dtype=float)
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    output = np.empty_like(mu)
    zero = y <= 0
    output[zero] = 2.0 * mu[zero]
    positive = ~zero
    output[positive] = 2.0 * (y[positive] * np.log(y[positive] / mu[positive]) - (y[positive] - mu[positive]))
    return output


def bootstrap_date_means(frame, metric_arrays, replicates, seed, confidence):
    names = list(metric_arrays)
    work = frame[["officialDate"]].copy().reset_index(drop=True)
    for name, values in metric_arrays.items():
        work[name] = np.asarray(values, dtype=float)
    daily = work.groupby("officialDate", sort=True)[names].mean()
    if len(daily) < 2:
        raise SystemExit("V55_BOOTSTRAP_TOO_FEW_DATES")
    values = daily.to_numpy(dtype=float)
    point = np.mean(values, axis=0)
    rng = np.random.default_rng(seed)
    n_dates = len(values)
    bootstrap = np.empty((replicates, len(names)), dtype=float)
    cursor = 0
    while cursor < replicates:
        count = min(500, replicates - cursor)
        indices = rng.integers(0, n_dates, size=(count, n_dates))
        bootstrap[cursor:cursor + count] = np.mean(values[indices], axis=1)
        cursor += count
    alpha = 1.0 - confidence
    lower = np.percentile(bootstrap, 100.0 * alpha / 2.0, axis=0)
    upper = np.percentile(bootstrap, 100.0 * (1.0 - alpha / 2.0), axis=0)
    return {
        "clusterUnit": "OFFICIAL_DATE",
        "uniqueDates": int(n_dates),
        "replicates": int(replicates),
        "randomSeed": int(seed),
        "confidenceLevel": float(confidence),
        "aggregationWithinCluster": "MEAN_PER_ELIGIBLE_STARTING_BATTER_LOSS_IMPROVEMENT_WITHIN_DATE",
        "aggregationAcrossClusters": "EQUAL_WEIGHT_MEAN_ACROSS_OFFICIAL_DATES",
        "metrics": {
            name: {"equalDayPointEstimate": float(point[i]), "ciLower": float(lower[i]), "ciUpper": float(upper[i])}
            for i, name in enumerate(names)
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--batter-root", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--v54-contract", required=True)
    parser.add_argument("--v54-script", required=True)
    parser.add_argument("--v54-report", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V55_CONTRACT_SCHEMA_INVALID")
    v54_contract = load(args.v54_contract)
    v54_report = load(args.v54_report)
    if v54_report.get("classification") != contract["parentEvidence"]["v54ClassificationRequired"]:
        raise SystemExit("V55_V54_PARENT_CLASSIFICATION_INVALID")
    if not v54_report.get("candidateRubricPassed"):
        raise SystemExit("V55_V54_PARENT_GATE_NOT_PASSED")

    v54 = load_v54(args.v54_script)
    seasons = [v54_contract["dataBoundary"]["modelFitSeason"], v54_contract["dataBoundary"]["validationSeason"], *v54_contract["dataBoundary"]["retrospectiveEvaluationSeasons"]]
    records, custody = [], {}
    for season in seasons:
        season_rows, season_custody = v54.build_season_rows(args.root, args.batter_root, season, v54_contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    features = tuple(v54_contract["features"]["exactly"])
    train = frame[frame["season"] == "2022"].copy()
    validation = frame[frame["season"] == "2023"].copy()
    evaluation = frame[frame["season"].isin(["2024", "2025", "2026_YTD"])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit("V55_EMPTY_PARTITION")

    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)]))
    y_train = train["doubles"].to_numpy(dtype=float)
    model_cfg = v54_contract["model"]
    model = PoissonRegressor(alpha=float(model_cfg["poissonAlpha"]), max_iter=int(model_cfg["maxIter"]))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = v54.nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in model_cfg["fixedHalfDoubleLines"]]
    line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = v54.evaluate(validation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    evaluation_metrics = v54.evaluate(evaluation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    tolerance = float(contract["replayParity"]["absoluteTolerance"])
    for metric in contract["replayParity"]["requiredMetrics"]:
        assert_close(f"validation2023.{metric}", validation_metrics[metric], v54_report["validation2023"][metric], tolerance)
        assert_close(f"evaluation2024_2026Ytd.{metric}", evaluation_metrics[metric], v54_report["evaluation2024_2026Ytd"][metric], tolerance)

    season_metrics, season_checks = {}, {}
    for season in contract["seasonStabilityGate"]["partitions"]:
        metrics = v54.evaluate(frame[frame["season"] == season].copy(), features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
        season_metrics[season] = metrics
        season_checks[season] = {
            "modelDevianceBeatsConstant": metrics["modelVsConstantDevianceImprovement"] > 0.0,
            "modelDevianceBeatsBatterOnly": metrics["modelVsBatterOnlyDevianceImprovement"] > 0.0,
            "modelAverageBrierBeatsConstant": metrics["modelVsConstantAverageBrierImprovement"] > 0.0,
            "modelAverageBrierBeatsBatterOnly": metrics["modelVsBatterOnlyAverageBrierImprovement"] > 0.0,
            "modelAbsoluteMeanBiasNoWorseThanConstant": metrics["modelAbsoluteMeanCalibrationBias"] <= metrics["constantAbsoluteMeanCalibrationBias"],
            "modelAbsoluteMeanBiasNoWorseThanBatterOnly": metrics["modelAbsoluteMeanCalibrationBias"] <= metrics["batterOnlyAbsoluteMeanCalibrationBias"],
        }

    evaluation_frame = evaluation.reset_index(drop=True)
    X_eval = scaler.transform(imputer.transform(evaluation_frame[list(features)]))
    model_mu = np.maximum(model.predict(X_eval), 1e-9)
    y = evaluation_frame["doubles"].to_numpy(dtype=float)
    constant_mu = np.full(len(evaluation_frame), train_mean, dtype=float)
    batter_mu = evaluation_frame["batterOnlyMuRaw"].to_numpy(dtype=float)
    batter_mu = np.where(np.isfinite(batter_mu) & (batter_mu > 0), batter_mu, train_mean)
    model_dev = poisson_deviance_per_row(y, model_mu)
    constant_dev = poisson_deviance_per_row(y, constant_mu)
    batter_dev = poisson_deviance_per_row(y, batter_mu)

    brier_vs_constant, brier_vs_batter = [], []
    for line in lines:
        observed = (y > line).astype(float)
        model_probs = np.asarray([v54.over_probability(mu, dispersion, line) for mu in model_mu])
        batter_probs = np.asarray([v54.over_probability(mu, dispersion, line) for mu in batter_mu])
        constant_prob = float(line_probs[line])
        model_loss = (model_probs - observed) ** 2
        brier_vs_constant.append((constant_prob - observed) ** 2 - model_loss)
        brier_vs_batter.append((batter_probs - observed) ** 2 - model_loss)

    bootstrap_arrays = {
        "devianceVsConstant": constant_dev - model_dev,
        "devianceVsBatterOnly": batter_dev - model_dev,
        "averageBrierVsConstant": np.mean(np.vstack(brier_vs_constant), axis=0),
        "averageBrierVsBatterOnly": np.mean(np.vstack(brier_vs_batter), axis=0),
    }
    bootstrap_cfg = contract["dateClusterBootstrapGate"]
    date_bootstrap = bootstrap_date_means(evaluation_frame, bootstrap_arrays, int(bootstrap_cfg["replicates"]), int(bootstrap_cfg["randomSeed"]), float(bootstrap_cfg["confidenceLevel"]))
    bootstrap_checks = {name: values["ciLower"] > 0.0 for name, values in date_bootstrap["metrics"].items()}

    season_pass = all(all(checks.values()) for checks in season_checks.values())
    bootstrap_pass = all(bootstrap_checks.values())
    passed = season_pass and bootstrap_pass
    classification = contract["classification"]["pass"] if passed else contract["classification"]["fail"]

    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "robustnessGatePassed": passed,
        "parent": {"v54Classification": v54_report["classification"], "v54CandidateRubricPassed": v54_report["candidateRubricPassed"], "v54WorkflowRunId": contract["parentEvidence"]["v54WorkflowRunId"], "v54ArtifactId": contract["parentEvidence"]["v54ArtifactId"]},
        "modelBoundary": {"unchangedV54ImplementationReplayed": True, "replayParityTolerance": tolerance, "replayParityPassed": True, "refitWithAdditionalSeasonsUsed": False, "recalibrationUsed": False, "coefficientChangeUsed": False, "featureChangeUsed": False, "imputationChangeUsed": False, "scalingChangeUsed": False, "dispersionChangeUsed": False, "lineSetChangeUsed": False, "baselineFormulaChangeUsed": False, "thresholdSearchUsed": False},
        "data": {"scoredRows": int(len(frame)), "custodyBySeason": custody, "featureCount": len(features), "features": list(features)},
        "seasonMetrics": season_metrics,
        "seasonStabilityChecks": season_checks,
        "seasonStabilityGatePassed": season_pass,
        "dateClusterBootstrap": date_bootstrap,
        "bootstrapChecks": bootstrap_checks,
        "bootstrapGatePassed": bootstrap_pass,
        "marketBoundary": {"providerMarketKey": "batter_doubles", "repositoryRegistryFamily": "BATTER_PROP", "repositoryQuoteShape": "PLAYER_OVER_UNDER", "historicalBatterDoublesPricesUsed": False, "positiveEvEstablished": False, "hardRockFloridaPerEventAvailabilityEstablished": False, "prospectivePriceCaptureEngineeringAuthorized": bool(passed), "productionPromotionAuthorized": False},
        "policy": {"featureSearchUsed": False, "modelSearchUsed": False, "hyperparameterSearchUsed": False, "lineSearchUsed": False, "thresholdSearchUsed": False, "subsetMiningUsed": False, "postResultRuleChangeUsed": False, "productionMarketRegistryChanged": False, "liveLookupAuthorizationChanged": False, "liveMarketDiscoveryChanged": False, "rankingChanged": False, "stakeChanged": False, "betEliteAllowed": False, "automaticBetPlacementAllowed": False, "realFinancialExposure": 0},
    }
    dump(args.out, report)
    print(json.dumps({"classification": classification, "robustnessGatePassed": passed, "seasonStabilityGatePassed": season_pass, "seasonStabilityChecks": season_checks, "seasonMetrics": season_metrics, "bootstrapGatePassed": bootstrap_pass, "dateClusterBootstrap": date_bootstrap, "bootstrapChecks": bootstrap_checks}, indent=2))


if __name__ == "__main__":
    main()
