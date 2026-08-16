#!/usr/bin/env python3
"""Pre-outcome V66 custody runner with one frozen zero-variance standardization correction.

This wrapper does not alter V62 source semantics or V66 features. It only applies the
predeclared correction frozen in research/p0-step12v66-preoutcome-zero-variance-correction.json:
a finite, non-empty 2022 training component whose raw standard deviation is exactly zero
uses effective scale 1.0, leaving its standardized contribution at zero.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


def load_custody_module():
    path = Path(__file__).with_name("p0-step12v66-game-horizon-exposure-custody.py")
    spec = importlib.util.spec_from_file_location("p0_step12v66_custody", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V66_CUSTODY_MODULE_LOAD_FAILED")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def corrected_quality_scaler(mod, raw):
    vals = {k: [] for k in mod.QUALITY_KEYS}
    for (season, _), q in raw.items():
        if season != "2022":
            continue
        for side in ("home", "away"):
            z = q.get(side)
            if z is None:
                continue
            for key in mod.QUALITY_KEYS:
                if mod.finite(z.get(key)):
                    vals[key].append(float(z[key]))

    params = {}
    for key in mod.QUALITY_KEYS:
        a = mod.np.asarray(vals[key], dtype=float)
        if len(a) == 0:
            raise SystemExit(f"V66_QUALITY_TRAINING_EMPTY:{key}")
        mean = float(mod.np.mean(a))
        raw_scale = float(mod.np.std(a))
        if not mod.finite(raw_scale) or raw_scale < 0.0:
            raise SystemExit(f"V66_QUALITY_TRAINING_SCALE_INVALID:{key}:{raw_scale}")
        zero_variance = raw_scale == 0.0
        effective_scale = 1.0 if zero_variance else raw_scale
        params[key] = {
            "mean": mean,
            "scale": effective_scale,
            "rawScale": raw_scale,
            "zeroVarianceTraining": zero_variance,
            "n": int(len(a)),
        }
    return params


def main():
    mod = load_custody_module()
    mod.quality_scaler = lambda raw: corrected_quality_scaler(mod, raw)
    mod.main()


if __name__ == "__main__":
    main()
