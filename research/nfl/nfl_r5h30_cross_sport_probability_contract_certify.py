#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

EXPECTED_CONTRACT_SCHEMA = "courtedge-nfl-r5h29-cross-sport-probability-contract.v1"
EXPECTED_R5H28_CLASSIFICATION = "R5H27_IDENTITY_PROBABILITY_HISTORICALLY_QUALIFIED_FOR_NFL_CROSS_SPORT_CANDIDACY"
ROUTES = ("R5H8_CORE", "R5H21_LATE_DOWN")
TOL = 1e-12


def close(a: float, b: float, name: str) -> None:
    if abs(float(a) - float(b)) > TOL:
        raise RuntimeError(f"R5H30 metric custody drift for {name}: {a} != {b}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5h28-dir", default="nfl-r5h28-output")
    ap.add_argument("--contract", default="research/nfl/R5H29_CROSS_SPORT_PROBABILITY_CONTRACT.json")
    ap.add_argument("--out-dir", default="nfl-r5h30-output")
    args = ap.parse_args()

    summary_path = Path(args.r5h28_dir) / "nfl_r5h28_summary.json"
    audit_path = Path(args.r5h28_dir) / "nfl_r5h28_audit.json"
    candidate_path = Path(args.r5h28_dir) / "nfl_r5h28_identity_probability_candidate.json"
    contract_path = Path(args.contract)
    if not all(p.exists() for p in (summary_path, audit_path, candidate_path, contract_path)):
        raise RuntimeError("R5H30 missing required R5H28 evidence or R5H29 contract")

    s = json.loads(summary_path.read_text())
    a = json.loads(audit_path.read_text())
    c28 = json.loads(candidate_path.read_text())
    c = json.loads(contract_path.read_text())

    if c.get("schemaVersion") != EXPECTED_CONTRACT_SCHEMA:
        raise RuntimeError("R5H30 unexpected R5H29 contract schema")
    if c.get("frozenBeforeR5H30Certification") is not True:
        raise RuntimeError("R5H29 contract was not frozen before R5H30 certification")
    if s.get("classification") != EXPECTED_R5H28_CLASSIFICATION:
        raise RuntimeError("R5H30 source R5H28 classification drift")
    if s.get("allStatisticalGatesPassed") is not True:
        raise RuntimeError("R5H30 source R5H28 statistical gates not all passed")
    if s.get("identityProbabilityHistoricallyQualified") is not True:
        raise RuntimeError("R5H30 source identity mapping not qualified")
    if s.get("crossSportCalibrationCandidateAuthorized") is not True:
        raise RuntimeError("R5H30 source cross-sport candidacy not authorized")
    if int(s.get("rows")) != 211 or int(s.get("wins")) != 171 or int(s.get("losses")) != 40:
        raise RuntimeError("R5H30 source custody counts drift")
    if s.get("r5h22RowsetSha256") != c["evidenceCustody"]["r5h22CalibrationRowsetSha256"]:
        raise RuntimeError("R5H30 R5H22 rowset SHA drift")
    if c["evidenceCustody"]["historicalQualificationClassification"] != s["classification"]:
        raise RuntimeError("R5H30 qualification classification custody drift")

    if c["probabilitySemantics"]["formula"] != "p_win_selected_side = reference_confidence":
        raise RuntimeError("R5H30 probability formula drift")
    if int(c["probabilitySemantics"]["freeParameters"]) != 0:
        raise RuntimeError("R5H30 identity map must remain zero-parameter")
    if c["probabilitySemantics"]["historicalHitRateMayNotReplacePerGameProbability"] is not True:
        raise RuntimeError("R5H30 historical-hit-rate semantic guard missing")

    source_combined = s["fullCustodyEvaluation"]["combined"]
    expected_combined = c["combinedHistoricalDiagnostics"]
    for key in ("rows", "wins", "losses"):
        if int(source_combined["raw"][key]) != int(expected_combined[key]):
            raise RuntimeError(f"R5H30 combined count drift for {key}")
    metric_map = {
        "accuracy": "accuracy",
        "meanProbability": "meanProbability",
        "brier": "brier",
        "logLoss": "logLoss",
        "absoluteMeanCalibrationGap": "absoluteMeanCalibrationGap",
        "ece5EqualWidth": "ece5EqualWidth",
    }
    for src, dst in metric_map.items():
        close(source_combined["raw"][src], expected_combined[dst], f"combined.{src}")
    close(source_combined["calibrationInTheLarge"]["twoSidedPValue"], expected_combined["calibrationInTheLargeTwoSidedPValue"], "combined.cilP")
    close(source_combined["identityAffineLikelihoodRatio"]["pValue"], expected_combined["identityAffineLikelihoodRatioPValue"], "combined.identityLrP")

    for route in ROUTES:
        sr = s["fullCustodyEvaluation"][route]
        er = c["routes"][route]
        for key in ("rows", "wins", "losses"):
            expected_key = "historicalRows" if key == "rows" else key
            if int(sr["raw"][key]) != int(er[expected_key]):
                raise RuntimeError(f"R5H30 {route} count drift for {key}")
        for src, dst in metric_map.items():
            close(sr["raw"][src], er[dst], f"{route}.{src}")
        close(sr["calibrationInTheLarge"]["twoSidedPValue"], er["calibrationInTheLargeTwoSidedPValue"], f"{route}.cilP")
        close(sr["identityAffineLikelihoodRatio"]["pValue"], er["identityAffineLikelihoodRatioPValue"], f"{route}.identityLrP")

        sp = s["prequentialSkillEvaluation"][route]
        if int(sp["raw"]["rows"]) != int(er["prequentialRows"]):
            raise RuntimeError(f"R5H30 {route} prequential row drift")
        close(sp["raw"]["brier"], er["prequentialRawBrier"], f"{route}.preqRawBrier")
        close(sp["climatology"]["brier"], er["prequentialClimatologyBrier"], f"{route}.preqClimateBrier")
        close(sp["raw"]["logLoss"], er["prequentialRawLogLoss"], f"{route}.preqRawLogLoss")
        close(sp["climatology"]["logLoss"], er["prequentialClimatologyLogLoss"], f"{route}.preqClimateLogLoss")
        if sp["rawBrierLower"] is not True or sp["rawLogLossLower"] is not True:
            raise RuntimeError(f"R5H30 {route} lost proper-score skill vs climatology")

    spc = s["prequentialSkillEvaluation"]["combined"]
    epc = c["combinedPrequentialSkill"]
    if int(spc["raw"]["rows"]) != int(epc["rows"]):
        raise RuntimeError("R5H30 combined prequential row drift")
    close(spc["raw"]["brier"], epc["rawBrier"], "combined.preqRawBrier")
    close(spc["climatology"]["brier"], epc["climatologyBrier"], "combined.preqClimateBrier")
    close(spc["rawMinusClimatology"]["brier"], epc["rawMinusClimatologyBrier"], "combined.preqBrierDelta")
    close(spc["raw"]["logLoss"], epc["rawLogLoss"], "combined.preqRawLogLoss")
    close(spc["climatology"]["logLoss"], epc["climatologyLogLoss"], "combined.preqClimateLogLoss")
    close(spc["rawMinusClimatology"]["logLoss"], epc["rawMinusClimatologyLogLoss"], "combined.preqLogLossDelta")

    if c["routes"]["R5H8_CORE"]["routeStatus"] != "QUALIFIED_STANDARD_MONITORING":
        raise RuntimeError("R5H30 Core uncertainty status drift")
    if c["routes"]["R5H21_LATE_DOWN"]["routeStatus"] != "QUALIFIED_ELEVATED_MONITORING_REQUIRED":
        raise RuntimeError("R5H30 Late Down uncertainty status drift")
    up = c["uncertaintyPolicy"]
    if any(up[k] for k in ("routeLabelMayChangeProbability", "routeLabelMayShrinkProbability", "routeLabelMayPenalizeGlobalRanking", "routeLabelMayChangeSelectionRules")):
        raise RuntimeError("R5H30 uncertainty metadata may not alter probability or ranking")
    if c["globalEliteRankerPolicy"]["nflMayEnterRankerNow"] is not False:
        raise RuntimeError("R5H30 global ranker must remain blocked")

    # Evidence-level safety checks from R5H28.
    if a.get("identityMapping") != "ZERO_PARAMETER_NO_FIT":
        raise RuntimeError("R5H30 R5H28 identity mapping audit drift")
    if a.get("marketCalibrationFeatures") != "NONE":
        raise RuntimeError("R5H30 market calibration features detected")
    if a.get("crossSportPooling") != "NONE":
        raise RuntimeError("R5H30 cross-sport pooling detected")
    if a.get("globalEliteRanker") != "BLOCKED":
        raise RuntimeError("R5H30 source global ranker boundary drift")

    if c28.get("crossSportCandidateAuthorized") is not True:
        raise RuntimeError("R5H30 R5H28 candidate authorization drift")
    if c28.get("formula") != "p_identity = reference_confidence":
        raise RuntimeError("R5H30 R5H28 candidate formula drift")

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result = {
        "schemaVersion": "courtedge-nfl-r5h30-cross-sport-probability-certification.v1",
        "stage": "R5H30_NFL_CROSS_SPORT_PROBABILITY_CONTRACT_CERTIFICATION",
        "contractSchema": c["schemaVersion"],
        "sourceR5H28Classification": s["classification"],
        "contractCustodyPassed": True,
        "probabilitySemanticsPassed": True,
        "routeUncertaintyCustodyPassed": True,
        "prequentialSkillCustodyPassed": True,
        "researchBoundaryPassed": True,
        "crossSportCandidateStatus": "NFL_PROBABILITY_INTERFACE_CERTIFIED_AS_CANDIDATE",
        "globalEliteRankerStatus": "BLOCKED_PENDING_EQUIVALENT_OTHER_SPORT_CONTRACTS",
        "nextAction": "AUDIT_MLB_CROSS_SPORT_PROBABILITY_READINESS_WITHOUT_CHANGING_MLB_MODELS"
    }
    (out / "nfl_r5h30_certification.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
