#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy
import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h8_interaction_contradiction_engine as r5h8

MODEL = "R5H19_2026_FROZEN_INFERENCE_EXPORT"
REFERENCE = "R5B2_HICONF_SWITCH"
TARGET_SEASON = 2026
TRAINED_THROUGH = 2025
PARITY_SEASON = 2025
PARITY_EXPECTED_CORE_GAMES = 15
MAX_PARITY_PROBABILITY_ERROR = 1e-10
MAX_PARITY_SCORE_ERROR = 1e-10


def to_jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [to_jsonable(v) for v in value.tolist()]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if np.isfinite(v) else None
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if pd.isna(value):
        return None
    return value


def canonical_digest(value: Any) -> str:
    payload = json.dumps(to_jsonable(value), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def fit_frozen_logit(train: pd.DataFrame, features: list[str]) -> tuple[Any, float]:
    c = float(base.tune_logit(train, features))
    model = base.pipe("logit", c)
    model.fit(train[features], train.home_win.astype(int))
    return model, c


def serialize_pipeline(model: Any, features: list[str], c: float) -> dict:
    imp = model.named_steps["impute"]
    scale = model.named_steps["scale"]
    lm = model.named_steps["model"]
    medians = np.asarray(imp.statistics_, dtype=float)
    means = np.asarray(scale.mean_, dtype=float)
    scales = np.asarray(scale.scale_, dtype=float)
    coef = np.asarray(lm.coef_, dtype=float).reshape(-1)
    intercept = float(np.asarray(lm.intercept_, dtype=float).reshape(-1)[0])
    if not (len(features) == len(medians) == len(means) == len(scales) == len(coef)):
        raise RuntimeError("R5H19 serialized pipeline dimensionality mismatch")
    if not all(np.isfinite(v).all() for v in (medians, means, scales, coef)) or not np.isfinite(intercept):
        raise RuntimeError("R5H19 frozen pipeline contains non-finite parameters")
    return {
        "kind": "STANDARDIZED_LOGISTIC_REGRESSION",
        "features": list(features),
        "imputer": {"strategy": "median", "statistics": medians.tolist()},
        "scaler": {"mean": means.tolist(), "scale": scales.tolist()},
        "logistic": {
            "C": float(c),
            "classes": [int(v) for v in np.asarray(lm.classes_).tolist()],
            "coef": coef.tolist(),
            "intercept": intercept,
        },
    }


def pure_predict(spec: dict, frame: pd.DataFrame) -> np.ndarray:
    cols = spec["features"]
    raw = frame[cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    median = np.asarray(spec["imputer"]["statistics"], dtype=float)
    mean = np.asarray(spec["scaler"]["mean"], dtype=float)
    scale = np.asarray(spec["scaler"]["scale"], dtype=float)
    coef = np.asarray(spec["logistic"]["coef"], dtype=float)
    intercept = float(spec["logistic"]["intercept"])
    missing = ~np.isfinite(raw)
    if missing.any():
        raw = raw.copy()
        raw[missing] = np.take(median, np.where(missing)[1])
    z = (raw - mean) / scale
    logits = intercept + z @ coef
    out = np.empty(len(logits), dtype=float)
    pos = logits >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-logits[pos]))
    ez = np.exp(logits[~pos])
    out[~pos] = ez / (1.0 + ez)
    return np.clip(out, 1e-6, 1 - 1e-6)


def build_models(train: pd.DataFrame, rules: dict[str, list[str]]) -> tuple[dict, dict[str, np.ndarray]]:
    models: dict[str, dict] = {}
    probabilities: dict[str, np.ndarray] = {}
    ref_features = list(hy.feature_sets()[REFERENCE])
    ref_model, ref_c = fit_frozen_logit(train, ref_features)
    models["reference"] = {
        "name": REFERENCE,
        "pipeline": serialize_pipeline(ref_model, ref_features, ref_c),
    }
    for rule, features in rules.items():
        model, c = fit_frozen_logit(train, list(features))
        models.setdefault("experts", {})[rule] = serialize_pipeline(model, list(features), c)
    return models, probabilities


def score_from_artifact(models: dict, frame: pd.DataFrame, rules: list[str]) -> pd.DataFrame:
    q = frame[["game_id", "season", "week", "home_win"]].copy().rename(columns={"home_win": "y"})
    q["ref_p"] = pure_predict(models["reference"]["pipeline"], frame)
    for rule in rules:
        q[f"p__{rule}"] = pure_predict(models["experts"][rule], frame)
    return q


