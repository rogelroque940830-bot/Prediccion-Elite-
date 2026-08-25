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
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h15_independent_signal_family_discovery as h15
import nfl_r5h19_2026_frozen_inference_export as h19

MODEL = "R5H21_2026_LATE_DOWN_RUNTIME_EXPORT"
FAMILY = "LATE_DOWN_CONVERSION"
TARGET_SEASON = 2026
TRAINED_THROUGH = 2025
PARITY_SEASON = 2025
H20_REPLAY_SEMANTIC_DIGEST = "d2873a557ed391b7bffaa6d12fb49ead7cc4554538554bdaa5bdf8248a06c5c5"
R5H18_ARTIFACT_ID = 9543740255
R5H18_DEPLOYABLE_GAMES = 53
R5H18_DEPLOYABLE_WINS = 46
R5H18_DEPLOYABLE_LOSSES = 7
R5H18_COMBINED_GAMES = 211
R5H18_COMBINED_WINS = 171
R5H18_COMBINED_LOSSES = 40
PARITY_THRESHOLD_ONLY_GAMES_2025 = 34
MAX_PARITY_PROBABILITY_ERROR = 1e-10
MAX_PARITY_SUPPORT_ERROR = 1e-10


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


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def enabled(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    if pd.isna(value):
        return False
    return bool(value)


def threshold_only_mask(frame: pd.DataFrame, threshold: float) -> np.ndarray:
    score = h15.family_support_score(frame, FAMILY)
    return (
        (~frame.core_selected.to_numpy(dtype=bool))
        & np.isfinite(score)
        & (score > 0)
        & (score >= float(threshold))
    )


def reproduce_r5h18_threshold_only(meta: pd.DataFrame, config_by_season: pd.DataFrame) -> tuple[np.ndarray, dict]:
    selected = np.zeros(len(meta), dtype=bool)
    seasons = meta.season.to_numpy(dtype=int)
    for y in sorted(int(v) for v in meta.season.unique()):
        row = config_by_season[
            (config_by_season.test_season == y) & (config_by_season.family == FAMILY)
        ]
        if row.empty or not enabled(row.iloc[0].enabled):
            continue
        threshold = float(row.iloc[0].threshold)
        iy = seasons == y
        local = meta[iy].copy()
        selected[np.flatnonzero(iy)] = threshold_only_mask(local, threshold)
    metrics = r5h6.metrics(meta, selected)
    return selected, metrics


def late_down_end_state(games: pd.DataFrame, team_metrics: pd.DataFrame) -> dict:
    keys = ["off_late_down_conversion", "def_late_down_conversion_allowed"]
    lookup = {
        (str(r.game_id), str(r.team)): r._asdict()
        for r in team_metrics.itertuples(index=False)
    }
    states: dict[str, dict[str, float]] = {}
    current_season: int | None = None
    processed = 0
    last_game_id: str | None = None

    for g in games.sort_values(["gameday", "game_id"]).itertuples(index=False):
        season = int(g.season)
        if current_season is not None and season != current_season:
            for state in states.values():
                for key in keys:
                    value = h15._state_value(state, key)
                    if np.isfinite(value):
                        state[key] = 0.75 * value
        current_season = season
        home, away = str(g.home_team), str(g.away_team)
        hs = states.setdefault(home, {})
        aws = states.setdefault(away, {})
        hm = lookup.get((str(g.game_id), home), {})
        am = lookup.get((str(g.game_id), away), {})
        for key in keys:
            h15._state_update(hs, key, float(hm.get(key, np.nan)), 0.22)
            h15._state_update(aws, key, float(am.get(key, np.nan)), 0.22)
        processed += 1
        last_game_id = str(g.game_id)

    team_state = []
    for team in sorted(states):
        state = states[team]
        team_state.append({
            "team": team,
            "offLateDownConversion": to_jsonable(h15._state_value(state, "off_late_down_conversion")),
            "defLateDownConversionAllowed": to_jsonable(h15._state_value(state, "def_late_down_conversion_allowed")),
        })
    payload = {
        "schemaVersion": "courtedge-nfl-r5h21-late-down-state.v1",
        "currentSeason": int(current_season) if current_season is not None else None,
        "trainedThroughSeason": TRAINED_THROUGH,
        "processedCompletedGames": int(processed),
        "lastAppliedGameId": last_game_id,
        "ewmaAlpha": 0.22,
        "seasonDecay": 0.75,
        "teamState": team_state,
    }
    payload["semanticDigest"] = canonical_digest(payload)
    return payload


def frozen_2026_threshold(meta: pd.DataFrame, core_cfg: pd.DataFrame) -> tuple[dict, pd.DataFrame]:
    cfg, search = h15.choose_family_threshold(meta.copy(), FAMILY, core_cfg)
    if cfg is None:
        raise RuntimeError("R5H21 could not certify a prior-only 2026 late-down threshold")
    validation = json.loads(str(cfg["validation_seasons"]))
    if validation != [2024, 2025]:
        raise RuntimeError(f"R5H21 expected 2026 validation seasons [2024, 2025], got {validation}")
    if not bool(cfg["gate"]):
        raise RuntimeError("R5H21 frozen 2026 late-down threshold failed its prior-only gate")
    return cfg, search


def build_parity_fixture(
    x2: pd.DataFrame,
    meta: pd.DataFrame,
    core_cfg: pd.DataFrame,
    features: list[str],
) -> tuple[dict, dict]:
    train = x2[x2.season < PARITY_SEASON].copy()
    target = x2[x2.season == PARITY_SEASON].copy()
    native = meta[meta.season == PARITY_SEASON].copy().reset_index(drop=True)
    hist = meta[meta.season < PARITY_SEASON].copy()
    if train.empty or target.empty or native.empty or hist.empty:
        raise RuntimeError("R5H21 2025 parity window unavailable")

    target_lookup = target.set_index("game_id", drop=False)
    target = target_lookup.loc[native.game_id.astype(str).tolist()].reset_index(drop=True)
    model, c = h19.fit_frozen_logit(train, features)
    spec = h19.serialize_pipeline(model, features, c)
    pure_probability = h19.pure_predict(spec, target)
    native_probability = native[f"p__{FAMILY}"].to_numpy(dtype=float)
    max_probability_error = float(np.max(np.abs(pure_probability - native_probability)))

    cfg, _ = h15.choose_family_threshold(hist, FAMILY, core_cfg)
    if cfg is None:
        raise RuntimeError("R5H21 2025 parity threshold unavailable")
    parity_validation = json.loads(str(cfg["validation_seasons"]))
    if parity_validation != [2023, 2024]:
        raise RuntimeError(f"R5H21 2025 parity validation drifted: {parity_validation}")

    native_support = h15.family_support_score(native, FAMILY)
    pure_frame = native[["game_id", "season", "week", "ref_p", "core_selected"]].copy()
    pure_frame[f"p__{FAMILY}"] = pure_probability
    pure_support = h15.family_support_score(pure_frame, FAMILY)
    max_support_error = float(np.max(np.abs(pure_support - native_support)))
    threshold = float(cfg["threshold"])
    native_selected = threshold_only_mask(native, threshold)
    pure_selected = threshold_only_mask(pure_frame, threshold)
    selection_mismatches = int(np.count_nonzero(native_selected != pure_selected))

    if max_probability_error > MAX_PARITY_PROBABILITY_ERROR:
        raise RuntimeError(f"R5H21 late-down probability parity failed: {max_probability_error}")
    if max_support_error > MAX_PARITY_SUPPORT_ERROR:
        raise RuntimeError(f"R5H21 late-down support parity failed: {max_support_error}")
    if selection_mismatches:
        raise RuntimeError(f"R5H21 threshold-only selection parity failed: {selection_mismatches}")
    if int(native_selected.sum()) != PARITY_THRESHOLD_ONLY_GAMES_2025:
        raise RuntimeError(
            f"R5H21 expected {PARITY_THRESHOLD_ONLY_GAMES_2025} threshold-only 2025 selections, "
            f"got {int(native_selected.sum())}"
        )

    rows = []
    for i, row in target.iterrows():
        rows.append({
            "gameId": str(row.game_id),
            "season": int(row.season),
            "week": int(row.week),
            "features": {feature: to_jsonable(row[feature]) for feature in features},
            "referenceProbability": float(native.loc[i, "ref_p"]),
            "coreSelected": bool(native.loc[i, "core_selected"]),
            "expected": {
                "lateDownProbability": float(native_probability[i]),
                "supportScore": float(native_support[i]),
                "thresholdOnlySelected": bool(native_selected[i]),
            },
        })

    fixture = {
        "schemaVersion": "courtedge-nfl-r5h21-late-down-2025-parity.v1",
        "family": FAMILY,
        "season": PARITY_SEASON,
        "trainedThroughSeason": PARITY_SEASON - 1,
        "productionPolicy": "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
        "validationSeasons": parity_validation,
        "threshold": threshold,
        "model": spec,
        "rows": rows,
    }
    fixture = to_jsonable(fixture)
    fixture["semanticDigest"] = canonical_digest(fixture)
    summary = {
        "season": PARITY_SEASON,
        "games": int(len(native)),
        "thresholdOnlySelections": int(native_selected.sum()),
        "threshold": threshold,
        "validationSeasons": parity_validation,
        "maxProbabilityError": max_probability_error,
        "maxSupportScoreError": max_support_error,
        "selectionMismatches": selection_mismatches,
        "pass": True,
    }
    return fixture, summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--h15-dir", default="nfl-r5h15-output")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    ap.add_argument("--out-dir", default="nfl-r5h21-output")
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    hybrid_dir = Path(a.hybrid_dir)
    h15_dir = Path(a.h15_dir)
    cache = Path(a.cache_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    hybrid_path = hybrid_dir / "nfl_r5b_hybrid_dataset.parquet"
    supplement_path = h15_dir / "nfl_r5h15_supplemental_pregame_features.parquet"
    meta_path = h15_dir / "nfl_r5h15_predictions.parquet"
    core_cfg_path = h15_dir / "nfl_r5h15_r5h8_core_config_by_season.csv"
    family_cfg_path = h15_dir / "nfl_r5h15_config_by_season.csv"
    for path in (hybrid_path, supplement_path, meta_path, core_cfg_path, family_cfg_path):
        if not path.exists():
            raise RuntimeError(f"R5H21 missing required frozen-chain input {path}")

    x = pd.read_parquet(hybrid_path)
    x = x[x.margin.ne(0) & x.season.le(TRAINED_THROUGH)].copy()
    supplement = pd.read_parquet(supplement_path)
    x2 = x.merge(
        supplement.drop(columns=["season", "week"]),
        on="game_id",
        how="left",
        validate="one_to_one",
    )
    meta = pd.read_parquet(meta_path).reset_index(drop=True)
    meta = meta[meta.season.le(TRAINED_THROUGH)].reset_index(drop=True)
    core_cfg = pd.read_csv(core_cfg_path)
    family_cfg = pd.read_csv(family_cfg_path)

    features = list(h15.new_rule_blocks()[FAMILY])
    missing = [feature for feature in features if feature not in x2.columns]
    if missing:
        raise RuntimeError(f"R5H21 missing late-down features: {missing}")
    if f"p__{FAMILY}" not in meta.columns or "core_selected" not in meta.columns or "ref_p" not in meta.columns:
        raise RuntimeError("R5H21 H15 meta contract is incomplete")

    # Reproduce the certified R5H18 threshold-only historical route before exporting anything new.
    h18_selected, h18_metrics = reproduce_r5h18_threshold_only(meta, family_cfg)
    if (
        h18_metrics["games"] != R5H18_DEPLOYABLE_GAMES
        or h18_metrics["wins"] != R5H18_DEPLOYABLE_WINS
        or h18_metrics["losses"] != R5H18_DEPLOYABLE_LOSSES
    ):
        raise RuntimeError(f"R5H21 R5H18 custody drifted: {h18_metrics}")
    combined = meta.core_selected.to_numpy(dtype=bool) | h18_selected
    combined_metrics = r5h6.metrics(meta, combined)
    if (
        combined_metrics["games"] != R5H18_COMBINED_GAMES
        or combined_metrics["wins"] != R5H18_COMBINED_WINS
        or combined_metrics["losses"] != R5H18_COMBINED_LOSSES
    ):
        raise RuntimeError(f"R5H21 R5H18 combined custody drifted: {combined_metrics}")

    cfg2026, threshold_search = frozen_2026_threshold(meta, core_cfg)
    model, c = h19.fit_frozen_logit(x2, features)
    model_spec = h19.serialize_pipeline(model, features, c)

    seasons = list(range(a.start_season, a.end_season + 1))
    games = base.schedule(cache, seasons)
    team_metrics, pbp_provenance = h15.aggregate_extra_pbp(cache, seasons)
    state = late_down_end_state(games, team_metrics)
    if state["currentSeason"] != TRAINED_THROUGH:
        raise RuntimeError("R5H21 end-state did not reach 2025")

    parity_fixture, parity_summary = build_parity_fixture(x2, meta, core_cfg, features)

    threshold_payload = {
        "family": FAMILY,
        "validationSeasons": json.loads(str(cfg2026["validation_seasons"])),
        "quantile": float(cfg2026["quantile"]),
        "threshold": float(cfg2026["threshold"]),
        "selectedGames": int(cfg2026["selected_games"]),
        "selectedAccuracy": float(cfg2026["selected_accuracy"]),
        "selectedWilson95Lower": float(cfg2026["selected_wilson95_lower"]),
        "matchedGames": int(cfg2026["matched_games"]),
        "matchedAccuracy": float(cfg2026["matched_accuracy"]),
        "deltaVsMatched": float(cfg2026["delta_vs_matched"]),
        "worstValidationSeasonAccuracy": float(cfg2026["worst_validation_season_accuracy"]),
        "gate": bool(cfg2026["gate"]),
    }

    artifact = {
        "schemaVersion": "courtedge-nfl-r5h21-late-down-runtime.v1",
        "sport": "NFL",
        "stage": MODEL,
        "family": FAMILY,
        "targetSeason": TARGET_SEASON,
        "trainedThroughSeason": TRAINED_THROUGH,
        "researchPr": 663,
        "productionPolicy": "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
        "referenceDirectionSource": "R5B2_HICONF_SWITCH_FROZEN_2026_REFERENCE_PROBABILITY",
        "supportScore": "sign(ref_p-0.5) * logit(late_down_probability)",
        "selectionRule": "NON_CORE_AND_FINITE_SUPPORT_AND_SUPPORT_GT_0_AND_SUPPORT_GTE_FROZEN_THRESHOLD",
        "targetSeasonRankingOrCapUsed": False,
        "features": features,
        "model": model_spec,
        "thresholdConfig": threshold_payload,
        "end2025State": state,
        "sourceCustody": {
            "hybridDatasetSha256": file_sha256(hybrid_path),
            "h15SupplementSha256": file_sha256(supplement_path),
            "h15PredictionsSha256": file_sha256(meta_path),
            "h20ReplaySemanticDigest": H20_REPLAY_SEMANTIC_DIGEST,
            "r5h18ArtifactId": R5H18_ARTIFACT_ID,
            "r5h18ThresholdOnlyGames": R5H18_DEPLOYABLE_GAMES,
            "r5h18ThresholdOnlyWins": R5H18_DEPLOYABLE_WINS,
            "r5h18ThresholdOnlyLosses": R5H18_DEPLOYABLE_LOSSES,
            "r5h18CombinedGames": R5H18_COMBINED_GAMES,
            "r5h18CombinedWins": R5H18_COMBINED_WINS,
            "r5h18CombinedLosses": R5H18_COMBINED_LOSSES,
        },
        "safety": {
            "marketDataUsedAsFeatures": False,
            "sameGameOutcomeAllowed": False,
            "postKickoffEvidenceAllowed": False,
            "target2026OutcomesUsed": False,
            "future2026FeatureRankingUsed": False,
            "historicalAccuracyExposedAsGameProbability": False,
            "automaticBetPlacement": False,
            "automaticProductionPromotion": False,
        },
    }
    artifact = to_jsonable(artifact)
    artifact["semanticDigest"] = canonical_digest(artifact)

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "targetSeason": TARGET_SEASON,
        "trainedThroughSeason": TRAINED_THROUGH,
        "family": FAMILY,
        "featureCount": len(features),
        "features": features,
        "frozen2026Threshold": threshold_payload["threshold"],
        "frozen2026ThresholdQuantile": threshold_payload["quantile"],
        "frozen2026ValidationSeasons": threshold_payload["validationSeasons"],
        "frozen2026ThresholdGate": threshold_payload["gate"],
        "productionPolicy": artifact["productionPolicy"],
        "targetSeasonRankingOrCapUsed": False,
        "r5h18Custody": h18_metrics,
        "r5h18CombinedCustody": combined_metrics,
        "end2025StateTeams": len(state["teamState"]),
        "end2025StateProcessedGames": state["processedCompletedGames"],
        "end2025StateDigest": state["semanticDigest"],
        "parity2025": parity_summary,
        "artifactSemanticDigest": artifact["semanticDigest"],
        "marketDataUsedAsFeature": False,
        "sameGameOutcomeAllowed": False,
        "postKickoffEvidenceAllowed": False,
        "target2026OutcomesUsed": False,
        "automaticProductionPromotion": False,
        "nextAction": "PORT_FROZEN_LATE_DOWN_ARTIFACT_TO_PR664_AND_RUN_TYPESCRIPT_PARITY",
    }
    audit = {
        "r5h18HistoricalThresholdOnlyCustody": "PASS_53_GAMES_46_7",
        "r5h18CombinedCustody": "PASS_211_GAMES_171_40",
        "2026ThresholdCalibration": "PRIOR_ONLY_VALIDATED_ON_2024_2025",
        "2026ThresholdPolicy": "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
        "2026TargetOutcomeUsage": "NONE",
        "2026FutureCandidateRanking": "NONE",
        "pregameState": "SNAPSHOT_BEFORE_SAME_GAME_UPDATE",
        "marketBoundary": "PASS_MARKET_FREE",
        "productionCodeTouched": False,
    }

    (out / "nfl_r5h21_2026_late_down_runtime_artifact.json").write_text(
        json.dumps(artifact, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    (out / "nfl_r5h21_2025_parity_fixture.json").write_text(
        json.dumps(parity_fixture, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    threshold_search.to_csv(out / "nfl_r5h21_2026_threshold_search.csv", index=False)
    pd.DataFrame(pbp_provenance).to_json(
        out / "nfl_r5h21_pbp_provenance.json", orient="records", indent=2
    )
    (out / "nfl_r5h21_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    (out / "nfl_r5h21_audit.json").write_text(
        json.dumps(audit, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )

    print("NFL_R5H21_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True, allow_nan=False))
    print("NFL_R5H21_COMPLETE")


if __name__ == "__main__":
    main()
