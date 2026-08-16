#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-p0-step12v57-lineup-offensive-impact.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v57-lineup-offensive-impact-contract.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
BATTER_SCHEMA = "courtedge-mlb-historical-batter-history.v1"
V20_SCHEMA = "courtedge-p0-step12v20-team-total-count-model.v1"


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


def safe_float(value):
    return float(value) if finite(value) else None


def empty_batter_state():
    return {
        "pa": 0.0,
        "h": 0.0,
        "tb": 0.0,
        "bb": 0.0,
        "k": 0.0,
        "hr": 0.0,
    }


def empty_slot_state():
    return {"starts": 0.0, "pa": 0.0}


def add_batter_line(state, line):
    pa = int(line.get("plateAppearances", 0))
    if pa <= 0:
        return
    state["pa"] += pa
    state["h"] += int(line.get("hits", 0))
    state["tb"] += int(line.get("totalBases", 0))
    state["bb"] += int(line.get("baseOnBalls", 0))
    state["k"] += int(line.get("strikeOuts", 0))
    state["hr"] += int(line.get("homeRuns", 0))


def league_rates(state):
    if state["pa"] <= 0:
        return None
    pa = state["pa"]
    return {
        "h": state["h"] / pa,
        "tb": state["tb"] / pa,
        "bb": state["bb"] / pa,
        "k": state["k"] / pa,
        "hr": state["hr"] / pa,
    }


def shrunk_rate(numerator, denominator, league_rate, prior_pa):
    return (float(numerator) + float(prior_pa) * float(league_rate)) / (
        float(denominator) + float(prior_pa)
    )


def shrunk_mean(total, trials, league_mean, prior_trials):
    return (float(total) + float(prior_trials) * float(league_mean)) / (
        float(trials) + float(prior_trials)
    )


def complete_lineup(snapshot):
    if not snapshot or not snapshot.get("complete"):
        return None, None
    try:
        home = [int(value) for value in snapshot.get("homeBattingOrder", [])]
        away = [int(value) for value in snapshot.get("awayBattingOrder", [])]
    except Exception:
        return None, None
    if (
        len(home) != 9
        or len(away) != 9
        or len(set(home)) != 9
        or len(set(away)) != 9
        or min(home + away) <= 0
    ):
        return None, None
    return home, away


def slot_expected_pa(slot_state, global_slot_state, prior_starts):
    if global_slot_state["starts"] <= 0:
        return None
    league_mean = global_slot_state["pa"] / global_slot_state["starts"]
    return shrunk_mean(
        slot_state["pa"],
        slot_state["starts"],
        league_mean,
        prior_starts,
    )


def lineup_impact(lineup, batter_state, league_prior, slot_state, global_slot_state, prior_pa, prior_starts):
    names = (
        "lineup_expected_hits",
        "lineup_expected_total_bases",
        "lineup_expected_walks",
        "lineup_expected_strikeouts",
        "lineup_expected_home_runs",
    )
    if league_prior is None:
        return {name: None for name in names}

    totals = {name: 0.0 for name in names}
    for slot, batter_id in enumerate(lineup, 1):
        expected_pa = slot_expected_pa(slot_state[slot], global_slot_state, prior_starts)
        if expected_pa is None:
            return {name: None for name in names}
        state = batter_state[int(batter_id)]
        rates = {
            "lineup_expected_hits": shrunk_rate(state["h"], state["pa"], league_prior["h"], prior_pa),
            "lineup_expected_total_bases": shrunk_rate(state["tb"], state["pa"], league_prior["tb"], prior_pa),
            "lineup_expected_walks": shrunk_rate(state["bb"], state["pa"], league_prior["bb"], prior_pa),
            "lineup_expected_strikeouts": shrunk_rate(state["k"], state["pa"], league_prior["k"], prior_pa),
            "lineup_expected_home_runs": shrunk_rate(state["hr"], state["pa"], league_prior["hr"], prior_pa),
        }
        for name, rate in rates.items():
            totals[name] += float(rate) * float(expected_pa)
    return totals


