#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os
from collections import Counter, defaultdict
from types import SimpleNamespace

import numpy as np
from scipy.optimize import minimize

SCHEMA = "courtedge-mlb-modular-team-structure-nrfi-yrfi.v1"
CONTRACT_SCHEMA = "courtedge-mlb-modular-team-structure-nrfi-yrfi-contract.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_SEASONS = ("2022", "2023", *EVAL_SEASONS)
TIERS = ("STRONG", "MIDDLE", "WEAK", "UNSTABLE")


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"MODULAR_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finite(x):
    try:
        value = float(x)
        return value if math.isfinite(value) else math.nan
    except (TypeError, ValueError):
        return math.nan


def fit_binary_logistic(x, y, alpha=1.0, max_iter=12000):
    n, p = x.shape
    z = np.column_stack([np.ones(n), x])
    initial = np.zeros(p + 1, dtype=float)
    rate = min(max(float(np.mean(y)), 1e-6), 1.0 - 1e-6)
    initial[0] = math.log(rate / (1.0 - rate))

    def objective(theta):
        eta = np.clip(z @ theta, -35.0, 35.0)
        prob = 1.0 / (1.0 + np.exp(-eta))
        prob = np.clip(prob, 1e-12, 1.0 - 1e-12)
        loss = -np.mean(y * np.log(prob) + (1.0 - y) * np.log(1.0 - prob))
        loss += (alpha / (2.0 * n)) * np.sum(theta[1:] ** 2)
        grad = (z.T @ (prob - y)) / n
        grad[1:] += (alpha / n) * theta[1:]
        return loss, grad

    result = minimize(
        lambda t: objective(t)[0],
        initial,
        jac=lambda t: objective(t)[1],
        method="L-BFGS-B",
        options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8},
    )
    if not result.success:
        raise SystemExit(f"MODULAR_NRFI_YRFI_FIT_FAILED:{result.message}")
    return result.x


def predict_binary(x, theta):
    z = np.column_stack([np.ones(len(x)), x])
    eta = np.clip(z @ theta, -35.0, 35.0)
    return 1.0 / (1.0 + np.exp(-eta))


def brier_binary(prob, outcome):
    return float(np.mean((np.asarray(prob, dtype=float) - np.asarray(outcome, dtype=float)) ** 2))


def build_standings_snapshots(root, minimum_prior_games):
    snapshots = {}
    season_diagnostics = {}
    for season in ALL_SEASONS:
        table = load(os.path.join(root, season, "game-anatomy-feature-table.json"))
        rows = table["rows"]
        by_date = defaultdict(list)
        for row in rows:
            by_date[str(row["officialDate"])].append(row)
        record = defaultdict(lambda: {"g": 0, "w": 0, "rf": 0, "ra": 0})
        tier_counts = Counter()
        for date in sorted(by_date):
            stable = []
            for team_id, rec in record.items():
                if rec["g"] >= minimum_prior_games:
                    win_pct = rec["w"] / rec["g"]
                    rdpg = (rec["rf"] - rec["ra"]) / rec["g"]
                    stable.append((team_id, win_pct, rdpg))
            stable.sort(key=lambda x: (-x[1], -x[2], x[0]))
            tier_by_team = {}
            n = len(stable)
            for idx, (team_id, _, _) in enumerate(stable):
                frac = idx / n if n else 1.0
                tier = "STRONG" if frac < (1.0 / 3.0) else "MIDDLE" if frac < (2.0 / 3.0) else "WEAK"
                tier_by_team[team_id] = tier
            for row in by_date[date]:
                game_pk = int(row["gamePk"])
                for side in ("home", "away"):
                    team_id = int(row[f"{side}TeamId"])
                    rec = record[team_id]
                    tier = tier_by_team.get(team_id, "UNSTABLE") if rec["g"] >= minimum_prior_games else "UNSTABLE"
                    snapshots[(season, game_pk, team_id)] = {
                        "tier": tier,
                        "priorGames": int(rec["g"]),
                        "winPct": rec["w"] / rec["g"] if rec["g"] else None,
                        "runDiffPerGame": (rec["rf"] - rec["ra"]) / rec["g"] if rec["g"] else None,
                    }
                    tier_counts[tier] += 1
            for row in by_date[date]:
                home = int(row["homeTeamId"])
                away = int(row["awayTeamId"])
                outcome = row["outcomes"]["FULL_GAME"]
                hr = int(outcome["homeRuns"])
                ar = int(outcome["awayRuns"])
                record[home]["g"] += 1
                record[away]["g"] += 1
                record[home]["rf"] += hr
                record[home]["ra"] += ar
                record[away]["rf"] += ar
                record[away]["ra"] += hr
                if hr > ar:
                    record[home]["w"] += 1
                elif ar > hr:
                    record[away]["w"] += 1
                else:
                    raise SystemExit(f"MODULAR_FULL_GAME_TIE_UNEXPECTED:{season}:{row['gamePk']}")
        season_diagnostics[season] = {"teams": len(record), "snapshotTierCounts": dict(tier_counts)}
    return snapshots, season_diagnostics


