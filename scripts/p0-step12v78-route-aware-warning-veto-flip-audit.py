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
from collections import Counter, defaultdict

import numpy as np

SCHEMA = "courtedge-p0-step12v78-route-aware-warning-veto-flip-audit.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v78-route-aware-warning-veto-flip-audit-contract.v1"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V78_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tertile_label(v, q1, q2):
    if v <= q1:
        return "LOW"
    if v <= q2:
        return "MID"
    return "HIGH"


def opposite(side):
    if side == "HOME":
        return "AWAY"
    if side == "AWAY":
        return "HOME"
    raise SystemExit(f"V78_INVALID_SIDE:{side}")


def flip_row(r):
    z = dict(r)
    z["originalSide"] = r["side"]
    z["side"] = opposite(r["side"])
    z["counterSide"] = z["side"]
    z["originalY"] = r["y"]
    z["y"] = None if r["y"] is None else 1 - int(r["y"])
    z["counterSideCounterfactual"] = True
    return z


def summarize(rows, baseline_pick_days, seasons):
    decisive = [r for r in rows if r["y"] is not None]
    wins = sum(r["y"] == 1 for r in decisive)
    losses = sum(r["y"] == 0 for r in decisive)
    pushes = len(rows) - len(decisive)
    dates = {r["date"] for r in rows}
    by_season = {}
    for s in seasons:
        sr = [r for r in rows if r["season"] == s]
        sd = [r for r in sr if r["y"] is not None]
        sw = sum(r["y"] == 1 for r in sd)
        by_season[s] = {
            "opportunities": len(sr),
            "decisiveRows": len(sd),
            "wins": sw,
            "losses": len(sd)-sw,
            "pushes": len(sr)-len(sd),
            "decisiveHitRate": sw/len(sd) if sd else None,
        }
    return {
        "opportunities": len(rows),
        "activePickDays": len(dates),
        "baselinePickDays": baseline_pick_days,
        "coverageVsBaselinePickDays": len(dates)/baseline_pick_days if baseline_pick_days else None,
        "decisiveRows": len(decisive),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "decisiveHitRate": wins/len(decisive) if decisive else None,
        "bySeason": by_season,
        "marketMix": dict(sorted(Counter(r["market"] for r in rows).items())),
        "routeMix": dict(sorted(Counter(r["route"] for r in rows).items())),
    }


def flag_summary(rows, flag_name, baseline_losses, route_losses):
    z = [r for r in rows if r.get(flag_name) is True]
    zd = [r for r in z if r["y"] is not None]
    w = sum(r["y"] == 1 for r in zd)
    l = sum(r["y"] == 0 for r in zd)
    return {
        "flaggedRows": len(z),
        "flaggedDecisiveRows": len(zd),
        "flaggedOriginalWins": w,
        "flaggedOriginalLosses": l,
        "flaggedPushes": len(z)-len(zd),
        "counterSideHistoricalPrecisionAmongFlaggedDecisive": l/len(zd) if zd else None,
        "lossCaptureRateOfAll138": l/baseline_losses if baseline_losses else None,
        "lossCaptureRateWithinApplicableRoute": l/route_losses if route_losses else None,
        "winsDestroyedIfFlipped": w,
        "lossesConvertedToWinsIfFlipped": l,
        "netCorrectDecisionChangeIfFlipped": l-w,
    }


def policy(rows, flag_name, action):
    out = []
    for r in rows:
        flagged = r.get(flag_name) is True
        if action == "KEEP":
            out.append(dict(r))
        elif action == "VETO":
            if not flagged:
                out.append(dict(r))
        elif action == "FLIP":
            out.append(flip_row(r) if flagged else dict(r))
        else:
            raise SystemExit(f"V78_UNKNOWN_ACTION:{action}")
    return out


