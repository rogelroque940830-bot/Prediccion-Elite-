#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os
from collections import defaultdict
from types import SimpleNamespace

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = "courtedge-mlb-nrfi-yrfi-half-inning-hazard.v1"
CONTRACT_SCHEMA = "courtedge-mlb-nrfi-yrfi-half-inning-hazard-contract.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_SEASONS = ("2022", "2023", *EVAL_SEASONS)


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


def valid_positive_int(value):
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def audit_valid(audit):
    return bool(audit and audit.get("identityOk") and audit.get("sourceHistorical") and audit.get("pregame"))


def probable_ids(audit):
    if not audit_valid(audit) or not audit.get("probableBothKnown"):
        return None, None
    home = valid_positive_int(audit.get("homeProbablePitcherId"))
    away = valid_positive_int(audit.get("awayProbablePitcherId"))
    return (home, away) if home is not None and away is not None else (None, None)


def complete_lineup(lineup, audit):
    if not audit_valid(audit) or not lineup or not lineup.get("complete"):
        return None, None
    try:
        home = [int(v) for v in lineup.get("homeBattingOrder", [])]
        away = [int(v) for v in lineup.get("awayBattingOrder", [])]
    except Exception:
        return None, None
    if len(home) != 9 or len(away) != 9 or len(set(home)) != 9 or len(set(away)) != 9:
        return None, None
    if min(home + away) <= 0:
        return None, None
    return home, away


def top3_continuity(current, prior):
    if current is None or prior is None:
        return None
    return len(set(current[:3]).intersection(prior[:3])) / 3.0


def shrunk_binary(successes, trials, prior_mean, prior_strength):
    return (float(successes) + float(prior_strength) * float(prior_mean)) / (float(trials) + float(prior_strength))


def pitcher_line(raw):
    if not raw:
        return None
    pid = valid_positive_int(raw.get("pitcherId"))
    return {"pitcherId": pid} if pid is not None else None


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"NRFI_HALF_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate_binary(y, p, baseline_prob):
    y = np.asarray(y, dtype=int)
    p = np.asarray(p, dtype=float)
    baseline = np.full(len(y), float(baseline_prob), dtype=float)
    model_log = float(log_loss(y, p, labels=[0, 1]))
    baseline_log = float(log_loss(y, baseline, labels=[0, 1]))
    model_brier = float(brier_score_loss(y, p))
    baseline_brier = float(brier_score_loss(y, baseline))
    observed = float(np.mean(y))
    predicted = float(np.mean(p))
    auc = float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None
    return {
        "rows": int(len(y)),
        "observedRate": observed,
        "meanPredictedProbability": predicted,
        "trainingClimatologyProbability": float(baseline_prob),
        "binaryLogLoss": model_log,
        "baselineBinaryLogLoss": baseline_log,
        "logLossImprovement": baseline_log - model_log,
        "brierScore": model_brier,
        "baselineBrierScore": baseline_brier,
        "brierImprovement": baseline_brier - model_brier,
        "rocAuc": auc,
        "absoluteMeanCalibrationBias": abs(predicted - observed),
        "baselineAbsoluteMeanCalibrationBias": abs(float(baseline_prob) - observed),
    }


