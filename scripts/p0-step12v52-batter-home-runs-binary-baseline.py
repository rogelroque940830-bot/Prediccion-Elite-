#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-p0-step12v52-batter-home-runs-binary-baseline.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v52-batter-home-runs-binary-baseline-contract.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
BATTER_SCHEMA = "courtedge-mlb-historical-batter-history.v1"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except Exception:
        return False


def positive_int(value):
    try:
        value = int(value)
        return value if value > 0 else None
    except Exception:
        return None


def audit_valid(audit):
    return bool(audit and audit.get("identityOk") and audit.get("sourceHistorical") and audit.get("pregame") and audit.get("probableBothKnown"))


def probable_ids(audit):
    if not audit_valid(audit):
        return None, None
    home = positive_int(audit.get("homeProbablePitcherId"))
    away = positive_int(audit.get("awayProbablePitcherId"))
    return (home, away) if home and away else (None, None)


def complete_lineup(lineup, audit):
    if not audit_valid(audit) or not lineup or not lineup.get("complete"):
        return None, None
    try:
        home = [int(v) for v in lineup.get("homeBattingOrder", [])]
        away = [int(v) for v in lineup.get("awayBattingOrder", [])]
    except Exception:
        return None, None
    if len(home) != 9 or len(away) != 9 or len(set(home)) != 9 or len(set(away)) != 9 or min(home + away) <= 0:
        return None, None
    return home, away


def parse_starter(raw):
    if not raw:
        return None
    pitcher_id = positive_int(raw.get("pitcherId"))
    if pitcher_id is None:
        return None
    mapping = {"bf": "battersFaced", "hr": "homeRuns", "k": "strikeOuts", "bb": "baseOnBalls"}
    out = {"pitcherId": pitcher_id}
    for key, source in mapping.items():
        value = raw.get(source, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f"V52_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}")
        out[key] = float(value)
    return out


def empty_batter_state():
    return {"games": 0, "pa": 0.0, "hr": 0.0, "h": 0.0, "bb": 0.0, "k": 0.0, "recent": []}


def empty_pitcher_state():
    return {"starts": 0, "bf": 0.0, "hr": 0.0, "k": 0.0, "bb": 0.0}


def empty_slot_state():
    return {"starts": 0, "pa": 0.0}


def add_batter_line(state, line, recent_window):
    pa = int(line.get("plateAppearances", 0))
    if pa <= 0:
        return
    hr = int(line["homeRuns"])
    h = int(line["hits"])
    bb = int(line["baseOnBalls"])
    k = int(line["strikeOuts"])
    state["games"] += 1
    state["pa"] += pa
    state["hr"] += hr
    state["h"] += h
    state["bb"] += bb
    state["k"] += k
    state["recent"].append({"hr": hr, "pa": pa})
    if len(state["recent"]) > recent_window:
        state["recent"] = state["recent"][-recent_window:]


def add_pitcher_line(state, line):
    if line is None or line["bf"] <= 0:
        return
    state["starts"] += 1
    for key in ("bf", "hr", "k", "bb"):
        state[key] += line[key]


def batter_prior(state):
    if state["pa"] <= 0:
        return None
    return {"hrpa": state["hr"] / state["pa"], "hpa": state["h"] / state["pa"], "bbpa": state["bb"] / state["pa"], "kpa": state["k"] / state["pa"]}


def pitcher_prior(state):
    if state["bf"] <= 0 or state["starts"] <= 0:
        return None
    return {"hrbf": state["hr"] / state["bf"], "kbf": state["k"] / state["bf"], "bbbf": state["bb"] / state["bf"], "bfPerStart": state["bf"] / state["starts"]}


def shrunk_rate(num, den, prior, weight):
    return (float(num) + float(weight) * float(prior)) / (float(den) + float(weight))


def shrunk_mean(total, trials, prior, weight):
    return (float(total) + float(weight) * float(prior)) / (float(trials) + float(weight))


