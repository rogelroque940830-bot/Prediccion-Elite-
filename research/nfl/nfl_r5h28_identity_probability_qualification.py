#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import chi2, norm

MODEL = "R5H28_FROZEN_IDENTITY_PROBABILITY_QUALIFICATION"
EXPECTED_SCHEMA = "courtedge-nfl-r5h27-identity-probability-qualification-contract.v1"
ROUTES = ("R5H8_CORE", "R5H21_LATE_DOWN")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


def sigmoid(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    out = np.empty_like(x)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out


def metrics(p: np.ndarray, y: np.ndarray) -> dict:
    p = np.clip(np.asarray(p, dtype=float), 1e-12, 1 - 1e-12)
    y = np.asarray(y, dtype=float)
    if len(p) != len(y) or len(y) == 0:
        raise RuntimeError("R5H28 invalid metric vectors")
    bins = np.linspace(0.0, 1.0, 6)
    bin_id = np.digitize(p, bins[1:-1], right=False)
    ece = 0.0
    for i in range(5):
        m = bin_id == i
        if np.any(m):
            ece += float(np.mean(m)) * abs(float(np.mean(p[m]) - np.mean(y[m])))
    return {
        "rows": int(len(y)),
        "wins": int(np.sum(y)),
        "losses": int(len(y) - np.sum(y)),
        "accuracy": float(np.mean(y)),
        "meanProbability": float(np.mean(p)),
        "brier": float(np.mean((p - y) ** 2)),
        "logLoss": float(-np.mean(y * np.log(p) + (1.0 - y) * np.log(1.0 - p))),
        "signedMeanCalibrationGap": float(np.mean(p) - np.mean(y)),
        "absoluteMeanCalibrationGap": float(abs(np.mean(p) - np.mean(y))),
        "ece5EqualWidth": float(ece),
    }


def calibration_in_large(p: np.ndarray, y: np.ndarray, critical_abs_z: float) -> dict:
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    variance = float(np.sum(p * (1.0 - p)))
    if not np.isfinite(variance) or variance <= 0:
        raise RuntimeError("R5H28 invalid Bernoulli variance for calibration-in-the-large")
    residual = float(np.sum(y - p))
    z = residual / math.sqrt(variance)
    return {
        "observedWins": int(np.sum(y)),
        "expectedWins": float(np.sum(p)),
        "residualWins": residual,
        "variance": variance,
        "z": float(z),
        "twoSidedPValue": float(2.0 * norm.sf(abs(z))),
        "criticalAbsZ": float(critical_abs_z),
        "pass": bool(abs(z) <= critical_abs_z),
    }


def affine_identity_lr(p: np.ndarray, y: np.ndarray, reject_below: float) -> dict:
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    y = np.asarray(y, dtype=float)
    z = logit(p)
    X = np.column_stack([np.ones(len(z), dtype=float), z])

    def nll(theta: np.ndarray) -> float:
        eta = X @ theta
        return float(np.sum(np.logaddexp(0.0, eta) - y * eta))

    theta = np.array([0.0, 1.0], dtype=float)
    for _ in range(100):
        eta = X @ theta
        phat = sigmoid(eta)
        w = phat * (1.0 - phat)
        grad = X.T @ (phat - y)
        hess = X.T @ (X * w[:, None])
        step = np.linalg.pinv(hess) @ grad
        if not np.all(np.isfinite(step)):
            raise RuntimeError("R5H28 non-finite affine LR Newton step")
        if float(np.linalg.norm(step)) < 1e-10:
            break
        old = nll(theta)
        scale = 1.0
        while scale > 1e-8 and nll(theta - scale * step) > old:
            scale *= 0.5
        theta = theta - scale * step

    alt_nll = nll(theta)
    identity_nll = nll(np.array([0.0, 1.0], dtype=float))
    lr = max(0.0, 2.0 * (identity_nll - alt_nll))
    p_value = float(chi2.sf(lr, 2))
    return {
        "identityAlpha": 0.0,
        "identityBeta": 1.0,
        "alternativeAlphaHat": float(theta[0]),
        "alternativeBetaHat": float(theta[1]),
        "identityNll": float(identity_nll),
        "alternativeNll": float(alt_nll),
        "likelihoodRatio": float(lr),
        "degreesOfFreedom": 2,
        "pValue": p_value,
        "rejectBelow": float(reject_below),
        "identityNotRejected": bool(p_value >= reject_below),
        "alternativeFitUsedForPrediction": False,
    }


def prior_mask(df: pd.DataFrame, season: int, week: int) -> pd.Series:
    return (df["season"] < season) | ((df["season"] == season) & (df["week"] < week))


def build_prequential(rows: pd.DataFrame, contract: dict) -> pd.DataFrame:
    cfg = contract["evaluationDesign"]
    min_prior = int(cfg["prequentialMinimumPriorRowsPerRoute"])
    prior_cfg = cfg["prequentialClimatologyPrior"]
    alpha = float(prior_cfg["alpha"])
    beta = float(prior_cfg["beta"])
    pieces = []
    for route in ROUTES:
        g = rows[rows.route.eq(route)].copy().sort_values(["season", "week", "game_id"], kind="stable")
        for (season, week), block in g.groupby(["season", "week"], sort=True):
            prior = g[prior_mask(g, int(season), int(week))]
            if len(prior) < min_prior:
                continue
            clim = (float(prior.selected_win.sum()) + alpha) / (float(len(prior)) + alpha + beta)
            b = block.copy()
            b["prior_route_rows"] = int(len(prior))
            b["climatology_probability"] = float(clim)
            pieces.append(b)
    if not pieces:
        raise RuntimeError("R5H28 produced no prequential rows")
    return pd.concat(pieces, ignore_index=True).sort_values(["season", "week", "game_id"], kind="stable")


def validate(contract: dict, rowset_path: Path, rows: pd.DataFrame) -> None:
    if contract.get("schemaVersion") != EXPECTED_SCHEMA:
        raise RuntimeError("R5H28 unexpected R5H27 contract schema")
    if not bool(contract.get("frozenBeforeR5H28Evaluation")):
        raise RuntimeError("R5H28 contract not frozen")
    identity = contract["identityProbability"]
    if int(identity["freeParameters"]) != 0 or bool(identity["fitPerformed"]):
        raise RuntimeError("R5H28 identity mapping drift")
    source = contract["sourceCustody"]
    actual_sha = sha256(rowset_path)
    if actual_sha != str(source["r5h22CalibrationRowsetSha256"]):
        raise RuntimeError(f"R5H28 R5H22 rowset SHA drift: {actual_sha}")
    if len(rows) != int(source["requiredRows"]):
        raise RuntimeError("R5H28 row-count drift")
    if int(rows.selected_win.sum()) != int(source["requiredWins"]):
        raise RuntimeError("R5H28 win-count drift")
    if int(len(rows) - rows.selected_win.sum()) != int(source["requiredLosses"]):
        raise RuntimeError("R5H28 loss-count drift")
    if rows.game_id.astype(str).duplicated().any():
        raise RuntimeError("R5H28 duplicate game ids")
    if not rows.reference_confidence.between(0.5, 1.0, inclusive="both").all():
        raise RuntimeError("R5H28 reference_confidence outside identity range")
    for route, exp in source["requiredRoutes"].items():
        g = rows[rows.route.eq(route)]
        got = (len(g), int(g.selected_win.sum()), int(len(g) - g.selected_win.sum()))
        want = (int(exp["rows"]), int(exp["wins"]), int(exp["losses"]))
        if got != want:
            raise RuntimeError(f"R5H28 route custody drift {route}: {got} != {want}")


def evaluate_group(g: pd.DataFrame, contract: dict) -> dict:
    q = g.reference_confidence.to_numpy(dtype=float)
    y = g.selected_win.to_numpy(dtype=float)
    stat = contract["statisticalQualification"]
    return {
        "raw": metrics(q, y),
        "calibrationInTheLarge": calibration_in_large(
            q, y, float(stat["calibrationInTheLarge"]["twoSidedCriticalAbsZ"])
        ),
        "identityAffineLikelihoodRatio": affine_identity_lr(
            q, y, float(stat["identityAffineLikelihoodRatio"]["rejectIdentityIfPValueBelow"])
        ),
    }


def season_diagnostics(rows: pd.DataFrame) -> pd.DataFrame:
    records = []
    for (route, season), g in rows.groupby(["route", "season"], sort=True):
        m = metrics(g.reference_confidence.to_numpy(dtype=float), g.selected_win.to_numpy(dtype=float))
        records.append({
            "route": route,
            "season": int(season),
            "rows": m["rows"],
            "wins": m["wins"],
            "losses": m["losses"],
            "accuracy": m["accuracy"],
            "mean_probability": m["meanProbability"],
            "signed_calibration_gap": m["signedMeanCalibrationGap"],
            "absolute_calibration_gap": m["absoluteMeanCalibrationGap"],
            "brier": m["brier"],
            "log_loss": m["logLoss"],
        })
    return pd.DataFrame(records)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5h22-dir", default="nfl-r5h22-output")
    ap.add_argument("--contract", default="research/nfl/R5H27_IDENTITY_PROBABILITY_QUALIFICATION_CONTRACT.json")
    ap.add_argument("--out-dir", default="nfl-r5h28-output")
    args = ap.parse_args()

    rowset_path = Path(args.r5h22_dir) / "nfl_r5h22_calibration_rowset.csv"
    contract_path = Path(args.contract)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if not rowset_path.exists() or not contract_path.exists():
        raise RuntimeError("R5H28 missing certified R5H22 rowset or R5H27 contract")

    contract = json.loads(contract_path.read_text())
    rows = pd.read_csv(rowset_path)
    required = ["game_id", "season", "week", "route", "reference_confidence", "selected_win"]
    missing = [c for c in required if c not in rows.columns]
    if missing:
        raise RuntimeError(f"R5H28 missing columns: {missing}")
    rows["selected_win"] = pd.to_numeric(rows["selected_win"], errors="raise").astype(int)
    validate(contract, rowset_path, rows)

    full = {"combined": evaluate_group(rows, contract)}
    for route in ROUTES:
        full[route] = evaluate_group(rows[rows.route.eq(route)], contract)

    pre = build_prequential(rows, contract)
    expected = contract["evaluationDesign"]["expectedPrequentialScoredRows"]
    if len(pre) != int(expected["combined"]):
        raise RuntimeError("R5H28 combined prequential row drift")
    preq = {}
    for key, g in [("combined", pre)] + [(route, pre[pre.route.eq(route)]) for route in ROUTES]:
        if key != "combined" and len(g) != int(expected[key]):
            raise RuntimeError(f"R5H28 prequential row drift for {key}")
        raw = metrics(g.reference_confidence.to_numpy(dtype=float), g.selected_win.to_numpy(dtype=float))
        clim = metrics(g.climatology_probability.to_numpy(dtype=float), g.selected_win.to_numpy(dtype=float))
        preq[key] = {
            "raw": raw,
            "climatology": clim,
            "rawMinusClimatology": {
                "brier": float(raw["brier"] - clim["brier"]),
                "logLoss": float(raw["logLoss"] - clim["logLoss"]),
            },
            "rawBrierLower": bool(raw["brier"] < clim["brier"]),
            "rawLogLossLower": bool(raw["logLoss"] < clim["logLoss"]),
        }

    stat = contract["statisticalQualification"]
    min_full = stat["minimumEvidence"]["fullRows"]
    min_preq = stat["minimumEvidence"]["prequentialRows"]
    gates = {}
    for key in ("combined",) + ROUTES:
        if key == "combined":
            evidence_ok = True
        else:
            evidence_ok = (
                full[key]["raw"]["rows"] >= int(min_full[key])
                and preq[key]["raw"]["rows"] >= int(min_preq[key])
            )
        gates[key] = {
            "minimumEvidence": bool(evidence_ok),
            "calibrationInTheLarge": bool(full[key]["calibrationInTheLarge"]["pass"]),
            "identityAffineNotRejected": bool(full[key]["identityAffineLikelihoodRatio"]["identityNotRejected"]),
            "rawBrierBeatsLeakageSafeClimatology": bool(preq[key]["rawBrierLower"]),
            "rawLogLossBeatsLeakageSafeClimatology": bool(preq[key]["rawLogLossLower"]),
        }

    passed = bool(all(all(v.values()) for v in gates.values()))
    rubric = contract["acceptanceRubric"]
    classification = str(rubric["passClassification"] if passed else rubric["failClassification"])

    season = season_diagnostics(rows)
    pre.to_csv(out / "nfl_r5h28_prequential_probability_comparison.csv", index=False)
    season.to_csv(out / "nfl_r5h28_season_diagnostics.csv", index=False)

    candidate = {
        "schemaVersion": "courtedge-nfl-r5h28-identity-probability-candidate.v1",
        "sport": "NFL",
        "mapping": "p_identity = reference_confidence",
        "freeParameters": 0,
        "historicalQualification": classification,
        "historicallyQualified": passed,
        "crossSportCandidateAuthorized": passed,
        "prospective2026MonitoringRequired": bool(contract["prospective2026Policy"]["monitoringIsRequired"]),
        "target2026OutcomesUsedToDefineMapping": False,
        "selectionRulesChanged": False,
        "weightsChanged": False,
        "thresholdsChanged": False,
        "productionCodeTouched": False,
    }
    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "contractSchema": contract["schemaVersion"],
        "contractFrozenBeforeEvaluation": True,
        "r5h22RowsetSha256": sha256(rowset_path),
        "rows": int(len(rows)),
        "wins": int(rows.selected_win.sum()),
        "losses": int(len(rows) - rows.selected_win.sum()),
        "fullCustodyEvaluation": full,
        "prequentialSkillEvaluation": preq,
        "gates": gates,
        "allStatisticalGatesPassed": passed,
        "classification": classification,
        "identityProbabilityHistoricallyQualified": passed,
        "crossSportCalibrationCandidateAuthorized": passed,
        "globalEliteRankerStillBlocked": True,
        "nextAction": (
            "FREEZE_NFL_IDENTITY_PROBABILITY_CONTRACT_AND_ATTACH_ROUTE_UNCERTAINTY_FOR_CROSS_SPORT_INPUT"
            if passed
            else "RETAIN_REFERENCE_CONFIDENCE_AS_UNCALIBRATED_SCORE_AND_FREEZE_NEXT_PROBABILITY_HYPOTHESIS"
        ),
    }
    audit = {
        "sourceRowsetCustody": "PASS_EXACT_R5H22_SHA256",
        "identityMapping": "ZERO_PARAMETER_NO_FIT",
        "historicalHitRateSubstitutedForProbability": False,
        "prequentialClimatologyBoundary": "PASS_PRIOR_WEEKS_ONLY",
        "sameWeekOutcomeUsedByBaseline": False,
        "futureOutcomeUsedByBaseline": False,
        "affineAlternativeUsedOnlyForIdentityHypothesisTest": True,
        "affineAlternativeUsedForPrediction": False,
        "rawMetricsKnownBeforeRubricFreeze": bool(contract["antiTuningDisclosure"]["rawBaselineMetricsWereKnownBeforeThisRubricWasFrozen"]),
        "gridSearch": "NONE",
        "featureSearch": "NONE",
        "marketFeatures": "NONE",
        "crossRoutePoolingForPrediction": "NONE",
        "crossSportPooling": "NONE",
        "productionChange": "NONE",
        "globalRanker": "BLOCKED",
    }

    (out / "nfl_r5h28_identity_probability_candidate.json").write_text(json.dumps(candidate, indent=2, sort_keys=True))
    (out / "nfl_r5h28_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True))
    (out / "nfl_r5h28_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True))
    print("NFL_R5H28_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H28_COMPLETE")


if __name__ == "__main__":
    main()
