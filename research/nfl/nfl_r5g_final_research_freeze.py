#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy


SOURCE_MODEL = "R5B2_HICONF_SWITCH"
TOURNAMENT_REFERENCE = "REGULARIZED_LINEAR_REFERENCE"
EXPECTED_R5F_DECISION = "RETAIN_R5B2_REGULARIZED_LINEAR_REFERENCE"
LOCK_SCHEMA = "courtedge-nfl-r5g-2026-model-lock.v1"
PROTOCOL_SCHEMA = "courtedge-nfl-r5g-prospective-shadow-protocol.v1"
TARGET_SEASON = 2026
TRAINING_THROUGH = 2025


def canonical_bytes(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha_obj(obj: dict) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()


def sha_features(cols: list[str]) -> str:
    return hashlib.sha256("\n".join(cols).encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def finite_list(values) -> list[float]:
    out = []
    for v in np.asarray(values, dtype=float).ravel():
        if not np.isfinite(v):
            raise RuntimeError("non-finite value in frozen model payload")
        out.append(float(v))
    return out


def extract_linear_pipeline(pipe, *, target: str, hyperparameter_name: str, hyperparameter_value: float) -> dict:
    impute = pipe.named_steps["impute"]
    scale = pipe.named_steps["scale"]
    model = pipe.named_steps["model"]
    coef = np.asarray(model.coef_, dtype=float)
    intercept = np.asarray(model.intercept_, dtype=float)
    return {
        "target": target,
        "hyperparameter": {hyperparameter_name: float(hyperparameter_value)},
        "imputerMedian": finite_list(impute.statistics_),
        "scalerMean": finite_list(scale.mean_),
        "scalerScale": finite_list(scale.scale_),
        "coefficient": finite_list(coef),
        "intercept": finite_list(intercept),
    }


def validate_r5f(r5f_dir: Path, r5b_cert_dir: Path, features: list[str], feature_sha: str) -> dict:
    manifest = load_json(r5f_dir / "nfl_r5f_manifest.json")
    audit = load_json(r5f_dir / "nfl_r5f_audit.json")
    verdict = load_json(r5f_dir / "nfl_r5f_verdict.json")
    cert = load_json(r5b_cert_dir / "nfl_r5b_cert_verdict.json")

    checks = {
        "r5fResearchOnly": verdict.get("researchOnly") is True and manifest.get("researchOnly") is True,
        "r5fMarketFree": verdict.get("marketDataUsedAsFeatures") is False and manifest.get("marketDataUsedAsFeatures") is False,
        "r5fNoMarketOptimization": manifest.get("marketOptimizationPerformed") is False,
        "r5fDecisionRetainsReference": verdict.get("decision") == EXPECTED_R5F_DECISION,
        "r5fWinnerIsReference": verdict.get("tournamentWinner") == TOURNAMENT_REFERENCE,
        "r5fNoEligibleChallenger": verdict.get("eligibleChallengers") == [],
        "r5fFeatureSetFrozen": verdict.get("featureSetFrozen") is True and manifest.get("featureSetFrozen") is True,
        "r5fFeatureSource": verdict.get("frozenFeatureSource") == SOURCE_MODEL and manifest.get("referenceSourceModel") == SOURCE_MODEL,
        "r5fFeatureCount": int(verdict.get("frozenFeatureCount", -1)) == len(features) == int(manifest.get("featureCount", -2)),
        "r5fFeatureHash": verdict.get("frozenFeatureSha256") == feature_sha == manifest.get("featureSha256"),
        "r5fNoFeaturesAdded": verdict.get("featuresAddedByR5F") == [] and manifest.get("featuresAddedByR5F") == [],
        "r5fAuditFrozenVector": audit.get("frozenFeatureVector") == "PASS_EXACT_R5B2_HICONF_SWITCH_VECTOR",
        "r5fAuditMarketBoundary": audit.get("marketBoundary") == "PASS_MARKET_FREE",
        "r5fAuditNoPostHocFeatureSelection": audit.get("postHocFeatureSelection") == "NONE_FEATURES_FROZEN_BEFORE_TOURNAMENT",
        "r5fAuditNoGateMutation": audit.get("postHocModelGateMutation") == "NONE_PREDECLARED_GATE",
        "r5fNoProductionTouch": audit.get("productionCodeTouched") is False and manifest.get("productionPromotionAutomatic") is False,
        "r5bCandidate": cert.get("candidate") == SOURCE_MODEL,
        "r5bCertified": cert.get("coreCertificationConditionsPass") is True,
        "r5bCertificationNoMutation": cert.get("modelChangedDuringCertification") is False,
    }
    bad = [k for k, v in checks.items() if not v]
    if bad:
        raise RuntimeError("R5G prerequisite failure: " + ", ".join(bad))
    return checks


def fit_frozen_2026_models(dataset_path: Path, features: list[str]) -> tuple[dict, dict]:
    x = pd.read_parquet(dataset_path)
    required = set(features) | {"season", "margin", "game_total", "home_win", "game_id"}
    missing = sorted(required - set(x.columns))
    if missing:
        raise RuntimeError(f"R5G dataset missing columns: {missing}")

    x = x[(pd.to_numeric(x.season, errors="coerce") <= TRAINING_THROUGH) & x.margin.ne(0)].copy()
    x = x[x.home_win.notna() & x.margin.notna() & x.game_total.notna()].copy()
    if x.empty:
        raise RuntimeError("R5G training set empty")
    if int(x.season.max()) != TRAINING_THROUGH:
        raise RuntimeError(f"R5G expected training through {TRAINING_THROUGH}, got {x.season.max()}")
    if int(x.season.min()) > 2012:
        raise RuntimeError("R5G unexpectedly lost early historical training seasons")

    c = base.tune_logit(x, features)
    win_pipe = base.pipe("logit", c)
    win_pipe.fit(x[features], x.home_win.astype(int))

    ridge_pipes = {}
    ridge_alpha = {}
    for target in ["margin", "game_total"]:
        a = base.tune_ridge(x, features, target)
        m = base.pipe("ridge", a)
        m.fit(x[features], x[target])
        ridge_pipes[target] = m
        ridge_alpha[target] = float(a)

    models = {
        "homeWinProbability": extract_linear_pipeline(
            win_pipe, target="home_win_probability", hyperparameter_name="C", hyperparameter_value=float(c)
        ),
        "margin": extract_linear_pipeline(
            ridge_pipes["margin"], target="margin", hyperparameter_name="alpha", hyperparameter_value=ridge_alpha["margin"]
        ),
        "gameTotal": extract_linear_pipeline(
            ridge_pipes["game_total"], target="game_total", hyperparameter_name="alpha", hyperparameter_value=ridge_alpha["game_total"]
        ),
    }

    meta = {
        "trainingRows": int(len(x)),
        "trainingSeasonMin": int(x.season.min()),
        "trainingSeasonMax": int(x.season.max()),
        "trainingGameIdSha256": hashlib.sha256("\n".join(sorted(x.game_id.astype(str))).encode("utf-8")).hexdigest(),
        "innerValidationSeasonFor2026Freeze": TRAINING_THROUGH,
        "selectedHyperparameters": {
            "homeWinLogisticC": float(c),
            "marginRidgeAlpha": ridge_alpha["margin"],
            "gameTotalRidgeAlpha": ridge_alpha["game_total"],
        },
    }
    return models, meta


def build_lock(features: list[str], feature_sha: str, models: dict, training_meta: dict) -> dict:
    payload = {
        "schemaVersion": LOCK_SCHEMA,
        "researchOnly": True,
        "targetSeason": TARGET_SEASON,
        "shadowOnly": True,
        "sourceModel": SOURCE_MODEL,
        "architecture": "regularized logistic home-win probability + ridge margin + ridge game-total",
        "tournamentReference": TOURNAMENT_REFERENCE,
        "r5fDecision": EXPECTED_R5F_DECISION,
        "trainingThroughSeason": TRAINING_THROUGH,
        "featureSetFrozen": True,
        "featureCount": len(features),
        "featureSha256": feature_sha,
        "features": features,
        "featuresAddedByR5G": [],
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "oddsAllowed": False,
        "modelRefitDuring2026Shadow": False,
        "featureSearchDuring2026Shadow": False,
        "thresholdTuningDuring2026Shadow": False,
        "productionPromotionAutomatic": False,
        "training": training_meta,
        "models": models,
    }
    lock = dict(payload)
    lock["payloadSha256"] = sha_obj(payload)
    return lock


def build_protocol(lock: dict) -> dict:
    return {
        "schemaVersion": PROTOCOL_SCHEMA,
        "researchOnly": True,
        "season": TARGET_SEASON,
        "mode": "PROSPECTIVE_SHADOW_ONLY",
        "frozenLockPayloadSha256": lock["payloadSha256"],
        "frozenFeatureSha256": lock["featureSha256"],
        "frozenSourceModel": SOURCE_MODEL,
        "marketInputsAllowed": False,
        "oddsSpreadMoneylineTotalLineVigAllowed": False,
        "productionIntegrationAllowed": False,
        "pregameCutoff": {
            "definition": "00:00:00 UTC at the start of the target gameday",
            "depthEligibility": "timestamped depth snapshot must be strictly earlier than cutoff",
            "injuryEligibility": "if a timestamped injury feed is available under the frozen protocol, row timestamp must be strictly earlier than cutoff",
            "targetGamedayUpdates": "FORBIDDEN",
            "sameWeekUntimestampedDepth": "FORBIDDEN",
            "predictionDeadline": "canonical shadow prediction must be generated before the cutoff; post-cutoff reruns are audit-only and ineligible",
        },
        "2026AvailabilityPolicy": {
            "timestampedDepthPrimary": True,
            "nflverseInjuryFeedRequired": False,
            "reason": "the certified 2025 portion already operated without nflverse injury parquet availability; missing injury status remains missing/zero and must never be reconstructed postgame",
            "postgameInjuryBackfill": "FORBIDDEN",
            "newInjurySourceAfterLock": "FORBIDDEN_WITHOUT_NEW_PROTOCOL_VERSION_AND_PRESEASON_REVIEW",
        },
        "custody": {
            "rawSourceSnapshotRequired": True,
            "rawSourceFields": ["url", "retrievedAtUtc", "bytes", "sha256"],
            "modelLockHashRequired": True,
            "codeCommitShaRequired": True,
            "targetFeatureVectorRequired": True,
            "predictionPayloadRequired": True,
            "predictionPayloadHashRequired": True,
            "writeOncePerGame": True,
            "overwriteCanonicalPrediction": "FORBIDDEN",
            "artifactOnlyCustodySufficient": False,
            "durableRetentionRequirement": "append-only Git history or equivalent immutable store retained through final 2026 review",
        },
        "canonicalPredictionFields": [
            "game_id", "season", "week", "gameday", "home_team", "away_team",
            "generated_at_utc", "cutoff_utc", "model_lock_sha256", "code_commit_sha",
            "home_win_probability", "predicted_margin", "predicted_game_total",
        ],
        "reviews": {
            "interim": "after 8 completed 2026 regular-season weeks; diagnostics only; no model changes",
            "primary": "after the 2026 regular season is complete",
            "primaryMetrics": ["log_loss", "brier"],
            "secondaryMetrics": ["accuracy", "margin_mae", "total_mae", "ece10"],
        },
        "promotion": {
            "automatic": False,
            "requiresSeparateCertification": True,
            "requiresSeparatePR": True,
        },
        "activationState": "PRESEASON_LOCK_COMPLETE_LIVE_CUSTODY_NOT_STARTED",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5f-dir", default="nfl-r5f-tournament-output")
    ap.add_argument("--r5b-cert-dir", default="nfl-r5b-cert-output")
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5g-output")
    ap.add_argument("--expected-lock", default="research/nfl/locks/nfl_r5g_2026_model_lock.json")
    a = ap.parse_args()

    r5f_dir = Path(a.r5f_dir)
    r5b_cert_dir = Path(a.r5b_cert_dir)
    hybrid_dir = Path(a.hybrid_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    features = list(hy.feature_sets()[SOURCE_MODEL])
    if len(features) != len(set(features)):
        raise RuntimeError("R5G frozen feature vector contains duplicates")
    if any(any(t in c.lower() for t in base.FORBIDDEN) for c in features):
        raise RuntimeError("R5G market-like feature name detected")
    feature_sha = sha_features(features)

    prerequisite_checks = validate_r5f(r5f_dir, r5b_cert_dir, features, feature_sha)
    models, training_meta = fit_frozen_2026_models(hybrid_dir / "nfl_r5b_hybrid_dataset.parquet", features)
    lock = build_lock(features, feature_sha, models, training_meta)
    protocol = build_protocol(lock)

    expected_path = Path(a.expected_lock)
    lock_status = "GENERATED_NOT_YET_REPOSITORY_LOCKED"
    if expected_path.exists():
        expected = load_json(expected_path)
        if expected != lock:
            raise RuntimeError(
                "committed R5G model lock does not exactly match regenerated lock: "
                f"expected={expected.get('payloadSha256')} regenerated={lock.get('payloadSha256')}"
            )
        lock_status = "PASS_EXACT_COMMITTED_MODEL_LOCK"

    audit = {
        "r5fPrerequisites": "PASS",
        "r5fPrerequisiteChecks": prerequisite_checks,
        "marketBoundary": "PASS_MARKET_FREE",
        "frozenFeatureVector": "PASS_EXACT_R5B2_HICONF_SWITCH_VECTOR",
        "frozenFeatureSha256": feature_sha,
        "frozenModelArchitecture": "PASS_REGULARIZED_LINEAR_REFERENCE",
        "modelLockStatus": lock_status,
        "modelRefitDuringShadow": "FORBIDDEN",
        "featureSearchDuringShadow": "FORBIDDEN",
        "postCutoffCanonicalPrediction": "FORBIDDEN",
        "targetGameOutcomeBeforePrediction": "FORBIDDEN",
        "productionCodeTouched": False,
        "readyForLiveActivation": bool(lock_status == "PASS_EXACT_COMMITTED_MODEL_LOCK"),
    }

    (out / "nfl_r5g_2026_model_lock.json").write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5g_prospective_protocol.json").write_text(json.dumps(protocol, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / "nfl_r5g_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    summary = {
        "stage": "NFL-R5G_FINAL_RESEARCH_FREEZE",
        "decision": "FREEZE_R5B2_REGULARIZED_LINEAR_FOR_2026_PROSPECTIVE_SHADOW",
        "modelLockPayloadSha256": lock["payloadSha256"],
        "featureSha256": feature_sha,
        "featureCount": len(features),
        "selectedHyperparameters": training_meta["selectedHyperparameters"],
        "trainingRows": training_meta["trainingRows"],
        "modelLockStatus": lock_status,
        "liveActivationReady": audit["readyForLiveActivation"],
        "productionChanged": False,
        "marketUsed": False,
    }
    (out / "nfl_r5g_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("NFL_R5G_FINAL_RESEARCH_FREEZE")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5G_AUDIT")
    print(json.dumps(audit, indent=2, sort_keys=True))
    print("NFL_R5G_COMPLETE")


if __name__ == "__main__":
    main()
