#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import math
import os
import re
from collections import Counter, defaultdict

import numpy as np

SCHEMA = "courtedge-p0-step12v69-confluence-frequency-quality-frontier.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v69-confluence-frequency-quality-frontier-contract.v1"
V16_SCHEMA = "courtedge-p0-step12v16-pure-settlement-model-manifest.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
EPS = 1e-15


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


def canonical_digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def sigmoid_scalar(z):
    z = max(-50.0, min(50.0, float(z)))
    return 1.0 / (1.0 + math.exp(-z))


def parse_frozen_classifier_source(path):
    text = open(path, encoding="utf-8").read()
    version = re.search(r'MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION\s*=\s*\n?\s*"([^"]+)"', text)
    if not version:
        raise SystemExit("V69_CLASSIFIER_VERSION_PARSE_FAILED")
    pblock = re.search(r"MLB_FROZEN_PREMIUM_A_THRESHOLDS\s*=\s*Object\.freeze\(\{(.*?)\}\);", text, re.S)
    if not pblock:
        raise SystemExit("V69_PREMIUM_A_THRESHOLDS_PARSE_FAILED")
    premium = {}
    for name, val in re.findall(r"([A-Za-z0-9_]+):\s*([-+0-9.eE]+)", pblock.group(1)):
        premium[name] = float(val)
    model_re = re.compile(
        r"([A-Z0-9_]+):\s*Object\.freeze\(\{\s*"
        r"intercept:\s*([-+0-9.eE]+),\s*threshold:\s*([-+0-9.eE]+),\s*"
        r"features:\s*Object\.freeze\(\[(.*?)\]\),\s*\}\),",
        re.S,
    )
    feature_re = re.compile(
        r'\{\s*name:\s*"([^"]+)",\s*coef:\s*([-+0-9.eE]+),\s*mean:\s*([-+0-9.eE]+),\s*'
        r"medianImpute:\s*([-+0-9.eE]+),\s*scale:\s*([-+0-9.eE]+)\s*\}"
    )
    models = {}
    for model_id, intercept, threshold, body in model_re.findall(text):
        features = []
        for name, coef, mean, median, scale in feature_re.findall(body):
            features.append({
                "name": name,
                "coef": float(coef),
                "mean": float(mean),
                "medianImpute": float(median),
                "scale": float(scale),
            })
        models[model_id] = {
            "intercept": float(intercept),
            "threshold": float(threshold),
            "features": features,
        }
    expected = {
        "A_PLUS_C4_2022_FROZEN",
        "A_PLUS_FULL13_2022_FROZEN",
        "F5_C4_2022_FROZEN",
        "F5_FULL13_2022_FROZEN",
    }
    if set(models) != expected or any(not models[k]["features"] for k in expected):
        raise SystemExit(f"V69_CLASSIFIER_MODELS_PARSE_FAILED:{sorted(models)}")
    if premium != {
        "team_win10_diff": 0.09999999999999998,
        "starter_kbb_adv": 0.02481042579422841,
        "lineup_exposure_rate_adv": 0.09876543209876554,
    }:
        raise SystemExit(f"V69_PREMIUM_A_THRESHOLD_DRIFT:{premium}")
    return version.group(1), premium, models


def frozen_classifier_prob(features, model):
    z = float(model["intercept"])
    for spec in model["features"]:
        raw = features.get(spec["name"])
        value = float(raw) if finite(raw) else float(spec["medianImpute"])
        z += float(spec["coef"]) * ((value - float(spec["mean"])) / float(spec["scale"]))
    return sigmoid_scalar(z)


