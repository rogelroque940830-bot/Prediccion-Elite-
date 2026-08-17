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
from scipy.stats import fisher_exact, mannwhitneyu, rankdata

SCHEMA = "courtedge-p0-step12v79-dynamic-team-strength-route-threat-regimes.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v79-dynamic-team-strength-route-threat-regimes-contract.v1"
TIERS = ("BOTTOM", "MID", "TOP")
TIER_ORD = {"BOTTOM": 0, "MID": 1, "TOP": 2}
SEASONS = ("2024", "2025", "2026_YTD")


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
        raise SystemExit(f"V79_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tier(v):
    x = float(v)
    if x < 1.0 / 3.0:
        return "BOTTOM"
    if x < 2.0 / 3.0:
        return "MID"
    return "TOP"


def relation(selected_tier, opponent_tier):
    a, b = TIER_ORD[selected_tier], TIER_ORD[opponent_tier]
    if a > b:
        return "SELECTED_STRONGER"
    if a < b:
        return "SELECTED_WEAKER"
    return "PEER"


def opposite(side):
    if side == "HOME":
        return "AWAY"
    if side == "AWAY":
        return "HOME"
    raise SystemExit(f"V79_INVALID_SIDE:{side}")


def wilson(w, n):
    if n <= 0:
        return {"lower": None, "upper": None}
    z = 1.96
    p = w / n
    den = 1.0 + z * z / n
    mid = (p + z * z / (2.0 * n)) / den
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n)) / den
    return {"lower": mid - half, "upper": mid + half}


def summarize(rows):
    decisive = [r for r in rows if r["y"] is not None]
    w = sum(r["y"] == 1 for r in decisive)
    l = sum(r["y"] == 0 for r in decisive)
    return {
        "rows": len(rows),
        "decisiveRows": len(decisive),
        "wins": w,
        "losses": l,
        "pushes": len(rows) - len(decisive),
        "hitRate": w / len(decisive) if decisive else None,
        "lossRate": l / len(decisive) if decisive else None,
        "wilson95HitRate": wilson(w, len(decisive)),
        "bySeason": {
            s: {
                "rows": len([r for r in rows if r["season"] == s]),
                "decisiveRows": len([r for r in decisive if r["season"] == s]),
                "wins": sum(r["season"] == s and r["y"] == 1 for r in decisive),
                "losses": sum(r["season"] == s and r["y"] == 0 for r in decisive),
                "pushes": sum(r["season"] == s and r["y"] is None for r in rows),
            }
            for s in SEASONS
        },
    }


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


def continuous_loss_analysis(rows, key):
    decisive = [r for r in rows if r["y"] is not None and finite(r.get(key))]
    wins = [float(r[key]) for r in decisive if r["y"] == 1]
    losses = [float(r[key]) for r in decisive if r["y"] == 0]
    p = float(mannwhitneyu(losses, wins, alternative="two-sided", method="asymptotic").pvalue) if wins and losses else None
    seasonal = {}
    for s in SEASONS:
        sw = [float(r[key]) for r in decisive if r["season"] == s and r["y"] == 1]
        sl = [float(r[key]) for r in decisive if r["season"] == s and r["y"] == 0]
        seasonal[s] = {
            "wins": len(sw), "losses": len(sl),
            "medianWins": float(np.median(sw)) if sw else None,
            "medianLosses": float(np.median(sl)) if sl else None,
            "lossMedianGreaterThanWinMedian": bool(sw and sl and np.median(sl) > np.median(sw)),
        }
    return {
        "nWins": len(wins), "nLosses": len(losses),
        "medianWins": float(np.median(wins)) if wins else None,
        "medianLosses": float(np.median(losses)) if losses else None,
        "meanWins": float(np.mean(wins)) if wins else None,
        "meanLosses": float(np.mean(losses)) if losses else None,
        "mannWhitneyTwoSidedP": p,
        "cliffsDeltaLossMinusWin": cliffs_delta(losses, wins),
        "lossWarningAuc": auc_loss_warning(losses, wins),
        "bySeason": seasonal,
    }


