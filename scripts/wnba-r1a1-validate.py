#!/usr/bin/env python3
import json
from pathlib import Path

CERT = Path("research/wnba/WNBA_R1A1_INJURY_SOURCE_CERTIFICATION.json")


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(f"WNBA R1A.1 VALIDATION FAILED: {msg}")


def main() -> None:
    require(CERT.exists(), f"missing certification artifact: {CERT}")
    data = json.loads(CERT.read_text(encoding="utf-8"))

    require(data.get("name") == "WNBA_R1A1_INJURY_SOURCE_CERTIFICATION_V1", "unexpected certification version")
    require(data.get("status") == "FROZEN_OUTCOME_BLIND_SOURCE_AUDIT", "certification must remain outcome-blind")
    require(data.get("outcomes_opened") is False, "target outcomes must remain closed")
    require(data.get("production_mutation") is False, "R1A.1 may not mutate production")
    require(data.get("r1b_outcome_opening_authorized") is False, "R1B may not be authorized yet")

    scope = data.get("scope", {})
    require(scope.get("seasons") == [2021, 2022, 2023, 2024, 2025], "scope must remain 2021-2025")
    require(scope.get("feature") == "injury_adjustment", "R1A.1 must remain injury-source audit")

    source = data.get("candidate_source", {})
    require(source.get("vendor") == "Sportradar", "candidate source vendor changed")
    require(source.get("feed") == "Daily Injuries", "candidate feed changed")
    require("{year}" in source.get("endpoint_template", ""), "historical date parameter missing from endpoint")
    require(source.get("authentication") == "x-api-key required", "authentication contract changed")

    interp = data.get("scientific_interpretation", {})
    require(interp.get("historical_feed_exists") is True, "historical feed finding missing")
    require(interp.get("historical_2021_2025_full_coverage_proven") is False, "cannot claim 2021-2025 coverage before empirical certification")
    require(interp.get("intra_day_pretip_snapshot_proven") is False, "cannot claim exact pre-tip state before as-of proof")
    require(interp.get("can_upgrade_r1a_to_pass_now") is False, "R1A may not upgrade yet")

    external = data.get("external_evidence", [])
    urls = {x.get("url") for x in external if isinstance(x, dict)}
    required_urls = {
        "https://developer.sportradar.com/basketball/docs/wnba-ig-historical-data",
        "https://developer.sportradar.com/basketball/reference/wnba-daily-injuries",
        "https://developer.sportradar.com/sportradar-updates/changelog/nba-wnba-apis",
        "https://www.wnba.com/wnba-injury-report",
    }
    require(required_urls.issubset(urls), "required source evidence missing")

    empirical = data.get("empirical_certification_required", {})
    require(empirical.get("credentials_required") is True, "empirical test must declare credentials requirement")
    checks = " ".join(empirical.get("minimum_checks", [])).lower()
    for token in ("2021", "2022", "2023", "2024", "2025", "target-tip", "raw-response"):
        require(token in checks, f"empirical certification missing requirement: {token}")

    fallback = data.get("fallback_if_2021_2025_not_certifiable", {})
    forbidden = " ".join(fallback.get("forbidden", [])).lower()
    require("missing injury state as healthy" in forbidden, "unknown injury state must never be zero-filled")
    require("target-game minutes" in forbidden, "target-game participation inference must be forbidden")
    require("open target outcomes" in forbidden, "outcomes must stay closed before source rule")

    closure = data.get("closure", {})
    require(closure.get("scientific_result") == "R1A1_SOURCE_PROMISING_BUT_NOT_CERTIFIED", "closure status changed")
    require(closure.get("next_gate") == "EMPIRICAL_SPORTRADAR_COVERAGE_AND_ASOF_TEST", "unexpected next gate")
    require(closure.get("target_outcomes_may_be_opened") is False, "outcomes cannot be opened")

    print("WNBA R1A.1 VALIDATION: PASS")
    print(f"decision={data['decision']}")
    print(f"next_gate={closure['next_gate']}")
    print("outcomes_opened=false")


if __name__ == "__main__":
    main()
