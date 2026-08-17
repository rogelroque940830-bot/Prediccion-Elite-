#!/usr/bin/env python3
import argparse
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy.stats import nbinom

SCHEMA = "courtedge-p0-step12v73-unified-best-opportunity-audit.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v73-unified-best-opportunity-audit-contract.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"


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


def load_module(path):
    spec = importlib.util.spec_from_file_location("v69_frozen_parent_for_v73", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V73_V69_IMPORT_FAILED")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_custody(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    out = {}
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            key = (str(r["season"]), int(r["gamePk"]))
            if key in out:
                raise SystemExit(f"V73_DUPLICATE_CUSTODY:{key}")
            out[key] = r
    if len(out) != 11407:
        raise SystemExit(f"V73_CUSTODY_TOTAL_DRIFT:{len(out)}")
    return out


def load_feature_maps(root, seasons, expected_by):
    rows = {}
    dates = set()
    for s in seasons:
        p = load(os.path.join(root, s, "game-anatomy-feature-table.json"))
        if p.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"V73_BASE_SCHEMA_DRIFT:{s}")
        eligible = [r for r in p.get("rows", []) if r.get("t5PregameValid") is True]
        if len(eligible) != int(expected_by[s]):
            raise SystemExit(f"V73_BASE_ROW_DRIFT:{s}:{len(eligible)}")
        for r in eligible:
            key = (s, int(r["gamePk"]))
            if key in rows:
                raise SystemExit(f"V73_DUPLICATE_BASE_GAME:{key}")
            rows[key] = r
            dates.add(str(r["officialDate"]))
    return rows, dates


def load_f5_outcomes(path):
    p = load(path)
    if p.get("schemaVersion") != "courtedge-p0-step12v28-f5-outcomes.v1":
        raise SystemExit("V73_F5_OUTCOME_SCHEMA_DRIFT")
    out = {}
    for r in p.get("rows", []):
        key = (str(r["season"]), int(r["gamePk"]))
        if key in out:
            raise SystemExit(f"V73_DUPLICATE_F5_OUTCOME:{key}")
        out[key] = r
    return out


def transform_one(row, pre):
    xs = []
    for name, med, mean, scale in zip(pre["features"], pre["medianImpute"], pre["mean"], pre["scale"]):
        raw = row.get(name)
        value = float(raw) if finite(raw) else float(med)
        s = float(scale)
        if not math.isfinite(s) or s <= 0:
            raise SystemExit(f"V73_INVALID_SCALE:{name}:{s}")
        xs.append((value - float(mean)) / s)
    return np.asarray(xs, dtype=float)


def frozen_mu(row, model):
    x = transform_one(row, model["preprocessor"])
    eta = float(model["intercept"]) + float(x @ np.asarray(model["coefficients"], dtype=float))
    mu = math.exp(eta)
    if not math.isfinite(mu) or mu <= 0:
        raise SystemExit("V73_INVALID_FROZEN_MU")
    return mu


def nb2_over_probability(mu, alpha, line):
    size = 1.0 / float(alpha)
    p = size / (size + float(mu))
    return float(nbinom.sf(math.floor(float(line)), size, p))


def central_total_candidate(row, custody_row, horizon, model, alpha, lines, f5_outcomes):
    mu = frozen_mu(custody_row, model)
    scored = []
    for line in lines:
        po = nb2_over_probability(mu, alpha, line)
        scored.append((abs(po - 0.5), float(line), po))
    scored.sort(key=lambda z: (z[0], z[1]))
    _, line, p_over = scored[0]
    side = "OVER" if p_over > 0.5 else "UNDER"
    confidence = max(p_over, 1.0 - p_over)
    key = (str(custody_row["season"]), int(custody_row["gamePk"]))
    if horizon == "F5":
        x = f5_outcomes.get(key)
        if x is None or not isinstance(x.get("totalRuns"), int):
            return None
        total_runs = int(x["totalRuns"])
        market = "F5_TOTAL"
    else:
        o = (row.get("outcomes") or {}).get("FULL_GAME") or {}
        if not isinstance(o.get("totalRuns"), int):
            raise SystemExit(f"V73_FG_TOTAL_OUTCOME_MISSING:{key}")
        total_runs = int(o["totalRuns"])
        market = "FULL_GAME_TOTAL"
    won = int(total_runs > line) if side == "OVER" else int(total_runs < line)
    return {
        "season": str(custody_row["season"]),
        "date": str(custody_row["officialDate"]),
        "gamePk": int(custody_row["gamePk"]),
        "family": market,
        "market": market,
        "side": side,
        "line": line,
        "confidence": float(confidence),
        "pOver": float(p_over),
        "mu": float(mu),
        "actualTotalRuns": total_runs,
        "y": won,
    }


