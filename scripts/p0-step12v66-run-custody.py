#!/usr/bin/env python3
"""Pre-outcome V66 custody runner with one frozen zero-variance standardization correction.

This wrapper does not alter V62 source semantics or V66 features. It only applies the
predeclared correction frozen in research/p0-step12v66-preoutcome-zero-variance-correction.json:
a finite, non-empty 2022 training component whose raw standard deviation is exactly zero
uses effective scale 1.0, leaving its standardized contribution at zero.
"""
from __future__ import annotations

import importlib.util
import json
import sys
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


def report_path_from_argv():
    try:
        i = sys.argv.index("--report")
        return Path(sys.argv[i + 1])
    except (ValueError, IndexError):
        return None


def attach_correction_audit_alias(report_path):
    if report_path is None or not report_path.exists():
        raise SystemExit("V66_CORRECTION_REPORT_PATH_MISSING")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    params = report.get("qualityTrainingStandardization", {}).get("sideLevelComponentParameters")
    if not isinstance(params, dict):
        raise SystemExit("V66_CORRECTION_SCALER_AUDIT_MISSING")
    report["qualityIndex"] = {
        "definition": "UNWEIGHTED_MEAN_OF_FIVE_2022_STANDARDIZED_V62_SIDE_COMPONENTS",
        "2022TrainingScaler": params,
        "zeroVariancePolicy": "PRESERVE_RAW_VALUES_AND_MEAN_USE_EFFECTIVE_SCALE_ONE",
        "correctionDocument": "research/p0-step12v66-preoutcome-zero-variance-correction.json",
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main():
    report_path = report_path_from_argv()
    mod = load_custody_module()
    mod.quality_scaler = lambda raw: corrected_quality_scaler(mod, raw)
    mod.main()
    attach_correction_audit_alias(report_path)


if __name__ == "__main__":
    main()
