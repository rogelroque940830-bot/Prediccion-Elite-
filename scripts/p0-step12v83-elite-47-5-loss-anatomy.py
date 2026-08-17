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
from collections import defaultdict

import numpy as np
from scipy.stats import mannwhitneyu

SCHEMA = "courtedge-p0-step12v83-elite-47-5-loss-anatomy.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v83-elite-47-5-loss-anatomy-contract.v1"
CONTRACT_STATUS = "FROZEN_47_5_LOSS_ANATOMY_PLAN_BEFORE_ANY_V83_SCORER_EXISTS"
SEASONS = ("2024", "2025", "2026_YTD")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def finite(x):
    try:
        return x is not None and math.isfinite(float(x))
    except Exception:
        return False


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V83_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cliffs_delta(losses, wins):
    if not losses or not wins:
        return None
    greater = 0
    less = 0
    for x in losses:
        greater += sum(x > y for y in wins)
        less += sum(x < y for y in wins)
    return (greater - less) / (len(losses) * len(wins))


def loss_auc(losses, wins):
    if not losses or not wins:
        return None
    greater = 0
    ties = 0
    for x in losses:
        greater += sum(x > y for y in wins)
        ties += sum(x == y for y in wins)
    return (greater + 0.5 * ties) / (len(losses) * len(wins))


def holm_adjust(pairs):
    valid = sorted((k, float(v)) for k, v in pairs.items() if finite(v))
    valid.sort(key=lambda kv: kv[1])
    m = len(valid)
    out = {k: None for k in pairs}
    running = 0.0
    for i, (k, p) in enumerate(valid):
        adj = min(1.0, (m - i) * p)
        running = max(running, adj)
        out[k] = running
    return out


def continuous_analysis(rows, key, qlo, qhi):
    wins = [float(r["signals"][key]) for r in rows if r["y"] == 1 and finite(r["signals"].get(key))]
    losses = [float(r["signals"][key]) for r in rows if r["y"] == 0 and finite(r["signals"].get(key))]
    if not wins or not losses:
        return {
            "nWins": len(wins), "nLosses": len(losses), "medianWins": None, "medianLosses": None,
            "meanWins": None, "meanLosses": None, "mannWhitneyTwoSidedP": None,
            "holmAdjustedPWithinPredeclaredContinuousSignals": None,
            "cliffsDeltaLossMinusWin": None, "lossWarningAucRaw": None,
            "lossWarningAucBestOrientation": None, "lossWarningOrientation": None,
            "winReferenceTail": None,
        }
    p = float(mannwhitneyu(losses, wins, alternative="two-sided", method="asymptotic").pvalue)
    auc = float(loss_auc(losses, wins))
    lo = float(np.quantile(np.asarray(wins, dtype=float), qlo))
    hi = float(np.quantile(np.asarray(wins, dtype=float), qhi))
    low_l = sum(x <= lo for x in losses)
    high_l = sum(x >= hi for x in losses)
    low_w = sum(x <= lo for x in wins)
    high_w = sum(x >= hi for x in wins)
    return {
        "nWins": len(wins),
        "nLosses": len(losses),
        "medianWins": float(np.median(wins)),
        "medianLosses": float(np.median(losses)),
        "meanWins": float(np.mean(wins)),
        "meanLosses": float(np.mean(losses)),
        "mannWhitneyTwoSidedP": p,
        "holmAdjustedPWithinPredeclaredContinuousSignals": None,
        "cliffsDeltaLossMinusWin": float(cliffs_delta(losses, wins)),
        "lossWarningAucRaw": auc,
        "lossWarningAucBestOrientation": max(auc, 1.0 - auc),
        "lossWarningOrientation": "HIGH_IS_LOSS" if auc >= 0.5 else "LOW_IS_LOSS",
        "winReferenceTail": {
            "lowerQuantile": qlo,
            "upperQuantile": qhi,
            "lowerThresholdFromWinsOnly": lo,
            "upperThresholdFromWinsOnly": hi,
            "lossesAtOrBelowLower": low_l,
            "lossesAtOrAboveUpper": high_l,
            "winsAtOrBelowLower": low_w,
            "winsAtOrAboveUpper": high_w,
        },
    }


