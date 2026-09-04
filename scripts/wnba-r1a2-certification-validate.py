#!/usr/bin/env python3
import json
from pathlib import Path

PATH = Path("research/wnba/WNBA_R1A2_STATS_SOURCE_CERTIFICATION.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"WNBA R1A.2 VALIDATION FAILED: {message}")


def main() -> None:
    data = json.loads(PATH.read_text(encoding="utf-8"))
    require(data.get("status") == "FROZEN_OUTCOME_BLIND_SOURCE_ACCESS_AUDIT", "status changed")
    require(data.get("decision") == "ACCESS_BLOCKED_NOT_CERTIFIED", "decision changed")
    require(data.get("outcomes_opened") is False, "outcomes must remain closed")
    require(data.get("r1b_outcome_opening_authorized") is False, "R1B may not open")
    ev = data.get("probe_evidence", {}).get("classified_run", {})
    require(ev.get("run_id") == 33073426510, "classified run changed")
    require(ev.get("host_attempts") == 30, "expected 30 host attempts")
    require(ev.get("http_responses_received") == 0, "this verdict requires zero HTTP responses")
    require(ev.get("access_classification") == "HOST_ACCESS_TIMEOUT_OR_NETWORK_BLOCK", "failure classification changed")
    interp = data.get("scientific_interpretation", {})
    require(interp.get("historical_coverage_proven") is False, "coverage cannot be claimed")
    require(interp.get("historical_coverage_disproven") is False, "timeouts cannot disprove coverage")
    closure = data.get("closure", {})
    require(closure.get("next_gate") == "R1A3_CREDENTIAL_FREE_PRIOR_GAME_SOURCE_AUDIT", "next gate changed")
    require(closure.get("target_outcomes_may_be_opened") is False, "outcomes may not open")
    print("WNBA R1A.2 VALIDATION: PASS")
    print("decision=ACCESS_BLOCKED_NOT_CERTIFIED")
    print("coverage_disproven=false")
    print("next_gate=R1A3_CREDENTIAL_FREE_PRIOR_GAME_SOURCE_AUDIT")


if __name__ == "__main__":
    main()
