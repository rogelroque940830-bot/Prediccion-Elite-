#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize

import nfl_r5h24_week_block_walkforward_calibration as h24

MODEL = "R5H26_AFFINE_LOGIT_WEEK_BLOCK_WALK_FORWARD_CALIBRATION"
EXPECTED_CONTRACT_SCHEMA = "courtedge-nfl-r5h25-affine-logit-calibration-contract.v1"
ROUTES = ("R5H8_CORE", "R5H21_LATE_DOWN")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fit_affine(q: np.ndarray, y: np.ndarray, contract: dict) -> tuple[float, float, dict]:
    algo = contract["algorithm"]
    lo, hi = [float(v) for v in algo["probabilityClip"]]
    alpha_lo, alpha_hi = [float(v) for v in algo["alphaBounds"]]
    lb_lo, lb_hi = [float(v) for v in algo["logBetaBounds"]]
    a_mu, a_sd = float(algo["alphaPrior"]["mean"]), float(algo["alphaPrior"]["std"])
    b_mu, b_sd = float(algo["logBetaPrior"]["mean"]), float(algo["logBetaPrior"]["std"])
    if a_sd <= 0 or b_sd <= 0:
        raise RuntimeError("R5H26 invalid prior standard deviation")

    base_z = np.asarray(h24.logit(np.asarray(q, dtype=float), lo, hi), dtype=float)
    target = np.asarray(y, dtype=float)

    def objective(theta: np.ndarray) -> float:
        alpha = float(theta[0])
        log_beta = float(theta[1])
        beta = math.exp(log_beta)
        p = np.clip(h24.sigmoid(alpha + beta * base_z), lo, hi)
        nll = -float(np.sum(target * np.log(p) + (1.0 - target) * np.log(1.0 - p)))
        penalty = 0.5 * ((alpha - a_mu) / a_sd) ** 2 + 0.5 * ((log_beta - b_mu) / b_sd) ** 2
        return nll + penalty

    x0 = np.asarray(algo["optimizerInitialPoint"], dtype=float)
    if x0.shape != (2,):
        raise RuntimeError("R5H26 optimizer initial point must contain alpha and log_beta")
    res = minimize(
        objective,
        x0=x0,
        method="L-BFGS-B",
        bounds=[(alpha_lo, alpha_hi), (lb_lo, lb_hi)],
        options={"ftol": 1e-12, "gtol": 1e-9, "maxiter": 500},
    )
    if not res.success or not np.all(np.isfinite(res.x)):
        raise RuntimeError(f"R5H26 affine optimization failed: {res}")
    alpha = float(res.x[0])
    log_beta = float(res.x[1])
    return alpha, log_beta, {
        "beta": float(math.exp(log_beta)),
        "objective": float(res.fun),
        "iterations": int(getattr(res, "nit", 0)),
        "evaluations": int(getattr(res, "nfev", 0)),
    }


def predict(q: np.ndarray, alpha: float, log_beta: float, contract: dict) -> np.ndarray:
    lo, hi = [float(v) for v in contract["algorithm"]["probabilityClip"]]
    beta = math.exp(float(log_beta))
    z = np.asarray(h24.logit(np.asarray(q, dtype=float), lo, hi), dtype=float)
    return np.clip(h24.sigmoid(float(alpha) + beta * z), lo, hi)


def validate_contract(contract: dict, rowset_path: Path, rows: pd.DataFrame) -> None:
    if contract.get("schemaVersion") != EXPECTED_CONTRACT_SCHEMA:
        raise RuntimeError("R5H26 unexpected R5H25 contract schema")
    if not bool(contract.get("frozenBeforeR5H26Fit")):
        raise RuntimeError("R5H26 contract was not frozen before fit")
    algo = contract["algorithm"]
    if int(algo["freeParametersPerRoute"]) != 2:
        raise RuntimeError("R5H26 parameter-count drift")
    if bool(algo["hyperparameterSearchAllowed"]) or bool(algo["featureSearchAllowed"]):
        raise RuntimeError("R5H26 search is forbidden by frozen contract")

    source = contract["sourceCustody"]
    actual_sha = file_sha256(rowset_path)
    expected_sha = str(source["r5h22CalibrationRowsetSha256"])
    if actual_sha != expected_sha:
        raise RuntimeError(f"R5H26 R5H22 rowset custody drift: {actual_sha} != {expected_sha}")
    if len(rows) != int(source["requiredRows"]):
        raise RuntimeError("R5H26 row-count drift")
    if int(rows.selected_win.sum()) != int(source["requiredWins"]):
        raise RuntimeError("R5H26 win-count drift")
    if int(len(rows) - rows.selected_win.sum()) != int(source["requiredLosses"]):
        raise RuntimeError("R5H26 loss-count drift")
    if rows.game_id.astype(str).duplicated().any():
        raise RuntimeError("R5H26 duplicate game ids")
    for route, exp in source["requiredRoutes"].items():
        g = rows[rows.route.eq(route)]
        got = (len(g), int(g.selected_win.sum()), int(len(g) - g.selected_win.sum()))
        expected = (int(exp["rows"]), int(exp["wins"]), int(exp["losses"]))
        if got != expected:
            raise RuntimeError(f"R5H26 route custody drift {route}: {got} != {expected}")


