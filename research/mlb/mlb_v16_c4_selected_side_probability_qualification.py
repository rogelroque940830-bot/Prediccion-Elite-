#!/usr/bin/env python3
import argparse, hashlib, json, math, os
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

CONTRACT_SCHEMA = "courtedge-mlb-v16-c4-selected-side-probability-qualification-contract.v1"
TABLE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
MANIFEST_SCHEMA = "courtedge-p0-step12v16-pure-settlement-model-manifest.v1"
REPORT_SCHEMA = "courtedge-p0-step12v16-pure-ml-f5-settlement-probability.v1"
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
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def sigmoid(z):
    z = np.clip(np.asarray(z, dtype=float), -50.0, 50.0)
    return 1.0 / (1.0 + np.exp(-z))


def logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def transform(rows, preprocessor):
    features = preprocessor["features"]
    median = preprocessor["medianImpute"]
    mean = preprocessor["mean"]
    scale = preprocessor["scale"]
    out = np.empty((len(rows), len(features)), dtype=float)
    for j, (name, med, mu, sd) in enumerate(zip(features, median, mean, scale)):
        vals = []
        for row in rows:
            v = row.get("features", {}).get(name)
            if v is None:
                vals.append(float(med))
                continue
            try:
                x = float(v)
            except Exception:
                x = float(med)
            if not math.isfinite(x):
                x = float(med)
            vals.append(x)
        out[:, j] = (np.asarray(vals) - float(mu)) / float(sd)
    return out


def predict_home(rows, model):
    x = transform(rows, model["preprocessor"])
    raw = float(model["intercept"]) + x @ np.asarray(model["coefficients"], dtype=float)
    cal = model["calibration"]
    return sigmoid(float(cal["slope"]) * raw + float(cal["intercept"]))


