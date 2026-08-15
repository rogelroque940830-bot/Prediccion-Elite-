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

REPORT_SCHEMA = "courtedge-p0-step12v48-batter-runs-scored-baseline.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v48-batter-runs-scored-baseline-contract.v1"
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
        home = [int(value) for value in lineup.get("homeBattingOrder", [])]
        away = [int(value) for value in lineup.get("awayBattingOrder", [])]
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
    mapping = {"bf": "battersFaced", "h": "hits", "bb": "baseOnBalls", "hr": "homeRuns"}
    values = {"pitcherId": pitcher_id}
    for key, source in mapping.items():
        value = raw.get(source, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f"V48_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}")
        values[key] = float(value)
    return values


def empty_batter_state():
    return {"games": 0, "pa": 0.0, "runs": 0.0, "h": 0.0, "bb": 0.0, "hr": 0.0, "recent": []}


def empty_pitcher_state():
    return {"starts": 0, "bf": 0.0, "h": 0.0, "bb": 0.0, "hr": 0.0}


def empty_slot_state():
    return {"starts": 0, "pa": 0.0}


def add_batter_line(state, line, recent_window):
    pa = int(line.get("plateAppearances", 0))
    if pa <= 0:
        return
    runs = int(line["runs"])
    hits = int(line["hits"])
    walks = int(line["baseOnBalls"])
    home_runs = int(line["homeRuns"])
    state["games"] += 1
    state["pa"] += pa
    state["runs"] += runs
    state["h"] += hits
    state["bb"] += walks
    state["hr"] += home_runs
    state["recent"].append({"runs": runs, "pa": pa})
    if len(state["recent"]) > recent_window:
        state["recent"] = state["recent"][-recent_window:]


def add_pitcher_line(state, line):
    if line is None or line["bf"] <= 0:
        return
    state["starts"] += 1
    for key in ("bf", "h", "bb", "hr"):
        state[key] += line[key]


def batter_league_prior(state):
    if state["pa"] <= 0:
        return None
    return {
        "runspa": state["runs"] / state["pa"],
        "hpa": state["h"] / state["pa"],
        "bbpa": state["bb"] / state["pa"],
        "hrpa": state["hr"] / state["pa"],
    }


def pitcher_league_prior(state):
    if state["bf"] <= 0 or state["starts"] <= 0:
        return None
    return {
        "hbf": state["h"] / state["bf"],
        "bbbf": state["bb"] / state["bf"],
        "hrbf": state["hr"] / state["bf"],
        "bfPerStart": state["bf"] / state["starts"],
    }


def shrunk_rate(numerator, denominator, league_rate, prior_weight):
    return (float(numerator) + prior_weight * float(league_rate)) / (float(denominator) + prior_weight)


def shrunk_mean(total, trials, league_mean, prior_trials):
    return (float(total) + prior_trials * float(league_mean)) / (float(trials) + prior_trials)


def batter_features(state, league_prior, prior_pa):
    recent = state["recent"]
    features = {
        "batter_recent10_runs_per_game": float(np.mean([row["runs"] for row in recent])) if recent else None,
        "batter_recent10_pa_per_game": float(np.mean([row["pa"] for row in recent])) if recent else None,
    }
    if league_prior is None:
        features.update({"batter_runspa_shrunk": None, "batter_hpa_shrunk": None, "batter_bbpa_shrunk": None, "batter_hrpa_shrunk": None})
        return features
    features.update({
        "batter_runspa_shrunk": shrunk_rate(state["runs"], state["pa"], league_prior["runspa"], prior_pa),
        "batter_hpa_shrunk": shrunk_rate(state["h"], state["pa"], league_prior["hpa"], prior_pa),
        "batter_bbpa_shrunk": shrunk_rate(state["bb"], state["pa"], league_prior["bbpa"], prior_pa),
        "batter_hrpa_shrunk": shrunk_rate(state["hr"], state["pa"], league_prior["hrpa"], prior_pa),
    })
    return features


def lineup_slot_pa_feature(slot_state, global_slot_state, prior_starts):
    if global_slot_state["starts"] <= 0:
        return None
    league_mean = global_slot_state["pa"] / global_slot_state["starts"]
    return shrunk_mean(slot_state["pa"], slot_state["starts"], league_mean, prior_starts)