def build_walk_forward(rows: pd.DataFrame, contract: dict) -> tuple[pd.DataFrame, list[dict]]:
    min_prior = int(contract["walkForward"]["minimumPriorRowsPerRoute"])
    out_rows: list[pd.DataFrame] = []
    fit_rows: list[dict] = []

    for route in ROUTES:
        route_df = rows[rows.route.eq(route)].copy().sort_values(["season", "week", "game_id"], kind="stable").reset_index(drop=True)
        for (season, week), block in route_df.groupby(["season", "week"], sort=True):
            prior = route_df[h24.week_prior_mask(route_df, int(season), int(week))].copy()
            active = len(prior) >= min_prior
            alpha = log_beta = None
            info = None
            if active:
                alpha, log_beta, info = fit_affine(
                    prior.reference_confidence.to_numpy(dtype=float),
                    prior.selected_win.to_numpy(dtype=float),
                    contract,
                )
                calibrated = predict(block.reference_confidence.to_numpy(dtype=float), alpha, log_beta, contract)
            else:
                calibrated = np.full(len(block), np.nan, dtype=float)
            beta = math.exp(log_beta) if log_beta is not None else None
            fit_rows.append({
                "route": route,
                "target_season": int(season),
                "target_week": int(week),
                "prior_rows": int(len(prior)),
                "prior_wins": int(prior.selected_win.sum()) if len(prior) else 0,
                "prior_losses": int(len(prior) - prior.selected_win.sum()) if len(prior) else 0,
                "active": bool(active),
                "alpha": float(alpha) if alpha is not None else None,
                "log_beta": float(log_beta) if log_beta is not None else None,
                "beta": float(beta) if beta is not None else None,
                "fit_objective": float(info["objective"]) if info else None,
                "optimizer_iterations": int(info["iterations"]) if info else None,
                "optimizer_evaluations": int(info["evaluations"]) if info else None,
            })
            b = block.copy()
            b["walk_forward_active"] = bool(active)
            b["prior_route_rows"] = int(len(prior))
            b["alpha_route"] = float(alpha) if alpha is not None else np.nan
            b["log_beta_route"] = float(log_beta) if log_beta is not None else np.nan
            b["beta_route"] = float(beta) if beta is not None else np.nan
            b["calibrated_probability"] = calibrated
            out_rows.append(b)

    if not out_rows:
        raise RuntimeError("R5H26 produced no rows")
    out = pd.concat(out_rows, ignore_index=True).sort_values(["season", "week", "game_id"], kind="stable").reset_index(drop=True)
    return out, fit_rows


def assert_exact_comparability(contract: dict, combined: dict, by_route: dict) -> None:
    exp_rows = contract["walkForward"]["expectedScoredRowsForExactComparability"]
    if int(combined["activeRows"]) != int(exp_rows["combined"]):
        raise RuntimeError("R5H26 combined active-row drift")
    for route in ROUTES:
        if int(by_route[route]["activeRows"]) != int(exp_rows[route]):
            raise RuntimeError(f"R5H26 active-row drift for {route}")

    eval_cfg = contract["evaluation"]
    if not bool(eval_cfg["requireExactR5H24RawBaselineReproduction"]):
        return
    tol = float(eval_cfg["rawBaselineTolerance"])
    expected = eval_cfg["expectedRawBaseline"]
    observed = {"combined": combined["raw"], **{r: by_route[r]["raw"] for r in ROUTES}}
    for key, exp in expected.items():
        got = observed[key]
        if int(got["rows"]) != int(exp["rows"]):
            raise RuntimeError(f"R5H26 raw-baseline row mismatch for {key}")
        for metric in ("brier", "logLoss"):
            if abs(float(got[metric]) - float(exp[metric])) > tol:
                raise RuntimeError(f"R5H26 raw-baseline drift for {key}.{metric}")


