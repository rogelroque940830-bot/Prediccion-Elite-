#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import io
import json
import math
import os
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zipfile import ZipFile

import numpy as np

CONTRACT = Path("research/wnba/WNBA_R3A5B_QUALITY_ADJUSTED_FORM_OOS_ABLATION_CONTRACT.json")
R2_RESULT = Path("research/wnba/WNBA_R2B2_FIVE_FOLD_RESULT.json")
ENGINE_PATH = Path("scripts/wnba-r3a4-first-oos-four-factors-ablation.py")
OUT_EVIDENCE = Path("wnba-r3a5b-quality-adjusted-form-oos-ablation-evidence.json")
OUT_ROWS = Path("wnba-r3a5b-quality-adjusted-form-oos.jsonl")
TARGET_SEASONS = (2021, 2022, 2023, 2024, 2025)
FEATURE_NAMES = (
    "recent5_efficiency_delta_adv",
    "recent10_efficiency_delta_adv",
    "recent5_margin_adv",
    "recent10_margin_adv",
    "recent5_quality_adjusted_efficiency_adv",
    "recent10_quality_adjusted_efficiency_adv",
)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical(row: dict) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def github_artifact(repository: str, artifact_id: int, token: str) -> bytes:
    conn = http.client.HTTPSConnection("api.github.com", timeout=120)
    conn.request(
        "GET",
        f"/repos/{repository}/actions/artifacts/{artifact_id}/zip",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Prediccion-Elite-WNBA-R3A5B/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    response = conn.getresponse()
    status = response.status
    location = response.getheader("Location")
    response.read()
    conn.close()
    if status not in (301, 302, 303, 307, 308) or not location:
        raise RuntimeError(f"artifact redirect failed status={status} artifact={artifact_id}")
    if urlparse(location).scheme != "https":
        raise RuntimeError("artifact redirect is not HTTPS")
    with urlopen(Request(location, headers={"User-Agent": "Prediccion-Elite-WNBA-R3A5B/1.0"}), timeout=120) as signed:
        return signed.read()


def member(zbytes: bytes, name: str) -> bytes:
    with ZipFile(io.BytesIO(zbytes)) as zf:
        if name not in zf.namelist():
            raise RuntimeError(f"missing artifact member {name}")
        return zf.read(name)


def jsonl(payload: bytes) -> list[dict]:
    return [json.loads(line) for line in payload.decode("utf-8").splitlines() if line.strip()]


def load_engine():
    spec = importlib.util.spec_from_file_location("wnba_r3a4_frozen_engine", ENGINE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load frozen R3A4 statistical engine")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.FEATURE_NAMES = FEATURE_NAMES
    return module


def feature_raw(base: dict, form: dict) -> list[float]:
    selected = str(base["selectedSide"]).upper()
    if selected not in {"HOME", "AWAY"}:
        raise RuntimeError(f"invalid selected side {selected}")
    orientation = 1.0 if selected == "HOME" else -1.0
    home = form["home"]
    away = form["away"]
    values = [
        orientation * (float(home["recent5EfficiencyDeltaVsSeason"]) - float(away["recent5EfficiencyDeltaVsSeason"])),
        orientation * (float(home["recent10EfficiencyDeltaVsSeason"]) - float(away["recent10EfficiencyDeltaVsSeason"])),
        orientation * (float(home["recent5MarginPerGame"]) - float(away["recent5MarginPerGame"])),
        orientation * (float(home["recent10MarginPerGame"]) - float(away["recent10MarginPerGame"])),
        orientation * (float(home["recent5QualityAdjustedNetEfficiency"]) - float(away["recent5QualityAdjustedNetEfficiency"])),
        orientation * (float(home["recent10QualityAdjustedNetEfficiency"]) - float(away["recent10QualityAdjustedNetEfficiency"])),
    ]
    if not all(math.isfinite(value) for value in values):
        raise RuntimeError(f"non-finite quality-form feature game={base['gameId']}")
    return values


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    r2_result = json.loads(R2_RESULT.read_text())
    engine = load_engine()
    engine_sha = sha256_bytes(ENGINE_PATH.read_bytes())
    expected_folds = engine.expected_r2_folds(r2_result)
    repository = os.getenv("GITHUB_REPOSITORY", "rogelroque940830-bot/Prediccion-Elite-").strip()
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")
    frozen = contract["frozen_inputs"]

    r2_zip = github_artifact(repository, int(frozen["r2_artifact_id"]), token)
    form_zip = github_artifact(repository, int(frozen["quality_form_artifact_id"]), token)
    if sha256_bytes(r2_zip) != frozen["r2_artifact_zip_sha256"]:
        raise RuntimeError("R2 artifact ZIP SHA mismatch")
    if sha256_bytes(form_zip) != frozen["quality_form_artifact_zip_sha256"]:
        raise RuntimeError("quality form artifact ZIP SHA mismatch")
    seed_bytes = member(r2_zip, frozen["r2_2020_seed_file"])
    target_bytes = member(r2_zip, frozen["r2_2021_2025_scored_file"])
    form_bytes = member(form_zip, frozen["quality_form_file"])
    if sha256_bytes(seed_bytes) != frozen["r2_2020_seed_sha256"]:
        raise RuntimeError("R2 2020 seed SHA mismatch")
    if sha256_bytes(target_bytes) != frozen["r2_2021_2025_scored_sha256"]:
        raise RuntimeError("R2 target rowset SHA mismatch")
    if sha256_bytes(form_bytes) != frozen["quality_form_sha256"]:
        raise RuntimeError("quality form rowset SHA mismatch")

    r2_rows = jsonl(seed_bytes) + jsonl(target_bytes)
    form_rows = jsonl(form_bytes)
    expected_total = int(contract["population"]["expected_rows_all_seasons"])
    if len(r2_rows) != expected_total or len(form_rows) != expected_total:
        raise RuntimeError(f"row count mismatch r2={len(r2_rows)} form={len(form_rows)}")

    def key(row: dict) -> tuple[int, str]:
        return int(row["season"]), str(row["gameId"])

    r2_counts = Counter(key(row) for row in r2_rows)
    form_counts = Counter(key(row) for row in form_rows)
    if any(count != 1 for count in r2_counts.values()) or any(count != 1 for count in form_counts.values()):
        raise RuntimeError("duplicate season+gameId identity")
    if set(r2_counts) != set(form_counts):
        raise RuntimeError("R2 and quality-form populations differ")
    form_map = {key(row): row for row in form_rows}

    joined: list[dict] = []
    identity_mismatch = 0
    for base in r2_rows:
        identity = key(base)
        form = form_map[identity]
        if str(base.get("homeTeamId")) != str(form.get("homeTeamId")) or str(base.get("awayTeamId")) != str(form.get("awayTeamId")):
            identity_mismatch += 1
        base_date = str(base.get("targetDate", ""))
        form_date = str(form.get("gameDate", ""))
        if base_date and form_date and base_date != form_date:
            identity_mismatch += 1
        probability = float(base["p_win_selected_side"])
        outcome = int(base["selectedSideOutcome"])
        if not (math.isfinite(probability) and 0 < probability < 1) or outcome not in (0, 1):
            raise RuntimeError(f"invalid R2 probability/outcome {identity}")
        joined.append({
            "season": identity[0],
            "gameId": identity[1],
            "gameDate": form_date or base_date,
            "selectedSide": str(base["selectedSide"]).upper(),
            "selectedTeamId": str(base.get("selectedTeamId", "")),
            "rawBaseProbability": probability,
            "outcome": outcome,
            "factorRaw": feature_raw(base, form),
        })
    if identity_mismatch:
        raise RuntimeError(f"identity mismatch count {identity_mismatch}")
    joined.sort(key=lambda row: (row["season"], row["gameDate"], row["gameId"]))

    fold_results: list[dict] = []
    oos_rows: list[dict] = []
    all_reference: list[float] = []
    all_augmented: list[float] = []
    all_outcomes: list[int] = []
    all_seasons: list[int] = []
    parity_max = 0.0
    zero_variance_events: list[dict] = []

    for target_season in TARGET_SEASONS:
        train = [row for row in joined if row["season"] < target_season]
        test = [row for row in joined if row["season"] == target_season]
        intercept, slope, ref_iterations = engine.fit_reference_platt(train)
        exp_intercept, exp_slope = expected_folds[target_season]
        parity_error = max(abs(intercept - exp_intercept), abs(slope - exp_slope))
        parity_max = max(parity_max, parity_error)
        if parity_error > 1e-9:
            raise RuntimeError(f"R2 reference parity failure season={target_season} error={parity_error}")

        train_z, test_z, means, stds, zero_names = engine.standardize_training_only(train, test)
        if zero_names:
            zero_variance_events.append({"targetSeason": target_season, "features": zero_names})
        theta, aug_iterations = engine.fit_augmented_irls(train, train_z)
        p0 = engine.probabilities_reference(test, intercept, slope)
        p1 = engine.probabilities_augmented(test, test_z, theta)
        y = np.asarray([row["outcome"] for row in test], dtype=np.float64)
        m0 = engine.metrics(p0, y)
        m1 = engine.metrics(p1, y)
        fold_results.append({
            "targetSeason": target_season,
            "trainingSeasons": sorted({row["season"] for row in train}),
            "trainingObservations": len(train),
            "testObservations": len(test),
            "referencePlatt": {
                "intercept": intercept,
                "slope": slope,
                "iterations": ref_iterations,
                "maxAbsoluteParityError": parity_error,
                "parityPass": True
            },
            "trainingFeatureStandardization": {
                "means": {name: float(means[i]) for i, name in enumerate(FEATURE_NAMES)},
                "populationStdDev": {name: float(stds[i]) for i, name in enumerate(FEATURE_NAMES)},
                "zeroVarianceFeatures": zero_names
            },
            "augmentedModel": {
                "iterations": aug_iterations,
                "intercept": float(theta[0]),
                "betaBaseLogit": float(theta[1]),
                "featureCoefficients": {name: float(theta[i + 2]) for i, name in enumerate(FEATURE_NAMES)}
            },
            "selectedSideAccuracyDescriptiveOnly": float(np.mean(y)),
            "reference": m0,
            "augmented": m1,
            "deltaAugmentedMinusReference": {
                "brier": m1["brier"] - m0["brier"],
                "logLoss": m1["logLoss"] - m0["logLoss"],
                "ece10": m1["ece10"] - m0["ece10"],
                "meanPredictedMinusObserved": m1["meanPredictedMinusObserved"] - m0["meanPredictedMinusObserved"]
            }
        })
        for row, z_values, refp, augp in zip(test, test_z, p0.tolist(), p1.tolist()):
            oos_rows.append({
                "schemaVersion": 1,
                "candidate": "BASE_R2_PLUS_QUALITY_ADJUSTED_FORM_FIXED_SIDE_R3A5B",
                "season": row["season"],
                "gameId": row["gameId"],
                "gameDate": row["gameDate"],
                "selectedSide": row["selectedSide"],
                "selectedTeamId": row["selectedTeamId"],
                "selectedSideOutcome": row["outcome"],
                "rawBaseProbability": row["rawBaseProbability"],
                "referenceProbability": float(refp),
                "augmentedProbability": float(augp),
                "featureRaw": {name: float(row["factorRaw"][i]) for i, name in enumerate(FEATURE_NAMES)},
                "featureStandardizedFromPriorSeasonsOnly": {name: float(z_values[i]) for i, name in enumerate(FEATURE_NAMES)},
                "sideSwitchingAllowed": False,
                "fourFactorsCombined": False,
                "marketAttached": False
            })
        all_reference.extend(p0.tolist())
        all_augmented.extend(p1.tolist())
        all_outcomes.extend(int(v) for v in y.tolist())
        all_seasons.extend([target_season] * len(test))

    expected_oos = int(contract["population"]["expected_oos_target_rows"])
    if len(oos_rows) != expected_oos:
        raise RuntimeError(f"OOS row count mismatch {len(oos_rows)}")
    p0a = np.asarray(all_reference, dtype=np.float64)
    p1a = np.asarray(all_augmented, dtype=np.float64)
    ya = np.asarray(all_outcomes, dtype=np.float64)
    sa = np.asarray(all_seasons, dtype=np.int64)
    pooled0 = engine.metrics(p0a, ya)
    pooled1 = engine.metrics(p1a, ya)
    boot = engine.bootstrap_paired(sa, ya, p0a, p1a, int(contract["paired_uncertainty"]["replicates"]), int(contract["paired_uncertainty"]["seed"]))

    delta_brier = pooled1["brier"] - pooled0["brier"]
    delta_logloss = pooled1["logLoss"] - pooled0["logLoss"]
    delta_ece = pooled1["ece10"] - pooled0["ece10"]
    brier_directional = boot["brierAugmentedMinusReference"]["ci95Percentile"][1] < 0
    logloss_directional = boot["logLossAugmentedMinusReference"]["ci95Percentile"][1] < 0
    brier_seasons = sum(1 for fold in fold_results if fold["deltaAugmentedMinusReference"]["brier"] < 0)
    logloss_seasons = sum(1 for fold in fold_results if fold["deltaAugmentedMinusReference"]["logLoss"] < 0)
    ece_ok = delta_ece <= 0.010
    brier_path = bool(brier_directional and delta_logloss <= 0.005 and ece_ok and brier_seasons >= 3)
    logloss_path = bool(logloss_directional and delta_brier <= 0.002 and ece_ok and logloss_seasons >= 3)
    admitted = brier_path or logloss_path

    oos_rows.sort(key=lambda row: (row["season"], row["gameDate"], row["gameId"]))
    row_payload = ("\n".join(canonical(row) for row in oos_rows) + "\n").encode("utf-8")
    OUT_ROWS.write_bytes(row_payload)
    evidence = {
        "name": "WNBA_R3A5B_QUALITY_ADJUSTED_FORM_OOS_ABLATION_EVIDENCE_V1",
        "contract": {"path": str(CONTRACT), "status": contract["status"]},
        "runtime": {
            "numpyVersion": np.__version__,
            "reusedFrozenR3A4StatisticalEnginePath": str(ENGINE_PATH),
            "reusedEngineSha256": engine_sha,
            "featureCount": len(FEATURE_NAMES)
        },
        "inputCustody": {
            "r2ArtifactId": int(frozen["r2_artifact_id"]),
            "r2ArtifactZipSha256": sha256_bytes(r2_zip),
            "qualityFormArtifactId": int(frozen["quality_form_artifact_id"]),
            "qualityFormArtifactZipSha256": sha256_bytes(form_zip),
            "qualityFormRowsetSha256": sha256_bytes(form_bytes)
        },
        "population": {
            "joinedRows": len(joined),
            "oosRows": len(oos_rows),
            "exactOneToOneJoin": True,
            "identityMismatchCount": identity_mismatch,
            "rowsDroppedAfterJoin": 0
        },
        "referenceParity": {
            "requiredTolerance": 1e-9,
            "maxAbsoluteErrorAcrossFiveFolds": parity_max,
            "allFiveFoldsPass": parity_max <= 1e-9
        },
        "zeroVarianceEvents": zero_variance_events,
        "folds": fold_results,
        "pooledOos2021To2025": {
            "observations": len(oos_rows),
            "selectedSideAccuracyDescriptiveOnly": float(np.mean(ya)),
            "reference": pooled0,
            "augmented": pooled1,
            "deltaAugmentedMinusReference": {
                "brier": delta_brier,
                "logLoss": delta_logloss,
                "ece10": delta_ece,
                "meanPredictedMinusObserved": pooled1["meanPredictedMinusObserved"] - pooled0["meanPredictedMinusObserved"]
            }
        },
        "pairedUncertainty": boot,
        "frozenIncrementalValueGate": {
            "brierDirectional95UpperBelowZero": brier_directional,
            "logLossDirectional95UpperBelowZero": logloss_directional,
            "eceNonDegradationWithinPlus0_010": ece_ok,
            "brierPointImprovedTargetSeasons": brier_seasons,
            "logLossPointImprovedTargetSeasons": logloss_seasons,
            "brierPathSecondaryLogLossWithinPlus0_005": delta_logloss <= 0.005,
            "logLossPathSecondaryBrierWithinPlus0_002": delta_brier <= 0.002,
            "brierPathPass": brier_path,
            "logLossPathPass": logloss_path,
            "incrementalValuePass": admitted
        },
        "decision": "QUALITY_ADJUSTED_FORM_ADMITTED_TO_BOUNDED_R3_COMBINATION_RESEARCH" if admitted else "QUALITY_ADJUSTED_FORM_NOT_ADMITTED_BY_FROZEN_R3A5B_ABLATION",
        "scientificBoundaries": {
            "sideSwitchingPerformed": False,
            "eliteThresholdSearchPerformed": False,
            "coverageFilterSearchPerformed": False,
            "targetSeasonFeatureSelectionPerformed": False,
            "targetSeasonHyperparameterTuningPerformed": False,
            "postResultRowDroppingPerformed": False,
            "fourFactorsCombined": False,
            "marketFeatureUse": False,
            "productionMutation": False,
            "historicalResultIsIndependentCertification": False
        },
        "oosRowset": {"rows": len(oos_rows), "bytes": len(row_payload), "sha256": sha256_bytes(row_payload)},
        "nextGate": contract["next_gate_on_pass"] if admitted else contract["next_gate_on_fail"]
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
        "nextGate": evidence["nextGate"]
    }, indent=2))


if __name__ == "__main__":
    main()
