#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit("PP_REFERENCE_IMPORT_FAILED:" + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def finite(value):
    try:
        x = float(value)
        return x if math.isfinite(x) else math.nan
    except (TypeError, ValueError):
        return math.nan


def sigmoid(z):
    if z >= 0:
        e = math.exp(-z)
        return 1.0 / (1.0 + e)
    e = math.exp(z)
    return e / (1.0 + e)


def zvalue(row, field, prep):
    p = prep[field]
    x = finite(row.get(field))
    if not math.isfinite(x):
        x = float(p["median"])
    if float(p["std"]) <= 1e-12:
        return 0.0
    z = (x - float(p["mean"])) / float(p["std"])
    return max(-float(p["clip"]), min(float(p["clip"]), z))


def enrich(candidate, source, full_authority, classifier, cross):
    row = dict(candidate)
    selected_fields = (
        "starter_kbb_adv",
        "team_win10_diff",
        "lineup_exposure_rate_adv",
        "team_ra10_adv",
        "starter_runrisk_adv",
    )
    for feature in selected_fields:
        value = cross.selected_value(source, feature, row["side"])
        row[f"sel_{feature}"] = None if not math.isfinite(value) else float(value)

    supports = 0
    margins = []
    for feature in ("team_win10_diff", "starter_kbb_adv", "lineup_exposure_rate_adv"):
        threshold = float(classifier["premiumAThresholds"][feature])
        value = row[f"sel_{feature}"]
        stats = full_authority["premiumHeritageTrainingStats"][feature]
        raw = float(stats["median"]) if value is None else float(value)
        if raw >= threshold:
            supports += 1
        margins.append((raw - threshold) / float(stats["std"]))
    row["premium_core_support_count_0_to_3"] = supports
    row["premium_core_weakest_margin"] = float(min(margins))

    c4_home = cross.frozen_home_probability(source, classifier["models"]["A_PLUS_C4_2022_FROZEN"])
    full_home = cross.frozen_home_probability(source, classifier["models"]["A_PLUS_FULL13_2022_FROZEN"])
    row["frozen_c4_selected_side_probability"] = float(c4_home if row["side"] == "HOME" else 1.0 - c4_home)
    row["frozen_full13_selected_side_probability"] = float(full_home if row["side"] == "HOME" else 1.0 - full_home)
    return row


def design_value(row, feature_name, snapshot):
    if feature_name.startswith("GLOBAL::"):
        descriptor = feature_name[len("GLOBAL::"):]
        if "=" in descriptor:
            field, level = descriptor.split("=", 1)
            return 1.0 if str(row[field]) == level else 0.0
        return zvalue(row, descriptor, snapshot["model"]["preprocessing"])

    prefix = "DEV::horizon="
    if not feature_name.startswith(prefix) or "::" not in feature_name[len(prefix):]:
        raise SystemExit("PP_REFERENCE_FEATURE_NAME_UNKNOWN:" + feature_name)
    horizon, signal = feature_name[len(prefix):].split("::", 1)
    if row["horizon"] != horizon:
        return 0.0
    if signal == "INTERCEPT":
        return float(snapshot["model"]["groupInterceptFeatureScale"])
    return float(snapshot["model"]["signalDeviationFeatureScale"]) * zvalue(
        row, signal, snapshot["model"]["preprocessing"]
    )


def probability(row, snapshot):
    names = snapshot["model"]["featureNames"]
    coefs = snapshot["model"]["rawCoefficients"]
    if len(names) != 49 or len(coefs) != 49:
        raise SystemExit("PP_REFERENCE_FEATURE_COUNT_DRIFT")
    logit = float(snapshot["model"]["intercept"])
    for name, coef in zip(names, coefs):
        logit += float(coef) * design_value(row, name, snapshot)
    return sigmoid(logit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full-reference", required=True)
    parser.add_argument("--full-authority", required=True)
    parser.add_argument("--classifier-authority", required=True)
    parser.add_argument("--pp-snapshot", required=True)
    parser.add_argument("--cross-source", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    full_reference = load(args.full_reference)
    full_authority = load(args.full_authority)
    classifier = load(args.classifier_authority)
    snapshot = load(args.pp_snapshot)
    cross = module(args.cross_source, "pp_cross_reference")

    if full_reference.get("schemaVersion") != "courtedge-mlb-full-modular-frozen-live-reference.v1":
        raise SystemExit("PP_REFERENCE_FULL_FIXTURE_INVALID")
    if snapshot.get("model", {}).get("parameterPayloadDigest") != "sha256:02f64630d94f5951fa684294e879937d1ad531acc6ecdedf56fc3b225526b275":
        raise SystemExit("PP_REFERENCE_SNAPSHOT_DIGEST_DRIFT")

    cases = []
    all_candidates = []
    for index, fixture in enumerate(full_reference["cases"]):
        source = fixture["featureVector"]
        candidates = []
        for candidate in fixture["candidates"]:
            row = enrich(candidate, source, full_authority, classifier, cross)
            row["partialPoolProbability"] = float(probability(row, snapshot))
            candidates.append(row)
            all_candidates.append(row)
        candidates.sort(key=lambda r: (
            -r["partialPoolProbability"],
            -r["qualityPercentile"],
            -r["modelProbability"],
            r["market"],
            r["gamePk"],
        ))
        cases.append({
            "caseIndex": index,
            "featureVector": source,
            "homeStrengthTier": fixture["homeStrengthTier"],
            "awayStrengthTier": fixture["awayStrengthTier"],
            "candidates": candidates,
        })

    all_candidates.sort(key=lambda r: (
        -r["partialPoolProbability"],
        -r["qualityPercentile"],
        -r["modelProbability"],
        r["market"],
        r["gamePk"],
    ))
    payload = {
        "schemaVersion": "courtedge-mlb-pp-horizon-frozen-live-reference.v1",
        "officialDate": full_reference["officialDate"],
        "caseCount": len(cases),
        "candidateCount": len(all_candidates),
        "cases": cases,
        "dailySelection": all_candidates[0] if all_candidates else None,
        "persistedSnapshotOnly": True,
        "runtimeRefit": False,
        "preprocessingRefit": False,
        "outcomesRead": False,
        "sportsbookPricesRead": False,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print("MLB_PP_HORIZON_FROZEN_REFERENCE_GENERATED", len(cases), len(all_candidates))


if __name__ == "__main__":
    main()