def config_payload(cfg: dict) -> dict:
    keep = [
        "top_k", "reliability_power", "conviction_power", "redundancy_lambda",
        "synergy_lambda", "agreement_floor", "diversity_power", "confidence_bins",
        "confidence_floor_quantile", "confidence_floor", "rule_selection_rate",
        "bin_edges", "rule_thresholds", "safe_conf_thresholds", "inner_fit_seasons",
        "inner_validation_seasons", "selection_objective",
    ]
    return {k: to_jsonable(cfg[k]) for k in keep if k in cfg}


def fit_2026_artifact(x: pd.DataFrame, meta: pd.DataFrame, rules: dict[str, list[str]]) -> dict:
    names = list(rules)
    cfg, rel, pair, _ = r5h8.select_config(meta.copy(), names)
    models, _ = build_models(x.copy(), rules)
    artifact = {
        "schemaVersion": "courtedge-nfl-r5h19-frozen-inference.v1",
        "sport": "NFL",
        "model": "R5H8_INTERACTION_CONTRADICTION_ENGINE",
        "reference": REFERENCE,
        "targetSeason": TARGET_SEASON,
        "trainedThroughSeason": TRAINED_THROUGH,
        "researchPr": 663,
        "marketDataUsedAsFeatures": False,
        "sameGameOutcomeAllowed": False,
        "postKickoffEvidenceAllowed": False,
        "automaticProductionPromotion": False,
        "historicalAccuracyExposedAsGameProbability": False,
        "ruleOrder": names,
        "ruleBlocks": rules,
        "coreConfig": config_payload(cfg),
        "reliability": rel[["rule", "fit_accuracy", "fit_log_loss", "reliability"]].to_dict(orient="records"),
        "pairStructure": pair.to_dict(orient="records"),
        "models": models,
    }
    artifact = to_jsonable(artifact)
    artifact["semanticDigest"] = canonical_digest(artifact)
    return artifact


