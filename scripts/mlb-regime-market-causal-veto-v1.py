#!/usr/bin/env python3
import argparse
import datetime as dt
import importlib.util
import json
import math
import os
from collections import Counter, defaultdict
from types import SimpleNamespace

import numpy as np

SCHEMA = "courtedge-mlb-regime-market-causal-veto.v1"
CONTRACT_SCHEMA = "courtedge-mlb-regime-market-causal-veto-contract.v1"
PARENT_RESULT_SCHEMA = "courtedge-mlb-market-state-matchup-modular-router.v1"
EVAL_SEASONS = ("2024", "2025", "2026_YTD")
ALL_SEASONS = ("2022", "2023", *EVAL_SEASONS)
POLICIES = (
    "CONTROL_FULL_MODULAR",
    "CHALLENGER_MARKET_GUARD",
    "CHALLENGER_CAUSAL_VETO",
    "CHALLENGER_MARKET_X_CAUSAL_VETO",
)


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
        raise SystemExit(f"REGIME_VETO_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finite(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else math.nan
    except (TypeError, ValueError):
        return math.nan


def raw_outcome_rows(root):
    out = {}
    for season in ALL_SEASONS:
        payload = load(os.path.join(root, season, "game-anatomy-feature-table.json"))
        rows = []
        for row in payload["rows"]:
            fg = row.get("outcomes", {}).get("FULL_GAME") or {}
            home = finite(fg.get("homeRuns"))
            away = finite(fg.get("awayRuns"))
            if not (math.isfinite(home) and math.isfinite(away)):
                continue
            rows.append({
                "season": season,
                "officialDate": row["officialDate"],
                "gamePk": int(row["gamePk"]),
                "homeRuns": home,
                "awayRuns": away,
                "totalRuns": home + away,
                "homeWin": 1.0 if home > away else 0.0,
                "absMargin": abs(home - away),
                "oneRunGame": 1.0 if abs(home - away) == 1 else 0.0,
            })
        out[season] = rows
    return out


def trailing_regime_vectors(raw_by_season, cfg):
    window = int(cfg["windowCalendarDays"])
    minimum = int(cfg["minimumPriorCompletedGames"])
    result = {}
    feature_order = cfg["featuresExactly"]
    expected = [
        "TRAILING_28D_TOTAL_RUNS_PER_GAME",
        "TRAILING_28D_HOME_WIN_RATE",
        "TRAILING_28D_MEAN_ABSOLUTE_RUN_MARGIN",
        "TRAILING_28D_ONE_RUN_GAME_RATE",
    ]
    if feature_order != expected:
        raise SystemExit("REGIME_VETO_REGIME_FEATURE_DRIFT")
    for season, rows in raw_by_season.items():
        dates = sorted({r["officialDate"] for r in rows})
        by_date = defaultdict(list)
        for row in rows:
            by_date[row["officialDate"]].append(row)
        vectors = {}
        parsed = {d: dt.date.fromisoformat(d) for d in dates}
        for date in dates:
            current = parsed[date]
            lower = current - dt.timedelta(days=window)
            prior = [
                row
                for d in dates
                if lower <= parsed[d] < current
                for row in by_date[d]
            ]
            if len(prior) < minimum:
                vectors[date] = None
                continue
            vectors[date] = np.asarray([
                float(np.mean([r["totalRuns"] for r in prior])),
                float(np.mean([r["homeWin"] for r in prior])),
                float(np.mean([r["absMargin"] for r in prior])),
                float(np.mean([r["oneRunGame"] for r in prior])),
            ], dtype=float)
        result[season] = vectors
    return result


def fit_regime_reference(vectors, cfg):
    train = [v for v in vectors["2022"].values() if v is not None]
    if len(train) < 30:
        raise SystemExit("REGIME_VETO_REGIME_TRAIN_TOO_SMALL")
    x = np.vstack(train)
    mean = np.mean(x, axis=0)
    covariance = np.cov(x, rowvar=False)
    covariance = covariance + float(cfg["covarianceRidgeExactly"]) * np.eye(covariance.shape[0])
    inverse = np.linalg.inv(covariance)

    def distance(v):
        if v is None:
            return None
        delta = v - mean
        return float(math.sqrt(max(0.0, float(delta @ inverse @ delta))))

    validation = [distance(v) for v in vectors["2023"].values() if v is not None]
    validation = [v for v in validation if v is not None and math.isfinite(v)]
    if len(validation) < 30:
        raise SystemExit("REGIME_VETO_REGIME_VALIDATION_TOO_SMALL")
    threshold = float(np.quantile(validation, float(cfg["stressQuantileExactly"]), method="linear"))
    states = {}
    distances = {}
    for season in ALL_SEASONS:
        states[season] = {}
        distances[season] = {}
        for date, vector in vectors[season].items():
            d = distance(vector)
            distances[season][date] = d
            states[season][date] = "UNKNOWN" if d is None else ("STRESS" if d >= threshold - 1e-15 else "NORMAL")
    return {
        "mean": mean.tolist(),
        "covariance": covariance.tolist(),
        "validationStressThreshold": threshold,
        "states": states,
        "distances": distances,
        "trainingValidDates": len(train),
        "validationValidDates": len(validation),
    }


def build_role_thresholds(parent_router, variants, source_index, structure_cfg, modular, quantile):
    distributions = defaultdict(list)
    seen = set()
    for variant, info in variants.items():
        horizon = info["horizon"]
        required_roles = structure_cfg["requiredRolesByHorizon"][horizon]
        for row in info["rows"]["2023"]:
            side, score, probability, tier, _ = modular.selected_direction(row)
            if score <= 0 or probability < 0.60:
                continue
            identity = (variant, int(row["gamePk"]), side, tier)
            if identity in seen:
                continue
            seen.add(identity)
            source = source_index[("2023", int(row["gamePk"]))]
            _, diagnostic = parent_router.structure_score(
                source, side, horizon, structure_cfg, structure_cfg["_prep"]
            )
            role_scores = diagnostic.get("roleScores")
            if not role_scores:
                continue
            for role in required_roles:
                if role not in role_scores:
                    continue
                distributions[(horizon, tier, role)].append(float(role_scores[role]))
    thresholds = {}
    for horizon, roles in structure_cfg["requiredRolesByHorizon"].items():
        thresholds[horizon] = {}
        for tier in parent_router.TIERS:
            thresholds[horizon][tier] = {}
            for role in roles:
                values = distributions[(horizon, tier, role)]
                if len(values) < 20:
                    raise SystemExit(f"REGIME_VETO_ROLE_THRESHOLD_TOO_SMALL:{horizon}:{tier}:{role}:{len(values)}")
                thresholds[horizon][tier][role] = {
                    "q20": float(np.quantile(values, quantile, method="linear")),
                    "validationRows": len(values),
                }
    return thresholds


def causal_veto(candidate, role_thresholds, required_roles):
    role_scores = candidate.get("roleScores")
    if not role_scores:
        return True, ["REQUIRED_ROLE_UNOBSERVABLE"]
    reasons = []
    horizon = candidate["horizon"]
    tier = candidate["strengthTier"]
    for role in required_roles[horizon]:
        value = role_scores.get(role)
        threshold = role_thresholds[horizon][tier][role]["q20"]
        if value is None or not math.isfinite(finite(value)):
            reasons.append(f"ROLE_UNOBSERVABLE:{role}")
        elif float(value) <= threshold + 1e-15:
            reasons.append(f"ROLE_Q20_VETO:{role}")
    return bool(reasons), reasons


def policy_allows(policy, candidate, blocked_markets, role_thresholds, required_roles):
    reasons = []
    if policy in ("CHALLENGER_MARKET_GUARD", "CHALLENGER_MARKET_X_CAUSAL_VETO"):
        if candidate["market"] in blocked_markets:
            reasons.append(f"MARKET_GUARD:{candidate['market']}")
    if policy in ("CHALLENGER_CAUSAL_VETO", "CHALLENGER_MARKET_X_CAUSAL_VETO"):
        vetoed, causal_reasons = causal_veto(candidate, role_thresholds, required_roles)
        if vetoed:
            reasons.extend(causal_reasons)
    return not reasons, reasons


def subgroup(parent_router, rows, field):
    grouped = defaultdict(list)
    for row in rows:
        grouped[str(row.get(field, "UNKNOWN"))].append(row)
    return {
        key: parent_router.group_basic_stats(parent_router._multi_market_parent, group)
        for key, group in sorted(grouped.items())
    }


def stats(parent_router, picks, parent_active_dates, eligible_dates, dates_by_season):
    base = parent_router.group_basic_stats(parent_router._multi_market_parent, picks)
    selected_dates = {r["officialDate"] for r in picks}
    combined = parent_active_dates | selected_dates
    base.update({
        "shadowPickDates": len(selected_dates),
        "combinedDailyOpportunityDates": len(combined),
        "combinedDailyOpportunityCoveragePct": 100.0 * len(combined) / len(eligible_dates),
        "remainingNoPlayDates": len(eligible_dates - combined),
        "remainingNoPlayStreaks": parent_router._multi_market_parent.streak_summary(combined, eligible_dates),
        "bySeason": {},
        "byMarket": subgroup(parent_router, picks, "market"),
        "byTeamState": subgroup(parent_router, picks, "strengthTier"),
        "byMatchupStructure": subgroup(parent_router, picks, "matchupStructure"),
        "bySelectedSideLineGeometry": subgroup(parent_router, picks, "lineGeometry"),
        "byLeagueRegime": subgroup(parent_router, picks, "leagueRegime"),
    })
    for season in EVAL_SEASONS:
        season_rows = [r for r in picks if r["season"] == season]
        season_dates = dates_by_season[season]
        s = parent_router.group_basic_stats(parent_router._multi_market_parent, season_rows)
        combined_s = (parent_active_dates & season_dates) | {r["officialDate"] for r in season_rows}
        s.update({
            "eligibleSlateDates": len(season_dates),
            "combinedDailyOpportunityDates": len(combined_s),
            "combinedDailyOpportunityCoveragePct": 100.0 * len(combined_s) / len(season_dates),
            "remainingNoPlayDates": len(season_dates - combined_s),
            "byLeagueRegime": subgroup(parent_router, season_rows, "leagueRegime"),
        })
        base["bySeason"][season] = s
    return base


def identity(row):
    return (row["officialDate"], int(row["gamePk"]), row["market"], row["side"])


def normalize_parent_pick(row):
    return (row["officialDate"], int(row["gamePk"]), row["market"], row["side"])


def removal_diagnostic(parent_router, control, challenger):
    control_by_date = {r["officialDate"]: r for r in control}
    challenger_by_date = {r["officialDate"]: r for r in challenger}
    removed = []
    replaced = []
    for date, row in control_by_date.items():
        other = challenger_by_date.get(date)
        if other is None:
            removed.append(row)
        elif identity(other) != identity(row):
            replaced.append({"control": row, "challenger": other})
    decisive_removed = [r for r in removed if r["outcome"] != "PUSH"]
    wins_removed = sum(r["outcome"] == "WIN" for r in decisive_removed)
    losses_removed = sum(r["outcome"] == "LOSS" for r in decisive_removed)
    control_decisive = [r for r in control if r["outcome"] != "PUSH"]
    control_wins = sum(r["outcome"] == "WIN" for r in control_decisive)
    control_losses = sum(r["outcome"] == "LOSS" for r in control_decisive)
    win_rate = wins_removed / control_wins if control_wins else None
    loss_rate = losses_removed / control_losses if control_losses else None
    lift = (loss_rate / win_rate) if win_rate not in (None, 0) and loss_rate is not None else None
    return {
        "controlDatesRemovedWithoutReplacement": len(removed),
        "controlDatesReplacedByDifferentCandidate": len(replaced),
        "winsRemoved": wins_removed,
        "lossesRemoved": losses_removed,
        "winRemovalRate": win_rate,
        "lossRemovalRate": loss_rate,
        "lossToWinRemovalLift": lift,
        "removedBySeason": subgroup(parent_router, removed, "season"),
        "removedByMarket": subgroup(parent_router, removed, "market"),
        "removedByGeometry": subgroup(parent_router, removed, "lineGeometry"),
        "removedByRegime": subgroup(parent_router, removed, "leagueRegime"),
    }


def regime_date_diagnostics(regime, dates_by_season, control_picks, parent_router):
    by_season = {}
    for season in EVAL_SEASONS:
        counts = Counter(regime["states"][season].get(date, "UNKNOWN") for date in dates_by_season[season])
        rows = [r for r in control_picks if r["season"] == season]
        by_season[season] = {
            "eligibleDateStates": dict(counts),
            "controlPerformanceByRegime": subgroup(parent_router, rows, "leagueRegime"),
        }
    return by_season


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "root", "custody", "v16-manifest", "v68-contract", "classifier-source", "router-source",
        "v69-contract", "v69-scorer", "multi-market-scorer", "multi-market-contract",
        "modular-parent-scorer", "modular-parent-contract", "parent-router-scorer", "parent-router-contract",
        "parent-result", "contract", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("REGIME_VETO_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "FROZEN_BEFORE_SCORER_RETROSPECTIVE_REGIME_MARKET_CAUSAL_VETO_STUDY_PROSPECTIVE_CONFIRMATION_REQUIRED":
        raise SystemExit("REGIME_VETO_CONTRACT_STATUS_INVALID")
    if contract["adaptiveSelectionDisclosure"]["thereforeEvaluation2024To2026CanCertifyProductionWinner"] is not False:
        raise SystemExit("REGIME_VETO_RETROSPECTIVE_BOUNDARY_DRIFT")
    if contract["leagueRegimeDiagnostic"]["policyEffect"] != "DIAGNOSTIC_ONLY_NO_ROUTING_EFFECT_IN_V1":
        raise SystemExit("REGIME_VETO_REGIME_POLICY_DRIFT")
    if contract["productionBoundary"]["productionChanged"] is not False:
        raise SystemExit("REGIME_VETO_PRODUCTION_BOUNDARY_DRIFT")
    if tuple(contract["policies"].keys()) != POLICIES:
        raise SystemExit("REGIME_VETO_POLICY_SET_DRIFT")

    parent_router = load_module(args.parent_router_scorer, "regime_veto_parent_router")
    multi_market = load_module(args.multi_market_scorer, "regime_veto_multi_market")
    modular = load_module(args.modular_parent_scorer, "regime_veto_modular")
    parent_router._multi_market_parent = multi_market
    parent_contract = load(args.parent_router_contract)
    multi_market_contract = load(args.multi_market_contract)
    modular_parent_contract = load(args.modular_parent_contract)
    parent_result = load(args.parent_result)
    if parent_result.get("schemaVersion") != PARENT_RESULT_SCHEMA:
        raise SystemExit("REGIME_VETO_PARENT_RESULT_SCHEMA_INVALID")
    if parent_contract.get("schemaVersion") != parent_router.CONTRACT_SCHEMA:
        raise SystemExit("REGIME_VETO_PARENT_CONTRACT_INVALID")

    snapshots, standings_diagnostics = modular.build_standings_snapshots(
        args.root, parent_contract["teamState"]["minimumPriorGamesForStableTier"]
    )
    custody_rows = multi_market.load_custody(args.custody)
    joined, dates_by_season = modular.load_joined_rows(args.root, custody_rows, snapshots)
    by_season = {season: [r for r in joined if r["season"] == season] for season in ALL_SEASONS}
    source_index = {(r["season"], int(r["gamePk"])): r for r in joined}
    if len(source_index) != len(joined):
        raise SystemExit("REGIME_VETO_DUPLICATE_GAME_IDENTITY")

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
    parent_active_dates, parent_no_play_dates = multi_market.reconstruct_parent_active_dates(parent_args, eligible_dates)
    expected = contract["parentControl"]
    if len(eligible_dates) != expected["eligibleSlateDatesExpected"]:
        raise SystemExit("REGIME_VETO_ELIGIBLE_DATE_DRIFT")
    if len(parent_active_dates) != expected["parentActiveDatesExpected"]:
        raise SystemExit("REGIME_VETO_PARENT_ACTIVE_DRIFT")
    if len(parent_no_play_dates) != expected["parentNoPlayDatesExpected"]:
        raise SystemExit("REGIME_VETO_PARENT_NO_PLAY_DRIFT")

    direction_features = multi_market_contract["directionalMarginModels"]["features"]
    margin_prob = defaultdict(dict)
    for horizon in ("F3", "F5", "FG"):
        train = by_season["2022"]
        x_train, prep = multi_market.fit_matrix(train, direction_features[horizon])
        y_train = np.asarray([multi_market.margin_class(r[f"{horizon}_diff"], horizon) for r in train], dtype=int)
        class_count = 4 if horizon == "FG" else 5
        weights = multi_market.fit_multinomial(
            x_train, y_train, class_count,
            multi_market_contract["directionalMarginModels"]["l2Strength"],
            multi_market_contract["directionalMarginModels"]["maxIter"],
        )
        for season in ALL_SEASONS[1:]:
            margin_prob[horizon][season] = multi_market.predict_multinomial(
                multi_market.apply_matrix(by_season[season], prep), weights, class_count
            )

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
        raise SystemExit("REGIME_VETO_MARKET_SCOPE_DRIFT")

    min_probability = float(parent_contract["qualityFrontiers"]["minimumSelectedSideModelProbability"])
    variants = {}
    for variant, horizon in defs.items():
        train_y = [multi_market.home_settlement(r[f"{horizon}_diff"], horizon, variant) for r in by_season["2022"]]
        decisive = [v for v in train_y if v is not None]
        baseline_home = sum(v == 1 for v in decisive) / len(decisive)
        rows_by_s = modular.directional_rows(
            multi_market,
            {season: by_season[season] for season in ALL_SEASONS[1:]},
            horizon,
            variant,
            margin_prob[horizon],
            baseline_home,
        )
        variants[variant] = {
            "horizon": horizon,
            "rows": rows_by_s,
            "thresholdsByTeamState": modular.tier_thresholds(
                rows_by_s["2023"], [0.80, 0.85, 0.90, 0.95], min_probability
            ),
            "validationQualityScores": parent_router.validation_quality_distributions(
                rows_by_s["2023"], modular, min_probability
            ),
        }

    structure_cfg = json.loads(json.dumps(parent_contract["matchupStructure"]))
    structure_cfg["_prep"] = parent_router.preprocess_structure(by_season["2022"], structure_cfg)
    structure_boundaries = parent_router.build_structure_boundaries(
        {variant: info["rows"]["2023"] for variant, info in variants.items()},
        source_index,
        parent_contract["marketScope"]["horizonByVariant"],
        structure_cfg,
        modular,
    )
    role_thresholds = build_role_thresholds(
        parent_router,
        variants,
        source_index,
        structure_cfg,
        modular,
        float(contract["causalWeakLinkVeto"]["lowerQuantileExactly"]),
    )

    raw = raw_outcome_rows(args.root)
    regime_vectors = trailing_regime_vectors(raw, contract["leagueRegimeDiagnostic"])
    regime = fit_regime_reference(regime_vectors, contract["leagueRegimeDiagnostic"])

    control_pool = []
    control_cell_counts = Counter()
    for variant, info in variants.items():
        horizon = info["horizon"]
        for season in EVAL_SEASONS:
            for row in info["rows"][season]:
                if row["officialDate"] not in parent_no_play_dates:
                    continue
                side, score, probability, tier, outcome = modular.selected_direction(row)
                source = source_index[(season, int(row["gamePk"]))]
                structure_score, structure_diagnostic = parent_router.structure_score(
                    source, side, horizon, structure_cfg, structure_cfg["_prep"]
                )
                structure_state = parent_router.classify_structure(
                    structure_score, structure_boundaries[horizon][tier]
                )
                geometry, selected_line = parent_router.selected_line_geometry(variant, side)
                percentile = parent_router.empirical_percentile(
                    info["validationQualityScores"][tier], score
                )
                if percentile is None:
                    continue
                frontier = parent_router.resolve_frontier(
                    "CHALLENGER_FULL_MODULAR", tier, structure_state, geometry, parent_contract
                )
                control_cell_counts[f"{variant}|{tier}|{structure_state}|{geometry}|{frontier}"] += 1
                if frontier == "NO_PLAY":
                    continue
                threshold = info["thresholdsByTeamState"][tier].get(frontier)
                if (
                    threshold is None
                    or score <= 0
                    or probability < min_probability
                    or score + 1e-15 < threshold
                ):
                    continue
                role_scores = structure_diagnostic.get("roleScores")
                control_pool.append({
                    "season": season,
                    "officialDate": row["officialDate"],
                    "gamePk": int(row["gamePk"]),
                    "market": variant,
                    "horizon": horizon,
                    "side": side,
                    "selectedLine": selected_line,
                    "lineGeometry": geometry,
                    "strengthTier": tier,
                    "matchupStructure": structure_state,
                    "structureScore": structure_score,
                    "roleScores": role_scores,
                    "frontier": frontier,
                    "qualityScore": float(score),
                    "qualityPercentile": float(percentile),
                    "modelProbability": float(probability),
                    "outcome": outcome,
                    "leagueRegime": regime["states"][season].get(row["officialDate"], "UNKNOWN"),
                    "leagueRegimeStressScore": regime["distances"][season].get(row["officialDate"]),
                })

    blocked_markets = set(contract["marketScope"]["marketGuardBlockedVariantsExactly"])
    policy_pools = {name: [] for name in POLICIES}
    veto_reason_counts = {name: Counter() for name in POLICIES}
    for candidate in control_pool:
        for policy in POLICIES:
            allowed, reasons = policy_allows(
                policy,
                candidate,
                blocked_markets,
                role_thresholds,
                structure_cfg["requiredRolesByHorizon"],
            )
            if allowed:
                policy_pools[policy].append(candidate)
            else:
                veto_reason_counts[policy].update(reasons)

    daily_picks = {}
    for policy, pool in policy_pools.items():
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
            raise SystemExit(f"REGIME_VETO_MULTI_PICK_DATE:{policy}")
        daily_picks[policy] = selected

    parent_daily = parent_result["dailyShadowPicks"]["CHALLENGER_FULL_MODULAR"]
    control_identities = [identity(r) for r in daily_picks["CONTROL_FULL_MODULAR"]]
    parent_identities = [normalize_parent_pick(r) for r in parent_daily]
    if control_identities != parent_identities:
        raise SystemExit("REGIME_VETO_PARENT_CONTROL_DAILY_PARITY_FAILED")

    policy_results = {
        policy: stats(parent_router, daily_picks[policy], parent_active_dates, eligible_dates, dates_by_season)
        for policy in POLICIES
    }
    control_stats = policy_results["CONTROL_FULL_MODULAR"]
    parent_control_stats = parent_result["policyResults"]["CHALLENGER_FULL_MODULAR"]

    frozen_discrete_reference = {
        "shadowPickDates": expected["parentControlShadowPickDatesExpected"],
        "combinedDailyOpportunityCoveragePct": expected["parentControlCoveragePctExpected"],
        "hitRate": expected["parentControlHitRateExpected"],
    }
    for key, expected_value in frozen_discrete_reference.items():
        actual = control_stats[key]
        if abs(float(actual) - float(expected_value)) > 1e-12:
            raise SystemExit(f"REGIME_VETO_PARENT_CONTROL_FROZEN_REFERENCE_FAILED:{key}:{actual}:{expected_value}")

    for key in ("shadowPickDates", "wins", "losses", "pushes", "decisive"):
        actual = control_stats[key]
        parent_value = parent_control_stats[key]
        if actual != parent_value:
            raise SystemExit(f"REGIME_VETO_PARENT_CONTROL_DISCRETE_PARITY_FAILED:{key}:{actual}:{parent_value}")

    floating_tolerance = 1e-7
    for key in (
        "combinedDailyOpportunityCoveragePct",
        "hitRate",
        "decisiveBrierScore",
        "absoluteCalibrationGap",
    ):
        actual = float(control_stats[key])
        parent_value = float(parent_control_stats[key])
        if abs(actual - parent_value) > floating_tolerance:
            raise SystemExit(
                f"REGIME_VETO_PARENT_CONTROL_FLOAT_PARITY_FAILED:{key}:{actual}:{parent_value}:{floating_tolerance}"
            )

    frozen_float_reference = {
        "decisiveBrierScore": expected["parentControlBrierExpected"],
        "absoluteCalibrationGap": expected["parentControlCalibrationGapExpected"],
    }
    for key, expected_value in frozen_float_reference.items():
        parent_value = float(parent_control_stats[key])
        if abs(parent_value - float(expected_value)) > floating_tolerance:
            raise SystemExit(
                f"REGIME_VETO_PARENT_FROZEN_FLOAT_REFERENCE_FAILED:{key}:{parent_value}:{expected_value}:{floating_tolerance}"
            )

    comparisons = {
        policy: parent_router.paired_comparison(
            daily_picks["CONTROL_FULL_MODULAR"], daily_picks[policy]
        )
        for policy in POLICIES[1:]
    }
    comparisons = parent_router.holm_adjust(comparisons)
    removals = {
        policy: removal_diagnostic(
            parent_router, daily_picks["CONTROL_FULL_MODULAR"], daily_picks[policy]
        )
        for policy in POLICIES[1:]
    }

    result = {
        "schemaVersion": SCHEMA,
        "classification": "REGIME_MARKET_CAUSAL_VETO_RETROSPECTIVE_STUDY_COMPLETE_PROSPECTIVE_CONFIRMATION_REQUIRED",
        "sample": {
            "trainingRows2022": len(by_season["2022"]),
            "calibrationRows2023": len(by_season["2023"]),
            "evaluationRows": sum(len(by_season[s]) for s in EVAL_SEASONS),
            "eligibleSlateDates": len(eligible_dates),
            "parentActiveDates": len(parent_active_dates),
            "parentNoPlayDates": len(parent_no_play_dates),
            "controlCandidatePoolRows": len(control_pool),
        },
        "parentControlParity": {
            "dailyPickIdentitiesExact": True,
            "discreteMetricsExact": True,
            "floatingMetricsNumericallyEquivalentWithin1e7": True,
            "floatingMetricTolerance": floating_tolerance,
            "frozenHistoricalFloatingReferenceWithin1e7": True,
        },
        "leagueRegime": {
            "trainingValidDates": regime["trainingValidDates"],
            "validationValidDates": regime["validationValidDates"],
            "validationStressThreshold": regime["validationStressThreshold"],
            "byEvaluationSeason": regime_date_diagnostics(
                regime, dates_by_season, daily_picks["CONTROL_FULL_MODULAR"], parent_router
            ),
        },
        "causalRoleThresholds": role_thresholds,
        "controlCellEligibility": dict(control_cell_counts),
        "policyResults": policy_results,
        "vetoReasonCounts": {k: dict(v) for k, v in veto_reason_counts.items()},
        "removalDiagnosticsVsControl": removals,
        "pairedComparisonsVsControl": comparisons,
        "paretoPolicies": parent_router.pareto_policies(policy_results),
        "dailyShadowPicks": daily_picks,
        "standingsDiagnostics": standings_diagnostics,
        "scientificBoundary": {
            "parentControlBitwiseDailyIdentityPreserved": True,
            "oneShadowPickMaximumPerParentNoPlayDate": True,
            "parentAPlusPremiumDatesReplaced": False,
            "marketGuardAdaptiveHypothesisDisclosed": True,
            "causalVetoThresholdUses2023Only": True,
            "regimeUsesStrictlyPriorCompletedGames": True,
            "regimeHasRoutingEffect": False,
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
            "generalV68Fallback": False,
            "v80Dependency": False,
        },
    }
    dump(args.out, result)
    print(json.dumps({
        "classification": result["classification"],
        "sample": result["sample"],
        "policySummary": {
            name: {
                "coveragePct": value["combinedDailyOpportunityCoveragePct"],
                "shadowPickDates": value["shadowPickDates"],
                "hitRate": value["hitRate"],
                "wilsonLower": value["wilson95"]["lower"] if value["wilson95"] else None,
                "brier": value["decisiveBrierScore"],
                "calibrationGap": value["absoluteCalibrationGap"],
                "maxNoPlayStreak": value["remainingNoPlayStreaks"]["maximum"],
            }
            for name, value in policy_results.items()
        },
        "paretoPolicies": result["paretoPolicies"],
        "pairedComparisons": comparisons,
        "removalDiagnostics": removals,
        "regimeBySeason": result["leagueRegime"]["byEvaluationSeason"],
    }, indent=2))


if __name__ == "__main__":
    main()
