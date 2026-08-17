#!/usr/bin/env python3
"""V80 historical parity gate.

This is deliberately a *pre-capture* integrity check. It does not create any V80
prospective record and it does not alter V68/V69/V79. It proves that the frozen
V69 TOP1 General identity and the frozen V79 pregame strength construction can be
reproduced from immutable historical custody before V80 is allowed to capture a
single fresh game.
"""

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import math
import os
import sys

SCHEMA = "courtedge-p0-step12v80-general-strength-historical-parity.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v80-general-strength-prospective-confirmation-contract.v1"
CONTRACT_STATUS = "FROZEN_GENERAL_STRENGTH_PROSPECTIVE_CONFIRMATION_BEFORE_ANY_V80_SCORER_OR_CAPTURE_EXISTS"
V79_SCHEMA = "courtedge-p0-step12v79-dynamic-team-strength-route-threat-regimes.v1"
V79_CLASSIFICATION = "V79_DYNAMIC_TEAM_STRENGTH_ROUTE_THREAT_REGIMES_RETROSPECTIVE_COMPLETE"
GENERAL_ROUTE = "V16_V68_CONSENSUS_T0.550"
SEASONS = ("2024", "2025", "2026_YTD")
EXPECTED_V79_SCORER_BLOB = "4a4f9f8a98d824f529b802477cc98568d9f78b4d"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def canonical_sha256(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V80_PARITY_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def numeric_abs_diff(a, b):
    if a is None and b is None:
        return 0.0
    if isinstance(a, bool) or isinstance(b, bool):
        return 0.0 if a == b else math.inf
    try:
        aa = float(a)
        bb = float(b)
    except Exception:
        return 0.0 if a == b else math.inf
    if not (math.isfinite(aa) and math.isfinite(bb)):
        return 0.0 if aa == bb else math.inf
    return abs(aa - bb)


def exact_loss_row_check(generated, official, tolerance):
    identity_keys = (
        "season", "date", "gamePk", "route", "originalSide", "selectedTeamId",
        "opponentTeamId", "selectedTier", "opponentTier", "tierRelation",
    )
    numeric_keys = ("selectedStrengthScore", "opponentStrengthScore", "strengthGap")
    identity_mismatches = []
    numeric_mismatches = []
    max_abs = 0.0
    for k in identity_keys:
        if generated.get(k) != official.get(k):
            identity_mismatches.append({"field": k, "generated": generated.get(k), "official": official.get(k)})
    for k in numeric_keys:
        d = numeric_abs_diff(generated.get(k), official.get(k))
        max_abs = max(max_abs, d)
        if d > tolerance:
            numeric_mismatches.append({"field": k, "absDiff": d, "generated": generated.get(k), "official": official.get(k)})
    return identity_mismatches, numeric_mismatches, max_abs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--custody", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--v68-contract", required=True)
    ap.add_argument("--classifier-source", required=True)
    ap.add_argument("--router-source", required=True)
    ap.add_argument("--v69-contract", required=True)
    ap.add_argument("--v69-scorer", required=True)
    ap.add_argument("--v72-scorer", required=True)
    ap.add_argument("--v79-contract", required=True)
    ap.add_argument("--v79-scorer", required=True)
    ap.add_argument("--official-v79-report", required=True)
    ap.add_argument("--rerun-v79-report", required=True)
    ap.add_argument("--v80-contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c80 = load(a.v80_contract)
    if c80.get("schemaVersion") != CONTRACT_SCHEMA or c80.get("scientificStatus") != CONTRACT_STATUS:
        raise SystemExit("V80_PARITY_CONTRACT_INVALID")
    if c80["prospectiveCohort"].get("firstEligibleOfficialDate") != "2026-08-18":
        raise SystemExit("V80_PARITY_FIRST_ELIGIBLE_DATE_DRIFT")
    if c80["prospectiveCohort"].get("targetRouteExactly") != GENERAL_ROUTE:
        raise SystemExit("V80_PARITY_TARGET_ROUTE_DRIFT")
    gate = c80.get("historicalParityGateBeforeProspectiveCapture") or {}
    if gate.get("required") is not True:
        raise SystemExit("V80_PARITY_GATE_NOT_REQUIRED_BY_CONTRACT")
    tolerance = float(gate.get("maximumNumericAbsoluteDifference", -1))
    if tolerance != 1e-12:
        raise SystemExit("V80_PARITY_TOLERANCE_DRIFT")

    parent = c80["immutableParentEvidence"]
    required_blobs = {
        "v79Contract": (a.v79_contract, parent["v79Contract"]["gitBlobSha"]),
        "v69Contract": (a.v69_contract, parent["v69Contract"]["gitBlobSha"]),
        "v69Scorer": (a.v69_scorer, parent["v69Scorer"]["gitBlobSha"]),
        "v68Contract": (a.v68_contract, parent["v68Contract"]["gitBlobSha"]),
        "frozenClassifierSource": (a.classifier_source, parent["frozenClassifierSource"]["gitBlobSha"]),
        "frozenRouterSource": (a.router_source, parent["frozenRouterSource"]["gitBlobSha"]),
    }
    blob_checks = {}
    for name, (path, expected) in required_blobs.items():
        got = git_blob_sha(path)
        blob_checks[name] = {"expected": expected, "actual": got, "match": got == expected}
        if got != expected:
            raise SystemExit(f"V80_PARITY_PARENT_BLOB_DRIFT:{name}:{got}")

    v79c = load(a.v79_contract)
    for key, path in (("v69Scorer", a.v69_scorer), ("v72Scorer", a.v72_scorer)):
        expected = v79c["immutableParentEvidence"][key]["gitBlobSha"]
        got = git_blob_sha(path)
        blob_checks[f"v79Parent.{key}"] = {"expected": expected, "actual": got, "match": got == expected}
        if got != expected:
            raise SystemExit(f"V80_PARITY_V79_PARENT_BLOB_DRIFT:{key}:{got}")
    got_v79_scorer = git_blob_sha(a.v79_scorer)
    blob_checks["v79Scorer"] = {"expected": EXPECTED_V79_SCORER_BLOB, "actual": got_v79_scorer, "match": got_v79_scorer == EXPECTED_V79_SCORER_BLOB}
    if got_v79_scorer != EXPECTED_V79_SCORER_BLOB:
        raise SystemExit(f"V80_PARITY_V79_SCORER_BLOB_DRIFT:{got_v79_scorer}")

    official = load(a.official_v79_report)
    rerun = load(a.rerun_v79_report)
    if official.get("schemaVersion") != V79_SCHEMA or official.get("classification") != V79_CLASSIFICATION:
        raise SystemExit("V80_PARITY_OFFICIAL_V79_REPORT_INVALID")
    if rerun != official:
        raise SystemExit("V80_PARITY_FULL_V79_REPRODUCTION_MISMATCH")
    official_sha = canonical_sha256(official)
    rerun_sha = canonical_sha256(rerun)

    v69 = module(a.v69_scorer, "v80_parity_v69")
    v72 = module(a.v72_scorer, "v80_parity_v72")
    v79 = module(a.v79_scorer, "v80_parity_v79")
    v69c = load(a.v69_contract)
    feature_map, _ = v72.load_feature_map(a.root, SEASONS, v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"])

    original_daily_cap = v69.daily_cap
    calls = []

    def capture(candidates, dates, cap):
        result = original_daily_cap(candidates, dates, cap)
        calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result

    v69.daily_cap = capture
    parent_out = a.out + ".v69-parent.json"
    old = sys.argv[:]
    sys.argv = [
        a.v69_scorer,
        "--root", a.root,
        "--custody", a.custody,
        "--v16-manifest", a.v16_manifest,
        "--v68-contract", a.v68_contract,
        "--classifier-source", a.classifier_source,
        "--router-source", a.router_source,
        "--contract", a.v69_contract,
        "--out", parent_out,
    ]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            v69.main()
    finally:
        sys.argv = old
        v69.daily_cap = original_daily_cap
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass

    expected_calls = len(v69c["predeclaredConsensusScoreGrid"]) * 8
    if len(calls) != expected_calls or calls[4]["cap"] != 1:
        raise SystemExit(f"V80_PARITY_V69_CAPTURE_DRIFT:{len(calls)}:{calls[4]['cap'] if len(calls) > 4 else None}")
    top1 = calls[4]["opps"]
    rows0 = [o for o in top1 if o["date"][5:] >= "05-01"]

    expected_parent = official["parentParity"]
    reproduced_parent = {
        "pickDays": len(rows0),
        "decisiveRows": sum(r["y"] is not None for r in rows0),
        "wins": sum(r["y"] == 1 for r in rows0),
        "losses": sum(r["y"] == 0 for r in rows0),
        "pushes": sum(r["y"] is None for r in rows0),
    }
    if reproduced_parent != expected_parent:
        raise SystemExit(f"V80_PARITY_PARENT_COUNTS_MISMATCH:{reproduced_parent}:{expected_parent}")

    target_dates = {s: {r["date"] for r in rows0 if r["season"] == s} for s in SEASONS}
    snapshots, diagnostics = v79.build_strength_snapshots(
        a.root,
        SEASONS,
        target_dates,
        int(c80["pregameStrengthDefinition"]["minimumPriorGamesPerTeam"]),
    )
    rows = v79.add_strength_context(rows0, feature_map, snapshots)

    reproduced_route_parity = {}
    for route in sorted(official["routeParity"]):
        z = [r for r in rows if r["route"] == route and r["y"] is not None]
        reproduced_route_parity[route] = {
            "decisiveRows": len(z),
            "wins": sum(r["y"] == 1 for r in z),
            "losses": sum(r["y"] == 0 for r in z),
        }
    if reproduced_route_parity != official["routeParity"]:
        raise SystemExit(f"V80_PARITY_ROUTE_COUNTS_MISMATCH:{reproduced_route_parity}")

    official_losses = {(r["season"], int(r["gamePk"])): r for r in official["all138LossContextLedger"]}
    generated_losses = {}
    for r in rows:
        if r["y"] != 0:
            continue
        generated_losses[(r["season"], int(r["gamePk"]))] = {
            "season": r["season"],
            "date": r["date"],
            "gamePk": int(r["gamePk"]),
            "route": r["route"],
            "originalSide": r["side"],
            "selectedTeamId": int(r["selectedTeamId"]),
            "opponentTeamId": int(r["opponentTeamId"]),
            "selectedTier": r["selectedStrength"]["primaryTier"],
            "opponentTier": r["opponentStrength"]["primaryTier"],
            "selectedStrengthScore": float(r["selectedStrength"]["strengthScore"]),
            "opponentStrengthScore": float(r["opponentStrength"]["strengthScore"]),
            "strengthGap": float(r["strengthGap"]),
            "tierRelation": r["tierRelation"],
        }
    missing_loss_keys = sorted(set(official_losses) - set(generated_losses))
    extra_loss_keys = sorted(set(generated_losses) - set(official_losses))
    identity_mismatch_rows = []
    numeric_mismatch_rows = []
    max_abs_diff = 0.0
    for key in sorted(set(official_losses) & set(generated_losses)):
        ids, nums, mx = exact_loss_row_check(generated_losses[key], official_losses[key], tolerance)
        max_abs_diff = max(max_abs_diff, mx)
        if ids:
            identity_mismatch_rows.append({"key": list(key), "mismatches": ids})
        if nums:
            numeric_mismatch_rows.append({"key": list(key), "mismatches": nums})
    if missing_loss_keys or extra_loss_keys or identity_mismatch_rows or numeric_mismatch_rows:
        raise SystemExit(
            "V80_PARITY_PRESERVED_LOSS_LEDGER_MISMATCH:"
            + json.dumps({
                "missing": missing_loss_keys[:5],
                "extra": extra_loss_keys[:5],
                "identity": identity_mismatch_rows[:3],
                "numeric": numeric_mismatch_rows[:3],
            }, sort_keys=True)
        )
    if max_abs_diff > tolerance:
        raise SystemExit(f"V80_PARITY_NUMERIC_TOLERANCE_FAILED:{max_abs_diff}")

    general = [r for r in rows if r["route"] == GENERAL_ROUTE]
    generated_general_relation = {
        rel: v79.summarize([r for r in general if r["tierRelation"] == rel])
        for rel in ("SELECTED_STRONGER", "PEER", "SELECTED_WEAKER")
    }
    if generated_general_relation != official["primaryRouteTierRelation"][GENERAL_ROUTE]:
        raise SystemExit("V80_PARITY_GENERAL_RELATION_MISMATCH")

    identity_rows = []
    for r in sorted(rows, key=lambda x: (x["date"], int(x["gamePk"]))):
        identity_rows.append({
            "season": r["season"],
            "date": r["date"],
            "gamePk": int(r["gamePk"]),
            "route": r["route"],
            "side": r["side"],
            "selectedTeamId": int(r["selectedTeamId"]),
            "opponentTeamId": int(r["opponentTeamId"]),
            "selectedStrengthScore": float(r["selectedStrength"]["strengthScore"]),
            "opponentStrengthScore": float(r["opponentStrength"]["strengthScore"]),
            "selectedTier": r["selectedStrength"]["primaryTier"],
            "opponentTier": r["opponentStrength"]["primaryTier"],
            "strengthGap": float(r["strengthGap"]),
            "tierRelation": r["tierRelation"],
        })
    general_identity_rows = [r for r in identity_rows if r["route"] == GENERAL_ROUTE]

    report = {
        "schemaVersion": SCHEMA,
        "classification": "V80_HISTORICAL_PARITY_GATE_PASSED",
        "prospectiveCaptureAuthorizedAfterThisGate": True,
        "firstEligibleOfficialDate": c80["prospectiveCohort"]["firstEligibleOfficialDate"],
        "contractFreezeStatus": c80["scientificStatus"],
        "fullOfficialV79Reproduction": {
            "exactJsonEquality": True,
            "officialCanonicalSha256": official_sha,
            "rerunCanonicalSha256": rerun_sha,
            "classification": official["classification"],
        },
        "parentBlobChecks": blob_checks,
        "v69GeneralTop1Reproduction": {
            "exactDailyCapCallIndex": 4,
            "expectedDailyCapCalls": expected_calls,
            "actualDailyCapCalls": len(calls),
            "parentParity": reproduced_parent,
            "routeParity": reproduced_route_parity,
            "allTop1StructuralFingerprintSha256": canonical_sha256(identity_rows),
            "generalTop1StructuralFingerprintSha256": canonical_sha256(general_identity_rows),
            "generalRows": len(general_identity_rows),
        },
        "v79StrengthReproduction": {
            "diagnostics": diagnostics,
            "preservedLossRowsCompared": len(official_losses),
            "lossRouteOrGameIdentityMismatches": 0,
            "lossStrengthTierMismatches": 0,
            "numericMismatchesAboveTolerance": 0,
            "maximumNumericAbsoluteDifference": max_abs_diff,
            "allowedMaximumNumericAbsoluteDifference": tolerance,
            "generalTierRelation": generated_general_relation,
        },
        "integrity": {
            "routeOrGameIdentityMismatchesAllowed": int(gate["routeOrGameIdentityMismatchesAllowed"]),
            "strengthTierMismatchesAllowed": int(gate["strengthTierMismatchesAllowed"]),
            "prospectiveOutcomesRead": False,
            "prospectiveCaptureCreated": False,
            "v68Changed": False,
            "productionChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakingChanged": False,
            "oddsUsedAsFeatures": False,
            "realFinancialExposure": 0,
        },
        "interpretation": (
            "The pre-capture historical parity gate passed. The successful preserved V79 report was reproduced exactly, "
            "the exact frozen V69 confluence TOP1 call was regenerated, all 138 preserved loss identities/strength values "
            "matched within the frozen 1e-12 tolerance, and the General route tier-relation aggregates matched V79. "
            "This authorizes implementation of outcome-free V80 prospective capture only; it does not validate the V80 hypothesis."
        ),
    }
    dump(a.out, report)
    print(json.dumps({
        "classification": report["classification"],
        "generalRows": len(general_identity_rows),
        "allTop1Fingerprint": report["v69GeneralTop1Reproduction"]["allTop1StructuralFingerprintSha256"],
        "generalFingerprint": report["v69GeneralTop1Reproduction"]["generalTop1StructuralFingerprintSha256"],
        "maxAbsDiff": max_abs_diff,
    }, indent=2))


if __name__ == "__main__":
    main()