def classify(features, premium_rules, models):
    premium = all(finite(features.get(name)) and float(features[name]) >= threshold for name, threshold in premium_rules.items())
    pa_c4 = frozen_classifier_prob(features, models["A_PLUS_C4_2022_FROZEN"])
    pa_f13 = frozen_classifier_prob(features, models["A_PLUS_FULL13_2022_FROZEN"])
    f5_c4 = frozen_classifier_prob(features, models["F5_C4_2022_FROZEN"])
    f5_f13 = frozen_classifier_prob(features, models["F5_FULL13_2022_FROZEN"])
    aplus = premium and pa_c4 >= models["A_PLUS_C4_2022_FROZEN"]["threshold"] and pa_f13 >= models["A_PLUS_FULL13_2022_FROZEN"]["threshold"]
    f5 = f5_c4 >= models["F5_C4_2022_FROZEN"]["threshold"] and f5_f13 >= models["F5_FULL13_2022_FROZEN"]["threshold"]
    return {
        "premiumA": premium,
        "aPlus": aplus,
        "f5Consensus": f5,
        "aPlusC4PHome": pa_c4,
        "aPlusFull13PHome": pa_f13,
        "f5C4PHome": f5_c4,
        "f5Full13PHome": f5_f13,
        "classifierScore": min(pa_c4, pa_f13),
    }


