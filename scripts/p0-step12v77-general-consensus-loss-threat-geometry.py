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
from scipy.stats import mannwhitneyu, rankdata

SCHEMA = "courtedge-p0-step12v77-general-consensus-loss-threat-geometry.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v77-general-consensus-loss-threat-geometry-contract.v1"


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
        raise SystemExit(f"V77_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cliffs_delta(losses, wins):
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return None
    greater = 0
    less = 0
    for x in a:
        greater += int(np.sum(x > b))
        less += int(np.sum(x < b))
    return float((greater - less) / (len(a) * len(b)))


def auc_loss_warning(losses, wins):
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return None
    greater = 0
    ties = 0
    for x in a:
        greater += int(np.sum(x > b))
        ties += int(np.sum(x == b))
    return float((greater + 0.5 * ties) / (len(a) * len(b)))


def bootstrap_diff(losses, wins, resamples, seed):
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return {"pointEstimateLossMinusWin": None, "ci95": [None, None], "resamples": resamples, "seed": seed}
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    for i in range(resamples):
        aa = a[rng.integers(0, len(a), size=len(a))]
        bb = b[rng.integers(0, len(b), size=len(b))]
        vals[i] = float(aa.mean() - bb.mean())
    return {
        "pointEstimateLossMinusWin": float(a.mean() - b.mean()),
        "ci95": [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))],
        "resamples": resamples,
        "seed": seed,
    }


def continuous_analysis(rows, getter, resamples, seed):
    wins = [float(getter(r)) for r in rows if r["y"] == 1 and finite(getter(r))]
    losses = [float(getter(r)) for r in rows if r["y"] == 0 and finite(getter(r))]
    p = float(mannwhitneyu(losses, wins, alternative="two-sided", method="asymptotic").pvalue) if losses and wins else None
    return {
        "nWins": len(wins),
        "nLosses": len(losses),
        "medianWins": float(np.median(wins)) if wins else None,
        "medianLosses": float(np.median(losses)) if losses else None,
        "iqrWins": [float(np.quantile(wins, .25)), float(np.quantile(wins, .75))] if wins else [None, None],
        "iqrLosses": [float(np.quantile(losses, .25)), float(np.quantile(losses, .75))] if losses else [None, None],
        "meanWins": float(np.mean(wins)) if wins else None,
        "meanLosses": float(np.mean(losses)) if losses else None,
        "mannWhitneyTwoSidedP": p,
        "cliffsDeltaLossMinusWin": cliffs_delta(losses, wins),
        "lossWarningAuc": auc_loss_warning(losses, wins),
        "bootstrapMeanDifferenceLossMinusWin": bootstrap_diff(losses, wins, resamples, seed),
    }


def percentile_rank_map(rows, signals):
    maps = {}
    for name in signals:
        pairs = [(i, float(r["opponentWarning"][name])) for i, r in enumerate(rows) if finite(r["opponentWarning"].get(name))]
        vals = np.asarray([v for _, v in pairs], dtype=float)
        ranks = rankdata(vals, method="average") / len(vals) if len(vals) else np.asarray([])
        maps[name] = {idx: float(rank) for (idx, _), rank in zip(pairs, ranks)}
    return maps


def add_threat_indexes(rows, contract):
    signals = contract["directionalOpponentWarningSignalsExactly"]
    domains = contract["signalDomainsExactly"]
    ranks = percentile_rank_map(rows, signals)
    min_all = int(contract["allSignalThreatIndex"]["minimumNonmissingSignals"])
    out = []
    for i, r in enumerate(rows):
        rr = dict(r)
        all_vals = [ranks[name][i] for name in signals if i in ranks[name]]
        rr["allSignalThreatIndex"] = float(np.mean(all_vals)) if len(all_vals) >= min_all else None
        rr["domainThreatIndex"] = {}
        for domain, names in domains.items():
            vals = [ranks[name][i] for name in names if i in ranks[name]]
            rr["domainThreatIndex"][domain] = float(np.mean(vals)) if vals else None
        out.append(rr)
    return out