def build_season_rows(root, season, outcomes, contract):
    base = os.path.join(root, season)
    canonical = load(os.path.join(base, "game-anatomy-feature-table.json"))
    starters_json = load(os.path.join(base, "cohort", "starting-pitcher-history.json"))
    lineups_json = load(os.path.join(base, "cohort", "pregame-lineup-history.json"))
    audit_json = load(os.path.join(base, "t5-audit", "t5-starter-identity-audit.json"))
    if canonical.get("schemaVersion") != BASE_SCHEMA:
        raise SystemExit(f"NRFI_HALF_BASE_SCHEMA_INVALID:{season}")

    starter_map = {int(row["gamePk"]): row for row in starters_json.get("games", [])}
    lineup_map = {int(row["gamePk"]): row for row in lineups_json.get("snapshots", [])}
    audit_map = {int(row["gamePk"]): row for row in audit_json.get("rows", [])}
    canonical_rows = [row for row in canonical.get("rows", []) if row.get("t5PregameValid")]
    by_date = defaultdict(list)
    for row in canonical_rows:
        game_pk = int(row["gamePk"])
        if game_pk in outcomes:
            by_date[str(row["officialDate"])].append(row)

    team_state = defaultdict(lambda: {"games": 0, "scored": 0, "allowed": 0})
    starter_i1_state = defaultdict(lambda: {"games": 0, "allowed": 0})
    prior_lineup = {}
    league_half_trials = 0
    league_half_successes = 0
    team_prior = int(contract["historicalState"]["teamI1PriorStrengthHalfInnings"])
    starter_prior = int(contract["historicalState"]["starterI1PriorStrengthGames"])
    opening_prior = float(contract["historicalState"]["openingDayFallbackPriorMean"])
    rows = []
    games = []
    label_mismatch = 0

    for official_date in sorted(by_date):
        day_games = sorted(by_date[official_date], key=lambda row: int(row["gamePk"]))
        league_i1_mean = league_half_successes / league_half_trials if league_half_trials else opening_prior

        for raw in day_games:
            game_pk = int(raw["gamePk"])
            home_id = int(raw["homeTeamId"])
            away_id = int(raw["awayTeamId"])
            outcome = outcomes[game_pk]
            if int(outcome["homeTeamId"]) != home_id or int(outcome["awayTeamId"]) != away_id:
                raise SystemExit(f"NRFI_HALF_TEAM_JOIN_DRIFT:{season}:{game_pk}")
            if str(outcome["officialDate"]) != official_date:
                raise SystemExit(f"NRFI_HALF_DATE_JOIN_DRIFT:{season}:{game_pk}")
            canonical_i1 = raw.get("outcomes", {}).get("FIRST_INNING")
            if isinstance(canonical_i1, dict):
                if int(canonical_i1["homeRuns"]) != int(outcome["homeRuns"]) or int(canonical_i1["awayRuns"]) != int(outcome["awayRuns"]):
                    label_mismatch += 1

            audit = audit_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            current_home_order, current_away_order = complete_lineup(lineup_map.get(game_pk), audit)
            hs = team_state[home_id]
            aws = team_state[away_id]
            full = raw.get("features") or {}

            home_starter_rate = None
            if home_probable is not None:
                st = starter_i1_state[home_probable]
                home_starter_rate = shrunk_binary(st["allowed"], st["games"], league_i1_mean, starter_prior)
            away_starter_rate = None
            if away_probable is not None:
                st = starter_i1_state[away_probable]
                away_starter_rate = shrunk_binary(st["allowed"], st["games"], league_i1_mean, starter_prior)

            top = {
                "season": season,
                "officialDate": official_date,
                "gamePk": game_pk,
                "half": "TOP",
                "target": int(int(outcome["awayRuns"]) > 0),
                "batting_offense_i1_score_rate_shrunk": shrunk_binary(aws["scored"], aws["games"], league_i1_mean, team_prior),
                "defending_team_i1_allow_rate_shrunk": shrunk_binary(hs["allowed"], hs["games"], league_i1_mean, team_prior),
                "opposing_starter_i1_allow_rate_shrunk": home_starter_rate,
                "batting_team_rs10": float(full["away_team_rs10"]) if finite(full.get("away_team_rs10")) else None,
                "defending_team_ra10": float(full["home_team_ra10"]) if finite(full.get("home_team_ra10")) else None,
                "batting_top3_continuity": top3_continuity(current_away_order, prior_lineup.get(away_id)),
                "batting_lineup_exposure_rate": float(full["away_lineup_exposure_rate"]) if finite(full.get("away_lineup_exposure_rate")) else None,
                "opposing_starter_erbf": float(full["home_starter_erbf"]) if finite(full.get("home_starter_erbf")) else None,
                "opposing_starter_hrbf": float(full["home_starter_hrbf"]) if finite(full.get("home_starter_hrbf")) else None,
                "opposing_starter_kbb": float(full["home_starter_kbb"]) if finite(full.get("home_starter_kbb")) else None,
                "opposing_probable_prior_bf": float(full["home_probable_prior_bf"]) if finite(full.get("home_probable_prior_bf")) else None,
                "batting_is_home": 0.0,
            }
            bottom = {
                "season": season,
                "officialDate": official_date,
                "gamePk": game_pk,
                "half": "BOTTOM",
                "target": int(int(outcome["homeRuns"]) > 0),
                "batting_offense_i1_score_rate_shrunk": shrunk_binary(hs["scored"], hs["games"], league_i1_mean, team_prior),
                "defending_team_i1_allow_rate_shrunk": shrunk_binary(aws["allowed"], aws["games"], league_i1_mean, team_prior),
                "opposing_starter_i1_allow_rate_shrunk": away_starter_rate,
                "batting_team_rs10": float(full["home_team_rs10"]) if finite(full.get("home_team_rs10")) else None,
                "defending_team_ra10": float(full["away_team_ra10"]) if finite(full.get("away_team_ra10")) else None,
                "batting_top3_continuity": top3_continuity(current_home_order, prior_lineup.get(home_id)),
                "batting_lineup_exposure_rate": float(full["home_lineup_exposure_rate"]) if finite(full.get("home_lineup_exposure_rate")) else None,
                "opposing_starter_erbf": float(full["away_starter_erbf"]) if finite(full.get("away_starter_erbf")) else None,
                "opposing_starter_hrbf": float(full["away_starter_hrbf"]) if finite(full.get("away_starter_hrbf")) else None,
                "opposing_starter_kbb": float(full["away_starter_kbb"]) if finite(full.get("away_starter_kbb")) else None,
                "opposing_probable_prior_bf": float(full["away_probable_prior_bf"]) if finite(full.get("away_probable_prior_bf")) else None,
                "batting_is_home": 1.0,
            }
            rows.extend([top, bottom])
            games.append({
                "season": season,
                "officialDate": official_date,
                "gamePk": game_pk,
                "yrfi": int(outcome["yrfi"]),
            })

        # Strict temporal boundary: update all states only after every game on the date was scored.
        for raw in day_games:
            game_pk = int(raw["gamePk"])
            home_id = int(raw["homeTeamId"])
            away_id = int(raw["awayTeamId"])
            outcome = outcomes[game_pk]
            home_runs = int(outcome["homeRuns"])
            away_runs = int(outcome["awayRuns"])
            hs = team_state[home_id]
            hs["games"] += 1
            hs["scored"] += int(home_runs > 0)
            hs["allowed"] += int(away_runs > 0)
            aws = team_state[away_id]
            aws["games"] += 1
            aws["scored"] += int(away_runs > 0)
            aws["allowed"] += int(home_runs > 0)
            league_half_trials += 2
            league_half_successes += int(home_runs > 0) + int(away_runs > 0)

            starter_game = starter_map.get(game_pk)
            if starter_game:
                home_line = pitcher_line(starter_game.get("homeStarter"))
                away_line = pitcher_line(starter_game.get("awayStarter"))
                if home_line is not None:
                    starter_i1_state[home_line["pitcherId"]]["games"] += 1
                    starter_i1_state[home_line["pitcherId"]]["allowed"] += int(away_runs > 0)
                if away_line is not None:
                    starter_i1_state[away_line["pitcherId"]]["games"] += 1
                    starter_i1_state[away_line["pitcherId"]]["allowed"] += int(home_runs > 0)

            audit = audit_map.get(game_pk)
            current_home_order, current_away_order = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home_order is not None:
                prior_lineup[home_id] = current_home_order
            if current_away_order is not None:
                prior_lineup[away_id] = current_away_order

    return rows, games, {
        "canonicalT5Rows": len(canonical_rows),
        "outcomeJoinedGames": len(games),
        "halfInningRows": len(rows),
        "step12v3VsV26FirstInningLabelMismatches": label_mismatch,
    }