def load_custody(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    out = {}
    total = 0
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            total += 1
            key = (str(r["season"]), int(r["gamePk"]))
            if key in out:
                raise SystemExit(f"V69_DUPLICATE_CUSTODY:{key}")
            out[key] = r
    if total != 11407:
        raise SystemExit(f"V69_CUSTODY_TOTAL_DRIFT:{total}")
    return out


def transform_one(row, pre):
    xs = []
    for name, med, mean, scale in zip(pre["features"], pre["medianImpute"], pre["mean"], pre["scale"]):
        raw = row.get(name)
        value = float(raw) if finite(raw) else float(med)
        s = float(scale)
        if not math.isfinite(s) or s <= 0:
            raise SystemExit(f"V69_INVALID_FROZEN_SCALE:{name}:{s}")
        xs.append((value - float(mean)) / s)
    return np.asarray(xs, dtype=float)


def frozen_binary_prob(row, model):
    x = transform_one(row, model["preprocessor"])
    z = float(model["intercept"]) + float(x @ np.asarray(model["coefficients"], dtype=float))
    cal = model["calibration"]
    return sigmoid_scalar(float(cal["slope"]) * z + float(cal["intercept"]))


def outcome_for(raw, market, side):
    if market == "FULL_GAME_ML":
        o = raw["outcomes"]["FULL_GAME"]
        result = o.get("result")
        if result not in ("HOME", "AWAY"):
            raise SystemExit(f"V69_INVALID_FG_RESULT:{raw['gamePk']}:{result}")
        return int(result == side)
    if market == "FIRST_5_ML":
        o = raw["outcomes"]["FIRST_5"]
        result = o.get("result")
        if result == "TIE":
            return None
        if result not in ("HOME", "AWAY"):
            raise SystemExit(f"V69_INVALID_F5_RESULT:{raw['gamePk']}:{result}")
        return int(result == side)
    raise SystemExit(f"V69_UNKNOWN_MARKET:{market}")


def make_opp(row, market, side, route, priority, rank_score=None):
    return {
        "season": row["season"],
        "date": row["date"],
        "gamePk": row["gamePk"],
        "market": market,
        "side": side,
        "route": route,
        "priority": int(priority),
        "rankScore": float(rank_score) if rank_score is not None else None,
        "classifierScore": float(row["classifierScore"]),
        "consensusScore": float(row["consensusScore"]) if row["consensusScore"] is not None else None,
        "p16Selected": float(row["p16Selected"]) if row["p16Selected"] is not None else None,
        "p68Selected": float(row["p68Selected"]) if row["p68Selected"] is not None else None,
        "y": outcome_for(row["raw"], market, side),
    }


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


def probability_metrics(opps):
    z = [o for o in opps if o["market"] == "FULL_GAME_ML" and o["y"] is not None and finite(o.get("p16Selected")) and finite(o.get("p68Selected"))]
    if len(z) != len([o for o in opps if o["y"] is not None]):
        return None
    if not z:
        return None
    y = np.asarray([o["y"] for o in z], dtype=float)
    p16 = np.asarray([o["p16Selected"] for o in z], dtype=float)
    p68 = np.asarray([o["p68Selected"] for o in z], dtype=float)
    def m(p):
        ll = -float(np.mean(y * np.log(np.maximum(p, EPS)) + (1-y) * np.log(np.maximum(1-p, EPS))))
        br = float(np.mean((p-y)**2))
        return {"n": len(y), "logLoss": ll, "brier": br, "meanSelectedProbability": float(p.mean()), "observedSelectedWinRate": float(y.mean())}
    a, b = m(p16), m(p68)
    return {"v16": a, "v68": b, "deltaV16MinusV68": {"logLossImprovement": a["logLoss"]-b["logLoss"], "brierImprovement": a["brier"]-b["brier"]}}


def bootstrap_hit_rate(opps, resamples, seed):
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
    point = float(a[:,0].sum()/a[:,1].sum())
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    k = len(keys)
    for i in range(resamples):
        pick = rng.integers(0, k, size=k)
        s = a[pick].sum(axis=0)
        vals[i] = s[0]/s[1] if s[1] else np.nan
    vals = vals[np.isfinite(vals)]
    return {
        "unit": "OFFICIAL_DATE_CLUSTER",
        "distinctDatesWithDecisions": len(keys),
        "resamples": resamples,
        "seed": seed,
        "pointEstimate": point,
        "ci95": [float(np.quantile(vals, .025)), float(np.quantile(vals, .975))] if len(vals) else [None, None],
    }


def stats(opps, eligible_dates, seasons, contract, include_bootstrap=True):
    ordered = sorted(eligible_dates)
    counts = Counter(o["date"] for o in opps)
    decisive = [o for o in opps if o["y"] is not None]
    wins = sum(int(o["y"]) for o in decisive)
    values = [counts.get(d, 0) for d in ordered]
    def pct(fn):
        return 100.0 * sum(fn(x) for x in values) / len(values) if values else 0.0
    by_season = {}
    for s in seasons:
        sd = sorted(d for d in ordered if d.startswith(s[:4]))
        so = [o for o in opps if o["season"] == s]
        sc = Counter(o["date"] for o in so)
        dec = [o for o in so if o["y"] is not None]
        w = sum(int(o["y"]) for o in dec)
        streak = no_play_streaks(sc, sd)
        by_season[s] = {
            "opportunities": len(so), "decisiveRows": len(dec), "wins": w, "losses": len(dec)-w,
            "pushes": len(so)-len(dec), "hitRate": w/len(dec) if dec else None,
            "wilson95": wilson(w, len(dec)), "eligibleSlateDays": len(sd),
            "meanSelectionsPerEligibleSlateDay": len(so)/len(sd) if sd else 0.0,
            "pctDaysWithAtLeast1": 100.0*sum(sc.get(d,0)>=1 for d in sd)/len(sd) if sd else 0.0,
            **streak,
        }
    out = {
        "opportunities": len(opps),
        "uniqueGames": len({(o["date"], o["gamePk"]) for o in opps}),
        "decisiveRows": len(decisive),
        "wins": wins,
        "losses": len(decisive)-wins,
        "pushes": len(opps)-len(decisive),
        "hitRate": wins/len(decisive) if decisive else None,
        "wilson95": wilson(wins, len(decisive)),
        "eligibleSlateDays": len(ordered),
        "meanSelectionsPerEligibleSlateDay": len(opps)/len(ordered) if ordered else 0.0,
        "meanSelectionsOnActiveDay": len(opps)/sum(v>=1 for v in values) if any(v>=1 for v in values) else 0.0,
        "pctDaysWithZero": pct(lambda x:x==0),
        "pctDaysWithAtLeast1": pct(lambda x:x>=1),
        "pctDaysWithExactly1": pct(lambda x:x==1),
        "pctDaysWithAtLeast2": pct(lambda x:x>=2),
        "maximumSelectionsOneDay": max(values) if values else 0,
        "dailySelectionDistribution": dict(sorted(Counter(values).items())),
        **no_play_streaks(counts, ordered),
        "bySeason": by_season,
        "probabilityMetricsOnPureFullGameSubset": probability_metrics(opps),
    }
    if include_bootstrap:
        out["officialDateClusterBootstrapHitRate"] = bootstrap_hit_rate(opps, int(contract["reporting"]["bootstrapResamples"]), int(contract["reporting"]["bootstrapSeed"]))
    q = contract["qualityFrequencyDiagnostics"]
    out["operationalPreferenceChecks"] = {
        "meanSelectionsWithinPreferredBand": q["preferredMeanSelectionsPerEligibleSlateDayMin"] <= out["meanSelectionsPerEligibleSlateDay"] <= q["preferredMeanSelectionsPerEligibleSlateDayMax"],
        "coverageAtLeastPreferred": out["pctDaysWithAtLeast1"] >= q["preferredPctEligibleSlateDaysWithAtLeastOne"],
        "maximumNoPlayStreakAtMostPreferred": out["maximumNoPlaySlateDayStreak"] <= q["preferredMaximumNoPlaySlateDayStreak"],
        "hitRateAtLeastPreferred": out["hitRate"] is not None and out["hitRate"] >= q["preferredDecisiveHitRateMin"],
        "wilsonLowerAtLeastPreferred": out["wilson95"]["lower"] >= q["preferredWilson95LowerMin"],
        "dailyHardCapRespected": out["maximumSelectionsOneDay"] <= q["maximumDailySelectionsHardCap"],
    }
    out["meetsAllOperationalPreferences"] = all(out["operationalPreferenceChecks"].values())
    return out


def daily_cap(candidates, eligible_dates, cap):
    by_date = defaultdict(list)
    for o in candidates:
        by_date[o["date"]].append(o)
    selected = []
    for d in sorted(eligible_dates):
        xs = by_date.get(d, [])
        xs = sorted(xs, key=lambda o: (
            int(o["priority"]),
            -(o["consensusScore"] if finite(o.get("consensusScore")) else -1.0),
            -(o["classifierScore"] if finite(o.get("classifierScore")) else -1.0),
            int(o["gamePk"]),
        ))
        selected.extend(xs[:cap])
    return selected


def dedupe_ledger(candidates):
    by_game = defaultdict(list)
    for o in candidates:
        by_game[(o["date"], o["gamePk"])].append(o)
    out = []
    for _, xs in by_game.items():
        xs = sorted(xs, key=lambda o: (
            int(o["priority"]),
            -(o["consensusScore"] if finite(o.get("consensusScore")) else -1.0),
            -(o["classifierScore"] if finite(o.get("classifierScore")) else -1.0),
            int(o["gamePk"]),
        ))
        out.append(xs[0])
    return out


def pareto_frontier(portfolio_stats):
    names = sorted(portfolio_stats)
    front = []
    for name in names:
        a = portfolio_stats[name]
        if a["hitRate"] is None:
            continue
        dominated = False
        for other in names:
            if other == name:
                continue
            b = portfolio_stats[other]
            if b["hitRate"] is None:
                continue
            ge = (
                b["hitRate"] >= a["hitRate"]
                and b["wilson95"]["lower"] >= a["wilson95"]["lower"]
                and b["pctDaysWithAtLeast1"] >= a["pctDaysWithAtLeast1"]
                and b["maximumNoPlaySlateDayStreak"] <= a["maximumNoPlaySlateDayStreak"]
            )
            strict = (
                b["hitRate"] > a["hitRate"]
                or b["wilson95"]["lower"] > a["wilson95"]["lower"]
                or b["pctDaysWithAtLeast1"] > a["pctDaysWithAtLeast1"]
                or b["maximumNoPlaySlateDayStreak"] < a["maximumNoPlaySlateDayStreak"]
            )
            if ge and strict:
                dominated = True
                break
        if not dominated:
            front.append(name)
    return front


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--custody", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--v68-contract", required=True)
    ap.add_argument("--classifier-source", required=True)
    ap.add_argument("--router-source", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_DISCOVERY_AUDIT_PLAN_BEFORE_ANY_V69_SCORER_EXISTS":
        raise SystemExit("V69_CONTRACT_INVALID")
    if any(c["statistics"].get(k) is not False for k in ("refitAllowed", "recalibrationAllowed", "featureSearchAllowed", "parentThresholdRelaxationAllowed", "postOutcomeThresholdAdditionAllowed", "postOutcomeRouteAdditionAllowed")):
        raise SystemExit("V69_CONTRACT_SEARCH_BOUNDARY_INVALID")

    for key, path in (("v68Contract", a.v68_contract), ("frozenClassifierSource", a.classifier_source), ("frozenRouterSource", a.router_source)):
        expected = c["immutableParentEvidence"][key]["gitBlobSha"]
        got = git_blob_sha(path)
        if got != expected:
            raise SystemExit(f"V69_GIT_BLOB_DRIFT:{key}:{got}:{expected}")

    classifier_version, premium_rules, models = parse_frozen_classifier_source(a.classifier_source)
    if classifier_version != c["immutableParentEvidence"]["frozenClassifierSource"]["requiredVersion"]:
        raise SystemExit("V69_CLASSIFIER_VERSION_DRIFT")
    router_text = open(a.router_source, encoding="utf-8").read()
    if c["immutableParentEvidence"]["frozenRouterSource"]["requiredVersion"] not in router_text:
        raise SystemExit("V69_ROUTER_VERSION_DRIFT")
    if 'snapshot.bullpenPitches1dAdv as number) > 0' not in router_text or '"FIRST_5_HOME"' not in router_text or '"FULL_GAME_HOME"' not in router_text:
        raise SystemExit("V69_ROUTER_D1_SEMANTIC_DRIFT")

    v16 = load(a.v16_manifest)
    if v16.get("schemaVersion") != V16_SCHEMA:
        raise SystemExit("V69_V16_SCHEMA_DRIFT")
    if canonical_digest(v16) != c["immutableParentEvidence"]["v16"]["manifestCanonicalSha256"]:
        raise SystemExit("V69_V16_MANIFEST_DRIFT")
    v68c = load(a.v68_contract)
    if v68c.get("scientificStatus") != c["immutableParentEvidence"]["v68Contract"]["requiredScientificStatus"]:
        raise SystemExit("V69_V68_CONTRACT_STATUS_DRIFT")
    v68_model = v68c["primaryCandidate"]["modelSnapshot"]
    v16_model = v16["fullGame"]
    if list(v16_model["preprocessor"]["features"]) != list(v68c["formalControl"]["featuresExactly"]):
        raise SystemExit("V69_V16_CONTROL_FEATURE_DRIFT")
    if len(v68c["primaryCandidate"]["featuresExactly"]) != 15:
        raise SystemExit("V69_V68_FEATURE_COUNT_DRIFT")

    custody = load_custody(a.custody)
    seasons = tuple(c["evaluationUniverse"]["seasons"])
    expected_by = c["evaluationUniverse"]["expectedCanonicalRowsBySeason"]
    rows = []
    eligible_dates = set()
    seen = set()
    for s in seasons:
        table = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        if table.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"V69_BASE_SCHEMA_DRIFT:{s}")
        eligible = [r for r in table["rows"] if r.get("t5PregameValid") is True]
        if len(eligible) != int(expected_by[s]):
            raise SystemExit(f"V69_ROWS_DRIFT:{s}:{len(eligible)}")
        for raw in eligible:
            gp = int(raw["gamePk"])
            key = (s, gp)
            if key in seen:
                raise SystemExit(f"V69_DUPLICATE_GAME:{key}")
            seen.add(key)
            if key not in custody:
                raise SystemExit(f"V69_CUSTODY_GAME_MISSING:{key}")
            cr = custody[key]
            f = raw.get("features") or {}
            cls = classify(f, premium_rules, models)
            p16 = frozen_binary_prob(cr, v16_model)
            p68 = frozen_binary_prob(cr, v68_model)
            side16 = "HOME" if p16 >= 0.5 else "AWAY"
            side68 = "HOME" if p68 >= 0.5 else "AWAY"
            agree = side16 == side68
            p16sel = p16 if side16 == "HOME" else 1.0-p16
            p68sel = p68 if side16 == "HOME" else 1.0-p68
            score = min(p16sel, p68sel) if agree else None
            reinforce = agree and p68sel >= p16sel
            exp = cr.get("fg_exposure_adv")
            exp_support = agree and finite(exp) and ((side16 == "HOME" and float(exp) > 0) or (side16 == "AWAY" and float(exp) < 0))
            d1 = cr.get("bullpen_pitches_1d_adv")
            if cls["aPlus"] and not finite(d1):
                raise SystemExit(f"V69_APLUS_D1_MISSING:{s}:{gp}")
            date = str(raw["officialDate"])
            eligible_dates.add(date)
            rows.append({
                "season": s, "date": date, "gamePk": gp, "raw": raw,
                **cls,
                "p16Home": p16, "p68Home": p68, "selectedSide": side16,
                "v16v68Agree": agree, "v68Reinforces": reinforce,
                "exposureSignSupport": exp_support, "consensusScore": score,
                "p16Selected": p16sel if agree else None, "p68Selected": p68sel if agree else None,
                "bullpenPitches1dAdv": float(d1) if finite(d1) else None,
            })

    if len(rows) != int(c["evaluationUniverse"]["expectedCombinedRows"]):
        raise SystemExit(f"V69_COMBINED_ROWS_DRIFT:{len(rows)}")
    if len(eligible_dates) != int(c["evaluationUniverse"]["expectedEligibleSlateDays"]):
        raise SystemExit(f"V69_SLATE_DAYS_DRIFT:{len(eligible_dates)}")

    routes = defaultdict(list)
    for r in rows:
        if r["premiumA"]:
            routes["PREMIUM_A_FULL_GAME_HOME"].append(make_opp(r, "FULL_GAME_ML", "HOME", "PREMIUM_A_FULL_GAME_HOME", 3, r["classifierScore"]))
            market = "FIRST_5_ML" if r["f5Consensus"] else "FULL_GAME_ML"
            routes["PREMIUM_A_ROUTE_SWITCH"].append(make_opp(r, market, "HOME", "PREMIUM_A_ROUTE_SWITCH", 3, r["classifierScore"]))
        if r["aPlus"]:
            routes["A_PLUS_FULL_GAME_HOME"].append(make_opp(r, "FULL_GAME_ML", "HOME", "A_PLUS_FULL_GAME_HOME", 2, r["classifierScore"]))
            market = "FIRST_5_ML" if r["bullpenPitches1dAdv"] > 0 else "FULL_GAME_ML"
            routes["A_PLUS_D1_ROUTER"].append(make_opp(r, market, "HOME", "A_PLUS_D1_ROUTER", 2, r["classifierScore"]))
        if r["premiumA"] and r["p68Home"] >= 0.5:
            routes["PREMIUM_A_V68_AGREE_FULL_GAME_HOME"].append(make_opp(r, "FULL_GAME_ML", "HOME", "PREMIUM_A_V68_AGREE_FULL_GAME_HOME", 1, min(r["p68Home"], r["classifierScore"])))
            market = "FIRST_5_ML" if r["f5Consensus"] else "FULL_GAME_ML"
            routes["PREMIUM_A_V68_AGREE_ROUTE_SWITCH"].append(make_opp(r, market, "HOME", "PREMIUM_A_V68_AGREE_ROUTE_SWITCH", 1, min(r["p68Home"], r["classifierScore"])))
        if r["premiumA"] and r["p16Home"] >= 0.5 and r["p68Home"] >= r["p16Home"]:
            routes["PREMIUM_A_V68_REINFORCE_FULL_GAME_HOME"].append(make_opp(r, "FULL_GAME_ML", "HOME", "PREMIUM_A_V68_REINFORCE_FULL_GAME_HOME", 1, min(r["p16Home"], r["p68Home"])))
        if r["aPlus"] and r["p68Home"] >= 0.5:
            market = "FIRST_5_ML" if r["bullpenPitches1dAdv"] > 0 else "FULL_GAME_ML"
            routes["A_PLUS_V68_AGREE_D1_ROUTER"].append(make_opp(r, market, "HOME", "A_PLUS_V68_AGREE_D1_ROUTER", 0, min(r["p68Home"], r["classifierScore"])))

    grid = [float(x) for x in c["predeclaredConsensusScoreGrid"]]
    general = {}
    reinforced = {}
    exposure = {}
    reinforced_exposure = {}
    for t in grid:
        tag = f"{t:.3f}"
        general[tag] = []
        reinforced[tag] = []
        exposure[tag] = []
        reinforced_exposure[tag] = []
        for r in rows:
            if not r["v16v68Agree"] or r["consensusScore"] is None or r["consensusScore"] < t:
                continue
            o = make_opp(r, "FULL_GAME_ML", r["selectedSide"], f"V16_V68_CONSENSUS_T{tag}", 4, r["consensusScore"])
            general[tag].append(o)
            if r["v68Reinforces"]:
                reinforced[tag].append(dict(o, route=f"V16_V68_REINFORCED_T{tag}"))
            if r["exposureSignSupport"]:
                exposure[tag].append(dict(o, route=f"V16_V68_EXPOSURE_SIGN_T{tag}"))
            if r["v68Reinforces"] and r["exposureSignSupport"]:
                reinforced_exposure[tag].append(dict(o, route=f"V16_V68_REINFORCED_EXPOSURE_SIGN_T{tag}"))

    route_stats = {name: stats(opps, eligible_dates, seasons, c) for name, opps in routes.items()}
    route_grid_stats = {
        "V16_V68_CONSENSUS": {k: stats(v, eligible_dates, seasons, c) for k,v in general.items()},
        "V16_V68_REINFORCED": {k: stats(v, eligible_dates, seasons, c) for k,v in reinforced.items()},
        "V16_V68_EXPOSURE_SIGN": {k: stats(v, eligible_dates, seasons, c) for k,v in exposure.items()},
        "V16_V68_REINFORCED_EXPOSURE_SIGN": {k: stats(v, eligible_dates, seasons, c) for k,v in reinforced_exposure.items()},
    }

    portfolio_opps = {}
    for t in grid:
        tag = f"{t:.3f}"
        portfolio_opps[f"GENERAL_CONSENSUS_TOP1_T{tag}"] = daily_cap(general[tag], eligible_dates, 1)
        portfolio_opps[f"GENERAL_CONSENSUS_TOP2_T{tag}"] = daily_cap(general[tag], eligible_dates, 2)
        portfolio_opps[f"GENERAL_REINFORCED_TOP1_T{tag}"] = daily_cap(reinforced[tag], eligible_dates, 1)
        portfolio_opps[f"GENERAL_REINFORCED_TOP2_T{tag}"] = daily_cap(reinforced[tag], eligible_dates, 2)

        special = []
        special.extend(routes["A_PLUS_V68_AGREE_D1_ROUTER"])
        special.extend(routes["PREMIUM_A_V68_AGREE_ROUTE_SWITCH"])
        special.extend(routes["A_PLUS_D1_ROUTER"])
        special.extend(routes["PREMIUM_A_ROUTE_SWITCH"])
        special.extend(general[tag])
        ledger = dedupe_ledger(special)
        portfolio_opps[f"CONFLUENCE_LEDGER_TOP1_T{tag}"] = daily_cap(ledger, eligible_dates, 1)
        portfolio_opps[f"CONFLUENCE_LEDGER_TOP2_T{tag}"] = daily_cap(ledger, eligible_dates, 2)

        special_r = []
        special_r.extend(routes["A_PLUS_V68_AGREE_D1_ROUTER"])
        special_r.extend(routes["PREMIUM_A_V68_AGREE_ROUTE_SWITCH"])
        special_r.extend(routes["A_PLUS_D1_ROUTER"])
        special_r.extend(routes["PREMIUM_A_ROUTE_SWITCH"])
        special_r.extend(reinforced[tag])
        ledger_r = dedupe_ledger(special_r)
        portfolio_opps[f"CONFLUENCE_REINFORCED_LEDGER_TOP1_T{tag}"] = daily_cap(ledger_r, eligible_dates, 1)
        portfolio_opps[f"CONFLUENCE_REINFORCED_LEDGER_TOP2_T{tag}"] = daily_cap(ledger_r, eligible_dates, 2)

    portfolio_stats = {name: stats(opps, eligible_dates, seasons, c) for name, opps in portfolio_opps.items()}
    operational = sorted(name for name, st in portfolio_stats.items() if st["meetsAllOperationalPreferences"])
    frontier = pareto_frontier(portfolio_stats)

    overlap = {
        "premiumAGames": sum(r["premiumA"] for r in rows),
        "aPlusGames": sum(r["aPlus"] for r in rows),
        "f5ConsensusGames": sum(r["f5Consensus"] for r in rows),
        "v16V68AgreementGames": sum(r["v16v68Agree"] for r in rows),
        "v68ReinforcesWithinAgreementGames": sum(r["v68Reinforces"] for r in rows),
        "exposureSignSupportsWithinAgreementGames": sum(r["exposureSignSupport"] for r in rows),
        "premiumAAndV16V68HomeAgreement": sum(r["premiumA"] and r["p16Home"] >= .5 and r["p68Home"] >= .5 for r in rows),
        "aPlusAndV16V68HomeAgreement": sum(r["aPlus"] and r["p16Home"] >= .5 and r["p68Home"] >= .5 for r in rows),
        "grid": {},
    }
    for t in grid:
        tag = f"{t:.3f}"
        gkeys = {(o["date"],o["gamePk"]) for o in general[tag]}
        pkeys = {(r["date"],r["gamePk"]) for r in rows if r["premiumA"]}
        overlap["grid"][tag] = {
            "generalConsensusGames": len(gkeys),
            "premiumAOverlapGames": len(gkeys & pkeys),
            "generalConsensusOutsidePremiumAGames": len(gkeys - pkeys),
            "generalConsensusActiveSlateDays": len({o["date"] for o in general[tag]}),
        }

    report = {
        "schemaVersion": SCHEMA,
        "classification": "V69_CONFLUENCE_FREQUENCY_QUALITY_FRONTIER_COMPLETED_RETROSPECTIVE_DISCOVERY_ONLY",
        "scientificInterpretation": "This audit measures the historical quality-frequency frontier of a finite set of frozen parent signals. Because the same historical outcomes helped motivate several parent routes, no V69 path is independent confirmation and none may be promoted without a new prospective freeze.",
        "sample": {
            "rows": len(rows),
            "rowsBySeason": {s: sum(r["season"] == s for r in rows) for s in seasons},
            "eligibleSlateDays": len(eligible_dates),
        },
        "sourceIdentity": {
            "contractFrozenBeforeScorer": True,
            "classifierVersion": classifier_version,
            "classifierGitBlobSha": git_blob_sha(a.classifier_source),
            "routerGitBlobSha": git_blob_sha(a.router_source),
            "v68ContractGitBlobSha": git_blob_sha(a.v68_contract),
            "v16CanonicalManifestSha256": canonical_digest(v16),
            "v68FeatureCount": len(v68c["primaryCandidate"]["featuresExactly"]),
        },
        "overlapAndIncrementalCoverage": overlap,
        "fixedRoutes": route_stats,
        "consensusRouteGrids": route_grid_stats,
        "dailyCappedPortfolios": portfolio_stats,
        "operationalPreferenceMatches": operational,
        "qualityFrequencyParetoFrontier": frontier,
        "interpretationGuardrails": {
            "frequencyMayNotForceAPlay": True,
            "threeDayDroughtPreferenceIsDiagnosticNotAThresholdRelaxationRule": True,
            "allGridPointsReported": True,
            "historicalBestPointMayNotBePromoted": True,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "prospectiveV68Changed": False,
            "productionChanged": False,
        },
        "policy": {
            "researchOnly": True,
            "retrospectiveDiscoveryOnly": True,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "featureSearchPerformed": False,
            "parentThresholdRelaxationPerformed": False,
            "postOutcomeRouteAdditionPerformed": False,
            "forcedDailyPlayAllowed": False,
            "dailyHardCap": 2,
            "liveLookupAuthorizationChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, report)
    compact = {}
    for name in frontier:
        st = portfolio_stats[name]
        compact[name] = {k:st[k] for k in ("opportunities","hitRate","meanSelectionsPerEligibleSlateDay","pctDaysWithAtLeast1","maximumNoPlaySlateDayStreak","meetsAllOperationalPreferences")}
    print(json.dumps({
        "classification": report["classification"],
        "sample": report["sample"],
        "operationalPreferenceMatches": operational,
        "paretoFrontier": compact,
    }, indent=2))


if __name__ == "__main__":
    main()
