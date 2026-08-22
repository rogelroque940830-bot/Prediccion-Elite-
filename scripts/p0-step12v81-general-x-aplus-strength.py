#!/usr/bin/env python3
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import math
import os
import sys

import numpy as np
from scipy.optimize import minimize
from scipy.stats import mannwhitneyu, pointbiserialr

SCHEMA = "courtedge-p0-step12v81-general-x-aplus-strength.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v81-general-x-aplus-strength-contract.v1"
CONTRACT_STATUS = "FROZEN_GENERAL_X_APLUS_SIGNAL_DISCOVERY_PLAN_BEFORE_ANY_V81_SCORER_EXISTS"
GENERAL_ROUTE = "V16_V68_CONSENSUS_T0.550"
SEASONS = ("2024", "2025", "2026_YTD")


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


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V81_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def finite(x):
    try:
        return x is not None and math.isfinite(float(x))
    except Exception:
        return False


def wilson(w, n):
    if n <= 0:
        return {"lower": None, "upper": None}
    z = 1.96
    p = w / n
    den = 1 + z*z/n
    mid = (p + z*z/(2*n))/den
    half = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den
    return {"lower": mid-half, "upper": mid+half}


def summarize(rows):
    decisive = [r for r in rows if r.get("y") in (0, 1)]
    w = sum(r["y"] == 1 for r in decisive)
    l = sum(r["y"] == 0 for r in decisive)
    by_season = {}
    for s in SEASONS:
        z = [r for r in decisive if r["season"] == s]
        sw = sum(r["y"] == 1 for r in z)
        by_season[s] = {"n": len(z), "wins": sw, "losses": len(z)-sw, "hitRate": sw/len(z) if z else None}
    by_side = {}
    for side in ("HOME", "AWAY"):
        z = [r for r in decisive if r["side"] == side]
        sw = sum(r["y"] == 1 for r in z)
        by_side[side] = {"n": len(z), "wins": sw, "losses": len(z)-sw, "hitRate": sw/len(z) if z else None}
    return {
        "decisiveRows": len(decisive), "wins": w, "losses": l,
        "hitRate": w/len(decisive) if decisive else None,
        "wilson95": wilson(w, len(decisive)),
        "bySeason": by_season,
        "bySide": by_side,
    }


def logistic_univariate(rows, key):
    z = [(float(r[key]), int(r["y"])) for r in rows if r.get("y") in (0, 1) and finite(r.get(key))]
    if len(z) < 5 or len({y for _, y in z}) < 2:
        return {"n": len(z), "intercept": None, "slope": None, "success": False}
    x = np.asarray([a for a, _ in z], dtype=float)
    y = np.asarray([b for _, b in z], dtype=float)
    def nll(beta):
        eta = beta[0] + beta[1]*x
        return float(np.sum(np.logaddexp(0.0, eta) - y*eta))
    res = minimize(nll, np.asarray([0.0, 0.0]), method="BFGS")
    return {"n": len(z), "intercept": float(res.x[0]), "slope": float(res.x[1]), "success": bool(res.success)}


def continuous(rows, key):
    z = [r for r in rows if r.get("y") in (0, 1) and finite(r.get(key))]
    wins = [float(r[key]) for r in z if r["y"] == 1]
    losses = [float(r[key]) for r in z if r["y"] == 0]
    pb = pointbiserialr([int(r["y"]) for r in z], [float(r[key]) for r in z]) if len(z) >= 3 and len({r['y'] for r in z}) == 2 else None
    mw = mannwhitneyu(wins, losses, alternative="two-sided", method="asymptotic") if wins and losses else None
    return {
        "n": len(z),
        "medianWins": float(np.median(wins)) if wins else None,
        "medianLosses": float(np.median(losses)) if losses else None,
        "meanWins": float(np.mean(wins)) if wins else None,
        "meanLosses": float(np.mean(losses)) if losses else None,
        "pointBiserialR": float(pb.statistic) if pb is not None else None,
        "pointBiserialP": float(pb.pvalue) if pb is not None else None,
        "mannWhitneyTwoSidedP": float(mw.pvalue) if mw is not None else None,
        "logistic": logistic_univariate(rows, key),
    }