def holm_adjust(pairs):
    valid = [(k, float(v)) for k, v in pairs.items() if finite(v)]
    valid.sort(key=lambda kv: kv[1])
    m = len(valid)
    out = {k: None for k in pairs}
    running = 0.0
    for i, (k, p) in enumerate(valid):
        adj = min(1.0, (m - i) * p)
        running = max(running, adj)
        out[k] = running
    return out


def percentile_map(metric_by_team):
    ids = sorted(metric_by_team)
    vals = np.asarray([float(metric_by_team[t]) for t in ids], dtype=float)
    if len(ids) < 2:
        raise SystemExit("V79_STRENGTH_RANK_UNIVERSE_TOO_SMALL")
    ranks = rankdata(vals, method="average")
    return {tid: float((rank - 1.0) / (len(ids) - 1.0)) for tid, rank in zip(ids, ranks)}


def build_strength_snapshots(root, seasons, target_dates_by_season, minimum_games):
    result = {}
    diagnostics = {}
    for season in seasons:
        acquisition = load(os.path.join(root, season, "cohort", "official-acquisition.json"))
        games = [g for g in acquisition.get("games", []) if g.get("gameType") == "R" and g.get("finalState") == "Final"]
        by_date = defaultdict(list)
        for g in games:
            if not isinstance(g.get("homeTeamId"), int) or not isinstance(g.get("awayTeamId"), int):
                raise SystemExit(f"V79_INVALID_TEAM_ID:{season}:{g.get('gamePk')}")
            if not isinstance(g.get("homeFinalRuns"), int) or not isinstance(g.get("awayFinalRuns"), int):
                raise SystemExit(f"V79_INVALID_FINAL_RUNS:{season}:{g.get('gamePk')}")
            by_date[str(g["officialDate"])].append(g)
        stats = defaultdict(lambda: {"games": 0, "wins": 0, "runsFor": 0, "runsAgainst": 0})
        target_dates = set(target_dates_by_season.get(season, set()))
        season_result = {}
        for d in sorted(by_date):
            if d in target_dates:
                eligible = {tid: st for tid, st in stats.items() if st["games"] >= minimum_games}
                if len(eligible) < 24:
                    raise SystemExit(f"V79_TOO_FEW_RANKED_TEAMS:{season}:{d}:{len(eligible)}")
                winpct = {tid: st["wins"] / st["games"] for tid, st in eligible.items()}
                rdpg = {tid: (st["runsFor"] - st["runsAgainst"]) / st["games"] for tid, st in eligible.items()}
                wpct_pct = percentile_map(winpct)
                rd_pct = percentile_map(rdpg)
                snap = {}
                for tid in sorted(eligible):
                    strength = 0.5 * (wpct_pct[tid] + rd_pct[tid])
                    snap[tid] = {
                        "games": eligible[tid]["games"],
                        "wins": eligible[tid]["wins"],
                        "winPct": winpct[tid],
                        "runDifferentialPerGame": rdpg[tid],
                        "winPctPercentile": wpct_pct[tid],
                        "runDifferentialPercentile": rd_pct[tid],
                        "strengthScore": strength,
                        "primaryTier": tier(strength),
                        "recordTier": tier(wpct_pct[tid]),
                    }
                season_result[d] = snap
            # Update only after the snapshot so every game on this official date is excluded.
            for g in by_date[d]:
                h, a = int(g["homeTeamId"]), int(g["awayTeamId"])
                hr, ar = int(g["homeFinalRuns"]), int(g["awayFinalRuns"])
                if hr == ar:
                    raise SystemExit(f"V79_REGULAR_SEASON_TIE:{season}:{g['gamePk']}")
                for tid, rf, ra, won in ((h, hr, ar, hr > ar), (a, ar, hr, ar > hr)):
                    stats[tid]["games"] += 1
                    stats[tid]["wins"] += int(won)
                    stats[tid]["runsFor"] += rf
                    stats[tid]["runsAgainst"] += ra
        missing_dates = target_dates - set(season_result)
        if missing_dates:
            raise SystemExit(f"V79_TARGET_DATE_SNAPSHOT_MISSING:{season}:{sorted(missing_dates)[:5]}")
        result[season] = season_result
        diagnostics[season] = {
            "targetDates": len(target_dates),
            "snapshotsBuilt": len(season_result),
            "minimumPriorGames": minimum_games,
            "sourceGames": len(games),
        }
    return result, diagnostics


