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

SCHEMA = "courtedge-p0-step12v71-operational-start-window-top1.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v71-operational-start-window-top1-contract.v1"


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


def wilson(wins, n):
    if n == 0:
        return {"lower": 0.0, "upper": 0.0}
    z = 1.96
    p = wins / n
    den = 1.0 + z * z / n
    mid = (p + z * z / (2.0 * n)) / den
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n)) / den
    return {"lower": mid - half, "upper": mid + half}


def loss_streaks(opps):
    by_season = defaultdict(list)
    for o in opps:
        by_season[o["season"]].append(o)
    seasonal = {}
    combined_runs = []
    for season, rows in sorted(by_season.items()):
        rows = sorted(rows, key=lambda x: (x["date"], int(x["gamePk"])))
        runs = []
        cur = 0
        for o in rows:
            if o["y"] == 0:
                cur += 1
            else:
                if cur:
                    runs.append(cur)
                    cur = 0
        if cur:
            runs.append(cur)
        combined_runs.extend(runs)
        seasonal[season] = {
            "maximumConsecutiveLosingSelectedDays": max(runs) if runs else 0,
            "lossStreakLengthDistribution": dict(sorted(Counter(runs).items())),
        }
    return {
        "definition": "Consecutive active TOP1 pick days ending in a loss within the same season; wins and pushes break the streak, and off/no-pick days are not treated as selections.",
        "maximumConsecutiveLosingSelectedDaysWithinSeason": max(combined_runs) if combined_runs else 0,
        "lossStreakLengthDistributionAcrossSeasons": dict(sorted(Counter(combined_runs).items())),
        "bySeason": seasonal,
    }


def bootstrap(opps, resamples, seed):
    decisive = [o for o in opps if o["y"] is not None]
    if not decisive:
        return {"resamples": resamples, "seed": seed, "pointEstimate": None, "ci95": [None, None]}
    y = np.asarray([int(o["y"]) for o in decisive], dtype=float)
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    n = len(y)
    for i in range(resamples):
        vals[i] = float(y[rng.integers(0, n, size=n)].mean())
    return {
        "unit": "OFFICIAL_DATE",
        "distinctDatesWithDecisions": n,
        "resamples": resamples,
        "seed": seed,
        "pointEstimate": float(y.mean()),
        "ci95": [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))],
    }


def summarize(opps, eligible_dates, seasons, resamples, seed):
    opps = sorted(opps, key=lambda x: (x["date"], int(x["gamePk"])))
    if len({o["date"] for o in opps}) != len(opps):
        raise SystemExit("V71_TOP1_MORE_THAN_ONE_SELECTION_PER_DATE")
    decisive = [o for o in opps if o["y"] is not None]
    wins = sum(int(o["y"]) for o in decisive)
    losses = len(decisive) - wins
    pushes = len(opps) - len(decisive)
    base = {
        "eligibleSlateDays": len(eligible_dates),
        "activeTop1PickDays": len(opps),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "decisiveRows": len(decisive),
        "winRateAcrossAllPickDays": wins / len(opps) if opps else None,
        "decisiveHitRate": wins / len(decisive) if decisive else None,
        "lossRateAcrossAllPickDays": losses / len(opps) if opps else None,
        "pushRateAcrossAllPickDays": pushes / len(opps) if opps else None,
        "pctEligibleSlateDaysWithTop1Pick": 100.0 * len(opps) / len(eligible_dates) if eligible_dates else 0.0,
        "wilson95OnDecisiveHitRate": wilson(wins, len(decisive)),
        "officialDateBootstrapDecisiveHitRate": bootstrap(opps, resamples, seed),
        "lossStreaks": loss_streaks(opps),
    }
    by_season = {}
    for s in seasons:
        so = [o for o in opps if o["season"] == s]
        sd = sorted(d for d in eligible_dates if d.startswith(s[:4]))
        dec = [o for o in so if o["y"] is not None]
        w = sum(int(o["y"]) for o in dec)
        l = len(dec) - w
        p = len(so) - len(dec)
        by_season[s] = {
            "eligibleSlateDays": len(sd),
            "activeTop1PickDays": len(so),
            "wins": w,
            "losses": l,
            "pushes": p,
            "decisiveRows": len(dec),
            "winRateAcrossAllPickDays": w / len(so) if so else None,
            "decisiveHitRate": w / len(dec) if dec else None,
            "pctEligibleSlateDaysWithTop1Pick": 100.0 * len(so) / len(sd) if sd else 0.0,
            "wilson95OnDecisiveHitRate": wilson(w, len(dec)),
        }
    base["bySeason"] = by_season
    return base


