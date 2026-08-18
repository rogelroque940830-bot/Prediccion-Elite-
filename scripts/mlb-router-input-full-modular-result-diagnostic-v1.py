#!/usr/bin/env python3
# Workflow trigger only: diagnostic comparison logic unchanged.
import argparse
import hashlib
import json
import math
from pathlib import Path

IDENTITY_FIELDS = (
    "season", "officialDate", "gamePk", "market", "horizon", "side",
    "selectedLine", "lineGeometry", "strengthTier", "matchupStructure", "frontier",
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def finite_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def recursive_diff(a, b, path="$", out=None, limit=200):
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if type(a) is not type(b):
        if finite_number(a) and finite_number(b) and float(a) == float(b):
            return out
        out.append({"path": path, "kind": "TYPE", "original": a, "generated": b})
        return out
    if isinstance(a, dict):
        ak, bk = set(a), set(b)
        for k in sorted(ak - bk):
            if len(out) >= limit: break
            out.append({"path": f"{path}.{k}", "kind": "MISSING_GENERATED", "original": a[k]})
        for k in sorted(bk - ak):
            if len(out) >= limit: break
            out.append({"path": f"{path}.{k}", "kind": "EXTRA_GENERATED", "generated": b[k]})
        for k in sorted(ak & bk):
            recursive_diff(a[k], b[k], f"{path}.{k}", out, limit)
            if len(out) >= limit: break
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            out.append({"path": path, "kind": "LIST_LENGTH", "original": len(a), "generated": len(b)})
        for i, (x, y) in enumerate(zip(a, b)):
            recursive_diff(x, y, f"{path}[{i}]", out, limit)
            if len(out) >= limit: break
        return out
    if finite_number(a) and finite_number(b):
        if float(a) != float(b):
            out.append({"path": path, "kind": "NUMBER", "original": a, "generated": b, "absDiff": abs(float(a)-float(b))})
        return out
    if a != b:
        out.append({"path": path, "kind": "VALUE", "original": a, "generated": b})
    return out


def identity(row):
    return tuple(row.get(k) for k in IDENTITY_FIELDS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--original", required=True)
    ap.add_argument("--generated", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    original_path = Path(args.original)
    generated_path = Path(args.generated)
    original = json.loads(original_path.read_text())
    generated = json.loads(generated_path.read_text())

    op = original.get("dailyShadowPicks", {}).get("CHALLENGER_FULL_MODULAR", [])
    gp = generated.get("dailyShadowPicks", {}).get("CHALLENGER_FULL_MODULAR", [])
    identity_mismatches = []
    object_mismatches = []
    for i, (a, b) in enumerate(zip(op, gp)):
        if identity(a) != identity(b) and len(identity_mismatches) < 50:
            identity_mismatches.append({"index": i, "original": identity(a), "generated": identity(b)})
        if a != b and len(object_mismatches) < 50:
            object_mismatches.append({"index": i, "diff": recursive_diff(a, b, f"pick[{i}]", limit=30)})

    ofm = original.get("policyResults", {}).get("CHALLENGER_FULL_MODULAR", {})
    gfm = generated.get("policyResults", {}).get("CHALLENGER_FULL_MODULAR", {})
    scientific_metric_fields = (
        "shadowPickDates", "wins", "losses", "pushes", "decisive", "hitRate",
        "combinedDailyOpportunityCoveragePct", "brierScore", "absoluteCalibrationGap",
    )
    metric_diffs = {}
    for k in scientific_metric_fields:
        a, b = ofm.get(k), gfm.get(k)
        if finite_number(a) and finite_number(b):
            same = float(a) == float(b)
        else:
            same = a == b
        if not same:
            metric_diffs[k] = {"original": a, "generated": b}

    top_diffs = recursive_diff(original, generated, limit=200)
    full_json_equal = original == generated
    original_sha = sha256(original_path)
    generated_sha = sha256(generated_path)

    selection_count_equal = len(op) == len(gp) == 236
    identity_equal = selection_count_equal and not identity_mismatches and all(identity(a) == identity(b) for a, b in zip(op, gp))
    object_equal = selection_count_equal and not object_mismatches and all(a == b for a, b in zip(op, gp))
    metrics_exact = not metric_diffs
    expected_record = (
        gfm.get("shadowPickDates") == 236 and gfm.get("wins") == 177 and
        gfm.get("losses") == 58 and gfm.get("pushes") == 1 and gfm.get("decisive") == 235
    )
    scientific_parity = selection_count_equal and identity_equal and object_equal and metrics_exact and expected_record

    report = {
        "schemaVersion": "courtedge-mlb-router-input-full-modular-result-diagnostic.v1",
        "classification": (
            "FULL_MODULAR_SCIENTIFIC_AND_BYTE_PARITY_PASS" if scientific_parity and original_sha == generated_sha
            else "FULL_MODULAR_SCIENTIFIC_PARITY_PASS_TRANSPORT_DIFF" if scientific_parity
            else "FULL_MODULAR_SCIENTIFIC_PARITY_FAIL"
        ),
        "originalSha256": original_sha,
        "generatedSha256": generated_sha,
        "byteIdentical": original_sha == generated_sha,
        "fullJsonEqual": full_json_equal,
        "selectionCountOriginal": len(op),
        "selectionCountGenerated": len(gp),
        "selectionIdentityExact": identity_equal,
        "selectionObjectExact": object_equal,
        "identityMismatchCount": sum(identity(a) != identity(b) for a, b in zip(op, gp)) + abs(len(op)-len(gp)),
        "objectMismatchCount": sum(a != b for a, b in zip(op, gp)) + abs(len(op)-len(gp)),
        "identityMismatchExamples": identity_mismatches,
        "objectMismatchExamples": object_mismatches,
        "metricDiffs": metric_diffs,
        "generatedFullModularRecord": {k: gfm.get(k) for k in ("shadowPickDates","wins","losses","pushes","decisive","hitRate","combinedDailyOpportunityCoveragePct")},
        "topLevelRecursiveDiffCountCapped": len(top_diffs),
        "recursiveDiffExamples": top_diffs,
        "scientificParity": scientific_parity,
        "productionChanged": False,
        "realFinancialExposure": 0,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print("MLB_FULL_MODULAR_RESULT_DIAGNOSTIC_BEGIN")
    print(json.dumps(report, indent=2, sort_keys=True))
    print("MLB_FULL_MODULAR_RESULT_DIAGNOSTIC_END")
    if not scientific_parity:
        raise SystemExit("FULL_MODULAR_SCIENTIFIC_PARITY_FAILED")


if __name__ == "__main__":
    main()
