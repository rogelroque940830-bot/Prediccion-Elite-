#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-p0-step12v53-batter-home-runs-binary-no-retune-robustness.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v53-batter-home-runs-binary-no-retune-robustness-contract.v1"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_v52(path):
    spec = importlib.util.spec_from_file_location("courtedge_v52_batter_hr_binary", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V53_V52_MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close(label, actual, expected, tolerance):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
        raise SystemExit(f"V53_PARITY_NONFINITE:{label}:{actual}:{expected}")
    if abs(float(actual) - float(expected)) > tolerance:
        raise SystemExit(f"V53_V52_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tolerance}")


def binary_log_loss_per_row(y, p):
    y = np.asarray(y, dtype=float)
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 0.999999)
    return -(y * np.log(p) + (1.0 - y) * np.log(1.0 - p))


def bootstrap_date_means(frame, metric_arrays, replicates, seed, confidence):
    names = list(metric_arrays)
    work = frame[["officialDate"]].copy().reset_index(drop=True)
    for name, values in metric_arrays.items():
        work[name] = np.asarray(values, dtype=float)
    daily = work.groupby("officialDate", sort=True)[names].mean()
    if len(daily) < 2:
        raise SystemExit("V53_BOOTSTRAP_TOO_FEW_DATES")
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
            name: {
                "equalDayPointEstimate": float(point[index]),
                "ciLower": float(lower[index]),
                "ciUpper": float(upper[index]),
            }
            for index, name in enumerate(names)
        },
    }


