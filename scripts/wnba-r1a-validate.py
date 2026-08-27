#!/usr/bin/env python3
import json
from pathlib import Path

AUDIT = Path("research/wnba/WNBA_R1A_INPUT_AUDIT.json")

REQUIRED_GROUPS = {
    "season_to_date_stats",
    "recent_stats",
    "schedule_context",
    "sos",
    "travel",
    "injuries",
    "manual_adjustment",
    "market",
}
REQUIRED_GROUP_KEYS = {
    "reconstruction_status",
    "provenance",
    "temporal_cutoff",
    "missingness_policy",
    "anti_leakage_rule",
}


def fail(msg: str) -> None:
    raise SystemExit(f"WNBA R1A VALIDATION FAILED: {msg}")


def require(condition: bool, msg: str) -> None:
    if not condition:
        fail(msg)


def main() -> None:
    require(AUDIT.exists(), f"missing audit artifact: {AUDIT}")
    data = json.loads(AUDIT.read_text(encoding="utf-8"))

    require(data.get("name") == "WNBA_R1A_INPUT_AUDIT_V1", "unexpected audit name/version")
    require(data.get("status") == "FROZEN_OUTCOME_BLIND_INPUT_AUDIT", "audit is not frozen outcome-blind")
    require(data.get("outcomes_opened") is False, "target outcomes must remain closed in R1A")
    require(data.get("production_mutation") is False, "R1A may not mutate production")

    groups = data.get("input_groups")
    require(isinstance(groups, dict), "input_groups must be an object")
    missing_groups = REQUIRED_GROUPS - set(groups)
    require(not missing_groups, f"missing probability-critical input groups: {sorted(missing_groups)}")

    for name in sorted(REQUIRED_GROUPS):
        group = groups[name]
        require(isinstance(group, dict), f"{name} must be an object")
        missing_keys = REQUIRED_GROUP_KEYS - set(group)
        require(not missing_keys, f"{name} missing audit fields: {sorted(missing_keys)}")
        require(bool(group["provenance"]), f"{name} must declare provenance")
        require(bool(str(group["temporal_cutoff"]).strip()), f"{name} missing temporal cutoff")
        require(bool(str(group["missingness_policy"]).strip()), f"{name} missing missingness policy")
        require(bool(str(group["anti_leakage_rule"]).strip()), f"{name} missing anti-leakage rule")

    recent = groups["recent_stats"]
    require(recent.get("reconstruction_status") == "RECONSTRUCTIBLE_DEPLOYED_SEMANTICS",
            "recent stats must preserve deployed semantics")
    require(recent.get("deployed_alias_fields") == [
        "recentNetRtg", "recentOffRtg", "recentDefRtg", "recentPace"
    ], "deployed recent advanced aliases changed")
    require(recent.get("true_l10_fields") == ["recentPpg", "recentWinPct"],
            "true L10 field set changed")
    recent_text = (str(recent.get("temporal_cutoff", "")) + " " +
                   str(recent.get("missingness_policy", ""))).lower()
    require("must equal" in recent_text and "true-l10" in recent_text,
            "recent deployed-alias vs true-L10 distinction must remain explicit")

    schedule = groups["schedule_context"]
    require(schedule.get("reconstruction_status") == "RECONSTRUCTIBLE_DEPLOYED_SEMANTICS",
            "schedule context must preserve deployed semantics")
    require(schedule.get("known_deployed_semantics_quirk") is True,
            "deployed schedule-context quirk must remain explicit")
    schedule_text = str(schedule.get("temporal_cutoff", "")).lower()
    require("gap between latest and second-latest" in schedule_text,
            "deployed isB2B algorithm changed")
    require("second-latest" in schedule_text and "b2bwasroad" in schedule_text,
            "deployed b2bWasRoad algorithm changed")

    sos = groups["sos"]
    require(sos.get("reconstruction_status") == "RECONSTRUCTIBLE_CONDITIONED_SEASON_PARAMETERIZED_ANALOGUE",
            "historical SOS must remain a season-parameterized analogue")
    sos_text = str(sos.get("temporal_cutoff", "")).lower()
    require("40%" in sos_text and "60%" in sos_text and "10 most recent prior opponents" in sos_text,
            "frozen SOS historical formula changed")

    findings = data.get("outcome_blind_source_semantics_findings", {})
    require("recent_advanced_alias" in findings, "recent source-semantics finding missing")
    require("fatigue_implementation" in findings, "fatigue source-semantics finding missing")
    require("sos_current_season_literal" in findings, "SOS current-season literal finding missing")

    injuries = groups["injuries"]
    injury_status = injuries.get("reconstruction_status")
    require(injury_status in {
        "NON_RECONSTRUCTIBLE_CURRENT_SOURCE_CHAIN",
        "RECONSTRUCTIBLE_CERTIFIED_ARCHIVE",
    }, "injury status must be explicit")

    injury_missingness = str(injuries.get("missingness_policy", "")).upper()
    if injury_status != "RECONSTRUCTIBLE_CERTIFIED_ARCHIVE":
        require("UNKNOWN_IS_NOT_ZERO" in injury_missingness,
                "unresolved historical injuries must explicitly forbid zero-fill")
        require(data.get("decision") != "PASS_RECONSTRUCTIBLE",
                "cannot PASS while historical injury state is unresolved")
        require(data.get("r1b_outcome_opening_authorized") is False,
                "cannot authorize R1B outcome opening while injuries are unresolved")
        require(data.get("exact_product_replay_supported") is False,
                "cannot claim exact historical product replay while injuries are unresolved")

    manual = groups["manual_adjustment"]
    if manual.get("reconstruction_status") != "RECONSTRUCTIBLE_CERTIFIED_LOG":
        require(data.get("exact_product_replay_supported") is False,
                "manual adjustment is unresolved, so exact product replay must remain false")

    market = groups["market"]
    require(market.get("reconstruction_status") == "EXCLUDED_FROM_SPORTS_ONLY",
            "market input must be excluded from SPORTS_ONLY_V1")

    candidate = data.get("candidate_assessment", {}).get("SPORTS_ONLY_V1", {})
    require(candidate.get("market_input") == "EXCLUDED",
            "SPORTS_ONLY_V1 candidate must not consume market data")

    invariants = [str(x).lower() for x in data.get("anti_leakage_invariants", [])]
    invariant_text = " ".join(invariants)
    require("prior-game outcomes" in invariant_text and "before the target cutoff" in invariant_text,
            "audit must distinguish valid prior-game outcomes from target leakage")
    require("target game's final score" in invariant_text,
            "target-game final score prohibition must be explicit")
    require("deployed source semantics" in invariant_text and "separately preregistered" in invariant_text,
            "outcome-blind deployed semantics may not be silently corrected")

    prohibited = " ".join(str(x).lower() for x in data.get("prohibited_next_actions", []))
    require("injury" in prohibited and "zero" in prohibited,
            "zero-filling unresolved historical injury state must be prohibited")
    require("open target outcomes" in prohibited,
            "opening target outcomes while conditional must be prohibited")
    require("recent-advanced aliases" in prohibited and "b2b" in prohibited,
            "silent source-semantics corrections must be prohibited")

    decision = data.get("decision")
    require(decision in {"PASS_RECONSTRUCTIBLE", "CONDITIONAL", "BLOCKED"},
            f"invalid decision: {decision!r}")

    closure = data.get("closure", {})
    require(closure.get("source_semantics_frozen_outcome_blind") is True,
            "outcome-blind source semantics must be frozen")
    require(closure.get("target_outcomes_may_be_opened") is False,
            "R1A closure must keep target outcomes closed")

    print("WNBA R1A VALIDATION: PASS")
    print(f"decision={decision}")
    print(f"outcomes_opened={data['outcomes_opened']}")
    print(f"exact_product_replay_supported={data['exact_product_replay_supported']}")
    print(f"injury_status={injury_status}")
    print("deployed_source_semantics=frozen")


if __name__ == "__main__":
    main()