def tertile_label(v, q1, q2):
    if v <= q1:
        return "LOW"
    if v <= q2:
        return "MID"
    return "HIGH"


def summarize_bucket(rows):
    n = len(rows)
    wins = sum(r["y"] == 1 for r in rows)
    losses = sum(r["y"] == 0 for r in rows)
    return {"rows": n, "wins": wins, "losses": losses, "historicalLossRate": losses / n if n else None}


def tertile_analysis(rows, getter):
    vals = [float(getter(r)) for r in rows if finite(getter(r))]
    q1 = float(np.quantile(vals, 1/3))
    q2 = float(np.quantile(vals, 2/3))
    buckets = {}
    for label in ("LOW", "MID", "HIGH"):
        z = [r for r in rows if finite(getter(r)) and tertile_label(float(getter(r)), q1, q2) == label]
        buckets[label] = summarize_bucket(z)
    return {"cutpoints": {"q33": q1, "q67": q2}, "buckets": buckets}


def threat_matrix(rows):
    lw = [float(r["opponentWarning"]["lineup_exposure_rate_adv"]) for r in rows if finite(r["opponentWarning"].get("lineup_exposure_rate_adv"))]
    cv = [float(r["modelConviction"]["consensusScore"]) for r in rows if finite(r["modelConviction"].get("consensusScore"))]
    lq1, lq2 = float(np.quantile(lw, 1/3)), float(np.quantile(lw, 2/3))
    cq1, cq2 = float(np.quantile(cv, 1/3)), float(np.quantile(cv, 2/3))
    cells = {}
    for l in ("LOW", "MID", "HIGH"):
        cells[l] = {}
        for c in ("LOW", "MID", "HIGH"):
            z = [r for r in rows if finite(r["opponentWarning"].get("lineup_exposure_rate_adv")) and finite(r["modelConviction"].get("consensusScore")) and tertile_label(float(r["opponentWarning"]["lineup_exposure_rate_adv"]), lq1, lq2) == l and tertile_label(float(r["modelConviction"]["consensusScore"]), cq1, cq2) == c]
            cells[l][c] = summarize_bucket(z)
    red = cells["HIGH"]["LOW"]
    comparison = cells["LOW"]["HIGH"]
    total_losses = sum(r["y"] == 0 for r in rows)
    for l in cells:
        for c in cells[l]:
            cells[l][c]["shareOfPrimaryRouteLosses"] = cells[l][c]["losses"] / total_losses if total_losses else None
    by_season = {}
    for s in sorted({r["season"] for r in rows}):
        sr = [r for r in rows if r["season"] == s and finite(r["opponentWarning"].get("lineup_exposure_rate_adv")) and finite(r["modelConviction"].get("consensusScore"))]
        rred = [r for r in sr if tertile_label(float(r["opponentWarning"]["lineup_exposure_rate_adv"]), lq1, lq2) == "HIGH" and tertile_label(float(r["modelConviction"]["consensusScore"]), cq1, cq2) == "LOW"]
        rcmp = [r for r in sr if tertile_label(float(r["opponentWarning"]["lineup_exposure_rate_adv"]), lq1, lq2) == "LOW" and tertile_label(float(r["modelConviction"]["consensusScore"]), cq1, cq2) == "HIGH"]
        by_season[s] = {"redCorner": summarize_bucket(rred), "comparisonCorner": summarize_bucket(rcmp)}
    return {
        "cutpoints": {"lineupWarningQ33": lq1, "lineupWarningQ67": lq2, "consensusScoreQ33": cq1, "consensusScoreQ67": cq2},
        "cells": cells,
        "redCorner": red,
        "comparisonCorner": comparison,
        "riskRatioRedVsComparison": (red["historicalLossRate"] / comparison["historicalLossRate"]) if red["historicalLossRate"] is not None and comparison["historicalLossRate"] not in (None, 0) else None,
        "lossRateDifferenceRedMinusComparison": (red["historicalLossRate"] - comparison["historicalLossRate"]) if red["historicalLossRate"] is not None and comparison["historicalLossRate"] is not None else None,
        "bySeasonUsingGlobalFrozenCutpoints": by_season,
    }


