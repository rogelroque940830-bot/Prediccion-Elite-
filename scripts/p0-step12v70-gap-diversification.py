#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np

SCHEMA = "courtedge-p0-step12v70-gap-diversification.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v70-gap-diversification-contract.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V70_MODULE_LOAD_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def wilson(w, n):
    if n == 0:
        return {"lower": 0.0, "upper": 0.0}
    z = 1.96
    p = w / n
    den = 1.0 + z * z / n
    mid = (p + z * z / (2.0 * n)) / den
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n)) / den
    return {"lower": mid - half, "upper": mid + half}


def no_play_streaks(counts, ordered_dates):
    runs = []
    cur = 0
    for d in ordered_dates:
        if counts.get(d, 0) == 0:
            cur += 1
        elif cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return {
        "maximumNoPlaySlateDayStreak": max(runs) if runs else 0,
        "numberNoPlayStreaksAtLeast2": sum(x >= 2 for x in runs),
        "numberNoPlayStreaksAtLeast3": sum(x >= 3 for x in runs),
        "noPlayStreakLengthDistribution": dict(sorted(Counter(runs).items())),
    }


def bootstrap_hit(opps, resamples, seed):
    by = defaultdict(lambda: [0, 0])
    for o in opps:
        if o["y"] is None:
            continue
        by[o["date"]][0] += int(o["y"])
        by[o["date"]][1] += 1
    keys = sorted(by)
    if not keys:
        return {"unit": "OFFICIAL_DATE_CLUSTER", "distinctDatesWithDecisions": 0, "resamples": resamples, "seed": seed, "pointEstimate": None, "ci95": [None, None]}
    a = np.asarray([by[k] for k in keys], dtype=float)
    point = float(a[:, 0].sum() / a[:, 1].sum())
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    k = len(keys)
    for i in range(resamples):
        pick = rng.integers(0, k, size=k)
        z = a[pick].sum(axis=0)
        vals[i] = z[0] / z[1] if z[1] else np.nan
    vals = vals[np.isfinite(vals)]
    return {
        "unit": "OFFICIAL_DATE_CLUSTER",
        "distinctDatesWithDecisions": len(keys),
        "resamples": resamples,
        "seed": seed,
        "pointEstimate": point,
        "ci95": [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))],
    }


def portfolio_stats(opps, eligible_dates, seasons, c):
    dates = sorted(eligible_dates)
    counts = Counter(o["date"] for o in opps)
    decisive = [o for o in opps if o["y"] is not None]
    wins = sum(int(o["y"]) for o in decisive)
    vals = [counts.get(d, 0) for d in dates]
    def pct(pred):
        return 100.0 * sum(pred(x) for x in vals) / len(vals) if vals else 0.0
    by_season = {}
    for s in seasons:
        year = s[:4]
        sd = sorted(d for d in dates if d.startswith(year))
        so = [o for o in opps if o["season"] == s]
        dec = [o for o in so if o["y"] is not None]
        w = sum(int(o["y"]) for o in dec)
        sc = Counter(o["date"] for o in so)
        by_season[s] = {
            "opportunities": len(so),
            "decisiveRows": len(dec),
            "wins": w,
            "losses": len(dec) - w,
            "pushes": len(so) - len(dec),
            "hitRate": w / len(dec) if dec else None,
            "wilson95": wilson(w, len(dec)),
            "eligibleSlateDays": len(sd),
            "pctDaysWithAtLeast1": 100.0 * sum(sc.get(d, 0) >= 1 for d in sd) / len(sd) if sd else 0.0,
            "meanSelectionsPerEligibleSlateDay": len(so) / len(sd) if sd else 0.0,
            **no_play_streaks(sc, sd),
        }
    out = {
        "opportunities": len(opps),
        "decisiveRows": len(decisive),
        "wins": wins,
        "losses": len(decisive) - wins,
        "pushes": len(opps) - len(decisive),
        "hitRate": wins / len(decisive) if decisive else None,
        "wilson95": wilson(wins, len(decisive)),
        "eligibleSlateDays": len(dates),
        "meanSelectionsPerEligibleSlateDay": len(opps) / len(dates) if dates else 0.0,
        "pctDaysWithZero": pct(lambda x: x == 0),
        "pctDaysWithAtLeast1": pct(lambda x: x >= 1),
        "pctDaysWithAtLeast2": pct(lambda x: x >= 2),
        "maximumSelectionsOneDay": max(vals) if vals else 0,
        "zeroSlateDays": sum(x == 0 for x in vals),
        "bySeason": by_season,
        **no_play_streaks(counts, dates),
        "officialDateClusterBootstrapHitRate": bootstrap_hit(
            opps,
            int(c["operationalDiagnostics"]["bootstrapResamples"]),
            int(c["operationalDiagnostics"]["bootstrapSeed"]),
        ),
    }
    q = c["operationalDiagnostics"]
    out["operationalPreferenceChecks"] = {
        "maxDroughtAtMostPreferred": out["maximumNoPlaySlateDayStreak"] <= int(q["preferredMaximumNoPlaySlateDayStreak"]),
        "coverageAtLeastPreferred": out["pctDaysWithAtLeast1"] >= float(q["preferredPctSlateDaysWithAtLeast1"]),
        "hitRateAtLeastPreferred": out["hitRate"] is not None and out["hitRate"] >= float(q["preferredCombinedDecisiveHitRateMin"]),
        "wilsonLowerAtLeastPreferred": out["wilson95"]["lower"] >= float(q["preferredCombinedWilson95LowerMin"]),
        "meanSelectionsAtMostPreferred": out["meanSelectionsPerEligibleSlateDay"] <= float(q["preferredMeanSelectionsPerSlateDayMax"]),
        "hardDailyCapRespected": out["maximumSelectionsOneDay"] <= int(c["portfolioRules"]["hardMaximumSelectionsPerSlateDay"]),
    }
    out["meetsAllOperationalPreferences"] = all(out["operationalPreferenceChecks"].values())
    return out