def batter_features(state, league, prior_pa):
    recent = state["recent"]
    out = {
        "batter_recent10_hr_per_game": float(np.mean([r["hr"] for r in recent])) if recent else None,
        "batter_recent10_pa_per_game": float(np.mean([r["pa"] for r in recent])) if recent else None,
    }
    if league is None:
        out.update({"batter_hrpa_shrunk": None, "batter_hpa_shrunk": None, "batter_bbpa_shrunk": None, "batter_kpa_shrunk": None})
        return out
    out.update({
        "batter_hrpa_shrunk": shrunk_rate(state["hr"], state["pa"], league["hrpa"], prior_pa),
        "batter_hpa_shrunk": shrunk_rate(state["h"], state["pa"], league["hpa"], prior_pa),
        "batter_bbpa_shrunk": shrunk_rate(state["bb"], state["pa"], league["bbpa"], prior_pa),
        "batter_kpa_shrunk": shrunk_rate(state["k"], state["pa"], league["kpa"], prior_pa),
    })
    return out


def lineup_slot_pa(slot, global_slot, prior_starts):
    if global_slot["starts"] <= 0:
        return None
    league = global_slot["pa"] / global_slot["starts"]
    return shrunk_mean(slot["pa"], slot["starts"], league, prior_starts)


def starter_features(state, league, prior_bf, prior_starts):
    if league is None:
        return {"opposing_starter_hrbf_shrunk": None, "opposing_starter_kbf_shrunk": None, "opposing_starter_bbbf_shrunk": None, "opposing_starter_bf_per_start_shrunk": None}
    return {
        "opposing_starter_hrbf_shrunk": shrunk_rate(state["hr"], state["bf"], league["hrbf"], prior_bf),
        "opposing_starter_kbf_shrunk": shrunk_rate(state["k"], state["bf"], league["kbf"], prior_bf),
        "opposing_starter_bbbf_shrunk": shrunk_rate(state["bb"], state["bf"], league["bbbf"], prior_bf),
        "opposing_starter_bf_per_start_shrunk": shrunk_mean(state["bf"], state["starts"], league["bfPerStart"], prior_starts),
    }


def batter_only_probability(hrpa, expected_pa, fallback):
    if not finite(hrpa) or not finite(expected_pa) or float(expected_pa) <= 0:
        return float(fallback)
    p = min(max(float(hrpa), 1e-9), 0.999999)
    result = 1.0 - (1.0 - p) ** float(expected_pa)
    return min(max(result, 1e-6), 0.999999)


