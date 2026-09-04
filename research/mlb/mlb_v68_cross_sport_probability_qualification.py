#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

CONTRACT_SCHEMA = "courtedge-mlb-v68-cross-sport-probability-qualification-contract.v1"
PARENT_CONTRACT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-confirmation-contract.v1"
CAPTURE_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-capture.v1"
PARENT_EVAL_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-evaluation.v1"
OUTCOME_SCHEMA = "courtedge-p0-step12v68-official-outcomes.v1"
RESULT_SCHEMA = "courtedge-mlb-v68-cross-sport-probability-qualification.v1"
EPS = 1e-15


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(path):
    data = Path(path).read_bytes()
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def canonical_digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def metric(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    ll = -float(np.mean(y * np.log(np.maximum(p, EPS)) + (1.0 - y) * np.log(np.maximum(1.0 - p, EPS))))
    brier = float(np.mean((p - y) ** 2))
    ece = 0.0
    bins = []
    for i in range(10):
        lo, hi = i / 10.0, (i + 1) / 10.0
        mask = (p >= lo) & ((p < hi) if i < 9 else (p <= hi))
        n = int(mask.sum())
        if n:
            mp = float(p[mask].mean())
            obs = float(y[mask].mean())
            ece += n / len(y) * abs(mp - obs)
            bins.append({"low": lo, "high": hi, "n": n, "meanPredicted": mp, "observedRate": obs})
    denom = math.sqrt(float(np.sum(p * (1.0 - p))))
    z = float(np.sum(y - p) / denom) if denom > 0 else float("inf")
    return {
        "n": int(len(y)),
        "logLoss": ll,
        "brier": brier,
        "ece10": float(ece),
        "absoluteMeanProbabilityGap": abs(float(p.mean()) - float(y.mean())),
        "meanPredictedHomeWin": float(p.mean()),
        "observedHomeWinRate": float(y.mean()),
        "calibrationInTheLargeZ": z,
        "calibrationBins": bins,
    }


def identity_affine_lr(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    clipped = np.clip(p, 1e-12, 1.0 - 1e-12)
    x = np.log(clipped / (1.0 - clipped))

    def nll(theta):
        alpha = float(theta[0])
        beta = math.exp(float(theta[1]))
        z = alpha + beta * x
        return float(np.sum(np.logaddexp(0.0, z) - y * z))

    null_nll = -float(np.sum(y * np.log(np.maximum(p, EPS)) + (1.0 - y) * np.log(np.maximum(1.0 - p, EPS))))
    opt = minimize(nll, np.zeros(2), method="L-BFGS-B", options={"maxiter": 10000, "ftol": 1e-14, "gtol": 1e-9})
    if not opt.success or not np.all(np.isfinite(opt.x)):
        raise SystemExit(f"MLB_V68_CROSS_SPORT_IDENTITY_AFFINE_OPTIMIZER_FAILED:{opt.message}")
    alt_nll = float(opt.fun)
    lr = max(0.0, 2.0 * (null_nll - alt_nll))
    # Chi-square survival function for df=2 is exactly exp(-x/2).
    p_value = math.exp(-lr / 2.0)
    return {
        "nullNll": null_nll,
        "alternativeNll": alt_nll,
        "likelihoodRatioStatistic": lr,
        "degreesOfFreedom": 2,
        "pValue": p_value,
        "alternativeAlpha": float(opt.x[0]),
        "alternativeLogBeta": float(opt.x[1]),
        "alternativeBeta": math.exp(float(opt.x[1])),
        "alternativeUsedForPrediction": False,
    }


def by_date_diagnostics(dates, p, y):
    groups = defaultdict(list)
    for i, day in enumerate(dates):
        groups[str(day)].append(i)
    out = []
    for day in sorted(groups):
        idx = np.asarray(groups[day], dtype=int)
        pp = np.asarray(p, dtype=float)[idx]
        yy = np.asarray(y, dtype=float)[idx]
        out.append({
            "officialDate": day,
            "n": int(len(idx)),
            "meanPredictedHomeWin": float(pp.mean()),
            "observedHomeWinRate": float(yy.mean()),
            "probabilityGap": float(pp.mean() - yy.mean()),
        })
    return out


def rolling_gap(dates, p, y):
    groups = defaultdict(list)
    for i, day in enumerate(dates):
        groups[str(day)].append(i)
    cumulative_p = []
    cumulative_y = []
    out = []
    for day in sorted(groups):
        idx = groups[day]
        cumulative_p.extend(float(p[i]) for i in idx)
        cumulative_y.extend(float(y[i]) for i in idx)
        out.append({
            "throughOfficialDate": day,
            "n": len(cumulative_y),
            "meanPredictedHomeWin": float(np.mean(cumulative_p)),
            "observedHomeWinRate": float(np.mean(cumulative_y)),
            "absoluteMeanProbabilityGap": abs(float(np.mean(cumulative_p) - np.mean(cumulative_y))),
            "reportOnlyNoAdaptiveStopping": True,
        })
    return out


def blocked_result(contract, reason, parent_eval_present):
    return {
        "schemaVersion": RESULT_SCHEMA,
        "classification": contract["acceptanceRubric"]["embargoBlockedClassification"],
        "scientificStatus": "CROSS_SPORT_OUTCOMES_NOT_READ_BECAUSE_ORIGINAL_V68_ONE_SHOT_EVALUATION_IS_NOT_AVAILABLE",
        "reason": reason,
        "parentV68FinalEvaluationPresent": parent_eval_present,
        "outcomesReadByCrossSportEvaluator": False,
        "crossSportMlbFullGameCandidateAuthorized": False,
        "first5CrossSportProbabilityAuthorized": False,
        "globalEliteRankerStillBlocked": True,
        "safety": {
            "v68ModelChanged": False,
            "calibrationChanged": False,
            "featuresChanged": False,
            "thresholdsChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "sportsbookPricesRead": False,
            "marketOddsRead": False,
            "crossSportPoolingPerformed": False,
            "globalEliteRankingPerformed": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
        },
    }


def prerequisite_fail_result(contract, parent_eval):
    return {
        "schemaVersion": RESULT_SCHEMA,
        "classification": contract["acceptanceRubric"]["failClassification"],
        "scientificStatus": "ORIGINAL_V68_PROSPECTIVE_PREREQUISITE_FAILED_NO_SECOND_OUTCOME_PASS_PERFORMED",
        "reason": "ORIGINAL_V68_PROSPECTIVE_EXPERIMENT_DID_NOT_PASS_ITS_FROZEN_PROMOTION_RUBRIC",
        "parentV68Classification": parent_eval.get("classification"),
        "parentV68Passed": parent_eval.get("passed"),
        "outcomesReadByCrossSportEvaluator": False,
        "crossSportMlbFullGameCandidateAuthorized": False,
        "first5CrossSportProbabilityAuthorized": False,
        "globalEliteRankerStillBlocked": True,
        "safety": {
            "v68ModelChanged": False,
            "calibrationChanged": False,
            "featuresChanged": False,
            "thresholdsChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "sportsbookPricesRead": False,
            "marketOddsRead": False,
            "crossSportPoolingPerformed": False,
            "globalEliteRankingPerformed": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
        },
    }


def validate_parent_files(contract, parent_contract_path, parent_evaluator_path):
    parent_spec = contract["governingProspectiveExperiment"]
    if git_blob_sha1(parent_contract_path) != parent_spec["contractBlobSha"]:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_CONTRACT_BLOB_DRIFT")
    if git_blob_sha1(parent_evaluator_path) != parent_spec["evaluatorBlobSha"]:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_EVALUATOR_BLOB_DRIFT")
    parent = load_json(parent_contract_path)
    if parent.get("schemaVersion") != PARENT_CONTRACT_SCHEMA:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_CONTRACT_SCHEMA_INVALID")
    if parent["outcomeEmbargo"]["minimumCanonicalGamesBeforeOutcomeScoring"] != contract["governingProspectiveExperiment"]["minimumCanonicalGamesBeforeOutcomeScoring"]:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_MIN_GAMES_DRIFT")
    if parent["outcomeEmbargo"]["minimumDistinctOfficialDatesBeforeOutcomeScoring"] != contract["governingProspectiveExperiment"]["minimumDistinctOfficialDatesBeforeOutcomeScoring"]:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_MIN_DATES_DRIFT")
    if parent["prospectiveCohort"]["firstEligibleOfficialDate"] != contract["governingProspectiveExperiment"]["firstEligibleOfficialDate"]:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_FIRST_DATE_DRIFT")
    return parent


def validate_parent_evaluation(contract, parent_eval):
    prereq = contract["originalV68ProspectivePassPrerequisite"]
    if parent_eval.get("schemaVersion") != PARENT_EVAL_SCHEMA:
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_EVAL_SCHEMA_INVALID")
    maturity = parent_eval.get("captureMaturity") or {}
    if int(maturity.get("canonicalGames", 0)) < int(contract["absoluteCrossSportProbabilityGates"]["minimumEvidence"]["canonicalGames"]):
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_EVAL_GAMES_BELOW_FROZEN_MINIMUM")
    if int(maturity.get("distinctOfficialDates", 0)) < int(contract["absoluteCrossSportProbabilityGates"]["minimumEvidence"]["distinctOfficialDates"]):
        raise SystemExit("MLB_V68_CROSS_SPORT_PARENT_EVAL_DATES_BELOW_FROZEN_MINIMUM")
    if parent_eval.get("scientificStatus") != prereq["requiredScientificStatus"]:
        return False
    checks = parent_eval.get("promotionChecks") or {}
    all_expected = all(checks.get(name) is True for name in prereq["originalChecks"])
    return (
        parent_eval.get("classification") == prereq["requiredClassification"]
        and parent_eval.get("passed") is True
        and all_expected
    )


def validate_capture(contract, parent_contract, capture_path):
    capture = load_json(capture_path)
    if capture.get("schemaVersion") != CAPTURE_SCHEMA:
        raise SystemExit("MLB_V68_CROSS_SPORT_CAPTURE_SCHEMA_INVALID")
    if capture.get("contractSha256") != sha256_file(parent_contract_path_global):
        raise SystemExit("MLB_V68_CROSS_SPORT_CAPTURE_PARENT_CONTRACT_DIGEST_DRIFT")
    expected_snapshot = canonical_digest(parent_contract["primaryCandidate"]["modelSnapshot"])
    if capture.get("candidateSnapshotDigest") != expected_snapshot:
        raise SystemExit("MLB_V68_CROSS_SPORT_CANDIDATE_SNAPSHOT_DRIFT")
    rows = capture.get("rows")
    if not isinstance(rows, list):
        raise SystemExit("MLB_V68_CROSS_SPORT_CAPTURE_ROWS_INVALID")
    min_games = int(contract["absoluteCrossSportProbabilityGates"]["minimumEvidence"]["canonicalGames"])
    min_dates = int(contract["absoluteCrossSportProbabilityGates"]["minimumEvidence"]["distinctOfficialDates"])
    dates = {str(r.get("officialDate")) for r in rows}
    if len(rows) < min_games or len(dates) < min_dates:
        raise SystemExit("MLB_V68_CROSS_SPORT_CAPTURE_NOT_MATURE")
    seen = set()
    first_date = contract["governingProspectiveExperiment"]["firstEligibleOfficialDate"]
    for row in rows:
        gp = int(row["gamePk"])
        if gp in seen:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_CAPTURE_DUPLICATE:{gp}")
        seen.add(gp)
        if str(row["officialDate"]) < first_date:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_PRE_FREEZE_GAME:{gp}")
        if row.get("containsOutcome") is not False or row.get("containsMarketPrice") is not False:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_CAPTURE_BOUNDARY_VIOLATION:{gp}")
        p = float(row["v68"]["homeWinProbability"])
        if not math.isfinite(p) or not (0.0 < p < 1.0):
            raise SystemExit(f"MLB_V68_CROSS_SPORT_PROBABILITY_INVALID:{gp}:{p}")
        p_away = 1.0 - p
        if abs((p + p_away) - 1.0) > float(contract["frozenProbabilityMapping"]["requiredComplementTolerance"]):
            raise SystemExit(f"MLB_V68_CROSS_SPORT_COMPLEMENT_IDENTITY_FAILED:{gp}")
    return capture, rows


def load_and_validate_outcomes(outcomes_path, capture_rows):
    payload = load_json(outcomes_path)
    if payload.get("schemaVersion") != OUTCOME_SCHEMA:
        raise SystemExit("MLB_V68_CROSS_SPORT_OUTCOME_SCHEMA_INVALID")
    if payload.get("outcomesRead") is not True or payload.get("allCapturedGamesOfficialFinal") is not True:
        raise SystemExit("MLB_V68_CROSS_SPORT_OUTCOMES_NOT_FINAL_COMPLETE")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise SystemExit("MLB_V68_CROSS_SPORT_OUTCOME_ROWS_INVALID")
    by_pk = {}
    for row in rows:
        gp = int(row["gamePk"])
        if gp in by_pk:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_DUPLICATE:{gp}")
        home_runs = int(row["homeRuns"])
        away_runs = int(row["awayRuns"])
        if home_runs < 0 or away_runs < 0 or home_runs == away_runs:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_NOT_BINARY_FINAL:{gp}")
        by_pk[gp] = row
    joined = []
    for cap in capture_rows:
        gp = int(cap["gamePk"])
        outcome = by_pk.get(gp)
        if outcome is None:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_MISSING:{gp}")
        if str(outcome["officialDate"]) != str(cap["officialDate"]):
            raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_DATE_MISMATCH:{gp}")
        if int(outcome["homeTeamId"]) != int(cap["homeTeamId"]) or int(outcome["awayTeamId"]) != int(cap["awayTeamId"]):
            raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_TEAM_MISMATCH:{gp}")
        joined.append((cap, outcome))
    if len(by_pk) != len(capture_rows):
        raise SystemExit(f"MLB_V68_CROSS_SPORT_OUTCOME_POPULATION_MISMATCH:{len(by_pk)}:{len(capture_rows)}")
    return payload, joined


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--parent-contract", required=True)
    ap.add_argument("--parent-evaluator", required=True)
    ap.add_argument("--capture", required=True)
    ap.add_argument("--outcomes", required=True)
    ap.add_argument("--v68-final-evaluation", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    contract = load_json(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MLB_V68_CROSS_SPORT_CONTRACT_SCHEMA_INVALID")
    if contract["frozenProbabilityMapping"]["freeParameters"] != 0 or contract["frozenProbabilityMapping"]["newCalibrationTransformAllowed"] is not False:
        raise SystemExit("MLB_V68_CROSS_SPORT_MAPPING_BOUNDARY_INVALID")
    if contract["crossSportSemantic"]["first5Excluded"] is not True:
        raise SystemExit("MLB_V68_CROSS_SPORT_FIRST5_MUST_REMAIN_EXCLUDED")

    global parent_contract_path_global
    parent_contract_path_global = args.parent_contract
    parent_contract = validate_parent_files(contract, args.parent_contract, args.parent_evaluator)

    # Critical embargo boundary: if the original one-shot V68 evaluation does not exist,
    # do not open the prospective capture or any outcome file.
    if not os.path.isfile(args.v68_final_evaluation):
        result = blocked_result(contract, "ORIGINAL_V68_FINAL_EVALUATION_FILE_ABSENT", False)
        dump_json(args.out, result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return

    parent_eval = load_json(args.v68_final_evaluation)
    parent_passed = validate_parent_evaluation(contract, parent_eval)
    if not parent_passed:
        result = prerequisite_fail_result(contract, parent_eval)
        dump_json(args.out, result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return

    # Only after the preregistered V68 experiment has passed do we open capture/outcomes
    # for the separately preregistered absolute cross-sport qualification.
    capture, capture_rows = validate_capture(contract, parent_contract, args.capture)
    outcomes_payload, joined = load_and_validate_outcomes(args.outcomes, capture_rows)

    dates = [str(cap["officialDate"]) for cap, _ in joined]
    p68 = np.asarray([float(cap["v68"]["homeWinProbability"]) for cap, _ in joined], dtype=float)
    y = np.asarray([1.0 if int(out["homeRuns"]) > int(out["awayRuns"]) else 0.0 for _, out in joined], dtype=float)
    baseline_probability = float(contract["frozenAbsoluteBaseline"]["probability"])
    baseline = np.full(len(joined), baseline_probability, dtype=float)

    m68 = metric(p68, y)
    mbase = metric(baseline, y)
    lr = identity_affine_lr(p68, y)
    gate_cfg = contract["absoluteCrossSportProbabilityGates"]
    critical_z = float(gate_cfg["calibrationInTheLarge"]["twoSidedCriticalAbsZ"])
    alpha = float(gate_cfg["identityAffineLikelihoodRatio"]["rejectIdentityIfPValueBelow"])
    ece_max = float(gate_cfg["preExistingV68CalibrationGates"]["combinedEce10Max"])
    gap_max = float(gate_cfg["preExistingV68CalibrationGates"]["combinedAbsoluteMeanProbabilityGapMax"])

    gates = {
        "originalV68ProspectivePrerequisitePassed": True,
        "minimumCanonicalGames": len(joined) >= int(gate_cfg["minimumEvidence"]["canonicalGames"]),
        "minimumDistinctOfficialDates": len(set(dates)) >= int(gate_cfg["minimumEvidence"]["distinctOfficialDates"]),
        "allProbabilitiesFiniteAndStrictlyInsideUnitInterval": bool(np.all(np.isfinite(p68)) and np.all((p68 > 0.0) & (p68 < 1.0))),
        "selectedSideComplementIdentity": bool(np.all(np.abs((p68 + (1.0 - p68)) - 1.0) <= float(contract["frozenProbabilityMapping"]["requiredComplementTolerance"]))),
        "combinedBrierBeatsFrozenClimatology": m68["brier"] < mbase["brier"],
        "combinedLogLossBeatsFrozenClimatology": m68["logLoss"] < mbase["logLoss"],
        "combinedCalibrationInTheLarge": abs(m68["calibrationInTheLargeZ"]) <= critical_z,
        "combinedIdentityAffineNotRejected": lr["pValue"] >= alpha,
        "combinedEce10WithinFrozenV68Gate": m68["ece10"] <= ece_max,
        "combinedAbsoluteMeanProbabilityGapWithinFrozenV68Gate": m68["absoluteMeanProbabilityGap"] <= gap_max,
        "captureChronologyAndModelIntegrityInheritedFromOriginalV68Pass": (parent_eval.get("promotionChecks") or {}).get("noCaptureChronologyViolations") is True and (parent_eval.get("promotionChecks") or {}).get("noModelOrFeatureDriftFromFrozenSnapshot") is True,
    }
    passed = all(gates.values())
    classification = contract["acceptanceRubric"]["passClassification"] if passed else contract["acceptanceRubric"]["failClassification"]

    parent_candidate = parent_eval.get("primaryCandidate") or {}
    for key, value in (("logLoss", m68["logLoss"]), ("brier", m68["brier"]), ("ece10", m68["ece10"]), ("absoluteMeanProbabilityGap", m68["absoluteMeanProbabilityGap"]), ("meanPredictedHomeWin", m68["meanPredictedHomeWin"]), ("observedHomeWinRate", m68["observedHomeWinRate"])):
        if key not in parent_candidate or abs(float(parent_candidate[key]) - float(value)) > 1e-12:
            raise SystemExit(f"MLB_V68_CROSS_SPORT_PARENT_METRIC_RECONSTRUCTION_MISMATCH:{key}:{value}:{parent_candidate.get(key)}")

    result = {
        "schemaVersion": RESULT_SCHEMA,
        "classification": classification,
        "scientificStatus": "V68_CROSS_SPORT_ABSOLUTE_PROBABILITY_QUALIFICATION_COMPLETED_AFTER_ORIGINAL_ONE_SHOT_PROSPECTIVE_EVALUATION",
        "passed": passed,
        "crossSportMlbFullGameCandidateAuthorized": passed,
        "first5CrossSportProbabilityAuthorized": False,
        "globalEliteRankerStillBlocked": True,
        "population": {
            "canonicalGames": len(joined),
            "distinctOfficialDates": len(set(dates)),
            "firstOfficialDate": min(dates),
            "lastOfficialDate": max(dates),
            "captureSha256": sha256_file(args.capture),
            "outcomesSha256": sha256_file(args.outcomes),
            "originalV68EvaluationSha256": sha256_file(args.v68_final_evaluation),
        },
        "v68": m68,
        "frozenClimatology": {"probability": baseline_probability, **mbase},
        "identityAffineLikelihoodRatio": lr,
        "gates": gates,
        "originalV68ProspectiveEvaluation": {
            "classification": parent_eval.get("classification"),
            "passed": parent_eval.get("passed"),
            "improvement": parent_eval.get("improvement"),
            "pairedBootstrap": parent_eval.get("pairedBootstrap"),
            "promotionChecks": parent_eval.get("promotionChecks"),
            "formalControl": parent_eval.get("formalControl"),
        },
        "diagnostics": {
            "byDate": by_date_diagnostics(dates, p68, y),
            "rollingProbabilityGap": rolling_gap(dates, p68, y),
        },
        "outcomesReadByCrossSportEvaluator": True,
        "outcomesSourceScientificStatus": outcomes_payload.get("scientificStatus"),
        "policy": {
            "diagnosticAffineAlternativeUsedForPrediction": False,
            "historicalHitRateUsedAsProbability": False,
            "marketOddsUsedAsProbabilityInput": False,
            "sportsbookPricesUsedAsProbabilityInput": False,
            "v68RefitPerformed": False,
            "v68RecalibrationPerformed": False,
            "subsetMiningPerformed": False,
            "adaptiveStoppingPerformed": False,
            "researchOnly": True,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
        },
        "nextAction": (
            "FREEZE_MLB_FULL_GAME_CROSS_SPORT_INTERFACE_CERTIFICATION_AND_THEN_DESIGN_SEPARATE_GLOBAL_ELITE_RANKER_CONTRACT_WITH_F5_STILL_EXCLUDED"
            if passed else
            "DO_NOT_AUTHORIZE_MLB_V68_FOR_CROSS_SPORT_USE_KEEP_GLOBAL_ELITE_BLOCKED_AND_DO_NOT_RETUNE_ON_THIS_PROSPECTIVE_COHORT"
        ),
    }
    dump_json(args.out, result)
    print(json.dumps({
        "classification": classification,
        "passed": passed,
        "population": result["population"],
        "v68": m68,
        "identityAffineLikelihoodRatio": lr,
        "gates": gates,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