def add_strength_context(rows, feature_map, snapshots):
    out = []
    for r in rows:
        key = (r["season"], int(r["gamePk"]))
        raw = feature_map[key]
        home = int(raw["homeTeamId"])
        away = int(raw["awayTeamId"])
        selected = home if r["side"] == "HOME" else away
        opponent = away if r["side"] == "HOME" else home
        snap = snapshots[r["season"]][r["date"]]
        if selected not in snap or opponent not in snap:
            raise SystemExit(f"V79_TARGET_TEAM_STRENGTH_MISSING:{key}:{selected}:{opponent}")
        ss, os_ = snap[selected], snap[opponent]
        rr = dict(r)
        rr["selectedTeamId"] = selected
        rr["opponentTeamId"] = opponent
        rr["selectedStrength"] = ss
        rr["opponentStrength"] = os_
        rr["strengthGap"] = float(os_["strengthScore"] - ss["strengthScore"])
        rr["tierRelation"] = relation(ss["primaryTier"], os_["primaryTier"])
        rr["recordTierRelation"] = relation(ss["recordTier"], os_["recordTier"])
        out.append(rr)
    return out


def add_opponent_advantage_share(rows, signals):
    out = []
    for r in rows:
        vals = [float(r["opponentWarning"][name]) for name in signals if finite(r["opponentWarning"].get(name))]
        rr = dict(r)
        rr["opponentAdvantageSignalNonmissing"] = len(vals)
        rr["opponentAdvantageSignalCount"] = sum(v > 0.0 for v in vals)
        rr["opponentAdvantageShare"] = (rr["opponentAdvantageSignalCount"] / len(vals)) if len(vals) >= 12 else None
        rr["opponentAdvantageMajority"] = bool(finite(rr["opponentAdvantageShare"]) and rr["opponentAdvantageShare"] > 0.5)
        out.append(rr)
    return out


def add_context_flags(rows):
    out = []
    for r in rows:
        rr = dict(r)
        selected_tier = r["selectedStrength"]["primaryTier"]
        opponent_tier = r["opponentStrength"]["primaryTier"]
        warning = bool(r["combinedPrimaryFlag"])
        weaker = r["tierRelation"] == "SELECTED_WEAKER"
        positive_gap = float(r["strengthGap"]) > 0.0
        extreme_gap = float(r["strengthGap"]) >= 1.0 / 3.0
        selected_not_top_vs_opp_top = selected_tier != "TOP" and opponent_tier == "TOP"
        maj = bool(r["opponentAdvantageMajority"])
        rr["contextFlags"] = {
            "ALL_SELECTED_WEAKER_TIER": weaker,
            "V78_WARNING_AND_SELECTED_WEAKER_TIER": warning and weaker,
            "V78_WARNING_AND_POSITIVE_STRENGTH_GAP": warning and positive_gap,
            "V78_WARNING_AND_EXTREME_OPPONENT_STRENGTH_GAP_GE_ONE_THIRD": warning and extreme_gap,
            "V78_WARNING_AND_SELECTED_NOT_TOP_VS_OPPONENT_TOP": warning and selected_not_top_vs_opp_top,
            "V78_WARNING_AND_SELECTED_WEAKER_AND_OPPONENT_ADVANTAGE_MAJORITY": warning and weaker and maj,
            "SELECTED_WEAKER_AND_OPPONENT_ADVANTAGE_MAJORITY": weaker and maj,
            "SELECTED_NOT_TOP_VS_OPPONENT_TOP_AND_OPPONENT_ADVANTAGE_MAJORITY": selected_not_top_vs_opp_top and maj,
        }
        out.append(rr)
    return out


