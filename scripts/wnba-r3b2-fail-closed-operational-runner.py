#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

EVALUATOR_PATH = Path("scripts/wnba-r3b2-rolling-origin-evaluation.py")
POLICY_PATH = Path("research/wnba/WNBA_R3B2_H2H_ZERO_MEETING_FAIL_CLOSED_POLICY.json")
PREFLIGHT_PATH = Path("wnba-r3b2-operational-input-preflight.json")


def load_evaluator() -> Any:
    spec = importlib.util.spec_from_file_location("wnba_r3b2_frozen_evaluator", EVALUATOR_PATH)
    if spec is None or spec.loader is None:
        raise SystemExit("unable to load frozen R3B2 evaluator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def numeric_ok(value: Any) -> bool:
    if isinstance(value, bool):
        return True
    if value is None:
        return False
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def main() -> None:
    evaluator = load_evaluator()
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    protocol = json.loads(evaluator.PROTOCOL_PATH.read_text(encoding="utf-8"))

    if policy.get("status") != "FROZEN_OPERATIONAL_BUGFIX_NO_SCIENCE_CHANGE":
        raise SystemExit("unexpected operational policy status")
    frozen_missing = protocol.get("preprocessing", {}).get("missing_or_nonfinite_policy")
    if frozen_missing != "FAIL_CLOSED; no imputation and no target-row dropping. R3B1 certification already reports complete finite inputs.":
        raise SystemExit("frozen R3B2 missing-data policy drift")

    rows, row_ev = evaluator.load_feature_rows(protocol)
    expected_rowset = policy["frozen_feature_rowset"]
    if row_ev["rows"] != int(expected_rowset["rows"]) or row_ev["sha256"] != expected_rowset["sha256"]:
        raise SystemExit("operational policy rowset pin mismatch")

    original_families = list(evaluator.FAMILIES)
    remaining_families = list(policy["operational_resolution"]["remaining_families"])
    if set(original_families) != {
        "FOUR_FACTORS",
        "QUALITY_ADJUSTED_FORM",
        "H2H_PREFIX",
        "FATIGUE_CORE",
        "SHOT_PROFILE_MATCHUP",
    }:
        raise SystemExit("frozen evaluator family registry drift")
    if "H2H_PREFIX" in remaining_families or set(remaining_families) != set(original_families) - {"H2H_PREFIX"}:
        raise SystemExit("operational remaining-family policy drift")

    unexpected: list[dict[str, Any]] = []
    affected_game_ids: list[str] = []
    affected_by_season: Counter[int] = Counter()
    structural_null_values = 0

    for row in rows:
        # BASE_R2 and every non-H2H family must remain fully finite.
        for field in protocol["feature_vectors"]["BASE_R2"]:
            for side in ("home", "away"):
                value = row["baseR2"][side].get(field)
                if not numeric_ok(value):
                    unexpected.append({"gameId": str(row["gameId"]), "family": "BASE_R2", "side": side, "field": field, "value": value})

        for family in original_families:
            container = evaluator.R3_CONTAINER[family]
            for field in protocol["feature_vectors"][family]:
                for side in ("home", "away"):
                    value = row["r3"][side][container].get(field)
                    if family == "H2H_PREFIX" and field in {"winShare", "avgMargin"} and value is None:
                        continue
                    if not numeric_ok(value):
                        unexpected.append({"gameId": str(row["gameId"]), "family": family, "side": side, "field": field, "value": value})

        home_h2h = row["r3"]["home"]["h2h"]
        away_h2h = row["r3"]["away"]["h2h"]
        null_fields = [
            home_h2h.get("winShare"),
            home_h2h.get("avgMargin"),
            away_h2h.get("winShare"),
            away_h2h.get("avgMargin"),
        ]
        has_h2h_null = any(value is None for value in null_fields)
        if has_h2h_null:
            exact_zero_meeting_pattern = (
                home_h2h.get("meetingCount") == 0
                and away_h2h.get("meetingCount") == 0
                and all(value is None for value in null_fields)
            )
            if not exact_zero_meeting_pattern:
                unexpected.append({
                    "gameId": str(row["gameId"]),
                    "family": "H2H_PREFIX",
                    "reason": "unexpected_partial_or_nonzero_meeting_null_pattern",
                    "home": home_h2h,
                    "away": away_h2h,
                })
            else:
                affected_game_ids.append(str(row["gameId"]))
                affected_by_season[int(row["season"])] += 1
                structural_null_values += 4
        else:
            for side_name, h2h in (("home", home_h2h), ("away", away_h2h)):
                for field in ("meetingCount", "winShare", "avgMargin", "historySeasonsAvailable"):
                    if not numeric_ok(h2h.get(field)):
                        unexpected.append({"gameId": str(row["gameId"]), "family": "H2H_PREFIX", "side": side_name, "field": field, "value": h2h.get(field)})

    expected_games = int(policy["input_defect"]["affected_games"])
    expected_nulls = int(policy["input_defect"]["null_values"])
    expected_by_season = {int(k): int(v) for k, v in policy["input_defect"]["affected_games_by_season"].items()}
    observed_by_season = {season: int(affected_by_season.get(season, 0)) for season in sorted(expected_by_season)}

    gates = {
        "frozen_rowset_sha_exact": row_ev["sha256"] == expected_rowset["sha256"],
        "frozen_rowset_rows_exact": row_ev["rows"] == int(expected_rowset["rows"]),
        "unexpected_missing_or_nonfinite_values": len(unexpected),
        "h2h_zero_meeting_affected_games": len(affected_game_ids),
        "h2h_zero_meeting_affected_games_exact": len(affected_game_ids) == expected_games,
        "h2h_structural_null_values": structural_null_values,
        "h2h_structural_null_values_exact": structural_null_values == expected_nulls,
        "h2h_affected_by_season": observed_by_season,
        "h2h_affected_by_season_exact": observed_by_season == expected_by_season,
        "imputation_used": False,
        "target_rows_dropped": 0,
        "outcomes_opened_during_preflight": False,
    }
    authorized = (
        gates["frozen_rowset_sha_exact"]
        and gates["frozen_rowset_rows_exact"]
        and gates["unexpected_missing_or_nonfinite_values"] == 0
        and gates["h2h_zero_meeting_affected_games_exact"]
        and gates["h2h_structural_null_values_exact"]
        and gates["h2h_affected_by_season_exact"]
    )
    preflight = {
        "name": "WNBA_R3B2_FAIL_CLOSED_OPERATIONAL_INPUT_PREFLIGHT_V1",
        "policy": str(POLICY_PATH),
        "feature_rowset": row_ev,
        "blocked_family": "H2H_PREFIX",
        "blocked_reason": "ZERO_MEETING_WINSHARE_AND_AVGMARGIN_STRUCTURALLY_UNDEFINED_UNDER_FROZEN_NO_IMPUTATION_POLICY",
        "remaining_families": remaining_families,
        "gates": gates,
        "unexpected_examples": unexpected[:20],
        "authorized_to_open_outcomes": authorized,
    }
    PREFLIGHT_PATH.write_text(json.dumps(preflight, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(preflight, indent=2, sort_keys=True))
    if not authorized:
        raise SystemExit("R3B2 operational input preflight failed before outcome opening")

    # Enforce the frozen FAIL_CLOSED policy. No values are changed and no rows are removed.
    evaluator.FAMILIES = remaining_families
    evaluator.main()

    evidence = json.loads(evaluator.OUT_EVIDENCE.read_text(encoding="utf-8"))
    evidence["operational_fail_closed_input_resolution"] = {
        "policy": str(POLICY_PATH),
        "preflight": str(PREFLIGHT_PATH),
        "preflight_authorized_before_outcome_opening": True,
        "blocked_families": {
            "H2H_PREFIX": {
                "status": "INPUT_BLOCKED_FAIL_CLOSED",
                "affected_games": len(affected_game_ids),
                "structural_null_values": structural_null_values,
                "imputation_used": False,
                "target_rows_dropped": 0,
                "science_changed": False,
            }
        },
        "remaining_families_evaluated_under_frozen_protocol": remaining_families,
    }
    evidence["single_family_ablations"]["H2H_PREFIX"] = {
        "evaluation": None,
        "gate": {
            "qualifies": False,
            "input_gate_pass": False,
            "reason": "INPUT_BLOCKED_FAIL_CLOSED_ZERO_MEETING_STRUCTURAL_NULLS",
            "metric_gate_opened": False,
        },
    }
    evidence["blocked_single_families"] = ["H2H_PREFIX"]
    evidence["anti_leakage"]["h2h_null_imputation"] = False
    evidence["anti_leakage"]["h2h_null_row_dropping"] = False
    evidence["anti_leakage"]["operational_input_block_decided_before_rerun_outcome_opening"] = True
    evaluator.OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "operational_rerun": "COMPLETED",
        "blocked_family": "H2H_PREFIX",
        "affected_games": len(affected_game_ids),
        "imputation_used": False,
        "target_rows_dropped": 0,
        "scientific_decision": evidence["scientific_decision"],
        "final_candidate": evidence["final_candidate"]["candidate"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
