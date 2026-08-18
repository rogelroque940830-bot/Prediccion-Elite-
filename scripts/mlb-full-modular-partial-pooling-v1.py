#!/usr/bin/env python3
import argparse
import json
import math
from collections import defaultdict
from types import SimpleNamespace

import numpy as np
from sklearn.linear_model import LogisticRegression

SCHEMA = "courtedge-mlb-full-modular-partial-pooling.v1"
CONTRACT_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-contract.v1"
FEATURE_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-feature-freeze.v1"
SHRINKAGE_SCHEMA = "courtedge-mlb-full-modular-partial-pooling-shrinkage-freeze.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_MODEL_SEASONS = ("2023", *EVAL_SEASONS)


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    import os
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def numeric_prep(rows, fields, clip, cross):
    prep = {}
    for field in fields:
        vals = np.asarray([cross.finite(r.get(field)) for r in rows], dtype=float)
        observed = vals[np.isfinite(vals)]
        if observed.size == 0:
            raise SystemExit(f"PP_EMPTY_NUMERIC_FEATURE:{field}")
        median = float(np.median(observed))
        vals = np.where(np.isfinite(vals), vals, median)
        mean = float(np.mean(vals))
        std = float(np.std(vals))
        prep[field] = {"median": median, "mean": mean, "std": std, "clip": float(clip)}
    return prep


def zvalue(row, field, prep, cross):
    p = prep[field]
    x = cross.finite(row.get(field))
    if not math.isfinite(x):
        x = p["median"]
    if p["std"] <= 1e-12:
        return 0.0
    return float(np.clip((x - p["mean"]) / p["std"], -p["clip"], p["clip"]))


def design_matrix(train_rows, score_rows, policy_name, contract, feature_freeze, shrinkage, cross):
    numeric = list(feature_freeze["numericGlobalFeatures"])
    categorical = feature_freeze["categoricalGlobalFeatures"]
    pp_signals = list(feature_freeze["partialPoolingSignals"])
    group_levels = feature_freeze["groupLevels"]
    axes = list(contract["policies"][policy_name]["deviationAxes"])
    cfg = shrinkage["axisRules"][policy_name]
    signal_scale = float(cfg["signalDeviationFeatureScale"])
    intercept_scale = float(cfg["groupInterceptFeatureScale"])
    clip = float(feature_freeze["preprocessing"]["standardizedClip"])
    prep = numeric_prep(train_rows, numeric, clip, cross)

    def vector(row):
        values = []
        names = []
        zmap = {}
        for field in numeric:
            z = zvalue(row, field, prep, cross)
            zmap[field] = z
            values.append(z)
            names.append(f"GLOBAL::{field}")
        for field, levels in categorical.items():
            value = str(row[field])
            if value not in levels:
                raise SystemExit(f"PP_UNSEEN_GLOBAL_CATEGORY:{field}:{value}")
            for level in levels:
                values.append(1.0 if value == level else 0.0)
                names.append(f"GLOBAL::{field}={level}")
        for axis in axes:
            levels = group_levels[axis]
            value = str(row[axis])
            if value not in levels:
                raise SystemExit(f"PP_UNSEEN_GROUP_CATEGORY:{axis}:{value}")
            for level in levels:
                indicator = 1.0 if value == level else 0.0
                values.append(intercept_scale * indicator)
                names.append(f"DEV::{axis}={level}::INTERCEPT")
                for signal in pp_signals:
                    values.append(signal_scale * indicator * zmap[signal])
                    names.append(f"DEV::{axis}={level}::{signal}")
        return values, names

    train_matrix = []
    names_ref = None
    for row in train_rows:
        values, names = vector(row)
        if names_ref is None:
            names_ref = names
        elif names != names_ref:
            raise SystemExit("PP_FEATURE_NAME_DRIFT")
        train_matrix.append(values)
    score_matrix = [vector(row)[0] for row in score_rows]
    return np.asarray(train_matrix, dtype=float), np.asarray(score_matrix, dtype=float), names_ref, prep