def relation_filter(rows, rel):
    if rel == "ALL": return rows
    if rel == "PEER_OR_WEAKER": return [r for r in rows if r["tierRelation"] in ("PEER", "SELECTED_WEAKER")]
    return [r for r in rows if r["tierRelation"] == rel]


def cell(name, rows, filters):
    return {"name": name, "filters": filters, **summarize(rows)}


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
    ap.add_argument("--v79-contract", required=True)
    ap.add_argument("--v79-scorer", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != CONTRACT_STATUS:
        raise SystemExit("V81_CONTRACT_INVALID")
    if c["targetCohort"]["routeExactly"] != GENERAL_ROUTE:
        raise SystemExit("V81_ROUTE_DRIFT")
    parent_paths = {
        "v69Scorer": a.v69_scorer, "v69Contract": a.v69_contract,
        "v79Scorer": a.v79_scorer, "v79Contract": a.v79_contract,
        "frozenAPlusClassifier": a.classifier_source,
    }
    blob_checks = {}
    for key, p in parent_paths.items():
        got = git_blob_sha(p); expected = c["immutableParents"][key]["gitBlobSha"]
        blob_checks[key] = {"expected": expected, "actual": got, "match": got == expected}
        if got != expected: raise SystemExit(f"V81_PARENT_BLOB_DRIFT:{key}:{got}")

    v69 = module(a.v69_scorer, "v81_v69")
    v79 = module(a.v79_scorer, "v81_v79")
    v69c = load(a.v69_contract)
    classifier_version, premium_rules, models = v69.parse_frozen_classifier_source(a.classifier_source)
    if classifier_version != c["immutableParents"]["frozenAPlusClassifier"]["requiredVersion"]:
        raise SystemExit("V81_CLASSIFIER_VERSION_DRIFT")

    original_daily_cap = v69.daily_cap; calls = []
    def capture(candidates, dates, cap):
        result = original_daily_cap(candidates, dates, cap)
        calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result
    v69.daily_cap = capture
    parent_out = a.out + ".v69-parent.json"; old_argv = sys.argv[:]
    sys.argv = [a.v69_scorer, "--root", a.root, "--custody", a.custody, "--v16-manifest", a.v16_manifest,
                "--v68-contract", a.v68_contract, "--classifier-source", a.classifier_source,
                "--router-source", a.router_source, "--contract", a.v69_contract, "--out", parent_out]
    try:
        with contextlib.redirect_stdout(io.StringIO()): v69.main()
    finally:
        sys.argv = old_argv; v69.daily_cap = original_daily_cap
    try: os.remove(parent_out)
    except FileNotFoundError: pass

    expected_calls = len(v69c["predeclaredConsensusScoreGrid"]) * 8
    if len(calls) != expected_calls or calls[4]["cap"] != 1: raise SystemExit(f"V81_V69_CAPTURE_DRIFT:{len(calls)}")
    top1 = [r for r in calls[4]["opps"] if r["date"][5:] >= c["targetCohort"]["minimumOfficialDateMonthDay"]]
    general0 = [r for r in top1 if r["route"] == GENERAL_ROUTE and r.get("y") in (0, 1)]
    if len(general0) != int(c["targetCohort"]["expectedDecisiveRows"]): raise SystemExit(f"V81_GENERAL_COUNT_DRIFT:{len(general0)}")
    if sum(r["y"] == 1 for r in general0) != int(c["targetCohort"]["expectedWins"]): raise SystemExit("V81_GENERAL_WIN_COUNT_DRIFT")
    if sum(r["y"] == 0 for r in general0) != int(c["targetCohort"]["expectedLosses"]): raise SystemExit("V81_GENERAL_LOSS_COUNT_DRIFT")

    raw_map = {}
    for s in SEASONS:
        table = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        for raw in table["rows"]:
            if raw.get("t5PregameValid") is True: raw_map[(s, int(raw["gamePk"]))] = raw
    target_dates = {s: {r["date"] for r in general0 if r["season"] == s} for s in SEASONS}
    v79c = load(a.v79_contract)
    minimum_games = int(v79c["pregameStrengthDefinition"]["minimumPriorGamesPerTeam"])
    snapshots, strength_diag = v79.build_strength_snapshots(a.root, SEASONS, target_dates, minimum_games)
    general = v79.add_strength_context(general0, raw_map, snapshots)

    premium_features = tuple(c["aPlusSignalFamilies"]["premiumComponentFeatures"])
    c4_features = tuple(c["aPlusSignalFamilies"]["c4StrongDirectionalFeatures"])
    enriched = []; exact_aplus_count = 0; exact_premium_count = 0
    for r in general:
        raw = raw_map[(r["season"], int(r["gamePk"]))]; features = raw.get("features") or {}
        cls = v69.classify(features, premium_rules, models); sign = 1.0 if r["side"] == "HOME" else -1.0
        c4_home = float(cls["aPlusC4PHome"]); f13_home = float(cls["aPlusFull13PHome"])
        c4_sel = c4_home if sign > 0 else 1.0-c4_home; f13_sel = f13_home if sign > 0 else 1.0-f13_home
        premium_support = sum(finite(features.get(k)) and sign*float(features[k]) > 0.0 for k in premium_features)
        c4_support = sum(finite(features.get(k)) and sign*float(features[k]) > 0.0 for k in c4_features)
        rr = dict(r); rr.update({
            "aPlusC4Selected": c4_sel, "aPlusFull13Selected": f13_sel,
            "aPlusMinSelected": min(c4_sel, f13_sel), "aPlusMeanSelected": 0.5*(c4_sel+f13_sel),
            "aPlusFrozenThresholdMargin": min(c4_sel-0.69, f13_sel-0.64),
            "directionalPremiumSupportCount": int(premium_support), "directionalC4StrongSupportCount": int(c4_support),
            "rawFrozenPremiumAHome": bool(cls["premiumA"]), "rawFrozenAPlusHome": bool(cls["aPlus"]),
            "rawFrozenF5ConsensusHome": bool(cls["f5Consensus"]),
        })
        exact_aplus_count += int(cls["aPlus"]); exact_premium_count += int(cls["premiumA"]); enriched.append(rr)

    baseline = summarize(enriched)
    score_thresholds = [float(x) for x in c["aPlusSignalFamilies"]["predeclaredMinSelectedThresholds"]]
    margin_thresholds = [float(x) for x in c["aPlusSignalFamilies"]["predeclaredMarginThresholds"]]
    premium_counts = [int(x) for x in c["aPlusSignalFamilies"]["predeclaredDirectionalSupportCounts"]]
    c4_counts = [int(x) for x in c["aPlusSignalFamilies"]["predeclaredC4SupportCounts"]]
    tables = {"scoreOnly": [], "marginOnly": [], "premiumSupportOnly": [], "c4SupportOnly": [], "jointGrid": []}
    for t in score_thresholds:
        z = [r for r in enriched if r["aPlusMinSelected"] >= t]
        tables["scoreOnly"].append(cell(f"APLUS_MIN_GE_{t:.2f}", z, {"aPlusMinSelectedGe": t}))
    for t in margin_thresholds:
        z = [r for r in enriched if r["aPlusFrozenThresholdMargin"] >= t]
        tables["marginOnly"].append(cell(f"APLUS_MARGIN_GE_{t:+.2f}", z, {"aPlusFrozenThresholdMarginGe": t}))
    for k in premium_counts:
        z = [r for r in enriched if r["directionalPremiumSupportCount"] >= k]
        tables["premiumSupportOnly"].append(cell(f"PREMIUM_DIRECTIONAL_SUPPORT_GE_{k}", z, {"directionalPremiumSupportCountGe": k}))
    for k in c4_counts:
        z = [r for r in enriched if r["directionalC4StrongSupportCount"] >= k]
        tables["c4SupportOnly"].append(cell(f"C4_DIRECTIONAL_SUPPORT_GE_{k}", z, {"directionalC4StrongSupportCountGe": k}))

    relations = c["structuralStrengthCross"]["relations"]
    for rel in relations:
        base_rel = relation_filter(enriched, rel)
        for t in score_thresholds:
            for pk in premium_counts:
                for ck in c4_counts:
                    z = [r for r in base_rel if r["aPlusMinSelected"] >= t and r["directionalPremiumSupportCount"] >= pk and r["directionalC4StrongSupportCount"] >= ck]
                    tables["jointGrid"].append(cell(f"{rel}|MIN>={t:.2f}|P>={pk}|C4>={ck}", z,
                        {"strengthRelation": rel, "aPlusMinSelectedGe": t, "directionalPremiumSupportCountGe": pk, "directionalC4StrongSupportCountGe": ck}))

    min_table = int(c["analysisPlan"]["minimumRowsForCandidateTable"]); min_serious = int(c["analysisPlan"]["minimumRowsForSeriousCandidate"])
    eligible_cells = [x for x in tables["jointGrid"] if x["decisiveRows"] >= min_table]
    serious = [x for x in eligible_cells if x["decisiveRows"] >= min_serious]
    key = lambda x: (-(x["hitRate"] if x["hitRate"] is not None else -1), -(x["wilson95"]["lower"] if x["wilson95"]["lower"] is not None else -1), -x["decisiveRows"], x["name"])
    ranked = sorted(eligible_cells, key=key); ranked_serious = sorted(serious, key=key)

    by_relation = {rel: summarize(relation_filter(enriched, rel)) for rel in relations}
    strongest_predeclared = {
        "selectedStrongerAndMinGe060": summarize([r for r in enriched if r["tierRelation"] == "SELECTED_STRONGER" and r["aPlusMinSelected"] >= 0.60]),
        "selectedStrongerAndMinGe060AndPremium3": summarize([r for r in enriched if r["tierRelation"] == "SELECTED_STRONGER" and r["aPlusMinSelected"] >= 0.60 and r["directionalPremiumSupportCount"] >= 3]),
        "selectedStrongerAndMinGe060AndC4Support3": summarize([r for r in enriched if r["tierRelation"] == "SELECTED_STRONGER" and r["aPlusMinSelected"] >= 0.60 and r["directionalC4StrongSupportCount"] >= 3]),
        "selectedStrongerAndMinGe064": summarize([r for r in enriched if r["tierRelation"] == "SELECTED_STRONGER" and r["aPlusMinSelected"] >= 0.64]),
        "selectedStrongerAndProbabilityOnlyAPlus": summarize([r for r in enriched if r["tierRelation"] == "SELECTED_STRONGER" and r["aPlusFrozenThresholdMargin"] >= 0.0]),
    }

    win_signal = [r["aPlusMinSelected"] for r in enriched if r["y"] == 1]; loss_signal = [r["aPlusMinSelected"] for r in enriched if r["y"] == 0]
    report = {
        "schemaVersion": SCHEMA,
        "classification": "V81_GENERAL_X_APLUS_RETROSPECTIVE_DISCOVERY_COMPLETE",
        "contractStatus": c["scientificStatus"], "parentBlobChecks": blob_checks,
        "cohortParity": baseline,
        "exactFrozenHomeRouteOverlapInsideGeneral": {"premiumAHomeRows": exact_premium_count, "aPlusHomeRows": exact_aplus_count},
        "structuralStrength": {"diagnostics": strength_diag, "byRelation": by_relation},
        "signalDistribution": {
            "aPlusMinSelected": continuous(enriched, "aPlusMinSelected"),
            "aPlusMeanSelected": continuous(enriched, "aPlusMeanSelected"),
            "medianAPlusMinWins": float(np.median(win_signal)), "medianAPlusMinLosses": float(np.median(loss_signal)),
        },
        "predeclaredTables": tables, "strongestPredeclaredViews": strongest_predeclared,
        "candidateRanking": {"minimumRowsForTable": min_table, "minimumRowsForSeriousCandidate": min_serious, "top15AllEligible": ranked[:15], "top15Serious": ranked_serious[:15]},
        "integrity": {
            "thresholdsAddedAfterOutcomeInspection": False, "featuresSearchedOutsideFrozenAPlusFamilies": False,
            "refitPerformed": False, "recalibrationPerformed": False, "oddsUsed": False,
            "v80Changed": False, "v68Changed": False, "productionChanged": False,
            "rankingChanged": False, "routingChanged": False, "stakingChanged": False,
            "betEliteChanged": False, "realFinancialExposure": 0,
        },
        "interpretationBoundary": c["interpretationBoundary"],
    }
    dump(a.out, report)
    print(json.dumps({"classification": report["classification"], "baseline": baseline,
                      "signalDistribution": report["signalDistribution"]["aPlusMinSelected"],
                      "strongestPredeclaredViews": strongest_predeclared, "topSerious": ranked_serious[:8]}, indent=2))


if __name__ == "__main__": main()
