#!/usr/bin/env python3
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
from collections import Counter, defaultdict

SCHEMA = "courtedge-mlb-daily-best-pick-historical-coverage.v1"
CONTRACT_SCHEMA = "courtedge-mlb-daily-best-pick-historical-coverage-contract.v1"
PARENT_SCHEMA = "courtedge-p0-step12v69-confluence-frequency-quality-frontier.v1"
A_PLUS_ROUTE = "A_PLUS_D1_ROUTER"
PREMIUM_ROUTE = "PREMIUM_A_FULL_GAME_HOME"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def require_text(path, fragments, error_prefix):
    text = open(path, encoding="utf-8").read()
    for fragment in fragments:
        if fragment not in text:
            raise SystemExit(f"{error_prefix}:{fragment}")
    return text


def load_module(path):
    spec = importlib.util.spec_from_file_location("daily_best_pick_v69_parent", path)
    if spec is None or spec.loader is None:
        raise SystemExit("DAILY_BEST_PICK_PARENT_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pct(numerator, denominator):
    return 100.0 * numerator / denominator if denominator else 0.0


def streak_summary(active_dates, eligible_dates):
    active = set(active_dates)
    runs = []
    current = 0
    for date in sorted(eligible_dates):
        if date not in active:
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    return {
        "maximumNoPlayEligibleDateStreak": max(runs) if runs else 0,
        "numberNoPlayStreaksAtLeast2": sum(run >= 2 for run in runs),
        "numberNoPlayStreaksAtLeast3": sum(run >= 3 for run in runs),
        "distribution": {str(key): value for key, value in sorted(Counter(runs).items())},
    }


def route_pool_digest(parent_stats):
    keys = (
        "opportunities",
        "decisiveRows",
        "wins",
        "losses",
        "pushes",
        "hitRate",
        "eligibleSlateDays",
        "pctDaysWithAtLeast1",
        "maximumNoPlaySlateDayStreak",
    )
    return {key: parent_stats.get(key) for key in keys}


def exact_ratio_bounds(selected_candidates_by_date):
    # Each date contributes exactly one parent-route tier choice. The unknown current
    # preprice rank may choose any same-tier candidate, so enumerate possible aggregate
    # (wins, decisive) states without ever using the outcome to define eligibility.
    states = {(0, 0)}
    for date in sorted(selected_candidates_by_date):
        options = set()
        for row in selected_candidates_by_date[date]:
            outcome = row["y"]
            if outcome == 1:
                options.add((1, 1))
            elif outcome == 0:
                options.add((0, 1))
            elif outcome is None:
                options.add((0, 0))
            else:
                raise SystemExit(f"DAILY_BEST_PICK_INVALID_CAPTURED_OUTCOME:{date}:{outcome}")
        if not options:
            raise SystemExit(f"DAILY_BEST_PICK_EMPTY_ACTIVE_DATE:{date}")
        states = {
            (wins + option_wins, decisive + option_decisive)
            for wins, decisive in states
            for option_wins, option_decisive in options
        }

    active_days = len(selected_candidates_by_date)
    possible_decisive = [(wins, decisive) for wins, decisive in states if decisive > 0]
    if not possible_decisive:
        decisive_range = [None, None]
    else:
        rates = [wins / decisive for wins, decisive in possible_decisive]
        decisive_range = [min(rates), max(rates)]
    win_counts = [wins for wins, _ in states] or [0]
    return {
        "possibleAggregateStates": len(states),
        "selectedDayWinCountRange": [min(win_counts), max(win_counts)],
        "winRateAcrossAllActiveDatesRange": [
            min(win_counts) / active_days if active_days else None,
            max(win_counts) / active_days if active_days else None,
        ],
        "decisiveHitRateRange": decisive_range,
        "note": "Bounds only. They are not the current production prepriceRank result.",
    }


def rank_sensitivity(selected_candidates_by_date):
    single = 0
    multi_same = 0
    rank_sensitive = 0
    by_tier = defaultdict(lambda: {"activeDates": 0, "singleCandidateDates": 0, "multiCandidateSameOutcomeDates": 0, "rankSensitiveOutcomeDates": 0})
    detail = []
    for date in sorted(selected_candidates_by_date):
        rows = selected_candidates_by_date[date]
        tier = "A_PLUS" if rows[0]["route"] == A_PLUS_ROUTE else "PREMIUM"
        outcomes = sorted({"PUSH" if row["y"] is None else "WIN" if row["y"] == 1 else "LOSS" for row in rows})
        bucket = by_tier[tier]
        bucket["activeDates"] += 1
        if len(rows) == 1:
            single += 1
            bucket["singleCandidateDates"] += 1
        elif len(outcomes) == 1:
            multi_same += 1
            bucket["multiCandidateSameOutcomeDates"] += 1
        else:
            rank_sensitive += 1
            bucket["rankSensitiveOutcomeDates"] += 1
            detail.append({
                "officialDate": date,
                "tier": tier,
                "candidateGames": len(rows),
                "outcomesAvailableWithoutCurrentRank": outcomes,
            })
    return {
        "activeDates": len(selected_candidates_by_date),
        "singleCandidateDates": single,
        "multiCandidateSameOutcomeDates": multi_same,
        "rankSensitiveOutcomeDates": rank_sensitive,
        "outcomeDeterminateWithoutCurrentRankDates": single + multi_same,
        "byTier": dict(sorted(by_tier.items())),
        "rankSensitiveDateDetails": detail,
        "exactCurrentDailySelectedWinLossCertified": rank_sensitive == 0,
    }


def load_eligible_dates(root, v69_contract):
    dates_by_season = {}
    expected_by = v69_contract["evaluationUniverse"]["expectedCanonicalRowsBySeason"]
    seasons = tuple(v69_contract["evaluationUniverse"]["seasons"])
    total_rows = 0
    all_dates = set()
    for season in seasons:
        table = load(os.path.join(root, season, "game-anatomy-feature-table.json"))
        eligible_rows = [row for row in table["rows"] if row.get("t5PregameValid") is True]
        if len(eligible_rows) != int(expected_by[season]):
            raise SystemExit(f"DAILY_BEST_PICK_PARENT_UNIVERSE_ROW_DRIFT:{season}:{len(eligible_rows)}")
        dates = {str(row["officialDate"]) for row in eligible_rows}
        dates_by_season[season] = dates
        all_dates.update(dates)
        total_rows += len(eligible_rows)
    if total_rows != int(v69_contract["evaluationUniverse"]["expectedCombinedRows"]):
        raise SystemExit(f"DAILY_BEST_PICK_PARENT_UNIVERSE_TOTAL_DRIFT:{total_rows}")
    if len(all_dates) != int(v69_contract["evaluationUniverse"]["expectedEligibleSlateDays"]):
        raise SystemExit(f"DAILY_BEST_PICK_PARENT_UNIVERSE_DATE_DRIFT:{len(all_dates)}")
    return seasons, dates_by_season, all_dates


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--custody", required=True)
    parser.add_argument("--v16-manifest", required=True)
    parser.add_argument("--v68-contract", required=True)
    parser.add_argument("--classifier-source", required=True)
    parser.add_argument("--router-source", required=True)
    parser.add_argument("--v69-contract", required=True)
    parser.add_argument("--v69-scorer", required=True)
    parser.add_argument("--audit-contract", required=True)
    parser.add_argument("--selector", required=True)
    parser.add_argument("--runtime-adapter", required=True)
    parser.add_argument("--intrinsic-rank", required=True)
    parser.add_argument("--shortlist", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    contract = load(args.audit_contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("DAILY_BEST_PICK_AUDIT_CONTRACT_INVALID")
    if contract.get("scientificStatus") != "RETROSPECTIVE_DERIVED_AUDIT_USING_FROZEN_PARENT_EVIDENCE":
        raise SystemExit("DAILY_BEST_PICK_AUDIT_STATUS_INVALID")

    current_files = {
        "selector": args.selector,
        "runtimeAdapter": args.runtime_adapter,
        "intrinsicRank": args.intrinsic_rank,
        "shortlist": args.shortlist,
    }
    for key, path in current_files.items():
        expected = contract["productionSnapshot"][key]["gitBlobSha"]
        actual = git_blob_sha(path)
        if actual != expected:
            raise SystemExit(f"DAILY_BEST_PICK_CURRENT_BLOB_DRIFT:{key}:{actual}:{expected}")

    if git_blob_sha(args.v69_scorer) != contract["immutableHistoricalInputs"]["v69ParentAudit"]["scorerGitBlobSha"]:
        raise SystemExit("DAILY_BEST_PICK_V69_SCORER_BLOB_DRIFT")

    require_text(args.selector, [
        'A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1',
        'PREMIUM_A_HOME_ML',
        'aPlusAlwaysPrecedesPremium: true',
        'generalV68FallbackAllowed: false',
        'v80DependencyAllowed: false',
        'decision: pick ? "BEST_PICK" as const : "NO_PLAY" as const',
    ], "DAILY_BEST_PICK_SELECTOR_SEMANTIC_DRIFT")
    require_text(args.runtime_adapter, [
        'runtime.intrinsic.rankedGames.forEach((game, prepriceRank)',
        'market: "FULL_GAME_ML"',
        'route: "PREMIUM_A_HOME_ML"',
        'route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1"',
        'generalV68EvaluationsCreated: 0',
        'v80Read: false',
    ], "DAILY_BEST_PICK_ADAPTER_SEMANTIC_DRIFT")
    require_text(args.intrinsic_rank, [
        'export function rankMlbIntrinsicGames(',
        'const rankedGames = rankedAll.slice(0, MLB_SHORTLIST_MAX_CANDIDATES);',
        'oddsAffectIntrinsicRank: false',
        'numericEliteScoreProduced: false',
    ], "DAILY_BEST_PICK_INTRINSIC_SEMANTIC_DRIFT")
    require_text(args.shortlist, [
        'export const MLB_SHORTLIST_MAX_CANDIDATES = 8 as const;',
        'qualificationRule: "AT_LEAST_ONE_NONZERO_NATIVE_RUN_SIGNAL_FROM_CERTIFIED_COMPONENT"',
    ], "DAILY_BEST_PICK_SHORTLIST_SEMANTIC_DRIFT")

    v69_contract = load(args.v69_contract)
    seasons, eligible_by_season, eligible_dates = load_eligible_dates(args.root, v69_contract)

    parent = load_module(args.v69_scorer)
    captured = []
    original_make_opp = parent.make_opp

    def capture_make_opp(*call_args, **call_kwargs):
        row = original_make_opp(*call_args, **call_kwargs)
        captured.append(dict(row))
        return row

    parent.make_opp = capture_make_opp
    parent_out = args.out + ".parent-v69.json"
    old_argv = sys.argv[:]
    sys.argv = [
        args.v69_scorer,
        "--root", args.root,
        "--custody", args.custody,
        "--v16-manifest", args.v16_manifest,
        "--v68-contract", args.v68_contract,
        "--classifier-source", args.classifier_source,
        "--router-source", args.router_source,
        "--contract", args.v69_contract,
        "--out", parent_out,
    ]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            parent.main()
    finally:
        sys.argv = old_argv
        parent.make_opp = original_make_opp

    parent_report = load(parent_out)
    if parent_report.get("schemaVersion") != PARENT_SCHEMA:
        raise SystemExit("DAILY_BEST_PICK_PARENT_REPORT_SCHEMA_DRIFT")
    if parent_report["sample"]["eligibleSlateDays"] != len(eligible_dates):
        raise SystemExit("DAILY_BEST_PICK_PARENT_REPORT_DATE_PARITY_FAILED")

    a_plus = [row for row in captured if row.get("route") == A_PLUS_ROUTE]
    premium = [row for row in captured if row.get("route") == PREMIUM_ROUTE]
    if len(a_plus) != parent_report["fixedRoutes"][A_PLUS_ROUTE]["opportunities"]:
        raise SystemExit("DAILY_BEST_PICK_A_PLUS_CAPTURE_PARITY_FAILED")
    if len(premium) != parent_report["fixedRoutes"][PREMIUM_ROUTE]["opportunities"]:
        raise SystemExit("DAILY_BEST_PICK_PREMIUM_CAPTURE_PARITY_FAILED")

    a_plus_keys = {(row["date"], int(row["gamePk"])) for row in a_plus}
    premium_keys = {(row["date"], int(row["gamePk"])) for row in premium}
    if not a_plus_keys.issubset(premium_keys):
        raise SystemExit("DAILY_BEST_PICK_A_PLUS_NOT_PREMIUM_SUBSET")

    a_plus_by_date = defaultdict(list)
    premium_by_date = defaultdict(list)
    for row in a_plus:
        a_plus_by_date[row["date"]].append(row)
    for row in premium:
        premium_by_date[row["date"]].append(row)

    a_plus_dates = set(a_plus_by_date)
    premium_dates = set(premium_by_date)
    if not a_plus_dates.issubset(premium_dates):
        raise SystemExit("DAILY_BEST_PICK_A_PLUS_DATE_NOT_PREMIUM_SUBSET")

    selected_candidates = {}
    selected_tier = {}
    for date in sorted(eligible_dates):
        if a_plus_by_date.get(date):
            selected_candidates[date] = list(a_plus_by_date[date])
            selected_tier[date] = "A_PLUS"
        elif premium_by_date.get(date):
            selected_candidates[date] = list(premium_by_date[date])
            selected_tier[date] = "PREMIUM"

    active_dates = set(selected_candidates)
    premium_only_dates = premium_dates - a_plus_dates
    no_play_dates = set(eligible_dates) - active_dates
    if active_dates != premium_dates:
        raise SystemExit("DAILY_BEST_PICK_PARENT_ROUTE_UNION_PARITY_FAILED")

    overall_streak = streak_summary(active_dates, eligible_dates)
    by_season = {}
    for season in seasons:
        season_dates = eligible_by_season[season]
        season_aplus = a_plus_dates & season_dates
        season_premium_only = premium_only_dates & season_dates
        season_active = active_dates & season_dates
        season_no_play = season_dates - season_active
        by_season[season] = {
            "eligibleSlateDates": len(season_dates),
            "aPlusTierDates": len(season_aplus),
            "premiumFallbackOnlyDates": len(season_premium_only),
            "parentRouteActiveDates": len(season_active),
            "parentRouteNoPlayDates": len(season_no_play),
            "parentRouteAvailabilityPct": pct(len(season_active), len(season_dates)),
            "parentRouteNoPlayPct": pct(len(season_no_play), len(season_dates)),
            "noPlayStreaks": streak_summary(season_active, season_dates),
        }

    sensitivity = rank_sensitivity(selected_candidates)
    bounds = exact_ratio_bounds(selected_candidates)

    result = {
        "schemaVersion": SCHEMA,
        "classification": "DAILY_BEST_PICK_HISTORICAL_PARENT_ROUTE_COVERAGE_VERIFIED_PRODUCTION_RANK_POPULATION_NOT_RECONSTRUCTED",
        "sourceIdentity": {
            "auditContractGitBlobSha": git_blob_sha(args.audit_contract),
            "v69ScorerGitBlobSha": git_blob_sha(args.v69_scorer),
            "currentSelectorGitBlobSha": git_blob_sha(args.selector),
            "currentRuntimeAdapterGitBlobSha": git_blob_sha(args.runtime_adapter),
            "currentIntrinsicRankGitBlobSha": git_blob_sha(args.intrinsic_rank),
            "currentShortlistGitBlobSha": git_blob_sha(args.shortlist),
            "parentClassification": parent_report["classification"],
            "parentSample": parent_report["sample"],
        },
        "verifiedParentRouteAvailabilityCeiling": {
            "eligibleSlateDates": len(eligible_dates),
            "aPlusTierDates": len(a_plus_dates),
            "premiumFallbackOnlyDates": len(premium_only_dates),
            "parentRouteActiveDates": len(active_dates),
            "parentRouteNoPlayDates": len(no_play_dates),
            "parentRouteAvailabilityPct": pct(len(active_dates), len(eligible_dates)),
            "parentRouteNoPlayPct": pct(len(no_play_dates), len(eligible_dates)),
            "aPlusShareOfActiveDatesPct": pct(len(a_plus_dates), len(active_dates)),
            "premiumFallbackShareOfActiveDatesPct": pct(len(premium_only_dates), len(active_dates)),
            "maximumDailySelectedTiers": 1,
            "noPlayStreaksAcrossCombinedEligibleDateSequence": overall_streak,
            "maximumNoPlayEligibleDateStreakWithinSeason": max(
                (by_season[season]["noPlayStreaks"]["maximumNoPlayEligibleDateStreak"] for season in seasons),
                default=0,
            ),
            "bySeason": by_season,
        },
        "sameTierRankSensitivity": {
            **sensitivity,
            "currentProductionPrepriceRankPresentInParentRows": False,
            "currentProductionPrepriceRankSubstitutionPerformed": False,
            "outcomesUsedToChooseCandidate": False,
            "outcomeBounds": bounds,
        },
        "parentRoutePoolOutcomeDiagnostics": {
            "warning": "These are all historical route opportunities, not the exactly one-per-day production selection performance.",
            "aPlusD1Router": route_pool_digest(parent_report["fixedRoutes"][A_PLUS_ROUTE]),
            "premiumAFullGameHome": route_pool_digest(parent_report["fixedRoutes"][PREMIUM_ROUTE]),
        },
        "productionCoverageBoundary": {
            "exactCurrentStep11cCoverageCertified": False,
            "reason": "The historical V69 route rows do not preserve the current certified shortlist payloads or current intrinsic rankedGames membership. The current runtime only adapts frozen route evaluations for games in runtime.intrinsic.rankedGames, capped at eight.",
            "certifiedQuantity": "PARENT_ROUTE_AVAILABILITY_CEILING",
            "currentProductionCoverageRelation": "LESS_THAN_OR_EQUAL_TO_PARENT_ROUTE_AVAILABILITY_CEILING",
            "parentRouteAvailabilityPctUpperBound": pct(len(active_dates), len(eligible_dates)),
        },
        "policy": {
            "aPlusAlwaysPrecedesPremium": True,
            "maximumDailyPicks": 1,
            "forcedDailyPlayAllowed": False,
            "generalV68FallbackAllowed": False,
            "v80DependencyAllowed": False,
            "historicalPricesUsed": False,
            "thresholdRelaxationPerformed": False,
            "newRankingFormulaAdded": False,
            "v69DailyRankSubstitutionPerformed": False,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
            "productionChanged": False,
        },
    }
    dump(args.out, result)
    try:
        os.remove(parent_out)
    except FileNotFoundError:
        pass

    print(json.dumps({
        "classification": result["classification"],
        "coverageCeiling": result["verifiedParentRouteAvailabilityCeiling"],
        "rankSensitivity": {
            key: sensitivity[key]
            for key in (
                "activeDates",
                "singleCandidateDates",
                "multiCandidateSameOutcomeDates",
                "rankSensitiveOutcomeDates",
                "outcomeDeterminateWithoutCurrentRankDates",
                "exactCurrentDailySelectedWinLossCertified",
            )
        },
        "outcomeBounds": bounds,
        "exactCurrentStep11cCoverageCertified": False,
    }, indent=2))


if __name__ == "__main__":
    main()