def load_joined_rows(root, custody_rows, snapshots):
    custody = {(str(row["season"]), int(row["gamePk"])): row for row in custody_rows}
    if len(custody) != len(custody_rows):
        raise SystemExit("MODULAR_DUPLICATE_CUSTODY_IDENTITY")
    joined = []
    dates_by_season = defaultdict(set)
    expected = {"2022": 2398, "2023": 2399, "2024": 2406, "2025": 2423, "2026_YTD": 1781}
    for season in ALL_SEASONS:
        table = load(os.path.join(root, season, "game-anatomy-feature-table.json"))
        for source in table["rows"]:
            if source.get("t5PregameValid") is not True:
                continue
            game_pk = int(source["gamePk"])
            key = (season, game_pk)
            if key not in custody:
                raise SystemExit(f"MODULAR_CUSTODY_JOIN_MISSING:{season}:{game_pk}")
            c = custody[key]
            if str(c["officialDate"]) != str(source["officialDate"]):
                raise SystemExit(f"MODULAR_DATE_JOIN_DRIFT:{season}:{game_pk}")
            home_id = int(source["homeTeamId"])
            away_id = int(source["awayTeamId"])
            if int(c["homeTeamId"]) != home_id or int(c["awayTeamId"]) != away_id:
                raise SystemExit(f"MODULAR_TEAM_JOIN_DRIFT:{season}:{game_pk}")
            row = dict(source.get("features") or {})
            row.update(c)
            row["season"] = season
            row["officialDate"] = str(source["officialDate"])
            row["gamePk"] = game_pk
            row["homeTeamId"] = home_id
            row["awayTeamId"] = away_id
            for horizon, outcome_key in (("F3", "FIRST_3"), ("F5", "FIRST_5"), ("FG", "FULL_GAME")):
                outcome = source["outcomes"][outcome_key]
                home_runs = int(outcome["homeRuns"])
                away_runs = int(outcome["awayRuns"])
                row[f"{horizon}_homeRuns"] = home_runs
                row[f"{horizon}_awayRuns"] = away_runs
                row[f"{horizon}_diff"] = home_runs - away_runs
            first = source["outcomes"].get("FIRST_INNING")
            if not isinstance(first, dict):
                raise SystemExit(f"MODULAR_FIRST_INNING_MISSING:{season}:{game_pk}")
            row["firstInningTotalRuns"] = int(first["totalRuns"])
            for side, team_id in (("home", home_id), ("away", away_id)):
                snap = snapshots.get((season, game_pk, team_id))
                if snap is None:
                    raise SystemExit(f"MODULAR_STANDINGS_SNAPSHOT_MISSING:{season}:{game_pk}:{team_id}")
                row[f"{side}StrengthTier"] = snap["tier"]
                row[f"{side}PriorGames"] = snap["priorGames"]
                row[f"{side}PregameWinPct"] = snap["winPct"]
                row[f"{side}PregameRunDiffPerGame"] = snap["runDiffPerGame"]
            joined.append(row)
            if season in EVAL_SEASONS:
                dates_by_season[season].add(row["officialDate"])
    counts = Counter(row["season"] for row in joined)
    if dict(counts) != expected:
        raise SystemExit(f"MODULAR_SEASON_COUNT_DRIFT:{dict(counts)}")
    return joined, dates_by_season