def opposing_starter_features(state, league_prior, rate_prior_bf, workload_prior_starts):
    if league_prior is None:
        return {"opposing_starter_hbf_shrunk": None, "opposing_starter_bbf_shrunk": None, "opposing_starter_hrbf_shrunk": None, "opposing_starter_bf_per_start_shrunk": None}
    return {
        "opposing_starter_hbf_shrunk": shrunk_rate(state["h"], state["bf"], league_prior["hbf"], rate_prior_bf),
        "opposing_starter_bbf_shrunk": shrunk_rate(state["bb"], state["bf"], league_prior["bbbf"], rate_prior_bf),
        "opposing_starter_hrbf_shrunk": shrunk_rate(state["hr"], state["bf"], league_prior["hrbf"], rate_prior_bf),
        "opposing_starter_bf_per_start_shrunk": shrunk_mean(state["bf"], state["starts"], league_prior["bfPerStart"], workload_prior_starts),
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu**2))
    if denominator <= 0:
        raise SystemExit("V48_NB2_DENOMINATOR_INVALID")
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
    batter_base = os.path.join(batter_root, season)
    canonical = load(os.path.join(base, "game-anatomy-feature-table.json"))
    lineups = load(os.path.join(base, "cohort", "pregame-lineup-history.json"))
    starters = load(os.path.join(base, "cohort", "starting-pitcher-history.json"))
    audits = load(os.path.join(base, "t5-audit", "t5-starter-identity-audit.json"))
    batter_history = load(os.path.join(batter_base, "batter-history.json"))
    if canonical.get("schemaVersion") != BASE_SCHEMA:
        raise SystemExit(f"V48_BASE_SCHEMA_INVALID:{season}")
    if batter_history.get("schemaVersion") != BATTER_SCHEMA:
        raise SystemExit(f"V48_BATTER_SCHEMA_INVALID:{season}")

    lineup_map = {int(row["gamePk"]): row for row in lineups.get("snapshots", [])}
    starter_map = {int(row["gamePk"]): row for row in starters.get("games", [])}
    audit_map = {int(row["gamePk"]): row for row in audits.get("rows", [])}
    batter_game_map = {int(row["gamePk"]): row for row in batter_history.get("games", [])}
    canonical_rows = [row for row in canonical.get("rows", []) if row.get("t5PregameValid")]
    by_date = defaultdict(list)
    for row in canonical_rows:
        by_date[str(row["officialDate"])].append(row)

    batter_state = defaultdict(empty_batter_state)
    league_batter_state = empty_batter_state()
    pitcher_state = defaultdict(empty_pitcher_state)
    league_pitcher_state = empty_pitcher_state()
    lineup_slot_state = defaultdict(empty_slot_state)
    global_lineup_slot_state = empty_slot_state()
    cfg = contract["featureEngineering"]
    rows = []
    exact_starter_games = frozen_slots = eligible_positive_pa = 0

    for official_date in sorted(by_date):
        games = sorted(by_date[official_date], key=lambda row: int(row["gamePk"]))
        batter_prior = batter_league_prior(league_batter_state)
        pitcher_prior = pitcher_league_prior(league_pitcher_state)

        for raw in games:
            game_pk = int(raw["gamePk"])
            audit = audit_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            home_lineup, away_lineup = complete_lineup(lineup_map.get(game_pk), audit)
            starter_game = starter_map.get(game_pk)
            batter_game = batter_game_map.get(game_pk)
            if home_probable is None or away_probable is None or home_lineup is None or away_lineup is None or starter_game is None or batter_game is None:
                continue
            home_starter = parse_starter(starter_game.get("homeStarter"))
            away_starter = parse_starter(starter_game.get("awayStarter"))
            if home_starter is None or away_starter is None or home_starter["pitcherId"] != home_probable or away_starter["pitcherId"] != away_probable:
                continue

            exact_starter_games += 1
            frozen_slots += 18
            lines_by_side = {
                "home": {int(line["batterId"]): line for line in batter_game["homeBatters"]},
                "away": {int(line["batterId"]): line for line in batter_game["awayBatters"]},
            }
            for side, lineup, opposing_pitcher_id in (("home", home_lineup, away_probable), ("away", away_lineup, home_probable)):
                for lineup_slot, batter_id in enumerate(lineup, 1):
                    batter_id = int(batter_id)
                    line = lines_by_side[side].get(batter_id)
                    if line is None or int(line.get("plateAppearances", 0)) <= 0:
                        continue
                    eligible_positive_pa += 1
                    features = batter_features(batter_state[batter_id], batter_prior, float(cfg["batterRateShrinkagePriorPlateAppearances"]))
                    slot_pa = lineup_slot_pa_feature(lineup_slot_state[lineup_slot], global_lineup_slot_state, float(cfg["lineupSlotWorkloadShrinkagePriorStarts"]))
                    features["lineup_slot"] = float(lineup_slot)
                    features["lineup_slot_pa_per_start_shrunk"] = slot_pa
                    features.update(opposing_starter_features(pitcher_state[opposing_pitcher_id], pitcher_prior, float(cfg["pitcherRateShrinkagePriorBattersFaced"]), float(cfg["pitcherWorkloadShrinkagePriorStarts"])))
                    batter_only_mu = float(features["batter_runspa_shrunk"]) * float(slot_pa) if finite(features["batter_runspa_shrunk"]) and finite(slot_pa) else None
                    rows.append({
                        "season": season,
                        "officialDate": official_date,
                        "gamePk": game_pk,
                        "side": side,
                        "batterId": batter_id,
                        "lineupSlot": lineup_slot,
                        "runs": int(line["runs"]),
                        "plateAppearances": int(line["plateAppearances"]),
                        "batterOnlyMuRaw": batter_only_mu,
                        **features,
                    })

        for raw in games:
            game_pk = int(raw["gamePk"])
            batter_game = batter_game_map.get(game_pk)
            starter_game = starter_map.get(game_pk)
            audit = audit_map.get(game_pk)
            home_lineup, away_lineup = complete_lineup(lineup_map.get(game_pk), audit)
            if batter_game is not None:
                for side_key in ("homeBatters", "awayBatters"):
                    for line in batter_game[side_key]:
                        if int(line.get("plateAppearances", 0)) <= 0:
                            continue
                        batter_id = int(line["batterId"])
                        add_batter_line(batter_state[batter_id], line, int(cfg["recentBatterGamesWindow"]))
                        add_batter_line(league_batter_state, line, int(cfg["recentBatterGamesWindow"]))
                if home_lineup is not None and away_lineup is not None:
                    for side, lineup in (("home", home_lineup), ("away", away_lineup)):
                        side_key = "homeBatters" if side == "home" else "awayBatters"
                        side_lines = {int(line["batterId"]): line for line in batter_game[side_key]}
                        for lineup_slot, batter_id in enumerate(lineup, 1):
                            line = side_lines.get(int(batter_id))
                            if line is None or int(line.get("plateAppearances", 0)) <= 0:
                                continue
                            pa = int(line["plateAppearances"])
                            lineup_slot_state[lineup_slot]["starts"] += 1
                            lineup_slot_state[lineup_slot]["pa"] += pa
                            global_lineup_slot_state["starts"] += 1
                            global_lineup_slot_state["pa"] += pa
            if starter_game is not None:
                home_starter = parse_starter(starter_game.get("homeStarter"))
                away_starter = parse_starter(starter_game.get("awayStarter"))
                if home_starter is not None:
                    add_pitcher_line(pitcher_state[home_starter["pitcherId"]], home_starter)
                    add_pitcher_line(league_pitcher_state, home_starter)
                if away_starter is not None:
                    add_pitcher_line(pitcher_state[away_starter["pitcherId"]], away_starter)
                    add_pitcher_line(league_pitcher_state, away_starter)

    return rows, {
        "canonicalT5Games": len(canonical_rows),
        "exactProbableRecordedStarterGamesWithCompleteLineup": exact_starter_games,
        "frozenPregameStartingBatterSlots": frozen_slots,
        "eligiblePositivePaBatterOutcomes": eligible_positive_pa,
        "eligibilityShareOfFrozenStartingSlots": eligible_positive_pa / frozen_slots if frozen_slots else 0.0,
    }