def flip_rows(rows, context):
    out = []
    for r in rows:
        rr = dict(r)
        if r["contextFlags"].get(context) is True:
            rr["side"] = opposite(r["side"])
            rr["y"] = None if r["y"] is None else 1 - int(r["y"])
            rr["counterSideApplied"] = True
        out.append(rr)
    return out


def veto_rows(rows, context):
    return [dict(r) for r in rows if not r["contextFlags"].get(context)]


def policy_summary(rows, context, baseline_pick_days, baseline_losses):
    flagged = [r for r in rows if r["contextFlags"].get(context)]
    fd = [r for r in flagged if r["y"] is not None]
    fw = sum(r["y"] == 1 for r in fd)
    fl = sum(r["y"] == 0 for r in fd)
    flip = summarize(flip_rows(rows, context))
    veto = summarize(veto_rows(rows, context))
    active_veto_dates = len({r["date"] for r in veto_rows(rows, context)})
    by_season_flagged = {}
    for s in SEASONS:
        sd = [r for r in fd if r["season"] == s]
        sl = sum(r["y"] == 0 for r in sd)
        by_season_flagged[s] = {
            "decisiveRows": len(sd),
            "originalWins": sum(r["y"] == 1 for r in sd),
            "originalLosses": sl,
            "counterSidePrecision": sl / len(sd) if sd else None,
        }
    return {
        "flaggedRows": len(flagged),
        "flaggedDecisiveRows": len(fd),
        "originalWins": fw,
        "originalLosses": fl,
        "pushes": len(flagged)-len(fd),
        "lossCaptureOfAll138": fl / baseline_losses if baseline_losses else None,
        "counterSidePrecision": fl / len(fd) if fd else None,
        "counterSideWilson95": wilson(fl, len(fd)),
        "netCorrectDecisionChangeIfFlipped": fl-fw,
        "bySeasonFlagged": by_season_flagged,
        "flipPortfolio": flip,
        "vetoPortfolio": {
            **veto,
            "coverageVsBaselinePickDays": active_veto_dates / baseline_pick_days if baseline_pick_days else None,
            "lossesAvoided": fl,
            "winsSacrificed": fw,
        },
        "byRouteFlagged": {
            route: summarize([r for r in flagged if r["route"] == route])
            for route in sorted({r["route"] for r in rows})
        },
    }


def route_tier_matrix(rows):
    result = {}
    for route in sorted({r["route"] for r in rows}):
        rr = [r for r in rows if r["route"] == route]
        result[route] = {}
        pvals = {}
        for st in TIERS:
            result[route][st] = {}
            for ot in TIERS:
                cell = [r for r in rr if r["selectedStrength"]["primaryTier"] == st and r["opponentStrength"]["primaryTier"] == ot]
                rest = [r for r in rr if not (r["selectedStrength"]["primaryTier"] == st and r["opponentStrength"]["primaryTier"] == ot)]
                sm = summarize(cell)
                cd = [r for r in cell if r["y"] is not None]
                rd = [r for r in rest if r["y"] is not None]
                a = sum(r["y"] == 0 for r in cd)
                b = sum(r["y"] == 1 for r in cd)
                c = sum(r["y"] == 0 for r in rd)
                d = sum(r["y"] == 1 for r in rd)
                p = float(fisher_exact([[a,b],[c,d]], alternative="two-sided").pvalue) if cd and rd else None
                cell_id = f"{st}_VS_{ot}"
                pvals[cell_id] = p
                sm["fisherTwoSidedPVsRouteRemainder"] = p
                sm["routeRemainderLossRate"] = c / (c+d) if c+d else None
                result[route][st][ot] = sm
        adj = holm_adjust(pvals)
        for st in TIERS:
            for ot in TIERS:
                cid = f"{st}_VS_{ot}"
                sm = result[route][st][ot]
                sm["holmAdjustedPWithinNineRouteCells"] = adj[cid]
                season_checks = []
                for s in SEASONS:
                    cell_s = [r for r in rr if r["season"] == s and r["selectedStrength"]["primaryTier"] == st and r["opponentStrength"]["primaryTier"] == ot and r["y"] is not None]
                    rest_s = [r for r in rr if r["season"] == s and not (r["selectedStrength"]["primaryTier"] == st and r["opponentStrength"]["primaryTier"] == ot) and r["y"] is not None]
                    if len(cell_s) >= 3 and rest_s:
                        cell_lr = sum(r["y"] == 0 for r in cell_s)/len(cell_s)
                        rest_lr = sum(r["y"] == 0 for r in rest_s)/len(rest_s)
                        season_checks.append(cell_lr > rest_lr)
                sm["strongRiskCell"] = bool(
                    sm["decisiveRows"] >= 12
                    and finite(sm.get("holmAdjustedPWithinNineRouteCells"))
                    and sm["holmAdjustedPWithinNineRouteCells"] < 0.05
                    and sm["lossRate"] is not None and sm["routeRemainderLossRate"] is not None
                    and sm["lossRate"] > sm["routeRemainderLossRate"]
                    and season_checks and all(season_checks)
                )
    return result


