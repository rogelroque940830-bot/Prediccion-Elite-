#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import math
import os
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen
from zipfile import ZipFile

import numpy as np

CONTRACT_PATH = Path("research/wnba/WNBA_R3A4_FIRST_OOS_FAMILY_ABLATION_CONTRACT.json")
R2_RESULT_PATH = Path("research/wnba/WNBA_R2B2_FIVE_FOLD_RESULT.json")
OUT_EVIDENCE = Path("wnba-r3a4-first-oos-four-factors-ablation-evidence.json")
OUT_ROWS = Path("wnba-r3a4-first-oos-four-factors-ablation-oos.jsonl")
TARGET_SEASONS = (2021, 2022, 2023, 2024, 2025)
FEATURE_NAMES = (
    "season_efg_adv",
    "season_tov_adv",
    "season_orb_adv",
    "season_ftr_adv",
    "recent10_efg_adv",
    "recent10_tov_adv",
    "recent10_orb_adv",
    "recent10_ftr_adv",
)
EPS = 1e-12
LAMBDA = 1e-3
MAX_ITER = 100
STEP_CLAMP = 2.0
TOL = 1e-9
PARITY_TOL = 1e-9


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def download_artifact(repository: str, artifact_id: int, token: str) -> bytes:
    url = f"https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}/zip"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "Prediccion-Elite-WNBA-R3A4/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    with urlopen(Request(url, headers=headers), timeout=120) as response:
        return response.read()


def zip_member(zbytes: bytes, name: str) -> bytes:
    with ZipFile(io.BytesIO(zbytes)) as zf:
        names = zf.namelist()
        if name not in names:
            raise RuntimeError(f"artifact member missing: {name}; found={names}")
        return zf.read(name)