def directional_rows(parent, rows_by_season, horizon, variant, probabilities, baseline_home):
    materialized = {}
    for season, source_rows in rows_by_season.items():
        ph, pa = parent.pair_probability(probabilities[season], horizon, variant)
        rows = []
        for i, source in enumerate(source_rows):
            outcome = parent.home_settlement(source[f"{horizon}_diff"], horizon, variant)
            rows.append({
                "season": season,
                "officialDate": source["officialDate"],
                "gamePk": int(source["gamePk"]),
                "homeProbability": float(ph[i]),
                "awayProbability": float(pa[i]),
                "homeOutcome": outcome,
                "baselineHomeProbability": float(baseline_home),
                "baselineAwayProbability": float(1.0 - baseline_home),
                "homeTier": source["homeStrengthTier"],
                "awayTier": source["awayStrengthTier"],
            })
        materialized[season] = rows
    return materialized


def selected_direction(row):
    home_score = row["homeProbability"] - row["baselineHomeProbability"]
    away_score = row["awayProbability"] - row["baselineAwayProbability"]
    if home_score >= away_score:
        side = "HOME"
        score = home_score
        probability = row["homeProbability"]
        tier = row["homeTier"]
        outcome = "PUSH" if row["homeOutcome"] is None else "WIN" if row["homeOutcome"] == 1 else "LOSS"
    else:
        side = "AWAY"
        score = away_score
        probability = row["awayProbability"]
        tier = row["awayTier"]
        outcome = "PUSH" if row["homeOutcome"] is None else "WIN" if row["homeOutcome"] == 0 else "LOSS"
    return side, float(score), float(probability), tier, outcome


def tier_thresholds(rows_2023, quantiles, min_probability):
    score_by_tier = {tier: [] for tier in TIERS}
    for row in rows_2023:
        _, score, probability, tier, _ = selected_direction(row)
        if score > 0 and probability >= min_probability:
            score_by_tier[tier].append(score)
    result = {}
    for tier in TIERS:
        scores = score_by_tier[tier]
        result[tier] = {
            f"Q{int(q*100)}": (float(np.quantile(scores, q, method="linear")) if scores else None)
            for q in quantiles
        }
        result[tier]["eligibleValidationScores"] = len(scores)
    return result


def materialize_policy_candidates(rows, thresholds, mapping, min_probability, variant):
    result = []
    for row in rows:
        side, score, probability, tier, outcome = selected_direction(row)
        qkey = mapping[tier]
        if qkey == "NO_PLAY":
            continue
        threshold = thresholds[tier].get(qkey)
        if threshold is None or score <= 0 or probability < min_probability or score + 1e-15 < threshold:
            continue
        result.append({
            "season": row["season"],
            "officialDate": row["officialDate"],
            "gamePk": row["gamePk"],
            "market": variant,
            "side": side,
            "strengthTier": tier,
            "frontier": qkey,
            "qualityScore": score,
            "modelProbability": probability,
            "outcome": outcome,
        })
    return result


def candidate_stats(parent, candidates, no_play_dates):
    decisive = [row for row in candidates if row["outcome"] != "PUSH"]
    wins = sum(row["outcome"] == "WIN" for row in decisive)
    losses = sum(row["outcome"] == "LOSS" for row in decisive)
    pushes = sum(row["outcome"] == "PUSH" for row in candidates)
    dates = {row["officialDate"] for row in candidates}
    rescue = dates & no_play_dates
    mean_p = float(np.mean([row["modelProbability"] for row in decisive])) if decisive else None
    hit = wins / len(decisive) if decisive else None
    return {
        "candidates": len(candidates),
        "distinctCandidateDates": len(dates),
        "rescuedParentNoPlayDates": len(rescue),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "decisive": len(decisive),
        "hitRate": hit,
        "wilson95": parent.wilson(wins, len(decisive)),
        "meanPredictedProbabilityOnDecisive": mean_p,
        "absoluteCalibrationGap": abs(hit - mean_p) if hit is not None and mean_p is not None else None,
        "candidateDates": sorted(dates),
        "rescuedDates": sorted(rescue),
    }


