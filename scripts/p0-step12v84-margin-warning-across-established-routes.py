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
from collections import defaultdict

SCHEMA = "courtedge-p0-step12v84-margin-warning-across-established-routes.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v84-margin-warning-across-established-routes-contract.v1"
CONTRACT_STATUS = "FROZEN_CROSS_ROUTE_MARGIN_WARNING_PLAN_BEFORE_ANY_V84_SCORER_EXISTS"
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
        raise SystemExit(f"V84_IMPORT_FAILED:{path}")
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


def summary(opps):
    d = [o for o in opps if o.get("y") in (0, 1)]
    w = sum(int(o["y"]) for o in d)
    out = {
        "decisiveRows": len(d),
        "wins": w,
        "losses": len(d)-w,
        "hitRate": w/len(d) if d else None,
        "wilson95": wilson(w, len(d)),
        "bySeason": {},
    }
    for s in SEASONS:
        z = [o for o in d if o["season"] == s]
        zw = sum(int(o["y"]) for o in z)
        out["bySeason"][s] = {
            "decisiveRows": len(z),
            "wins": zw,
            "losses": len(z)-zw,
            "hitRate": zw/len(z) if z else None,
        }
    return out


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
    ap.add_argument("--v83-contract", required=True)
    ap.add_argument("--v83-scorer", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != CONTRACT_STATUS:
        raise SystemExit("V84_CONTRACT_INVALID")

    paths = {
        "v69Scorer": a.v69_scorer,
        "v69Contract": a.v69_contract,
        "v83Contract": a.v83_contract,
        "v83Scorer": a.v83_scorer,
        "frozenClassifier": a.classifier_source,
    }
    blob_checks = {}
    for key, path in paths.items():
        got = git_blob_sha(path)
        expected = c["immutableParents"][key]["gitBlobSha"]
        blob_checks[key] = {"expected": expected, "actual": got, "match": got == expected}
        if got != expected:
            raise SystemExit(f"V84_PARENT_BLOB_DRIFT:{key}:{got}:{expected}")

    v69 = module(a.v69_scorer, "v84_v69")
    classifier_version, premium_rules, _ = v69.parse_frozen_classifier_source(a.classifier_source)
    if classifier_version != c["immutableParents"]["frozenClassifier"]["requiredVersion"]:
        raise SystemExit("V84_CLASSIFIER_VERSION_DRIFT")
    expected_rules = {k: float(v) for k, v in c["warningExactly"]["premiumThresholdsExactly"].items()}
    if premium_rules != expected_rules:
        raise SystemExit(f"V84_PREMIUM_THRESHOLD_DRIFT:{premium_rules}")

    # Re-run exact frozen V69 engine while capturing immutable route opportunity lists and daily-cap outputs.
    original_stats = v69.stats
    original_daily_cap = v69.daily_cap
    homogeneous_calls = defaultdict(list)
    daily_calls = []

    def capture_stats(opps, eligible_dates, seasons, contract, include_bootstrap=True):
        copied = [dict(x) for x in opps]
        route_names = {x.get("route") for x in copied}
        if len(route_names) == 1 and copied:
            homogeneous_calls[next(iter(route_names))].append(copied)
        return original_stats(opps, eligible_dates, seasons, contract, include_bootstrap=include_bootstrap)

    def capture_daily(candidates, dates, cap):
        result = original_daily_cap(candidates, dates, cap)
        daily_calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result

    v69.stats = capture_stats
    v69.daily_cap = capture_daily
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
        v69.stats = original_stats
        v69.daily_cap = original_daily_cap
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass

    grid = [float(x) for x in load(a.v69_contract)["predeclaredConsensusScoreGrid"]]
    if not grid or abs(grid[0] - 0.55) > 1e-15:
        raise SystemExit(f"V84_V69_GRID_DRIFT:{grid[:2]}")
    expected_daily_calls = len(grid) * 8
    if len(daily_calls) != expected_daily_calls:
        raise SystemExit(f"V84_DAILY_CAPTURE_COUNT_DRIFT:{len(daily_calls)}:{expected_daily_calls}")
    if daily_calls[0]["cap"] != 1 or daily_calls[4]["cap"] != 1:
        raise SystemExit("V84_DAILY_CAPTURE_ORDER_DRIFT")

    raw_map = {}
    for s in SEASONS:
        table = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        for raw in table["rows"]:
            if raw.get("t5PregameValid") is True:
                raw_map[(s, int(raw["gamePk"]))] = raw

    special_names = [
        x for x in c["primaryEstablishedRouteViewsExactly"]
        if not x.startswith("GENERAL_CONSENSUS_TOP1") and not x.startswith("CONFLUENCE_LEDGER_TOP1")
    ]
    views = {}
    for name in special_names:
        candidates = homogeneous_calls.get(name, [])
        if not candidates:
            raise SystemExit(f"V84_ROUTE_CAPTURE_MISSING:{name}")
        # Exact route universe is the largest homogeneous V69 stats call for this route.
        views[name] = max(candidates, key=len)

    min_md = c["evaluationUniverse"]["officialDateMonthDayMinimum"]
    general_top1_home = [
        x for x in daily_calls[0]["opps"]
        if x.get("side") == "HOME" and x["date"][5:] >= min_md
    ]
    confluence_top1_home = [
        x for x in daily_calls[4]["opps"]
        if x.get("side") == "HOME" and x["date"][5:] >= min_md
    ]
    views["GENERAL_CONSENSUS_TOP1_T0.550_HOME"] = general_top1_home
    views["CONFLUENCE_LEDGER_TOP1_T0.550_HOME"] = confluence_top1_home

    # Apply the same operational season window to every route view.
    for name in list(views):
        views[name] = [x for x in views[name] if x["date"][5:] >= min_md]

    threshold = float(c["warningExactly"]["warningThresholdExactly"])
    reports = {}
    missing_margin = []
    vote_min_n = int(c["perRouteHistoricalPositiveRule"]["minimumBaselineDecisiveRowsForPrimaryVote"])

    for name in c["primaryEstablishedRouteViewsExactly"]:
        opps = views[name]
        enriched = []
        for o in opps:
            raw = raw_map.get((o["season"], int(o["gamePk"])))
            if raw is None:
                raise SystemExit(f"V84_RAW_ROW_MISSING:{name}:{o['season']}:{o['gamePk']}")
            f = raw.get("features") or {}
            margins = []
            for k, thr in expected_rules.items():
                if not finite(f.get(k)):
                    missing_margin.append({"route": name, "season": o["season"], "gamePk": o["gamePk"], "feature": k})
                    margins = []
                    break
                margins.append(float(f[k]) - float(thr))
            if not margins:
                continue
            z = dict(o)
            z["minimumPremiumMargin"] = min(margins)
            z["marginWarningFlag"] = z["minimumPremiumMargin"] <= threshold
            enriched.append(z)

        baseline = summary(enriched)
        flagged_rows = [x for x in enriched if x["marginWarningFlag"]]
        kept_rows = [x for x in enriched if not x["marginWarningFlag"]]
        flagged = summary(flagged_rows)
        kept = summary(kept_rows)

        bn = baseline["decisiveRows"]
        bw = baseline["wins"]
        bl = baseline["losses"]
        kn = kept["decisiveRows"]
        kw = kept["wins"]
        kl = kept["losses"]
        wins_removed = bw - kw
        losses_removed = bl - kl
        win_removal_rate = wins_removed / bw if bw else 0.0
        loss_removal_rate = losses_removed / bl if bl else 0.0
        coverage = kn / bn if bn else 0.0
        delta_pp = 100.0 * ((kept["hitRate"] or 0.0) - (baseline["hitRate"] or 0.0)) if bn and kn else None
        loss_to_win_lift = (loss_removal_rate / win_removal_rate) if win_removal_rate > 0 else (math.inf if loss_removal_rate > 0 else None)
        voting = bn >= vote_min_n
        positive = bool(
            voting and kn >= 20 and coverage >= 0.70 and
            kept["hitRate"] is not None and baseline["hitRate"] is not None and kept["hitRate"] > baseline["hitRate"] and
            loss_removal_rate > win_removal_rate
        )
        material_deterioration = bool(voting and delta_pp is not None and delta_pp <= -1.0)

        flagged["shareOfBaseline"] = flagged["decisiveRows"] / bn if bn else None
        kept["coverageRetained"] = coverage
        reports[name] = {
            "baseline": baseline,
            "flagged": flagged,
            "kept": kept,
            "effect": {
                "hitRateDeltaPercentagePoints": delta_pp,
                "winsRemoved": wins_removed,
                "lossesRemoved": losses_removed,
                "winRemovalRate": win_removal_rate,
                "lossRemovalRate": loss_removal_rate,
                "lossToWinRemovalLift": loss_to_win_lift,
            },
            "votingRoute": voting,
            "historicallyPositive": positive,
            "materialDeterioration": material_deterioration,
        }

    if missing_margin:
        raise SystemExit(f"V84_MARGIN_FEATURE_MISSING:{missing_margin[:5]}:TOTAL={len(missing_margin)}")

    voting = [x for x in reports.values() if x["votingRoute"]]
    positive = [x for x in voting if x["historicallyPositive"]]
    material_bad = [name for name, x in reports.items() if x["materialDeterioration"]]
    two_pp = [
        name for name, x in reports.items()
        if x["votingRoute"] and x["effect"]["hitRateDeltaPercentagePoints"] is not None and x["effect"]["hitRateDeltaPercentagePoints"] >= 2.0
    ]
    gate = c["globalConsistencyGate"]
    positive_share = len(positive)/len(voting) if voting else 0.0
    passed = bool(
        len(voting) >= int(gate["minimumVotingRoutes"]) and
        positive_share >= float(gate["minimumPositiveShareAmongVotingRoutes"]) and
        len(material_bad) <= int(gate["maximumAllowedMaterialDeteriorationRoutes"]) and
        len(two_pp) >= int(gate["minimumRoutesWithAtLeastTwoPointImprovement"])
    )
    classification = gate["passClassification"] if passed else gate["failClassification"]

    report = {
        "schemaVersion": SCHEMA,
        "classification": classification,
        "scientificInterpretation": "Retrospective transport/consistency test of a V83-derived warning threshold across frozen established route views. Passing this gate can support SHADOW diagnostic integration only, never a production veto without future prospective confirmation.",
        "warning": c["warningExactly"],
        "routeReports": reports,
        "globalConsistencyGate": {
            "passed": passed,
            "votingRoutes": len(voting),
            "positiveVotingRoutes": len(positive),
            "positiveShare": positive_share,
            "materialDeteriorationRoutes": material_bad,
            "routesWithAtLeastTwoPointImprovement": two_pp,
            "thresholds": gate,
        },
        "integrity": {
            "parentBlobChecks": blob_checks,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "newFeatureSearchPerformed": False,
            "newThresholdSearchPerformed": False,
            "warningDirectionChanged": False,
            "routeListChangedAfterOutcomeInspection": False,
            "positivityGateChangedAfterOutcomeInspection": False,
            "multiSignalCombinationSearchPerformed": False,
            "v80Changed": False,
            "productionChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, report)
    print(json.dumps({
        "classification": classification,
        "gate": report["globalConsistencyGate"],
        "routes": {
            k: {
                "baseline": [v["baseline"]["wins"], v["baseline"]["losses"], v["baseline"]["hitRate"]],
                "kept": [v["kept"]["wins"], v["kept"]["losses"], v["kept"]["hitRate"]],
                "coverage": v["kept"]["coverageRetained"],
                "deltaPP": v["effect"]["hitRateDeltaPercentagePoints"],
                "winsRemoved": v["effect"]["winsRemoved"],
                "lossesRemoved": v["effect"]["lossesRemoved"],
                "positive": v["historicallyPositive"],
            } for k, v in reports.items()
        }
    }, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