def parity_2025(x: pd.DataFrame, meta: pd.DataFrame, rules: dict[str, list[str]]) -> tuple[dict, dict]:
    names = list(rules)
    train = x[x.season < PARITY_SEASON].copy()
    native = meta[meta.season == PARITY_SEASON].copy().reset_index(drop=True)
    hist_meta = meta[meta.season < PARITY_SEASON].copy()
    if train.empty or native.empty or hist_meta.empty:
        raise RuntimeError("R5H19 parity window unavailable")
    target_lookup = x[x.season == PARITY_SEASON].set_index("game_id", drop=False)
    target = target_lookup.loc[native.game_id.tolist()].reset_index(drop=True)

    cfg, rel, pair, _ = r5h8.select_config(hist_meta, names)
    models, _ = build_models(train, rules)
    pure = score_from_artifact(models, target, names)

    max_errors: dict[str, float] = {}
    max_errors["reference"] = float(np.max(np.abs(pure.ref_p.to_numpy() - native.ref_p.to_numpy())))
    for rule in names:
        err = float(np.max(np.abs(pure[f"p__{rule}"].to_numpy() - native[f"p__{rule}"].to_numpy())))
        max_errors[rule] = err
    max_probability_error = max(max_errors.values())

    native_score, native_agreement, _, _ = r5h8.score_games(native, rel, pair, cfg)
    pure_score, pure_agreement, _, _ = r5h8.score_games(pure, rel, pair, cfg)
    edges = r5h8.decode_edges(cfg["bin_edges"])
    floor = float(cfg["confidence_floor"])
    thresholds = r5h8.decode_thresholds(cfg["rule_thresholds"])
    native_selected, native_bins = r5h6.apply_rule_thresholds(native, native_score, edges, floor, thresholds)
    pure_selected, pure_bins = r5h6.apply_rule_thresholds(pure, pure_score, edges, floor, thresholds)

    max_score_error = float(np.max(np.abs(native_score - pure_score)))
    max_agreement_error = float(np.max(np.abs(native_agreement - pure_agreement)))
    selected_mismatch = int(np.count_nonzero(native_selected != pure_selected))
    bin_mismatch = int(np.count_nonzero(native_bins != pure_bins))
    core_games = int(native_selected.sum())

    if max_probability_error > MAX_PARITY_PROBABILITY_ERROR:
        raise RuntimeError(f"R5H19 probability parity failed: {max_probability_error}")
    if max_score_error > MAX_PARITY_SCORE_ERROR or max_agreement_error > MAX_PARITY_SCORE_ERROR:
        raise RuntimeError(
            f"R5H19 score parity failed: score={max_score_error} agreement={max_agreement_error}"
        )
    if selected_mismatch or bin_mismatch:
        raise RuntimeError(
            f"R5H19 selection parity failed: selected={selected_mismatch} bins={bin_mismatch}"
        )
    if core_games != PARITY_EXPECTED_CORE_GAMES:
        raise RuntimeError(f"R5H19 2025 certified core custody drifted: {core_games}")

    union_features = sorted(set(hy.feature_sets()[REFERENCE]).union(*[set(v) for v in rules.values()]))
    rows = []
    for i, row in target.iterrows():
        rows.append({
            "gameId": str(row.game_id),
            "season": int(row.season),
            "week": int(row.week),
            "features": {f: to_jsonable(row[f]) for f in union_features},
            "expected": {
                "referenceProbability": float(native.loc[i, "ref_p"]),
                "expertProbabilities": {rule: float(native.loc[i, f"p__{rule}"]) for rule in names},
                "interactionScore": float(native_score[i]),
                "agreement": float(native_agreement[i]),
                "confidenceStratum": int(native_bins[i]),
                "coreSelected": bool(native_selected[i]),
            },
        })
    fixture = {
        "schemaVersion": "courtedge-nfl-r5h19-2025-parity-fixture.v1",
        "season": PARITY_SEASON,
        "trainedThroughSeason": PARITY_SEASON - 1,
        "rules": names,
        "models": models,
        "coreConfig": config_payload(cfg),
        "reliability": rel[["rule", "fit_accuracy", "fit_log_loss", "reliability"]].to_dict(orient="records"),
        "pairStructure": pair.to_dict(orient="records"),
        "rows": rows,
    }
    fixture = to_jsonable(fixture)
    fixture["semanticDigest"] = canonical_digest(fixture)
    summary = {
        "season": PARITY_SEASON,
        "games": int(len(native)),
        "certifiedCoreSelections": core_games,
        "maxProbabilityError": max_probability_error,
        "maxInteractionScoreError": max_score_error,
        "maxAgreementError": max_agreement_error,
        "selectionMismatches": selected_mismatch,
        "confidenceBinMismatches": bin_mismatch,
        "pass": True,
    }
    return fixture, summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h19-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--end-season", type=int, default=TRAINED_THROUGH)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0) & x.season.le(a.end_season)].copy().reset_index(drop=True)
    if int(x.season.max()) != TRAINED_THROUGH:
        raise RuntimeError(f"R5H19 expected training through {TRAINED_THROUGH}")

    rules = r5h3.expanded_rule_blocks()
    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, _ = r5h.expert_oos(x, a.expert_oos_start, TRAINED_THROUGH)
    ref = r5h4.reference_oos(x, a.expert_oos_start, TRAINED_THROUGH)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    artifact = fit_2026_artifact(x, meta, rules)
    fixture, parity = parity_2025(x, meta, rules)
    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "productionChanged": False,
        "targetSeason": TARGET_SEASON,
        "trainedThroughSeason": TRAINED_THROUGH,
        "model": "R5H8_INTERACTION_CONTRADICTION_ENGINE",
        "reference": REFERENCE,
        "ruleCount": len(rules),
        "artifactDigest": artifact["semanticDigest"],
        "parityFixtureDigest": fixture["semanticDigest"],
        "parity": parity,
        "marketDataUsedAsFeatures": False,
        "sameGameOutcomeUsedForInference": False,
        "futureTargetSeasonFeatureRankingUsed": False,
        "automaticProductionPromotion": False,
        "nextAction": "PORT_FROZEN_ARTIFACT_TO_TYPESCRIPT_AND_RUN_CROSS_LANGUAGE_PARITY",
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "trainingCutoff": "2025_COMPLETED_GAMES_ONLY",
        "targetSeason": 2026,
        "targetSeasonOutcomesUsedForFit": "NO",
        "targetSeasonFeatureRankingUsed": "NO",
        "sameGamePbpAllowed": "NO",
        "postKickoffEvidenceAllowed": "NO",
        "frozenArtifact": "EXPORTED",
        "pythonSerializationParity2025": "PASS",
        "typescriptParity": "PENDING",
        "livePregameMaterializer": "PENDING",
        "productionCodeTouched": False,
    }

    (out / "nfl_r5h19_2026_artifact.json").write_text(
        json.dumps(artifact, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    (out / "nfl_r5h19_2025_parity_fixture.json").write_text(
        json.dumps(fixture, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    (out / "nfl_r5h19_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    (out / "nfl_r5h19_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    print("NFL_R5H19_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H19_COMPLETE")


if __name__ == "__main__":
    main()