def evaluate(frame, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    model_mu = np.maximum(model.predict(X), 1e-9)
    y = frame["runs"].to_numpy(dtype=float)
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
        model_briers.append(model_brier)
        constant_briers.append(constant_brier)
        batter_briers.append(batter_brier)
        diagnostics[str(line)] = {
            "observedOverRate": float(np.mean(observed)),
            "meanModelOverProbability": float(np.mean(model_probs)),
            "meanBatterOnlyOverProbability": float(np.mean(batter_probs)),
            "trainingClimatologyOverProbability": constant_prob,
            "modelBrier": model_brier,
            "constantBaselineBrier": constant_brier,
            "batterOnlyBaselineBrier": batter_brier,
            "modelVsConstantBrierImprovement": constant_brier - model_brier,
            "modelVsBatterOnlyBrierImprovement": batter_brier - model_brier,
        }
    observed_mean = float(np.mean(y))
    model_mean = float(np.mean(model_mu))
    batter_mean = float(np.mean(batter_mu))
    return {
        "rows": int(len(frame)),
        "observedMeanRuns": observed_mean,
        "meanModelRuns": model_mean,
        "meanBatterOnlyRuns": batter_mean,
        "trainingConstantMeanRuns": float(train_mean),
        "modelAbsoluteMeanCalibrationBias": abs(model_mean - observed_mean),
        "constantAbsoluteMeanCalibrationBias": abs(float(train_mean) - observed_mean),
        "batterOnlyAbsoluteMeanCalibrationBias": abs(batter_mean - observed_mean),
        "modelMeanAbsoluteError": float(mean_absolute_error(y, model_mu)),
        "constantMeanAbsoluteError": float(mean_absolute_error(y, constant_mu)),
        "batterOnlyMeanAbsoluteError": float(mean_absolute_error(y, batter_mu)),
        "modelPoissonDeviance": model_dev,
        "constantPoissonDeviance": constant_dev,
        "batterOnlyPoissonDeviance": batter_dev,
        "modelVsConstantDevianceImprovement": constant_dev - model_dev,
        "modelVsBatterOnlyDevianceImprovement": batter_dev - model_dev,
        "fixedLineDiagnostics": diagnostics,
        "modelAverageBrier": float(np.mean(model_briers)),
        "constantAverageBrier": float(np.mean(constant_briers)),
        "batterOnlyAverageBrier": float(np.mean(batter_briers)),
        "modelVsConstantAverageBrierImprovement": float(np.mean(constant_briers) - np.mean(model_briers)),
        "modelVsBatterOnlyAverageBrierImprovement": float(np.mean(batter_briers) - np.mean(model_briers)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--batter-root", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V48_CONTRACT_SCHEMA_INVALID")

    seasons = [contract["dataBoundary"]["modelFitSeason"], contract["dataBoundary"]["validationSeason"], *contract["dataBoundary"]["retrospectiveEvaluationSeasons"]]
    records, custody = [], {}
    for season in seasons:
        season_rows, season_custody = build_season_rows(args.root, args.batter_root, season, contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    features = tuple(contract["features"]["exactly"])
    train = frame[frame["season"] == "2022"].copy()
    validation = frame[frame["season"] == "2023"].copy()
    evaluation = frame[frame["season"].isin(["2024", "2025", "2026_YTD"])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit("V48_EMPTY_PARTITION")

    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)]))
    y_train = train["runs"].to_numpy(dtype=float)
    model_cfg = contract["model"]
    model = PoissonRegressor(alpha=float(model_cfg["poissonAlpha"]), max_iter=int(model_cfg["maxIter"]))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(value) for value in model_cfg["fixedHalfRunsLines"]]
    line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = evaluate(validation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    evaluation_metrics = evaluate(evaluation, features, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    by_season = {season: evaluate(frame[frame["season"] == season].copy(), features, imputer, scaler, model, dispersion, train_mean, line_probs, lines) for season in ["2023", "2024", "2025", "2026_YTD"]}

    checks = {
        "validationDevianceBeatsConstant": validation_metrics["modelVsConstantDevianceImprovement"] > 0,
        "validationDevianceBeatsBatterOnly": validation_metrics["modelVsBatterOnlyDevianceImprovement"] > 0,
        "validationBrierBeatsConstant": validation_metrics["modelVsConstantAverageBrierImprovement"] > 0,
        "validationBrierBeatsBatterOnly": validation_metrics["modelVsBatterOnlyAverageBrierImprovement"] > 0,
        "evaluationDevianceBeatsConstant": evaluation_metrics["modelVsConstantDevianceImprovement"] > 0,
        "evaluationDevianceBeatsBatterOnly": evaluation_metrics["modelVsBatterOnlyDevianceImprovement"] > 0,
        "evaluationBrierBeatsConstant": evaluation_metrics["modelVsConstantAverageBrierImprovement"] > 0,
        "evaluationBrierBeatsBatterOnly": evaluation_metrics["modelVsBatterOnlyAverageBrierImprovement"] > 0,
    }
    passed = all(checks.values())
    classification = contract["candidateRubric"]["passingClassification"] if passed else contract["candidateRubric"]["failureClassification"]
    counts = Counter(frame["officialDate"])
    frozen_slots = sum(row["frozenPregameStartingBatterSlots"] for row in custody.values())

    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "candidateRubricPassed": passed,
        "parent": {
            "v41Classification": contract["parentEvidence"]["v41CertificationRequired"],
            "v41WorkflowRunId": contract["parentEvidence"]["v41WorkflowRunId"],
            "v41ArtifactId": contract["parentEvidence"]["v41ArtifactId"],
            "v41FiveSeasonCustodyDigest": contract["parentEvidence"]["v41FiveSeasonCustodyDigest"],
            "priorBatterRbiClosure": contract["parentEvidence"]["priorBatterRbiClosure"],
        },
        "data": {"scoredRows": int(len(frame)), "custodyBySeason": custody, "featureCount": len(features), "features": list(features), "sameDateHistoryAllowed": False, "seasonHistoryReset": True},
        "model": {
            "providerMarketKey": "batter_runs_scored",
            "canonicalResearchMarketType": "BATTER_RUNS_SCORED",
            "trainingSeason": "2022",
            "trainingRows": int(len(train)),
            "trainingMeanRuns": train_mean,
            "poissonAlpha": float(model_cfg["poissonAlpha"]),
            "maxIter": int(model_cfg["maxIter"]),
            "nb2Dispersion": float(dispersion),
            "fixedHalfRunsLines": lines,
            "featureSearchUsed": False,
            "modelSearchUsed": False,
            "hyperparameterSearchUsed": False,
            "lineSearchUsed": False,
            "coefficientsDescriptiveNotSelectionInput": {features[index]: float(model.coef_[index]) for index in range(len(features))},
        },
        "baselines": {
            "constantMeanRuns": train_mean,
            "batterOnlyFormula": contract["baselines"]["batterOnlyMechanistic"],
            "sharedTrainingOnlyNb2Dispersion": float(dispersion),
            "constantFixedLineOverProbabilities": {str(key): value for key, value in line_probs.items()},
        },
        "validation2023": validation_metrics,
        "evaluation2024_2026Ytd": evaluation_metrics,
        "bySeasonDescriptiveOnly": by_season,
        "candidateRubricChecks": checks,
        "volumeDiagnostics": {
            "eligibleSlateDays": len(counts),
            "eligibleStartingBatterOutcomes": int(len(frame)),
            "frozenPregameStartingBatterSlots": int(frozen_slots),
            "eligibilityShare": len(frame) / frozen_slots if frozen_slots else 0.0,
            "meanEligibleBatterOutcomesPerSlateDay": float(np.mean(list(counts.values()))),
            "medianEligibleBatterOutcomesPerSlateDay": float(np.median(list(counts.values()))),
            "note": "Eligible starting-batter outcomes are research observations, not bet candidates.",
        },
        "marketBoundary": {
            "providerMarketKey": "batter_runs_scored",
            "repositoryRegistryFamily": "BATTER_PROP",
            "hardRockFloridaPerEventAvailabilityEstablished": False,
            "productionRegistryChanged": False,
            "historicalBatterRunsScoredPricesUsed": False,
            "positiveEvEstablished": False,
            "priceCaptureAuthorized": False,
            "productionPromotionAuthorized": False,
        },
        "policy": {
            "sameDateOutcomeLeakageAllowed": False,
            "futureGameDataAllowed": False,
            "featureSearchUsed": False,
            "modelSearchUsed": False,
            "hyperparameterSearchUsed": False,
            "lineSearchUsed": False,
            "thresholdSearchUsed": False,
            "subsetMiningUsed": False,
            "postResultRuleChangeUsed": False,
            "priorClosedModelsRetuned": False,
            "productionMarketRegistryChanged": False,
            "liveLookupAuthorizationChanged": False,
            "liveMarketDiscoveryChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({"classification": classification, "candidateRubricPassed": passed, "validation2023": validation_metrics, "evaluation2024_2026Ytd": evaluation_metrics, "bySeason": by_season, "candidateRubricChecks": checks, "volumeDiagnostics": report["volumeDiagnostics"]}, indent=2))


if __name__ == "__main__":
    main()