def add_predictions(half_frame, feature_names, imputer, scaler, model):
    copy = half_frame.copy()
    X = scaler.transform(imputer.transform(copy[list(feature_names)]))
    copy["probability"] = model.predict_proba(X)[:, 1]
    return copy


def game_predictions(half_predictions, game_frame):
    rows = []
    for (season, game_pk), group in half_predictions.groupby(["season", "gamePk"], sort=False):
        if len(group) != 2 or set(group["half"]) != {"TOP", "BOTTOM"}:
            raise SystemExit(f"NRFI_HALF_GAME_PAIR_INVALID:{season}:{game_pk}")
        top = group[group["half"] == "TOP"].iloc[0]
        bottom = group[group["half"] == "BOTTOM"].iloc[0]
        game = game_frame[(game_frame["season"] == season) & (game_frame["gamePk"] == game_pk)]
        if len(game) != 1:
            raise SystemExit(f"NRFI_HALF_GAME_TARGET_INVALID:{season}:{game_pk}")
        target = int(game.iloc[0]["yrfi"])
        p_top = float(top["probability"])
        p_bottom = float(bottom["probability"])
        p_nrfi = (1.0 - p_top) * (1.0 - p_bottom)
        p_yrfi = 1.0 - p_nrfi
        rows.append({
            "season": season,
            "officialDate": str(top["officialDate"]),
            "gamePk": int(game_pk),
            "yrfi": target,
            "topScoreProbability": p_top,
            "bottomScoreProbability": p_bottom,
            "yrfiProbability": p_yrfi,
            "nrfiProbability": p_nrfi,
        })
    return pd.DataFrame.from_records(rows)