def build_season_rows(root, batter_root, season, contract):
    base = os.path.join(root, season)
    bbase = os.path.join(batter_root, season)
    canonical = load(os.path.join(base, "game-anatomy-feature-table.json"))
    lineups = load(os.path.join(base, "cohort", "pregame-lineup-history.json"))
    starters = load(os.path.join(base, "cohort", "starting-pitcher-history.json"))
    audits = load(os.path.join(base, "t5-audit", "t5-starter-identity-audit.json"))
    bh = load(os.path.join(bbase, "batter-history.json"))
    if canonical.get("schemaVersion") != BASE_SCHEMA or bh.get("schemaVersion") != BATTER_SCHEMA:
        raise SystemExit(f"V52_SCHEMA_INVALID:{season}")

    lineup_map = {int(r["gamePk"]): r for r in lineups.get("snapshots", [])}
    starter_map = {int(r["gamePk"]): r for r in starters.get("games", [])}
    audit_map = {int(r["gamePk"]): r for r in audits.get("rows", [])}
    batter_map = {int(r["gamePk"]): r for r in bh.get("games", [])}
    by_date = defaultdict(list)
    for row in canonical.get("rows", []):
        if row.get("t5PregameValid"):
            by_date[str(row["officialDate"])].append(row)

    bstate, pstate = defaultdict(empty_batter_state), defaultdict(empty_pitcher_state)
    league_b, league_p = empty_batter_state(), empty_pitcher_state()
    slots, global_slot = defaultdict(empty_slot_state), empty_slot_state()
    cfg = contract["featureEngineering"]
    rows = []
    frozen_slots = eligible = exact_games = 0

    for date in sorted(by_date):
        games = sorted(by_date[date], key=lambda r: int(r["gamePk"]))
        bp = batter_prior(league_b)
        pp = pitcher_prior(league_p)
        for raw in games:
            game_pk = int(raw["gamePk"])
            audit = audit_map.get(game_pk)
            hp, ap = probable_ids(audit)
            hl, al = complete_lineup(lineup_map.get(game_pk), audit)
            sg, bg = starter_map.get(game_pk), batter_map.get(game_pk)
            if hp is None or ap is None or hl is None or al is None or sg is None or bg is None:
                continue
            hs, aws = parse_starter(sg.get("homeStarter")), parse_starter(sg.get("awayStarter"))
            if hs is None or aws is None or hs["pitcherId"] != hp or aws["pitcherId"] != ap:
                continue
            exact_games += 1
            frozen_slots += 18
            side_lines = {"home": {int(x["batterId"]): x for x in bg["homeBatters"]}, "away": {int(x["batterId"]): x for x in bg["awayBatters"]}}
            for side, lineup, opp in (("home", hl, ap), ("away", al, hp)):
                for slot_index, batter_id in enumerate(lineup, 1):
                    line = side_lines[side].get(int(batter_id))
                    if line is None or int(line.get("plateAppearances", 0)) <= 0:
                        continue
                    eligible += 1
                    features = batter_features(bstate[int(batter_id)], bp, float(cfg["batterRateShrinkagePriorPlateAppearances"]))
                    expected_pa = lineup_slot_pa(slots[slot_index], global_slot, float(cfg["lineupSlotWorkloadShrinkagePriorStarts"]))
                    features["lineup_slot"] = float(slot_index)
                    features["lineup_slot_pa_per_start_shrunk"] = expected_pa
                    features.update(starter_features(pstate[opp], pp, float(cfg["pitcherRateShrinkagePriorBattersFaced"]), float(cfg["pitcherWorkloadShrinkagePriorStarts"])))
                    rows.append({"season": season, "officialDate": date, "gamePk": game_pk, "side": side, "batterId": int(batter_id), "lineupSlot": slot_index, "anyHomeRun": int(int(line["homeRuns"]) > 0), "homeRuns": int(line["homeRuns"]), **features})

        for raw in games:
            game_pk = int(raw["gamePk"])
            bg, sg = batter_map.get(game_pk), starter_map.get(game_pk)
            audit = audit_map.get(game_pk)
            hl, al = complete_lineup(lineup_map.get(game_pk), audit)
            if bg is not None:
                for key in ("homeBatters", "awayBatters"):
                    for line in bg[key]:
                        if int(line.get("plateAppearances", 0)) > 0:
                            bid = int(line["batterId"])
                            add_batter_line(bstate[bid], line, int(cfg["recentBatterGamesWindow"]))
                            add_batter_line(league_b, line, int(cfg["recentBatterGamesWindow"]))
                if hl is not None and al is not None:
                    for side, lineup in (("home", hl), ("away", al)):
                        key = "homeBatters" if side == "home" else "awayBatters"
                        lookup = {int(x["batterId"]): x for x in bg[key]}
                        for idx, bid in enumerate(lineup, 1):
                            line = lookup.get(int(bid))
                            if line is not None and int(line.get("plateAppearances", 0)) > 0:
                                pa = int(line["plateAppearances"])
                                slots[idx]["starts"] += 1; slots[idx]["pa"] += pa
                                global_slot["starts"] += 1; global_slot["pa"] += pa
            if sg is not None:
                for raw_starter in (sg.get("homeStarter"), sg.get("awayStarter")):
                    line = parse_starter(raw_starter)
                    if line is not None:
                        add_pitcher_line(pstate[line["pitcherId"]], line)
                        add_pitcher_line(league_p, line)

    return rows, {"canonicalT5Games": sum(len(v) for v in by_date.values()), "exactProbableRecordedStarterGamesWithCompleteLineup": exact_games, "frozenPregameStartingBatterSlots": frozen_slots, "eligiblePositivePaBatterOutcomes": eligible, "eligibilityShareOfFrozenStartingSlots": eligible / frozen_slots if frozen_slots else 0.0}


