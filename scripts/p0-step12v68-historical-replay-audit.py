#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import math
import os
from collections import defaultdict

import numpy as np

EPS = 1e-15
SCHEMA = "courtedge-p0-step12v68-historical-replay-audit.v1"
SPEC_SCHEMA = "courtedge-p0-step12v68-historical-replay-audit-spec.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-confirmation-contract.v1"
V16_SCHEMA = "courtedge-p0-step12v16-pure-settlement-model-manifest.v1"
EXPECTED = {"2023": 2399, "2024": 2406, "2025": 2423, "2026_YTD": 1781}
EVAL = ("2024", "2025", "2026_YTD")
CONTEXT = ("2023",) + EVAL


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def canonical_digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except Exception:
        return False


def load_custody(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    rows = []
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def load_outcomes(control_root):
    out = {}
    for season in CONTEXT:
        path = os.path.join(control_root, season, "game-anatomy-feature-table.json")
        table = load(path)
        rows = [r for r in table.get("rows", []) if r.get("t5PregameValid") is True]
        if len(rows) != EXPECTED[season]:
            raise SystemExit(f"V68_REPLAY_CONTROL_ROWS_DRIFT:{season}:{len(rows)}")
        for r in rows:
            result = ((r.get("outcomes") or {}).get("FULL_GAME") or {}).get("result")
            if result not in ("HOME", "AWAY"):
                raise SystemExit(f"V68_REPLAY_FULL_GAME_OUTCOME_INVALID:{season}:{r.get('gamePk')}:{result}")
            out[(season, int(r["gamePk"]))] = 1.0 if result == "HOME" else 0.0
    return out


def attach(custody, outcomes):
    rows = []
    by_season = defaultdict(int)
    seen = set()
    for source in custody:
        season = str(source.get("season"))
        if season not in CONTEXT:
            continue
        gp = int(source["gamePk"])
        key = (season, gp)
        if key in seen:
            raise SystemExit(f"V68_REPLAY_DUPLICATE_CUSTODY_GAME:{season}:{gp}")
        seen.add(key)
        if key not in outcomes:
            raise SystemExit(f"V68_REPLAY_OUTCOME_MISSING:{season}:{gp}")
        row = dict(source)
        row["_y"] = outcomes[key]
        rows.append(row)
        by_season[season] += 1
    for season in CONTEXT:
        if by_season[season] != EXPECTED[season]:
            raise SystemExit(f"V68_REPLAY_CUSTODY_ROWS_DRIFT:{season}:{by_season[season]}")
    return rows


def sigmoid(z):
    z = np.clip(np.asarray(z, dtype=float), -50.0, 50.0)
    return 1.0 / (1.0 + np.exp(-z))


def transform(rows, preprocessor):
    names = list(preprocessor["features"])
    med = list(preprocessor["medianImpute"])
    mean = list(preprocessor["mean"])
    scale = list(preprocessor["scale"])
    x = np.empty((len(rows), len(names)), dtype=float)
    for j, (name, m, u, s) in enumerate(zip(names, med, mean, scale)):
        s = float(s)
        if not math.isfinite(s) or s <= 0:
            raise SystemExit(f"V68_REPLAY_INVALID_FROZEN_SCALE:{name}:{s}")
        x[:, j] = [((float(r[name]) if finite(r.get(name)) else float(m)) - float(u)) / s for r in rows]
    return x


def predict(model, rows):
    x = transform(rows, model["preprocessor"])
    z = float(model["intercept"]) + x @ np.asarray(model["coefficients"], dtype=float)
    c = model["calibration"]
    return sigmoid(float(c["slope"]) * z + float(c["intercept"]))


def roc_auc(y, p):
    y = np.asarray(y, dtype=int)
    p = np.asarray(p, dtype=float)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return None
    order = np.argsort(p, kind="mergesort")
    sorted_p = p[order]
    ranks = np.empty(len(p), dtype=float)
    i = 0
    while i < len(p):
        j = i + 1
        while j < len(p) and sorted_p[j] == sorted_p[i]:
            j += 1
        avg_rank = (i + 1 + j) / 2.0
        ranks[order[i:j]] = avg_rank
        i = j
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def reliability_bins(p, y, edges):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    out = []
    for i in range(len(edges) - 1):
        lo, hi = float(edges[i]), float(edges[i + 1])
        mask = (p >= lo) & ((p < hi) if i < len(edges) - 2 else (p <= hi))
        n = int(mask.sum())
        out.append({
            "lower": lo,
            "upper": hi,
            "n": n,
            "meanPredictedHome": float(p[mask].mean()) if n else None,
            "observedHomeRate": float(y[mask].mean()) if n else None,
            "absoluteGap": abs(float(p[mask].mean()) - float(y[mask].mean())) if n else None,
        })
    return out


def metrics(p, y, reliability_edges=None):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    llv = -(y * np.log(np.maximum(p, EPS)) + (1.0 - y) * np.log(np.maximum(1.0 - p, EPS)))
    brv = (p - y) ** 2
    ece = 0.0
    default_edges = np.linspace(0.0, 1.0, 11)
    for i in range(10):
        lo, hi = default_edges[i], default_edges[i + 1]
        mask = (p >= lo) & ((p < hi) if i < 9 else (p <= hi))
        n = int(mask.sum())
        if n:
            ece += n / len(y) * abs(float(p[mask].mean()) - float(y[mask].mean()))
    out = {
        "n": len(y),
        "logLoss": float(llv.mean()),
        "brier": float(brv.mean()),
        "ece10": float(ece),
        "absoluteMeanProbabilityGap": abs(float(p.mean()) - float(y.mean())),
        "rocAuc": roc_auc(y, p),
        "accuracyAt0_5": float(np.mean((p >= 0.5) == (y >= 0.5))),
        "meanPredictedHome": float(p.mean()),
        "observedHomeRate": float(y.mean()),
    }
    if reliability_edges is not None:
        out["reliabilityBins"] = reliability_bins(p, y, reliability_edges)
    return out


def delta(control, candidate):
    return {
        "logLossImprovement": float(control["logLoss"] - candidate["logLoss"]),
        "brierImprovement": float(control["brier"] - candidate["brier"]),
        "ece10ChangePositiveMeansLower": float(control["ece10"] - candidate["ece10"]),
        "absoluteMeanProbabilityGapChangePositiveMeansLower": float(
            control["absoluteMeanProbabilityGap"] - candidate["absoluteMeanProbabilityGap"]
        ),
        "rocAucChange": None if control["rocAuc"] is None or candidate["rocAuc"] is None else float(candidate["rocAuc"] - control["rocAuc"]),
        "accuracyAt0_5Change": float(candidate["accuracyAt0_5"] - control["accuracyAt0_5"]),
    }


def per_game_losses(p, y):
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=float)
    return (
        -(y * np.log(np.maximum(p, EPS)) + (1.0 - y) * np.log(np.maximum(1.0 - p, EPS))),
        (p - y) ** 2,
    )