def selected_candidate(row, baseline_yrfi, min_probability):
    p_yrfi = float(row["yrfiProbability"])
    p_nrfi = float(row["nrfiProbability"])
    base_nrfi = 1.0 - baseline_yrfi
    yrfi_score = p_yrfi - baseline_yrfi
    nrfi_score = p_nrfi - base_nrfi
    if yrfi_score >= nrfi_score:
        side, probability, score, win = "YRFI", p_yrfi, yrfi_score, int(row["yrfi"]) == 1
    else:
        side, probability, score, win = "NRFI", p_nrfi, nrfi_score, int(row["yrfi"]) == 0
    if score <= 0 or probability < min_probability:
        return None
    return {
        "season": row["season"],
        "officialDate": row["officialDate"],
        "gamePk": int(row["gamePk"]),
        "side": side,
        "modelProbability": probability,
        "qualityScore": score,
        "outcome": "WIN" if win else "LOSS",
    }


def frontier_stats(parent, candidates, parent_no_play_dates):
    wins = sum(row["outcome"] == "WIN" for row in candidates)
    losses = sum(row["outcome"] == "LOSS" for row in candidates)
    dates = {row["officialDate"] for row in candidates}
    rescue = dates & parent_no_play_dates
    hit = wins / len(candidates) if candidates else None
    mean_p = float(np.mean([row["modelProbability"] for row in candidates])) if candidates else None
    return {
        "candidates": len(candidates),
        "distinctCandidateDates": len(dates),
        "rescuedParentNoPlayDates": len(rescue),
        "wins": wins,
        "losses": losses,
        "hitRate": hit,
        "wilson95": parent.wilson(wins, len(candidates)),
        "meanPredictedProbability": mean_p,
        "absoluteCalibrationGap": abs(hit - mean_p) if hit is not None and mean_p is not None else None,
        "rescuedDates": sorted(rescue),
    }


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "contract", "v26-outcomes", "v26-report", "v27-report", "modular-report",
        "v16-manifest", "v68-contract", "classifier-source", "router-source", "v69-contract", "v69-scorer",
        "parent-multi-market-scorer", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("NRFI_HALF_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "RETROSPECTIVE_HALF_INNING_HAZARD_DISCOVERY_AFTER_THREE_GLOBAL_NRFI_YRFI_REJECTIONS_PROSPECTIVE_CONFIRMATION_REQUIRED":
        raise SystemExit("NRFI_HALF_CONTRACT_STATUS_INVALID")

    v26_report = load(args.v26_report)
    v27_report = load(args.v27_report)
    modular_report = load(args.modular_report)
    if v26_report.get("classification") != contract["parentEvidence"]["v26"]["requiredClassification"]:
        raise SystemExit("NRFI_HALF_V26_PARENT_INVALID")
    if v27_report.get("classification") != contract["parentEvidence"]["v27"]["requiredClassification"]:
        raise SystemExit("NRFI_HALF_V27_PARENT_INVALID")
    modular_validation = modular_report.get("firstInningRuns", {}).get("validation", {})
    if modular_validation.get("validationQualified") is not False:
        raise SystemExit("NRFI_HALF_MODULAR_PARENT_NOT_REJECTED")
    expected_brier = float(contract["parentEvidence"]["modularGlobalRetry"]["requiredValidationBrierImprovement"])
    if not math.isclose(float(modular_validation.get("brierImprovement")), expected_brier, rel_tol=0, abs_tol=1e-15):
        raise SystemExit("NRFI_HALF_MODULAR_PARENT_BRIER_DRIFT")

    outcomes_json = load(args.v26_outcomes)
    outcomes = {int(row["gamePk"]): row for row in outcomes_json.get("rows", [])}
    if len(outcomes) != int(outcomes_json["acquisition"]["outcomeCompleteGames"]):
        raise SystemExit("NRFI_HALF_OUTCOME_MAP_DRIFT")

    half_records = []
    game_records = []
    custody = {}
    for season in ALL_SEASONS:
        half, games, diag = build_season_rows(args.root, season, outcomes, contract)
        half_records.extend(half)
        game_records.extend(games)
        custody[season] = diag
    if any(diag["step12v3VsV26FirstInningLabelMismatches"] != 0 for diag in custody.values()):
        raise SystemExit(f"NRFI_HALF_OFFICIAL_LABEL_PARITY_FAILED:{custody}")

    half_frame = pd.DataFrame.from_records(half_records)
    game_frame = pd.DataFrame.from_records(game_records)
    features = tuple(contract["halfInningFeatures"]["genericRolesExactly"])
    if len(features) != int(contract["halfInningFeatures"]["featureCount"]):
        raise SystemExit("NRFI_HALF_FEATURE_COUNT_DRIFT")

    train = half_frame[half_frame["season"] == "2022"].copy()
    validation = half_frame[half_frame["season"] == "2023"].copy()
    evaluation = half_frame[half_frame["season"].isin(EVAL_SEASONS)].copy()
    cfg = contract["halfInningModel"]
    imputer = SimpleImputer(strategy="median")
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)]))
    y_train = train["target"].to_numpy(dtype=int)
    model = LogisticRegression(
        C=float(cfg["regularizationC"]),
        solver=str(cfg["solver"]),
        max_iter=int(cfg["maxIter"]),
        random_state=int(cfg["randomState"]),
        class_weight=None,
    )
    model.fit(X_train, y_train)
    half_baseline = float(np.mean(y_train))

    all_predictions = add_predictions(half_frame, features, imputer, scaler, model)
    half_validation = evaluate_binary(
        validation["target"].to_numpy(dtype=int),
        all_predictions[all_predictions["season"] == "2023"]["probability"].to_numpy(dtype=float),
        half_baseline,
    )
    half_evaluation = evaluate_binary(
        evaluation["target"].to_numpy(dtype=int),
        all_predictions[all_predictions["season"].isin(EVAL_SEASONS)]["probability"].to_numpy(dtype=float),
        half_baseline,
    )
    half_by_season = {}
    half_by_half = {}
    for season in ("2023", *EVAL_SEASONS):
        subset = all_predictions[all_predictions["season"] == season]
        half_by_season[season] = evaluate_binary(subset["target"], subset["probability"], half_baseline)
    for half_name in ("TOP", "BOTTOM"):
        train_half = train[train["half"] == half_name]
        baseline = float(np.mean(train_half["target"]))
        half_by_half[half_name] = {}
        for season in ("2023", *EVAL_SEASONS):
            subset = all_predictions[(all_predictions["season"] == season) & (all_predictions["half"] == half_name)]
            half_by_half[half_name][season] = evaluate_binary(subset["target"], subset["probability"], baseline)

    game_predictions_frame = game_predictions(all_predictions, game_frame)
    train_games = game_predictions_frame[game_predictions_frame["season"] == "2022"].copy()
    validation_games = game_predictions_frame[game_predictions_frame["season"] == "2023"].copy()
    evaluation_games = game_predictions_frame[game_predictions_frame["season"].isin(EVAL_SEASONS)].copy()
    game_baseline_yrfi = float(np.mean(train_games["yrfi"]))
    game_validation = evaluate_binary(validation_games["yrfi"], validation_games["yrfiProbability"], game_baseline_yrfi)
    game_evaluation = evaluate_binary(evaluation_games["yrfi"], evaluation_games["yrfiProbability"], game_baseline_yrfi)
    game_by_season = {}
    for season in ("2023", *EVAL_SEASONS):
        subset = game_predictions_frame[game_predictions_frame["season"] == season]
        game_by_season[season] = evaluate_binary(subset["yrfi"], subset["yrfiProbability"], game_baseline_yrfi)

    checks = {
        "halfValidationLogLossBeatsBaseline": half_validation["logLossImprovement"] > 0,
        "halfValidationBrierBeatsBaseline": half_validation["brierImprovement"] > 0,
        "halfValidationRocAucAboveHalf": half_validation["rocAuc"] is not None and half_validation["rocAuc"] > 0.5,
        "gameValidationLogLossBeatsBaseline": game_validation["logLossImprovement"] > 0,
        "gameValidationBrierBeatsBaseline": game_validation["brierImprovement"] > 0,
        "gameValidationRocAucAboveHalf": game_validation["rocAuc"] is not None and game_validation["rocAuc"] > 0.5,
    }
    validation_passed = all(checks.values())

    parent = load_module(args.parent_multi_market_scorer, "nrfi_half_parent_multi_market")
    eligible_dates = set(evaluation_games["officialDate"].astype(str))
    parent_args = SimpleNamespace(
        root=args.root,
        custody="UNUSED_BY_RECONSTRUCTION",
        v16_manifest=args.v16_manifest,
        v68_contract=args.v68_contract,
        classifier_source=args.classifier_source,
        router_source=args.router_source,
        v69_contract=args.v69_contract,
        v69_scorer=args.v69_scorer,
        out=args.out,
    )
    # Parent helper only uses the immutable feature root plus listed V16/V68/V69 sources.
    parent_active_dates, parent_no_play_dates = parent.reconstruct_parent_active_dates(parent_args, eligible_dates)

    frontier_report = {
        "status": "NOT_EVALUATED_VALIDATION_GATE_FAILED",
        "thresholds": {},
        "frontiers": {},
        "combinedOpportunityCoverage": {},
    }
    if validation_passed:
        min_probability = float(contract["candidateFrontiers"]["minimumSelectedSideProbability"])
        val_candidates = []
        for row in validation_games.to_dict("records"):
            cand = selected_candidate(row, game_baseline_yrfi, min_probability)
            if cand is not None:
                val_candidates.append(cand)
        scores = [row["qualityScore"] for row in val_candidates]
        if not scores:
            raise SystemExit("NRFI_HALF_NO_VALIDATION_FRONTIER_SCORES")
        thresholds = {
            f"Q{int(q*100)}": float(np.quantile(scores, q, method="linear"))
            for q in contract["candidateFrontiers"]["quantilesFrom2023PositiveEligibleScoresExactly"]
        }
        eval_selected = []
        for row in evaluation_games.to_dict("records"):
            cand = selected_candidate(row, game_baseline_yrfi, min_probability)
            if cand is not None:
                eval_selected.append(cand)
        reports = {}
        coverage = {}
        for qkey, threshold in thresholds.items():
            candidates = [row for row in eval_selected if row["qualityScore"] + 1e-15 >= threshold]
            stats = frontier_stats(parent, candidates, parent_no_play_dates)
            reports[qkey] = stats
            rescued = set(stats["rescuedDates"])
            combined = parent_active_dates | rescued
            coverage[qkey] = {
                "parentActiveDates": len(parent_active_dates),
                "rescuedParentNoPlayDates": len(rescued),
                "combinedOpportunityDates": len(combined),
                "eligibleSlateDates": len(eligible_dates),
                "combinedOpportunityCoveragePct": 100.0 * len(combined) / len(eligible_dates),
                "remainingNoPlayDates": len(eligible_dates - combined),
            }
        frontier_report = {
            "status": "EVALUATED_AFTER_VALIDATION_GATE_PASS",
            "validationEligibleScores": len(scores),
            "thresholds": thresholds,
            "frontiers": reports,
            "combinedOpportunityCoverage": coverage,
        }

    classification = (
        "NRFI_YRFI_HALF_INNING_HAZARD_RETROSPECTIVE_ROBUSTNESS_CANDIDATE_ONLY"
        if validation_passed
        else "NRFI_YRFI_HALF_INNING_HAZARD_REJECTED"
    )
    coefficient_map = {features[i]: float(model.coef_[0][i]) for i in range(len(features))}
    report = {
        "schemaVersion": REPORT_SCHEMA,
        "classification": classification,
        "validationGatePassed": validation_passed,
        "parentEvidence": {
            "v26Classification": v26_report["classification"],
            "v27Classification": v27_report["classification"],
            "modularGlobalRetryValidationQualified": modular_validation["validationQualified"],
            "modularGlobalRetryValidationBrierImprovement": modular_validation["brierImprovement"],
        },
        "data": {
            "custodyBySeason": custody,
            "trainingGames2022": int(len(train_games)),
            "trainingHalfInningRows2022": int(len(train)),
            "validationGames2023": int(len(validation_games)),
            "validationHalfInningRows2023": int(len(validation)),
            "evaluationGames": int(len(evaluation_games)),
            "evaluationHalfInningRows": int(len(evaluation)),
            "featureCount": len(features),
            "features": list(features),
        },
        "model": {
            "family": cfg["family"],
            "sharedAcrossTopAndBottom": True,
            "trainingHalfInningClimatology": half_baseline,
            "trainingGameYrfiClimatology": game_baseline_yrfi,
            "regularizationC": float(cfg["regularizationC"]),
            "solver": cfg["solver"],
            "maxIter": int(cfg["maxIter"]),
            "coefficientsDescriptiveOnly": coefficient_map,
            "featureSearchUsed": False,
            "modelSearchUsed": False,
            "hyperparameterSearchUsed": False,
            "postHocGameCalibrationUsed": False,
        },
        "halfInningValidation2023": half_validation,
        "halfInningEvaluation2024_2026Ytd": half_evaluation,
        "halfInningBySeason": half_by_season,
        "topBottomDescriptive": half_by_half,
        "gameLevelValidation2023": game_validation,
        "gameLevelEvaluation2024_2026Ytd": game_evaluation,
        "gameLevelBySeason": game_by_season,
        "validationGateChecks": checks,
        "candidateFrontiers": frontier_report,
        "scientificBoundary": {
            "retrospective2024To2026IsIndependentConfirmation": False,
            "prospectiveConfirmationRequired": True,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
            "productionChanged": False,
            "currentAPlusPremiumHierarchyChanged": False,
            "forcedDailyPlayAllowed": False,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        "classification": classification,
        "validationGatePassed": validation_passed,
        "data": report["data"],
        "halfInningValidation2023": half_validation,
        "gameLevelValidation2023": game_validation,
        "halfInningEvaluation2024_2026Ytd": half_evaluation,
        "gameLevelEvaluation2024_2026Ytd": game_evaluation,
        "validationGateChecks": checks,
        "candidateFrontiers": frontier_report,
    }, indent=2))


if __name__ == "__main__":
    main()