def nrfi_rows(rows_by_season, probabilities, baseline_yrfi):
    result = {}
    for season, source_rows in rows_by_season.items():
        rows = []
        for i, source in enumerate(source_rows):
            p_yrfi = float(probabilities[season][i])
            outcome = 1 if source["firstInningTotalRuns"] >= 1 else 0
            rows.append({
                "season": season,
                "officialDate": source["officialDate"],
                "gamePk": int(source["gamePk"]),
                "yrfiProbability": p_yrfi,
                "nrfiProbability": 1.0 - p_yrfi,
                "yrfiOutcome": outcome,
                "baselineYrfiProbability": float(baseline_yrfi),
                "baselineNrfiProbability": float(1.0 - baseline_yrfi),
            })
        result[season] = rows
    return result


def selected_first_inning(row):
    yrfi_score = row["yrfiProbability"] - row["baselineYrfiProbability"]
    nrfi_score = row["nrfiProbability"] - row["baselineNrfiProbability"]
    if yrfi_score >= nrfi_score:
        return "YRFI", float(yrfi_score), float(row["yrfiProbability"]), "WIN" if row["yrfiOutcome"] == 1 else "LOSS"
    return "NRFI", float(nrfi_score), float(row["nrfiProbability"]), "WIN" if row["yrfiOutcome"] == 0 else "LOSS"


def first_inning_thresholds(rows_2023, quantiles, min_probability):
    scores = []
    for row in rows_2023:
        _, score, probability, _ = selected_first_inning(row)
        if score > 0 and probability >= min_probability:
            scores.append(score)
    result = {f"Q{int(q*100)}": (float(np.quantile(scores, q, method="linear")) if scores else None) for q in quantiles}
    result["eligibleValidationScores"] = len(scores)
    return result


def first_inning_candidates(rows, threshold, min_probability):
    if threshold is None:
        return []
    result = []
    for row in rows:
        side, score, probability, outcome = selected_first_inning(row)
        if score <= 0 or probability < min_probability or score + 1e-15 < threshold:
            continue
        result.append({
            "season": row["season"],
            "officialDate": row["officialDate"],
            "gamePk": row["gamePk"],
            "market": "FIRST_INNING_RUNS",
            "side": side,
            "strengthTier": "GAME_GLOBAL",
            "qualityScore": score,
            "modelProbability": probability,
            "outcome": outcome,
        })
    return result


