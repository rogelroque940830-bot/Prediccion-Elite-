#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar

MODEL = "R5H24_WEEK_BLOCK_WALK_FORWARD_CALIBRATION"
EXPECTED_CONTRACT_SCHEMA = "courtedge-nfl-r5h23-calibration-contract.v1"
ROUTES = ("R5H8_CORE", "R5H21_LATE_DOWN")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sigmoid(z: np.ndarray | float) -> np.ndarray | float:
    x = np.asarray(z, dtype=float)
    out = np.where(x >= 0, 1.0 / (1.0 + np.exp(-x)), np.exp(x) / (1.0 + np.exp(x)))
    if np.ndim(z) == 0:
        return float(out)
    return out


def logit(p: np.ndarray | float, lo: float, hi: float) -> np.ndarray | float:
    x = np.clip(np.asarray(p, dtype=float), lo, hi)
    z = np.log(x / (1.0 - x))
    if np.ndim(p) == 0:
        return float(z)
    return z


def fit_delta(q: np.ndarray, y: np.ndarray, contract: dict) -> tuple[float, dict]:
    algo = contract["algorithm"]
    lo, hi = [float(v) for v in algo["probabilityClip"]]
    d_lo, d_hi = [float(v) for v in algo["deltaBounds"]]
    prior_mean = float(algo["normalPriorMean"])
    prior_std = float(algo["normalPriorStd"])
    if prior_std <= 0:
        raise RuntimeError("R5H24 invalid calibration prior std")

    base_z = logit(np.asarray(q, dtype=float), lo, hi)
    target = np.asarray(y, dtype=float)

    def objective(delta: float) -> float:
        p = np.clip(sigmoid(base_z + float(delta)), lo, hi)
        nll = -float(np.sum(target * np.log(p) + (1.0 - target) * np.log(1.0 - p)))
        prior_penalty = 0.5 * ((float(delta) - prior_mean) / prior_std) ** 2
        return nll + prior_penalty

    res = minimize_scalar(objective, method="bounded", bounds=(d_lo, d_hi), options={"xatol": 1e-12})
    if not res.success or not math.isfinite(float(res.x)):
        raise RuntimeError(f"R5H24 delta optimization failed: {res}")
    delta = float(res.x)
    return delta, {"objective": float(res.fun), "iterations": int(res.nfev)}


def predict(q: np.ndarray, delta: float, contract: dict) -> np.ndarray:
    lo, hi = [float(v) for v in contract["algorithm"]["probabilityClip"]]
    return np.clip(sigmoid(logit(np.asarray(q, dtype=float), lo, hi) + float(delta)), lo, hi)


def ece_equal_width(y: np.ndarray, p: np.ndarray, bins: int = 5) -> float:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    edges = np.linspace(0.0, 1.0, int(bins) + 1)
    total = len(y)
    if total == 0:
        return float("nan")
    ece = 0.0
    for i in range(int(bins)):
        if i == bins - 1:
            mask = (p >= edges[i]) & (p <= edges[i + 1])
        else:
            mask = (p >= edges[i]) & (p < edges[i + 1])
        n = int(mask.sum())
        if n:
            ece += (n / total) * abs(float(p[mask].mean()) - float(y[mask].mean()))
    return float(ece)


