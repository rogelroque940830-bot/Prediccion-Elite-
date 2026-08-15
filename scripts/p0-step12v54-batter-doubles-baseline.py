#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-p0-step12v54-batter-doubles-baseline.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v54-batter-doubles-baseline-contract.v1"
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
        parsed = int(value)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def audit_valid(audit):
    return bool(audit and audit.get("identityOk") and audit.get("sourceHistorical") and audit.get("pregame") and audit.get("probableBothKnown"))


def probable_ids(audit):
    if not audit_valid(audit):
        return None, None
    home = positive_int(audit.get("homeProbablePitcherId"))
    away = positive_int(audit.get("awayProbablePitcherId"))
    return (home, away) if home is not None and away is not None else (None, None)


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
    mapping = {"bf": "battersFaced", "h": "hits", "hr": "homeRuns"}
    out = {"pitcherId": pitcher_id}
    for key, source in mapping.items():
        value = raw.get(source, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f"V54_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}")
        out[key] = float(value)
    return out


def empty_batter_state():
    return {"games": 0, "pa": 0.0, "doubles": 0.0, "h": 0.0, "hr": 0.0, "recent": []}


def empty_pitcher_state():
    return {"starts": 0, "bf": 0.0, "h": 0.0, "hr": 0.0}


def empty_slot_state():
    return {"starts": 0, "pa": 0.0}


def add_batter_line(state, line, recent_window):
    pa = int(line.get("plateAppearances", 0))
    if pa <= 0:
        return
    doubles = int(line["doubles"])
    hits = int(line["hits"])
    home_runs = int(line["homeRuns"])
    if min(doubles, hits, home_runs) < 0:
        raise SystemExit("V54_NEGATIVE_BATTER_STAT")
    state["games"] += 1
    state["pa"] += pa
    state["doubles"] += doubles
    state["h"] += hits
    state["hr"] += home_runs
    state["recent"].append({"doubles": doubles, "pa": pa})
    if len(state["recent"]) > recent_window:
        state["recent"] = state["recent"][-recent_window:]


def add_pitcher_line(state, line):
    if line is None or line["bf"] <= 0:
        return
    state["starts"] += 1
    for key in ("bf", "h", "hr"):
        state[key] += line[key]


def batter_league_prior(state):
    if state["pa"] <= 0:
        return None
    return {"2bpa": state["doubles"] / state["pa"], "hpa": state["h"] / state["pa"], "hrpa": state["hr"] / state["pa"]}


def pitcher_league_prior(state):
    if state["bf"] <= 0 or state["starts"] <= 0:
        return None
    return {"hbf": state["h"] / state["bf"], "hrbf": state["hr"] / state["bf"], "bfPerStart": state["bf"] / state["starts"]}


def shrunk_rate(num, den, prior, weight):
    return (float(num) + float(weight) * float(prior)) / (float(den) + float(weight))


def shrunk_mean(total, trials, prior, weight):
    return (float(total) + float(weight) * float(prior)) / (float(trials) + float(weight))


def batter_features(state, league_prior, prior_pa):
    recent = state["recent"]
    out = {
        "batter_recent10_doubles_per_game": float(np.mean([r["doubles"] for r in recent])) if recent else None,
        "batter_recent10_pa_per_game": float(np.mean([r["pa"] for r in recent])) if recent else None,
    }
    if league_prior is None:
        out.update({"batter_2bpa_shrunk": None, "batter_hpa_shrunk": None, "batter_hrpa_shrunk": None})
        return out
    out.update({
        "batter_2bpa_shrunk": shrunk_rate(state["doubles"], state["pa"], league_prior["2bpa"], prior_pa),
        "batter_hpa_shrunk": shrunk_rate(state["h"], state["pa"], league_prior["hpa"], prior_pa),
        "batter_hrpa_shrunk": shrunk_rate(state["hr"], state["pa"], league_prior["hrpa"], prior_pa),
    })
    return out


def lineup_slot_pa_feature(slot_state, global_slot_state, prior_starts):
    if global_slot_state["starts"] <= 0:
        return None
    league_mean = global_slot_state["pa"] / global_slot_state["starts"]
    return shrunk_mean(slot_state["pa"], slot_state["starts"], league_mean, prior_starts)