def fit_and_score(train_rows, score_rows, policy_name, contract, feature_freeze, shrinkage, cross):
    decisive_train = [r for r in train_rows if r["outcome"] != "PUSH"]
    if not decisive_train:
        raise SystemExit(f"PP_EMPTY_TRAIN:{policy_name}")
    y = np.asarray([1 if r["outcome"] == "WIN" else 0 for r in decisive_train], dtype=int)
    if len(set(y.tolist())) != 2:
        raise SystemExit(f"PP_ONE_CLASS_TRAIN:{policy_name}")
    weights = cross.game_balanced_weights(train_rows)
    x_train, x_score, names, prep = design_matrix(decisive_train, score_rows, policy_name, contract, feature_freeze, shrinkage, cross)
    cfg = contract["model"]
    model = LogisticRegression(
        penalty="l2",
        C=float(cfg["regularizationC"]),
        solver=cfg["solver"],
        max_iter=int(cfg["maxIterations"]),
        class_weight=cfg["classWeight"],
    )
    model.fit(x_train, y, sample_weight=weights)
    probs = model.predict_proba(x_score)[:, 1]
    coefs = model.coef_[0]
    ranked = sorted(zip(names, coefs), key=lambda x: (-abs(float(x[1])), x[0]))
    signal_scale = float(shrinkage["deviationGeometry"]["signalDeviationFeatureScale"])
    intercept_scale = float(shrinkage["deviationGeometry"]["groupInterceptFeatureScale"])
    diagnostics = {
        "trainDecisiveRows": len(decisive_train),
        "trainUniqueGames": len({(r["season"], int(r["gamePk"])) for r in decisive_train}),
        "weightedPositiveRate": float(np.average(y, weights=weights)),
        "featureCount": len(names),
        "intercept": float(model.intercept_[0]),
        "signalDeviationFeatureScale": signal_scale,
        "groupInterceptFeatureScale": intercept_scale,
        "topAbsoluteCoefficients": [
            {
                "feature": name,
                "rawCoefficient": float(coef),
                "effectivePredictionCoefficient": float(coef) * (signal_scale if "::INTERCEPT" not in name and name.startswith("DEV::") else intercept_scale if name.startswith("DEV::") else 1.0),
            }
            for name, coef in ranked[:40]
        ],
    }
    return probs, diagnostics