def by_route_flag(rows, flag_name):
    out = {}
    for route in sorted({r["route"] for r in rows}):
        rr = [r for r in rows if r["route"] == route and r.get(flag_name) is True]
        dec = [r for r in rr if r["y"] is not None]
        out[route] = {
            "flaggedRows": len(rr),
            "wins": sum(r["y"] == 1 for r in dec),
            "losses": sum(r["y"] == 0 for r in dec),
            "pushes": len(rr)-len(dec),
            "counterSideHistoricalPrecision": sum(r["y"] == 0 for r in dec)/len(dec) if dec else None,
        }
    return out


def by_season_flag(rows, flag_name):
    out = {}
    for s in ("2024", "2025", "2026_YTD"):
        rr = [r for r in rows if r["season"] == s and r.get(flag_name) is True]
        dec = [r for r in rr if r["y"] is not None]
        out[s] = {
            "flaggedRows": len(rr),
            "wins": sum(r["y"] == 1 for r in dec),
            "losses": sum(r["y"] == 0 for r in dec),
            "pushes": len(rr)-len(dec),
            "counterSideHistoricalPrecision": sum(r["y"] == 0 for r in dec)/len(dec) if dec else None,
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
    ap.add_argument("--v72-scorer", required=True)
    ap.add_argument("--v77-scorer", required=True)
    ap.add_argument("--v77-summary", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_ROUTE_AWARE_VETO_AND_COUNTERSIDE_AUDIT_BEFORE_ANY_V78_SCORER_EXISTS":
        raise SystemExit("V78_CONTRACT_INVALID")
    for k in (
        "refitAllowed","recalibrationAllowed","newFeatureSearchAllowed","thresholdSearchAllowed","routeSearchAllowed",
        "dateCutoffSearchAllowed","outcomeWeightedCompositeAllowed","policySelectionAfterOutcomeInspectionAllowed",
        "claimIndependentConfirmationAllowed","claimCausationAllowed","liveVetoCreatedByV78","liveCounterSideSwitchCreatedByV78"
    ):
        if c["statisticsBoundary"].get(k) is not False:
            raise SystemExit(f"V78_BOUNDARY_INVALID:{k}")
    for key, path in (("v69Scorer",a.v69_scorer),("v72Scorer",a.v72_scorer),("v77Scorer",a.v77_scorer)):
        if git_blob_sha(path) != c["immutableParentEvidence"][key]["gitBlobSha"]:
            raise SystemExit(f"V78_PARENT_BLOB_DRIFT:{key}")

    v77s = load(a.v77_summary)
    expected77 = c["immutableParentEvidence"]["v77Summary"]
    if v77s.get("classification") != expected77["requiredClassification"]:
        raise SystemExit("V78_V77_CLASSIFICATION_DRIFT")
    if v77s.get("parentParity") != expected77["parentParity"] or v77s.get("routeParity") != expected77["routeParity"]:
        raise SystemExit("V78_V77_PARITY_DRIFT")

    v69 = module(a.v69_scorer, "v78_v69")
    v72 = module(a.v72_scorer, "v78_v72")
    v77 = module(a.v77_scorer, "v78_v77")
    v69c = load(a.v69_contract)
    seasons = ("2024", "2025", "2026_YTD")
    feature_map, _ = v72.load_feature_map(a.root, seasons, v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"])
    custody_map = v72.load_custody_map(a.custody)

    original_daily_cap = v69.daily_cap
    calls = []
    def capture(candidates, dates, cap):
        result = original_daily_cap(candidates, dates, cap)
        calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result
    v69.daily_cap = capture
    parent_out = a.out + ".parent-v69.json"
    old = sys.argv[:]
    sys.argv = [a.v69_scorer,"--root",a.root,"--custody",a.custody,"--v16-manifest",a.v16_manifest,"--v68-contract",a.v68_contract,"--classifier-source",a.classifier_source,"--router-source",a.router_source,"--contract",a.v69_contract,"--out",parent_out]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            v69.main()
    finally:
        sys.argv = old
    if len(calls) != len(v69c["predeclaredConsensusScoreGrid"]) * 8 or calls[4]["cap"] != 1:
        raise SystemExit("V78_V69_CAPTURE_DRIFT")
    top1 = calls[4]["opps"]
    rows0 = [o for o in top1 if o["date"][5:] >= "05-01"]
    pp = c["parentPortfolio"]
    parity = {
        "pickDays": len(rows0),
        "decisiveRows": sum(r["y"] is not None for r in rows0),
        "wins": sum(r["y"] == 1 for r in rows0),
        "losses": sum(r["y"] == 0 for r in rows0),
        "pushes": sum(r["y"] is None for r in rows0),
    }
    if parity != {"pickDays":pp["expectedPickDays"],"decisiveRows":pp["expectedDecisiveRows"],"wins":pp["expectedWins"],"losses":pp["expectedLosses"],"pushes":pp["expectedPushes"]}:
        raise SystemExit(f"V78_PARENT_PARITY_FAILED:{parity}")

    directional = load("research/p0-step12v77-general-consensus-loss-threat-geometry-contract.json")["directionalOpponentWarningSignalsExactly"]
    enriched = v72.enrich_top1(rows0, feature_map, custody_map, directional, ["consensusScore","p16Selected","p68Selected","p68MinusP16Selected","classifierScore","routePriority"])

    general_route = "V16_V68_CONSENSUS_T0.550"
    premium_route = "PREMIUM_A_V68_AGREE_ROUTE_SWITCH"
    aplus_route = "A_PLUS_V68_AGREE_D1_ROUTER"
    general = [r for r in enriched if r["route"] == general_route]
    if any(r["y"] is None for r in general) or len(general) != 223:
        raise SystemExit("V78_GENERAL_ROUTE_SHAPE_DRIFT")
    general_idx = v77.add_threat_indexes(general, load("research/p0-step12v77-general-consensus-loss-threat-geometry-contract.json"))
    gmap = {(r["season"],int(r["gamePk"])):r for r in general_idx}
    threat_vals = [float(r["allSignalThreatIndex"]) for r in general_idx if finite(r.get("allSignalThreatIndex"))]
    consensus_vals = [float(r["modelConviction"]["consensusScore"]) for r in general_idx if finite(r["modelConviction"].get("consensusScore"))]
    lineup_vals = [float(r["opponentWarning"]["lineup_exposure_rate_adv"]) for r in general_idx if finite(r["opponentWarning"].get("lineup_exposure_rate_adv"))]
    tq33,tq67 = float(np.quantile(threat_vals,1/3)),float(np.quantile(threat_vals,2/3))
    cq33,cq67 = float(np.quantile(consensus_vals,1/3)),float(np.quantile(consensus_vals,2/3))
    lq33,lq67 = float(np.quantile(lineup_vals,1/3)),float(np.quantile(lineup_vals,2/3))

    rows = []
    for r0 in enriched:
        r = dict(r0)
        key = (r["season"],int(r["gamePk"]))
        r["allSignalThreatIndex"] = None
        if r["route"] == general_route:
            gr = gmap[key]
            r["allSignalThreatIndex"] = gr.get("allSignalThreatIndex")
            r["generalPrimaryFlag"] = bool(
                finite(r["allSignalThreatIndex"]) and tertile_label(float(r["allSignalThreatIndex"]),tq33,tq67)=="HIGH"
                and finite(r["modelConviction"].get("consensusScore")) and tertile_label(float(r["modelConviction"]["consensusScore"]),cq33,cq67)=="LOW"
            )
            r["generalRedCornerFlag"] = bool(
                finite(r["opponentWarning"].get("lineup_exposure_rate_adv")) and tertile_label(float(r["opponentWarning"]["lineup_exposure_rate_adv"]),lq33,lq67)=="HIGH"
                and finite(r["modelConviction"].get("consensusScore")) and tertile_label(float(r["modelConviction"]["consensusScore"]),cq33,cq67)=="LOW"
            )
        else:
            r["generalPrimaryFlag"] = False
            r["generalRedCornerFlag"] = False
        r["premiumHrFlag"] = bool(r["route"]==premium_route and finite(r["opponentWarning"].get("starter_hr_adv")) and float(r["opponentWarning"]["starter_hr_adv"])>0.0)
        r["combinedPrimaryFlag"] = bool(r["generalPrimaryFlag"] or r["premiumHrFlag"])
        rows.append(r)

    route_parity = {}
    for route in (aplus_route,premium_route,general_route):
        rr=[r for r in rows if r["route"]==route and r["y"] is not None]
        route_parity[route]={"decisiveRows":len(rr),"wins":sum(r["y"]==1 for r in rr),"losses":sum(r["y"]==0 for r in rr)}
    if route_parity != expected77["routeParity"]:
        raise SystemExit(f"V78_ROUTE_PARITY_FAILED:{route_parity}")

    policy_specs = {
        "BASELINE_KEEP": ("combinedPrimaryFlag","KEEP"),
        "PRIMARY_VETO": ("combinedPrimaryFlag","VETO"),
        "PRIMARY_COUNTERSIDE_FLIP": ("combinedPrimaryFlag","FLIP"),
        "GENERAL_PRIMARY_VETO_ONLY": ("generalPrimaryFlag","VETO"),
        "GENERAL_PRIMARY_COUNTERSIDE_ONLY": ("generalPrimaryFlag","FLIP"),
        "GENERAL_RED_CORNER_COMPARATOR_VETO": ("generalRedCornerFlag","VETO"),
        "GENERAL_RED_CORNER_COMPARATOR_FLIP": ("generalRedCornerFlag","FLIP"),
        "PREMIUM_HR_VETO_ONLY": ("premiumHrFlag","VETO"),
        "PREMIUM_HR_COUNTERSIDE_ONLY": ("premiumHrFlag","FLIP"),
    }
    policies = {}
    for name,(flag,action) in policy_specs.items():
        pr = policy(rows, flag, action)
        sm = summarize(pr, parity["pickDays"], seasons)
        sm["action"] = action
        sm["flag"] = flag
        if action in ("VETO","FLIP"):
            fs = flag_summary(rows, flag, parity["losses"], parity["losses"])
            sm["flagEffect"] = fs
            if action=="VETO":
                sm["lossesAvoidedByVeto"] = fs["flaggedOriginalLosses"]
                sm["winsSacrificedByVeto"] = fs["flaggedOriginalWins"]
            else:
                sm["lossesConvertedToWinsByCounterSide"] = fs["lossesConvertedToWinsIfFlipped"]
                sm["winsConvertedToLossesByCounterSide"] = fs["winsDestroyedIfFlipped"]
                sm["netCorrectDecisionChange"] = fs["netCorrectDecisionChangeIfFlipped"]
        policies[name]=sm

    baseline_hit = policies["BASELINE_KEEP"]["decisiveHitRate"]
    for name,pv in policies.items():
        pv["hitRateDeltaVsBaseline"] = (pv["decisiveHitRate"]-baseline_hit) if pv["decisiveHitRate"] is not None else None
        pv["winsDeltaVsBaseline"] = pv["wins"]-policies["BASELINE_KEEP"]["wins"]
        pv["lossesDeltaVsBaseline"] = pv["losses"]-policies["BASELINE_KEEP"]["losses"]

    flag_diagnostics = {}
    route_loss_denoms = {route:vals["losses"] for route,vals in route_parity.items()}
    for flag, route_for_denom in (("generalPrimaryFlag",general_route),("generalRedCornerFlag",general_route),("premiumHrFlag",premium_route),("combinedPrimaryFlag",None)):
        denom = parity["losses"] if route_for_denom is None else route_loss_denoms[route_for_denom]
        fs = flag_summary(rows,flag,parity["losses"],denom)
        fs["byRoute"] = by_route_flag(rows,flag)
        fs["bySeason"] = by_season_flag(rows,flag)
        flag_diagnostics[flag]=fs

    flagged_loss_ledger=[]
    for r in rows:
        if r["y"]==0 and r["combinedPrimaryFlag"]:
            flagged_loss_ledger.append({
                "season":r["season"],"date":r["date"],"gamePk":r["gamePk"],"route":r["route"],"market":r["market"],
                "originalSide":r["side"],"counterSide":opposite(r["side"]),
                "generalPrimaryFlag":r["generalPrimaryFlag"],"premiumHrFlag":r["premiumHrFlag"],
                "allSignalThreatIndex":r.get("allSignalThreatIndex"),
                "consensusScore":r["modelConviction"].get("consensusScore"),
                "lineupExposureOpponentWarning":r["opponentWarning"].get("lineup_exposure_rate_adv"),
                "starterHrOpponentWarning":r["opponentWarning"].get("starter_hr_adv"),
                "oracleFact": "Because the original decisive ML side lost, the exact opposite side in the same market/horizon won historically. This row is listed only because the pregame warning flag was already defined independently of this row's outcome within V78."
            })
    flagged_loss_ledger.sort(key=lambda x:(x["date"],x["gamePk"]))

    report={
        "schemaVersion":SCHEMA,
        "classification":"V78_ROUTE_AWARE_WARNING_VETO_FLIP_RETROSPECTIVE_AUDIT_COMPLETE",
        "parentParity":parity,
        "routeParity":route_parity,
        "oracleCounterfactualCeiling":{
            "decisiveHistoricalLosses":parity["losses"],
            "oppositeSideWouldMechanicallyWinAllDecisiveLosses":parity["losses"],
            "interpretation":"138/138 is an impossible hindsight ceiling, not model skill. V78's actionable question is whether pregame flags identify a subset where counter-side switching wins more often than it destroys original wins."
        },
        "outcomeBlindCutpoints":{
            "generalAllSignalThreatQ33":tq33,"generalAllSignalThreatQ67":tq67,
            "generalConsensusScoreQ33":cq33,"generalConsensusScoreQ67":cq67,
            "generalLineupWarningQ33":lq33,"generalLineupWarningQ67":lq67,
        },
        "flagDiagnostics":flag_diagnostics,
        "policies":policies,
        "combinedPrimaryFlaggedHistoricalLossLedger":flagged_loss_ledger,
        "guardrails":{
            "retrospectiveAdaptiveDiscoveryOnly":True,"strictlyPregameFlagInputsOnly":True,"oracleCeilingNotActionable":True,
            "outcomeThresholdSearchPerformed":False,"outcomeWeightedCompositePerformed":False,"bestPolicySelectedAfterOutcomes":False,
            "liveVetoCreated":False,"liveCounterSideSwitchCreated":False,"historicalPricesUsed":False,"marketOddsUsedAsFeatures":False,
            "productionChanged":False,"prospectiveV68Changed":False,"routingChanged":False,"rankingChanged":False,"stakeChanged":False,
            "betEliteAllowed":False,"positiveEvEstablished":False,"realFinancialExposure":0
        },
        "scientificInterpretation":"V78 quantifies the historical tradeoff of route-aware pregame warning flags as either vetoes or exact opposite-side switches. Because V78 was motivated by V77 outcome-inspected findings and is evaluated on the same historical window, any apparent improvement remains adaptive retrospective evidence only. A useful candidate must show favorable loss capture versus win destruction and acceptable season behavior before it can justify a separately frozen fresh-data validation."
    }
    dump(a.out,report)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass
    print(json.dumps({
        "classification":report["classification"],
        "oracleCeiling":report["oracleCounterfactualCeiling"],
        "flags":{k:{x:v[x] for x in ("flaggedRows","flaggedOriginalWins","flaggedOriginalLosses","counterSideHistoricalPrecisionAmongFlaggedDecisive","netCorrectDecisionChangeIfFlipped")} for k,v in flag_diagnostics.items()},
        "policies":{k:{"n":v["opportunities"],"w":v["wins"],"l":v["losses"],"p":v["pushes"],"hit":v["decisiveHitRate"],"coverage":v["coverageVsBaselinePickDays"],"delta":v["hitRateDeltaVsBaseline"]} for k,v in policies.items()}
    },indent=2))


if __name__=="__main__":
    main()