def robust_labels(signal_results, contract):
    label = contract["statisticalPlan"]["predeclaredStrongAssociationLabel"]
    out = []
    for name, r in signal_results.items():
        if (
            finite(r.get("holm_adjusted_p_across_directional_signal_family"))
            and r["holm_adjusted_p_across_directional_signal_family"] < float(label["holmAdjustedPLt"])
            and finite(r.get("cliffs_delta_loss_minus_win"))
            and abs(r["cliffs_delta_loss_minus_win"]) >= float(label["minimumAbsoluteCliffsDelta"])
            and finite(r.get("loss_warning_univariate_auc"))
            and r["loss_warning_univariate_auc"] >= float(label["minimumLossWarningAuc"])
            and r.get("median_losses") is not None and r.get("median_wins") is not None and r["median_losses"] > r["median_wins"]
            and r["seasonal_direction_check"]["lossGreaterThanWinInAllSeasons"] is True
        ):
            out.append(name)
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
    ap.add_argument("--v72-summary", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_GENERAL_CONSENSUS_LOSS_THREAT_GEOMETRY_BEFORE_ANY_V77_SCORER_EXISTS":
        raise SystemExit("V77_CONTRACT_INVALID")
    for k in ("refitAllowed", "recalibrationAllowed", "featureAdditionAfterOutcomeInspectionAllowed", "featureRemovalAfterOutcomeInspectionAllowed", "thresholdSearchAllowed", "routeSearchAllowed", "dateCutoffSearchAllowed", "outcomeWeightedCompositeAllowed", "liveVetoCreatedByV77", "causalClaimAllowed"):
        if c["statisticsBoundary"].get(k) is not False:
            raise SystemExit(f"V77_BOUNDARY_INVALID:{k}")
    if git_blob_sha(a.v69_scorer) != c["immutableParentEvidence"]["v69Scorer"]["gitBlobSha"]:
        raise SystemExit("V77_V69_SCORER_BLOB_DRIFT")
    if git_blob_sha(a.v72_scorer) != c["immutableParentEvidence"]["v72Scorer"]["gitBlobSha"]:
        raise SystemExit("V77_V72_SCORER_BLOB_DRIFT")
    v72s = load(a.v72_summary)
    ev = c["immutableParentEvidence"]["v72Summary"]
    if v72s.get("classification") != ev["requiredClassification"]:
        raise SystemExit("V77_V72_SUMMARY_CLASSIFICATION_DRIFT")
    src = v72s.get("sourceArtifact") or {}
    if int(src.get("workflowRunId", -1)) != int(ev["sourceWorkflowRunId"]) or int(src.get("artifactId", -1)) != int(ev["sourceArtifactId"]) or src.get("artifactDigest") != ev["sourceArtifactDigest"]:
        raise SystemExit("V77_V72_CUSTODY_DRIFT")

    v72 = module(a.v72_scorer, "v77_v72_parent")
    v69 = module(a.v69_scorer, "v77_v69_parent")
    v69c = load(a.v69_contract)
    seasons = ("2024", "2025", "2026_YTD")
    feature_map, eligible_dates = v72.load_feature_map(a.root, seasons, v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"])
    custody_map = v72.load_custody_map(a.custody)

    original_daily_cap = v69.daily_cap
    calls = []
    dates_seen = None
    def capture(candidates, dates, cap):
        nonlocal dates_seen
        result = original_daily_cap(candidates, dates, cap)
        if dates_seen is None:
            dates_seen = set(dates)
        elif set(dates) != dates_seen:
            raise SystemExit("V77_V69_DATE_SET_DRIFT")
        calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result
    v69.daily_cap = capture
    parent_out = a.out + ".parent-v69.json"
    old = sys.argv[:]
    sys.argv = [a.v69_scorer, "--root", a.root, "--custody", a.custody, "--v16-manifest", a.v16_manifest, "--v68-contract", a.v68_contract, "--classifier-source", a.classifier_source, "--router-source", a.router_source, "--contract", a.v69_contract, "--out", parent_out]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            v69.main()
    finally:
        sys.argv = old
    if len(calls) != len(v69c["predeclaredConsensusScoreGrid"]) * 8 or calls[4]["cap"] != 1:
        raise SystemExit("V77_V69_CAPTURE_SHAPE_DRIFT")
    top1 = calls[4]["opps"]
    may01 = [o for o in top1 if o["date"][5:] >= "05-01"]
    p = c["parentPortfolio"]
    parity = {"pickDays": len(may01), "decisiveRows": sum(o["y"] is not None for o in may01), "wins": sum(o["y"] == 1 for o in may01), "losses": sum(o["y"] == 0 for o in may01), "pushes": sum(o["y"] is None for o in may01)}
    expected = {"pickDays": p["expectedPickDays"], "decisiveRows": p["expectedDecisiveRows"], "wins": p["expectedWins"], "losses": p["expectedLosses"], "pushes": p["expectedPushes"]}
    if parity != expected:
        raise SystemExit(f"V77_MAY01_PARENT_PARITY_FAILED:{parity}")

    enriched = v72.enrich_top1(may01, feature_map, custody_map, c["directionalOpponentWarningSignalsExactly"], ["consensusScore", "p16Selected", "p68Selected", "p68MinusP16Selected", "classifierScore", "routePriority"])
    decisive = [r for r in enriched if r["y"] is not None]
    route_parity = {}
    for route in p["routeParity"]:
        z = [r for r in decisive if r["route"] == route]
        route_parity[route] = {"wins": sum(r["y"] == 1 for r in z), "losses": sum(r["y"] == 0 for r in z), "decisiveRows": len(z)}
        e = p["routeParity"][route]
        if route_parity[route]["wins"] != e["wins"] or route_parity[route]["losses"] != e["losses"]:
            raise SystemExit(f"V77_ROUTE_PARITY_FAILED:{route}:{route_parity[route]}")

    primary = [r for r in decisive if r["route"] == c["primaryRoute"]["id"]]
    ep = c["primaryRoute"]
    if len(primary) != ep["expectedDecisiveRows"] or sum(r["y"] == 1 for r in primary) != ep["expectedWins"] or sum(r["y"] == 0 for r in primary) != ep["expectedLosses"]:
        raise SystemExit("V77_PRIMARY_ROUTE_PARITY_FAILED")

    sp = c["statisticalPlan"]
    signal_results = v72.signal_analysis(primary, c["directionalOpponentWarningSignalsExactly"], "opponentWarning", sp["bootstrapResamples"], sp["bootstrapSeed"], True)
    robust = robust_labels(signal_results, c)
    ranking = sorted(c["directionalOpponentWarningSignalsExactly"], key=lambda name: (
        signal_results[name]["holm_adjusted_p_across_directional_signal_family"] if finite(signal_results[name]["holm_adjusted_p_across_directional_signal_family"]) else 2.0,
        -(signal_results[name]["loss_warning_univariate_auc"] if finite(signal_results[name]["loss_warning_univariate_auc"]) else -1.0), name))

    primary = add_threat_indexes(primary, c)
    domain_analyses = {}
    domain_tertiles = {}
    for i, domain in enumerate(c["signalDomainsExactly"]):
        domain_analyses[domain] = continuous_analysis(primary, lambda r, d=domain: r["domainThreatIndex"].get(d), sp["bootstrapResamples"], sp["bootstrapSeed"] + 200 + i)
        domain_tertiles[domain] = tertile_analysis(primary, lambda r, d=domain: r["domainThreatIndex"].get(d))
    all_index_analysis = continuous_analysis(primary, lambda r: r.get("allSignalThreatIndex"), sp["bootstrapResamples"], sp["bootstrapSeed"] + 300)
    all_index_tertiles = tertile_analysis(primary, lambda r: r.get("allSignalThreatIndex"))
    matrix = threat_matrix(primary)

    conviction = {}
    for i, name in enumerate(c["modelConvictionSignalsExactly"]):
        # Convert to warning orientation so larger = lower conviction.
        conviction[name] = continuous_analysis(primary, lambda r, n=name: -float(r["modelConviction"][n]) if finite(r["modelConviction"].get(n)) else None, sp["bootstrapResamples"], sp["bootstrapSeed"] + 400 + i)

    references = {}
    for ri, route in enumerate(("A_PLUS_V68_AGREE_D1_ROUTER", "PREMIUM_A_V68_AGREE_ROUTE_SWITCH")):
        rr = [r for r in decisive if r["route"] == route]
        references[route] = {
            "parity": route_parity[route],
            "directionalOpponentWarningSignalAnalysis": v72.signal_analysis(rr, c["directionalOpponentWarningSignalsExactly"], "opponentWarning", sp["bootstrapResamples"], sp["bootstrapSeed"] + 1000 + ri * 100, True),
        }

    # Loss-profile accounting on predeclared matrix corners, descriptive only.
    red_losses = matrix["redCorner"]["losses"]
    comp_losses = matrix["comparisonCorner"]["losses"]
    report = {
        "schemaVersion": SCHEMA,
        "classification": "V77_GENERAL_CONSENSUS_LOSS_THREAT_GEOMETRY_RETROSPECTIVE_COMPLETE",
        "parentParity": parity,
        "routeParity": route_parity,
        "primaryRoute": {
            "id": ep["id"],
            "decisiveRows": len(primary),
            "wins": sum(r["y"] == 1 for r in primary),
            "losses": sum(r["y"] == 0 for r in primary),
            "shareOfAllMay01Losses": sum(r["y"] == 0 for r in primary) / parity["losses"],
            "directionalOpponentWarningSignalAnalysis": signal_results,
            "predeclaredStrongAssociationSignals": robust,
            "signalRankingByHolmThenAuc": ranking,
            "modelLowConvictionWarningAnalysis": conviction,
            "domainThreatIndexAnalysis": domain_analyses,
            "domainThreatIndexTertiles": domain_tertiles,
            "allSignalThreatIndexAnalysis": all_index_analysis,
            "allSignalThreatIndexTertiles": all_index_tertiles,
            "lineupWarningByConsensusScoreMatrix": matrix,
            "lossProfileAccounting": {
                "redCornerLosses": red_losses,
                "redCornerShareOf95Losses": red_losses / ep["expectedLosses"],
                "comparisonCornerLosses": comp_losses,
                "comparisonCornerShareOf95Losses": comp_losses / ep["expectedLosses"],
            },
        },
        "referenceRoutesContextOnly": references,
        "guardrails": {
            "strictlyPregameSignalsOnly": True,
            "retrospectiveAdaptiveDiscoveryOnly": True,
            "associationNotCausation": True,
            "outcomeOptimizedThresholdSearchPerformed": False,
            "outcomeWeightedCompositePerformed": False,
            "liveVetoCreated": False,
            "historicalPricesUsed": False,
            "marketOddsUsedAsFeatures": False,
            "productionChanged": False,
            "prospectiveV68Changed": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "positiveEvEstablished": False,
            "realFinancialExposure": 0,
        },
        "scientificInterpretation": "V77 asks what pregame threat geometry the eventual opponent showed in the 95 losses concentrated in the general V16+V68 consensus TOP1 route. It can identify historical warning structure and combinations, but cannot establish causal reasons or create a live veto without a separately frozen future validation."
    }
    dump(a.out, report)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass
    print(json.dumps({
        "classification": report["classification"],
        "primaryRoute": {"wins": ep["expectedWins"], "losses": ep["expectedLosses"], "strongSignals": robust, "topSignals": ranking[:8]},
        "redCorner": matrix["redCorner"],
        "comparisonCorner": matrix["comparisonCorner"],
        "riskRatio": matrix["riskRatioRedVsComparison"],
        "allSignalThreatTertiles": all_index_tertiles["buckets"],
        "domainThreatTertiles": {k:v["buckets"] for k,v in domain_tertiles.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
