#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from collections import defaultdict
import numpy as np

CAPTURE_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-capture.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-confirmation-contract.v1"
REPORT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-evaluation.v1"
EPS = 1e-15

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def dump(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

def metric(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    ll = -float(np.mean(y * np.log(np.maximum(p, EPS)) + (1.0-y) * np.log(np.maximum(1.0-p, EPS))))
    brier = float(np.mean((p-y)**2))
    ece = 0.0
    for i in range(10):
        lo, hi = i/10.0, (i+1)/10.0
        mask = (p >= lo) & ((p < hi) if i < 9 else (p <= hi))
        n = int(mask.sum())
        if n:
            ece += n/len(y) * abs(float(p[mask].mean()) - float(y[mask].mean()))
    return {
        "n": int(len(y)),
        "logLoss": ll,
        "brier": brier,
        "ece10": float(ece),
        "absoluteMeanProbabilityGap": abs(float(p.mean()) - float(y.mean())),
        "meanPredictedHomeWin": float(p.mean()),
        "observedHomeWinRate": float(y.mean()),
    }

def losses(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    ll = -(y*np.log(np.maximum(p, EPS)) + (1-y)*np.log(np.maximum(1-p, EPS)))
    br = (p-y)**2
    return ll, br

def paired_bootstrap(dates, control_p, candidate_p, y, cfg):
    c_ll, c_br = losses(control_p, y)
    v_ll, v_br = losses(candidate_p, y)
    d_ll = c_ll - v_ll
    d_br = c_br - v_br
    groups = defaultdict(list)
    for i, day in enumerate(dates):
        groups[str(day)].append(i)
    keys = sorted(groups)
    if len(keys) < 2:
        raise SystemExit("V68_EVAL_BOOTSTRAP_NEEDS_MULTIPLE_DATES")
    aggregate = []
    for day in keys:
        idx = np.asarray(groups[day], dtype=int)
        aggregate.append((float(d_ll[idx].sum()), float(d_br[idx].sum()), int(len(idx))))
    a = np.asarray(aggregate, dtype=float)
    seed = int(cfg["seed"])
    resamples = int(cfg["resamples"])
    rng = np.random.default_rng(seed)
    vals = np.empty((resamples, 2), dtype=float)
    k = len(keys)
    for b in range(resamples):
        pick = rng.integers(0, k, size=k)
        x = a[pick]
        n = float(x[:,2].sum())
        vals[b,0] = float(x[:,0].sum() / n)
        vals[b,1] = float(x[:,1].sum() / n)
    return {
        "unit": "OFFICIAL_DATE_CLUSTER",
        "distinctDates": k,
        "resamples": resamples,
        "seed": seed,
        "logLossImprovement": {
            "pointEstimate": float(d_ll.mean()),
            "ci95": [float(np.quantile(vals[:,0], 0.025)), float(np.quantile(vals[:,0], 0.975))],
        },
        "brierImprovement": {
            "pointEstimate": float(d_br.mean()),
            "ci95": [float(np.quantile(vals[:,1], 0.025)), float(np.quantile(vals[:,1], 0.975))],
        },
    }

def load_outcomes_after_embargo(path):
    payload = load(path)
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise SystemExit("V68_EVAL_OUTCOME_ROWS_INVALID")
    out = {}
    for row in rows:
        try:
            gp = int(row["gamePk"])
            h = int(row["homeRuns"])
            a = int(row["awayRuns"])
            home = int(row["homeTeamId"])
            away = int(row["awayTeamId"])
        except Exception:
            raise SystemExit("V68_EVAL_OUTCOME_ROW_INVALID")
        if gp <= 0 or h < 0 or a < 0 or h == a:
            raise SystemExit(f"V68_EVAL_OUTCOME_NOT_OFFICIAL_NON_TIE:{gp}:{h}:{a}")
        if gp in out:
            raise SystemExit(f"V68_EVAL_OUTCOME_DUPLICATE:{gp}")
        out[gp] = {
            "gamePk": gp,
            "officialDate": str(row["officialDate"]),
            "homeTeamId": home,
            "awayTeamId": away,
            "homeRuns": h,
            "awayRuns": a,
        }
    return out

def validate_capture(capture, contract, contract_path, v16_path):
    if capture.get("schemaVersion") != CAPTURE_SCHEMA:
        raise SystemExit("V68_EVAL_CAPTURE_SCHEMA_INVALID")
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V68_EVAL_CONTRACT_SCHEMA_INVALID")
    if capture.get("contractSha256") != sha256_file(contract_path):
        raise SystemExit("V68_EVAL_CONTRACT_DIGEST_DRIFT")
    expected_v16 = contract["parentEvidence"]["v16ManifestSha256"]
    v16_manifest = load(v16_path)
    if canonical_digest(v16_manifest) != expected_v16 or capture.get("v16ManifestSha256") != expected_v16:
        raise SystemExit("V68_EVAL_V16_MANIFEST_DRIFT")
    expected_candidate = canonical_digest(contract["primaryCandidate"]["modelSnapshot"])
    if capture.get("candidateSnapshotDigest") != expected_candidate:
        raise SystemExit("V68_EVAL_CANDIDATE_SNAPSHOT_DRIFT")
    rows = capture.get("rows", [])
    if not isinstance(rows, list):
        raise SystemExit("V68_EVAL_CAPTURE_ROWS_INVALID")
    seen = set()
    first = contract["prospectiveCohort"]["firstEligibleOfficialDate"]
    for row in rows:
        gp = int(row["gamePk"])
        if gp in seen:
            raise SystemExit(f"V68_EVAL_CAPTURE_DUPLICATE:{gp}")
        seen.add(gp)
        if str(row["officialDate"]) < first:
            raise SystemExit(f"V68_EVAL_PRE_FREEZE_GAME_PRESENT:{gp}")
        if row.get("containsOutcome") is not False or row.get("containsMarketPrice") is not False:
            raise SystemExit(f"V68_EVAL_CAPTURE_BOUNDARY_VIOLATION:{gp}")
        for model in ("v16", "v68"):
            p = float(row[model]["homeWinProbability"])
            if not math.isfinite(p) or not (0.0 < p < 1.0):
                raise SystemExit(f"V68_EVAL_PROBABILITY_INVALID:{gp}:{model}:{p}")
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", required=True)
    ap.add_argument("--outcomes", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    contract = load(args.contract)
    capture = load(args.capture)
    rows = validate_capture(capture, contract, args.contract, args.v16_manifest)
    dates = sorted({str(r["officialDate"]) for r in rows})
    embargo = contract["outcomeEmbargo"]
    enough_games = len(rows) >= int(embargo["minimumCanonicalGamesBeforeOutcomeScoring"])
    enough_dates = len(dates) >= int(embargo["minimumDistinctOfficialDatesBeforeOutcomeScoring"])
    if not (enough_games and enough_dates):
        report = {
            "schemaVersion": REPORT_SCHEMA,
            "classification": contract["evaluation"]["insufficientCohortClassification"],
            "scientificStatus": "OUTCOMES_NOT_READ_BECAUSE_PROSPECTIVE_EMBARGO_NOT_MATURE",
            "captureMaturity": {
                "canonicalGames": len(rows),
                "distinctOfficialDates": len(dates),
                "minimumCanonicalGamesRequired": int(embargo["minimumCanonicalGamesBeforeOutcomeScoring"]),
                "minimumDistinctOfficialDatesRequired": int(embargo["minimumDistinctOfficialDatesBeforeOutcomeScoring"]),
                "gamesRequirementMet": enough_games,
                "datesRequirementMet": enough_dates,
            },
            "outcomesRead": False,
            "policy": {
                "researchOnly": True,
                "interimOutcomePeekingPerformed": False,
                "productionV16Changed": False,
                "betEliteAllowed": False,
                "automaticBetPlacementAllowed": False,
                "realFinancialExposure": 0,
            },
        }
        dump(args.out, report)
        print(json.dumps(report, indent=2))
        return

    outcomes = load_outcomes_after_embargo(args.outcomes)
    joined = []
    missing = []
    for row in rows:
        gp = int(row["gamePk"])
        o = outcomes.get(gp)
        if o is None:
            missing.append(gp)
            continue
        if (str(o["officialDate"]) != str(row["officialDate"]) or
            int(o["homeTeamId"]) != int(row["homeTeamId"]) or
            int(o["awayTeamId"]) != int(row["awayTeamId"])):
            raise SystemExit(f"V68_EVAL_OUTCOME_IDENTITY_MISMATCH:{gp}")
        joined.append((row, o))
    if len(joined) != len(rows):
        raise SystemExit(f"V68_EVAL_OUTCOME_COVERAGE_INCOMPLETE:{len(joined)}:{len(rows)}:{missing[:20]}")

    dates = [str(r["officialDate"]) for r, _ in joined]
    y = np.asarray([1.0 if o["homeRuns"] > o["awayRuns"] else 0.0 for _, o in joined], dtype=float)
    p16 = np.asarray([float(r["v16"]["homeWinProbability"]) for r, _ in joined], dtype=float)
    p68 = np.asarray([float(r["v68"]["homeWinProbability"]) for r, _ in joined], dtype=float)
    m16 = metric(p16, y)
    m68 = metric(p68, y)
    improvement = {
        "logLossImprovement": m16["logLoss"] - m68["logLoss"],
        "brierImprovement": m16["brier"] - m68["brier"],
    }
    boot = paired_bootstrap(dates, p16, p68, y, contract["evaluation"]["pairedBootstrap"])
    checks = {
        "prospectiveLogLossImprovementPositive": improvement["logLossImprovement"] > 0.0,
        "prospectiveBrierImprovementPositive": improvement["brierImprovement"] > 0.0,
        "bootstrapLogLoss95CiLowerBoundPositive": boot["logLossImprovement"]["ci95"][0] > 0.0,
        "bootstrapBrier95CiLowerBoundPositive": boot["brierImprovement"]["ci95"][0] > 0.0,
        "v68Ece10Le002": m68["ece10"] <= 0.02,
        "v68AbsoluteMeanProbabilityGapLe002": m68["absoluteMeanProbabilityGap"] <= 0.02,
        "noCaptureChronologyViolations": True,
        "noModelOrFeatureDriftFromFrozenSnapshot": True,
    }
    passed = all(checks.values())
    classification = contract["evaluation"]["passingClassification"] if passed else contract["evaluation"]["failingClassification"]
    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "scientificStatus": "SINGLE_PROSPECTIVE_EVALUATION_COMPLETED_AFTER_FROZEN_EMBARGO",
        "passed": passed,
        "captureMaturity": {
            "canonicalGames": len(rows),
            "distinctOfficialDates": len(set(dates)),
            "minimumCanonicalGamesRequired": int(embargo["minimumCanonicalGamesBeforeOutcomeScoring"]),
            "minimumDistinctOfficialDatesRequired": int(embargo["minimumDistinctOfficialDatesBeforeOutcomeScoring"]),
        },
        "formalControl": m16,
        "primaryCandidate": m68,
        "improvement": improvement,
        "pairedBootstrap": boot,
        "promotionChecks": checks,
        "outcomesRead": True,
        "adaptiveSelectionDisclosure": contract["parentEvidence"]["adaptiveSelectionDisclosure"],
        "policy": {
            "researchOnly": True,
            "historical2023Or2024_2026YtdUsedToDecideV68": False,
            "marketOddsUsedAsFeatures": False,
            "positiveEvEstablished": False,
            "productionV16Changed": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "finalRecommendationChanged": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        "classification": classification,
        "passed": passed,
        "improvement": improvement,
        "pairedBootstrap": boot,
        "promotionChecks": checks,
    }, indent=2))

if __name__ == "__main__":
    main()