def predictions(frame, features, imputer, scaler, model, constant_prob, v52):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    model_p = np.clip(model.predict_proba(X)[:, 1], 1e-6, 0.999999)
    batter_p = np.asarray(
        [
            v52.batter_only_probability(
                row["batter_hrpa_shrunk"],
                row["lineup_slot_pa_per_start_shrunk"],
                constant_prob,
            )
            for _, row in frame.iterrows()
        ],
        dtype=float,
    )
    constant_p = np.full(len(frame), float(constant_prob), dtype=float)
    y = frame["anyHomeRun"].to_numpy(dtype=float)
    return y, model_p, constant_p, batter_p


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--batter-root", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--v52-contract", required=True)
    parser.add_argument("--v52-script", required=True)
    parser.add_argument("--v52-report", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V53_CONTRACT_SCHEMA_INVALID")
    v52_contract = load(args.v52_contract)
    v52_report = load(args.v52_report)
    if v52_report.get("classification") != contract["parentEvidence"]["v52ClassificationRequired"]:
        raise SystemExit("V53_V52_PARENT_CLASSIFICATION_INVALID")
    if not v52_report.get("candidateRubricPassed"):
        raise SystemExit("V53_V52_PARENT_GATE_NOT_PASSED")

    v52 = load_v52(args.v52_script)
    seasons = [
        v52_contract["dataBoundary"]["modelFitSeason"],
        v52_contract["dataBoundary"]["validationSeason"],
        *v52_contract["dataBoundary"]["retrospectiveEvaluationSeasons"],
    ]
    records, custody = [], {}
    for season in seasons:
        season_rows, season_custody = v52.build_season_rows(args.root, args.batter_root, season, v52_contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    features = tuple(v52_contract["features"]["exactly"])
    train = frame[frame["season"] == "2022"].copy()
    validation = frame[frame["season"] == "2023"].copy()
    evaluation = frame[frame["season"].isin(["2024", "2025", "2026_YTD"])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit("V53_EMPTY_PARTITION")

    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)]))
    y_train = train["anyHomeRun"].to_numpy(dtype=int)
    model_cfg = v52_contract["model"]
    model = LogisticRegression(
        C=float(model_cfg["regularizationC"]),
        solver=model_cfg["solver"],
        max_iter=int(model_cfg["maxIter"]),
        class_weight=None,
    )
    model.fit(X_train, y_train)
    constant_prob = float(np.mean(y_train))

    validation_metrics = v52.evaluate(validation, features, imputer, scaler, model, constant_prob)
    evaluation_metrics = v52.evaluate(evaluation, features, imputer, scaler, model, constant_prob)

    tolerance = float(contract["replayParity"]["absoluteTolerance"])
    for metric in contract["replayParity"]["requiredMetrics"]:
        assert_close(f"validation2023.{metric}", validation_metrics[metric], v52_report["validation2023"][metric], tolerance)
        assert_close(
            f"evaluation2024_2026Ytd.{metric}",
            evaluation_metrics[metric],
            v52_report["evaluation2024_2026Ytd"][metric],
            tolerance,
        )

    season_metrics = {}
    season_checks = {}
    for season in contract["seasonStabilityGate"]["partitions"]:
        metrics = v52.evaluate(
            frame[frame["season"] == season].copy(),
            features,
            imputer,
            scaler,
            model,
            constant_prob,
        )
        season_metrics[season] = metrics
        season_checks[season] = {
            "modelLogLossBeatsConstant": metrics["modelVsConstantLogLossImprovement"] > 0.0,
            "modelLogLossBeatsBatterOnly": metrics["modelVsBatterOnlyLogLossImprovement"] > 0.0,
            "modelBrierBeatsConstant": metrics["modelVsConstantBrierImprovement"] > 0.0,
            "modelBrierBeatsBatterOnly": metrics["modelVsBatterOnlyBrierImprovement"] > 0.0,
            "modelAbsoluteMeanBiasNoWorseThanConstant": metrics["modelAbsoluteMeanCalibrationBias"] <= metrics["constantAbsoluteMeanCalibrationBias"],
            "modelAbsoluteMeanBiasNoWorseThanBatterOnly": metrics["modelAbsoluteMeanCalibrationBias"] <= metrics["batterOnlyAbsoluteMeanCalibrationBias"],
        }

    evaluation_frame = evaluation.reset_index(drop=True)
    y, model_p, constant_p, batter_p = predictions(
        evaluation_frame, features, imputer, scaler, model, constant_prob, v52
    )
    model_log = binary_log_loss_per_row(y, model_p)
    constant_log = binary_log_loss_per_row(y, constant_p)
    batter_log = binary_log_loss_per_row(y, batter_p)
    model_brier = (model_p - y) ** 2
    constant_brier = (constant_p - y) ** 2
    batter_brier = (batter_p - y) ** 2

    bootstrap_arrays = {
        "logLossVsConstant": constant_log - model_log,
        "logLossVsBatterOnly": batter_log - model_log,
        "brierVsConstant": constant_brier - model_brier,
        "brierVsBatterOnly": batter_brier - model_brier,
    }
    bootstrap_cfg = contract["dateClusterBootstrapGate"]
    date_bootstrap = bootstrap_date_means(
        evaluation_frame,
        bootstrap_arrays,
        int(bootstrap_cfg["replicates"]),
        int(bootstrap_cfg["randomSeed"]),
        float(bootstrap_cfg["confidenceLevel"]),
    )
    bootstrap_checks = {
        name: values["ciLower"] > 0.0
        for name, values in date_bootstrap["metrics"].items()
    }

    season_pass = all(all(checks.values()) for checks in season_checks.values())
    bootstrap_pass = all(bootstrap_checks.values())
    passed = season_pass and bootstrap_pass
    classification = contract["classification"]["pass"] if passed else contract["classification"]["fail"]

    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "robustnessGatePassed": passed,
        "parent": {
            "v52Classification": v52_report["classification"],
            "v52CandidateRubricPassed": v52_report["candidateRubricPassed"],
            "v52WorkflowRunId": contract["parentEvidence"]["v52WorkflowRunId"],
            "v52ArtifactId": contract["parentEvidence"]["v52ArtifactId"],
        },
        "modelBoundary": {
            "unchangedV52ImplementationReplayed": True,
            "replayParityTolerance": tolerance,
            "replayParityPassed": True,
            "refitWithAdditionalSeasonsUsed": False,
            "recalibrationUsed": False,
            "coefficientChangeUsed": False,
            "featureChangeUsed": False,
            "imputationChangeUsed": False,
            "scalingChangeUsed": False,
            "baselineFormulaChangeUsed": False,
            "thresholdSearchUsed": False,
            "subsetSearchUsed": False,
        },
        "data": {
            "scoredRows": int(len(frame)),
            "custodyBySeason": custody,
            "featureCount": len(features),
            "features": list(features),
        },
        "seasonMetrics": season_metrics,
        "seasonStabilityChecks": season_checks,
        "seasonStabilityGatePassed": season_pass,
        "dateClusterBootstrap": date_bootstrap,
        "bootstrapChecks": bootstrap_checks,
        "bootstrapGatePassed": bootstrap_pass,
        "marketBoundary": {
            "providerMarketKey": "batter_home_runs",
            "repositoryRegistryFamily": "BATTER_PROP",
            "repositoryQuoteShape": "PLAYER_OVER_UNDER",
            "researchTargetEvent": "HOME_RUNS_GREATER_THAN_ZERO",
            "researchBinaryTargetMatchesProviderQuoteShape": False,
            "historicalBatterHomeRunPricesUsed": False,
            "positiveEvEstablished": False,
            "hardRockFloridaPerEventAvailabilityEstablished": False,
            "providerContractMappingResearchAuthorized": bool(passed),
            "priceCaptureAuthorized": False,
            "productionPromotionAuthorized": False,
        },
        "policy": {
            "featureSearchUsed": False,
            "modelSearchUsed": False,
            "hyperparameterSearchUsed": False,
            "thresholdSearchUsed": False,
            "subsetMiningUsed": False,
            "postResultRuleChangeUsed": False,
            "productionMarketRegistryChanged": False,
            "liveLookupAuthorizationChanged": False,
            "liveMarketDiscoveryChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        "classification": classification,
        "robustnessGatePassed": passed,
        "seasonStabilityGatePassed": season_pass,
        "seasonStabilityChecks": season_checks,
        "seasonMetrics": season_metrics,
        "bootstrapGatePassed": bootstrap_pass,
        "dateClusterBootstrap": date_bootstrap,
        "bootstrapChecks": bootstrap_checks,
    }, indent=2))


if __name__ == "__main__":
    main()
