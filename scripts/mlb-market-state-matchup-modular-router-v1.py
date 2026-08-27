#!/usr/bin/env python3
import argparse
import bisect
import importlib.util
import json
import math
import os
from collections import Counter, defaultdict
from types import SimpleNamespace

import numpy as np
from scipy.stats import binomtest

SCHEMA = "courtedge-mlb-market-state-matchup-modular-router.v1"
CONTRACT_SCHEMA = "courtedge-mlb-market-state-matchup-modular-router-contract.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_SEASONS = ("2022", "2023", *EVAL_SEASONS)
TIERS = ("STRONG", "MIDDLE", "WEAK", "UNSTABLE")
STRUCTURE_STATES = ("SUPPORTIVE", "MIXED", "CONFLICTING", "UNKNOWN")
GEOMETRIES = ("PROTECTED", "NEUTRAL_ML", "AGGRESSIVE")


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
        raise SystemExit(f"MODULAR_ROUTER_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finite(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else math.nan
    except (TypeError, ValueError):
        return math.nan


def preprocess_structure(train_rows, cfg):
    all_features = sorted({f for fs in cfg["roles"].values() for f in fs})
    prep = {}
    for feature in all_features:
        observed = [finite(r.get(feature)) for r in train_rows]
        observed = np.asarray([v for v in observed if math.isfinite(v)], dtype=float)
        if observed.size == 0:
            raise SystemExit(f"MODULAR_ROUTER_STRUCTURE_FEATURE_EMPTY:{feature}")
        median = float(np.median(observed))
        imputed = np.asarray([
            finite(r.get(feature)) if math.isfinite(finite(r.get(feature))) else median
            for r in train_rows
        ], dtype=float)
        mean = float(np.mean(imputed))
        std = float(np.std(imputed))
        prep[feature] = {
            "median": median,
            "mean": mean,
            "std": std,
            "observedTrainRows": int(observed.size),
        }
    return prep


def standardized_value(row, feature, prep, clip_z):
    raw = finite(row.get(feature))
    p = prep[feature]
    if not math.isfinite(raw):
        raw = p["median"]
    if p["std"] <= 1e-12:
        return 0.0
    return float(np.clip((raw - p["mean"]) / p["std"], -clip_z, clip_z))


def structure_score(row, side, horizon, cfg, prep):
    required_roles = cfg["requiredRolesByHorizon"][horizon]
    role_features = [cfg["roles"][role] for role in required_roles]
    total = sum(len(fs) for fs in role_features)
    observed_total = sum(
        math.isfinite(finite(row.get(feature)))
        for fs in role_features for feature in fs
    )
    per_role_observed = {
        role: sum(math.isfinite(finite(row.get(feature))) for feature in cfg["roles"][role])
        for role in required_roles
    }
    observed_fraction = observed_total / total if total else 0.0
    observable = (
        observed_fraction + 1e-15 >= float(cfg["minimumObservedFeatureFraction"])
        and all(v >= int(cfg["minimumObservedFeaturesPerRequiredRole"]) for v in per_role_observed.values())
    )
    if not observable:
        return None, {
            "observedFeatureFraction": observed_fraction,
            "observedFeatures": int(observed_total),
            "requiredFeatures": int(total),
            "observedByRole": per_role_observed,
        }
    orientation = 1.0 if side == "HOME" else -1.0
    role_scores = {}
    for role in required_roles:
        values = [
            orientation * standardized_value(row, feature, prep, float(cfg["trainingOnlyPreprocessing"]["clipZ"]))
            for feature in cfg["roles"][role]
        ]
        role_scores[role] = float(np.mean(values))
    return float(np.mean(list(role_scores.values()))), {
        "observedFeatureFraction": observed_fraction,
        "observedFeatures": int(observed_total),
        "requiredFeatures": int(total),
        "observedByRole": per_role_observed,
        "roleScores": role_scores,
    }


def selected_line_geometry(variant, side):
    if variant in ("F5_ML", "FG_ML"):
        return "NEUTRAL_ML", None
    home_line = {
        "F3_RL_HOME_PLUS_0_5": 0.5,
        "F5_RL_HOME_MINUS_0_5": -0.5,
        "F5_RL_HOME_PLUS_0_5": 0.5,
        "FG_RL_HOME_MINUS_1_5": -1.5,
        "FG_RL_HOME_PLUS_1_5": 1.5,
    }.get(variant)
    if home_line is None:
        raise SystemExit(f"MODULAR_ROUTER_LINE_GEOMETRY_UNKNOWN:{variant}")
    line = home_line if side == "HOME" else -home_line
    return ("PROTECTED" if line > 0 else "AGGRESSIVE"), float(line)


def build_structure_boundaries(variant_rows, source_index, horizon_by_variant, cfg, modular):
    by_cell = defaultdict(list)
    unknown = Counter()
    for variant, rows_2023 in variant_rows.items():
        horizon = horizon_by_variant[variant]
        for row in rows_2023:
            side, _, _, tier, _ = modular.selected_direction(row)
            source = source_index[("2023", int(row["gamePk"]))]
            score, _ = structure_score(source, side, horizon, cfg, cfg["_prep"])
            if score is None:
                unknown[(horizon, tier)] += 1
            else:
                by_cell[(horizon, tier)].append(score)
    lower_q = float(cfg["lowerQuantile"])
    upper_q = float(cfg["upperQuantile"])
    boundaries = {}
    for horizon in ("F3", "F5", "FG"):
        boundaries[horizon] = {}
        for tier in TIERS:
            values = by_cell[(horizon, tier)]
            if not values:
                raise SystemExit(f"MODULAR_ROUTER_STRUCTURE_BOUNDARY_EMPTY:{horizon}:{tier}")
            boundaries[horizon][tier] = {
                "lower": float(np.quantile(values, lower_q, method="linear")),
                "upper": float(np.quantile(values, upper_q, method="linear")),
                "eligibleStructureScores": len(values),
                "unknownRows": int(unknown[(horizon, tier)]),
            }
    return boundaries


def classify_structure(score, boundary):
    if score is None:
        return "UNKNOWN"
    if score >= boundary["upper"] - 1e-15:
        return "SUPPORTIVE"
    if score <= boundary["lower"] + 1e-15:
        return "CONFLICTING"
    return "MIXED"


def validation_quality_distributions(rows_2023, modular, min_probability):
    by_tier = {tier: [] for tier in TIERS}
    for row in rows_2023:
        _, score, probability, tier, _ = modular.selected_direction(row)
        if score > 0 and probability >= min_probability:
            by_tier[tier].append(float(score))
    for tier in TIERS:
        by_tier[tier].sort()
    return by_tier


def empirical_percentile(sorted_values, value):
    if not sorted_values:
        return None
    return bisect.bisect_right(sorted_values, value) / len(sorted_values)


def resolve_frontier(policy_name, tier, structure, geometry, contract):
    policies = contract["policies"]
    if policy_name == "CONTROL_UNIFORM_Q85":
        return "Q85"
    if policy_name == "CONTROL_UNIFORM_Q90":
        return "Q90"
    if policy_name == "CONTROL_STATE_ONLY_BALANCED":
        return policies[policy_name]["byTeamState"][tier]
    matrix = policies["CHALLENGER_STATE_X_STRUCTURE"]["matrix"]
    base = matrix[tier][structure]
    if policy_name == "CHALLENGER_STATE_X_STRUCTURE":
        return base
    if policy_name != "CHALLENGER_FULL_MODULAR":
        raise SystemExit(f"MODULAR_ROUTER_POLICY_UNKNOWN:{policy_name}")

    order = policies[policy_name]["frontierOrder"]
    idx = order.index(base)
    if geometry == "PROTECTED":
        idx = max(0, idx - 1)
        floor = policies[policy_name]["teamStateFloor"][tier]
        floor_idx = order.index(floor)
        idx = max(idx, floor_idx)
    elif geometry == "AGGRESSIVE":
        idx = min(len(order) - 1, idx + 1)
    elif geometry != "NEUTRAL_ML":
        raise SystemExit(f"MODULAR_ROUTER_GEOMETRY_UNKNOWN:{geometry}")
    return order[idx]


def group_basic_stats(parent, rows):
    decisive = [r for r in rows if r["outcome"] != "PUSH"]
    wins = sum(r["outcome"] == "WIN" for r in decisive)
    losses = sum(r["outcome"] == "LOSS" for r in decisive)
    pushes = sum(r["outcome"] == "PUSH" for r in rows)
    hit = wins / len(decisive) if decisive else None
    mean_p = float(np.mean([r["modelProbability"] for r in decisive])) if decisive else None
    brier = (
        float(np.mean([
            (r["modelProbability"] - (1.0 if r["outcome"] == "WIN" else 0.0)) ** 2
            for r in decisive
        ]))
        if decisive else None
    )
    return {
        "picks": len(rows),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "decisive": len(decisive),
        "hitRate": hit,
        "wilson95": parent.wilson(wins, len(decisive)),
        "meanModelProbabilityOnDecisive": mean_p,
        "decisiveBrierScore": brier,
        "absoluteCalibrationGap": abs(hit - mean_p) if hit is not None and mean_p is not None else None,
    }


def subgroup_stats(parent, picks, field):
    grouped = defaultdict(list)
    for row in picks:
        grouped[str(row[field])].append(row)
    return {key: group_basic_stats(parent, rows) for key, rows in sorted(grouped.items())}


def policy_stats(parent, picks, parent_active_dates, eligible_dates, dates_by_season):
    dates = {r["officialDate"] for r in picks}
    combined = parent_active_dates | dates
    remaining = eligible_dates - combined
    result = group_basic_stats(parent, picks)
    result.update({
        "shadowPickDates": len(dates),
        "combinedDailyOpportunityDates": len(combined),
        "combinedDailyOpportunityCoveragePct": 100.0 * len(combined) / len(eligible_dates),
        "remainingNoPlayDates": len(remaining),
        "remainingNoPlayStreaks": parent.streak_summary(combined, eligible_dates),
        "bySeason": {},
        "byMarket": subgroup_stats(parent, picks, "market"),
        "byTeamState": subgroup_stats(parent, picks, "strengthTier"),
        "byMatchupStructure": subgroup_stats(parent, picks, "matchupStructure"),
        "bySelectedSideLineGeometry": subgroup_stats(parent, picks, "lineGeometry"),
        "frontierUsage": dict(Counter(r["frontier"] for r in picks)),
    })
    for season in EVAL_SEASONS:
        season_dates = dates_by_season[season]
        rows = [r for r in picks if r["season"] == season]
        base = group_basic_stats(parent, rows)
        combined_s = (parent_active_dates & season_dates) | {r["officialDate"] for r in rows}
        base.update({
            "eligibleSlateDates": len(season_dates),
            "combinedDailyOpportunityDates": len(combined_s),
            "combinedDailyOpportunityCoveragePct": 100.0 * len(combined_s) / len(season_dates),
            "remainingNoPlayDates": len(season_dates - combined_s),
        })
        result["bySeason"][season] = base
    return result


def paired_comparison(control_picks, challenger_picks):
    control = {r["officialDate"]: r for r in control_picks if r["outcome"] != "PUSH"}
    challenger = {r["officialDate"]: r for r in challenger_picks if r["outcome"] != "PUSH"}
    overlap = sorted(set(control) & set(challenger))
    c_only = 0
    b_only = 0
    both_correct = 0
    both_wrong = 0
    for date in overlap:
        b = control[date]["outcome"] == "WIN"
        c = challenger[date]["outcome"] == "WIN"
        if b and c:
            both_correct += 1
        elif (not b) and (not c):
            both_wrong += 1
        elif c and not b:
            c_only += 1
        else:
            b_only += 1
    discordant = c_only + b_only
    pvalue = float(binomtest(c_only, discordant, p=0.5, alternative="two-sided").pvalue) if discordant else 1.0
    return {
        "overlapDecisiveDates": len(overlap),
        "bothCorrect": both_correct,
        "bothWrong": both_wrong,
        "challengerOnlyCorrect": c_only,
        "controlOnlyCorrect": b_only,
        "discordantDates": discordant,
        "unadjustedPValue": pvalue,
    }


def holm_adjust(comparisons):
    items = sorted(comparisons.items(), key=lambda kv: kv[1]["unadjustedPValue"])
    m = len(items)
    running = 0.0
    for rank, (name, result) in enumerate(items, start=1):
        adjusted = min(1.0, (m - rank + 1) * result["unadjustedPValue"])
        running = max(running, adjusted)
        comparisons[name]["holmAdjustedPValue"] = running
        comparisons[name]["holmRejectAt005"] = running <= 0.05
    return comparisons


def pareto_policies(policy_results):
    names = list(policy_results)
    out = []
    for name in names:
        a = policy_results[name]
        aw = a["wilson95"]["lower"] if a["wilson95"] else None
        ag = a["absoluteCalibrationGap"]
        astreak = a["remainingNoPlayStreaks"]["maximum"] if isinstance(a["remainingNoPlayStreaks"], dict) else None
        if aw is None or ag is None or astreak is None:
            continue
        dominated = False
        for other in names:
            if other == name:
                continue
            b = policy_results[other]
            bw = b["wilson95"]["lower"] if b["wilson95"] else None
            bg = b["absoluteCalibrationGap"]
            bstreak = b["remainingNoPlayStreaks"]["maximum"] if isinstance(b["remainingNoPlayStreaks"], dict) else None
            if bw is None or bg is None or bstreak is None:
                continue
            no_worse = (
                b["combinedDailyOpportunityCoveragePct"] >= a["combinedDailyOpportunityCoveragePct"]
                and bw >= aw
                and bg <= ag
                and bstreak <= astreak
            )
            strictly_better = (
                b["combinedDailyOpportunityCoveragePct"] > a["combinedDailyOpportunityCoveragePct"]
                or bw > aw or bg < ag or bstreak < astreak
            )
            if no_worse and strictly_better:
                dominated = True
                break
        if not dominated:
            out.append(name)
    return out


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source", "router-source",
        "v69-contract", "v69-scorer", "multi-market-scorer", "multi-market-contract",
        "modular-parent-scorer", "modular-parent-contract", "contract", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MODULAR_ROUTER_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "RETROSPECTIVE_MARKET_TEAM_STATE_MATCHUP_HORIZON_ROUTER_DISCOVERY_PROSPECTIVE_CONFIRMATION_REQUIRED":
        raise SystemExit("MODULAR_ROUTER_CONTRACT_STATUS_INVALID")
    if contract["scientificChronology"]["retrospectiveEvaluationIsIndependentConfirmation"] is not False:
        raise SystemExit("MODULAR_ROUTER_CONFIRMATION_BOUNDARY_DRIFT")
    if contract["promotionBoundary"]["productionChanged"] is not False:
        raise SystemExit("MODULAR_ROUTER_PRODUCTION_BOUNDARY_DRIFT")
    if contract["promotionBoundary"]["historicalPricesUsed"] is not False:
        raise SystemExit("MODULAR_ROUTER_PRICE_BOUNDARY_DRIFT")
    if contract["marketScope"]["nrfiYrfiIncluded"] is not False:
        raise SystemExit("MODULAR_ROUTER_NRFI_BOUNDARY_DRIFT")

    parent = load_module(args.multi_market_scorer, "modular_router_multi_market_parent")
    modular = load_module(args.modular_parent_scorer, "modular_router_team_state_parent")
    parent_contract = load(args.multi_market_contract)
    modular_parent_contract = load(args.modular_parent_contract)

    if modular_parent_contract["schemaVersion"] != "courtedge-mlb-modular-team-structure-nrfi-yrfi-contract.v1":
        raise SystemExit("MODULAR_ROUTER_PARENT_CONTRACT_INVALID")
    if modular_parent_contract["teamStrengthModule"]["strengthTierDefinition"]["minimumPriorGamesForStableTier"] != 20:
        raise SystemExit("MODULAR_ROUTER_PARENT_TEAM_STATE_DRIFT")

    snapshots, standings_diagnostics = modular.build_standings_snapshots(
        args.root, contract["teamState"]["minimumPriorGamesForStableTier"]
    )
    custody_rows = parent.load_custody(args.custody)
    joined, dates_by_season = modular.load_joined_rows(args.root, custody_rows, snapshots)
    by_season = {season: [r for r in joined if r["season"] == season] for season in ALL_SEASONS}
    source_index = {(r["season"], int(r["gamePk"])): r for r in joined}
    if len(source_index) != len(joined):
        raise SystemExit("MODULAR_ROUTER_DUPLICATE_GAME_IDENTITY")

    eligible_dates = set().union(*(dates_by_season[s] for s in EVAL_SEASONS))
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
    expected = contract["productionBase"]
    if len(eligible_dates) != expected["eligibleSlateDatesExpected"]:
        raise SystemExit(f"MODULAR_ROUTER_ELIGIBLE_DATE_DRIFT:{len(eligible_dates)}")
    if len(parent_active_dates) != expected["parentActiveDatesExpected"]:
        raise SystemExit(f"MODULAR_ROUTER_PARENT_ACTIVE_DRIFT:{len(parent_active_dates)}")
    if len(parent_no_play_dates) != expected["parentNoPlayDatesExpected"]:
        raise SystemExit(f"MODULAR_ROUTER_PARENT_NO_PLAY_DRIFT:{len(parent_no_play_dates)}")

    direction_features = parent_contract["directionalMarginModels"]["features"]
    margin_prob = defaultdict(dict)
    model_diagnostics = {}
    for horizon in ("F3", "F5", "FG"):
        train = by_season["2022"]
        x_train, prep = parent.fit_matrix(train, direction_features[horizon])
        y_train = np.asarray([parent.margin_class(r[f"{horizon}_diff"], horizon) for r in train], dtype=int)
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
        model_diagnostics[horizon] = {
            "featureCount": len(direction_features[horizon]),
            "parameterCount": int(weights.size),
        }

    defs = {
        "F3_RL_HOME_PLUS_0_5": "F3",
        "F5_ML": "F5",
        "F5_RL_HOME_MINUS_0_5": "F5",
        "F5_RL_HOME_PLUS_0_5": "F5",
        "FG_ML": "FG",
        "FG_RL_HOME_MINUS_1_5": "FG",
        "FG_RL_HOME_PLUS_1_5": "FG",
    }
    if list(contract["marketScope"]["variantsExactly"]) != list(defs):
        raise SystemExit("MODULAR_ROUTER_MARKET_SCOPE_DRIFT")

    min_probability = float(contract["qualityFrontiers"]["minimumSelectedSideModelProbability"])
    quantiles = [0.80, 0.85, 0.90, 0.95]
    variants = {}
    for variant, horizon in defs.items():
        train_y = [parent.home_settlement(r[f"{horizon}_diff"], horizon, variant) for r in by_season["2022"]]
        decisive = [v for v in train_y if v is not None]
        baseline_home = sum(v == 1 for v in decisive) / len(decisive)
        rows_by_s = modular.directional_rows(
            parent,
            {season: by_season[season] for season in ALL_SEASONS[1:]},
            horizon, variant, margin_prob[horizon], baseline_home
        )
        thresholds = modular.tier_thresholds(rows_by_s["2023"], quantiles, min_probability)
        validation_scores = validation_quality_distributions(rows_by_s["2023"], modular, min_probability)
        variants[variant] = {
            "horizon": horizon,
            "baselineHomeProbability": baseline_home,
            "rows": rows_by_s,
            "thresholdsByTeamState": thresholds,
            "validationQualityScores": validation_scores,
        }

    structure_cfg = contract["matchupStructure"]
    structure_cfg["_prep"] = preprocess_structure(by_season["2022"], structure_cfg)
    structure_boundaries = build_structure_boundaries(
        {variant: info["rows"]["2023"] for variant, info in variants.items()},
        source_index, contract["marketScope"]["horizonByVariant"], structure_cfg, modular
    )

    policy_names = list(contract["policies"])
    candidate_pools = {name: [] for name in policy_names}
    cell_eligibility = {name: Counter() for name in policy_names}
    for variant, info in variants.items():
        horizon = info["horizon"]
        for season in EVAL_SEASONS:
            for row in info["rows"][season]:
                if row["officialDate"] not in parent_no_play_dates:
                    continue
                side, score, probability, tier, outcome = modular.selected_direction(row)
                source = source_index[(season, int(row["gamePk"]))]
                struct_score, struct_diag = structure_score(source, side, horizon, structure_cfg, structure_cfg["_prep"])
                struct_state = classify_structure(struct_score, structure_boundaries[horizon][tier])
                geometry, selected_line = selected_line_geometry(variant, side)
                percentile = empirical_percentile(info["validationQualityScores"][tier], score)
                if percentile is None:
                    continue
                for policy_name in policy_names:
                    frontier = resolve_frontier(policy_name, tier, struct_state, geometry, contract)
                    cell_eligibility[policy_name][f"{variant}|{tier}|{struct_state}|{geometry}|{frontier}"] += 1
                    if frontier == "NO_PLAY":
                        continue
                    threshold = info["thresholdsByTeamState"][tier].get(frontier)
                    if (
                        threshold is None or score <= 0 or probability < min_probability
                        or score + 1e-15 < threshold
                    ):
                        continue
                    candidate_pools[policy_name].append({
                        "season": season,
                        "officialDate": row["officialDate"],
                        "gamePk": int(row["gamePk"]),
                        "market": variant,
                        "horizon": horizon,
                        "side": side,
                        "selectedLine": selected_line,
                        "lineGeometry": geometry,
                        "strengthTier": tier,
                        "matchupStructure": struct_state,
                        "structureScore": struct_score,
                        "structureObservedFeatureFraction": struct_diag["observedFeatureFraction"],
                        "frontier": frontier,
                        "qualityScore": float(score),
                        "qualityPercentile": float(percentile),
                        "modelProbability": float(probability),
                        "outcome": outcome,
                    })

    daily_picks = {}
    for policy_name, pool in candidate_pools.items():
        by_date = defaultdict(list)
        for row in pool:
            by_date[row["officialDate"]].append(row)
        selected = []
        for date, rows in sorted(by_date.items()):
            rows.sort(key=lambda r: (
                -r["qualityPercentile"],
                -r["modelProbability"],
                r["market"],
                r["gamePk"],
            ))
            selected.append(rows[0])
        if len({r["officialDate"] for r in selected}) != len(selected):
            raise SystemExit(f"MODULAR_ROUTER_MULTI_PICK_DATE:{policy_name}")
        daily_picks[policy_name] = selected

    policy_results = {
        name: policy_stats(parent, daily_picks[name], parent_active_dates, eligible_dates, dates_by_season)
        for name in policy_names
    }

    comparisons = {}
    control = daily_picks[contract["nestedPolicyComparison"]["primaryComparator"]]
    for challenger in contract["nestedPolicyComparison"]["challengersExactly"]:
        comparisons[challenger] = paired_comparison(control, daily_picks[challenger])
    comparisons = holm_adjust(comparisons)

    full_name = "CHALLENGER_FULL_MODULAR"
    full_cells = defaultdict(list)
    for row in daily_picks[full_name]:
        key = f"{row['market']}|{row['strengthTier']}|{row['matchupStructure']}|{row['lineGeometry']}"
        full_cells[key].append(row)

    result = {
        "schemaVersion": SCHEMA,
        "classification": "MARKET_STATE_MATCHUP_MODULAR_ROUTER_RETROSPECTIVE_ABLATION_COMPLETE_PROSPECTIVE_CONFIRMATION_REQUIRED",
        "sample": {
            "trainingRows2022": len(by_season["2022"]),
            "calibrationRows2023": len(by_season["2023"]),
            "evaluationRows": sum(len(by_season[s]) for s in EVAL_SEASONS),
            "eligibleSlateDates": len(eligible_dates),
            "parentActiveDates": len(parent_active_dates),
            "parentNoPlayDates": len(parent_no_play_dates),
        },
        "models": model_diagnostics,
        "standingsDiagnostics": standings_diagnostics,
        "structure": {
            "preprocessing": structure_cfg["_prep"],
            "boundariesByHorizonAndTeamState": structure_boundaries,
            "minimumObservedFeatureFraction": structure_cfg["minimumObservedFeatureFraction"],
        },
        "variants": {
            variant: {
                "horizon": info["horizon"],
                "baselineHomeProbability": info["baselineHomeProbability"],
                "thresholdsByTeamState": info["thresholdsByTeamState"],
                "validationEligibleQualityScoresByTeamState": {
                    tier: len(info["validationQualityScores"][tier]) for tier in TIERS
                },
            }
            for variant, info in variants.items()
        },
        "policyResults": policy_results,
        "dailyShadowPicks": daily_picks,
        "candidatePoolCounts": {name: len(pool) for name, pool in candidate_pools.items()},
        "cellEligibilityCounts": {name: dict(counter) for name, counter in cell_eligibility.items()},
        "fullModularFinalPickCells": {
            key: group_basic_stats(parent, rows) for key, rows in sorted(full_cells.items())
        },
        "nestedPolicyComparisonsVsUniformQ85": comparisons,
        "paretoPolicies": pareto_policies(policy_results),
        "coverageReference80Pct": {
            name: policy_results[name]["combinedDailyOpportunityCoveragePct"] >= float(contract["primaryReporting"]["targetCoverageReferencePct"])
            for name in policy_names
        },
        "scientificBoundary": {
            "oneShadowPickMaximumPerParentNoPlayDate": True,
            "parentAPlusPremiumDatesReplaced": False,
            "rulesAreTeamStateAndStructureModularNotTeamNameSpecific": True,
            "matchupStructureUsesPregameFeaturesOnly": True,
            "sameDateOutcomeLeakageAllowed": False,
            "retrospective2024To2026IsIndependentConfirmation": False,
            "prospectiveConfirmationRequired": True,
            "nrfiYrfiContributesCoverage": False,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
            "productionChanged": False,
            "currentAPlusPremiumHierarchyChanged": False,
            "generalV68Fallback": False,
            "v80Dependency": False,
            "forcedDailyPlayAllowed": False,
        },
    }
    dump(args.out, result)
    print(json.dumps({
        "classification": result["classification"],
        "sample": result["sample"],
        "policySummary": {
            name: {
                "coveragePct": policy_results[name]["combinedDailyOpportunityCoveragePct"],
                "shadowPickDates": policy_results[name]["shadowPickDates"],
                "hitRate": policy_results[name]["hitRate"],
                "wilsonLower": policy_results[name]["wilson95"]["lower"] if policy_results[name]["wilson95"] else None,
                "calibrationGap": policy_results[name]["absoluteCalibrationGap"],
                "maxNoPlayStreak": policy_results[name]["remainingNoPlayStreaks"]["maximum"],
            }
            for name in policy_names
        },
        "paretoPolicies": result["paretoPolicies"],
        "nestedComparisons": comparisons,
    }, indent=2))


if __name__ == "__main__":
    main()
