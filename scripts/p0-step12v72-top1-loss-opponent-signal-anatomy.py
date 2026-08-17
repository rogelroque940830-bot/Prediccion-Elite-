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
from scipy.stats import mannwhitneyu

SCHEMA = "courtedge-p0-step12v72-top1-loss-opponent-signal-anatomy.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v72-top1-loss-opponent-signal-anatomy-contract.v1"
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
    spec = importlib.util.spec_from_file_location("v69_frozen_parent_for_v72", path)
    if spec is None or spec.loader is None:
        raise SystemExit("V72_V69_IMPORT_FAILED")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_custody_map(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    out = {}
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            key = (str(r["season"]), int(r["gamePk"]))
            if key in out:
                raise SystemExit(f"V72_DUPLICATE_CUSTODY:{key}")
            out[key] = r
    if len(out) != 11407:
        raise SystemExit(f"V72_CUSTODY_TOTAL_DRIFT:{len(out)}")
    return out


def load_feature_map(root, seasons, expected_by):
    out = {}
    eligible_dates = set()
    for s in seasons:
        table = load(os.path.join(root, s, "game-anatomy-feature-table.json"))
        if table.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"V72_BASE_SCHEMA_DRIFT:{s}")
        rows = [r for r in table["rows"] if r.get("t5PregameValid") is True]
        if len(rows) != int(expected_by[s]):
            raise SystemExit(f"V72_BASE_ROW_DRIFT:{s}:{len(rows)}")
        for r in rows:
            key = (s, int(r["gamePk"]))
            if key in out:
                raise SystemExit(f"V72_DUPLICATE_BASE_GAME:{key}")
            out[key] = r
            eligible_dates.add(str(r["officialDate"]))
    return out, eligible_dates


def percentile(values, q):
    vals = np.asarray([float(v) for v in values if finite(v)], dtype=float)
    return float(np.quantile(vals, q)) if len(vals) else None


def iqr(values):
    vals = np.asarray(values, dtype=float)
    if not len(vals):
        return [None, None]
    return [float(np.quantile(vals, 0.25)), float(np.quantile(vals, 0.75))]


def cliffs_delta(losses, wins):
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return None
    greater = 0
    less = 0
    for x in a:
        greater += int(np.sum(x > b))
        less += int(np.sum(x < b))
    return float((greater - less) / (len(a) * len(b)))


def auc_loss_warning(losses, wins):
    # Probability that a random historical loss has a larger warning value than a random win,
    # with ties contributing one-half.
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return None
    greater = 0
    ties = 0
    for x in a:
        greater += int(np.sum(x > b))
        ties += int(np.sum(x == b))
    return float((greater + 0.5 * ties) / (len(a) * len(b)))


def holm_adjust(pvals):
    valid = [(k, float(v)) for k, v in pvals.items() if finite(v)]
    valid.sort(key=lambda kv: kv[1])
    m = len(valid)
    out = {k: None for k in pvals}
    running = 0.0
    for i, (k, p) in enumerate(valid):
        adj = min(1.0, (m - i) * p)
        running = max(running, adj)
        out[k] = running
    return out


def bootstrap_mean_difference(losses, wins, resamples, seed):
    a = np.asarray(losses, dtype=float)
    b = np.asarray(wins, dtype=float)
    if not len(a) or not len(b):
        return {"resamples": resamples, "seed": seed, "pointEstimateLossMinusWin": None, "ci95": [None, None]}
    rng = np.random.default_rng(seed)
    vals = np.empty(resamples, dtype=float)
    for i in range(resamples):
        aa = a[rng.integers(0, len(a), size=len(a))]
        bb = b[rng.integers(0, len(b), size=len(b))]
        vals[i] = float(aa.mean() - bb.mean())
    return {
        "unit": "OFFICIAL_DATE",
        "resamples": resamples,
        "seed": seed,
        "pointEstimateLossMinusWin": float(a.mean() - b.mean()),
        "ci95": [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))],
    }


def distribution(values):
    return {str(k): int(v) for k, v in sorted(Counter(values).items())}