def outcome_f5(raw):
    o = raw["outcomes"]["FIRST_5"]
    if int(o["homeRuns"]) == int(o["awayRuns"]):
        return None
    return int(int(o["homeRuns"]) > int(o["awayRuns"]))


def basic_anchor(rows):
    dec = [r for r in rows if r["f5Y"] is not None]
    w = sum(int(r["f5Y"]) for r in dec)
    return {"selectedRows": len(rows), "decisiveRows": len(dec), "wins": w, "losses": len(dec)-w, "pushes": len(rows)-len(dec)}


def rank_gap_rows(rows, policy):
    def key(r):
        if policy in ("PARETO_THEN_ANY_OUTSIDE_A", "F5_CONSENSUS_ALL"):
            p0 = 0 if r.get("pareto") else 1
            p1 = 0 if r.get("hrpa") else 1
        else:
            p0 = p1 = 0
        return (p0, p1, -float(r["f5Score"]), int(r["gamePk"]))
    return sorted(rows, key=key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--pitch-dir", required=True)
    ap.add_argument("--custody", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--v68-contract", required=True)
    ap.add_argument("--classifier-source", required=True)
    ap.add_argument("--router-source", required=True)
    ap.add_argument("--v69-scorer", required=True)
    ap.add_argument("--v69-summary", required=True)
    ap.add_argument("--v19-scorer", required=True)
    ap.add_argument("--v19-contract", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_ADAPTIVE_DIVERSIFICATION_PLAN_BEFORE_ANY_V70_SCORER_EXISTS":
        raise SystemExit("V70_CONTRACT_INVALID")
    if any(c["statistics"].get(k) is not False for k in ("newFeatureSearchAllowed", "newNumericThresholdSearchAllowed", "v69ThresholdRelaxationAllowed", "v19RouteMutationAllowed", "postOutcomeGapFillRouteAdditionAllowed")):
        raise SystemExit("V70_SEARCH_BOUNDARY_INVALID")

    if git_blob_sha(a.v69_scorer) != c["frozenBaseline"]["v69ScorerGitBlobSha"]:
        raise SystemExit("V70_V69_SCORER_DRIFT")
    if git_blob_sha(a.v69_summary) != c["frozenBaseline"]["v69ResultSummaryGitBlobSha"]:
        raise SystemExit("V70_V69_SUMMARY_DRIFT")
    if git_blob_sha(a.v19_scorer) != c["frozenDiversificationSources"]["v19ScorerGitBlobSha"]:
        raise SystemExit("V70_V19_SCORER_DRIFT")
    if git_blob_sha(a.v19_contract) != c["frozenDiversificationSources"]["v19ContractGitBlobSha"]:
        raise SystemExit("V70_V19_CONTRACT_DRIFT")

    v69 = module(a.v69_scorer, "v69f")
    v19 = module(a.v19_scorer, "v19f")
    v19c = load(a.v19_contract)
    summary69 = load(a.v69_summary)
    seasons = tuple(c["evaluationUniverse"]["seasons"])
    custody = v69.load_custody(a.custody)
    v16 = load(a.v16_manifest)
    v68c = load(a.v68_contract)
    version, premium_rules, models = v69.parse_frozen_classifier_source(a.classifier_source)
    if version != "mlb-frozen-a-plus-classifier.v1":
        raise SystemExit("V70_CLASSIFIER_VERSION_DRIFT")
    if "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" not in open(a.router_source, encoding="utf-8").read():
        raise SystemExit("V70_ROUTER_VERSION_DRIFT")
    v16_model = v16["fullGame"]
    v68_model = v68c["primaryCandidate"]["modelSnapshot"]

    rows = []
    eligible_dates = set()
    for s in seasons:
        tab = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        if tab.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"V70_BASE_SCHEMA_DRIFT:{s}")
        for raw in tab["rows"]:
            if raw.get("t5PregameValid") is not True:
                continue
            key = (s, int(raw["gamePk"]))
            if key not in custody:
                raise SystemExit(f"V70_CUSTODY_MISSING:{key}")
            cr = custody[key]
            f = raw.get("features") or {}
            cls = v69.classify(f, premium_rules, models)
            p16 = v69.frozen_binary_prob(cr, v16_model)
            p68 = v69.frozen_binary_prob(cr, v68_model)
            side16 = "HOME" if p16 >= 0.5 else "AWAY"
            side68 = "HOME" if p68 >= 0.5 else "AWAY"
            agree = side16 == side68
            p16sel = p16 if side16 == "HOME" else 1.0-p16
            p68sel = p68 if side16 == "HOME" else 1.0-p68
            consensus = min(p16sel, p68sel) if agree else None
            d1 = cr.get("bullpen_pitches_1d_adv")
            date = str(raw["officialDate"])
            eligible_dates.add(date)
            rows.append({
                "season": s, "date": date, "gamePk": int(raw["gamePk"]), "raw": raw, **cls,
                "p16Home": p16, "p68Home": p68, "selectedSide": side16,
                "v16v68Agree": agree, "consensusScore": consensus,
                "p16Selected": p16sel if agree else None, "p68Selected": p68sel if agree else None,
                "bullpenPitches1dAdv": float(d1) if finite(d1) else None,
            })
    if len(rows) != int(c["evaluationUniverse"]["expectedRows"]) or len(eligible_dates) != int(c["evaluationUniverse"]["expectedEligibleSlateDays"]):
        raise SystemExit(f"V70_UNIVERSE_DRIFT:{len(rows)}:{len(eligible_dates)}")

    routes = defaultdict(list)
    general = []
    for r in rows:
        if r["premiumA"]:
            market = "FIRST_5_ML" if r["f5Consensus"] else "FULL_GAME_ML"
            routes["PREMIUM_A_ROUTE_SWITCH"].append(v69.make_opp(r, market, "HOME", "PREMIUM_A_ROUTE_SWITCH", 3, r["classifierScore"]))
        if r["aPlus"]:
            if not finite(r["bullpenPitches1dAdv"]):
                raise SystemExit(f"V70_APLUS_D1_MISSING:{r['season']}:{r['gamePk']}")
            market = "FIRST_5_ML" if r["bullpenPitches1dAdv"] > 0 else "FULL_GAME_ML"
            routes["A_PLUS_D1_ROUTER"].append(v69.make_opp(r, market, "HOME", "A_PLUS_D1_ROUTER", 2, r["classifierScore"]))
        if r["premiumA"] and r["p68Home"] >= 0.5:
            market = "FIRST_5_ML" if r["f5Consensus"] else "FULL_GAME_ML"
            routes["PREMIUM_A_V68_AGREE_ROUTE_SWITCH"].append(v69.make_opp(r, market, "HOME", "PREMIUM_A_V68_AGREE_ROUTE_SWITCH", 1, min(r["p68Home"], r["classifierScore"])))
        if r["aPlus"] and r["p68Home"] >= 0.5:
            market = "FIRST_5_ML" if r["bullpenPitches1dAdv"] > 0 else "FULL_GAME_ML"
            routes["A_PLUS_V68_AGREE_D1_ROUTER"].append(v69.make_opp(r, market, "HOME", "A_PLUS_V68_AGREE_D1_ROUTER", 0, min(r["p68Home"], r["classifierScore"])))
        if r["v16v68Agree"] and r["consensusScore"] is not None and r["consensusScore"] >= float(c["frozenBaseline"]["consensusThreshold"]):
            general.append(v69.make_opp(r, "FULL_GAME_ML", r["selectedSide"], "V16_V68_CONSENSUS_T0.550", 4, r["consensusScore"]))

    special = []
    special.extend(routes["A_PLUS_V68_AGREE_D1_ROUTER"])
    special.extend(routes["PREMIUM_A_V68_AGREE_ROUTE_SWITCH"])
    special.extend(routes["A_PLUS_D1_ROUTER"])
    special.extend(routes["PREMIUM_A_ROUTE_SWITCH"])
    special.extend(general)
    baseline = v69.daily_cap(v69.dedupe_ledger(special), eligible_dates, int(c["frozenBaseline"]["dailyCap"]))
    baseline_stats = portfolio_stats(baseline, eligible_dates, seasons, c)
    b = c["frozenBaseline"]
    checks = {
        "opportunities": (baseline_stats["opportunities"], int(b["expectedOpportunities"])),
        "decisiveRows": (baseline_stats["decisiveRows"], int(b["expectedDecisiveRows"])),
        "wins": (baseline_stats["wins"], int(b["expectedWins"])),
        "losses": (baseline_stats["losses"], int(b["expectedLosses"])),
        "pushes": (baseline_stats["pushes"], int(b["expectedPushes"])),
        "zeroSlateDays": (baseline_stats["zeroSlateDays"], int(b["expectedZeroSlateDays"])),
        "maximumNoPlaySlateDayStreak": (baseline_stats["maximumNoPlaySlateDayStreak"], int(b["expectedMaxNoPlaySlateDayStreak"])),
    }
    for name, (got, exp) in checks.items():
        if got != exp:
            raise SystemExit(f"V70_V69_BASELINE_PARITY_FAILED:{name}:{got}:{exp}")
    for name, got, exp in (
        ("hitRate", baseline_stats["hitRate"], float(b["expectedHitRate"])),
        ("meanSelections", baseline_stats["meanSelectionsPerEligibleSlateDay"], float(b["expectedMeanSelectionsPerSlateDay"])),
        ("coverage", baseline_stats["pctDaysWithAtLeast1"], float(b["expectedPctDaysAtLeast1"])),
    ):
        if abs(float(got)-exp) > 1e-15:
            raise SystemExit(f"V70_V69_BASELINE_PARITY_FAILED:{name}:{got}:{exp}")
    summary_name = summary69["closestHighCoveragePoint"]["name"]
    contract_name = b["name"]
    normalized_contract_name = contract_name[4:] if contract_name.startswith("V69_") else contract_name
    if summary_name not in (contract_name, normalized_contract_name):
        raise SystemExit(f"V70_V69_SUMMARY_NAME_DRIFT:{summary_name}:{contract_name}")

    all_pitch = (v19c["dataBoundary"]["pitchmixWarmupSeason"],) + seasons
    enrich = v19.make_pitchmix_enricher(
        a.pitch_dir,
        all_pitch,
        v19c["frozenPitchmix"],
        int(v19c["dataBoundary"]["rollingPitchmixLookbackDays"]),
    )
    f5_rows = []
    for r in rows:
        if not r["f5Consensus"]:
            continue
        raw = r["raw"]
        hp = raw.get("t5HomeProbablePitcherId")
        ap0 = raw.get("t5AwayProbablePitcherId")
        pm = {
            "season": r["season"], "date": r["date"], "gamePk": r["gamePk"],
            "homeTeamId": int(raw["homeTeamId"]), "awayTeamId": int(raw["awayTeamId"]),
            "homeStarterId": int(hp) if hp is not None else None,
            "awayStarterId": int(ap0) if ap0 is not None else None,
            "premiumA": bool(r["premiumA"]), "f5Consensus": True,
            "f5Y": outcome_f5(raw), "f5Score": min(float(r["f5C4PHome"]), float(r["f5Full13PHome"])),
        }
        if not pm["premiumA"]:
            pm = enrich(pm)
            hr = pm.get("pitchmixEligible") is True and finite(pm.get("pitchmix_rel_hrpa_adv")) and float(pm["pitchmix_rel_hrpa_adv"]) > 0
            tb = pm.get("pitchmixEligible") is True and finite(pm.get("pitchmix_rel_tbpa_adv")) and float(pm["pitchmix_rel_tbpa_adv"]) > 0
            at2 = pm.get("pitchmixEligible") is True and int(pm.get("positiveCount", 0)) >= 2
            pm["hrpa"] = bool(hr or at2)
            pm["pareto"] = bool(hr or tb or at2)
        else:
            pm["hrpa"] = False
            pm["pareto"] = False
        f5_rows.append(pm)

    outside = [r for r in f5_rows if not r["premiumA"]]
    hrpa = [r for r in outside if r["hrpa"]]
    pareto = [r for r in outside if r["pareto"]]
    actual_anchors = {
        "F5_CONSENSUS": basic_anchor(f5_rows),
        "F5_CONSENSUS_OUTSIDE_A": basic_anchor(outside),
        "F5_OUTSIDE_A_HRPA_OR_AT2": basic_anchor(hrpa),
        "F5_OUTSIDE_A_PARETO_UNION": basic_anchor(pareto),
    }
    for name, got in actual_anchors.items():
        exp = c["frozenDiversificationSources"]["v19FrozenAnchors"][name]
        if got != exp:
            raise SystemExit(f"V70_V19_ANCHOR_DRIFT:{name}:{got}:{exp}")

    baseline_counts = Counter(o["date"] for o in baseline)
    gap_dates = sorted(d for d in eligible_dates if baseline_counts.get(d, 0) == 0)
    if len(gap_dates) != int(b["expectedZeroSlateDays"]):
        raise SystemExit(f"V70_GAP_COUNT_DRIFT:{len(gap_dates)}")
    by_date_all = defaultdict(list)
    for r in f5_rows:
        by_date_all[r["date"]].append(r)

    policies = {}
    for policy in c["candidateGapFillPoliciesExactly"]:
        fills = []
        for d in gap_dates:
            pool = by_date_all.get(d, [])
            if policy == "PARETO_ONLY":
                pool = [r for r in pool if (not r["premiumA"]) and r["pareto"]]
            elif policy == "HRPA_OR_AT2_ONLY":
                pool = [r for r in pool if (not r["premiumA"]) and r["hrpa"]]
            elif policy == "F5_CONSENSUS_OUTSIDE_A":
                pool = [r for r in pool if not r["premiumA"]]
            elif policy == "PARETO_THEN_ANY_OUTSIDE_A":
                pool = [r for r in pool if not r["premiumA"]]
            elif policy == "F5_CONSENSUS_ALL":
                pool = list(pool)
            else:
                raise SystemExit(f"V70_UNKNOWN_POLICY:{policy}")
            ranked = rank_gap_rows(pool, policy)
            if ranked:
                r = ranked[0]
                fills.append({
                    "season": r["season"], "date": r["date"], "gamePk": r["gamePk"],
                    "market": "FIRST_5_ML", "side": "HOME", "route": f"V70_GAP_FILL_{policy}",
                    "priority": -1, "rankScore": r["f5Score"], "classifierScore": r["f5Score"],
                    "consensusScore": None, "p16Selected": None, "p68Selected": None,
                    "y": r["f5Y"], "pareto": bool(r["pareto"]), "hrpa": bool(r["hrpa"]),
                })
        if any(o["date"] not in gap_dates for o in fills):
            raise SystemExit(f"V70_FILL_OUTSIDE_GAP:{policy}")
        combined = baseline + fills
        combined_stats = portfolio_stats(combined, eligible_dates, seasons, c)
        if combined_stats["maximumSelectionsOneDay"] > int(c["portfolioRules"]["hardMaximumSelectionsPerSlateDay"]):
            raise SystemExit(f"V70_DAILY_CAP_BREACH:{policy}")
        remaining = sorted(d for d in gap_dates if d not in {o["date"] for o in fills})
        fill_dec = [o for o in fills if o["y"] is not None]
        fw = sum(int(o["y"]) for o in fill_dec)
        policies[policy] = {
            "gapFill": {
                "opportunities": len(fills),
                "decisiveRows": len(fill_dec),
                "wins": fw,
                "losses": len(fill_dec)-fw,
                "pushes": len(fills)-len(fill_dec),
                "hitRate": fw/len(fill_dec) if fill_dec else None,
                "wilson95": wilson(fw, len(fill_dec)),
                "coveredGapDays": len({o["date"] for o in fills}),
                "remainingGapDays": len(remaining),
                "remainingGapDateList": remaining,
                "selectedGapRows": [{k:o[k] for k in ("season","date","gamePk","market","side","route","rankScore","pareto","hrpa","y")} for o in fills],
            },
            "combinedPortfolio": combined_stats,
        }

    matches = sorted(name for name, obj in policies.items() if obj["combinedPortfolio"]["meetsAllOperationalPreferences"])
    classification = (
        "V70_EXISTING_F5_DIVERSIFICATION_MEETS_RETROSPECTIVE_OPERATIONAL_PREFERENCES"
        if matches else
        "V70_EXISTING_F5_DIVERSIFICATION_DOES_NOT_MEET_ALL_RETROSPECTIVE_OPERATIONAL_PREFERENCES"
    )
    report = {
        "schemaVersion": SCHEMA,
        "classification": classification,
        "scientificStatus": "ADAPTIVE_RETROSPECTIVE_DIVERSIFICATION_ONLY_NOT_INDEPENDENT_CONFIRMATION",
        "sample": {"rows": len(rows), "eligibleSlateDays": len(eligible_dates), "seasons": list(seasons)},
        "baselineV69": {"stats": baseline_stats, "gapDateList": gap_dates},
        "v19AnchorParity": {"passed": True, "actual": actual_anchors},
        "policies": policies,
        "operationalPreferenceMatches": matches,
        "interpretation": {
            "v70WasMotivatedByObservedV69Gaps": True,
            "candidateF5RoutesPredateV69": True,
            "gapOutcomesWereNotUsedToDefineThisContract": True,
            "resultMayNotBePromotedFromThisRetrospectiveAudit": True,
            "forcedPlayAllowed": False,
            "v69ThresholdRelaxed": False,
            "v19RouteMutated": False,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "prospectiveV68Changed": False,
            "productionChanged": False,
            "realFinancialExposure": 0,
        },
        "policy": {
            "researchOnly": True,
            "adaptiveRetrospectiveOnly": True,
            "newFeatureSearchPerformed": False,
            "newNumericThresholdSearchPerformed": False,
            "postOutcomeRouteAdditionPerformed": False,
            "liveLookupAuthorizationChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBettingAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, report)
    compact = {name: {
        "fill": {k: obj["gapFill"][k] for k in ("opportunities","decisiveRows","wins","losses","pushes","hitRate","coveredGapDays","remainingGapDays")},
        "combined": {k: obj["combinedPortfolio"][k] for k in ("opportunities","hitRate","wilson95","meanSelectionsPerEligibleSlateDay","pctDaysWithAtLeast1","maximumNoPlaySlateDayStreak","zeroSlateDays","meetsAllOperationalPreferences")},
    } for name, obj in policies.items()}
    print(json.dumps({"classification": classification, "operationalPreferenceMatches": matches, "policies": compact}, indent=2))


if __name__ == "__main__":
    main()