def binary_metrics(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    ll = -float(np.mean(y * np.log(np.maximum(p, EPS)) + (1 - y) * np.log(np.maximum(1 - p, EPS))))
    brier = float(np.mean((p - y) ** 2))
    ece = 0.0
    bins = []
    for i in range(10):
        lo, hi = i / 10, (i + 1) / 10
        mask = (p >= lo) & ((p < hi) if i < 9 else (p <= hi))
        n = int(mask.sum())
        if n:
            mp = float(p[mask].mean())
            obs = float(y[mask].mean())
            ece += n / len(y) * abs(mp - obs)
            bins.append({"low": lo, "high": hi, "n": n, "meanPredicted": mp, "observedRate": obs})
    denom = math.sqrt(float(np.sum(p * (1 - p))))
    z = float(np.sum(y - p) / denom) if denom > 0 else float("inf")
    return {
        "n": int(len(y)),
        "meanPredicted": float(p.mean()),
        "observedRate": float(y.mean()),
        "absoluteMeanCalibrationGap": abs(float(p.mean() - y.mean())),
        "brier": brier,
        "logLoss": ll,
        "ece10": float(ece),
        "calibrationInTheLargeZ": z,
        "calibrationBins": bins,
    }


def identity_affine_lr(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    x = logit(p)

    def nll(t):
        alpha = float(t[0])
        beta = math.exp(float(t[1]))
        z = alpha + beta * x
        return float(np.sum(np.logaddexp(0.0, z) - y * z))

    null_nll = -float(np.sum(y * np.log(np.maximum(p, EPS)) + (1 - y) * np.log(np.maximum(1 - p, EPS))))
    opt = minimize(nll, np.zeros(2), method="L-BFGS-B", options={"maxiter": 10000, "ftol": 1e-14, "gtol": 1e-9})
    if not opt.success or not np.all(np.isfinite(opt.x)):
        raise SystemExit(f"MLB_V16_IDENTITY_AFFINE_OPTIMIZER_FAILED:{opt.message}")
    alt_nll = float(opt.fun)
    lr = max(0.0, 2.0 * (null_nll - alt_nll))
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="Extracted p0-step12v winner-anatomy artifact root")
    ap.add_argument("--v16-evidence", required=True, help="Extracted V16 evidence artifact root")
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    contract = load_json(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MLB_V16_QUALIFICATION_CONTRACT_SCHEMA_INVALID")
    if contract["crossSportSemantic"]["first5Excluded"] is not True:
        raise SystemExit("MLB_V16_FIRST5_MUST_REMAIN_EXCLUDED")
    if contract["frozenProbabilityMapping"]["freeParameters"] != 0:
        raise SystemExit("MLB_V16_MAPPING_MUST_HAVE_ZERO_FREE_PARAMETERS")

    evidence_root = Path(args.v16_evidence)
    manifest_path = evidence_root / "pure-settlement-model-manifest.json"
    report_path = evidence_root / "pure-settlement-probability-report.json"
    if sha256_file(manifest_path) != contract["v16FrozenAuthority"]["manifestArtifactFileSha256"]:
        raise SystemExit("MLB_V16_MANIFEST_ARTIFACT_FILE_SHA_MISMATCH")
    if sha256_file(report_path) != contract["v16FrozenAuthority"]["reportArtifactFileSha256"]:
        raise SystemExit("MLB_V16_REPORT_ARTIFACT_FILE_SHA_MISMATCH")

    manifest = load_json(manifest_path)
    report = load_json(report_path)
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA or report.get("schemaVersion") != REPORT_SCHEMA:
        raise SystemExit("MLB_V16_EVIDENCE_SCHEMA_INVALID")
    if canonical_digest(manifest) != contract["v16FrozenAuthority"]["manifestCanonicalSha256"]:
        raise SystemExit("MLB_V16_MANIFEST_CANONICAL_SHA_MISMATCH")
    if manifest.get("modelVersion") != contract["v16FrozenAuthority"]["modelVersion"]:
        raise SystemExit("MLB_V16_MODEL_VERSION_MISMATCH")
    if manifest.get("priceIndependent") is not True:
        raise SystemExit("MLB_V16_PRICE_INDEPENDENCE_INVALID")
    if manifest.get("fullGame", {}).get("featureSet") != "C4":
        raise SystemExit("MLB_V16_FULL_GAME_FEATURE_SET_DRIFT")
    if manifest.get("policy", {}).get("sportsbookPriceInputs") is not False or manifest.get("policy", {}).get("marketOddsInputs") is not False:
        raise SystemExit("MLB_V16_MARKET_INPUT_BOUNDARY_INVALID")
    if manifest.get("policy", {}).get("evaluationSeasonsCanMutateModel") is not False:
        raise SystemExit("MLB_V16_EVALUATION_MUTATION_BOUNDARY_INVALID")

    rows_all = []
    season_payload = {}
    seen_game_pks = set()
    expected_tables = contract["sourceCustody"]["exactEvaluationTables"]
    for season in contract["v16FrozenAuthority"]["evaluationSeasons"]:
        spec = expected_tables[season]
        table_path = Path(args.root) / spec["path"]
        actual_sha = sha256_file(table_path)
        if actual_sha != spec["fileSha256"]:
            raise SystemExit(f"MLB_V16_SOURCE_TABLE_SHA_MISMATCH:{season}:{actual_sha}")
        table = load_json(table_path)
        if table.get("schemaVersion") != TABLE_SCHEMA:
            raise SystemExit(f"MLB_V16_SOURCE_TABLE_SCHEMA_INVALID:{season}")
        rows = [r for r in table.get("rows", []) if r.get("t5PregameValid") is True]
        if len(rows) != int(spec["eligibleRows"]):
            raise SystemExit(f"MLB_V16_ELIGIBLE_ROW_COUNT_MISMATCH:{season}:{len(rows)}")
        p = predict_home(rows, manifest["fullGame"])
        y = []
        season_rows = []
        for idx, (row, prob) in enumerate(zip(rows, p)):
            game_pk = row.get("gamePk")
            if not isinstance(game_pk, int) or game_pk <= 0:
                raise SystemExit(f"MLB_V16_GAME_PK_INVALID:{season}:{idx}")
            if game_pk in seen_game_pks:
                raise SystemExit(f"MLB_V16_DUPLICATE_GAME_PK:{game_pk}")
            seen_game_pks.add(game_pk)
            result = row.get("outcomes", {}).get("FULL_GAME", {}).get("result")
            if result not in ("HOME", "AWAY"):
                raise SystemExit(f"MLB_V16_FULL_GAME_BINARY_OUTCOME_INVALID:{game_pk}:{result}")
            yy = 1 if result == "HOME" else 0
            y.append(yy)
            p_home = float(prob)
            p_away = 1.0 - p_home
            if not (0.0 <= p_home <= 1.0 and 0.0 <= p_away <= 1.0):
                raise SystemExit(f"MLB_V16_PROBABILITY_OUT_OF_RANGE:{game_pk}")
            if abs((p_home + p_away) - 1.0) > float(contract["frozenProbabilityMapping"]["requiredComplementTolerance"]):
                raise SystemExit(f"MLB_V16_COMPLEMENT_IDENTITY_FAILED:{game_pk}")
            season_rows.append({
                "season": season,
                "gamePk": game_pk,
                "officialDate": row.get("officialDate"),
                "pHomeWin": p_home,
                "pAwayWin": p_away,
                "yHomeWin": yy,
                "yAwayWin": 1 - yy,
                "qualificationReferenceSide": "HOME",
                "pWinSelectedSideWhenHome": p_home,
                "pWinSelectedSideWhenAway": p_away,
            })
        y_arr = np.asarray(y, dtype=float)
        base = np.full(len(rows), float(contract["frozenBaseline"]["probability"]))
        metrics = binary_metrics(p, y_arr)
        baseline_metrics = binary_metrics(base, y_arr)
        lr = identity_affine_lr(p, y_arr)
        season_payload[season] = {
            "rows": len(rows),
            "sourceTableSha256": actual_sha,
            "model": metrics,
            "frozenClimatology": baseline_metrics,
            "identityAffineLikelihoodRatio": lr,
        }
        rows_all.extend(season_rows)

    if len(rows_all) != int(contract["sourceCustody"]["requiredCombinedEvaluationRows"]):
        raise SystemExit(f"MLB_V16_COMBINED_ROW_COUNT_MISMATCH:{len(rows_all)}")

    rows_all.sort(key=lambda r: (r["officialDate"], r["gamePk"]))
    p_all = np.asarray([r["pHomeWin"] for r in rows_all], dtype=float)
    y_all = np.asarray([r["yHomeWin"] for r in rows_all], dtype=float)
    base_all = np.full(len(rows_all), float(contract["frozenBaseline"]["probability"]))
    combined = binary_metrics(p_all, y_all)
    combined_base = binary_metrics(base_all, y_all)
    combined_lr = identity_affine_lr(p_all, y_all)

    certified = report["combinedEvaluation"]["fullGame"]["model"]
    for key, ours in (("brier", combined["brier"]), ("logLoss", combined["logLoss"]), ("ece10", combined["ece10"]), ("meanPredictedHome", combined["meanPredicted"]), ("observedHomeRate", combined["observedRate"])):
        if abs(float(certified[key]) - float(ours)) > 1e-12:
            raise SystemExit(f"MLB_V16_CERTIFIED_METRIC_RECONSTRUCTION_MISMATCH:{key}:{ours}:{certified[key]}")

    qual = contract["statisticalQualification"]
    critical = float(qual["calibrationInTheLarge"]["twoSidedCriticalAbsZ"])
    alpha = float(qual["identityAffineLikelihoodRatio"]["rejectIdentityIfPValueBelow"])
    pre = qual["preExistingV16FrozenGates"]
    gates = {
        "exactCustodyRows": len(rows_all) == int(contract["sourceCustody"]["requiredCombinedEvaluationRows"]),
        "probabilityComplementIdentity": bool(np.all(np.abs((p_all + (1 - p_all)) - 1.0) <= float(contract["frozenProbabilityMapping"]["requiredComplementTolerance"]))),
        "allProbabilitiesFiniteAndUnitInterval": bool(np.all(np.isfinite(p_all)) and np.all((p_all >= 0) & (p_all <= 1))),
        "combinedBrierBeatsFrozenClimatology": combined["brier"] < combined_base["brier"],
        "combinedLogLossBeatsFrozenClimatology": combined["logLoss"] < combined_base["logLoss"],
        "combinedCalibrationInTheLarge": abs(combined["calibrationInTheLargeZ"]) <= critical,
        "combinedIdentityAffineNotRejected": combined_lr["pValue"] >= alpha,
        "combinedEce10WithinFrozenV16Gate": combined["ece10"] <= float(pre["combinedEce10Max"]),
        "everySeasonLogLossWithinFrozenNoCatastropheGate": all(
            payload["model"]["logLoss"] <= payload["frozenClimatology"]["logLoss"] + float(pre["everySeasonLogLossMaxFrozenPriorPlus"])
            for payload in season_payload.values()
        ),
        "everySeasonCoverageExact": all(payload["rows"] == int(expected_tables[s]["eligibleRows"]) for s, payload in season_payload.items()),
    }
    passed = all(gates.values())
    classification = contract["acceptanceRubric"]["passClassification"] if passed else contract["acceptanceRubric"]["failClassification"]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rowset_path = out_dir / "mlb-v16-c4-selected-side-qualification-rowset.jsonl"
    with open(rowset_path, "w", encoding="utf-8") as f:
        for row in rows_all:
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
    rowset_sha = sha256_file(rowset_path)

    summary = {
        "schemaVersion": "courtedge-mlb-v16-c4-selected-side-probability-qualification.v1",
        "classification": classification,
        "allMandatoryGatesPassed": passed,
        "crossSportMlbFullGameCandidateAuthorized": passed,
        "first5CrossSportProbabilityAuthorized": False,
        "globalEliteRankerStillBlocked": True,
        "rows": len(rows_all),
        "rowsetSha256": rowset_sha,
        "combined": {
            "model": combined,
            "frozenClimatology": combined_base,
            "identityAffineLikelihoodRatio": combined_lr,
        },
        "bySeason": season_payload,
        "gates": gates,
        "nextAction": (
            "FREEZE_MLB_FULL_GAME_CROSS_SPORT_INTERFACE_AND_KEEP_DAILY_BEST_PICK_PROSPECTIVE_EMBARGO"
            if passed else
            "DO_NOT_AUTHORIZE_MLB_V16_C4_FOR_CROSS_SPORT_USE_KEEP_GLOBAL_ELITE_BLOCKED_AND_FREEZE_NEXT_NON_TUNED_MLB_PROBABILITY_HYPOTHESIS"
        ),
    }
    audit = {
        "schemaVersion": "courtedge-mlb-v16-c4-selected-side-probability-qualification-audit.v1",
        "contractSchema": contract["schemaVersion"],
        "v16ArtifactId": contract["v16FrozenAuthority"]["artifactId"],
        "sourceArtifactId": contract["sourceCustody"]["winnerAnatomyArtifactId"],
        "manifestCanonicalSha256": canonical_digest(manifest),
        "rowsetSha256": rowset_sha,
        "selectionRulesChanged": False,
        "weightsChanged": False,
        "featuresChanged": False,
        "calibrationChanged": False,
        "thresholdsChanged": False,
        "routingChanged": False,
        "rankingChanged": False,
        "v68Changed": False,
        "sportsbookPricesRead": False,
        "marketOddsRead": False,
        "first5EvaluatedForCrossSport": False,
        "alternativeAffineFitUsedForPrediction": False,
        "historicalHitRateUsedAsProbability": False,
        "crossSportPoolingPerformed": False,
        "globalEliteRankingPerformed": False,
        "automaticBetPlacement": False,
        "realFinancialExposure": 0,
    }
    dump_json(out_dir / "mlb-v16-c4-selected-side-probability-qualification-summary.json", summary)
    dump_json(out_dir / "mlb-v16-c4-selected-side-probability-qualification-audit.json", audit)
    print(json.dumps({
        "classification": classification,
        "allMandatoryGatesPassed": passed,
        "rows": len(rows_all),
        "rowsetSha256": rowset_sha,
        "combined": summary["combined"],
        "gates": gates,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