def outcome_breakdown(rows):
    wins = [r for r in rows if r["y"] == 1]
    losses = [r for r in rows if r["y"] == 0]
    pushes = [r for r in rows if r["y"] is None]
    return {
        "pickDays": len(rows),
        "wins": len(wins),
        "losses": len(losses),
        "pushes": len(pushes),
        "decisiveRows": len(wins) + len(losses),
        "routesWins": dict(sorted(Counter(r["route"] for r in wins).items())),
        "routesLosses": dict(sorted(Counter(r["route"] for r in losses).items())),
        "selectedSidesWins": dict(sorted(Counter(r["side"] for r in wins).items())),
        "selectedSidesLosses": dict(sorted(Counter(r["side"] for r in losses).items())),
    }


def filter_window(rows, mmdd):
    return [r for r in rows if r["date"][5:] >= mmdd]


def enrich_top1(opps, feature_map, custody_map, directional, conviction):
    enriched = []
    for o in opps:
        key = (str(o["season"]), int(o["gamePk"]))
        if key not in feature_map or key not in custody_map:
            raise SystemExit(f"V72_SELECTED_GAME_SOURCE_MISSING:{key}")
        raw = feature_map[key]
        f = raw.get("features") or {}
        c = custody_map[key]
        mult = 1.0 if o["side"] == "HOME" else -1.0
        selected_support = {}
        opponent_warning = {}
        for name in directional:
            source = f if name in f else c
            value = source.get(name)
            if finite(value):
                support = mult * float(value)
                selected_support[name] = support
                opponent_warning[name] = -support
            else:
                selected_support[name] = None
                opponent_warning[name] = None
        conv = {
            "consensusScore": float(o["consensusScore"]) if finite(o.get("consensusScore")) else None,
            "p16Selected": float(o["p16Selected"]) if finite(o.get("p16Selected")) else None,
            "p68Selected": float(o["p68Selected"]) if finite(o.get("p68Selected")) else None,
            "p68MinusP16Selected": (
                float(o["p68Selected"]) - float(o["p16Selected"])
                if finite(o.get("p68Selected")) and finite(o.get("p16Selected")) else None
            ),
            "classifierScore": float(o["classifierScore"]) if finite(o.get("classifierScore")) else None,
            "routePriority": float(o["priority"]),
        }
        if set(conviction) != set(conv):
            raise SystemExit("V72_CONVICTION_SIGNAL_SET_DRIFT")
        enriched.append({
            **o,
            "selectedSideSupport": selected_support,
            "opponentWarning": opponent_warning,
            "modelConviction": conv,
        })
    return enriched


def signal_analysis(rows, signals, value_field, resamples, seed, apply_holm):
    decisive = [r for r in rows if r["y"] is not None]
    seasons = sorted({r["season"] for r in decisive})
    results = {}
    pvals = {}
    for idx, name in enumerate(signals):
        wins = [float(r[value_field][name]) for r in decisive if r["y"] == 1 and finite(r[value_field].get(name))]
        losses = [float(r[value_field][name]) for r in decisive if r["y"] == 0 and finite(r[value_field].get(name))]
        p = None
        if wins and losses:
            p = float(mannwhitneyu(losses, wins, alternative="two-sided", method="asymptotic").pvalue)
        pvals[name] = p
        seasonal = {}
        direction_all = True
        for s in seasons:
            sw = [float(r[value_field][name]) for r in decisive if r["season"] == s and r["y"] == 1 and finite(r[value_field].get(name))]
            sl = [float(r[value_field][name]) for r in decisive if r["season"] == s and r["y"] == 0 and finite(r[value_field].get(name))]
            mw = float(np.median(sw)) if sw else None
            ml = float(np.median(sl)) if sl else None
            matches = bool(sw and sl and ml > mw)
            direction_all = direction_all and matches
            seasonal[s] = {
                "nWins": len(sw), "nLosses": len(sl),
                "medianWins": mw, "medianLosses": ml,
                "lossGreaterThanWin": matches,
            }
        results[name] = {
            "n_nonmissing_wins": len(wins),
            "n_nonmissing_losses": len(losses),
            "missing_wins": sum(1 for r in decisive if r["y"] == 1 and not finite(r[value_field].get(name))),
            "missing_losses": sum(1 for r in decisive if r["y"] == 0 and not finite(r[value_field].get(name))),
            "median_wins": float(np.median(wins)) if wins else None,
            "median_losses": float(np.median(losses)) if losses else None,
            "iqr_wins": iqr(wins),
            "iqr_losses": iqr(losses),
            "mean_wins": float(np.mean(wins)) if wins else None,
            "mean_losses": float(np.mean(losses)) if losses else None,
            "mann_whitney_two_sided_p": p,
            "cliffs_delta_loss_minus_win": cliffs_delta(losses, wins),
            "loss_warning_univariate_auc": auc_loss_warning(losses, wins),
            "bootstrapMeanDifferenceLossMinusWin": bootstrap_mean_difference(losses, wins, resamples, seed + idx),
            "seasonal_direction_check": {
                "lossGreaterThanWinInAllSeasons": direction_all,
                "bySeason": seasonal,
            },
        }
    adjusted = holm_adjust(pvals) if apply_holm else {k: None for k in signals}
    for name in signals:
        results[name]["holm_adjusted_p_across_directional_signal_family"] = adjusted[name]
    return results