def cutoff_filter(opps, eligible_dates, mmdd):
    chosen = [o for o in opps if o["date"][5:] >= mmdd]
    dates = {d for d in eligible_dates if d[5:] >= mmdd}
    return chosen, dates


def load_module(path):
    spec = importlib.util.spec_from_file_location("v69_frozen_parent", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V71_V69_IMPORT_FAILED")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_OPERATIONAL_START_WINDOW_TOP1_AUDIT_BEFORE_ANY_V71_SCORER_EXISTS":
        raise SystemExit("V71_CONTRACT_INVALID")
    if c.get("frozenPortfolioExactly") != "CONFLUENCE_LEDGER_TOP1_T0.550" or float(c.get("frozenConsensusThreshold")) != 0.55:
        raise SystemExit("V71_FROZEN_PORTFOLIO_DRIFT")
    for k in ("refitAllowed", "recalibrationAllowed", "featureSearchAllowed", "thresholdSearchAllowed", "routeSearchAllowed", "subsetMiningForPromotionAllowed"):
        if c["statistics"].get(k) is not False:
            raise SystemExit(f"V71_SEARCH_BOUNDARY_INVALID:{k}")

    expected_v69_scorer = c["immutableParentEvidence"]["v69Scorer"]["gitBlobSha"]
    expected_v69_contract = c["immutableParentEvidence"]["v69Contract"]["gitBlobSha"]
    if git_blob_sha(a.v69_scorer) != expected_v69_scorer:
        raise SystemExit("V71_V69_SCORER_BLOB_DRIFT")
    if git_blob_sha(a.v69_contract) != expected_v69_contract:
        raise SystemExit("V71_V69_CONTRACT_BLOB_DRIFT")

    v69c = load(a.v69_contract)
    if v69c.get("scientificStatus") != "FROZEN_DISCOVERY_AUDIT_PLAN_BEFORE_ANY_V69_SCORER_EXISTS":
        raise SystemExit("V71_V69_CONTRACT_STATUS_DRIFT")
    if list(v69c.get("predeclaredConsensusScoreGrid") or [])[0] != 0.55:
        raise SystemExit("V71_V69_GRID_ORDER_DRIFT")

    mod = load_module(a.v69_scorer)
    original_daily_cap = mod.daily_cap
    captured_calls = []
    captured_eligible_dates = None

    def capture_daily_cap(candidates, eligible_dates, cap):
        nonlocal captured_eligible_dates
        result = original_daily_cap(candidates, eligible_dates, cap)
        if captured_eligible_dates is None:
            captured_eligible_dates = set(eligible_dates)
        elif set(eligible_dates) != captured_eligible_dates:
            raise SystemExit("V71_V69_ELIGIBLE_DATE_SET_DRIFT_DURING_REPLAY")
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
    if len(captured_calls) != expected_calls:
        raise SystemExit(f"V71_V69_DAILY_CAP_CALL_SHAPE_DRIFT:{len(captured_calls)}:{expected_calls}")
    # Frozen V69 scorer call order for each threshold is:
    # general top1, general top2, reinforced top1, reinforced top2,
    # confluence top1, confluence top2, confluence-reinforced top1, confluence-reinforced top2.
    baseline = captured_calls[4]["opps"]
    if captured_calls[4]["cap"] != 1:
        raise SystemExit("V71_PARENT_TOP1_CAP_DRIFT")
    eligible_dates = set(captured_eligible_dates or set())

    expected = c["fullSeasonTop1ParityExpected"]
    decisive = [o for o in baseline if o["y"] is not None]
    wins = sum(int(o["y"]) for o in decisive)
    parity = {
        "opportunities": len(baseline),
        "decisiveRows": len(decisive),
        "wins": wins,
        "losses": len(decisive) - wins,
        "pushes": len(baseline) - len(decisive),
    }
    if parity != expected:
        raise SystemExit(f"V71_PARENT_TOP1_PARITY_FAILED:{parity}:{expected}")
    if len(eligible_dates) != int(c["evaluationUniverse"]["expectedEligibleSlateDaysFullUniverse"]):
        raise SystemExit("V71_PARENT_ELIGIBLE_DATE_PARITY_FAILED")

    seasons = tuple(c["evaluationUniverse"]["seasons"])
    resamples = int(c["reporting"]["bootstrapResamples"])
    seed = int(c["reporting"]["bootstrapSeed"])
    full_stats = summarize(baseline, eligible_dates, seasons, resamples, seed)

    windows = {}
    for spec in c["operationalStartWindowsExactly"]:
        wid = spec["id"]
        if wid == "MAY01":
            mmdd = "05-01"
        elif wid == "MAY15":
            mmdd = "05-15"
        else:
            raise SystemExit(f"V71_UNKNOWN_FROZEN_WINDOW:{wid}")
        wo, wd = cutoff_filter(baseline, eligible_dates, mmdd)
        st = summarize(wo, wd, seasons, resamples, seed + (1 if wid == "MAY01" else 2))
        st["officialDateRule"] = spec["officialDateRule"]
        st["interpretation"] = spec["interpretation"]
        st["excludedTop1PickDaysVsFullSeason"] = len(baseline) - len(wo)
        st["decisiveHitRateDifferenceVsFullSeason"] = (
            st["decisiveHitRate"] - full_stats["decisiveHitRate"]
            if st["decisiveHitRate"] is not None and full_stats["decisiveHitRate"] is not None else None
        )
        windows[wid] = st

    report = {
        "schemaVersion": SCHEMA,
        "classification": "V71_OPERATIONAL_START_WINDOW_TOP1_RETROSPECTIVE_AUDIT_COMPLETE",
        "scientificInterpretation": "This report answers a narrow operational question: how often the already-frozen V69 single highest-priority daily selection won when play begins on May 1 or May 15. Both windows were frozen before the V71 scorer and are reported without selecting the historically better cutoff for promotion.",
        "sourceIdentity": {
            "v69ScorerGitBlobSha": git_blob_sha(a.v69_scorer),
            "v69ContractGitBlobSha": git_blob_sha(a.v69_contract),
            "frozenPortfolio": c["frozenPortfolioExactly"],
            "frozenConsensusThreshold": c["frozenConsensusThreshold"],
        },
        "fullSeasonTop1Parity": parity,
        "fullSeasonTop1Stats": full_stats,
        "operationalStartWindows": windows,
        "interpretationGuardrails": {
            "bothFrozenWindowsReported": True,
            "historicalBestWindowChosenForPromotion": False,
            "newDateCutoffSearchPerformed": False,
            "v69PortfolioChanged": False,
            "v69ThresholdChanged": False,
            "forcedPlayAllowed": False,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "prospectiveV68Changed": False,
            "productionChanged": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, report)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass
    print(json.dumps({
        "classification": report["classification"],
        "fullSeasonParity": parity,
        "windows": {
            k: {
                "eligibleSlateDays": v["eligibleSlateDays"],
                "activeTop1PickDays": v["activeTop1PickDays"],
                "wins": v["wins"],
                "losses": v["losses"],
                "pushes": v["pushes"],
                "decisiveHitRate": v["decisiveHitRate"],
                "winRateAcrossAllPickDays": v["winRateAcrossAllPickDays"],
                "pctEligibleSlateDaysWithTop1Pick": v["pctEligibleSlateDaysWithTop1Pick"],
                "wilson95": v["wilson95OnDecisiveHitRate"],
                "bootstrap95": v["officialDateBootstrapDecisiveHitRate"]["ci95"],
                "maxConsecutiveLosingSelectedDays": v["lossStreaks"]["maximumConsecutiveLosingSelectedDaysWithinSeason"],
                "bySeason": v["bySeason"],
            } for k, v in windows.items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