def final_fit(rows: pd.DataFrame, contract: dict) -> dict:
    result = {}
    for route in ROUTES:
        g = rows[rows.route.eq(route)].copy()
        alpha, log_beta, info = fit_affine(
            g.reference_confidence.to_numpy(dtype=float),
            g.selected_win.to_numpy(dtype=float),
            contract,
        )
        result[route] = {
            "trainingRows": int(len(g)),
            "trainingWins": int(g.selected_win.sum()),
            "trainingLosses": int(len(g) - g.selected_win.sum()),
            "alpha": float(alpha),
            "logBeta": float(log_beta),
            "beta": float(info["beta"]),
            "fitObjective": float(info["objective"]),
            "optimizerIterations": int(info["iterations"]),
            "optimizerEvaluations": int(info["evaluations"]),
            "formula": "sigmoid(alpha + beta*logit(reference_confidence))",
        }
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5h22-dir", default="nfl-r5h22-output")
    ap.add_argument("--contract", default="research/nfl/R5H25_AFFINE_LOGIT_CALIBRATION_CONTRACT.json")
    ap.add_argument("--out-dir", default="nfl-r5h26-output")
    a = ap.parse_args()

    rowset_path = Path(a.r5h22_dir) / "nfl_r5h22_calibration_rowset.csv"
    contract_path = Path(a.contract)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if not rowset_path.exists() or not contract_path.exists():
        raise RuntimeError("R5H26 missing required R5H22 rowset or R5H25 contract")

    contract = json.loads(contract_path.read_text())
    rows = pd.read_csv(rowset_path)
    required = ["game_id", "season", "week", "route", "reference_confidence", "selected_win"]
    missing = [c for c in required if c not in rows.columns]
    if missing:
        raise RuntimeError(f"R5H26 missing required columns {missing}")
    rows.selected_win = pd.to_numeric(rows.selected_win, errors="raise").astype(int)
    validate_contract(contract, rowset_path, rows)

    walk, fit_history = build_walk_forward(rows, contract)
    by_route = {route: h24.compare_metrics(walk[walk.route.eq(route)]) for route in ROUTES}
    combined = h24.compare_metrics(walk)
    assert_exact_comparability(contract, combined, by_route)

    rubric = contract["acceptanceRubric"]
    min_rows = int(contract["evaluation"]["minimumWalkForwardScoredRowsPerRoute"])
    route_gates = {}
    for route in ROUTES:
        m = by_route[route]
        d = m["calibratedMinusRaw"]
        enough = m["activeRows"] >= min_rows
        route_gates[route] = {
            "minimumScoredRows": bool(enough),
            "brierWithinTolerance": bool(enough and d["brier"] is not None and d["brier"] <= float(rubric["perRouteBrierMaxDegradation"])),
            "logLossWithinTolerance": bool(enough and d["logLoss"] is not None and d["logLoss"] <= float(rubric["perRouteLogLossMaxDegradation"])),
            "meanCalibrationGapWithinTolerance": bool(enough and d["absoluteMeanCalibrationGap"] is not None and d["absoluteMeanCalibrationGap"] <= float(rubric["perRouteAbsoluteMeanCalibrationGapMaxDegradation"])),
        }
    combined_gates = {
        "brierImproves": bool(combined["calibrated"]["brier"] < combined["raw"]["brier"]),
        "logLossImproves": bool(combined["calibrated"]["logLoss"] < combined["raw"]["logLoss"]),
    }
    passed = bool(all(all(g.values()) for g in route_gates.values()) and all(combined_gates.values()))
    classification = str(rubric["passClassification"] if passed else rubric["failClassification"])

    final2026 = final_fit(rows, contract)
    walk.to_csv(out / "nfl_r5h26_walk_forward_predictions.csv", index=False)
    pd.DataFrame(fit_history).to_csv(out / "nfl_r5h26_weekly_fit_history.csv", index=False)

    candidate = {
        "schemaVersion": "courtedge-nfl-r5h26-2026-affine-logit-calibrator.v1",
        "sport": "NFL",
        "targetSeason": 2026,
        "algorithm": contract["algorithm"],
        "routes": final2026,
        "walkForwardClassification": classification,
        "walkForwardGatePassed": passed,
        "crossSportCandidateAuthorized": passed,
        "target2026OutcomesUsed": False,
        "selectionRulesChanged": False,
        "productionCodeTouched": False,
    }
    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "contractSchema": contract["schemaVersion"],
        "contractFrozenBeforeFit": True,
        "r5h22RowsetSha256": file_sha256(rowset_path),
        "rows": int(len(rows)),
        "byRoute": by_route,
        "combined": combined,
        "routeGates": route_gates,
        "combinedGates": combined_gates,
        "walkForwardGatePassed": passed,
        "classification": classification,
        "final2026Fit": final2026,
        "crossSportCalibrationCandidateAuthorized": passed,
        "globalEliteRankerStillBlocked": True,
        "nextAction": (
            "CERTIFY_NFL_AFFINE_LOGIT_PROBABILITY_CONTRACT_FOR_CROSS_SPORT_COMPARISON"
            if passed else
            "RETAIN_RAW_REFERENCE_CONFIDENCE_AND_FREEZE_NEXT_CALIBRATION_HYPOTHESIS_BEFORE_TEST"
        ),
    }
    audit = {
        "sourceRowsetCustody": "PASS_R5H22_SHA256_LOCKED",
        "r5h25ContractFrozenBeforeFit": True,
        "rawBaselineCustody": "PASS_EXACT_R5H24_ACTIVE_ROWS_AND_RAW_PROPER_SCORES",
        "routeSeparation": "PASS_NO_PARAMETER_POOLING",
        "walkForwardBoundary": "PASS_PRIOR_WEEKS_ONLY",
        "sameWeekOutcomeCalibration": "NONE",
        "futureOutcomeCalibration": "NONE",
        "marketCalibrationFeatures": "NONE",
        "hyperparameterSearch": "NONE",
        "featureSearch": "NONE",
        "crossSportPooling": "NONE",
        "selectionRuleChanges": "NONE",
        "productionCodeTouched": False,
    }
    (out / "nfl_r5h26_2026_calibrator_candidate.json").write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h26_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h26_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H26_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H26_COMPLETE")


if __name__ == "__main__":
    main()