def evaluate(frame, features, imputer, scaler, model, constant_prob):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    model_p = np.clip(model.predict_proba(X)[:, 1], 1e-6, 0.999999)
    y = frame["anyHomeRun"].to_numpy(dtype=int)
    batter_p = np.asarray([batter_only_probability(row["batter_hrpa_shrunk"], row["lineup_slot_pa_per_start_shrunk"], constant_prob) for _, row in frame.iterrows()], dtype=float)
    constant_p = np.full(len(frame), float(constant_prob), dtype=float)
    model_ll = float(log_loss(y, model_p, labels=[0, 1]))
    constant_ll = float(log_loss(y, constant_p, labels=[0, 1]))
    batter_ll = float(log_loss(y, batter_p, labels=[0, 1]))
    model_brier = float(brier_score_loss(y, model_p))
    constant_brier = float(brier_score_loss(y, constant_p))
    batter_brier = float(brier_score_loss(y, batter_p))
    return {
        "rows": int(len(frame)), "observedAnyHrRate": float(np.mean(y)), "meanModelProbability": float(np.mean(model_p)), "meanBatterOnlyProbability": float(np.mean(batter_p)), "trainingConstantProbability": float(constant_prob),
        "modelLogLoss": model_ll, "constantLogLoss": constant_ll, "batterOnlyLogLoss": batter_ll, "modelVsConstantLogLossImprovement": constant_ll - model_ll, "modelVsBatterOnlyLogLossImprovement": batter_ll - model_ll,
        "modelBrier": model_brier, "constantBrier": constant_brier, "batterOnlyBrier": batter_brier, "modelVsConstantBrierImprovement": constant_brier - model_brier, "modelVsBatterOnlyBrierImprovement": batter_brier - model_brier,
        "modelAbsoluteMeanCalibrationBias": abs(float(np.mean(model_p)) - float(np.mean(y))), "constantAbsoluteMeanCalibrationBias": abs(float(constant_prob) - float(np.mean(y))), "batterOnlyAbsoluteMeanCalibrationBias": abs(float(np.mean(batter_p)) - float(np.mean(y)))
    }