def winner_confidence(o):
    route = o["route"]
    if route == "V16_V68_CONSENSUS_T0.550":
        if not finite(o.get("consensusScore")):
            raise SystemExit("V73_GENERAL_WINNER_CONFIDENCE_MISSING")
        return float(o["consensusScore"])
    if route in ("A_PLUS_V68_AGREE_D1_ROUTER", "PREMIUM_A_V68_AGREE_ROUTE_SWITCH"):
        if not finite(o.get("classifierScore")) or not finite(o.get("p68Selected")):
            raise SystemExit(f"V73_STRONG_WINNER_CONFIDENCE_MISSING:{route}")
        return min(float(o["classifierScore"]), float(o["p68Selected"]))
    raise SystemExit(f"V73_UNEXPECTED_FROZEN_TOP1_ROUTE:{route}")


def as_winner_candidate(o):
    z = dict(o)
    z["family"] = "FROZEN_WINNER_TOP1"
    z["confidence"] = winner_confidence(o)
    z["line"] = None
    return z


def daily_top1(candidates, family_tie_order=None):
    by = defaultdict(list)
    for c in candidates:
        by[c["date"]].append(c)
    out = []
    tie = family_tie_order or {}
    for d in sorted(by):
        xs = sorted(by[d], key=lambda c: (
            -float(c["confidence"]),
            int(tie.get(c["family"], 99)),
            int(c["gamePk"]),
        ))
        out.append(xs[0])
    return out


def wilson(w, n):
    if n == 0:
        return {"lower": None, "upper": None}
    z = 1.96
    p = w / n
    den = 1.0 + z*z/n
    mid = (p + z*z/(2*n))/den
    half = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den
    return {"lower": mid-half, "upper": mid+half}


def bootstrap_hit(rows, resamples, seed):
    dec = [r for r in rows if r["y"] is not None]
    by = defaultdict(lambda: [0,0])
    for r in dec:
        by[r["date"]][0] += int(r["y"])
        by[r["date"]][1] += 1
    keys = sorted(by)
    a = np.asarray([by[k] for k in keys], dtype=float)
    if not len(a):
        return {"pointEstimate": None, "ci95": [None,None], "resamples": resamples, "seed": seed, "unit": "OFFICIAL_DATE"}
    point = float(a[:,0].sum()/a[:,1].sum())
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    for i in range(resamples):
        idx = rng.integers(0, len(a), size=len(a))
        s = a[idx].sum(axis=0)
        vals[i] = s[0]/s[1]
    return {
        "pointEstimate": point,
        "ci95": [float(np.quantile(vals,.025)), float(np.quantile(vals,.975))],
        "resamples": resamples,
        "seed": seed,
        "unit": "OFFICIAL_DATE",
        "distinctDates": len(keys),
    }


def max_losing_streak_within_season(rows, seasons):
    best = 0
    by_season = {}
    for s in seasons:
        xs = sorted([r for r in rows if r["season"] == s], key=lambda r: r["date"])
        cur = 0
        m = 0
        for r in xs:
            if r["y"] == 0:
                cur += 1
                m = max(m, cur)
            elif r["y"] == 1:
                cur = 0
            else:
                cur = 0
        by_season[s] = m
        best = max(best, m)
    return best, by_season