def build_rows(root, batter_root, season, contract):
    base = os.path.join(root, season)
    batter_base = os.path.join(batter_root, season)
    table = load(os.path.join(base, "game-anatomy-feature-table.json"))
    lineups = load(os.path.join(base, "cohort", "pregame-lineup-history.json"))
    batter_history = load(os.path.join(batter_base, "batter-history.json"))
    if table.get("schemaVersion") != BASE_SCHEMA:
        raise SystemExit(f"V57_BASE_SCHEMA_INVALID:{season}")
    if batter_history.get("schemaVersion") != BATTER_SCHEMA:
        raise SystemExit(f"V57_BATTER_SCHEMA_INVALID:{season}")

    base_features = tuple(contract["control"]["featuresExactly"])
    canonical = [row for row in table.get("rows", []) if row.get("t5PregameValid")]
    expected_rows = int(contract["dataBoundary"]["expectedControlRowsBySeason"][season])
    if len(canonical) != expected_rows:
        raise SystemExit(f"V57_CONTROL_ROW_DRIFT:{season}:{len(canonical)}:{expected_rows}")

    lineup_map = {int(row["gamePk"]): row for row in lineups.get("snapshots", [])}
    batter_game_map = {int(row["gamePk"]): row for row in batter_history.get("games", [])}
    by_date = defaultdict(list)
    for row in canonical:
        by_date[str(row["officialDate"])].append(row)

    batter_state = defaultdict(empty_batter_state)
    league_state = empty_batter_state()
    slot_state = defaultdict(empty_slot_state)
    global_slot_state = empty_slot_state()
    prior_pa = float(contract["playerPriorEngineering"]["batterRateShrinkagePriorPlateAppearances"])
    prior_starts = float(contract["playerPriorEngineering"]["lineupSlotWorkloadShrinkagePriorStarts"])

    rows = []
    complete_games = 0
    slots = 0
    prior_available_games = 0

    for official_date in sorted(by_date):
        games = sorted(by_date[official_date], key=lambda row: int(row["gamePk"]))
        current_league = league_rates(league_state)

        # Score the entire official date from strictly prior-date state.
        for raw in games:
            game_pk = int(raw["gamePk"])
            home_lineup, away_lineup = complete_lineup(lineup_map.get(game_pk))
            if home_lineup is None or away_lineup is None:
                raise SystemExit(f"V57_COMPLETE_T5_LINEUP_REQUIRED:{season}:{game_pk}")
            batter_game = batter_game_map.get(game_pk)
            if batter_game is None:
                raise SystemExit(f"V57_BATTER_GAME_REQUIRED:{season}:{game_pk}")

            complete_games += 1
            slots += 18
            home_impact = lineup_impact(
                home_lineup,
                batter_state,
                current_league,
                slot_state,
                global_slot_state,
                prior_pa,
                prior_starts,
            )
            away_impact = lineup_impact(
                away_lineup,
                batter_state,
                current_league,
                slot_state,
                global_slot_state,
                prior_pa,
                prior_starts,
            )
            if all(finite(value) for value in home_impact.values()) and all(
                finite(value) for value in away_impact.values()
            ):
                prior_available_games += 1

            outcome = raw["outcomes"]["FULL_GAME"]
            feature_values = raw.get("features") or {}
            row = {
                "season": season,
                "officialDate": official_date,
                "gamePk": game_pk,
                "home_runs": int(outcome["homeRuns"]),
                "away_runs": int(outcome["awayRuns"]),
            }
            for feature in base_features:
                row[feature] = safe_float(feature_values.get(feature))
            for name, value in home_impact.items():
                row[f"home_{name}"] = safe_float(value)
            for name, value in away_impact.items():
                row[f"away_{name}"] = safe_float(value)
            rows.append(row)

        # Only now may this official date update batter and slot state.
        for raw in games:
            game_pk = int(raw["gamePk"])
            home_lineup, away_lineup = complete_lineup(lineup_map.get(game_pk))
            batter_game = batter_game_map.get(game_pk)
            if home_lineup is None or away_lineup is None or batter_game is None:
                raise SystemExit(f"V57_DATE_UPDATE_INPUT_MISSING:{season}:{game_pk}")

            for side_key in ("homeBatters", "awayBatters"):
                for line in batter_game.get(side_key, []):
                    if int(line.get("plateAppearances", 0)) <= 0:
                        continue
                    batter_id = int(line["batterId"])
                    add_batter_line(batter_state[batter_id], line)
                    add_batter_line(league_state, line)

            for side_key, lineup in (("homeBatters", home_lineup), ("awayBatters", away_lineup)):
                side_lines = {
                    int(line["batterId"]): line
                    for line in batter_game.get(side_key, [])
                }
                for slot, batter_id in enumerate(lineup, 1):
                    line = side_lines.get(int(batter_id))
                    if line is None or int(line.get("plateAppearances", 0)) <= 0:
                        continue
                    pa = int(line["plateAppearances"])
                    slot_state[slot]["starts"] += 1
                    slot_state[slot]["pa"] += pa
                    global_slot_state["starts"] += 1
                    global_slot_state["pa"] += pa

    return rows, {
        "controlRows": len(canonical),
        "completeT5LineupGames": complete_games,
        "frozenStartingSlots": slots,
        "gamesWithAllFiveLineupFeaturesAvailablePregame": prior_available_games,
        "gamesWithOpeningDateOrOtherPregameMissingLineupFeatures": complete_games - prior_available_games,
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu**2))
    if denominator <= 0:
        raise SystemExit("V57_NB2_DENOMINATOR_INVALID")
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    mu = max(float(mu), 1e-9)
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def poisson_deviance_rows(y, mu):
    y = np.asarray(y, dtype=float)
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    out = np.empty_like(y, dtype=float)
    zero = y == 0
    out[zero] = 2.0 * mu[zero]
    nz = ~zero
    out[nz] = 2.0 * (y[nz] * np.log(y[nz] / mu[nz]) - y[nz] + mu[nz])
    return out