def build_candidates(args, cross, contract, cross_contract, source_count_freeze):
    multi = cross.load_module(args.multi_market_scorer, "pp_multi")
    modular = cross.load_module(args.modular_parent_scorer, "pp_modular")
    parent_router = cross.load_module(args.parent_router_scorer, "pp_parent_router")
    multi_contract = load(args.multi_market_contract)
    modular_contract = load(args.modular_parent_contract)
    parent_router_contract = load(args.parent_router_contract)
    frozen_aplus = load(args.aplus_frozen)
    parent_result = load(args.parent_result)

    if modular_contract.get("schemaVersion") != "courtedge-mlb-modular-team-structure-nrfi-yrfi-contract.v1":
        raise SystemExit("PP_MODULAR_PARENT_CONTRACT_INVALID")
    if frozen_aplus.get("schemaVersion") != "courtedge-p0-step12v2-a-plus-consensus-freeze.v1":
        raise SystemExit("PP_APLUS_SOURCE_INVALID")
    if parent_result.get("schemaVersion") != "courtedge-mlb-full-modular-aplus-premium-cross-anatomy.v1":
        raise SystemExit("PP_PARENT_RESULT_INVALID")

    snapshots, _ = modular.build_standings_snapshots(args.root, parent_router_contract["teamState"]["minimumPriorGamesForStableTier"])
    custody_rows = multi.load_custody(args.custody)
    joined, dates_by_season = modular.load_joined_rows(args.root, custody_rows, snapshots)
    by_season = {s: [r for r in joined if r["season"] == s] for s in ("2022", "2023", "2024", "2025", "2026_YTD")}
    source_index = {(r["season"], int(r["gamePk"])): r for r in joined}
    if len(source_index) != len(joined):
        raise SystemExit("PP_DUPLICATE_GAME_IDENTITY")

    expected = source_count_freeze["certifiedJoinedRows"]
    if len(by_season["2022"]) != int(expected["2022"]):
        raise SystemExit("PP_SOURCE_ROW_DRIFT_2022")
    if len(by_season["2023"]) != int(expected["2023"]):
        raise SystemExit("PP_SOURCE_ROW_DRIFT_2023")
    if sum(len(by_season[s]) for s in EVAL_SEASONS) != int(expected["2024_2026_YTD_combined"]):
        raise SystemExit("PP_SOURCE_ROW_DRIFT_EVAL")

    eligible_dates = set().union(*(dates_by_season[s] for s in EVAL_SEASONS))
    parent_args = SimpleNamespace(
        root=args.root, custody=args.custody, v16_manifest=args.v16_manifest, v68_contract=args.v68_contract,
        classifier_source=args.classifier_source, router_source=args.router_source, v69_contract=args.v69_contract,
        v69_scorer=args.v69_scorer, out=args.out,
    )
    parent_active_dates, parent_no_play_dates = multi.reconstruct_parent_active_dates(parent_args, eligible_dates)
    if len(parent_active_dates) != 200 or len(parent_no_play_dates) != 305 or len(eligible_dates) != 505:
        raise SystemExit("PP_PARENT_DATE_DRIFT")

    direction_features = multi_contract["directionalMarginModels"]["features"]
    margin_prob = defaultdict(dict)
    for horizon in ("F3", "F5", "FG"):
        x_train, prep = multi.fit_matrix(by_season["2022"], direction_features[horizon])
        y_train = np.asarray([multi.margin_class(r[f"{horizon}_diff"], horizon) for r in by_season["2022"]], dtype=int)
        class_count = 4 if horizon == "FG" else 5
        weights = multi.fit_multinomial(
            x_train, y_train, class_count,
            multi_contract["directionalMarginModels"]["l2Strength"],
            multi_contract["directionalMarginModels"]["maxIter"],
        )
        for season in ALL_MODEL_SEASONS:
            margin_prob[horizon][season] = multi.predict_multinomial(multi.apply_matrix(by_season[season], prep), weights, class_count)

    defs = {
        "F3_RL_HOME_PLUS_0_5": "F3",
        "F5_ML": "F5",
        "F5_RL_HOME_MINUS_0_5": "F5",
        "F5_RL_HOME_PLUS_0_5": "F5",
        "FG_ML": "FG",
        "FG_RL_HOME_MINUS_1_5": "FG",
        "FG_RL_HOME_PLUS_1_5": "FG",
    }
    min_probability = float(parent_router_contract["qualityFrontiers"]["minimumSelectedSideModelProbability"])
    quantiles = [0.80, 0.85, 0.90, 0.95]
    variants = {}
    for variant, horizon in defs.items():
        train_y = [multi.home_settlement(r[f"{horizon}_diff"], horizon, variant) for r in by_season["2022"]]
        decisive = [v for v in train_y if v is not None]
        baseline_home = sum(v == 1 for v in decisive) / len(decisive)
        rows_by_s = modular.directional_rows(
            multi, {s: by_season[s] for s in ALL_MODEL_SEASONS}, horizon, variant, margin_prob[horizon], baseline_home
        )
        thresholds = modular.tier_thresholds(rows_by_s["2023"], quantiles, min_probability)
        validation_scores = parent_router.validation_quality_distributions(rows_by_s["2023"], modular, min_probability)
        variants[variant] = {"horizon": horizon, "rows": rows_by_s, "thresholds": thresholds, "validationScores": validation_scores}

    structure_cfg = dict(parent_router_contract["matchupStructure"])
    structure_cfg["roles"] = {k: list(v) for k, v in parent_router_contract["matchupStructure"]["roles"].items()}
    structure_cfg["requiredRolesByHorizon"] = {k: list(v) for k, v in parent_router_contract["matchupStructure"]["requiredRolesByHorizon"].items()}
    structure_cfg["_prep"] = parent_router.preprocess_structure(by_season["2022"], structure_cfg)
    structure_boundaries = parent_router.build_structure_boundaries(
        {v: info["rows"]["2023"] for v, info in variants.items()}, source_index,
        parent_router_contract["marketScope"]["horizonByVariant"], structure_cfg, modular,
    )

    premium_std = {
        p["feature"]: cross.training_feature_std(by_season["2022"], p["feature"])
        for p in cross_contract["frozenPremiumAHeritage"]["exactPillars"]
    }
    training_median = {}
    for p in cross_contract["frozenPremiumAHeritage"]["exactPillars"]:
        feature = p["feature"]
        values = np.asarray([cross.finite(r.get(feature)) for r in by_season["2022"]], dtype=float)
        values = values[np.isfinite(values)]
        training_median[feature] = float(np.median(values))

    all_candidates = {s: [] for s in ALL_MODEL_SEASONS}
    eval_candidates = {s: [] for s in EVAL_SEASONS}
    for variant, info in variants.items():
        horizon = info["horizon"]
        for season in ALL_MODEL_SEASONS:
            for row in info["rows"][season]:
                side, score, probability, tier, outcome = modular.selected_direction(row)
                source = source_index[(season, int(row["gamePk"]))]
                struct_score, struct_diag = parent_router.structure_score(source, side, horizon, structure_cfg, structure_cfg["_prep"])
                struct_state = parent_router.classify_structure(struct_score, structure_boundaries[horizon][tier])
                geometry, selected_line = parent_router.selected_line_geometry(variant, side)
                percentile = parent_router.empirical_percentile(info["validationScores"][tier], score)
                if percentile is None:
                    continue
                frontier = parent_router.resolve_frontier("CHALLENGER_FULL_MODULAR", tier, struct_state, geometry, parent_router_contract)
                if frontier == "NO_PLAY":
                    continue
                threshold = info["thresholds"][tier].get(frontier)
                if threshold is None or score <= 0 or probability < min_probability or score + 1e-15 < threshold:
                    continue
                candidate = {
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
                }
                candidate = cross.add_heritage(candidate, source, cross_contract, frozen_aplus, premium_std, training_median)
                all_candidates[season].append(candidate)
                if season in EVAL_SEASONS and candidate["officialDate"] in parent_no_play_dates:
                    eval_candidates[season].append(candidate)

    control = cross.select_daily([r for s in EVAL_SEASONS for r in eval_candidates[s]])
    parent_control = parent_result["dailyShadowPicks"]["CONTROL_FULL_MODULAR"]
    if len(control) != int(contract["candidateUniverse"]["expectedShadowDates"]):
        raise SystemExit(f"PP_CONTROL_PICK_COUNT_DRIFT:{len(control)}")
    if [cross.identity(r) for r in control] != [cross.identity(r) for r in parent_control]:
        raise SystemExit("PP_CONTROL_IDENTITY_PARITY_FAILED")

    return {
        "bySeason": by_season,
        "eligibleDates": eligible_dates,
        "parentActiveDates": parent_active_dates,
        "parentNoPlayDates": parent_no_play_dates,
        "allCandidates": all_candidates,
        "evalCandidates": eval_candidates,
        "control": control,
    }


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source", "router-source",
        "v69-contract", "v69-scorer", "multi-market-scorer", "multi-market-contract",
        "modular-parent-scorer", "modular-parent-contract", "parent-router-scorer", "parent-router-contract",
        "cross-scorer", "cross-contract", "source-count-freeze", "aplus-frozen", "parent-result",
        "contract", "feature-freeze", "shrinkage-freeze", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    feature_freeze = load(args.feature_freeze)
    shrinkage = load(args.shrinkage_freeze)
    cross_contract = load(args.cross_contract)
    source_count_freeze = load(args.source_count_freeze)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("PP_CONTRACT_SCHEMA_INVALID")
    if feature_freeze.get("schemaVersion") != FEATURE_SCHEMA:
        raise SystemExit("PP_FEATURE_SCHEMA_INVALID")
    if shrinkage.get("schemaVersion") != SHRINKAGE_SCHEMA:
        raise SystemExit("PP_SHRINKAGE_SCHEMA_INVALID")
    if contract["scientificChronology"]["retrospectiveEvaluationIsIndependentConfirmation"] is not False:
        raise SystemExit("PP_CONFIRMATION_BOUNDARY_DRIFT")
    if contract["promotionBoundary"]["productionChanged"] is not False:
        raise SystemExit("PP_PRODUCTION_BOUNDARY_DRIFT")
    if contract["candidateUniverse"]["challengerChangesRankingOnly"] is not True:
        raise SystemExit("PP_CANDIDATE_UNIVERSE_DRIFT")
    if shrinkage["noRetuning"]["postResultScaleChangeAllowed"] is not False:
        raise SystemExit("PP_SHRINKAGE_RETUNE_BOUNDARY_DRIFT")

    cross = __import__("importlib.util").util.spec_from_file_location("pp_cross", args.cross_scorer)
    if cross is None or cross.loader is None:
        raise SystemExit("PP_CROSS_IMPORT_SPEC_FAILED")
    cross_module = __import__("importlib.util").util.module_from_spec(cross)
    cross.loader.exec_module(cross_module)
    cross = cross_module

    built = build_candidates(args, cross, contract, cross_contract, source_count_freeze)
    control = built["control"]
    all_candidates = built["allCandidates"]
    eval_candidates = built["evalCandidates"]

    policies = {"CONTROL_FULL_MODULAR": control}
    diagnostics = {}
    policy_order = ("CHALLENGER_PP_HORIZON", "CHALLENGER_PP_STRENGTH", "CHALLENGER_PP_ADDITIVE")
    temporal = contract["temporalProtocol"]
    for policy_name in policy_order:
        selected = []
        diagnostics[policy_name] = {}
        for target in EVAL_SEASONS:
            prior = temporal[target]
            train = [r for season in prior for r in all_candidates[season]]
            score = eval_candidates[target]
            probs, diag = fit_and_score(train, score, policy_name, contract, feature_freeze, shrinkage, cross)
            diagnostics[policy_name][target] = diag
            scored = []
            for row, p in zip(score, probs):
                x = dict(row)
                x["partialPoolProbability"] = float(p)
                scored.append(x)
            selected.extend(cross.select_daily(scored, "partialPoolProbability"))
        policies[policy_name] = selected

    control_dates = [r["officialDate"] for r in control]
    for name, rows in policies.items():
        dates = [r["officialDate"] for r in rows]
        if dates != control_dates:
            raise SystemExit(f"PP_COVERAGE_DATE_PARITY_FAILED:{name}")

    results = {}
    for name, rows in policies.items():
        probability_field = "modelProbability" if name == "CONTROL_FULL_MODULAR" else "partialPoolProbability"
        result = cross.policy_stats(rows, probability_field)
        result["sameDateCoverageParity"] = True
        result["bySeason"] = {s: cross.policy_stats([r for r in rows if r["season"] == s], probability_field) for s in EVAL_SEASONS}
        result["byHorizon"] = cross.subgroup(rows, "horizon", probability_field)
        result["byStrengthTier"] = cross.subgroup(rows, "strengthTier", probability_field)
        result["byLineGeometry"] = cross.subgroup(rows, "lineGeometry", probability_field)
        result["byMatchupStructure"] = cross.subgroup(rows, "matchupStructure", probability_field)
        results[name] = result

    comparisons = cross.holm({name: cross.paired(control, rows) for name, rows in policies.items() if name != "CONTROL_FULL_MODULAR"})

    output = {
        "schemaVersion": SCHEMA,
        "classification": "FULL_MODULAR_CONTEXT_CONDITIONED_PARTIAL_POOLING_RETROSPECTIVE_COMPLETE_PROSPECTIVE_CONFIRMATION_REQUIRED",
        "sample": {
            "trainingRows2022": len(built["bySeason"]["2022"]),
            "calibrationRows2023": len(built["bySeason"]["2023"]),
            "evaluationRows": sum(len(built["bySeason"][s]) for s in EVAL_SEASONS),
            "eligibleSlateDates": len(built["eligibleDates"]),
            "parentActiveDates": len(built["parentActiveDates"]),
            "parentNoPlayDates": len(built["parentNoPlayDates"]),
            "fullModularControlShadowDates": len(control),
            "allCandidateRowsBySeason": {s: len(all_candidates[s]) for s in ALL_MODEL_SEASONS},
            "evaluationNoPlayCandidateRowsBySeason": {s: len(eval_candidates[s]) for s in EVAL_SEASONS},
        },
        "policyResults": results,
        "pairedComparisonsVsControl": comparisons,
        "modelDiagnostics": diagnostics,
        "dailyShadowPicks": policies,
        "scientificDecisionBoundary": {
            "retrospectiveWinnerMayBeDeclared": False,
            "productionChanged": False,
            "currentAPlusPremiumHierarchyChanged": False,
            "fullModularProductionPromoted": False,
            "challengersChangeEligibility": False,
            "challengersChangeCoverage": False,
            "sameDateOutcomeLeakageAllowed": False,
            "futureSeasonTrainingAllowed": False,
            "historicalPricesUsed": False,
            "positiveEvEstablished": False,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
            "prospectiveLiveShadowRequiredBeforeAnyPromotion": True,
        },
    }
    dump(args.out, output)
    print(json.dumps({"sample": output["sample"], "policyResults": results, "pairedComparisonsVsControl": comparisons}, indent=2))


if __name__ == "__main__":
    main()