def categorical_analysis(rows, key):
    values = sorted({str(r["categorical"].get(key)) for r in rows})
    out = {}
    for value in values:
        z = [r for r in rows if str(r["categorical"].get(key)) == value]
        out[value] = {
            "rows": len(z),
            "wins": sum(r["y"] == 1 for r in z),
            "losses": sum(r["y"] == 0 for r in z),
            "lossCapture": sum(r["y"] == 0 for r in z) / 5.0,
            "winSacrifice": sum(r["y"] == 1 for r in z) / 47.0,
        }
    return out


def get_team_name(raw, side):
    candidates = [
        f"{side}TeamName",
        f"{side}Name",
        f"{side}Team",
    ]
    for key in candidates:
        v = raw.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, dict):
            for nk in ("name", "teamName", "clubName"):
                nv = v.get(nk)
                if isinstance(nv, str) and nv.strip():
                    return nv.strip()
    return None


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
    ap.add_argument("--v79-contract", required=True)
    ap.add_argument("--v79-scorer", required=True)
    ap.add_argument("--v82-contract", required=True)
    ap.add_argument("--v82-scorer", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != CONTRACT_STATUS:
        raise SystemExit("V83_CONTRACT_INVALID")
    for key in (
        "refitAllowed", "recalibrationAllowed", "newFeatureSearchAllowed",
        "newRawSignalAdditionAfterOutcomeInspectionAllowed", "newThresholdSearchAllowed",
        "multiSignalCombinationSearchAllowed", "decisionTreeSearchAllowed", "interactionSearchAllowed",
        "postOutcomeRuleOptimizationAllowed", "claimIndependentConfirmationAllowed", "claimCausationAllowed",
        "promoteRetrospectiveWarningToVetoAllowed",
    ):
        if c["statisticsBoundary"].get(key) is not False:
            raise SystemExit(f"V83_BOUNDARY_INVALID:{key}")

    direct = {
        "v82Contract": a.v82_contract,
        "v82Scorer": a.v82_scorer,
        "v79Scorer": a.v79_scorer,
        "v69Scorer": a.v69_scorer,
        "frozenClassifier": a.classifier_source,
    }
    blob_checks = {}
    for key, path in direct.items():
        expected = c["immutableParents"][key]["gitBlobSha"]
        got = git_blob_sha(path)
        blob_checks[key] = {"expected": expected, "actual": got, "match": expected == got}
        if expected != got:
            raise SystemExit(f"V83_PARENT_BLOB_DRIFT:{key}:{got}:{expected}")

    c82 = load(a.v82_contract)
    inherited = {
        "v69Contract": a.v69_contract,
        "v68Contract": a.v68_contract,
        "v79Contract": a.v79_contract,
        "frozenRouter": a.router_source,
    }
    inherited_checks = {}
    for key, path in inherited.items():
        expected = c82["immutableParents"][key]["gitBlobSha"]
        got = git_blob_sha(path)
        inherited_checks[key] = {"expected": expected, "actual": got, "match": expected == got}
        if expected != got:
            raise SystemExit(f"V83_INHERITED_PARENT_BLOB_DRIFT:{key}:{got}:{expected}")

    v69 = module(a.v69_scorer, "v83_v69")
    v79 = module(a.v79_scorer, "v83_v79")
    c69 = load(a.v69_contract)
    c79 = load(a.v79_contract)
    classifier_version, premium_rules, models = v69.parse_frozen_classifier_source(a.classifier_source)
    if classifier_version != c["immutableParents"]["frozenClassifier"]["requiredVersion"]:
        raise SystemExit("V83_CLASSIFIER_VERSION_DRIFT")

    # Recreate the exact pure General TOP1 parent used by V82.
    original_daily_cap = v69.daily_cap
    calls = []
    def capture(candidates, dates, cap):
        result = original_daily_cap(candidates, dates, cap)
        calls.append({"cap": int(cap), "opps": [dict(x) for x in result]})
        return result
    v69.daily_cap = capture
    parent_out = a.out + ".v69-parent.json"
    old = sys.argv[:]
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
            v69.main()
    finally:
        sys.argv = old
        v69.daily_cap = original_daily_cap
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass

    grid = [float(x) for x in c69["predeclaredConsensusScoreGrid"]]
    if len(calls) != len(grid) * 8 or calls[0]["cap"] != 1:
        raise SystemExit(f"V83_V69_CAPTURE_DRIFT:{len(calls)}")
    pure0 = [
        r for r in calls[0]["opps"]
        if r["date"][5:] >= c["targetCohortExactly"]["officialDateMonthDayMinimum"]
        and r.get("y") in (0, 1)
    ]

    raw_map = {}
    for s in SEASONS:
        table = load(os.path.join(a.root, s, "game-anatomy-feature-table.json"))
        for raw in table["rows"]:
            if raw.get("t5PregameValid") is True:
                raw_map[(s, int(raw["gamePk"]))] = raw
    custody_map = v69.load_custody(a.custody)

    target_dates = {s: {r["date"] for r in pure0 if r["season"] == s} for s in SEASONS}
    minimum_games = int(c79["pregameStrengthDefinition"]["minimumPriorGamesPerTeam"])
    snapshots, strength_diag = v79.build_strength_snapshots(a.root, SEASONS, target_dates, minimum_games)
    strength_rows = v79.add_strength_context(pure0, raw_map, snapshots)

    raw_feature_names = list(c["pregameSignalsExactly"]["rawFrozenClassifierFeatures"])
    continuous_names = []
    for group in ("modelConviction", "dynamicStrength", "frozenClassifierProbabilities", "premiumMargins", "rawFrozenClassifierFeatures", "custodySignals"):
        continuous_names.extend(c["pregameSignalsExactly"][group])
    if len(continuous_names) != len(set(continuous_names)):
        raise SystemExit("V83_DUPLICATE_CONTINUOUS_SIGNAL_NAME")

    enriched = []
    for r in strength_rows:
        raw = raw_map[(r["season"], int(r["gamePk"]))]
        f = raw.get("features") or {}
        cls = v69.classify(f, premium_rules, models)
        if r["side"] != "HOME" or r["tierRelation"] != "SELECTED_STRONGER" or not cls["aPlus"]:
            continue
        custody = custody_map[(r["season"], int(r["gamePk"]))]
        a_c4 = float(cls["aPlusC4PHome"])
        a_f13 = float(cls["aPlusFull13PHome"])
        f5_c4 = float(cls["f5C4PHome"])
        f5_f13 = float(cls["f5Full13PHome"])
        margins = {
            "team_win10_diff_margin_vs_frozen_premium_threshold": float(f["team_win10_diff"]) - float(premium_rules["team_win10_diff"]),
            "starter_kbb_adv_margin_vs_frozen_premium_threshold": float(f["starter_kbb_adv"]) - float(premium_rules["starter_kbb_adv"]),
            "lineup_exposure_rate_adv_margin_vs_frozen_premium_threshold": float(f["lineup_exposure_rate_adv"]) - float(premium_rules["lineup_exposure_rate_adv"]),
        }
        signals = {
            "consensusScore": r.get("consensusScore"),
            "p16Selected": r.get("p16Selected"),
            "p68Selected": r.get("p68Selected"),
            "classifierScore": r.get("classifierScore"),
            "selectedStrengthScore": r["selectedStrength"]["strengthScore"],
            "opponentStrengthScore": r["opponentStrength"]["strengthScore"],
            "strengthGap": r["strengthGap"],
            "selectedWinPct": r["selectedStrength"]["winPct"],
            "opponentWinPct": r["opponentStrength"]["winPct"],
            "selectedRunDifferentialPerGame": r["selectedStrength"]["runDifferentialPerGame"],
            "opponentRunDifferentialPerGame": r["opponentStrength"]["runDifferentialPerGame"],
            "aPlusC4PHome": a_c4,
            "aPlusFull13PHome": a_f13,
            "aPlusMinHome": min(a_c4, a_f13),
            "aPlusProbabilityDisagreementAbs": abs(a_c4 - a_f13),
            "f5C4PHome": f5_c4,
            "f5Full13PHome": f5_f13,
            "f5MinHome": min(f5_c4, f5_f13),
            **margins,
            "minimumPremiumMargin": min(margins.values()),
            **{name: f.get(name) for name in raw_feature_names},
            "bullpen_pitches_1d_adv": custody.get("bullpen_pitches_1d_adv"),
            "fg_exposure_adv": custody.get("fg_exposure_adv"),
        }
        missing_declared = set(continuous_names) - set(signals)
        if missing_declared:
            raise SystemExit(f"V83_DECLARED_SIGNAL_NOT_MATERIALIZED:{sorted(missing_declared)}")
        categorical = {
            "f5Consensus": bool(cls["f5Consensus"]),
            "recordTierRelation": r["recordTierRelation"],
            "selectedPrimaryTier": r["selectedStrength"]["primaryTier"],
            "opponentPrimaryTier": r["opponentStrength"]["primaryTier"],
            "selectedRecordTier": r["selectedStrength"]["recordTier"],
            "opponentRecordTier": r["opponentStrength"]["recordTier"],
        }
        enriched.append({
            "season": r["season"],
            "date": r["date"],
            "gamePk": int(r["gamePk"]),
            "side": r["side"],
            "y": int(r["y"]),
            "homeTeamId": int(raw["homeTeamId"]),
            "awayTeamId": int(raw["awayTeamId"]),
            "homeTeamName": get_team_name(raw, "home"),
            "awayTeamName": get_team_name(raw, "away"),
            "selectedTeamId": int(r["selectedTeamId"]),
            "opponentTeamId": int(r["opponentTeamId"]),
            "signals": signals,
            "categorical": categorical,
        })

    expected = c["targetCohortExactly"]
    parity = {
        "decisiveRows": len(enriched),
        "wins": sum(r["y"] == 1 for r in enriched),
        "losses": sum(r["y"] == 0 for r in enriched),
    }
    expected_parity = {
        "decisiveRows": int(expected["expectedDecisiveRows"]),
        "wins": int(expected["expectedWins"]),
        "losses": int(expected["expectedLosses"]),
    }
    if parity != expected_parity:
        raise SystemExit(f"V83_TARGET_PARITY_FAILED:{parity}:{expected_parity}")

    qlo = float(c["predeclaredDiagnostics"]["winReferenceTailDiagnostic"]["lowerQuantile"])
    qhi = float(c["predeclaredDiagnostics"]["winReferenceTailDiagnostic"]["upperQuantile"])
    continuous = {name: continuous_analysis(enriched, name, qlo, qhi) for name in continuous_names}
    adj = holm_adjust({k: v["mannWhitneyTwoSidedP"] for k, v in continuous.items()})
    for key in continuous:
        continuous[key]["holmAdjustedPWithinPredeclaredContinuousSignals"] = adj[key]

    categorical_names = list(c["pregameSignalsExactly"]["preExistingCategoricalFlags"])
    categorical = {key: categorical_analysis(enriched, key) for key in categorical_names}

    candidates = []
    for key, st in continuous.items():
        tail = st.get("winReferenceTail")
        if not tail:
            continue
        for direction, lc, wc, threshold in (
            ("AT_OR_BELOW_WIN_P10", tail["lossesAtOrBelowLower"], tail["winsAtOrBelowLower"], tail["lowerThresholdFromWinsOnly"]),
            ("AT_OR_ABOVE_WIN_P90", tail["lossesAtOrAboveUpper"], tail["winsAtOrAboveUpper"], tail["upperThresholdFromWinsOnly"]),
        ):
            if lc >= 4:
                remaining_w = 47 - wc
                remaining_l = 5 - lc
                candidates.append({
                    "kind": "CONTINUOUS_WIN_REFERENCE_TAIL",
                    "signal": key,
                    "state": direction,
                    "threshold": threshold,
                    "lossesCaptured": lc,
                    "winsSacrificed": wc,
                    "winSacrificePct": wc / 47.0,
                    "remainingHistoricalHitRateAfterDescriptiveVeto": remaining_w / (remaining_w + remaining_l) if remaining_w + remaining_l else None,
                    "deployable": False,
                })
    for key, states in categorical.items():
        for state, st in states.items():
            if st["losses"] >= 4 and st["winSacrifice"] <= 0.20:
                remaining_w = 47 - st["wins"]
                remaining_l = 5 - st["losses"]
                candidates.append({
                    "kind": "PRE_EXISTING_CATEGORICAL_STATE",
                    "signal": key,
                    "state": state,
                    "threshold": None,
                    "lossesCaptured": st["losses"],
                    "winsSacrificed": st["wins"],
                    "winSacrificePct": st["winSacrifice"],
                    "remainingHistoricalHitRateAfterDescriptiveVeto": remaining_w / (remaining_w + remaining_l) if remaining_w + remaining_l else None,
                    "deployable": False,
                })
    candidates.sort(key=lambda x: (-x["lossesCaptured"], x["winsSacrificed"], -(x["remainingHistoricalHitRateAfterDescriptiveVeto"] or -1), x["signal"], str(x["state"])))

    # Annotate each of the five losses against fixed win-reference tails.
    losses = []
    for r in sorted((x for x in enriched if x["y"] == 0), key=lambda x: (x["date"], x["gamePk"])):
        extremes = []
        for key, st in continuous.items():
            tail = st.get("winReferenceTail")
            v = r["signals"].get(key)
            if not tail or not finite(v):
                continue
            fv = float(v)
            if fv <= tail["lowerThresholdFromWinsOnly"]:
                extremes.append({"signal": key, "tail": "AT_OR_BELOW_WIN_P10", "value": fv, "threshold": tail["lowerThresholdFromWinsOnly"]})
            if fv >= tail["upperThresholdFromWinsOnly"]:
                extremes.append({"signal": key, "tail": "AT_OR_ABOVE_WIN_P90", "value": fv, "threshold": tail["upperThresholdFromWinsOnly"]})
        loss_row = dict(r)
        loss_row["extremeWinReferenceTails"] = extremes
        losses.append(loss_row)

    season = {}
    for s in SEASONS:
        z = [r for r in enriched if r["season"] == s]
        season[s] = {
            "rows": len(z),
            "wins": sum(r["y"] == 1 for r in z),
            "losses": sum(r["y"] == 0 for r in z),
            "hitRate": sum(r["y"] == 1 for r in z) / len(z) if z else None,
        }

    result = {
        "schemaVersion": SCHEMA,
        "classification": "V83_ELITE_47_5_LOSS_ANATOMY_RETROSPECTIVE_COMPLETE",
        "contractStatus": c["scientificStatus"],
        "targetParity": parity,
        "bySeason": season,
        "lossCases": losses,
        "continuousSignalAnalysis": continuous,
        "categoricalSignalAnalysis": categorical,
        "simpleWarningCandidates": candidates,
        "headline": {
            "simpleSingleSignalCandidateCount": len(candidates),
            "bestSingleSignalDescriptiveCandidate": candidates[0] if candidates else None,
            "interpretation": "RETROSPECTIVE_SIMPLE_WARNING_CANDIDATE_EXISTS_BUT_NOT_DEPLOYABLE" if candidates else "NO_PREDECLARED_SIMPLE_SINGLE_SIGNAL_CAUGHT_AT_LEAST_4_OF_5_LOSSES",
        },
        "diagnostics": {
            "pureGeneralRowsBeforeEliteFilter": len(pure0),
            "targetRows": len(enriched),
            "lossRowsListed": len(losses),
            "continuousSignalsTested": len(continuous_names),
            "categoricalSignalsTested": len(categorical_names),
            "strength": strength_diag,
        },
        "parentBlobChecks": blob_checks,
        "inheritedParentBlobChecks": inherited_checks,
        "integrity": {
            "targetWasKnownBeforeV83": True,
            "retrospectiveOnly": True,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "newFeatureSearchPerformed": False,
            "newThresholdSearchPerformed": False,
            "multiSignalCombinationSearchPerformed": False,
            "decisionTreeSearchPerformed": False,
            "interactionSearchPerformed": False,
            "warningPromotedToVeto": False,
            "v80Changed": False,
            "productionChanged": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.out, result)

    print(json.dumps({
        "classification": result["classification"],
        "targetParity": result["targetParity"],
        "bySeason": result["bySeason"],
        "headline": result["headline"],
        "lossCases": [
            {
                "season": r["season"], "date": r["date"], "gamePk": r["gamePk"],
                "selectedTeamId": r["selectedTeamId"], "opponentTeamId": r["opponentTeamId"],
                "extremeWinReferenceTails": r["extremeWinReferenceTails"],
                "categorical": r["categorical"],
            }
            for r in losses
        ],
        "topContinuousByLossAuc": sorted(
            [
                {"signal": k, **v}
                for k, v in continuous.items()
                if v.get("lossWarningAucBestOrientation") is not None
            ],
            key=lambda x: (-x["lossWarningAucBestOrientation"], x["signal"]),
        )[:12],
        "simpleWarningCandidates": candidates[:12],
    }, indent=2))


if __name__ == "__main__":
    main()