def opposing_starter_features(state, league_prior, prior_bf, prior_starts):
    if league_prior is None:
        return {"opposing_starter_hbf_shrunk": None, "opposing_starter_hrbf_shrunk": None, "opposing_starter_bf_per_start_shrunk": None}
    return {
        "opposing_starter_hbf_shrunk": shrunk_rate(state["h"], state["bf"], league_prior["hbf"], prior_bf),
        "opposing_starter_hrbf_shrunk": shrunk_rate(state["hr"], state["bf"], league_prior["hrbf"], prior_bf),
        "opposing_starter_bf_per_start_shrunk": shrunk_mean(state["bf"], state["starts"], league_prior["bfPerStart"], prior_starts),
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit("V54_NB2_DENOMINATOR_INVALID")
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    mu = max(float(mu), 1e-9)
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def build_season_rows(root, batter_root, season, contract):
    base = os.path.join(root, season)
    bbase = os.path.join(batter_root, season)
    canonical = load(os.path.join(base, "game-anatomy-feature-table.json"))
    lineups = load(os.path.join(base, "cohort", "pregame-lineup-history.json"))
    starters = load(os.path.join(base, "cohort", "starting-pitcher-history.json"))
    audits = load(os.path.join(base, "t5-audit", "t5-starter-identity-audit.json"))
    batter_history = load(os.path.join(bbase, "batter-history.json"))
    if canonical.get("schemaVersion") != BASE_SCHEMA:
        raise SystemExit(f"V54_BASE_SCHEMA_INVALID:{season}")
    if batter_history.get("schemaVersion") != BATTER_SCHEMA:
        raise SystemExit(f"V54_BATTER_SCHEMA_INVALID:{season}")

    lineup_map = {int(r["gamePk"]): r for r in lineups.get("snapshots", [])}
    starter_map = {int(r["gamePk"]): r for r in starters.get("games", [])}
    audit_map = {int(r["gamePk"]): r for r in audits.get("rows", [])}
    batter_map = {int(r["gamePk"]): r for r in batter_history.get("games", [])}
    by_date = defaultdict(list)
    for row in canonical.get("rows", []):
        if row.get("t5PregameValid"):
            by_date[str(row["officialDate"])].append(row)

    batter_state = defaultdict(empty_batter_state)
    league_batter = empty_batter_state()
    pitcher_state = defaultdict(empty_pitcher_state)
    league_pitcher = empty_pitcher_state()
    slot_state = defaultdict(empty_slot_state)
    global_slot = empty_slot_state()
    cfg = contract["featureEngineering"]
    rows = []
    exact_games = frozen_slots = eligible = 0

    for official_date in sorted(by_date):
        games = sorted(by_date[official_date], key=lambda r: int(r["gamePk"]))
        bp = batter_league_prior(league_batter)
        pp = pitcher_league_prior(league_pitcher)

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
                for lineup_slot, batter_id in enumerate(lineup, 1):
                    line = side_lines[side].get(int(batter_id))
                    if line is None or int(line.get("plateAppearances", 0)) <= 0:
                        continue
                    eligible += 1
                    features = batter_features(batter_state[int(batter_id)], bp, float(cfg["batterRateShrinkagePriorPlateAppearances"]))
                    expected_pa = lineup_slot_pa_feature(slot_state[lineup_slot], global_slot, float(cfg["lineupSlotWorkloadShrinkagePriorStarts"]))
                    features["lineup_slot"] = float(lineup_slot)
                    features["lineup_slot_pa_per_start_shrunk"] = expected_pa
                    features.update(opposing_starter_features(pitcher_state[opp], pp, float(cfg["pitcherRateShrinkagePriorBattersFaced"]), float(cfg["pitcherWorkloadShrinkagePriorStarts"])))
                    batter_only_mu = float(features["batter_2bpa_shrunk"]) * float(expected_pa) if finite(features["batter_2bpa_shrunk"]) and finite(expected_pa) else None
                    rows.append({"season": season, "officialDate": official_date, "gamePk": game_pk, "side": side, "batterId": int(batter_id), "lineupSlot": lineup_slot, "doubles": int(line["doubles"]), "plateAppearances": int(line["plateAppearances"]), "batterOnlyMuRaw": batter_only_mu, **features})

        # Strict same-date batch update.
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
                            add_batter_line(batter_state[bid], line, int(cfg["recentBatterGamesWindow"]))
                            add_batter_line(league_batter, line, int(cfg["recentBatterGamesWindow"]))
                if hl is not None and al is not None:
                    for side, lineup in (("home", hl), ("away", al)):
                        key = "homeBatters" if side == "home" else "awayBatters"
                        lookup = {int(x["batterId"]): x for x in bg[key]}
                        for idx, bid in enumerate(lineup, 1):
                            line = lookup.get(int(bid))
                            if line is not None and int(line.get("plateAppearances", 0)) > 0:
                                pa = int(line["plateAppearances"])
                                slot_state[idx]["starts"] += 1
                                slot_state[idx]["pa"] += pa
                                global_slot["starts"] += 1
                                global_slot["pa"] += pa
            if sg is not None:
                for raw_starter in (sg.get("homeStarter"), sg.get("awayStarter")):
                    line = parse_starter(raw_starter)
                    if line is not None:
                        add_pitcher_line(pitcher_state[line["pitcherId"]], line)
                        add_pitcher_line(league_pitcher, line)

    return rows, {
        "canonicalT5Games": sum(len(v) for v in by_date.values()),
        "exactProbableRecordedStarterGamesWithCompleteLineup": exact_games,
        "frozenPregameStartingBatterSlots": frozen_slots,
        "eligiblePositivePaBatterOutcomes": eligible,
        "eligibilityShareOfFrozenStartingSlots": eligible / frozen_slots if frozen_slots else 0.0,
    }


def evaluate(frame, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    model_mu = np.maximum(model.predict(X), 1e-9)
    y = frame["doubles"].to_numpy(dtype=float)
    constant_mu = np.full(len(frame), train_mean, dtype=float)
    batter_mu = frame["batterOnlyMuRaw"].to_numpy(dtype=float)
    batter_mu = np.where(np.isfinite(batter_mu) & (batter_mu > 0), batter_mu, train_mean)
    model_dev = float(mean_poisson_deviance(y, model_mu))
    constant_dev = float(mean_poisson_deviance(y, constant_mu))
    batter_dev = float(mean_poisson_deviance(y, batter_mu))
    model_briers, constant_briers, batter_briers = [], [], []
    diagnostics = {}
    for line in lines:
        observed = (y > line).astype(float)
        model_probs = np.asarray([over_probability(mu, dispersion, line) for mu in model_mu])
        batter_probs = np.asarray([over_probability(mu, dispersion, line) for mu in batter_mu])
        constant_prob = float(line_probs[line])
        model_brier = float(np.mean((model_probs - observed) ** 2))
        constant_brier = float(np.mean((constant_prob - observed) ** 2))
        batter_brier = float(np.mean((batter_probs - observed) ** 2))
        model_briers.append(model_brier); constant_briers.append(constant_brier); batter_briers.append(batter_brier)
        diagnostics[str(line)] = {"observedOverRate": float(np.mean(observed)), "meanModelOverProbability": float(np.mean(model_probs)), "meanBatterOnlyOverProbability": float(np.mean(batter_probs)), "trainingClimatologyOverProbability": constant_prob, "modelBrier": model_brier, "constantBaselineBrier": constant_brier, "batterOnlyBaselineBrier": batter_brier, "modelVsConstantBrierImprovement": constant_brier - model_brier, "modelVsBatterOnlyBrierImprovement": batter_brier - model_brier}
    observed_mean = float(np.mean(y)); model_mean = float(np.mean(model_mu)); batter_mean = float(np.mean(batter_mu))
    return {
        "rows": int(len(frame)), "observedMeanDoubles": observed_mean, "meanModelDoubles": model_mean, "meanBatterOnlyDoubles": batter_mean, "trainingConstantMeanDoubles": float(train_mean),
        "modelAbsoluteMeanCalibrationBias": abs(model_mean - observed_mean), "constantAbsoluteMeanCalibrationBias": abs(float(train_mean) - observed_mean), "batterOnlyAbsoluteMeanCalibrationBias": abs(batter_mean - observed_mean),
        "modelMeanAbsoluteError": float(mean_absolute_error(y, model_mu)), "constantMeanAbsoluteError": float(mean_absolute_error(y, constant_mu)), "batterOnlyMeanAbsoluteError": float(mean_absolute_error(y, batter_mu)),
        "modelPoissonDeviance": model_dev, "constantPoissonDeviance": constant_dev, "batterOnlyPoissonDeviance": batter_dev, "modelVsConstantDevianceImprovement": constant_dev - model_dev, "modelVsBatterOnlyDevianceImprovement": batter_dev - model_dev,
        "fixedLineDiagnostics": diagnostics, "modelAverageBrier": float(np.mean(model_briers)), "constantAverageBrier": float(np.mean(constant_briers)), "batterOnlyAverageBrier": float(np.mean(batter_briers)), "modelVsConstantAverageBrierImprovement": float(np.mean(constant_briers) - np.mean(model_briers)), "modelVsBatterOnlyAverageBrierImprovement": float(np.mean(batter_briers) - np.mean(model_briers)),
    }


def volume_diagnostics(frame, custody):
    counts = Counter(frame["officialDate"])
    frozen_slots = sum(v["frozenPregameStartingBatterSlots"] for v in custody.values())
    return {"eligibleSlateDays": len(counts), "eligibleStartingBatterOutcomes": int(len(frame)), "frozenPregameStartingBatterSlots": int(frozen_slots), "eligibilityShare": len(frame) / frozen_slots if frozen_slots else 0.0, "meanEligibleStartingBattersPerSlateDay": float(np.mean(list(counts.values()))) if counts else 0.0, "medianEligibleStartingBattersPerSlateDay": float(np.median(list(counts.values()))) if counts else 0.0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True); parser.add_argument("--batter-root", required=True); parser.add_argument("--contract", required=True); parser.add_argument("--out", required=True)
    args = parser.parse_args()
    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V54_CONTRACT_SCHEMA_INVALID")
    seasons = [contract["dataBoundary"]["modelFitSeason"], contract["dataBoundary"]["validationSeason"], *contract["dataBoundary"]["retrospectiveEvaluationSeasons"]]
    records, custody = [], {}
    for season in seasons:
        sr, sc = build_season_rows(args.root, args.batter_root, season, contract); records.extend(sr); custody[season] = sc
    frame = pd.DataFrame.from_records(records)
    features = tuple(contract["features"]["exactly"])
    train = frame[frame["season"] == "2022"].copy(); validation = frame[frame["season"] == "2023"].copy(); evaluation = frame[frame["season"].isin(["2024", "2025", "2026_YTD"])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit("V54_EMPTY_PARTITION")
    imputer = SimpleImputer(strategy="median"); scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)])); y_train = train["doubles"].to_numpy(dtype=float)
    cfg = contract["model"]
    model = PoissonRegressor(alpha=float(cfg["poissonAlpha"]), max_iter=int(cfg["maxIter"])); model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9); dispersion = nb2_dispersion(y_train, train_mu); train_mean = float(np.mean(y_train))
    lines = [float(x) for x in cfg["fixedHalfDoubleLines"]]; line_probs = {line: float(np.mean(y_train > line)) for line in lines}
    vm = evaluate(validation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    em = evaluate(evaluation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    by_season = {s: evaluate(frame[frame["season"] == s].copy(), features, imputer, scaler, model, dispersion, train_mean, line_probs, lines) for s in ["2023", "2024", "2025", "2026_YTD"]}
    checks = {
        "validationDevianceBeatsConstant": vm["modelVsConstantDevianceImprovement"] > 0,
        "validationDevianceBeatsBatterOnly": vm["modelVsBatterOnlyDevianceImprovement"] > 0,
        "validationBrierBeatsConstant": vm["modelVsConstantAverageBrierImprovement"] > 0,
        "validationBrierBeatsBatterOnly": vm["modelVsBatterOnlyAverageBrierImprovement"] > 0,
        "evaluationDevianceBeatsConstant": em["modelVsConstantDevianceImprovement"] > 0,
        "evaluationDevianceBeatsBatterOnly": em["modelVsBatterOnlyDevianceImprovement"] > 0,
        "evaluationBrierBeatsConstant": em["modelVsConstantAverageBrierImprovement"] > 0,
        "evaluationBrierBeatsBatterOnly": em["modelVsBatterOnlyAverageBrierImprovement"] > 0,
    }
    passed = all(checks.values()); classification = contract["candidateRubric"]["passingClassification"] if passed else contract["candidateRubric"]["failureClassification"]
    report = {
        "schemaVersion": REPORT_SCHEMA, "classification": classification, "candidateRubricPassed": passed, "candidateRubricChecks": checks,
        "parent": {"mainBaseSha": contract["parentEvidence"]["mainBaseSha"], "v41Classification": contract["parentEvidence"]["v41CertificationRequired"], "priorBatterHomeRunClosure": contract["parentEvidence"]["priorBatterHomeRunClosure"]},
        "data": {"scoredRows": int(len(frame)), "custodyBySeason": custody, "featureCount": len(features), "features": list(features), "sameDateHistoryAllowed": False, "seasonHistoryReset": True},
        "model": {"providerMarketKey": "batter_doubles", "canonicalResearchMarketType": "BATTER_DOUBLES", "trainingSeason": "2022", "trainingRows": int(len(train)), "trainingMeanDoubles": train_mean, "poissonAlpha": float(cfg["poissonAlpha"]), "maxIter": int(cfg["maxIter"]), "nb2Dispersion": float(dispersion), "fixedHalfDoubleLines": lines, "featureSearchUsed": False, "modelSearchUsed": False, "hyperparameterSearchUsed": False, "lineSearchUsed": False},
        "baselines": {"constantMeanDoubles": train_mean, "batterOnlyFormula": contract["baselines"]["batterOnlyMechanistic"], "batterOnlyMissingPredictionFallback": train_mean, "sharedTrainingOnlyNb2DispersionForProbabilityConversion": float(dispersion)},
        "validation2023": vm, "evaluation2024_2026Ytd": em, "bySeasonDescriptiveOnly": by_season, "volumeDiagnostics": volume_diagnostics(frame, custody),
        "marketBoundary": {"providerMarketKey": "batter_doubles", "repositoryRegistryFamily": "BATTER_PROP", "repositoryQuoteShape": "PLAYER_OVER_UNDER", "hardRockEvidenceSourceId": "HARD_ROCK_MLB_GUIDE_20260807", "historicalBatterDoublesPricesUsed": False, "positiveEvEstablished": False, "hardRockFloridaPerEventAvailabilityEstablished": False, "priceCaptureAuthorized": False, "productionPromotionAuthorized": False},
        "policy": {"sameDateOutcomeLeakageAllowed": False, "futureGameDataAllowed": False, "featureSearchUsed": False, "modelSearchUsed": False, "hyperparameterSearchUsed": False, "lineSearchUsed": False, "thresholdSearchUsed": False, "subsetMiningUsed": False, "postResultRuleChangeUsed": False, "priorClosedModelsRetuned": False, "productionMarketRegistryChanged": False, "liveLookupAuthorizationChanged": False, "liveMarketDiscoveryChanged": False, "rankingChanged": False, "stakeChanged": False, "betEliteAllowed": False, "automaticBetPlacementAllowed": False, "realFinancialExposure": 0}
    }
    dump(args.out, report)
    print(json.dumps({"classification": classification, "candidateRubricPassed": passed, "validation2023": vm, "evaluation2024_2026Ytd": em, "bySeason": by_season, "candidateRubricChecks": checks, "volumeDiagnostics": report["volumeDiagnostics"]}, indent=2))


if __name__ == "__main__":
    main()