def brier_rows(y, mu, dispersion, lines):
    y = np.asarray(y, dtype=float)
    rows = []
    for line in lines:
        observed = (y > float(line)).astype(float)
        probs = np.asarray([over_probability(value, dispersion, line) for value in mu], dtype=float)
        rows.append((probs - observed) ** 2)
    return np.mean(np.vstack(rows), axis=0)


def fit_model(train, target_col, features, alpha, max_iter):
    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()
    X_train = imputer.fit_transform(train[list(features)])
    X_train_scaled = scaler.fit_transform(X_train)
    y_train = train[target_col].to_numpy(dtype=float)
    model = PoissonRegressor(alpha=alpha, max_iter=max_iter)
    model.fit(X_train_scaled, y_train)
    train_mu = np.maximum(model.predict(X_train_scaled), 1e-9)
    dispersion = nb2_dispersion(y_train, train_mu)
    return {
        "features": tuple(features),
        "imputer": imputer,
        "scaler": scaler,
        "model": model,
        "dispersion": dispersion,
        "trainingMeanRuns": float(np.mean(y_train)),
    }


def predict(fitted, frame):
    X = fitted["scaler"].transform(
        fitted["imputer"].transform(frame[list(fitted["features"])])
    )
    return np.maximum(fitted["model"].predict(X), 1e-9)


def snapshot(fitted):
    return {
        "featureNames": list(fitted["features"]),
        "medianImpute": [float(x) for x in fitted["imputer"].statistics_],
        "mean": [float(x) for x in fitted["scaler"].mean_],
        "scale": [float(x) for x in fitted["scaler"].scale_],
        "intercept": float(fitted["model"].intercept_),
        "coef": [float(x) for x in fitted["model"].coef_],
        "poissonRegressorAlpha": float(fitted["model"].alpha),
        "nb2Dispersion": float(fitted["dispersion"]),
        "trainingMeanRuns": float(fitted["trainingMeanRuns"]),
    }


def assert_close_vector(label, actual, expected, tolerance=1e-10):
    if len(actual) != len(expected):
        raise SystemExit(f"V57_V20_PARITY_LENGTH:{label}:{len(actual)}:{len(expected)}")
    if not np.allclose(np.asarray(actual, dtype=float), np.asarray(expected, dtype=float), rtol=0.0, atol=tolerance):
        delta = float(np.max(np.abs(np.asarray(actual, dtype=float) - np.asarray(expected, dtype=float))))
        raise SystemExit(f"V57_V20_PARITY_VECTOR:{label}:{delta}")


def verify_v20_snapshot(target_name, fitted, v20_snapshot):
    actual = snapshot(fitted)
    if actual["featureNames"] != v20_snapshot["featureNames"]:
        raise SystemExit(f"V57_V20_FEATURE_PARITY:{target_name}")
    for key in ("medianImpute", "mean", "scale", "coef"):
        assert_close_vector(f"{target_name}:{key}", actual[key], v20_snapshot[key])
    for key in ("intercept", "nb2Dispersion", "trainingMeanRuns"):
        if abs(float(actual[key]) - float(v20_snapshot[key])) > 1e-10:
            raise SystemExit(f"V57_V20_SCALAR_PARITY:{target_name}:{key}:{actual[key]}:{v20_snapshot[key]}")
    if abs(float(actual["poissonRegressorAlpha"]) - float(v20_snapshot["poissonRegressorAlpha"])) > 1e-12:
        raise SystemExit(f"V57_V20_ALPHA_PARITY:{target_name}")
    return True