def composite_diagnostics(rows, directional):
    decisive = [r for r in rows if r["y"] is not None]
    all_support = {name: [r["selectedSideSupport"][name] for r in decisive if finite(r["selectedSideSupport"].get(name))] for name in directional}
    q25 = {name: percentile(vals, 0.25) for name, vals in all_support.items()}
    detailed = []
    for r in decisive:
        warning_count = sum(1 for name in directional if finite(r["opponentWarning"].get(name)) and float(r["opponentWarning"][name]) > 0)
        strong_count = sum(1 for name in directional if finite(r["selectedSideSupport"].get(name)) and finite(q25[name]) and float(r["selectedSideSupport"][name]) <= float(q25[name]))
        detailed.append((r["y"], warning_count, strong_count))

    def summarize_count(index):
        vals = [x[index] for x in detailed]
        by = {}
        for count in sorted(set(vals)):
            z = [x for x in detailed if x[index] == count]
            losses = sum(x[0] == 0 for x in z)
            wins = sum(x[0] == 1 for x in z)
            by[str(count)] = {
                "rows": len(z), "wins": wins, "losses": losses,
                "historicalLossRate": losses / len(z) if z else None,
            }
        return {
            "allDecisiveDistribution": distribution(vals),
            "winsDistribution": distribution([x[index] for x in detailed if x[0] == 1]),
            "lossesDistribution": distribution([x[index] for x in detailed if x[0] == 0]),
            "byObservedCount": by,
        }

    return {
        "selectedSideSupportQ25Thresholds": q25,
        "opponentWarningSignalCount": summarize_count(1),
        "strongOpponentWarningCount": summarize_count(2),
    }