def stats(rows, seasons, resamples, seed):
    dec = [r for r in rows if r["y"] is not None]
    w = sum(r["y"] == 1 for r in dec)
    p = sum(r["y"] is None for r in rows)
    m, mby = max_losing_streak_within_season(rows, seasons)
    bys = {}
    for s in seasons:
        z = [r for r in rows if r["season"] == s]
        zd = [r for r in z if r["y"] is not None]
        zw = sum(r["y"] == 1 for r in zd)
        bys[s] = {
            "opportunities": len(z),
            "decisiveRows": len(zd),
            "wins": zw,
            "losses": len(zd)-zw,
            "pushes": len(z)-len(zd),
            "decisiveHitRate": zw/len(zd) if zd else None,
            "wilson95": wilson(zw, len(zd)),
        }
    return {
        "opportunities": len(rows),
        "decisiveRows": len(dec),
        "wins": w,
        "losses": len(dec)-w,
        "pushes": p,
        "decisiveHitRate": w/len(dec) if dec else None,
        "wilson95": wilson(w, len(dec)),
        "officialDateClusterBootstrap95": bootstrap_hit(rows, resamples, seed),
        "bySeason": bys,
        "marketShare": dict(sorted(Counter(r["family"] for r in rows).items())),
        "maximumConsecutiveLosingSelectedDaysWithinSeason": m,
        "maximumConsecutiveLosingSelectedDaysBySeason": mby,
        "meanConfidence": float(np.mean([r["confidence"] for r in rows])) if rows else None,
    }