def bootstrap_dates(rows, p16, p68, y, spec):
    cll, cbr = per_game_losses(p16, y)
    vll, vbr = per_game_losses(p68, y)
    dll, dbr = cll - vll, cbr - vbr
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[str(r["officialDate"])].append(i)
    keys = sorted(groups)
    agg = []
    date_rows = []
    for date in keys:
        idx = np.asarray(groups[date], dtype=int)
        ll_mean = float(dll[idx].mean())
        br_mean = float(dbr[idx].mean())
        agg.append((float(dll[idx].sum()), float(dbr[idx].sum()), len(idx)))
        date_rows.append({"officialDate": date, "n": len(idx), "meanLogLossImprovement": ll_mean, "meanBrierImprovement": br_mean})
    cfg = spec["primaryCharacterization"]["pairedBootstrap"]
    resamples = int(cfg["resamples"])
    seed = int(cfg["seed"])
    rng = np.random.default_rng(seed)
    a = np.asarray(agg, dtype=float)
    vals = np.empty((resamples, 2), dtype=float)
    k = len(keys)
    for b in range(resamples):
        pick = rng.integers(0, k, size=k)
        x = a[pick]
        n = x[:, 2].sum()
        vals[b, 0] = x[:, 0].sum() / n
        vals[b, 1] = x[:, 1].sum() / n
    date_ll = np.asarray([x["meanLogLossImprovement"] for x in date_rows], dtype=float)
    date_br = np.asarray([x["meanBrierImprovement"] for x in date_rows], dtype=float)
    return {
        "unit": "OFFICIAL_DATE_CLUSTER",
        "distinctDates": k,
        "resamples": resamples,
        "seed": seed,
        "logLossImprovement": {
            "pointEstimate": float(dll.mean()),
            "ci95": [float(np.quantile(vals[:, 0], 0.025)), float(np.quantile(vals[:, 0], 0.975))],
        },
        "brierImprovement": {
            "pointEstimate": float(dbr.mean()),
            "ci95": [float(np.quantile(vals[:, 1], 0.025)), float(np.quantile(vals[:, 1], 0.975))],
        },
        "dateLevelStability": {
            "meanDateLogLossImprovement": float(date_ll.mean()),
            "medianDateLogLossImprovement": float(np.median(date_ll)),
            "positiveDateShareLogLoss": float(np.mean(date_ll > 0)),
            "meanDateBrierImprovement": float(date_br.mean()),
            "medianDateBrierImprovement": float(np.median(date_br)),
            "positiveDateShareBrier": float(np.mean(date_br > 0)),
        },
    }