def evaluate_window(rows, contract, window_id, mmdd, expected, seed_offset):
    w = filter_window(rows, mmdd)
    b = outcome_breakdown(w)
    parity = {
        "eligibleSlateDays": int(expected["expectedEligibleSlateDays"]),
        "pickDays": b["pickDays"],
        "wins": b["wins"],
        "losses": b["losses"],
        "pushes": b["pushes"],
        "decisiveRows": b["decisiveRows"],
    }
    expected_parity = {
        "eligibleSlateDays": int(expected["expectedEligibleSlateDays"]),
        "pickDays": int(expected["expectedTop1PickDays"]),
        "wins": int(expected["expectedWins"]),
        "losses": int(expected["expectedLosses"]),
        "pushes": int(expected["expectedPushes"]),
        "decisiveRows": int(expected["expectedDecisiveRows"]),
    }
    if parity != expected_parity:
        raise SystemExit(f"V72_WINDOW_PARENT_PARITY_FAILED:{window_id}:{parity}:{expected_parity}")

    sp = contract["statisticalPlan"]
    directional = contract["directionalOpponentWarningSignalsExactly"]
    conviction = contract["modelConvictionSignalsExactly"]
    directional_results = signal_analysis(
        w, directional, "opponentWarning",
        int(sp["bootstrap"]["resamples"]), int(sp["bootstrap"]["seed"]) + seed_offset,
        True,
    )
    conviction_results = signal_analysis(
        w, conviction, "modelConviction",
        int(sp["bootstrap"]["resamples"]), int(sp["bootstrap"]["seed"]) + 100 + seed_offset,
        False,
    )

    label = sp["predeclaredRobustHistoricalWarningLabel"]
    robust = []
    for name, r in directional_results.items():
        if (
            finite(r["holm_adjusted_p_across_directional_signal_family"])
            and r["holm_adjusted_p_across_directional_signal_family"] < float(label["holmAdjustedPLt"])
            and finite(r["cliffs_delta_loss_minus_win"])
            and abs(r["cliffs_delta_loss_minus_win"]) >= float(label["minimumAbsoluteCliffsDelta"])
            and finite(r["loss_warning_univariate_auc"])
            and r["loss_warning_univariate_auc"] >= float(label["minimumLossWarningAuc"])
            and r["median_losses"] is not None and r["median_wins"] is not None
            and r["median_losses"] > r["median_wins"]
            and r["seasonal_direction_check"]["lossGreaterThanWinInAllSeasons"] is True
        ):
            robust.append(name)

    ranked = sorted(
        directional,
        key=lambda name: (
            directional_results[name]["holm_adjusted_p_across_directional_signal_family"] if finite(directional_results[name]["holm_adjusted_p_across_directional_signal_family"]) else 2.0,
            -(directional_results[name]["loss_warning_univariate_auc"] if finite(directional_results[name]["loss_warning_univariate_auc"]) else -1.0),
            name,
        ),
    )

    return {
        "windowId": window_id,
        "officialDateRule": expected["officialDateRule"],
        "parentParity": parity,
        "outcomeBreakdown": b,
        "directionalOpponentWarningSignalAnalysis": directional_results,
        "modelConvictionExploratoryAnalysis": conviction_results,
        "predeclaredRobustHistoricalWarningSignals": robust,
        "directionalSignalRankingByHolmThenAuc": ranked,
        "compositeDiagnostics": composite_diagnostics(w, directional),
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
    ap.add_argument("--v71-summary", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_TOP1_LOSS_OPPONENT_SIGNAL_ANATOMY_BEFORE_ANY_V72_SCORER_EXISTS":
        raise SystemExit("V72_CONTRACT_INVALID")
    for k in ("refitAllowed", "recalibrationAllowed", "featureAdditionAfterOutcomeInspectionAllowed", "featureRemovalAfterOutcomeInspectionAllowed", "thresholdSearchAllowed", "routeSearchAllowed", "dateCutoffSearchAllowed", "lossSubsetMiningForPromotionAllowed", "newLiveVetoMayBeCreatedByV72"):
        if c["statisticsBoundary"].get(k) is not False:
            raise SystemExit(f"V72_SEARCH_BOUNDARY_INVALID:{k}")

    if git_blob_sha(a.v69_contract) != c["immutableParentEvidence"]["v69Contract"]["gitBlobSha"]:
        raise SystemExit("V72_V69_CONTRACT_BLOB_DRIFT")
    if git_blob_sha(a.v69_scorer) != c["immutableParentEvidence"]["v69Scorer"]["gitBlobSha"]:
        raise SystemExit("V72_V69_SCORER_BLOB_DRIFT")

    v71 = load(a.v71_summary)
    ev71 = c["immutableParentEvidence"]["v71ResultSummary"]
    if v71.get("classification") != ev71["requiredClassification"]:
        raise SystemExit("V72_V71_SUMMARY_CLASSIFICATION_DRIFT")
    src = v71.get("sourceArtifact") or {}
    if int(src.get("workflowRunId", -1)) != int(ev71["sourceWorkflowRunId"]) or int(src.get("artifactId", -1)) != int(ev71["sourceArtifactId"]) or src.get("artifactDigest") != ev71["sourceArtifactDigest"]:
        raise SystemExit("V72_V71_SOURCE_CUSTODY_DRIFT")

    v69c = load(a.v69_contract)
    seasons = tuple(c["evaluationWindows"]["seasonSetExactly"])
    expected_by = v69c["evaluationUniverse"]["expectedCanonicalRowsBySeason"]
    feature_map, eligible_dates = load_feature_map(a.root, seasons, expected_by)
    if len(eligible_dates) != int(v69c["evaluationUniverse"]["expectedEligibleSlateDays"]):
        raise SystemExit("V72_ELIGIBLE_DATE_COUNT_DRIFT")
    custody_map = load_custody_map(a.custody)

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
            raise SystemExit("V72_V69_ELIGIBLE_DATE_SET_DRIFT_DURING_REPLAY")
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
        raise SystemExit(f"V72_V69_DAILY_CAP_CALL_SHAPE_DRIFT:{len(captured_calls)}:{expected_calls}")
    # Frozen V69 call order per threshold: general top1, general top2, reinforced top1,
    # reinforced top2, confluence top1, confluence top2, confluence-reinforced top1,
    # confluence-reinforced top2. Threshold grid begins at 0.55.
    top1 = captured_calls[4]["opps"]
    if captured_calls[4]["cap"] != 1:
        raise SystemExit("V72_PARENT_TOP1_CAP_DRIFT")
    parity = {
        "opportunities": len(top1),
        "decisiveRows": sum(o["y"] is not None for o in top1),
        "wins": sum(o["y"] == 1 for o in top1),
        "losses": sum(o["y"] == 0 for o in top1),
        "pushes": sum(o["y"] is None for o in top1),
    }
    if parity != {"opportunities": 492, "decisiveRows": 488, "wins": 311, "losses": 177, "pushes": 4}:
        raise SystemExit(f"V72_FULL_PARENT_PARITY_FAILED:{parity}")

    enriched = enrich_top1(
        top1,
        feature_map,
        custody_map,
        c["directionalOpponentWarningSignalsExactly"],
        c["modelConvictionSignalsExactly"],
    )

    primary = evaluate_window(enriched, c, "MAY01", "05-01", c["evaluationWindows"]["primary"], 0)
    sensitivity = evaluate_window(enriched, c, "MAY15", "05-15", c["evaluationWindows"]["sensitivity"], 1000)

    report = {
        "schemaVersion": SCHEMA,
        "classification": "V72_TOP1_LOSS_OPPONENT_SIGNAL_ANATOMY_RETROSPECTIVE_COMPLETE",
        "scientificInterpretation": "V72 isolates strictly pregame signals that historically leaned toward the eventual opponent when the frozen V69 TOP1 selection lost. It is descriptive loss anatomy only and cannot create a live veto or modify any frozen route.",
        "fullSeasonTop1Parity": parity,
        "primaryMay01": primary,
        "sensitivityMay15": sensitivity,
        "guardrails": {
            "strictlyPregameSignalsOnly": True,
            "outcomesUsedOnlyAsPostHocLabels": True,
            "newSignalAddedAfterInspection": False,
            "newThresholdSearched": False,
            "newRouteSearched": False,
            "historicalPricesUsed": False,
            "liveVetoCreated": False,
            "prospectiveV68Changed": False,
            "productionChanged": False,
            "positiveEvEstablished": False,
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
        "fullSeasonTop1Parity": parity,
        "may01": {
            "wins": primary["parentParity"]["wins"],
            "losses": primary["parentParity"]["losses"],
            "robustWarnings": primary["predeclaredRobustHistoricalWarningSignals"],
        },
        "may15": {
            "wins": sensitivity["parentParity"]["wins"],
            "losses": sensitivity["parentParity"]["losses"],
            "robustWarnings": sensitivity["predeclaredRobustHistoricalWarningSignals"],
        },
    }, indent=2))


if __name__ == "__main__":
    main()