def evaluate_pair(frame, target_col, control, challenger, lines):
    y = frame[target_col].to_numpy(dtype=float)
    control_mu = predict(control, frame)
    challenger_mu = predict(challenger, frame)
    control_dev = float(mean_poisson_deviance(y, control_mu))
    challenger_dev = float(mean_poisson_deviance(y, challenger_mu))
    control_brier_rows = brier_rows(y, control_mu, control["dispersion"], lines)
    challenger_brier_rows = brier_rows(y, challenger_mu, challenger["dispersion"], lines)
    control_brier = float(np.mean(control_brier_rows))
    challenger_brier = float(np.mean(challenger_brier_rows))
    observed_mean = float(np.mean(y))
    control_mean = float(np.mean(control_mu))
    challenger_mean = float(np.mean(challenger_mu))
    line_diagnostics = {}
    for line in lines:
        observed = (y > line).astype(float)
        cp = np.asarray([over_probability(value, control["dispersion"], line) for value in control_mu])
        hp = np.asarray([over_probability(value, challenger["dispersion"], line) for value in challenger_mu])
        line_diagnostics[str(line)] = {
            "observedOverRate": float(np.mean(observed)),
            "controlMeanOverProbability": float(np.mean(cp)),
            "challengerMeanOverProbability": float(np.mean(hp)),
            "controlBrier": float(np.mean((cp - observed) ** 2)),
            "challengerBrier": float(np.mean((hp - observed) ** 2)),
            "brierImprovement": float(np.mean((cp - observed) ** 2) - np.mean((hp - observed) ** 2)),
        }
    return {
        "rows": int(len(frame)),
        "observedMeanRuns": observed_mean,
        "controlMeanPredictedRuns": control_mean,
        "challengerMeanPredictedRuns": challenger_mean,
        "controlAbsoluteMeanCalibrationBias": abs(control_mean - observed_mean),
        "challengerAbsoluteMeanCalibrationBias": abs(challenger_mean - observed_mean),
        "calibrationBiasImprovement": abs(control_mean - observed_mean) - abs(challenger_mean - observed_mean),
        "controlMeanAbsoluteError": float(mean_absolute_error(y, control_mu)),
        "challengerMeanAbsoluteError": float(mean_absolute_error(y, challenger_mu)),
        "maeImprovement": float(mean_absolute_error(y, control_mu) - mean_absolute_error(y, challenger_mu)),
        "controlMeanPoissonDeviance": control_dev,
        "challengerMeanPoissonDeviance": challenger_dev,
        "poissonDevianceImprovement": control_dev - challenger_dev,
        "controlAverageBrier": control_brier,
        "challengerAverageBrier": challenger_brier,
        "averageBrierImprovement": control_brier - challenger_brier,
        "fixedLineDiagnostics": line_diagnostics,
        "_pairedDevianceImprovementRows": poisson_deviance_rows(y, control_mu) - poisson_deviance_rows(y, challenger_mu),
        "_pairedBrierImprovementRows": control_brier_rows - challenger_brier_rows,
    }


def bootstrap_interval(values, rng, resamples, confidence):
    values = np.asarray(values, dtype=float)
    n = len(values)
    if n <= 0:
        raise SystemExit("V57_BOOTSTRAP_EMPTY")
    means = np.empty(resamples, dtype=float)
    for i in range(resamples):
        idx = rng.integers(0, n, size=n)
        means[i] = float(np.mean(values[idx]))
    alpha = (1.0 - confidence) / 2.0
    return {
        "pointEstimate": float(np.mean(values)),
        "lower": float(np.quantile(means, alpha)),
        "upper": float(np.quantile(means, 1.0 - alpha)),
        "resamples": int(resamples),
        "confidenceLevel": float(confidence),
    }