def route_relation(rows, relation_key="tierRelation"):
    out = {}
    for route in sorted({r["route"] for r in rows}):
        out[route] = {}
        for rel in ("SELECTED_STRONGER","PEER","SELECTED_WEAKER"):
            out[route][rel] = summarize([r for r in rows if r["route"] == route and r[relation_key] == rel])
    return out


def opponent_evidence_relation(rows):
    out = {}
    for route in sorted({r["route"] for r in rows}):
        out[route] = {}
        for rel in ("SELECTED_STRONGER","PEER","SELECTED_WEAKER"):
            z = [r for r in rows if r["route"] == route and r["tierRelation"] == rel and finite(r.get("opponentAdvantageShare"))]
            zd = [r for r in z if r["y"] is not None]
            out[route][rel] = {
                "rows": len(z),
                "wins": sum(r["y"] == 1 for r in zd),
                "losses": sum(r["y"] == 0 for r in zd),
                "medianShareWins": float(np.median([r["opponentAdvantageShare"] for r in zd if r["y"] == 1])) if any(r["y"] == 1 for r in zd) else None,
                "medianShareLosses": float(np.median([r["opponentAdvantageShare"] for r in zd if r["y"] == 0])) if any(r["y"] == 0 for r in zd) else None,
                "majorityRows": sum(r["opponentAdvantageMajority"] for r in z),
                "majorityWins": sum(r["opponentAdvantageMajority"] and r["y"] == 1 for r in zd),
                "majorityLosses": sum(r["opponentAdvantageMajority"] and r["y"] == 0 for r in zd),
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
    ap.add_argument("--v78-scorer", required=True)
    ap.add_argument("--v78-summary", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_DYNAMIC_TEAM_STRENGTH_ROUTE_THREAT_REGIMES_BEFORE_ANY_V79_SCORER_EXISTS":
        raise SystemExit("V79_CONTRACT_INVALID")
    for k in (
        "refitAllowed","recalibrationAllowed","newPredictiveFeatureFitAllowed","thresholdSearchAllowed","tierBoundarySearchAllowed",
        "strengthWeightSearchAllowed","routeSearchAllowed","dateCutoffSearchAllowed","cellSelectionAfterOutcomeInspectionAllowed",
        "outcomeWeightedCompositeAllowed","bestPolicySelectionAfterOutcomeInspectionAllowed","claimCausationAllowed",
        "claimIndependentConfirmationAllowed","liveVetoCreatedByV79","liveCounterSideSwitchCreatedByV79"
    ):
        if c["statisticsBoundary"].get(k) is not False:
            raise SystemExit(f"V79_BOUNDARY_INVALID:{k}")
    for key, path in (("v69Scorer",a.v69_scorer),("v72Scorer",a.v72_scorer),("v77Scorer",a.v77_scorer),("v78Scorer",a.v78_scorer)):
        if git_blob_sha(path) != c["immutableParentEvidence"][key]["gitBlobSha"]:
            raise SystemExit(f"V79_PARENT_BLOB_DRIFT:{key}")
    if git_blob_sha(a.v78_summary) != c["immutableParentEvidence"]["v78ResultSummary"]["gitBlobSha"]:
        raise SystemExit("V79_V78_SUMMARY_BLOB_DRIFT")
    v78s = load(a.v78_summary)
    ev78 = c["immutableParentEvidence"]["v78ResultSummary"]
    if v78s.get("classification") != ev78["requiredClassification"]:
        raise SystemExit("V79_V78_SUMMARY_CLASSIFICATION_DRIFT")
    src78 = v78s.get("sourceArtifact") or {}
    if int(src78.get("workflowRunId",-1)) != ev78["sourceWorkflowRunId"] or int(src78.get("artifactId",-1)) != ev78["sourceArtifactId"] or src78.get("artifactDigest") != ev78["sourceArtifactDigest"]:
        raise SystemExit("V79_V78_SUMMARY_CUSTODY_DRIFT")

    v69 = module(a.v69_scorer, "v79_v69")
    v72 = module(a.v72_scorer, "v79_v72")
    v77 = module(a.v77_scorer, "v79_v77")
    v69c = load(a.v69_contract)
    feature_map, _ = v72.load_feature_map(a.root, SEASONS, v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"])
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
        raise SystemExit("V79_V69_CAPTURE_DRIFT")
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
    expected = {"pickDays":pp["expectedPickDays"],"decisiveRows":pp["expectedDecisiveRows"],"wins":pp["expectedWins"],"losses":pp["expectedLosses"],"pushes":pp["expectedPushes"]}
    if parity != expected:
        raise SystemExit(f"V79_PARENT_PARITY_FAILED:{parity}")

    v77c = load("research/p0-step12v77-general-consensus-loss-threat-geometry-contract.json")
    signals = c["opponentEvidenceDefinition"]["directionalSignalsExactly"]
    if signals != v77c["directionalOpponentWarningSignalsExactly"]:
        raise SystemExit("V79_DIRECTIONAL_SIGNAL_DRIFT")
    enriched = v72.enrich_top1(rows0, feature_map, custody_map, signals, ["consensusScore","p16Selected","p68Selected","p68MinusP16Selected","classifierScore","routePriority"])

    general_route = "V16_V68_CONSENSUS_T0.550"
    premium_route = "PREMIUM_A_V68_AGREE_ROUTE_SWITCH"
    aplus_route = "A_PLUS_V68_AGREE_D1_ROUTER"
    general = [r for r in enriched if r["route"] == general_route]
    general_idx = v77.add_threat_indexes(general, v77c)
    gmap = {(r["season"], int(r["gamePk"])): r for r in general_idx}
    threat_vals = [float(r["allSignalThreatIndex"]) for r in general_idx if finite(r.get("allSignalThreatIndex"))]
    consensus_vals = [float(r["modelConviction"]["consensusScore"]) for r in general_idx if finite(r["modelConviction"].get("consensusScore"))]
    tq33,tq67 = float(np.quantile(threat_vals,1/3)),float(np.quantile(threat_vals,2/3))
    cq33,cq67 = float(np.quantile(consensus_vals,1/3)),float(np.quantile(consensus_vals,2/3))
    def tertile(v,q1,q2):
        return "LOW" if v <= q1 else ("MID" if v <= q2 else "HIGH")
    rows1 = []
    for r0 in enriched:
        r = dict(r0)
        key = (r["season"], int(r["gamePk"]))
        r["allSignalThreatIndex"] = None
        r["generalPrimaryFlag"] = False
        if r["route"] == general_route:
            gr = gmap[key]
            r["allSignalThreatIndex"] = gr.get("allSignalThreatIndex")
            r["generalPrimaryFlag"] = bool(
                finite(r["allSignalThreatIndex"]) and tertile(float(r["allSignalThreatIndex"]),tq33,tq67) == "HIGH"
                and finite(r["modelConviction"].get("consensusScore")) and tertile(float(r["modelConviction"]["consensusScore"]),cq33,cq67) == "LOW"
            )
        r["premiumHrFlag"] = bool(r["route"] == premium_route and finite(r["opponentWarning"].get("starter_hr_adv")) and float(r["opponentWarning"]["starter_hr_adv"]) > 0.0)
        r["combinedPrimaryFlag"] = bool(r["generalPrimaryFlag"] or r["premiumHrFlag"])
        rows1.append(r)

    route_parity = {}
    for route in (aplus_route,premium_route,general_route):
        z = [r for r in rows1 if r["route"] == route and r["y"] is not None]
        route_parity[route] = {"decisiveRows":len(z),"wins":sum(r["y"]==1 for r in z),"losses":sum(r["y"]==0 for r in z)}
        e = pp["routeParity"][route]
        if route_parity[route]["wins"] != e["wins"] or route_parity[route]["losses"] != e["losses"]:
            raise SystemExit(f"V79_ROUTE_PARITY_FAILED:{route}:{route_parity[route]}")

    target_dates = {s: {r["date"] for r in rows1 if r["season"] == s} for s in SEASONS}
    snapshots, strength_diagnostics = build_strength_snapshots(a.root, SEASONS, target_dates, int(c["pregameStrengthDefinition"]["minimumPriorGamesPerTeam"]))
    rows2 = add_strength_context(rows1, feature_map, snapshots)
    rows3 = add_opponent_advantage_share(rows2, signals)
    rows = add_context_flags(rows3)
    if any(not finite(r.get("opponentAdvantageShare")) for r in rows):
        raise SystemExit("V79_OPPONENT_ADVANTAGE_SHARE_MISSING_TARGET")

    matrix = route_tier_matrix(rows)
    strong_cells = []
    for route in matrix:
        for st in TIERS:
            for ot in TIERS:
                if matrix[route][st][ot]["strongRiskCell"]:
                    strong_cells.append({"route":route,"selectedTier":st,"opponentTier":ot,**matrix[route][st][ot]})
    relation_primary = route_relation(rows, "tierRelation")
    relation_record = route_relation(rows, "recordTierRelation")
    gap_analysis = {"ALL": continuous_loss_analysis(rows, "strengthGap")}
    for route in sorted(route_parity):
        gap_analysis[route] = continuous_loss_analysis([r for r in rows if r["route"] == route], "strengthGap")

    context_results = {}
    for name in c["predeclaredContextPolicies"]:
        context_results[name] = policy_summary(rows, name, parity["pickDays"], parity["losses"])

    loss_ledger = []
    for r in rows:
        if r["y"] != 0:
            continue
        loss_ledger.append({
            "season":r["season"],"date":r["date"],"gamePk":r["gamePk"],"route":r["route"],"market":r["market"],
            "originalSide":r["side"],"counterSide":opposite(r["side"]),
            "selectedTeamId":r["selectedTeamId"],"opponentTeamId":r["opponentTeamId"],
            "selectedTier":r["selectedStrength"]["primaryTier"],"opponentTier":r["opponentStrength"]["primaryTier"],
            "selectedStrengthScore":r["selectedStrength"]["strengthScore"],"opponentStrengthScore":r["opponentStrength"]["strengthScore"],
            "strengthGap":r["strengthGap"],"tierRelation":r["tierRelation"],
            "v78CombinedWarning":r["combinedPrimaryFlag"],"generalPrimaryFlag":r["generalPrimaryFlag"],"premiumHrFlag":r["premiumHrFlag"],
            "opponentAdvantageShare":r["opponentAdvantageShare"],"opponentAdvantageSignalCount":r["opponentAdvantageSignalCount"],
            "applicablePredeclaredContexts":[name for name,val in r["contextFlags"].items() if val],
        })
    loss_ledger.sort(key=lambda x:(x["date"],x["gamePk"]))
    if len(loss_ledger) != 138:
        raise SystemExit(f"V79_LOSS_LEDGER_PARITY_FAILED:{len(loss_ledger)}")

    inherited_warning_cross = {}
    for rel in ("SELECTED_STRONGER","PEER","SELECTED_WEAKER"):
        z = [r for r in rows if r["combinedPrimaryFlag"] and r["tierRelation"] == rel]
        inherited_warning_cross[rel] = summarize(z)
        zd = [r for r in z if r["y"] is not None]
        l = sum(r["y"] == 0 for r in zd)
        inherited_warning_cross[rel]["counterSidePrecision"] = l/len(zd) if zd else None
        inherited_warning_cross[rel]["counterSideWilson95"] = wilson(l,len(zd))

    report = {
        "schemaVersion":SCHEMA,
        "classification":"V79_DYNAMIC_TEAM_STRENGTH_ROUTE_THREAT_REGIMES_RETROSPECTIVE_COMPLETE",
        "parentParity":parity,
        "routeParity":route_parity,
        "strengthConstructionDiagnostics":strength_diagnostics,
        "inheritedV78OutcomeBlindCutpoints":{"generalAllSignalThreatQ33":tq33,"generalAllSignalThreatQ67":tq67,"generalConsensusScoreQ33":cq33,"generalConsensusScoreQ67":cq67},
        "primaryRouteSelectedTierByOpponentTierMatrix":matrix,
        "predeclaredStrongRiskCells":strong_cells,
        "primaryRouteTierRelation":relation_primary,
        "recordOnlyTierRelationSensitivity":relation_record,
        "strengthGapLossAssociation":gap_analysis,
        "inheritedV78WarningByPrimaryTierRelation":inherited_warning_cross,
        "opponentEvidenceByRouteAndPrimaryTierRelation":opponent_evidence_relation(rows),
        "predeclaredContextPolicyResults":context_results,
        "all138LossContextLedger":loss_ledger,
        "oracleBoundary":{
            "knownDecisiveLosses":138,
            "oppositeSideWouldMechanicallyWinKnownLosses":138,
            "actionable":False,
            "interpretation":"The exact opposite side wins a known decisive historical loss by definition. V79 only evaluates predeclared pregame contexts over both original wins and losses; it never treats the 138/138 oracle ceiling as model skill."
        },
        "guardrails":{
            "strictPregameStrengthOnly":True,
            "sameDateGamesExcludedFromStrengthSnapshot":True,
            "fixedThirdsTierBoundaries":True,
            "strengthWeightsOutcomeBlindAndEqual":True,
            "allNineCellsReportedNoSelection":True,
            "thresholdSearchPerformed":False,
            "outcomeWeightedCompositePerformed":False,
            "liveVetoCreated":False,
            "liveCounterSideSwitchCreated":False,
            "historicalPricesUsed":False,
            "marketOddsUsedAsFeatures":False,
            "productionChanged":False,
            "prospectiveV68Changed":False,
            "routingChanged":False,
            "rankingChanged":False,
            "stakeChanged":False,
            "positiveEvEstablished":False,
            "realFinancialExposure":0
        },
        "scientificInterpretation":"V79 tests whether reliability of the frozen Winner TOP1 routes depends on the relative pregame strength of the selected team and opponent. Team tiers are reconstructed strictly from prior same-season results and run differential, dynamically ranked against MLB on each target date. All route x tier cells and all predeclared counter-side/veto contexts are reported; no favorable cell or policy can be promoted from this same retrospective window."
    }
    dump(a.out, report)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass

    compact_contexts = {
        k:{"n":v["flaggedDecisiveRows"],"origW":v["originalWins"],"origL":v["originalLosses"],"oppPrecision":v["counterSidePrecision"],"netFlip":v["netCorrectDecisionChangeIfFlipped"],"vetoHit":v["vetoPortfolio"]["hitRate"],"vetoCoverage":v["vetoPortfolio"]["coverageVsBaselinePickDays"]}
        for k,v in context_results.items()
    }
    print(json.dumps({
        "classification":report["classification"],
        "parentParity":parity,
        "routeTierRelation":{route:{rel:{"n":x["decisiveRows"],"w":x["wins"],"l":x["losses"],"hit":x["hitRate"]} for rel,x in rels.items()} for route,rels in relation_primary.items()},
        "strongRiskCells":strong_cells,
        "contexts":compact_contexts,
        "strengthGapAuc":{k:v["lossWarningAuc"] for k,v in gap_analysis.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
