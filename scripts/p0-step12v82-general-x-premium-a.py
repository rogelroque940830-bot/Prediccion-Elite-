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

SCHEMA = "courtedge-p0-step12v82-general-x-premium-a.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v82-general-x-premium-a-contract.v1"
CONTRACT_STATUS = "FROZEN_GENERAL_X_PREMIUM_A_DISCOVERY_PLAN_BEFORE_ANY_V82_SCORER_EXISTS"
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
        raise SystemExit(f"V82_IMPORT_FAILED:{path}")
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
    d = [r for r in rows if r.get("y") in (0, 1)]
    w = sum(r["y"] == 1 for r in d)
    out = {
        "decisiveRows": len(d),
        "wins": w,
        "losses": len(d)-w,
        "hitRate": w/len(d) if d else None,
        "wilson95": wilson(w, len(d)),
        "bySeason": {},
        "bySide": {},
    }
    for s in SEASONS:
        z = [r for r in d if r["season"] == s]
        sw = sum(r["y"] == 1 for r in z)
        out["bySeason"][s] = {
            "n": len(z), "wins": sw, "losses": len(z)-sw,
            "hitRate": sw/len(z) if z else None,
        }
    for side in ("HOME", "AWAY"):
        z = [r for r in d if r["side"] == side]
        sw = sum(r["y"] == 1 for r in z)
        out["bySide"][side] = {
            "n": len(z), "wins": sw, "losses": len(z)-sw,
            "hitRate": sw/len(z) if z else None,
        }
    return out