def proper_metrics(frame: pd.DataFrame, prob_col: str) -> dict:
    if frame.empty:
        return {
            "rows": 0,
            "wins": 0,
            "losses": 0,
            "accuracy": None,
            "meanProbability": None,
            "brier": None,
            "logLoss": None,
            "absoluteMeanCalibrationGap": None,
            "ece5EqualWidth": None,
        }
    y = frame.selected_win.to_numpy(dtype=float)
    p = np.clip(frame[prob_col].to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    wins = int(y.sum())
    n = int(len(y))
    return {
        "rows": n,
        "wins": wins,
        "losses": n - wins,
        "accuracy": float(wins / n),
        "meanProbability": float(p.mean()),
        "brier": float(np.mean((p - y) ** 2)),
        "logLoss": float(-np.mean(y * np.log(p) + (1.0 - y) * np.log(1.0 - p))),
        "absoluteMeanCalibrationGap": float(abs(p.mean() - y.mean())),
        "ece5EqualWidth": ece_equal_width(y, p, 5),
    }


def validate_contract(contract: dict, rowset_path: Path, rows: pd.DataFrame) -> None:
    if contract.get("schemaVersion") != EXPECTED_CONTRACT_SCHEMA:
        raise RuntimeError("R5H24 unexpected R5H23 contract schema")
    if not bool(contract.get("frozenBeforeCalibrationFit")):
        raise RuntimeError("R5H24 contract was not declared frozen before fit")
    expected_sha = str(contract["sourceCustody"]["r5h22CalibrationRowsetSha256"])
    actual_sha = file_sha256(rowset_path)
    if actual_sha != expected_sha:
        raise RuntimeError(f"R5H24 R5H22 rowset custody drift: {actual_sha} != {expected_sha}")

    source = contract["sourceCustody"]
    if len(rows) != int(source["requiredRows"]):
        raise RuntimeError("R5H24 R5H22 row count drifted")
    if int(rows.selected_win.sum()) != int(source["requiredWins"]):
        raise RuntimeError("R5H24 R5H22 win count drifted")
    if int(len(rows) - rows.selected_win.sum()) != int(source["requiredLosses"]):
        raise RuntimeError("R5H24 R5H22 loss count drifted")
    if rows.game_id.astype(str).duplicated().any():
        raise RuntimeError("R5H24 duplicate game ids in certified rowset")

    for route, exp in source["requiredRoutes"].items():
        g = rows[rows.route.eq(route)]
        got = (len(g), int(g.selected_win.sum()), int(len(g) - g.selected_win.sum()))
        expected = (int(exp["rows"]), int(exp["wins"]), int(exp["losses"]))
        if got != expected:
            raise RuntimeError(f"R5H24 route custody drift {route}: {got} != {expected}")


def week_prior_mask(frame: pd.DataFrame, season: int, week: int) -> np.ndarray:
    s = frame.season.to_numpy(dtype=int)
    w = frame.week.to_numpy(dtype=int)
    return (s < int(season)) | ((s == int(season)) & (w < int(week)))


def build_walk_forward(rows: pd.DataFrame, contract: dict) -> tuple[pd.DataFrame, list[dict]]:
    min_prior = int(contract["walkForward"]["minimumPriorRowsPerRoute"])
    out_rows = []
    fit_rows: list[dict] = []

    for route in ROUTES:
        route_df = rows[rows.route.eq(route)].copy().sort_values(["season", "week", "game_id"], kind="stable").reset_index(drop=True)
        for (season, week), block in route_df.groupby(["season", "week"], sort=True):
            prior = route_df[week_prior_mask(route_df, int(season), int(week))].copy()
            active = len(prior) >= min_prior
            delta = None
            fit_info = None
            if active:
                delta, fit_info = fit_delta(
                    prior.reference_confidence.to_numpy(dtype=float),
                    prior.selected_win.to_numpy(dtype=float),
                    contract,
                )
                calibrated = predict(block.reference_confidence.to_numpy(dtype=float), delta, contract)
            else:
                calibrated = np.full(len(block), np.nan, dtype=float)

            fit_rows.append({
                "route": route,
                "target_season": int(season),
                "target_week": int(week),
                "prior_rows": int(len(prior)),
                "prior_wins": int(prior.selected_win.sum()) if len(prior) else 0,
                "prior_losses": int(len(prior) - prior.selected_win.sum()) if len(prior) else 0,
                "active": bool(active),
                "delta": float(delta) if delta is not None else None,
                "fit_objective": float(fit_info["objective"]) if fit_info else None,
                "optimizer_evaluations": int(fit_info["iterations"]) if fit_info else None,
            })

            block = block.copy()
            block["walk_forward_active"] = bool(active)
            block["prior_route_rows"] = int(len(prior))
            block["delta_route"] = float(delta) if delta is not None else np.nan
            block["calibrated_probability"] = calibrated
            out_rows.append(block)

    if not out_rows:
        raise RuntimeError("R5H24 produced no walk-forward rows")
    out = pd.concat(out_rows, ignore_index=True).sort_values(["season", "week", "game_id"], kind="stable").reset_index(drop=True)
    return out, fit_rows


def compare_metrics(frame: pd.DataFrame) -> dict:
    active = frame[frame.walk_forward_active.astype(bool)].copy()
    raw = proper_metrics(active, "reference_confidence")
    cal = proper_metrics(active, "calibrated_probability")
    if not active.empty:
        delta = {
            "brier": float(cal["brier"] - raw["brier"]),
            "logLoss": float(cal["logLoss"] - raw["logLoss"]),
            "absoluteMeanCalibrationGap": float(
                cal["absoluteMeanCalibrationGap"] - raw["absoluteMeanCalibrationGap"]
            ),
            "ece5EqualWidth": float(cal["ece5EqualWidth"] - raw["ece5EqualWidth"]),
        }
    else:
        delta = {"brier": None, "logLoss": None, "absoluteMeanCalibrationGap": None, "ece5EqualWidth": None}
    return {"activeRows": int(len(active)), "raw": raw, "calibrated": cal, "calibratedMinusRaw": delta}


def final_fit(rows: pd.DataFrame, contract: dict) -> dict:
    result = {}
    for route in ROUTES:
        g = rows[rows.route.eq(route)].copy()
        delta, info = fit_delta(
            g.reference_confidence.to_numpy(dtype=float),
            g.selected_win.to_numpy(dtype=float),
            contract,
        )
        result[route] = {
            "trainingRows": int(len(g)),
            "trainingWins": int(g.selected_win.sum()),
            "trainingLosses": int(len(g) - g.selected_win.sum()),
            "delta": float(delta),
            "fitObjective": float(info["objective"]),
            "optimizerEvaluations": int(info["iterations"]),
            "formula": "sigmoid(logit(reference_confidence)+delta)",
        }
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5h22-dir", default="nfl-r5h22-output")
    ap.add_argument("--contract", default="research/nfl/R5H23_CALIBRATION_CONTRACT.json")
    ap.add_argument("--out-dir", default="nfl-r5h24-output")
    a = ap.parse_args()

    r5h22 = Path(a.r5h22_dir)
    contract_path = Path(a.contract)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    rowset_path = r5h22 / "nfl_r5h22_calibration_rowset.csv"
    if not rowset_path.exists() or not contract_path.exists():
        raise RuntimeError("R5H24 missing required R5H22 rowset or R5H23 contract")

    contract = json.loads(contract_path.read_text())
    rows = pd.read_csv(rowset_path)
    required = ["game_id", "season", "week", "route", "reference_confidence", "selected_win"]
    missing = [c for c in required if c not in rows.columns]
    if missing:
        raise RuntimeError(f"R5H24 missing required columns {missing}")
    rows.selected_win = pd.to_numeric(rows.selected_win, errors="raise").astype(int)
    validate_contract(contract, rowset_path, rows)

    walk, fit_history = build_walk_forward(rows, contract)
    by_route = {route: compare_metrics(walk[walk.route.eq(route)]) for route in ROUTES}
    combined = compare_metrics(walk)

    rubric = contract["acceptanceRubric"]
    eval_cfg = contract["evaluation"]
    min_rows = int(eval_cfg["minimumWalkForwardScoredRowsPerRoute"])
    route_gates = {}
    for route in ROUTES:
        m = by_route[route]
        d = m["calibratedMinusRaw"]
        enough = m["activeRows"] >= min_rows
        route_gates[route] = {
            "minimumScoredRows": bool(enough),
            "brierWithinTolerance": bool(enough and d["brier"] is not None and d["brier"] <= float(rubric["perRouteBrierMaxDegradation"])),
            "logLossWithinTolerance": bool(enough and d["logLoss"] is not None and d["logLoss"] <= float(rubric["perRouteLogLossMaxDegradation"])),
            "meanCalibrationGapWithinTolerance": bool(
                enough
                and d["absoluteMeanCalibrationGap"] is not None
                and d["absoluteMeanCalibrationGap"] <= float(rubric["perRouteAbsoluteMeanCalibrationGapMaxDegradation"])
            ),
        }

    combined_gates = {
        "brierImproves": bool(
            combined["calibrated"]["brier"] is not None
            and combined["raw"]["brier"] is not None
            and combined["calibrated"]["brier"] < combined["raw"]["brier"]
        ),
        "logLossImproves": bool(
            combined["calibrated"]["logLoss"] is not None
            and combined["raw"]["logLoss"] is not None
            and combined["calibrated"]["logLoss"] < combined["raw"]["logLoss"]
        ),
    }
    passed = bool(
        all(all(g.values()) for g in route_gates.values())
        and all(combined_gates.values())
    )
    classification = (
        str(rubric["passClassification"])
        if passed
        else str(rubric["failClassification"])
    )

    # This fit occurs only after the frozen walk-forward evaluation above. It is the
    # 2026 candidate fit; authorization is conditional on the frozen acceptance rubric.
    final2026 = final_fit(rows, contract)

    predictions_path = out / "nfl_r5h24_walk_forward_predictions.csv"
    fits_path = out / "nfl_r5h24_weekly_fit_history.csv"
    walk.to_csv(predictions_path, index=False)
    pd.DataFrame(fit_history).to_csv(fits_path, index=False)

    candidate = {
        "schemaVersion": "courtedge-nfl-r5h24-2026-calibrator.v1",
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
            "CERTIFY_NFL_CALIBRATED_PROBABILITY_CONTRACT_FOR_CROSS_SPORT_COMPARISON"
            if passed
            else "TEST_NEXT_PREDECLARED_CALIBRATION_HYPOTHESIS_WITHOUT_CHANGING_ELITE_SELECTIONS"
        ),
    }
    audit = {
        "sourceRowsetCustody": "PASS_R5H22_SHA256_LOCKED",
        "routeSeparation": "PASS_NO_PARAMETER_POOLING",
        "walkForwardBoundary": "PASS_PRIOR_WEEKS_ONLY",
        "sameWeekOutcomeCalibration": "NONE",
        "futureOutcomeCalibration": "NONE",
        "marketCalibrationFeatures": "NONE",
        "hyperparameterSearch": "NONE",
        "featureSearch": "NONE",
        "selectionRuleChanges": "NONE",
        "crossSportPooling": "NONE",
        "productionCodeTouched": False,
    }

    (out / "nfl_r5h24_2026_calibrator_candidate.json").write_text(
        json.dumps(candidate, indent=2, sort_keys=True) + "\n"
    )
    (out / "nfl_r5h24_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h24_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H24_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H24_COMPLETE")


if __name__ == "__main__":
    main()