def strip_private_arrays(metrics):
    return {key: value for key, value in metrics.items() if not key.startswith("_paired")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--batter-root", required=True)
    parser.add_argument("--v20-report", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V57_CONTRACT_SCHEMA_INVALID")
    v20 = load(args.v20_report)
    if v20.get("schemaVersion") != V20_SCHEMA:
        raise SystemExit("V57_V20_REPORT_SCHEMA_INVALID")
    if v20.get("classification") != contract["parentEvidence"]["v20ClassificationRequired"]:
        raise SystemExit("V57_V20_CLASSIFICATION_INVALID")

    seasons = [
        contract["dataBoundary"]["modelFitSeason"],
        contract["dataBoundary"]["validationSeason"],
        *contract["dataBoundary"]["retrospectiveEvaluationSeasons"],
    ]
    all_rows = []
    custody = {}
    for season in seasons:
        season_rows, season_custody = build_rows(args.root, args.batter_root, season, contract)
        all_rows.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(all_rows)
    train = frame[frame.season == contract["dataBoundary"]["modelFitSeason"]].copy()
    validation = frame[frame.season == contract["dataBoundary"]["validationSeason"]].copy()
    eval_seasons = tuple(contract["dataBoundary"]["retrospectiveEvaluationSeasons"])
    evaluation = frame[frame.season.isin(eval_seasons)].copy()
    if train.empty or validation.empty or evaluation.empty:
        raise SystemExit("V57_PARTITION_EMPTY")

    base_features = tuple(contract["control"]["featuresExactly"])
    impact_names = tuple(contract["lineupOffensiveImpact"]["derivedFeaturesPerSideExactly"])
    alpha = float(contract["challenger"]["poissonRegressorAlpha"])
    max_iter = int(contract["challenger"]["poissonRegressorMaxIter"])
    lines = tuple(float(value) for value in contract["probabilityDiagnostics"]["fixedHalfRunLines"])

    targets = {
        "HOME_FULL_GAME_RUNS": {
            "targetCol": "home_runs",
            "sidePrefix": "home_",
        },
        "AWAY_FULL_GAME_RUNS": {
            "targetCol": "away_runs",
            "sidePrefix": "away_",
        },
    }

    snapshots = {}
    validation_results = {}
    evaluation_results = {}
    by_season = {}
    bootstrap_results = {}
    target_checks = {}
    control_parity = {}
    bootstrap_cfg = contract["pairedBootstrap"]
    rng = np.random.default_rng(int(bootstrap_cfg["seed"]))

    for target_name, target_cfg in targets.items():
        target_col = target_cfg["targetCol"]
        challenger_features = base_features + tuple(
            f"{target_cfg['sidePrefix']}{name}" for name in impact_names
        )
        if len(challenger_features) != int(contract["challenger"]["featureCountPerTarget"]):
            raise SystemExit(f"V57_CHALLENGER_FEATURE_COUNT:{target_name}")

        control = fit_model(train, target_col, base_features, alpha, max_iter)
        challenger = fit_model(train, target_col, challenger_features, alpha, max_iter)
        control_parity[target_name] = verify_v20_snapshot(
            target_name, control, v20["modelSnapshots"][target_name]
        )
        snapshots[target_name] = {
            "control": snapshot(control),
            "challenger": snapshot(challenger),
        }

        v_raw = evaluate_pair(validation, target_col, control, challenger, lines)
        e_raw = evaluate_pair(evaluation, target_col, control, challenger, lines)
        validation_results[target_name] = strip_private_arrays(v_raw)
        evaluation_results[target_name] = strip_private_arrays(e_raw)
        by_season[target_name] = {}
        positive_both_seasons = 0
        no_both_worse = True
        for season in eval_seasons:
            part = frame[frame.season == season].copy()
            season_raw = evaluate_pair(part, target_col, control, challenger, lines)
            season_public = strip_private_arrays(season_raw)
            by_season[target_name][season] = season_public
            dev = season_public["poissonDevianceImprovement"]
            brier = season_public["averageBrierImprovement"]
            if dev > 0 and brier > 0:
                positive_both_seasons += 1
            if dev < 0 and brier < 0:
                no_both_worse = False

        bootstrap_results[target_name] = {
            "poissonDevianceImprovement": bootstrap_interval(
                e_raw["_pairedDevianceImprovementRows"],
                rng,
                int(bootstrap_cfg["resamples"]),
                float(bootstrap_cfg["confidenceLevel"]),
            ),
            "averageBrierImprovement": bootstrap_interval(
                e_raw["_pairedBrierImprovementRows"],
                rng,
                int(bootstrap_cfg["resamples"]),
                float(bootstrap_cfg["confidenceLevel"]),
            ),
        }

        v = validation_results[target_name]
        e = evaluation_results[target_name]
        b = bootstrap_results[target_name]
        target_checks[target_name] = {
            "controlSnapshotReproduced": control_parity[target_name] is True,
            "validationPoissonDevianceImproved": v["poissonDevianceImprovement"] > 0,
            "validationAverageBrierImproved": v["averageBrierImprovement"] > 0,
            "validationCalibrationNotWorse": v["challengerAbsoluteMeanCalibrationBias"] <= v["controlAbsoluteMeanCalibrationBias"],
            "evaluationPoissonDevianceImproved": e["poissonDevianceImprovement"] > 0,
            "evaluationAverageBrierImproved": e["averageBrierImprovement"] > 0,
            "evaluationCalibrationNotWorse": e["challengerAbsoluteMeanCalibrationBias"] <= e["controlAbsoluteMeanCalibrationBias"],
            "bootstrapDevianceLowerBoundPositive": b["poissonDevianceImprovement"]["lower"] > 0,
            "bootstrapBrierLowerBoundPositive": b["averageBrierImprovement"]["lower"] > 0,
            "atLeastTwoOfThreeEvaluationSeasonsImproveBoth": positive_both_seasons >= 2,
            "noEvaluationSeasonWorseOnBoth": no_both_worse,
        }

    all_checks = [value for checks in target_checks.values() for value in checks.values()]
    passed = all(all_checks)
    classification = (
        contract["candidateRubric"]["passingClassification"]
        if passed
        else contract["candidateRubric"]["failingClassification"]
    )

    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "scientificStatus": contract["scientificStatus"],
        "data": {
            "seasonRows": {season: int(custody[season]["controlRows"]) for season in seasons},
            "modelFitSeason": contract["dataBoundary"]["modelFitSeason"],
            "validationSeason": contract["dataBoundary"]["validationSeason"],
            "retrospectiveEvaluationSeasons": list(eval_seasons),
            "pairedControlAndChallengerRows": True,
            "custody": custody,
        },
        "features": {
            "controlCount": len(base_features),
            "control": list(base_features),
            "lineupOffensiveImpactPerSideCount": len(impact_names),
            "lineupOffensiveImpactPerSide": list(impact_names),
            "challengerCountPerTarget": int(contract["challenger"]["featureCountPerTarget"]),
        },
        "controlParity": {
            "requiredV20Classification": contract["parentEvidence"]["v20ClassificationRequired"],
            "targetSnapshotReproduced": control_parity,
            "allTargetsReproduced": all(control_parity.values()),
        },
        "modelSnapshots": snapshots,
        "validation2023": validation_results,
        "evaluation2024_2026Ytd": evaluation_results,
        "evaluationBySeason": by_season,
        "pairedBootstrap2024_2026Ytd": bootstrap_results,
        "candidateRubricChecks": target_checks,
        "candidateRubricPassed": passed,
        "winnerObjectiveBoundary": {
            "principalProjectQuestion": contract["winnerObjectiveBoundary"]["principalProjectQuestion"],
            "winnerModelChanged": False,
            "passingOnlyAuthorizesSeparateFrozenWinnerIntegrationExperiment": True,
        },
        "marketBoundary": {
            "historicalTeamTotalPricesUsed": False,
            "positiveEvEstablished": False,
            "liveTeamTotalPromotionAuthorized": False,
        },
        "policy": {
            "researchOnly": True,
            "sameDateOutcomeLeakageAllowed": False,
            "futureGameDataAllowed": False,
            "featureSearchUsed": False,
            "derivedFeatureSearchUsed": False,
            "shrinkageSearchUsed": False,
            "hyperparameterSearchUsed": False,
            "lineSearchUsed": False,
            "subsetMiningUsed": False,
            "postResultRuleChangeAllowed": False,
            "v16Changed": False,
            "liveLookupAuthorizationChanged": False,
            "liveMarketDiscoveryChanged": False,
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
        "candidateRubricPassed": passed,
        "controlParity": report["controlParity"],
        "validation2023": validation_results,
        "evaluation2024_2026Ytd": evaluation_results,
        "pairedBootstrap2024_2026Ytd": bootstrap_results,
        "candidateRubricChecks": target_checks,
    }, indent=2))


if __name__ == "__main__":
    main()
