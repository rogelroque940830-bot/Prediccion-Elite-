#!/usr/bin/env python3
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import minimize

import nfl_r5h24_week_block_walkforward_calibration as h24
import nfl_r5h26_affine_logit_walkforward_calibration as r5h26


def fit_affine_stable(q: np.ndarray, y: np.ndarray, contract: dict) -> tuple[float, float, dict]:
    """Numerically stable implementation of the frozen R5H25 L-BFGS-B objective.

    This does not change the R5H25 statistical hypothesis, priors, bounds,
    starting point, walk-forward policy, features, or acceptance rubric.
    It supplies the exact analytic gradient and a larger line-search budget to
    prevent SciPy finite-difference line-search ABNORMAL terminations near the optimum.
    """
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
        raw_p = np.asarray(h24.sigmoid(alpha + beta * base_z), dtype=float)
        p = np.clip(raw_p, lo, hi)
        nll = -float(np.sum(target * np.log(p) + (1.0 - target) * np.log(1.0 - p)))
        penalty = 0.5 * ((alpha - a_mu) / a_sd) ** 2 + 0.5 * ((log_beta - b_mu) / b_sd) ** 2
        return nll + penalty

    def gradient(theta: np.ndarray) -> np.ndarray:
        alpha = float(theta[0])
        log_beta = float(theta[1])
        beta = math.exp(log_beta)
        raw_p = np.asarray(h24.sigmoid(alpha + beta * base_z), dtype=float)
        interior = (raw_p > lo) & (raw_p < hi)
        residual = np.where(interior, raw_p - target, 0.0)
        grad_alpha = float(np.sum(residual) + (alpha - a_mu) / (a_sd ** 2))
        grad_log_beta = float(np.sum(residual * (beta * base_z)) + (log_beta - b_mu) / (b_sd ** 2))
        return np.asarray([grad_alpha, grad_log_beta], dtype=float)

    x0 = np.asarray(algo["optimizerInitialPoint"], dtype=float)
    if x0.shape != (2,):
        raise RuntimeError("R5H26 optimizer initial point must contain alpha and log_beta")

    res = minimize(
        objective,
        x0=x0,
        jac=gradient,
        method="L-BFGS-B",
        bounds=[(alpha_lo, alpha_hi), (lb_lo, lb_hi)],
        options={"ftol": 1e-12, "gtol": 1e-9, "maxiter": 500, "maxls": 100},
    )
    if not res.success or not np.all(np.isfinite(res.x)):
        raise RuntimeError(f"R5H26 affine optimization failed after numeric stabilization: {res}")

    alpha = float(res.x[0])
    log_beta = float(res.x[1])
    return alpha, log_beta, {
        "beta": float(math.exp(log_beta)),
        "objective": float(res.fun),
        "iterations": int(getattr(res, "nit", 0)),
        "evaluations": int(getattr(res, "nfev", 0)),
    }


def main() -> None:
    print("NFL_R5H26_NUMERIC_STABILIZATION_ONLY_ANALYTIC_GRADIENT_LBFGSB")
    r5h26.fit_affine = fit_affine_stable
    r5h26.main()


if __name__ == "__main__":
    main()