def volume(frame, custody):
    dates = Counter(frame["officialDate"])
    frozen = sum(v["frozenPregameStartingBatterSlots"] for v in custody.values())
    return {"eligibleSlateDays": len(dates), "eligibleStartingBatterOutcomes": int(len(frame)), "frozenPregameStartingBatterSlots": int(frozen), "eligibilityShare": len(frame) / frozen if frozen else 0.0, "positiveHomeRunEvents": int(frame["anyHomeRun"].sum()), "positiveEventRate": float(frame["anyHomeRun"].mean())}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True); p.add_argument("--batter-root", required=True); p.add_argument("--contract", required=True); p.add_argument("--out", required=True)
    args = p.parse_args()
    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V52_CONTRACT_SCHEMA_INVALID")
    seasons = [contract["dataBoundary"]["modelFitSeason"], contract["dataBoundary"]["validationSeason"], *contract["dataBoundary"]["retrospectiveEvaluationSeasons"]]
    records, custody = [], {}
    for season in seasons:
        r, c = build_season_rows(args.root, args.batter_root, season, contract); records.extend(r); custody[season] = c
    frame = pd.DataFrame.from_records(records)
    features = tuple(contract["features"]["exactly"])
    train = frame[frame["season"] == "2022"].copy(); val = frame[frame["season"] == "2023"].copy(); ev = frame[frame["season"].isin(["2024", "2025", "2026_YTD"])].copy()
    if min(len(train), len(val), len(ev)) <= 0 or train["anyHomeRun"].nunique() != 2:
        raise SystemExit("V52_INVALID_PARTITION")
    imputer = SimpleImputer(strategy="median"); scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)])); y_train = train["anyHomeRun"].to_numpy(dtype=int)
    cfg = contract["model"]
    model = LogisticRegression(C=float(cfg["regularizationC"]), solver=cfg["solver"], max_iter=int(cfg["maxIter"]), class_weight=None)
    model.fit(X_train, y_train)
    constant_prob = float(np.mean(y_train))
    vm = evaluate(val, features, imputer, scaler, model, constant_prob); em = evaluate(ev, features, imputer, scaler, model, constant_prob)
    by_season = {s: evaluate(frame[frame["season"] == s].copy(), features, imputer, scaler, model, constant_prob) for s in ["2023", "2024", "2025", "2026_YTD"]}
    checks = {
        "validationLogLossBeatsConstant": vm["modelVsConstantLogLossImprovement"] > 0,
        "validationLogLossBeatsBatterOnly": vm["modelVsBatterOnlyLogLossImprovement"] > 0,
        "validationBrierBeatsConstant": vm["modelVsConstantBrierImprovement"] > 0,
        "validationBrierBeatsBatterOnly": vm["modelVsBatterOnlyBrierImprovement"] > 0,
        "evaluationLogLossBeatsConstant": em["modelVsConstantLogLossImprovement"] > 0,
        "evaluationLogLossBeatsBatterOnly": em["modelVsBatterOnlyLogLossImprovement"] > 0,
        "evaluationBrierBeatsConstant": em["modelVsConstantBrierImprovement"] > 0,
        "evaluationBrierBeatsBatterOnly": em["modelVsBatterOnlyBrierImprovement"] > 0,
    }
    passed = all(checks.values()); classification = contract["candidateRubric"]["passingClassification"] if passed else contract["candidateRubric"]["failureClassification"]
    report = {
        "schemaVersion": REPORT_SCHEMA, "classification": classification, "candidateRubricPassed": passed, "candidateRubricChecks": checks,
        "parent": {"mainBaseSha": contract["parentEvidence"]["mainBaseSha"], "v41Classification": contract["parentEvidence"]["v41CertificationRequired"], "priorBatterWalksClosure": contract["parentEvidence"]["priorBatterWalksClosure"]},
        "data": {"scoredRows": int(len(frame)), "custodyBySeason": custody, "featureCount": len(features), "features": list(features), "sameDateHistoryAllowed": False, "seasonHistoryReset": True},
        "model": {"providerMarketKey": "batter_home_runs", "canonicalResearchMarketType": "BATTER_HOME_RUN_BINARY", "trainingSeason": "2022", "trainingRows": int(len(train)), "trainingPositiveEvents": int(y_train.sum()), "trainingPositiveRate": constant_prob, "regularizationC": float(cfg["regularizationC"]), "solver": cfg["solver"], "maxIter": int(cfg["maxIter"]), "featureSearchUsed": False, "modelSearchUsed": False, "hyperparameterSearchUsed": False},
        "baselines": {"constantProbability": constant_prob, "batterOnlyFormula": contract["baselines"]["batterOnlyFormula"]},
        "validation2023": vm, "evaluation2024_2026Ytd": em, "bySeasonDescriptiveOnly": by_season, "volumeDiagnostics": volume(frame, custody),
        "marketBoundary": {"providerMarketKey": "batter_home_runs", "repositoryRegistryFamily": "BATTER_PROP", "repositoryQuoteShape": "NO_LINE_BINARY", "hardRockEvidenceSourceId": "HARD_ROCK_MLB_GUIDE_20260807", "historicalBatterHomeRunPricesUsed": False, "positiveEvEstablished": False, "hardRockFloridaPerEventAvailabilityEstablished": False, "priceCaptureAuthorized": False, "productionPromotionAuthorized": False},
        "policy": {"sameDateOutcomeLeakageAllowed": False, "futureGameDataAllowed": False, "featureSearchUsed": False, "modelSearchUsed": False, "hyperparameterSearchUsed": False, "thresholdSearchUsed": False, "subsetMiningUsed": False, "postResultRuleChangeUsed": False, "priorClosedModelsRetuned": False, "productionMarketRegistryChanged": False, "liveLookupAuthorizationChanged": False, "liveMarketDiscoveryChanged": False, "rankingChanged": False, "stakeChanged": False, "betEliteAllowed": False, "automaticBetPlacementAllowed": False, "realFinancialExposure": 0}
    }
    dump(args.out, report)
    print(json.dumps({"classification": classification, "candidateRubricPassed": passed, "validation2023": vm, "evaluation2024_2026Ytd": em, "bySeason": by_season, "candidateRubricChecks": checks, "volumeDiagnostics": report["volumeDiagnostics"]}, indent=2))


if __name__ == "__main__":
    main()