def relation_filter(rows, relation):
    if relation == "ALL":
        return rows
    return [r for r in rows if r["tierRelation"] == relation]


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
        raise SystemExit("V82_CONTRACT_INVALID")

    parent_paths = {
        "v69Scorer": a.v69_scorer,
        "v69Contract": a.v69_contract,
        "v68Contract": a.v68_contract,
        "v79Scorer": a.v79_scorer,
        "v79Contract": a.v79_contract,
        "frozenClassifier": a.classifier_source,
        "frozenRouter": a.router_source,
    }
    blob_checks = {}
    for key, path in parent_paths.items():
        expected = c["immutableParents"][key]["gitBlobSha"]
        got = git_blob_sha(path)
        blob_checks[key] = {"expected": expected, "actual": got, "match": got == expected}
        if got != expected:
            raise SystemExit(f"V82_PARENT_BLOB_DRIFT:{key}:{got}")

    v69 = module(a.v69_scorer, "v82_v69")
    v79 = module(a.v79_scorer, "v82_v79")
    c69 = load(a.v69_contract)
    classifier_version, premium_rules, models = v69.parse_frozen_classifier_source(a.classifier_source)
    if classifier_version != c["immutableParents"]["frozenClassifier"]["requiredVersion"]:
        raise SystemExit("V82_CLASSIFIER_VERSION_DRIFT")
    if premium_rules != c["premiumADefinition"]["thresholdsExactly"]:
        raise SystemExit(f"V82_PREMIUM_THRESHOLDS_DRIFT:{premium_rules}")

    grid = [float(x) for x in c69["predeclaredConsensusScoreGrid"]]
    if not grid or abs(grid[0] - float(c["targetDefinition"]["consensusThreshold"])) > 1e-15:
        raise SystemExit(f"V82_GENERAL_GRID_DRIFT:{grid[:2]}")

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

    expected_calls = len(grid) * 8
    if len(calls) != expected_calls:
        raise SystemExit(f"V82_V69_CAPTURE_COUNT_DRIFT:{len(calls)}:{expected_calls}")
    if calls[0]["cap"] != 1 or calls[4]["cap"] != 1:
        raise SystemExit("V82_V69_CAPTURE_ORDER_DRIFT")

    min_md = c["targetDefinition"]["officialDateMonthDayMinimum"]
    pure0 = [r for r in calls[0]["opps"] if r["date"][5:] >= min_md and r.get("y") in (0, 1)]
    confluence0 = [r for r in calls[4]["opps"] if r["date"][5:] >= min_md and r.get("y") in (0, 1)]
    exact_general_route = [r for r in confluence0 if r["route"] == GENERAL_ROUTE]

    raw_map = {}
    for s in SEASONS:
        table = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        for raw in table["rows"]:
            if raw.get("t5PregameValid") is True:
                raw_map[(s, int(raw["gamePk"]))] = raw

    target_dates = {s: {r["date"] for r in pure0 if r["season"] == s} for s in SEASONS}
    minimum_games = int(load(a.v79_contract)["pregameStrengthDefinition"]["minimumPriorGamesPerTeam"])
    snapshots, strength_diag = v79.build_strength_snapshots(a.root, SEASONS, target_dates, minimum_games)
    pure_strength = v79.add_strength_context(pure0, raw_map, snapshots)

    enriched = []
    for r in pure_strength:
        raw = raw_map[(r["season"], int(r["gamePk"]))]
        f = raw.get("features") or {}
        cls = v69.classify(f, premium_rules, models)
        if r["side"] == "HOME":
            comp_flags = {name: finite(f.get(name)) and float(f[name]) >= float(thr) for name, thr in premium_rules.items()}
            comp_count = sum(comp_flags.values())
            c4 = float(cls["aPlusC4PHome"])
            f13 = float(cls["aPlusFull13PHome"])
            min_ap = min(c4, f13)
            exact_premium = bool(cls["premiumA"])
            exact_aplus = bool(cls["aPlus"])
        else:
            comp_flags = None
            comp_count = None
            c4 = None
            f13 = None
            min_ap = None
            exact_premium = False
            exact_aplus = False
        rr = dict(r)
        rr.update({
            "premiumComponentThresholdFlags": comp_flags,
            "premiumComponentThresholdCount": comp_count,
            "exactPremiumASelected": exact_premium,
            "exactAPlusSelected": exact_aplus,
            "aPlusC4Home": c4,
            "aPlusFull13Home": f13,
            "aPlusMinHome": min_ap,
        })
        enriched.append(rr)

    # Structural identity check: exact confluence General route cannot also be exact Premium-A HOME.
    exact_general_overlap = []
    for r in exact_general_route:
        raw = raw_map[(r["season"], int(r["gamePk"]))]
        cls = v69.classify(raw.get("features") or {}, premium_rules, models)
        if r["side"] == "HOME" and cls["premiumA"]:
            exact_general_overlap.append({"season": r["season"], "date": r["date"], "gamePk": r["gamePk"]})
    if exact_general_overlap:
        raise SystemExit(f"V82_CONFLUENCE_GENERAL_PREMIUM_OVERLAP_NOT_ZERO:{exact_general_overlap[:3]}")

    home = [r for r in enriched if r["side"] == "HOME"]
    away = [r for r in enriched if r["side"] == "AWAY"]
    premium = [r for r in home if r["exactPremiumASelected"]]
    aplus = [r for r in home if r["exactAPlusSelected"]]

    component_dose = {}
    for k in c["premiumADefinition"]["componentCountThresholds"]:
        z = [r for r in home if r["premiumComponentThresholdCount"] >= int(k)]
        component_dose[f"GE_{k}_OF_3"] = summarize(z)

    relation_breakdown = {}
    for rel in c["predeclaredCrosses"]["strengthRelations"]:
        relation_breakdown[rel] = {
            "homeBaseline": summarize(relation_filter(home, rel)),
            "exactPremiumA": summarize(relation_filter(premium, rel)),
            "exactAPlus": summarize(relation_filter(aplus, rel)),
        }

    probability_crosses = {}
    for rel in c["predeclaredCrosses"]["strengthRelations"]:
        probability_crosses[rel] = {}
        pr = relation_filter(premium, rel)
        for t in c["predeclaredCrosses"]["aPlusMinProbabilityThresholds"]:
            z = [r for r in pr if finite(r.get("aPlusMinHome")) and r["aPlusMinHome"] >= float(t)]
            probability_crosses[rel][f"PREMIUM_A_AND_APLUS_MIN_GE_{float(t):.2f}"] = summarize(z)

    serious = []
    min_serious = int(c["requiredDiagnostics"]["minimumRowsForSeriousCandidateDisplay"])
    candidates = []
    for rel, views in probability_crosses.items():
        for name, st in views.items():
            candidates.append((f"{rel}|{name}", st))
    for rel, views in relation_breakdown.items():
        candidates.append((f"{rel}|EXACT_PREMIUM_A", views["exactPremiumA"]))
        candidates.append((f"{rel}|EXACT_A_PLUS", views["exactAPlus"]))
    for name, st in candidates:
        if st["decisiveRows"] >= min_serious:
            serious.append({"name": name, **st})
    serious.sort(key=lambda x: (-(x["hitRate"] if x["hitRate"] is not None else -1), -x["decisiveRows"], x["name"]))

    selected_stronger_premium = relation_breakdown["SELECTED_STRONGER"]["exactPremiumA"]
    selected_stronger_aplus = relation_breakdown["SELECTED_STRONGER"]["exactAPlus"]
    selected_stronger_premium_min64 = probability_crosses["SELECTED_STRONGER"]["PREMIUM_A_AND_APLUS_MIN_GE_0.64"]
    selected_stronger_premium_min69 = probability_crosses["SELECTED_STRONGER"]["PREMIUM_A_AND_APLUS_MIN_GE_0.69"]

    result = {
        "schemaVersion": SCHEMA,
        "classification": "V82_GENERAL_X_PREMIUM_A_RETROSPECTIVE_DISCOVERY_COMPLETE",
        "contractStatus": c["scientificStatus"],
        "parentBlobChecks": blob_checks,
        "routingIdentity": {
            "exactConfluenceGeneralRouteRows": len(exact_general_route),
            "exactConfluenceGeneralRouteAndExactPremiumAOverlap": len(exact_general_overlap),
            "interpretation": "ZERO_EXPECTED_BY_PRIORITY; USE_PURE_GENERAL_TOP1_FOR_MEANINGFUL_PREMIUM_A_CROSS",
        },
        "pureGeneralParity": summarize(enriched),
        "pureGeneralHome": summarize(home),
        "pureGeneralAway": summarize(away),
        "premiumComponentDoseResponseHome": component_dose,
        "strengthRelationBreakdownHome": relation_breakdown,
        "premiumAPlusProbabilityCrossesHome": probability_crosses,
        "headlineViews": {
            "exactPremiumAHome": summarize(premium),
            "exactAPlusHome": summarize(aplus),
            "selectedStrongerAndExactPremiumA": selected_stronger_premium,
            "selectedStrongerAndExactPremiumAAndAPlusMinGe064": selected_stronger_premium_min64,
            "selectedStrongerAndExactPremiumAAndAPlusMinGe069": selected_stronger_premium_min69,
            "selectedStrongerAndExactAPlus": selected_stronger_aplus,
        },
        "seriousCandidatesByHistoricalHitRate": serious,
        "diagnostics": {
            "strength": strength_diag,
            "pureGeneralRows": len(enriched),
            "pureGeneralHomeRows": len(home),
            "pureGeneralAwayRows": len(away),
            "exactPremiumAHomeRows": len(premium),
            "exactAPlusHomeRows": len(aplus),
        },
        "integrity": {
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "newFeaturesSearched": False,
            "newThresholdsSearched": False,
            "premiumThresholdRelaxed": False,
            "awayPremiumASymmetrized": False,
            "v80Changed": False,
            "productionChanged": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, result)
    print(json.dumps({
        "classification": result["classification"],
        "routingIdentity": result["routingIdentity"],
        "pureGeneral": result["pureGeneralParity"],
        "home": result["pureGeneralHome"],
        "away": result["pureGeneralAway"],
        "componentDose": result["premiumComponentDoseResponseHome"],
        "headlineViews": result["headlineViews"],
        "seriousTop10": result["seriousCandidatesByHistoricalHitRate"][:10],
    }, indent=2))


if __name__ == "__main__":
    main()