def head_to_head(unified, winner):
    u = {r["date"]: r for r in unified}
    w = {r["date"]: r for r in winner}
    dates = sorted(set(u) & set(w))
    diff = [d for d in dates if (u[d]["family"], u[d]["gamePk"], u[d].get("market"), u[d].get("side"), u[d].get("line")) != (w[d]["family"], w[d]["gamePk"], w[d].get("market"), w[d].get("side"), w[d].get("line"))]
    both_dec = [d for d in diff if u[d]["y"] is not None and w[d]["y"] is not None]
    return {
        "commonDates": len(dates),
        "daysUnifiedDiffersFromFrozenWinner": len(diff),
        "differentDaysBothDecisive": len(both_dec),
        "unifiedWinsOnDifferentBothDecisiveDays": sum(u[d]["y"] == 1 for d in both_dec),
        "winnerWinsOnDifferentBothDecisiveDays": sum(w[d]["y"] == 1 for d in both_dec),
        "unifiedWinWinnerLoss": sum(u[d]["y"] == 1 and w[d]["y"] == 0 for d in both_dec),
        "unifiedLossWinnerWin": sum(u[d]["y"] == 0 and w[d]["y"] == 1 for d in both_dec),
        "bothWin": sum(u[d]["y"] == 1 and w[d]["y"] == 1 for d in both_dec),
        "bothLose": sum(u[d]["y"] == 0 and w[d]["y"] == 0 for d in both_dec),
    }


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
    ap.add_argument("--v66-totals-report", required=True)
    ap.add_argument("--v67-report", required=True)
    ap.add_argument("--f5-outcomes", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_BEFORE_ANY_V73_SCORER_EXISTS":
        raise SystemExit("V73_CONTRACT_INVALID")
    for k in ("refitAllowed","recalibrationAllowed","featureSearchAllowed","thresholdSearchAllowed","routeSearchAllowed","lineSearchAfterOutcomesAllowed","marketFamilyAdditionAfterOutcomesAllowed","seasonExclusionAfterResultsAllowed"):
        if c["statistics"].get(k) is not False:
            raise SystemExit(f"V73_SEARCH_BOUNDARY_INVALID:{k}")
    if git_blob_sha(a.v69_scorer) != c["immutableParentEvidence"]["v69Scorer"]["gitBlobSha"]:
        raise SystemExit("V73_V69_SCORER_BLOB_DRIFT")

    v67 = load(a.v67_report)
    if v67["routes"]["V67_A_F5_TOTAL_NB2"]["classification"] != c["immutableParentEvidence"]["v67"]["f5Classification"]:
        raise SystemExit("V73_V67_F5_CLASSIFICATION_DRIFT")
    if v67["routes"]["V67_B_FULL_GAME_TOTAL_NB2"]["classification"] != c["immutableParentEvidence"]["v67"]["fullGameClassification"]:
        raise SystemExit("V73_V67_FG_CLASSIFICATION_DRIFT")
    alpha_f5 = float(v67["routes"]["V67_A_F5_TOTAL_NB2"]["dispersionFit2022"]["alpha"])
    alpha_fg = float(v67["routes"]["V67_B_FULL_GAME_TOTAL_NB2"]["dispersionFit2022"]["alpha"])
    if abs(alpha_f5 - float(c["immutableParentEvidence"]["v67"]["f5Alpha"])) > 1e-15 or abs(alpha_fg - float(c["immutableParentEvidence"]["v67"]["fullGameAlpha"])) > 1e-15:
        raise SystemExit("V73_V67_ALPHA_DRIFT")

    v66 = load(a.v66_totals_report)
    f5_model = v66["routes"]["V66_D_F5_TOTAL"]["primaryCandidate"]["model"]
    fg_model = v66["routes"]["V66_E_FULL_GAME_TOTAL"]["primaryCandidate"]["model"]
    f5_lines = [float(x) for x in c["totalCandidateRule"]["f5FixedHalfRunLinesExactly"]]
    fg_lines = [float(x) for x in c["totalCandidateRule"]["fullGameFixedHalfRunLinesExactly"]]

    v69c = load(a.v69_contract)
    seasons = tuple(c["evaluationUniverse"]["seasons"])
    expected_by = v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"]
    feature_map, eligible_dates = load_feature_maps(a.root, seasons, expected_by)
    custody = load_custody(a.custody)
    f5_outcomes = load_f5_outcomes(a.f5_outcomes)

    mod = load_module(a.v69_scorer)
    original_daily_cap = mod.daily_cap
    captured_calls = []
    captured_dates = None
    def capture_daily_cap(candidates, dates, cap):
        nonlocal captured_dates
        result = original_daily_cap(candidates, dates, cap)
        if captured_dates is None:
            captured_dates = set(dates)
        elif set(dates) != captured_dates:
            raise SystemExit("V73_V69_ELIGIBLE_DATE_SET_DRIFT")
        captured_calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result
    mod.daily_cap = capture_daily_cap
    parent_out = a.out + ".parent-v69-replay.json"
    old_argv = sys.argv[:]
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
            mod.main()
    finally:
        sys.argv = old_argv
    expected_calls = len(v69c["predeclaredConsensusScoreGrid"]) * 8
    if len(captured_calls) != expected_calls or captured_calls[4]["cap"] != 1:
        raise SystemExit("V73_V69_CAPTURE_CALL_DRIFT")
    top1_all = captured_calls[4]["opps"]
    parent_parity = {
        "opportunities": len(top1_all),
        "decisiveRows": sum(o["y"] is not None for o in top1_all),
        "wins": sum(o["y"] == 1 for o in top1_all),
        "losses": sum(o["y"] == 0 for o in top1_all),
        "pushes": sum(o["y"] is None for o in top1_all),
    }
    if parent_parity != {"opportunities":492,"decisiveRows":488,"wins":311,"losses":177,"pushes":4}:
        raise SystemExit(f"V73_FULL_PARENT_PARITY_FAILED:{parent_parity}")

    winner = [as_winner_candidate(o) for o in top1_all if o["date"][5:] >= "05-01"]
    wp = c["immutableParentEvidence"]["v71OperationalWindow"]
    wpar = {"pickDays":len(winner),"decisiveRows":sum(r["y"] is not None for r in winner),"wins":sum(r["y"]==1 for r in winner),"losses":sum(r["y"]==0 for r in winner),"pushes":sum(r["y"] is None for r in winner)}
    if wpar != {"pickDays":int(wp["expectedPickDays"]),"decisiveRows":int(wp["expectedDecisiveRows"]),"wins":int(wp["expectedWins"]),"losses":int(wp["expectedLosses"]),"pushes":int(wp["expectedPushes"])}:
        raise SystemExit(f"V73_MAY01_WINNER_PARITY_FAILED:{wpar}")

    f5_candidates = []
    fg_candidates = []
    for key,row in feature_map.items():
        if str(row["officialDate"])[5:] < "05-01":
            continue
        cr = custody.get(key)
        if cr is None:
            raise SystemExit(f"V73_CUSTODY_GAME_MISSING:{key}")
        f5 = central_total_candidate(row, cr, "F5", f5_model, alpha_f5, f5_lines, f5_outcomes)
        if f5 is not None:
            f5_candidates.append(f5)
        fg_candidates.append(central_total_candidate(row, cr, "FULL_GAME", fg_model, alpha_fg, fg_lines, f5_outcomes))

    f5_top1 = daily_top1(f5_candidates)
    fg_top1 = daily_top1(fg_candidates)
    totals_top1 = daily_top1(f5_top1 + fg_top1, {"FULL_GAME_TOTAL":0,"F5_TOTAL":1})
    unified = daily_top1(winner + f5_top1 + fg_top1, {"FROZEN_WINNER_TOP1":0,"FULL_GAME_TOTAL":1,"F5_TOTAL":2})

    resamples = int(c["reporting"]["bootstrapResamples"])
    seed = int(c["reporting"]["bootstrapSeed"])
    policies = {
        "FROZEN_WINNER_TOP1": stats(winner, seasons, resamples, seed),
        "F5_TOTAL_NB2_CENTRAL_LINE_TOP1": stats(f5_top1, seasons, resamples, seed+1),
        "FULL_GAME_TOTAL_NB2_CENTRAL_LINE_TOP1": stats(fg_top1, seasons, resamples, seed+2),
        "TOTALS_CROSS_HORIZON_TOP1": stats(totals_top1, seasons, resamples, seed+3),
        "UNIFIED_ALL_MARKETS_TOP1": stats(unified, seasons, resamples, seed+4),
    }
    report = {
        "schemaVersion": SCHEMA,
        "classification": "V73_UNIFIED_BEST_OPPORTUNITY_RETROSPECTIVE_AUDIT_COMPLETE",
        "parentParity": {"fullSeason": parent_parity, "may01": wpar},
        "candidateCounts": {"F5_TOTAL":len(f5_candidates),"FULL_GAME_TOTAL":len(fg_candidates)},
        "policies": policies,
        "unifiedVsFrozenWinner": head_to_head(unified, winner),
        "lineUsage": {
            "F5_TOTAL": dict(sorted(Counter(str(r["line"]) for r in f5_top1).items())),
            "FULL_GAME_TOTAL": dict(sorted(Counter(str(r["line"]) for r in fg_top1).items())),
            "UNIFIED_TOTAL_COMPONENT": dict(sorted(Counter(f"{r['family']}:{r.get('line')}" for r in unified if r["family"] != "FROZEN_WINNER_TOP1").items())),
        },
        "guardrails": {
            "retrospectiveAdaptiveDiscoveryOnly": True,
            "totalCentralLinesAreSyntheticPriceBlindResearchPropositions": True,
            "historicalPricesUsed": False,
            "marketOddsUsedAsFeatures": False,
            "outcomeDependentLineSearchPerformed": False,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "productionChanged": False,
            "prospectiveV68Changed": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "positiveEvEstablished": False,
            "realFinancialExposure": 0,
        },
        "scientificInterpretation": "V73 is a price-blind retrospective contest among an immutable winner TOP1 path and certified NB2 total-distribution paths using a predeclared model-central line rule. It may identify a promising predictive market family, but it cannot establish sportsbook profitability or future win probability without fresh prospective confirmation and a later actual-line/price layer."
    }
    dump(a.out, report)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass
    print(json.dumps({"classification":report["classification"],"policies":{k:{"opportunities":v["opportunities"],"wins":v["wins"],"losses":v["losses"],"pushes":v["pushes"],"hitRate":v["decisiveHitRate"],"marketShare":v["marketShare"]} for k,v in policies.items()},"headToHead":report["unifiedVsFrozenWinner"]},indent=2))


if __name__ == "__main__":
    main()
