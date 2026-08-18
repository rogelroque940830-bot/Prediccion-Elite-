#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os
from collections import Counter, defaultdict
from types import SimpleNamespace

import numpy as np
from scipy.stats import binomtest
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score

SCHEMA = "courtedge-mlb-full-modular-aplus-premium-cross-anatomy.v1"
CONTRACT_SCHEMA = "courtedge-mlb-full-modular-aplus-premium-cross-anatomy-contract.v1"
FEATURE_FREEZE_SCHEMA = "courtedge-mlb-full-modular-aplus-premium-feature-engineering-freeze.v1"
WEIGHT_FREEZE_SCHEMA = "courtedge-mlb-full-modular-aplus-premium-training-weight-freeze.v1"
SOURCE_COUNT_FREEZE_SCHEMA = "courtedge-mlb-full-modular-aplus-premium-source-count-freeze.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_MODEL_SEASONS = ("2023", *EVAL_SEASONS)


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
        raise SystemExit(f"AP_CROSS_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finite(value):
    try:
        x = float(value)
        return x if math.isfinite(x) else math.nan
    except (TypeError, ValueError):
        return math.nan


def sigmoid(z):
    if z >= 0:
        e = math.exp(-z)
        return 1.0 / (1.0 + e)
    e = math.exp(z)
    return e / (1.0 + e)


def frozen_home_probability(source, model):
    z = float(model["intercept"])
    for spec in model["features"]:
        raw = finite(source.get(spec["name"]))
        if not math.isfinite(raw):
            raw = float(spec["medianImpute"])
        scale = float(spec["scale"])
        standardized = 0.0 if abs(scale) <= 1e-15 else (raw - float(spec["mean"])) / scale
        z += float(spec["coef"]) * standardized
    return sigmoid(z)


def selected_value(source, feature, side):
    raw = finite(source.get(feature))
    if not math.isfinite(raw):
        return math.nan
    if feature.endswith("_adv") or feature.endswith("_diff"):
        return raw if side == "HOME" else -raw
    return raw


def training_feature_std(rows_2022, feature):
    values = [finite(r.get(feature)) for r in rows_2022]
    values = np.asarray([v for v in values if math.isfinite(v)], dtype=float)
    if values.size == 0:
        raise SystemExit(f"AP_CROSS_EMPTY_TRAIN_FEATURE:{feature}")
    std = float(np.std(values))
    if std <= 1e-12:
        raise SystemExit(f"AP_CROSS_ZERO_TRAIN_STD:{feature}")
    return std


def add_heritage(candidate, source, contract, frozen_aplus, premium_std, training_median):
    side = candidate["side"]
    heritage = contract["heritageFeatureSet"]
    for feature in heritage["directionalSelectedSideFeatures"]:
        candidate[f"sel_{feature}"] = selected_value(source, feature, side)
    for feature in heritage["nonDirectionalContextFeatures"]:
        candidate[feature] = finite(source.get(feature))

    supports = 0
    normalized_margins = []
    for pillar in contract["frozenPremiumAHeritage"]["exactPillars"]:
        feature = pillar["feature"]
        threshold = float(pillar["selectedSideThreshold"])
        raw = candidate[f"sel_{feature}"]
        if not math.isfinite(raw):
            raw = training_median[feature]
        if raw >= threshold:
            supports += 1
        normalized_margins.append((raw - threshold) / premium_std[feature])
    candidate["premium_core_support_count_0_to_3"] = supports
    candidate["premium_core_weakest_margin"] = float(min(normalized_margins))

    c4 = frozen_aplus["models"]["ML_C4_2022_FROZEN"]
    full13 = frozen_aplus["models"]["ML_FULL13_2022_FROZEN"]
    p_c4_home = frozen_home_probability(source, c4)
    p_full_home = frozen_home_probability(source, full13)
    p_c4 = p_c4_home if side == "HOME" else 1.0 - p_c4_home
    p_full = p_full_home if side == "HOME" else 1.0 - p_full_home
    candidate["frozen_c4_selected_side_probability"] = float(p_c4)
    candidate["frozen_full13_selected_side_probability"] = float(p_full)
    c4_ref = float(contract["frozenAPlusHeritage"]["c4SelectedSideProbabilityReference"])
    f13_ref = float(contract["frozenAPlusHeritage"]["full13SelectedSideProbabilityReference"])
    candidate["frozen_consensus_weakest_probability_margin"] = float(min(p_c4 - c4_ref, p_full - f13_ref))
    candidate["premium_like_3_of_3"] = supports == 3
    candidate["aplus_consensus_like"] = bool(supports == 3 and p_c4 >= c4_ref and p_full >= f13_ref)
    return candidate


def select_daily(pool, score_field=None):
    by_date = defaultdict(list)
    for row in pool:
        by_date[row["officialDate"]].append(row)
    selected = []
    for date, rows in sorted(by_date.items()):
        if score_field is None:
            rows.sort(key=lambda r: (-r["qualityPercentile"], -r["modelProbability"], r["market"], r["gamePk"]))
        else:
            rows.sort(key=lambda r: (-r[score_field], -r["qualityPercentile"], -r["modelProbability"], r["market"], r["gamePk"]))
        selected.append(dict(rows[0]))
    return selected


def identity(row):
    return (
        row["officialDate"], int(row["gamePk"]), row["market"], row["side"],
        None if row.get("selectedLine") is None else float(row["selectedLine"]), row["frontier"],
    )


def game_balanced_weights(rows):
    counts = Counter((r["season"], int(r["gamePk"])) for r in rows if r["outcome"] != "PUSH")
    return np.asarray([1.0 / counts[(r["season"], int(r["gamePk"]))] for r in rows if r["outcome"] != "PUSH"], dtype=float)


def numeric_prep(train_rows, fields, clip):
    prep = {}
    for field in fields:
        vals = np.asarray([finite(r.get(field)) for r in train_rows], dtype=float)
        observed = vals[np.isfinite(vals)]
        if observed.size == 0:
            raise SystemExit(f"AP_CROSS_MODEL_FEATURE_EMPTY:{field}")
        median = float(np.median(observed))
        vals = np.where(np.isfinite(vals), vals, median)
        mean = float(np.mean(vals))
        std = float(np.std(vals))
        prep[field] = {"median": median, "mean": mean, "std": std, "clip": clip}
    return prep


def zvalue(row, field, prep):
    p = prep[field]
    x = finite(row.get(field))
    if not math.isfinite(x):
        x = p["median"]
    if p["std"] <= 1e-12:
        return 0.0
    return float(np.clip((x - p["mean"]) / p["std"], -p["clip"], p["clip"]))


def context_design(train_rows, score_rows, contract, feature_freeze, kind):
    if kind == "CORE":
        numeric = list(contract["policies"]["CHALLENGER_AP_CORE_DYNAMIC_RERANK"]["modelInputs"])
        categoricals = []
        interactions = []
    elif kind == "CONTEXT":
        numeric = []
        for f in contract["heritageFeatureSet"]["directionalSelectedSideFeatures"]:
            numeric.append(f"sel_{f}")
        numeric += list(contract["heritageFeatureSet"]["nonDirectionalContextFeatures"])
        numeric += list(contract["heritageFeatureSet"]["derivedFrozenSignals"])
        numeric += list(contract["fullModularContextSet"]["continuous"])
        numeric = list(dict.fromkeys(numeric))
        categoricals = list(contract["fullModularContextSet"]["categorical"])
        interactions = list(contract["dynamicInteractionSet"]["exactInteractions"])
    else:
        raise SystemExit(f"AP_CROSS_DESIGN_UNKNOWN:{kind}")

    clip = float(feature_freeze["numericPreprocessing"]["clipStandardizedValue"])
    prep = numeric_prep(train_rows, numeric, clip)
    levels = feature_freeze["categoricalLevels"]

    def main_vector(row):
        values = []
        names = []
        zmap = {}
        for field in numeric:
            z = zvalue(row, field, prep)
            zmap[field] = z
            values.append(z)
            names.append(field)
        onehot = {}
        for field in categoricals:
            value = str(row[field])
            if value not in levels[field]:
                raise SystemExit(f"AP_CROSS_UNSEEN_CATEGORY:{field}:{value}")
            for level in levels[field]:
                x = 1.0 if value == level else 0.0
                onehot[(field, level)] = x
                values.append(x)
                names.append(f"{field}={level}")

        if kind == "CONTEXT":
            specs = {
                "premium_core_weakest_margin_X_strengthTier": ("premium_core_weakest_margin", "strengthTier"),
                "premium_core_weakest_margin_X_lineGeometry": ("premium_core_weakest_margin", "lineGeometry"),
                "frozen_consensus_weakest_probability_margin_X_horizon": ("frozen_consensus_weakest_probability_margin", "horizon"),
                "frozen_consensus_weakest_probability_margin_X_lineGeometry": ("frozen_consensus_weakest_probability_margin", "lineGeometry"),
                "frozen_c4_selected_side_probability_X_market": ("frozen_c4_selected_side_probability", "market"),
                "frozen_full13_selected_side_probability_X_market": ("frozen_full13_selected_side_probability", "market"),
                "starter_kbb_selected_adv_X_horizon": ("sel_starter_kbb_adv", "horizon"),
                "team_win10_selected_diff_X_strengthTier": ("sel_team_win10_diff", "strengthTier"),
                "lineup_exposure_selected_adv_X_matchupStructure": ("sel_lineup_exposure_rate_adv", "matchupStructure"),
                "team_ra10_selected_adv_X_horizon": ("sel_team_ra10_adv", "horizon"),
                "starter_runrisk_selected_adv_X_horizon": ("sel_starter_runrisk_adv", "horizon"),
            }
            for name in interactions:
                if name == "structureScore_X_frozen_consensus_weakest_probability_margin":
                    values.append(zmap["structureScore"] * zmap["frozen_consensus_weakest_probability_margin"])
                    names.append(name)
                    continue
                if name not in specs:
                    raise SystemExit(f"AP_CROSS_INTERACTION_UNKNOWN:{name}")
                num, cat = specs[name]
                for level in levels[cat]:
                    values.append(zmap[num] * onehot[(cat, level)])
                    names.append(f"{name}:{level}")
        return values, names

    train_matrix = []
    feature_names = None
    for row in train_rows:
        values, names = main_vector(row)
        if feature_names is None:
            feature_names = names
        elif names != feature_names:
            raise SystemExit("AP_CROSS_FEATURE_NAME_DRIFT")
        train_matrix.append(values)
    score_matrix = [main_vector(row)[0] for row in score_rows]
    return np.asarray(train_matrix, dtype=float), np.asarray(score_matrix, dtype=float), feature_names, prep


def fit_and_score(train_rows, score_rows, contract, feature_freeze, kind):
    decisive_train = [r for r in train_rows if r["outcome"] != "PUSH"]
    if not decisive_train:
        raise SystemExit(f"AP_CROSS_EMPTY_TRAIN:{kind}")
    y = np.asarray([1 if r["outcome"] == "WIN" else 0 for r in decisive_train], dtype=int)
    if len(set(y.tolist())) != 2:
        raise SystemExit(f"AP_CROSS_ONE_CLASS_TRAIN:{kind}")
    weights = game_balanced_weights(train_rows)
    x_train, x_score, names, prep = context_design(decisive_train, score_rows, contract, feature_freeze, kind)
    cfg = contract["trainingAndEvaluation"]
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
    diag = {
        "trainDecisiveRows": len(decisive_train),
        "trainUniqueGames": len({(r["season"], int(r["gamePk"])) for r in decisive_train}),
        "positiveRateWeighted": float(np.average(y, weights=weights)),
        "featureCount": len(names),
        "intercept": float(model.intercept_[0]),
        "topAbsoluteCoefficients": [{"feature": n, "coefficient": float(c)} for n, c in ranked[:25]],
    }
    return probs, diag


def wilson(wins, n, z=1.959963984540054):
    if n <= 0:
        return None
    p = wins / n
    den = 1 + z * z / n
    center = (p + z * z / (2 * n)) / den
    margin = z * math.sqrt(p * (1-p)/n + z*z/(4*n*n)) / den
    return {"lower": center - margin, "upper": center + margin}


def policy_stats(rows, probability_field):
    decisive = [r for r in rows if r["outcome"] != "PUSH"]
    y = np.asarray([1 if r["outcome"] == "WIN" else 0 for r in decisive], dtype=int)
    p = np.asarray([float(r[probability_field]) for r in decisive], dtype=float)
    wins = int(y.sum())
    losses = int(len(y) - wins)
    pushes = sum(r["outcome"] == "PUSH" for r in rows)
    hit = wins / len(y) if len(y) else None
    brier = float(np.mean((p-y)**2)) if len(y) else None
    ll = float(log_loss(y, p, labels=[0,1])) if len(y) else None
    auc = float(roc_auc_score(y,p)) if len(set(y.tolist()))==2 else None
    mean_p = float(np.mean(p)) if len(p) else None
    return {
        "picks": len(rows), "wins": wins, "losses": losses, "pushes": pushes, "decisive": len(y),
        "hitRate": hit, "wilson95": wilson(wins, len(y)), "meanDecisionProbability": mean_p,
        "decisiveBrierScore": brier, "logLoss": ll, "rocAuc": auc,
        "absoluteCalibrationGap": abs(hit-mean_p) if hit is not None and mean_p is not None else None,
    }


def subgroup(rows, field, probability_field):
    groups = defaultdict(list)
    for r in rows:
        groups[str(r[field])].append(r)
    return {k: policy_stats(v, probability_field) for k,v in sorted(groups.items())}


def cross_tables(rows, probability_field):
    return {
        "premiumSupportCount": subgroup(rows, "premium_core_support_count_0_to_3", probability_field),
        "premiumLike3Of3": subgroup(rows, "premium_like_3_of_3", probability_field),
        "aPlusConsensusLike": subgroup(rows, "aplus_consensus_like", probability_field),
    }


def paired(control, challenger):
    c = {r["officialDate"]: r for r in control if r["outcome"] != "PUSH"}
    q = {r["officialDate"]: r for r in challenger if r["outcome"] != "PUSH"}
    overlap = sorted(set(c) & set(q))
    both_correct=both_wrong=q_only=c_only=0
    for d in overlap:
        cw = c[d]["outcome"] == "WIN"
        qw = q[d]["outcome"] == "WIN"
        if cw and qw: both_correct += 1
        elif not cw and not qw: both_wrong += 1
        elif qw: q_only += 1
        else: c_only += 1
    discordant=q_only+c_only
    p=float(binomtest(q_only, discordant, p=0.5, alternative="two-sided").pvalue) if discordant else 1.0
    return {
        "overlapDecisiveDates": len(overlap), "bothCorrect": both_correct, "bothWrong": both_wrong,
        "challengerOnlyCorrect": q_only, "controlOnlyCorrect": c_only, "discordantDates": discordant,
        "unadjustedPValue": p,
    }


def holm(comparisons):
    items=sorted(comparisons.items(), key=lambda kv: kv[1]["unadjustedPValue"])
    running=0.0; m=len(items)
    for rank,(name,res) in enumerate(items,1):
        adj=min(1.0,(m-rank+1)*res["unadjustedPValue"])
        running=max(running,adj)
        res["holmAdjustedPValue"]=running
        res["holmRejectAt005"]=running<=0.05
    return comparisons


def main():
    parser=argparse.ArgumentParser()
    for name in (
        "root","custody","v16-manifest","v68-contract","classifier-source","router-source",
        "v69-contract","v69-scorer","multi-market-scorer","multi-market-contract",
        "modular-parent-scorer","modular-parent-contract","parent-router-scorer","parent-router-contract",
        "aplus-frozen","parent-artifact","contract","feature-freeze","weight-freeze","source-count-freeze","out",
    ):
        parser.add_argument(f"--{name}",required=True)
    args=parser.parse_args()

    contract=load(args.contract)
    feature_freeze=load(args.feature_freeze)
    weight_freeze=load(args.weight_freeze)
    source_count_freeze=load(args.source_count_freeze)
    if contract.get("schemaVersion")!=CONTRACT_SCHEMA:
        raise SystemExit("AP_CROSS_CONTRACT_SCHEMA_INVALID")
    if feature_freeze.get("schemaVersion")!=FEATURE_FREEZE_SCHEMA:
        raise SystemExit("AP_CROSS_FEATURE_FREEZE_INVALID")
    if weight_freeze.get("schemaVersion")!=WEIGHT_FREEZE_SCHEMA:
        raise SystemExit("AP_CROSS_WEIGHT_FREEZE_INVALID")
    if source_count_freeze.get("schemaVersion")!=SOURCE_COUNT_FREEZE_SCHEMA:
        raise SystemExit("AP_CROSS_SOURCE_COUNT_FREEZE_INVALID")
    if contract["scientificChronology"]["retrospectiveEvaluationIsIndependentConfirmation"] is not False:
        raise SystemExit("AP_CROSS_CONFIRMATION_BOUNDARY_DRIFT")
    if contract["promotionBoundary"]["productionChanged"] is not False:
        raise SystemExit("AP_CROSS_PRODUCTION_BOUNDARY_DRIFT")
    if contract["coverageLock"]["challengersMustHaveSameShadowPickDatesAsControl"] is not True:
        raise SystemExit("AP_CROSS_COVERAGE_LOCK_DRIFT")

    multi=load_module(args.multi_market_scorer,"ap_cross_multi")
    modular=load_module(args.modular_parent_scorer,"ap_cross_modular")
    parent_router=load_module(args.parent_router_scorer,"ap_cross_parent_router")
    multi_contract=load(args.multi_market_contract)
    modular_contract=load(args.modular_parent_contract)
    parent_router_contract=load(args.parent_router_contract)
    frozen_aplus=load(args.aplus_frozen)
    parent_artifact=load(args.parent_artifact)

    if modular_contract.get("schemaVersion")!="courtedge-mlb-modular-team-structure-nrfi-yrfi-contract.v1":
        raise SystemExit("AP_CROSS_MODULAR_PARENT_CONTRACT_INVALID")
    if frozen_aplus.get("schemaVersion")!="courtedge-p0-step12v2-a-plus-consensus-freeze.v1":
        raise SystemExit("AP_CROSS_APLUS_SOURCE_INVALID")
    if parent_artifact.get("schemaVersion")!="courtedge-mlb-market-state-matchup-modular-router.v1":
        raise SystemExit("AP_CROSS_PARENT_ARTIFACT_INVALID")

    snapshots,_=modular.build_standings_snapshots(args.root, parent_router_contract["teamState"]["minimumPriorGamesForStableTier"])
    custody_rows=multi.load_custody(args.custody)
    joined,dates_by_season=modular.load_joined_rows(args.root,custody_rows,snapshots)
    by_season={s:[r for r in joined if r["season"]==s] for s in ("2022","2023","2024","2025","2026_YTD")}
    source_index={(r["season"],int(r["gamePk"])):r for r in joined}
    if len(source_index)!=len(joined):
        raise SystemExit("AP_CROSS_DUPLICATE_GAME_IDENTITY")

    expected_joined=source_count_freeze["certifiedJoinedRows"]
    if len(by_season["2022"])!=int(expected_joined["2022"]):
        raise SystemExit(f"AP_CROSS_SOURCE_ROW_DRIFT:2022:{len(by_season['2022'])}")
    if len(by_season["2023"])!=int(expected_joined["2023"]):
        raise SystemExit(f"AP_CROSS_SOURCE_ROW_DRIFT:2023:{len(by_season['2023'])}")
    if sum(len(by_season[s]) for s in EVAL_SEASONS)!=int(expected_joined["2024_2026_YTD_combined"]):
        raise SystemExit("AP_CROSS_EVAL_JOINED_ROW_DRIFT")

    eligible_dates=set().union(*(dates_by_season[s] for s in EVAL_SEASONS))
    parent_args=SimpleNamespace(
        root=args.root,custody=args.custody,v16_manifest=args.v16_manifest,v68_contract=args.v68_contract,
        classifier_source=args.classifier_source,router_source=args.router_source,v69_contract=args.v69_contract,
        v69_scorer=args.v69_scorer,out=args.out,
    )
    parent_active_dates,parent_no_play_dates=multi.reconstruct_parent_active_dates(parent_args,eligible_dates)
    if len(parent_active_dates)!=200 or len(parent_no_play_dates)!=305 or len(eligible_dates)!=505:
        raise SystemExit("AP_CROSS_PARENT_DATE_DRIFT")

    direction_features=multi_contract["directionalMarginModels"]["features"]
    margin_prob=defaultdict(dict)
    for horizon in ("F3","F5","FG"):
        x_train,prep=multi.fit_matrix(by_season["2022"],direction_features[horizon])
        y_train=np.asarray([multi.margin_class(r[f"{horizon}_diff"],horizon) for r in by_season["2022"]],dtype=int)
        class_count=4 if horizon=="FG" else 5
        weights=multi.fit_multinomial(x_train,y_train,class_count,multi_contract["directionalMarginModels"]["l2Strength"],multi_contract["directionalMarginModels"]["maxIter"])
        for season in ALL_MODEL_SEASONS:
            margin_prob[horizon][season]=multi.predict_multinomial(multi.apply_matrix(by_season[season],prep),weights,class_count)

    defs={
        "F3_RL_HOME_PLUS_0_5":"F3","F5_ML":"F5","F5_RL_HOME_MINUS_0_5":"F5",
        "F5_RL_HOME_PLUS_0_5":"F5","FG_ML":"FG","FG_RL_HOME_MINUS_1_5":"FG","FG_RL_HOME_PLUS_1_5":"FG",
    }
    min_probability=float(parent_router_contract["qualityFrontiers"]["minimumSelectedSideModelProbability"])
    quantiles=[0.80,0.85,0.90,0.95]
    variants={}
    for variant,horizon in defs.items():
        train_y=[multi.home_settlement(r[f"{horizon}_diff"],horizon,variant) for r in by_season["2022"]]
        decisive=[v for v in train_y if v is not None]
        baseline_home=sum(v==1 for v in decisive)/len(decisive)
        rows_by_s=modular.directional_rows(multi,{s:by_season[s] for s in ALL_MODEL_SEASONS},horizon,variant,margin_prob[horizon],baseline_home)
        thresholds=modular.tier_thresholds(rows_by_s["2023"],quantiles,min_probability)
        validation_scores=parent_router.validation_quality_distributions(rows_by_s["2023"],modular,min_probability)
        variants[variant]={"horizon":horizon,"rows":rows_by_s,"thresholds":thresholds,"validationScores":validation_scores}

    structure_cfg=dict(parent_router_contract["matchupStructure"])
    structure_cfg["roles"]={k:list(v) for k,v in parent_router_contract["matchupStructure"]["roles"].items()}
    structure_cfg["requiredRolesByHorizon"]={k:list(v) for k,v in parent_router_contract["matchupStructure"]["requiredRolesByHorizon"].items()}
    structure_cfg["_prep"]=parent_router.preprocess_structure(by_season["2022"],structure_cfg)
    structure_boundaries=parent_router.build_structure_boundaries(
        {v:info["rows"]["2023"] for v,info in variants.items()},source_index,
        parent_router_contract["marketScope"]["horizonByVariant"],structure_cfg,modular
    )

    premium_std={p["feature"]:training_feature_std(by_season["2022"],p["feature"]) for p in contract["frozenPremiumAHeritage"]["exactPillars"]}
    training_median={}
    for p in contract["frozenPremiumAHeritage"]["exactPillars"]:
        feature=p["feature"]
        values=np.asarray([finite(r.get(feature)) for r in by_season["2022"]],dtype=float)
        values=values[np.isfinite(values)]
        training_median[feature]=float(np.median(values))

    all_candidates={s:[] for s in ALL_MODEL_SEASONS}
    eval_candidates={s:[] for s in EVAL_SEASONS}
    for variant,info in variants.items():
        horizon=info["horizon"]
        for season in ALL_MODEL_SEASONS:
            for row in info["rows"][season]:
                side,score,probability,tier,outcome=modular.selected_direction(row)
                source=source_index[(season,int(row["gamePk"]))]
                struct_score,struct_diag=parent_router.structure_score(source,side,horizon,structure_cfg,structure_cfg["_prep"])
                struct_state=parent_router.classify_structure(struct_score,structure_boundaries[horizon][tier])
                geometry,selected_line=parent_router.selected_line_geometry(variant,side)
                percentile=parent_router.empirical_percentile(info["validationScores"][tier],score)
                if percentile is None:
                    continue
                frontier=parent_router.resolve_frontier("CHALLENGER_FULL_MODULAR",tier,struct_state,geometry,parent_router_contract)
                if frontier=="NO_PLAY":
                    continue
                threshold=info["thresholds"][tier].get(frontier)
                if threshold is None or score<=0 or probability<min_probability or score+1e-15<threshold:
                    continue
                candidate={
                    "season":season,"officialDate":row["officialDate"],"gamePk":int(row["gamePk"]),
                    "market":variant,"horizon":horizon,"side":side,"selectedLine":selected_line,
                    "lineGeometry":geometry,"strengthTier":tier,"matchupStructure":struct_state,
                    "structureScore":struct_score,"structureObservedFeatureFraction":struct_diag["observedFeatureFraction"],
                    "frontier":frontier,"qualityScore":float(score),"qualityPercentile":float(percentile),
                    "modelProbability":float(probability),"outcome":outcome,
                }
                candidate=add_heritage(candidate,source,contract,frozen_aplus,premium_std,training_median)
                all_candidates[season].append(candidate)
                if season in EVAL_SEASONS and candidate["officialDate"] in parent_no_play_dates:
                    eval_candidates[season].append(candidate)

    control_pool=[r for s in EVAL_SEASONS for r in eval_candidates[s]]
    control=select_daily(control_pool)
    parent_control=parent_artifact["dailyShadowPicks"][contract["parent"]["controlPolicy"]]
    if len(control)!=contract["parent"]["expectedShadowPickDates"]:
        raise SystemExit(f"AP_CROSS_CONTROL_PICK_COUNT_DRIFT:{len(control)}")
    if [identity(r) for r in control] != [identity(r) for r in parent_control]:
        raise SystemExit("AP_CROSS_CONTROL_IDENTITY_PARITY_FAILED")

    policies={"CONTROL_FULL_MODULAR":control}
    model_diagnostics={"CORE":{},"CONTEXT":{}}
    for kind,policy_name in (("CORE","CHALLENGER_AP_CORE_DYNAMIC_RERANK"),("CONTEXT","CHALLENGER_AP_CONTEXT_DYNAMIC_RERANK")):
        selected=[]
        for target in EVAL_SEASONS:
            prior={"2024":["2023"],"2025":["2023","2024"],"2026_YTD":["2023","2024","2025"]}[target]
            train=[r for s in prior for r in all_candidates[s]]
            score=eval_candidates[target]
            probs,diag=fit_and_score(train,score,contract,feature_freeze,kind)
            model_diagnostics[kind][target]=diag
            scored=[]
            for row,p in zip(score,probs):
                x=dict(row); x["dynamicMetaProbability"]=float(p); scored.append(x)
            selected.extend(select_daily(scored,"dynamicMetaProbability"))
        policies[policy_name]=selected

    control_dates=[r["officialDate"] for r in control]
    for name,rows in policies.items():
        dates=[r["officialDate"] for r in rows]
        if dates!=control_dates:
            raise SystemExit(f"AP_CROSS_COVERAGE_DATE_PARITY_FAILED:{name}")

    results={}
    for name,rows in policies.items():
        prob_field="modelProbability" if name=="CONTROL_FULL_MODULAR" else "dynamicMetaProbability"
        result=policy_stats(rows,prob_field)
        result["sameDateCoverageParity"]=True
        result["bySeason"]={s:policy_stats([r for r in rows if r["season"]==s],prob_field) for s in EVAL_SEASONS}
        result["byMarket"]=subgroup(rows,"market",prob_field)
        result["byStrengthTier"]=subgroup(rows,"strengthTier",prob_field)
        result["byLineGeometry"]=subgroup(rows,"lineGeometry",prob_field)
        result["byMatchupStructure"]=subgroup(rows,"matchupStructure",prob_field)
        result["heritageCrossTables"]=cross_tables(rows,prob_field)
        results[name]=result

    comparisons=holm({
        name:paired(control,rows) for name,rows in policies.items() if name!="CONTROL_FULL_MODULAR"
    })

    output={
        "schemaVersion":SCHEMA,
        "classification":"FULL_MODULAR_APLUS_PREMIUM_DYNAMIC_CROSS_ANATOMY_RETROSPECTIVE_COMPLETE_PROSPECTIVE_CONFIRMATION_REQUIRED",
        "sample":{
            "trainingRows2022":len(by_season["2022"]),"calibrationRows2023":len(by_season["2023"]),
            "evaluationRows":sum(len(by_season[s]) for s in EVAL_SEASONS),"eligibleSlateDates":len(eligible_dates),
            "parentActiveDates":len(parent_active_dates),"parentNoPlayDates":len(parent_no_play_dates),
            "fullModularControlShadowDates":len(control),
            "allCandidateRowsBySeason":{s:len(all_candidates[s]) for s in ALL_MODEL_SEASONS},
            "evaluationNoPlayCandidateRowsBySeason":{s:len(eval_candidates[s]) for s in EVAL_SEASONS},
        },
        "premiumCoreTrainingStd":premium_std,
        "policyResults":results,
        "pairedComparisonsVsControl":comparisons,
        "modelDiagnostics":model_diagnostics,
        "dailyShadowPicks":policies,
        "scientificDecisionBoundary":{
            "retrospectiveWinnerMayBeDeclared":False,"productionChanged":False,
            "currentAPlusPremiumHierarchyChanged":False,"fullModularProductionPromoted":False,
            "challengersChangeEligibility":False,"challengersChangeCoverage":False,
            "sameDateOutcomeLeakageAllowed":False,"futureSeasonTrainingAllowed":False,
            "historicalPricesUsed":False,"positiveEvEstablished":False,"betEliteProduced":False,
            "stakeCalculated":False,"automaticBetPlacement":False,"realFinancialExposure":0,
            "prospectiveLiveShadowRequiredBeforeAnyPromotion":True,
        },
    }
    dump(args.out,output)
    print(json.dumps({"policyResults":results,"paired":comparisons,"sample":output["sample"]},indent=2))


if __name__=="__main__":
    main()
