#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import math
from types import SimpleNamespace

import numpy as np
from sklearn.linear_model import LogisticRegression

SCHEMA = "courtedge-mlb-full-modular-pp-horizon-model-snapshot.v1"
PROSPECTIVE_CONTRACT_SCHEMA = "courtedge-mlb-full-modular-pp-horizon-prospective-contract.v1"
REPRO_AMENDMENT_SCHEMA = "courtedge-mlb-full-modular-pp-horizon-reproducibility-amendment.v1"
PARENT_CONTRACT_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-contract.v1"
FEATURE_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-feature-freeze.v1"
SHRINKAGE_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-shrinkage-freeze.v1"
POLICY = "CHALLENGER_PP_HORIZON"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    import os
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"PP_PROSPECTIVE_IMPORT_SPEC_FAILED:{name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_hash(value):
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def row_identity(cross, row):
    value = cross.identity(row)
    if isinstance(value, tuple):
        return list(value)
    return value


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source", "router-source",
        "v69-contract", "v69-scorer", "multi-market-scorer", "multi-market-contract",
        "modular-parent-scorer", "modular-parent-contract", "parent-router-scorer", "parent-router-contract",
        "cross-scorer", "cross-contract", "source-count-freeze", "aplus-frozen", "parent-result",
        "partial-pooling-scorer", "parent-contract", "feature-freeze", "shrinkage-freeze",
        "prospective-contract", "reproducibility-amendment", "immutable-parent-artifact", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    prospective_contract = load(args.prospective_contract)
    amendment = load(args.reproducibility_amendment)
    parent_contract = load(args.parent_contract)
    feature_freeze = load(args.feature_freeze)
    shrinkage = load(args.shrinkage_freeze)
    cross_contract = load(args.cross_contract)
    source_count_freeze = load(args.source_count_freeze)
    immutable_parent = load(args.immutable_parent_artifact)

    if prospective_contract.get("schemaVersion") != PROSPECTIVE_CONTRACT_SCHEMA:
        raise SystemExit("PP_PROSPECTIVE_CONTRACT_SCHEMA_INVALID")
    if amendment.get("schemaVersion") != REPRO_AMENDMENT_SCHEMA:
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_SCHEMA_INVALID")
    if amendment.get("scientificStatus") != "FROZEN_BEFORE_ANY_PP_HORIZON_PROSPECTIVE_CAPTURE_AND_BEFORE_ACCEPTED_MODEL_SNAPSHOT":
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_STATUS_INVALID")
    if amendment.get("amendsContractPath") != "research/mlb-full-modular-pp-horizon-prospective-v1-contract.json":
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_TARGET_INVALID")
    if amendment["prospectiveBoundaryUnchanged"]["firstEligibleOfficialDate"] != "2026-08-19":
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_DATE_DRIFT")
    if amendment["historicalParentProbabilityStatement"]["bitLevelProbabilityParityCertified"] is not False:
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_FALSE_EXACTNESS_REQUIRED")
    if amendment["reconstructedProspectiveSnapshotAcceptance"]["historicalProbabilityDifferenceIsDiagnosticNotAcceptanceThreshold"] is not True:
        raise SystemExit("PP_PROSPECTIVE_REPRO_AMENDMENT_MODE_INVALID")
    if amendment["postSnapshotAuthority"]["maximumRuntimeProbabilityAbsoluteDifferenceVsPersistedSnapshot"] != 1e-12:
        raise SystemExit("PP_PROSPECTIVE_RUNTIME_PARITY_TOLERANCE_DRIFT")
    if amendment["scientificChoicesUnchanged"]["featuresChanged"] is not False:
        raise SystemExit("PP_PROSPECTIVE_REPRO_FEATURE_DRIFT")
    if amendment["scientificChoicesUnchanged"]["hyperparametersChanged"] is not False:
        raise SystemExit("PP_PROSPECTIVE_REPRO_HYPERPARAMETER_DRIFT")
    if amendment["scientificChoicesUnchanged"]["rankingChanged"] is not False:
        raise SystemExit("PP_PROSPECTIVE_REPRO_RANKING_DRIFT")
    if parent_contract.get("schemaVersion") != PARENT_CONTRACT_SCHEMA:
        raise SystemExit("PP_PROSPECTIVE_PARENT_CONTRACT_SCHEMA_INVALID")
    if feature_freeze.get("schemaVersion") != FEATURE_SCHEMA:
        raise SystemExit("PP_PROSPECTIVE_FEATURE_SCHEMA_INVALID")
    if shrinkage.get("schemaVersion") != SHRINKAGE_SCHEMA:
        raise SystemExit("PP_PROSPECTIVE_SHRINKAGE_SCHEMA_INVALID")
    if immutable_parent.get("schemaVersion") != "courtedge-mlb-full-modular-partial-pooling.v1":
        raise SystemExit("PP_PROSPECTIVE_IMMUTABLE_PARENT_SCHEMA_INVALID")
    if prospective_contract["frozenModel"]["policy"] != POLICY:
        raise SystemExit("PP_PROSPECTIVE_POLICY_DRIFT")
    if prospective_contract["frozenModel"]["globalTrainingSeasonsExactly"] != ["2023", "2024", "2025"]:
        raise SystemExit("PP_PROSPECTIVE_TRAINING_WINDOW_DRIFT")
    if prospective_contract["prospectiveBoundary"]["firstEligibleOfficialDate"] != "2026-08-19":
        raise SystemExit("PP_PROSPECTIVE_FIRST_DATE_DRIFT")

    pp = load_module(args.partial_pooling_scorer, "pp_frozen_parent")
    cross = load_module(args.cross_scorer, "pp_frozen_cross")

    # Reconstruct the exact parent candidate universe with the exact historical inputs.
    built = pp.build_candidates(args, cross, parent_contract, cross_contract, source_count_freeze)
    all_candidates = built["allCandidates"]
    eval_candidates = built["evalCandidates"]

    training_seasons = tuple(prospective_contract["frozenModel"]["globalTrainingSeasonsExactly"])
    train_rows = [r for season in training_seasons for r in all_candidates[season]]
    decisive_train = [r for r in train_rows if r["outcome"] != "PUSH"]
    score_rows = list(eval_candidates["2026_YTD"])
    if not decisive_train or not score_rows:
        raise SystemExit("PP_PROSPECTIVE_EMPTY_FREEZE_ROWS")

    y = np.asarray([1 if r["outcome"] == "WIN" else 0 for r in decisive_train], dtype=int)
    if len(set(y.tolist())) != 2:
        raise SystemExit("PP_PROSPECTIVE_ONE_CLASS_TRAIN")

    weights = cross.game_balanced_weights(train_rows)
    x_train, x_score, feature_names, prep = pp.design_matrix(
        decisive_train, score_rows, POLICY, parent_contract, feature_freeze, shrinkage, cross
    )
    cfg = parent_contract["model"]
    model = LogisticRegression(
        penalty="l2",
        C=float(cfg["regularizationC"]),
        solver=cfg["solver"],
        max_iter=int(cfg["maxIterations"]),
        class_weight=cfg["classWeight"],
    )
    model.fit(x_train, y, sample_weight=weights)
    probs = model.predict_proba(x_score)[:, 1]

    scored = []
    for row, probability in zip(score_rows, probs):
        current = dict(row)
        current["partialPoolProbability"] = float(probability)
        scored.append(current)
    selected = cross.select_daily(scored, "partialPoolProbability")

    immutable_pp = [
        r for r in immutable_parent["dailyShadowPicks"][POLICY]
        if r["season"] == "2026_YTD"
    ]
    immutable_control = [
        r for r in immutable_parent["dailyShadowPicks"]["CONTROL_FULL_MODULAR"]
        if r["season"] == "2026_YTD"
    ]
    rebuilt_control = [
        r for r in built["control"]
        if r["season"] == "2026_YTD"
    ]

    if [row_identity(cross, r) for r in selected] != [row_identity(cross, r) for r in immutable_pp]:
        raise SystemExit("PP_PROSPECTIVE_PP_HORIZON_IDENTITY_PARITY_FAILED")
    if [row_identity(cross, r) for r in rebuilt_control] != [row_identity(cross, r) for r in immutable_control]:
        raise SystemExit("PP_PROSPECTIVE_CONTROL_IDENTITY_PARITY_FAILED")

    parent_2026 = immutable_parent["policyResults"][POLICY]["bySeason"]["2026_YTD"]
    expected_2026 = amendment["reconstructedProspectiveSnapshotAcceptance"]["mustReproduce2026YtdPpHorizonSeasonResultFromImmutableParent"]
    for key, parent_key in (("wins", "wins"), ("losses", "losses"), ("pushes", "pushes"), ("hitRate", "hitRate")):
        if parent_2026[parent_key] != expected_2026[key]:
            raise SystemExit(f"PP_PROSPECTIVE_PARENT_2026_RESULT_DRIFT:{key}")

    # The original parent optimizer state was not serialized. Per the frozen
    # pre-prospective reproducibility amendment, historical probability delta is
    # retained as a diagnostic and MUST NOT be relabeled as exact bit parity.
    max_probability_abs_diff = 0.0
    for got, expected in zip(selected, immutable_pp):
        diff = abs(float(got["partialPoolProbability"]) - float(expected["partialPoolProbability"]))
        max_probability_abs_diff = max(max_probability_abs_diff, diff)
    original_tolerance = float(prospective_contract["historicalParityGateBeforeProspectiveCapture"]["maximumProbabilityAbsoluteDifference"])
    historical_probability_bit_parity_certified = max_probability_abs_diff <= original_tolerance

    coefficients = [float(v) for v in model.coef_[0]]
    intercept = float(model.intercept_[0])
    if len(coefficients) != len(feature_names):
        raise SystemExit("PP_PROSPECTIVE_COEFFICIENT_LENGTH_DRIFT")
    if len(coefficients) != 49:
        raise SystemExit(f"PP_PROSPECTIVE_EXPECTED_49_COEFFICIENTS:{len(coefficients)}")
    if not all(math.isfinite(v) for v in coefficients + [intercept]):
        raise SystemExit("PP_PROSPECTIVE_NONFINITE_MODEL_PARAMETER")

    parameter_payload = {
        "featureNames": list(feature_names),
        "preprocessing": prep,
        "intercept": intercept,
        "rawCoefficients": coefficients,
    }

    snapshot = {
        "schemaVersion": SCHEMA,
        "scientificStatus": "FROZEN_2023_2025_PP_HORIZON_RECONSTRUCTED_PROSPECTIVE_IMPLEMENTATION_SNAPSHOT_CAPTURE_NOT_YET_STARTED",
        "policy": POLICY,
        "source": {
            "prospectiveContractPath": "research/mlb-full-modular-pp-horizon-prospective-v1-contract.json",
            "reproducibilityAmendmentPath": "research/mlb-full-modular-pp-horizon-prospective-v1-reproducibility-amendment.json",
            "parentPartialPoolingHeadSha": prospective_contract["immutableParentEvidence"]["partialPoolingHeadSha"],
            "parentWorkflowRunId": prospective_contract["immutableParentEvidence"]["partialPoolingResultSummary"]["sourceWorkflowRunId"],
            "parentArtifactId": prospective_contract["immutableParentEvidence"]["partialPoolingResultSummary"]["sourceArtifactId"],
            "parentArtifactDigest": prospective_contract["immutableParentEvidence"]["partialPoolingResultSummary"]["sourceArtifactDigest"],
            "firstFailedFreezeRunId": amendment["firstReconstructionEvidence"]["workflowRunId"],
            "firstFailedFreezeJobId": amendment["firstReconstructionEvidence"]["jobId"],
        },
        "training": {
            "seasons": list(training_seasons),
            "candidateRows": len(train_rows),
            "decisiveRows": len(decisive_train),
            "uniqueGames": len({(r["season"], int(r["gamePk"])) for r in decisive_train}),
            "weightedPositiveRate": float(np.average(y, weights=weights)),
            "prospectiveOutcomesUsed": False,
        },
        "model": {
            "family": prospective_contract["frozenModel"]["family"],
            "solver": cfg["solver"],
            "regularizationC": float(cfg["regularizationC"]),
            "maxIterations": int(cfg["maxIterations"]),
            "classWeight": cfg["classWeight"],
            "signalDeviationFeatureScale": float(shrinkage["deviationGeometry"]["signalDeviationFeatureScale"]),
            "groupInterceptFeatureScale": float(shrinkage["deviationGeometry"]["groupInterceptFeatureScale"]),
            **parameter_payload,
            "parameterPayloadDigest": canonical_hash(parameter_payload),
        },
        "historicalParity": {
            "evaluationSeason": "2026_YTD",
            "scoreCandidateRows": len(score_rows),
            "ppHorizonDailySelections": len(selected),
            "controlDailySelections": len(rebuilt_control),
            "ppHorizonIdentityMismatches": 0,
            "controlIdentityMismatches": 0,
            "maximumPartialPoolProbabilityAbsoluteDifference": max_probability_abs_diff,
            "originalContractProbabilityTolerance": original_tolerance,
            "historicalProbabilityBitParityCertified": historical_probability_bit_parity_certified,
            "historicalProbabilityDifferenceRole": "DIAGNOSTIC_ONLY_PER_FROZEN_REPRODUCIBILITY_AMENDMENT",
            "ppHorizonSeasonResult": {
                "wins": parent_2026["wins"],
                "losses": parent_2026["losses"],
                "pushes": parent_2026["pushes"],
                "hitRate": parent_2026["hitRate"],
            },
            "semanticSelectionParityPassed": True,
            "historicalProbabilityExactnessClaimed": False,
            "passedUnderReproducibilityAmendment": True,
        },
        "postSnapshotAuthority": {
            "futureRuntimeMustScoreFromPersistedSnapshotNotFreshOptimizerFit": True,
            "maximumRuntimeProbabilityAbsoluteDifferenceVsPersistedSnapshot": float(amendment["postSnapshotAuthority"]["maximumRuntimeProbabilityAbsoluteDifferenceVsPersistedSnapshot"]),
            "modelRefitAllowed": False,
            "preprocessingRefitAllowed": False,
        },
        "prospectiveBoundary": {
            "firstEligibleOfficialDate": prospective_contract["prospectiveBoundary"]["firstEligibleOfficialDate"],
            "modelRefitAllowed": False,
            "preprocessingRefitAllowed": False,
            "outcomeReadBeforeEmbargoMaturityAllowed": False,
            "productionChanged": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, snapshot)
    print("PP_HORIZON_MODEL_SNAPSHOT_BEGIN")
    print(json.dumps(snapshot, sort_keys=True, separators=(",", ":"), allow_nan=False))
    print("PP_HORIZON_MODEL_SNAPSHOT_END")
    print(json.dumps({
        "parameterPayloadDigest": snapshot["model"]["parameterPayloadDigest"],
        "training": snapshot["training"],
        "historicalParity": snapshot["historicalParity"],
        "postSnapshotAuthority": snapshot["postSnapshotAuthority"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