def coverage_summary(parent, candidates, parent_active_dates, parent_no_play_dates, eligible_dates, dates_by_season):
    candidate_dates = {row["officialDate"] for row in candidates}
    rescued = candidate_dates & parent_no_play_dates
    combined = parent_active_dates | rescued
    remaining = eligible_dates - combined
    by_season = {}
    for season in EVAL_SEASONS:
        dates = dates_by_season[season]
        active = parent_active_dates & dates
        rescue_s = rescued & dates
        combined_s = active | rescue_s
        by_season[season] = {
            "eligibleSlateDates": len(dates),
            "parentActiveDates": len(active),
            "rescuedParentNoPlayDates": len(rescue_s),
            "combinedOpportunityDates": len(combined_s),
            "combinedOpportunityCoveragePct": 100.0 * len(combined_s) / len(dates),
            "remainingNoPlayDates": len(dates - combined_s),
        }
    return {
        "parentActiveDates": len(parent_active_dates),
        "parentNoPlayDates": len(parent_no_play_dates),
        "rescuedParentNoPlayDates": len(rescued),
        "shareOfParentNoPlayDatesRescuedPct": 100.0 * len(rescued) / len(parent_no_play_dates),
        "combinedOpportunityDates": len(combined),
        "combinedOpportunityCoveragePct": 100.0 * len(combined) / len(eligible_dates),
        "remainingNoPlayDates": len(remaining),
        "remainingNoPlayStreaks": parent.streak_summary(combined, eligible_dates),
        "rescuedDates": sorted(rescued),
        "bySeason": by_season,
    }


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source", "router-source",
        "v69-contract", "v69-scorer", "parent-multi-market-scorer", "parent-multi-market-contract",
        "contract", "market-registry", "market-contract", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MODULAR_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "RETROSPECTIVE_MODULAR_TEAM_STRUCTURE_AND_FIRST_INNING_DISCOVERY_WITH_PROSPECTIVE_CONFIRMATION_REQUIRED":
        raise SystemExit("MODULAR_CONTRACT_STATUS_INVALID")
    if contract["chronology"]["retrospectiveEvaluationIsIndependentConfirmation"] is not False:
        raise SystemExit("MODULAR_CONFIRMATION_BOUNDARY_DRIFT")
    if contract["priceAndPromotionBoundary"]["historicalPricesUsed"] is not False:
        raise SystemExit("MODULAR_PRICE_BOUNDARY_DRIFT")

    registry_text = open(args.market_registry, encoding="utf-8").read()
    market_contract_text = open(args.market_contract, encoding="utf-8").read()
    for token in ("totals_1st_1_innings", "NRFI", "YRFI", "HARD_ROCK_NRFI_YRFI"):
        if token not in registry_text and token not in market_contract_text:
            raise SystemExit(f"MODULAR_FIRST_INNING_REGISTRY_CONTRACT_MISSING:{token}")

    parent = load_module(args.parent_multi_market_scorer, "modular_parent_multi_market")
    parent_contract = load(args.parent_multi_market_contract)
    snapshots, standings_diagnostics = build_standings_snapshots(
        args.root, contract["teamStrengthModule"]["strengthTierDefinition"]["minimumPriorGamesForStableTier"]
    )
    custody_rows = parent.load_custody(args.custody)
    joined, dates_by_season = load_joined_rows(args.root, custody_rows, snapshots)
    by_season = {season: [row for row in joined if row["season"] == season] for season in ALL_SEASONS}
    eligible_dates = set().union(*(dates_by_season[season] for season in EVAL_SEASONS))
    parent_args = SimpleNamespace(
        root=args.root,
        custody=args.custody,
        v16_manifest=args.v16_manifest,
        v68_contract=args.v68_contract,
        classifier_source=args.classifier_source,
        router_source=args.router_source,
        v69_contract=args.v69_contract,
        v69_scorer=args.v69_scorer,
        out=args.out,
    )
    parent_active_dates, parent_no_play_dates = parent.reconstruct_parent_active_dates(parent_args, eligible_dates)

    direction_features = parent_contract["directionalMarginModels"]["features"]
    margin_prob = defaultdict(dict)
    model_diagnostics = {}
    for horizon in ("F3", "F5", "FG"):
        train = by_season["2022"]
        x_train, prep = parent.fit_matrix(train, direction_features[horizon])
        y_train = np.asarray([parent.margin_class(row[f"{horizon}_diff"], horizon) for row in train], dtype=int)
        class_count = 4 if horizon == "FG" else 5
        weights = parent.fit_multinomial(
            x_train, y_train, class_count,
            parent_contract["directionalMarginModels"]["l2Strength"],
            parent_contract["directionalMarginModels"]["maxIter"],
        )
        for season in ALL_SEASONS[1:]:
            margin_prob[horizon][season] = parent.predict_multinomial(
                parent.apply_matrix(by_season[season], prep), weights, class_count
            )
        model_diagnostics[horizon] = {"featureCount": len(direction_features[horizon]), "parameterCount": int(weights.size)}

    defs = {
        "F3_RL_HOME_PLUS_0_5": ("F3", "F3_RUN_LINE"),
        "F5_ML": ("F5", "F5_ML"),
        "F5_RL_HOME_MINUS_0_5": ("F5", "F5_RUN_LINE"),
        "F5_RL_HOME_PLUS_0_5": ("F5", "F5_RUN_LINE"),
        "FG_ML": ("FG", "FG_ML"),
        "FG_RL_HOME_MINUS_1_5": ("FG", "FG_RUN_LINE"),
        "FG_RL_HOME_PLUS_1_5": ("FG", "FG_RUN_LINE"),
    }
    if list(contract["marketScope"]["carryForwardQualifiedVariants"]) != list(defs.keys()):
        raise SystemExit("MODULAR_CARRY_FORWARD_VARIANT_DRIFT")

    quantiles = [0.80, 0.85, 0.90, 0.95]
    min_probability = float(parent_contract["qualityVolumeFrontier"]["minimumSelectedSideModelProbability"])
    variants = {}
    for variant, (horizon, family) in defs.items():
        train_y = [parent.home_settlement(row[f"{horizon}_diff"], horizon, variant) for row in by_season["2022"]]
        decisive = [value for value in train_y if value is not None]
        baseline_home = sum(value == 1 for value in decisive) / len(decisive)
        rows_by_s = directional_rows(
            parent,
            {season: by_season[season] for season in ALL_SEASONS[1:]},
            horizon,
            variant,
            margin_prob[horizon],
            baseline_home,
        )
        thresholds = tier_thresholds(rows_by_s["2023"], quantiles, min_probability)
        variants[variant] = {
            "family": family,
            "horizon": horizon,
            "baselineHomeProbability": baseline_home,
            "thresholdsByStrengthTier": thresholds,
            "rows": rows_by_s,
        }

    fi_cfg = contract["nrfiYrfiModel"]
    fi_features = contract["matchupStructureModule"]["nrfiYrfiFeaturesExactly"]
    x_train, fi_prep = parent.fit_matrix(by_season["2022"], fi_features)
    y_train = np.asarray([1 if row["firstInningTotalRuns"] >= 1 else 0 for row in by_season["2022"]], dtype=float)
    fi_theta = fit_binary_logistic(x_train, y_train, fi_cfg["l2Strength"], fi_cfg["maxIter"])
    baseline_yrfi = float(np.mean(y_train))
    fi_prob = {}
    for season in ALL_SEASONS[1:]:
        fi_prob[season] = predict_binary(parent.apply_matrix(by_season[season], fi_prep), fi_theta)
    fi_rows = nrfi_rows({season: by_season[season] for season in ALL_SEASONS[1:]}, fi_prob, baseline_yrfi)
    val_outcome = np.asarray([row["yrfiOutcome"] for row in fi_rows["2023"]], dtype=float)
    val_model = np.asarray([row["yrfiProbability"] for row in fi_rows["2023"]], dtype=float)
    val_base = np.full(len(val_outcome), baseline_yrfi, dtype=float)
    fi_validation = {
        "modelBrier": brier_binary(val_model, val_outcome),
        "baselineBrier": brier_binary(val_base, val_outcome),
    }
    fi_validation["brierImprovement"] = fi_validation["baselineBrier"] - fi_validation["modelBrier"]
    fi_validation["validationQualified"] = fi_validation["brierImprovement"] > 0
    fi_threshold = first_inning_thresholds(
        fi_rows["2023"], quantiles, fi_cfg["minimumSelectedSideModelProbability"]
    )
    eval_fi = [row for season in EVAL_SEASONS for row in fi_rows[season]]
    eval_outcome = np.asarray([row["yrfiOutcome"] for row in eval_fi], dtype=float)
    eval_model = np.asarray([row["yrfiProbability"] for row in eval_fi], dtype=float)
    eval_base = np.full(len(eval_outcome), baseline_yrfi, dtype=float)
    fi_oos = {
        "combinedModelBrier": brier_binary(eval_model, eval_outcome),
        "combinedBaselineBrier": brier_binary(eval_base, eval_outcome),
    }
    fi_oos["combinedBrierImprovement"] = fi_oos["combinedBaselineBrier"] - fi_oos["combinedModelBrier"]
    fi_oos["bySeason"] = {}
    for season in EVAL_SEASONS:
        rows_s = fi_rows[season]
        y = np.asarray([row["yrfiOutcome"] for row in rows_s], dtype=float)
        p = np.asarray([row["yrfiProbability"] for row in rows_s], dtype=float)
        b = np.full(len(y), baseline_yrfi, dtype=float)
        fi_oos["bySeason"][season] = {
            "modelBrier": brier_binary(p, y),
            "baselineBrier": brier_binary(b, y),
            "brierImprovement": brier_binary(b, y) - brier_binary(p, y),
        }

    policy_maps = {}
    policy_maps.update(contract["modularAcceptancePolicies"]["uniformControls"])
    policy_maps.update(contract["modularAcceptancePolicies"]["modularTemplates"])
    fi_policy_frontier = contract["modularAcceptancePolicies"]["nrfiYrfiFrontierByPolicy"]
    policy_results = {}
    for policy_name, tier_map in policy_maps.items():
        all_candidates = []
        by_market = {}
        for variant, info in variants.items():
            rows_eval = [row for season in EVAL_SEASONS for row in info["rows"][season]]
            cands = materialize_policy_candidates(
                rows_eval, info["thresholdsByStrengthTier"], tier_map, min_probability, variant
            )
            all_candidates.extend(cands)
            by_market[variant] = candidate_stats(parent, cands, parent_no_play_dates)
        qkey = fi_policy_frontier[policy_name]
        fi_cands = []
        if fi_validation["validationQualified"]:
            fi_cands = first_inning_candidates(
                eval_fi, fi_threshold[qkey], fi_cfg["minimumSelectedSideModelProbability"]
            )
            all_candidates.extend(fi_cands)
        by_market["FIRST_INNING_RUNS"] = candidate_stats(parent, fi_cands, parent_no_play_dates)
        by_tier = {}
        for tier in (*TIERS, "GAME_GLOBAL"):
            by_tier[tier] = candidate_stats(
                parent, [row for row in all_candidates if row["strengthTier"] == tier], parent_no_play_dates
            )
        stats = candidate_stats(parent, all_candidates, parent_no_play_dates)
        policy_results[policy_name] = {
            "teamTierFrontiers": tier_map,
            "nrfiYrfiFrontier": qkey,
            "allSignalStats": stats,
            "byMarket": by_market,
            "byStrengthTier": by_tier,
            "coverage": coverage_summary(
                parent, all_candidates, parent_active_dates, parent_no_play_dates, eligible_dates, dates_by_season
            ),
        }

    result = {
        "schemaVersion": SCHEMA,
        "classification": "MODULAR_TEAM_STRUCTURE_AND_NRFI_YRFI_RETROSPECTIVE_DISCOVERY_COMPLETE_PROSPECTIVE_CONFIRMATION_REQUIRED",
        "sample": {
            "trainingRows2022": len(by_season["2022"]),
            "validationRows2023": len(by_season["2023"]),
            "evaluationRows": sum(len(by_season[s]) for s in EVAL_SEASONS),
            "eligibleSlateDates": len(eligible_dates),
            "parentActiveDates": len(parent_active_dates),
            "parentNoPlayDates": len(parent_no_play_dates),
        },
        "standingsModule": {
            "minimumPriorGamesForStableTier": contract["teamStrengthModule"]["strengthTierDefinition"]["minimumPriorGamesForStableTier"],
            "cutoff": "PREVIOUS_CALENDAR_DATE_ONLY",
            "diagnostics": standings_diagnostics,
        },
        "directionalModelDiagnostics": model_diagnostics,
        "variantThresholdsByStrengthTier": {
            variant: info["thresholdsByStrengthTier"] for variant, info in variants.items()
        },
        "firstInningRuns": {
            "baselineYrfiProbability2022": baseline_yrfi,
            "features": fi_features,
            "parameterCount": int(fi_theta.size),
            "validation": fi_validation,
            "outOfSampleRobustness": fi_oos,
            "thresholds": fi_threshold,
            "frontiers": {
                qkey: candidate_stats(
                    parent,
                    first_inning_candidates(eval_fi, fi_threshold[qkey], fi_cfg["minimumSelectedSideModelProbability"])
                    if fi_validation["validationQualified"] else [],
                    parent_no_play_dates,
                )
                for qkey in ("Q80", "Q85", "Q90", "Q95")
            },
        },
        "policyResults": policy_results,
        "scientificBoundary": {
            "rulesAreStateModularNotTeamNameSpecific": True,
            "standingsArePregameAndPreviousDateOnly": True,
            "sameDayDoubleheaderLeakageAllowed": False,
            "nrfiYrfiStudied": True,
            "nrfiYrfiAlreadyCanonicalContractSupported": True,
            "nrfiYrfiUsesExactFirstInningOutcome": True,
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
    if result["sample"] != {
        "trainingRows2022": 2398,
        "validationRows2023": 2399,
        "evaluationRows": 6610,
        "eligibleSlateDates": 505,
        "parentActiveDates": 200,
        "parentNoPlayDates": 305,
    }:
        raise SystemExit(f"MODULAR_SAMPLE_DRIFT:{result['sample']}")
    dump(args.out, result)
    print(json.dumps({
        "classification": result["classification"],
        "sample": result["sample"],
        "firstInningRunsValidation": fi_validation,
        "policyCoverage": {
            name: policy_results[name]["coverage"]["combinedOpportunityCoveragePct"] for name in policy_results
        },
    }, indent=2))


if __name__ == "__main__":
    main()