def parse_jsonl(payload: bytes, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_no, raw in enumerate(payload.decode("utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{label} invalid JSONL line {line_no}: {exc}") from exc
        if not isinstance(value, dict):
            raise RuntimeError(f"{label} line {line_no} is not an object")
        rows.append(value)
    return rows


def clamp_probability(p: float) -> float:
    return min(1.0 - EPS, max(EPS, float(p)))


def logit(p: float) -> float:
    q = clamp_probability(p)
    return math.log(q / (1.0 - q))


def sigmoid_scalar(z: float) -> float:
    if z >= 0:
        e = math.exp(-z)
        return 1.0 / (1.0 + e)
    e = math.exp(z)
    return e / (1.0 + e)


def sigmoid_vector(z: np.ndarray) -> np.ndarray:
    z = np.asarray(z, dtype=np.float64)
    out = np.empty_like(z)
    positive = z >= 0
    out[positive] = 1.0 / (1.0 + np.exp(-z[positive]))
    e = np.exp(z[~positive])
    out[~positive] = e / (1.0 + e)
    return out


def fit_reference_platt(rows: list[dict[str, Any]]) -> tuple[float, float, int]:
    intercept = 0.0
    slope = 1.0
    for iteration in range(1, MAX_ITER + 1):
        g0 = 0.0
        g1 = LAMBDA * slope
        h00 = 0.0
        h01 = 0.0
        h11 = LAMBDA
        for row in rows:
            x = logit(float(row["rawBaseProbability"]))
            p = sigmoid_scalar(intercept + slope * x)
            error = p - int(row["outcome"])
            w = max(1e-9, p * (1.0 - p))
            g0 += error
            g1 += error * x
            h00 += w
            h01 += w * x
            h11 += w * x * x
        det = h00 * h11 - h01 * h01
        if not math.isfinite(det) or abs(det) < 1e-12:
            raise RuntimeError("reference Platt Hessian became singular")
        d0 = (h11 * g0 - h01 * g1) / det
        d1 = (-h01 * g0 + h00 * g1) / det
        intercept -= max(-STEP_CLAMP, min(STEP_CLAMP, d0))
        slope -= max(-STEP_CLAMP, min(STEP_CLAMP, d1))
        if max(abs(d0), abs(d1)) < TOL:
            if not math.isfinite(intercept) or not math.isfinite(slope):
                raise RuntimeError("reference Platt fit became non-finite")
            return intercept, slope, iteration
    raise RuntimeError("reference Platt did not converge within frozen iteration limit")


def standardize_training_only(
    train: list[dict[str, Any]], test: list[dict[str, Any]]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[str]]:
    train_raw = np.asarray([row["factorRaw"] for row in train], dtype=np.float64)
    test_raw = np.asarray([row["factorRaw"] for row in test], dtype=np.float64)
    means = np.mean(train_raw, axis=0)
    stds = np.std(train_raw, axis=0, ddof=0)
    zero_mask = stds <= EPS
    safe_stds = stds.copy()
    safe_stds[zero_mask] = 1.0
    train_z = (train_raw - means) / safe_stds
    test_z = (test_raw - means) / safe_stds
    if np.any(zero_mask):
        train_z[:, zero_mask] = 0.0
        test_z[:, zero_mask] = 0.0
    zero_names = [FEATURE_NAMES[i] for i, flag in enumerate(zero_mask.tolist()) if flag]
    return train_z, test_z, means, stds, zero_names


def fit_augmented_irls(rows: list[dict[str, Any]], z: np.ndarray) -> tuple[np.ndarray, int]:
    base_logit = np.asarray([logit(float(row["rawBaseProbability"])) for row in rows], dtype=np.float64)
    y = np.asarray([int(row["outcome"]) for row in rows], dtype=np.float64)
    x = np.column_stack([np.ones(len(rows), dtype=np.float64), base_logit, z])
    theta = np.zeros(x.shape[1], dtype=np.float64)
    theta[1] = 1.0

    for iteration in range(1, MAX_ITER + 1):
        p = sigmoid_vector(x @ theta)
        error = p - y
        w = np.maximum(1e-9, p * (1.0 - p))
        gradient = x.T @ error
        gradient[1:] += LAMBDA * theta[1:]
        hessian = x.T @ (x * w[:, None])
        hessian[1:, 1:] += np.eye(x.shape[1] - 1, dtype=np.float64) * LAMBDA
        try:
            delta = np.linalg.solve(hessian, gradient)
        except np.linalg.LinAlgError as exc:
            raise RuntimeError("augmented IRLS Hessian is singular") from exc
        if not np.all(np.isfinite(delta)):
            raise RuntimeError("augmented IRLS Newton step is non-finite")
        theta -= np.clip(delta, -STEP_CLAMP, STEP_CLAMP)
        if np.max(np.abs(delta)) < TOL:
            if not np.all(np.isfinite(theta)):
                raise RuntimeError("augmented IRLS parameters are non-finite")
            return theta, iteration
    raise RuntimeError("augmented IRLS did not converge within frozen iteration limit")


def probabilities_reference(rows: list[dict[str, Any]], intercept: float, slope: float) -> np.ndarray:
    return np.asarray(
        [sigmoid_scalar(intercept + slope * logit(float(row["rawBaseProbability"]))) for row in rows],
        dtype=np.float64,
    )


def probabilities_augmented(rows: list[dict[str, Any]], z: np.ndarray, theta: np.ndarray) -> np.ndarray:
    base_logit = np.asarray([logit(float(row["rawBaseProbability"])) for row in rows], dtype=np.float64)
    x = np.column_stack([np.ones(len(rows), dtype=np.float64), base_logit, z])
    return sigmoid_vector(x @ theta)


def metrics(probabilities: np.ndarray, outcomes: np.ndarray) -> dict[str, Any]:
    p = np.clip(np.asarray(probabilities, dtype=np.float64), EPS, 1.0 - EPS)
    y = np.asarray(outcomes, dtype=np.float64)
    if len(p) != len(y) or len(p) == 0:
        raise RuntimeError("metric input length invalid")
    brier = float(np.mean((p - y) ** 2))
    log_loss = float(np.mean(-(y * np.log(p) + (1.0 - y) * np.log(1.0 - p))))
    ece = 0.0
    for bin_index in range(10):
        lo = bin_index / 10.0
        hi = (bin_index + 1) / 10.0
        if bin_index == 9:
            mask = (p >= lo) & (p <= hi)
        else:
            mask = (p >= lo) & (p < hi)
        if np.any(mask):
            ece += float(np.mean(mask)) * abs(float(np.mean(p[mask])) - float(np.mean(y[mask])))
    return {
        "observations": int(len(p)),
        "brier": brier,
        "logLoss": log_loss,
        "ece10": float(ece),
        "meanPredictedMinusObserved": float(np.mean(p) - np.mean(y)),
    }


def bootstrap_paired(
    seasons: np.ndarray,
    outcomes: np.ndarray,
    reference: np.ndarray,
    augmented: np.ndarray,
    replicates: int,
    seed: int,
) -> dict[str, Any]:
    y = np.asarray(outcomes, dtype=np.float64)
    p0 = np.clip(np.asarray(reference, dtype=np.float64), EPS, 1.0 - EPS)
    p1 = np.clip(np.asarray(augmented, dtype=np.float64), EPS, 1.0 - EPS)
    brier_diff = (p1 - y) ** 2 - (p0 - y) ** 2
    logloss0 = -(y * np.log(p0) + (1.0 - y) * np.log(1.0 - p0))
    logloss1 = -(y * np.log(p1) + (1.0 - y) * np.log(1.0 - p1))
    logloss_diff = logloss1 - logloss0
    groups = [np.flatnonzero(seasons == season) for season in TARGET_SEASONS]
    if any(len(index) == 0 for index in groups):
        raise RuntimeError("bootstrap target-season stratum missing")
    rng = np.random.Generator(np.random.PCG64(seed))
    sampled_brier = np.empty(replicates, dtype=np.float64)
    sampled_logloss = np.empty(replicates, dtype=np.float64)
    for replicate in range(replicates):
        sampled = np.concatenate([rng.choice(index, size=len(index), replace=True) for index in groups])
        sampled_brier[replicate] = float(np.mean(brier_diff[sampled]))
        sampled_logloss[replicate] = float(np.mean(logloss_diff[sampled]))
    brier_ci = np.percentile(sampled_brier, [2.5, 97.5])
    logloss_ci = np.percentile(sampled_logloss, [2.5, 97.5])
    return {
        "method": "SEASON_STRATIFIED_PAIRED_BOOTSTRAP",
        "replicates": int(replicates),
        "rng": "NumPy PCG64",
        "seed": int(seed),
        "brierAugmentedMinusReference": {
            "point": float(np.mean(brier_diff)),
            "ci95Percentile": [float(brier_ci[0]), float(brier_ci[1])],
        },
        "logLossAugmentedMinusReference": {
            "point": float(np.mean(logloss_diff)),
            "ci95Percentile": [float(logloss_ci[0]), float(logloss_ci[1])],
        },
    }


def expected_r2_folds(r2_result: dict[str, Any]) -> dict[int, tuple[float, float]]:
    values: dict[int, tuple[float, float]] = {}
    for fold in r2_result.get("folds", []):
        season = int(fold["target_season"] if "target_season" in fold else fold["targetSeason"])
        if "platt_intercept" in fold:
            values[season] = (float(fold["platt_intercept"]), float(fold["platt_slope"]))
        else:
            platt = fold["platt"]
            values[season] = (float(platt["intercept"]), float(platt["slope"]))
    if set(values) != set(TARGET_SEASONS):
        raise RuntimeError(f"R2 expected fold parameters incomplete: {sorted(values)}")
    return values


def make_factor_raw(base: dict[str, Any], feature: dict[str, Any]) -> list[float]:
    selected = str(base.get("selectedSide", "")).upper()
    if selected not in {"HOME", "AWAY"}:
        raise RuntimeError(f"invalid selected side for {base.get('gameId')}: {selected}")
    orientation = 1.0 if selected == "HOME" else -1.0
    home = feature["home"]
    away = feature["away"]
    raw = [
        orientation * (float(home["season"]["efgPct"]) - float(away["season"]["efgPct"])),
        orientation * (float(away["season"]["tovPct"]) - float(home["season"]["tovPct"])),
        orientation * (float(home["season"]["orbPct"]) - float(away["season"]["orbPct"])),
        orientation * (float(home["season"]["ftr"]) - float(away["season"]["ftr"])),
        orientation * (float(home["recent10"]["efgPct"]) - float(away["recent10"]["efgPct"])),
        orientation * (float(away["recent10"]["tovPct"]) - float(home["recent10"]["tovPct"])),
        orientation * (float(home["recent10"]["orbPct"]) - float(away["recent10"]["orbPct"])),
        orientation * (float(home["recent10"]["ftr"]) - float(away["recent10"]["ftr"])),
    ]
    if not all(math.isfinite(value) for value in raw):
        raise RuntimeError(f"non-finite Four Factors feature for {base.get('gameId')}")
    return raw


def main() -> None:
    contract = json.loads(CONTRACT_PATH.read_text())
    r2_result = json.loads(R2_RESULT_PATH.read_text())
    expected_folds = expected_r2_folds(r2_result)
    repository = os.getenv("GITHUB_REPOSITORY", "rogelroque940830-bot/Prediccion-Elite-").strip()
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required to download frozen workflow artifacts")

    frozen = contract["frozen_inputs"]
    r2_zip = download_artifact(repository, int(frozen["r2_artifact_id"]), token)
    r3_zip = download_artifact(repository, int(frozen["r3a2_artifact_id"]), token)
    r2_zip_sha = sha256_bytes(r2_zip)
    r3_zip_sha = sha256_bytes(r3_zip)
    if r2_zip_sha != str(frozen["r2_artifact_zip_sha256"]):
        raise RuntimeError(f"R2 artifact ZIP SHA mismatch: {r2_zip_sha}")
    if r3_zip_sha != str(frozen["r3a2_artifact_zip_sha256"]):
        raise RuntimeError(f"R3A2 artifact ZIP SHA mismatch: {r3_zip_sha}")

    seed_bytes = zip_member(r2_zip, str(frozen["r2_2020_seed_file"]))
    target_bytes = zip_member(r2_zip, str(frozen["r2_2021_2025_scored_file"]))
    feature_bytes = zip_member(r3_zip, str(frozen["r3a2_feature_file"]))
    if sha256_bytes(seed_bytes) != str(frozen["r2_2020_seed_sha256"]):
        raise RuntimeError("R2 2020 seed SHA mismatch")
    if sha256_bytes(target_bytes) != str(frozen["r2_2021_2025_scored_sha256"]):
        raise RuntimeError("R2 2021-2025 scored rowset SHA mismatch")
    if sha256_bytes(feature_bytes) != str(frozen["r3a2_feature_sha256"]):
        raise RuntimeError("R3A2 Four Factors rowset SHA mismatch")

    r2_rows = parse_jsonl(seed_bytes, "R2 2020 seed") + parse_jsonl(target_bytes, "R2 2021-2025 scored")
    feature_rows = parse_jsonl(feature_bytes, "R3A2 Four Factors")
    expected_total = int(contract["population"]["expected_rows_all_seasons"])
    if len(r2_rows) != expected_total or len(feature_rows) != expected_total:
        raise RuntimeError(f"population row count mismatch r2={len(r2_rows)} r3a2={len(feature_rows)} expected={expected_total}")

    def key(row: dict[str, Any]) -> tuple[int, str]:
        return int(row["season"]), str(row["gameId"])

    r2_counts = Counter(key(row) for row in r2_rows)
    feature_counts = Counter(key(row) for row in feature_rows)
    r2_dupes = sorted([k for k, count in r2_counts.items() if count != 1])
    feature_dupes = sorted([k for k, count in feature_counts.items() if count != 1])
    if r2_dupes or feature_dupes:
        raise RuntimeError(f"duplicate identity rows r2={r2_dupes[:3]} r3a2={feature_dupes[:3]}")
    if set(r2_counts) != set(feature_counts):
        raise RuntimeError("R2 and R3A2 game identity populations differ")
    feature_map = {key(row): row for row in feature_rows}

    joined: list[dict[str, Any]] = []
    identity_mismatches = 0
    for base in r2_rows:
        identity = key(base)
        feature = feature_map[identity]
        if str(base.get("homeTeamId")) != str(feature.get("homeTeamId")) or str(base.get("awayTeamId")) != str(feature.get("awayTeamId")):
            identity_mismatches += 1
        base_date = str(base.get("targetDate", ""))
        feature_date = str(feature.get("gameDate", ""))
        if base_date and feature_date and base_date != feature_date:
            identity_mismatches += 1
        probability = float(base["p_win_selected_side"])
        outcome = int(base["selectedSideOutcome"])
        if not (math.isfinite(probability) and 0.0 < probability < 1.0):
            raise RuntimeError(f"invalid R2 raw probability for {identity}")
        if outcome not in (0, 1):
            raise RuntimeError(f"invalid binary outcome for {identity}")
        joined.append({
            "season": identity[0],
            "gameId": identity[1],
            "gameDate": feature_date or base_date,
            "selectedSide": str(base["selectedSide"]).upper(),
            "selectedTeamId": str(base.get("selectedTeamId", "")),
            "rawBaseProbability": probability,
            "outcome": outcome,
            "factorRaw": make_factor_raw(base, feature),
        })
    if identity_mismatches:
        raise RuntimeError(f"team/date identity mismatch count: {identity_mismatches}")
    joined.sort(key=lambda row: (int(row["season"]), str(row["gameDate"]), str(row["gameId"])))

    fold_results: list[dict[str, Any]] = []
    oos_rows: list[dict[str, Any]] = []
    all_reference: list[float] = []
    all_augmented: list[float] = []
    all_outcomes: list[int] = []
    all_seasons: list[int] = []
    parity_max_error = 0.0
    any_zero_variance: list[dict[str, Any]] = []

    for target_season in TARGET_SEASONS:
        train = [row for row in joined if int(row["season"]) < target_season]
        test = [row for row in joined if int(row["season"]) == target_season]
        if not train or not test:
            raise RuntimeError(f"missing train/test rows for target season {target_season}")
        intercept, slope, ref_iterations = fit_reference_platt(train)
        expected_intercept, expected_slope = expected_folds[target_season]
        intercept_error = abs(intercept - expected_intercept)
        slope_error = abs(slope - expected_slope)
        parity_error = max(intercept_error, slope_error)
        parity_max_error = max(parity_max_error, parity_error)
        if parity_error > PARITY_TOL:
            raise RuntimeError(
                f"reference Platt parity failed season {target_season}: intercept_error={intercept_error} slope_error={slope_error}"
            )

        train_z, test_z, means, stds, zero_names = standardize_training_only(train, test)
        if zero_names:
            any_zero_variance.append({"targetSeason": target_season, "features": zero_names})
        theta, aug_iterations = fit_augmented_irls(train, train_z)
        reference_p = probabilities_reference(test, intercept, slope)
        augmented_p = probabilities_augmented(test, test_z, theta)
        outcomes = np.asarray([int(row["outcome"]) for row in test], dtype=np.float64)
        reference_metrics = metrics(reference_p, outcomes)
        augmented_metrics = metrics(augmented_p, outcomes)
        selected_accuracy = float(np.mean(outcomes))

        fold_results.append({
            "targetSeason": target_season,
            "trainingSeasons": sorted({int(row["season"]) for row in train}),
            "trainingObservations": len(train),
            "testObservations": len(test),
            "referencePlatt": {
                "intercept": intercept,
                "slope": slope,
                "iterations": ref_iterations,
                "expectedFrozenR2Intercept": expected_intercept,
                "expectedFrozenR2Slope": expected_slope,
                "maxAbsoluteParityError": parity_error,
                "parityPass": True,
            },
            "trainingFactorStandardization": {
                "means": {name: float(means[i]) for i, name in enumerate(FEATURE_NAMES)},
                "populationStdDev": {name: float(stds[i]) for i, name in enumerate(FEATURE_NAMES)},
                "zeroVarianceFeatures": zero_names,
            },
            "augmentedModel": {
                "iterations": aug_iterations,
                "intercept": float(theta[0]),
                "betaBaseLogit": float(theta[1]),
                "factorCoefficients": {name: float(theta[i + 2]) for i, name in enumerate(FEATURE_NAMES)},
            },
            "selectedSideAccuracyDescriptiveOnly": selected_accuracy,
            "reference": reference_metrics,
            "augmented": augmented_metrics,
            "deltaAugmentedMinusReference": {
                "brier": augmented_metrics["brier"] - reference_metrics["brier"],
                "logLoss": augmented_metrics["logLoss"] - reference_metrics["logLoss"],
                "ece10": augmented_metrics["ece10"] - reference_metrics["ece10"],
                "meanPredictedMinusObserved": augmented_metrics["meanPredictedMinusObserved"] - reference_metrics["meanPredictedMinusObserved"],
            },
        })

        for row, z_values, p0, p1 in zip(test, test_z, reference_p.tolist(), augmented_p.tolist()):
            oos_rows.append({
                "schemaVersion": 1,
                "candidate": "BASE_R2_PLUS_FOUR_FACTORS_FIXED_SIDE_R3A4",
                "season": int(row["season"]),
                "gameId": str(row["gameId"]),
                "gameDate": str(row["gameDate"]),
                "selectedSide": str(row["selectedSide"]),
                "selectedTeamId": str(row["selectedTeamId"]),
                "selectedSideOutcome": int(row["outcome"]),
                "rawBaseProbability": float(row["rawBaseProbability"]),
                "referenceProbability": float(p0),
                "augmentedProbability": float(p1),
                "factorRaw": {name: float(row["factorRaw"][i]) for i, name in enumerate(FEATURE_NAMES)},
                "factorStandardizedFromPriorSeasonsOnly": {name: float(z_values[i]) for i, name in enumerate(FEATURE_NAMES)},
                "sideSwitchingAllowed": False,
                "marketAttached": False,
            })
        all_reference.extend(reference_p.tolist())
        all_augmented.extend(augmented_p.tolist())
        all_outcomes.extend(int(v) for v in outcomes.tolist())
        all_seasons.extend([target_season] * len(test))

    if len(oos_rows) != int(contract["population"]["expected_oos_target_rows"]):
        raise RuntimeError(f"OOS row count mismatch: {len(oos_rows)}")

    reference_array = np.asarray(all_reference, dtype=np.float64)
    augmented_array = np.asarray(all_augmented, dtype=np.float64)
    outcomes_array = np.asarray(all_outcomes, dtype=np.float64)
    seasons_array = np.asarray(all_seasons, dtype=np.int64)
    pooled_reference = metrics(reference_array, outcomes_array)
    pooled_augmented = metrics(augmented_array, outcomes_array)
    bootstrap_cfg = contract["paired_uncertainty"]
    bootstrap = bootstrap_paired(
        seasons_array,
        outcomes_array,
        reference_array,
        augmented_array,
        int(bootstrap_cfg["replicates"]),
        int(bootstrap_cfg["seed"]),
    )

    delta_brier = pooled_augmented["brier"] - pooled_reference["brier"]
    delta_logloss = pooled_augmented["logLoss"] - pooled_reference["logLoss"]
    delta_ece = pooled_augmented["ece10"] - pooled_reference["ece10"]
    brier_upper = float(bootstrap["brierAugmentedMinusReference"]["ci95Percentile"][1])
    logloss_upper = float(bootstrap["logLossAugmentedMinusReference"]["ci95Percentile"][1])
    brier_directional = brier_upper < 0.0
    logloss_directional = logloss_upper < 0.0
    brier_seasons_improved = sum(1 for fold in fold_results if fold["deltaAugmentedMinusReference"]["brier"] < 0.0)
    logloss_seasons_improved = sum(1 for fold in fold_results if fold["deltaAugmentedMinusReference"]["logLoss"] < 0.0)
    ece_ok = delta_ece <= 0.010
    brier_path_pass = bool(
        brier_directional
        and delta_logloss <= 0.005
        and ece_ok
        and brier_seasons_improved >= 3
    )
    logloss_path_pass = bool(
        logloss_directional
        and delta_brier <= 0.002
        and ece_ok
        and logloss_seasons_improved >= 3
    )
    incremental_pass = brier_path_pass or logloss_path_pass

    oos_rows.sort(key=lambda row: (int(row["season"]), str(row["gameDate"]), str(row["gameId"])))
    row_payload = ("\n".join(canonical(row) for row in oos_rows) + "\n").encode("utf-8")
    OUT_ROWS.write_bytes(row_payload)

    evidence = {
        "name": "WNBA_R3A4_FIRST_OOS_FOUR_FACTORS_ABLATION_EVIDENCE_V1",
        "contract": {
            "path": str(CONTRACT_PATH),
            "status": contract["status"],
        },
        "runtime": {
            "pythonNumPyVersion": np.__version__,
            "optimizer": "FROZEN_MULTIVARIATE_NEWTON_IRLS",
            "ridgeLambda": LAMBDA,
            "maxIterations": MAX_ITER,
            "newtonStepComponentClamp": STEP_CLAMP,
            "convergenceTolerance": TOL,
        },
        "inputCustody": {
            "r2Artifact": {
                "artifactId": int(frozen["r2_artifact_id"]),
                "zipSha256": r2_zip_sha,
                "match": True,
                "seedSha256": sha256_bytes(seed_bytes),
                "targetSha256": sha256_bytes(target_bytes),
            },
            "r3a2Artifact": {
                "artifactId": int(frozen["r3a2_artifact_id"]),
                "zipSha256": r3_zip_sha,
                "match": True,
                "featureRowsetSha256": sha256_bytes(feature_bytes),
            },
        },
        "population": {
            "joinedRows": len(joined),
            "oosRows": len(oos_rows),
            "r2DuplicateIdentityCount": len(r2_dupes),
            "r3a2DuplicateIdentityCount": len(feature_dupes),
            "identityMismatchCount": identity_mismatches,
            "exactOneToOneJoin": True,
            "rowsDroppedAfterJoin": 0,
        },
        "referenceParity": {
            "requiredTolerance": PARITY_TOL,
            "maxAbsoluteErrorAcrossFiveFolds": parity_max_error,
            "allFiveFoldsPass": parity_max_error <= PARITY_TOL,
        },
        "zeroVarianceEvents": any_zero_variance,
        "folds": fold_results,
        "pooledOos2021To2025": {
            "observations": len(oos_rows),
            "selectedSideAccuracyDescriptiveOnly": float(np.mean(outcomes_array)),
            "reference": pooled_reference,
            "augmented": pooled_augmented,
            "deltaAugmentedMinusReference": {
                "brier": delta_brier,
                "logLoss": delta_logloss,
                "ece10": delta_ece,
                "meanPredictedMinusObserved": pooled_augmented["meanPredictedMinusObserved"] - pooled_reference["meanPredictedMinusObserved"],
            },
        },
        "pairedUncertainty": bootstrap,
        "frozenIncrementalValueGate": {
            "brierDirectional95UpperBelowZero": brier_directional,
            "logLossDirectional95UpperBelowZero": logloss_directional,
            "eceNonDegradationWithinPlus0_010": ece_ok,
            "brierPointImprovedTargetSeasons": brier_seasons_improved,
            "logLossPointImprovedTargetSeasons": logloss_seasons_improved,
            "brierPathSecondaryLogLossWithinPlus0_005": delta_logloss <= 0.005,
            "logLossPathSecondaryBrierWithinPlus0_002": delta_brier <= 0.002,
            "brierPathPass": brier_path_pass,
            "logLossPathPass": logloss_path_pass,
            "incrementalValuePass": incremental_pass,
        },
        "decision": "FOUR_FACTORS_ADMITTED_TO_BOUNDED_R3_COMBINATION_RESEARCH" if incremental_pass else "FOUR_FACTORS_NOT_ADMITTED_BY_FROZEN_R3A4_ABLATION",
        "scientificBoundaries": {
            "fixedR2SelectedSide": True,
            "sideSwitchingPerformed": False,
            "eliteThresholdSearchPerformed": False,
            "coverageFilterSearchPerformed": False,
            "targetSeasonFeatureSelectionPerformed": False,
            "targetSeasonHyperparameterTuningPerformed": False,
            "postResultRowDroppingPerformed": False,
            "marketFeatureUse": False,
            "productionMutation": False,
            "historicalResultIsIndependentCertification": False,
        },
        "oosRowset": {
            "rows": len(oos_rows),
            "bytes": len(row_payload),
            "sha256": sha256_bytes(row_payload),
        },
        "nextGate": contract["next_gate_on_pass"] if incremental_pass else contract["next_gate_on_fail"],
    }
    OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(json.dumps({
        "decision": evidence["decision"],
        "referenceParity": evidence["referenceParity"],
        "population": evidence["population"],
        "pooled": evidence["pooledOos2021To2025"],
        "bootstrap": evidence["pairedUncertainty"],
        "gate": evidence["frozenIncrementalValueGate"],
        "oosRowset": evidence["oosRowset"],
        "nextGate": evidence["nextGate"],
    }, indent=2))


if __name__ == "__main__":
    main()