def evaluate_group(rows, p16, p68, y, reliability_edges=None):
    m16 = metrics(p16, y, reliability_edges)
    m68 = metrics(p68, y, reliability_edges)
    return {"v16": m16, "v68": m68, "delta": delta(m16, m68)}


def binned_diagnostic(rows, p16, p68, y, values, edges, label):
    values = np.asarray(values, dtype=float)
    p16 = np.asarray(p16, dtype=float)
    p68 = np.asarray(p68, dtype=float)
    y = np.asarray(y, dtype=float)
    out = []
    for i in range(len(edges) - 1):
        lo, hi = float(edges[i]), float(edges[i + 1])
        mask = np.isfinite(values) & (values >= lo) & ((values < hi) if i < len(edges) - 2 else (values <= hi))
        n = int(mask.sum())
        item = {"label": label, "lower": lo, "upper": hi, "n": n}
        if n:
            item.update(evaluate_group([rows[j] for j in np.where(mask)[0]], p16[mask], p68[mask], y[mask]))
        out.append(item)
    missing = int((~np.isfinite(values)).sum())
    return {"bins": out, "missingValueRows": missing}


def monthly(rows, p16, p68, y):
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[str(r["officialDate"])[:7]].append(i)
    out = []
    for month in sorted(groups):
        idx = np.asarray(groups[month], dtype=int)
        z = evaluate_group([rows[i] for i in idx], np.asarray(p16)[idx], np.asarray(p68)[idx], np.asarray(y)[idx])
        out.append({"month": month, **z})
    return out


def quantiles(values, qs):
    a = np.asarray(values, dtype=float)
    return {str(q): float(np.quantile(a, float(q))) for q in qs}


def feature_missingness(rows, names):
    out = {}
    for season in CONTEXT:
        rs = [r for r in rows if r["season"] == season]
        out[season] = {
            name: {
                "missing": int(sum(not finite(r.get(name)) for r in rs)),
                "missingShare": float(sum(not finite(r.get(name)) for r in rs) / len(rs)),
            }
            for name in names
        }
    rs = [r for r in rows if r["season"] in EVAL]
    out["COMBINED_2024_2026_YTD"] = {
        name: {
            "missing": int(sum(not finite(r.get(name)) for r in rs)),
            "missingShare": float(sum(not finite(r.get(name)) for r in rs) / len(rs)),
        }
        for name in names
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--custody", required=True)
    ap.add_argument("--control-root", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--v66-score", required=True)
    ap.add_argument("--v68-contract", required=True)
    ap.add_argument("--audit-spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    spec = load(a.audit_spec)
    contract = load(a.v68_contract)
    v16 = load(a.v16_manifest)
    v66 = load(a.v66_score)
    if spec.get("schemaVersion") != SPEC_SCHEMA or spec.get("scientificStatus") != "FROZEN_RETROSPECTIVE_AUDIT_PLAN_BEFORE_REPLAY_SCORER_EXISTS":
        raise SystemExit("V68_REPLAY_AUDIT_SPEC_INVALID")
    if contract.get("schemaVersion") != CONTRACT_SCHEMA or contract.get("scientificStatus") != "FROZEN_BEFORE_ANY_V68_PROSPECTIVE_CAPTURE_OR_OUTCOME_SCORER_EXISTS":
        raise SystemExit("V68_REPLAY_V68_CONTRACT_INVALID")
    if v16.get("schemaVersion") != V16_SCHEMA:
        raise SystemExit("V68_REPLAY_V16_SCHEMA_INVALID")
    if canonical_digest(v16) != spec["immutableInputs"]["v16"]["manifestCanonicalSha256"]:
        raise SystemExit("V68_REPLAY_V16_MANIFEST_DRIFT")

    feature_names = list(contract["primaryCandidate"]["featuresExactly"])
    if len(feature_names) != 15 or feature_names != list(contract["primaryCandidate"]["modelSnapshot"]["features"]):
        raise SystemExit("V68_REPLAY_V68_FEATURE_DRIFT")
    v68_model = contract["primaryCandidate"]["modelSnapshot"]
    v16_model = v16["fullGame"]
    if list(v16_model["preprocessor"]["features"]) != list(contract["formalControl"]["featuresExactly"]):
        raise SystemExit("V68_REPLAY_V16_CONTROL_FEATURE_DRIFT")

    hypothesis = contract["parentEvidence"]["v66DiagnosticHypothesisKey"]
    v66_model = (((v66.get("routes") or {}).get("V66_C_FULL_GAME_WINNER") or {}).get("models") or {}).get(hypothesis)
    if not isinstance(v66_model, dict):
        raise SystemExit("V68_REPLAY_V66_DIAGNOSTIC_MODEL_MISSING")
    if canonical_digest(v66_model) != canonical_digest(v68_model):
        raise SystemExit("V68_REPLAY_V68_SNAPSHOT_NOT_EXACT_V66_DIAGNOSTIC")

    custody = load_custody(a.custody)
    if len(custody) != 11407:
        raise SystemExit(f"V68_REPLAY_CUSTODY_TOTAL_DRIFT:{len(custody)}")
    rows = attach(custody, load_outcomes(a.control_root))

    cache = {}
    reliability_edges = spec["fixedDiagnostics"]["probabilityReliabilityBins"]
    season_results = {}
    for season in CONTEXT:
        rs = [r for r in rows if r["season"] == season]
        y = np.asarray([r["_y"] for r in rs], dtype=float)
        p16 = predict(v16_model, rs)
        p68 = predict(v68_model, rs)
        cache[season] = (rs, y, p16, p68)
        season_results[season] = evaluate_group(rs, p16, p68, y, reliability_edges)

    # Exact parity to the already-disclosed V66 diagnostic historical results.
    parity = {"tolerance": 1e-12, "bySeason": {}, "combined": {}}
    for season in EVAL:
        observed = season_results[season]["delta"]
        expected = contract["parentEvidence"]["v66DiagnosticBySeason"][season]
        dll = abs(observed["logLossImprovement"] - float(expected["logLossImprovementVsV16"]))
        dbr = abs(observed["brierImprovement"] - float(expected["brierImprovementVsV16"]))
        parity["bySeason"][season] = {"logLossAbsoluteDifference": dll, "brierAbsoluteDifference": dbr}
        if dll > 1e-12 or dbr > 1e-12:
            raise SystemExit(f"V68_REPLAY_V66_METRIC_PARITY_FAILED:{season}:{dll}:{dbr}")

    combined_rows = []
    combined_y = []
    combined_p16 = []
    combined_p68 = []
    for season in EVAL:
        rs, y, p16, p68 = cache[season]
        combined_rows.extend(rs)
        combined_y.extend(y.tolist())
        combined_p16.extend(p16.tolist())
        combined_p68.extend(p68.tolist())
    combined_y = np.asarray(combined_y, dtype=float)
    combined_p16 = np.asarray(combined_p16, dtype=float)
    combined_p68 = np.asarray(combined_p68, dtype=float)
    combined = evaluate_group(combined_rows, combined_p16, combined_p68, combined_y, reliability_edges)
    expc = contract["parentEvidence"]["v66DiagnosticCombined2024_2026Ytd"]
    dll = abs(combined["delta"]["logLossImprovement"] - float(expc["logLossImprovementVsV16"]))
    dbr = abs(combined["delta"]["brierImprovement"] - float(expc["brierImprovementVsV16"]))
    parity["combined"] = {"logLossAbsoluteDifference": dll, "brierAbsoluteDifference": dbr}
    if dll > 1e-12 or dbr > 1e-12:
        raise SystemExit(f"V68_REPLAY_V66_COMBINED_PARITY_FAILED:{dll}:{dbr}")
    parity["passed"] = True

    pshift = combined_p68 - combined_p16
    confidence = np.abs(combined_p68 - 0.5)
    abs_shift = np.abs(pshift)
    exposure = np.asarray([abs(float(r["fg_exposure_adv"])) if finite(r.get("fg_exposure_adv")) else np.nan for r in combined_rows])
    outs_gap = np.asarray([
        abs(float(r["home_expected_starter_outs"]) - float(r["away_expected_starter_outs"]))
        if finite(r.get("home_expected_starter_outs")) and finite(r.get("away_expected_starter_outs")) else np.nan
        for r in combined_rows
    ])
    quality_gap = np.asarray([
        abs(float(r["home_starter_quality_index_z5"]) - float(r["away_starter_quality_index_z5"]))
        if finite(r.get("home_starter_quality_index_z5")) and finite(r.get("away_starter_quality_index_z5")) else np.nan
        for r in combined_rows
    ])

    flips = (combined_p16 >= 0.5) != (combined_p68 >= 0.5)
    flip_n = int(flips.sum())
    flip_report = {"n": flip_n, "share": float(flip_n / len(combined_y))}
    if flip_n:
        flip_report.update(evaluate_group(
            [combined_rows[i] for i in np.where(flips)[0]], combined_p16[flips], combined_p68[flips], combined_y[flips]
        ))

    _, br16 = per_game_losses(combined_p16, combined_y)
    _, br68 = per_game_losses(combined_p68, combined_y)
    brier_delta_game = br16 - br68
    tol = 1e-15
    direction = {
        "v68BetterGames": int(np.sum(brier_delta_game > tol)),
        "exactOrNumericalTieGames": int(np.sum(np.abs(brier_delta_game) <= tol)),
        "v68WorseGames": int(np.sum(brier_delta_game < -tol)),
        "v68BetterShare": float(np.mean(brier_delta_game > tol)),
        "v68WorseShare": float(np.mean(brier_delta_game < -tol)),
    }

    diagnostics = {
        "probabilityShift": {
            "signedV68MinusV16Quantiles": quantiles(pshift, spec["fixedDiagnostics"]["reportProbabilityShiftQuantiles"]),
            "absoluteV68MinusV16Quantiles": quantiles(abs_shift, spec["fixedDiagnostics"]["reportProbabilityShiftQuantiles"]),
            "meanSignedShift": float(pshift.mean()),
            "meanAbsoluteShift": float(abs_shift.mean()),
            "maximumAbsoluteShift": float(abs_shift.max()),
        },
        "confidenceDistanceFromHalf": binned_diagnostic(
            combined_rows, combined_p16, combined_p68, combined_y, confidence,
            spec["fixedDiagnostics"]["v68ConfidenceDistanceFromHalfBins"], "ABS_V68_P_MINUS_0_5"
        ),
        "absoluteModelShift": binned_diagnostic(
            combined_rows, combined_p16, combined_p68, combined_y, abs_shift,
            spec["fixedDiagnostics"]["absoluteV68MinusV16ProbabilityShiftBins"], "ABS_V68_MINUS_V16_PROBABILITY"
        ),
        "absoluteFgExposureAdv": binned_diagnostic(
            combined_rows, combined_p16, combined_p68, combined_y, exposure,
            spec["fixedDiagnostics"]["absoluteFgExposureAdvBins"], "ABS_FG_EXPOSURE_ADV"
        ),
        "absoluteExpectedStarterOutsGap": binned_diagnostic(
            combined_rows, combined_p16, combined_p68, combined_y, outs_gap,
            spec["fixedDiagnostics"]["absoluteExpectedStarterOutsGapBins"], "ABS_EXPECTED_STARTER_OUTS_GAP"
        ),
        "absoluteStarterQualityIndexGap": binned_diagnostic(
            combined_rows, combined_p16, combined_p68, combined_y, quality_gap,
            spec["fixedDiagnostics"]["absoluteStarterQualityIndexGapBins"], "ABS_STARTER_QUALITY_INDEX_GAP"
        ),
        "decisionFlipsAt0_5": flip_report,
        "perGameBrierDirection": direction,
        "monthlyChronological": monthly(combined_rows, combined_p16, combined_p68, combined_y),
        "featureMissingness": feature_missingness(rows, feature_names),
    }

    report = {
        "schemaVersion": SCHEMA,
        "classification": "V68_HISTORICAL_REPLAY_COMPLETED_RETROSPECTIVE_CHARACTERIZATION_ONLY",
        "scientificInterpretation": "Historical outcomes helped select the V68 hypothesis in V66, so these results characterize behavior and stability but cannot independently confirm V68 or change its frozen prospective experiment.",
        "modelIdentity": {
            "v68ExactV66DiagnosticSnapshot": True,
            "v68SnapshotDigest": canonical_digest(v68_model),
            "v66DiagnosticSnapshotDigest": canonical_digest(v66_model),
            "v16CanonicalManifestDigest": canonical_digest(v16),
            "frozenV68FeatureCount": len(feature_names),
            "frozenV68Features": feature_names,
        },
        "historicalMetricParityToDisclosedV66Diagnostic": parity,
        "evaluationBySeason": season_results,
        "combinedEvaluation2024_2026Ytd": combined,
        "pairedDateClusterBootstrap2024_2026Ytd": bootstrap_dates(
            combined_rows, combined_p16, combined_p68, combined_y, spec
        ),
        "diagnostics2024_2026Ytd": diagnostics,
        "sample": {
            "rowsBySeason": {season: len(cache[season][0]) for season in CONTEXT},
            "combinedEvaluationRows": len(combined_rows),
            "combinedDistinctOfficialDates": len({str(r["officialDate"]) for r in combined_rows}),
        },
        "boundaries": {
            "2022OutcomePerformanceReported": False,
            "2023Role": "FROZEN_CALIBRATION_SEASON_CONTEXT_ONLY_AND_ADAPTIVE_SELECTION_EVIDENCE",
            "2024Through2026YtdRole": "RETROSPECTIVE_CHARACTERIZATION_ONLY",
            "prospectiveV68MayBeConfirmedByThisAudit": False,
            "prospectiveV68MayBeChangedByThisAudit": False,
            "productionPromotionAllowed": False,
            "positiveEvEstablished": False,
        },
        "policy": {
            "researchOnly": True,
            "historicalPricesUsed": False,
            "marketOddsUsedAsFeatures": False,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "featureSearchPerformed": False,
            "thresholdOptimizationPerformed": False,
            "productionV16Changed": False,
            "prospectiveV68Changed": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, report)
    print(json.dumps({
        "classification": report["classification"],
        "rows": report["sample"],
        "combinedDelta": combined["delta"],
        "bootstrap": report["pairedDateClusterBootstrap2024_2026Ytd"],
        "meanAbsoluteProbabilityShift": diagnostics["probabilityShift"]["meanAbsoluteShift"],
        "decisionFlips": diagnostics["decisionFlipsAt0_5"],
        "metricParityPassed": parity["passed"],
    }, indent=2))


if __name__ == "__main__":
    main()
