#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import itertools
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

MODULE_PATH = Path("scripts/wnba-r3b2-rolling-origin-evaluation.py")
spec = importlib.util.spec_from_file_location("wnba_r3b2_base_evaluator", MODULE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("unable to load frozen R3B2 evaluator")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def family_input_audit(rows: list[dict[str, Any]], protocol: dict[str, Any], family: str) -> dict[str, Any]:
    container = m.R3_CONTAINER[family]
    fields = m.fields_for(protocol, family)
    missing_by_field: Counter[str] = Counter()
    affected_games: set[str] = set()
    missing_side_values = 0
    nonfinite_side_values = 0
    for row in rows:
        for side in ("home", "away"):
            payload = row["r3"][side][container]
            for field in fields:
                v = payload.get(field)
                if v is None:
                    missing_by_field[field] += 1
                    missing_side_values += 1
                    affected_games.add(str(row["gameId"]))
                    continue
                if isinstance(v, bool):
                    continue
                try:
                    x = float(v)
                except (TypeError, ValueError):
                    nonfinite_side_values += 1
                    affected_games.add(str(row["gameId"]))
                    continue
                if not math.isfinite(x):
                    nonfinite_side_values += 1
                    affected_games.add(str(row["gameId"]))
    ready = missing_side_values == 0 and nonfinite_side_values == 0
    return {
        "family": family,
        "ready_for_frozen_no_imputation_model": ready,
        "missing_side_values": missing_side_values,
        "nonfinite_side_values": nonfinite_side_values,
        "affected_games": len(affected_games),
        "missing_by_field": dict(sorted(missing_by_field.items())),
        "frozen_policy_if_not_ready": "FAIL_CLOSED_NO_IMPUTATION_NO_ROW_DROPPING",
    }


def main() -> None:
    protocol_raw = m.PROTOCOL_PATH.read_bytes()
    protocol = json.loads(protocol_raw)
    if protocol.get("status") != "FROZEN_BEFORE_R3B2_OUTCOME_OPENING":
        raise SystemExit("unexpected R3B2 protocol status")

    rows, row_ev = m.load_feature_rows(protocol)
    labels, outcome_ev = m.load_labels(protocol, {str(r["gameId"]) for r in rows})

    base = m.fit_candidate(protocol, rows, labels, ())
    singles: dict[str, dict[str, Any] | None] = {}
    single_gates: dict[str, Any] = {}
    family_input_audits: dict[str, Any] = {}
    all_prediction_rows: list[dict[str, Any]] = list(base["predictions"])

    for fam in m.FAMILIES:
        audit = family_input_audit(rows, protocol, fam)
        family_input_audits[fam] = audit
        if not audit["ready_for_frozen_no_imputation_model"]:
            singles[fam] = None
            single_gates[fam] = {
                "qualifies": False,
                "status": "UNSCORABLE_FAIL_CLOSED",
                "reason": "FROZEN_PROTOCOL_FORBIDS_IMPUTATION_AND_TARGET_ROW_DROPPING_FOR_MISSING_FAMILY_INPUTS",
            }
            continue
        ev = m.fit_candidate(protocol, rows, labels, (fam,))
        singles[fam] = ev
        single_gates[fam] = m.single_gate(base, ev)
        all_prediction_rows.extend(ev["predictions"])

    eligible = [fam for fam in m.FAMILIES if single_gates[fam]["qualifies"]]
    best_single: dict[str, Any] | None = None
    combos: dict[str, dict[str, Any]] = {}
    combo_gates: dict[str, Any] = {}
    advancing: list[dict[str, Any]] = []

    if eligible:
        q = [singles[f] for f in eligible if singles[f] is not None]
        best_single = min(q, key=lambda e: (e["pooled"]["log_loss"], e["pooled"]["brier"], e["candidate"]))
        for size in (2, 3):
            for fam_tuple in itertools.combinations(eligible, size):
                ev = m.fit_candidate(protocol, rows, labels, tuple(fam_tuple))
                combos[ev["candidate"]] = ev
                gate = m.combination_gate(best_single, ev)
                combo_gates[ev["candidate"]] = gate
                all_prediction_rows.extend(ev["predictions"])
                if gate["advances"]:
                    advancing.append(ev)

    if advancing:
        final_pre = min(
            advancing,
            key=lambda e: (e["pooled"]["log_loss"], e["pooled"]["brier"], len(e["families"]), e["candidate"]),
        )
        final_families = tuple(final_pre["families"])
    elif best_single is not None:
        final_families = tuple(best_single["families"])
    else:
        final_families = ()

    final_eval = m.fit_candidate(protocol, rows, labels, final_families, with_contributions=True)
    elite = m.elite_screen(final_eval)
    selected_predictions = elite.pop("selected_predictions", []) if elite.get("enabled") else []

    all_prediction_rows.sort(key=lambda x: (x["candidate"], x["season"], x["targetDate"], x["gameId"]))
    m.OUT_PREDICTIONS.write_text("".join(m.canonical(x) + "\n" for x in all_prediction_rows), encoding="utf-8")

    selected_ids = {str(x["gameId"]): x for x in selected_predictions}
    final_lines = []
    for x in final_eval["predictions"]:
        row = dict(x)
        elite_row = selected_ids.get(str(x["gameId"]))
        if elite_row:
            row.update({k: v for k, v in elite_row.items() if k not in row})
            row["elite"] = True
        else:
            row["elite"] = False
        final_lines.append(row)
    m.OUT_FINAL.write_text("".join(m.canonical(x) + "\n" for x in final_lines), encoding="utf-8")

    single_public = {
        fam: {
            "input_audit": family_input_audits[fam],
            "evaluation": m.public_eval(singles[fam]) if singles[fam] is not None else None,
            "gate": single_gates[fam],
        }
        for fam in m.FAMILIES
    }
    combo_public = {
        cid: {"evaluation": m.public_eval(ev), "gate": combo_gates[cid]} for cid, ev in sorted(combos.items())
    }

    if elite.get("development_feasibility_pass"):
        decision = "R3_DEVELOPMENT_FEASIBILITY_PASS_NOT_CERTIFICATION"
    elif len(final_families) < 2:
        decision = "R3_NO_MULTIDIMENSIONAL_ELITE_CANDIDATE"
    else:
        decision = "R3_DEVELOPMENT_FEASIBILITY_FAIL"

    evidence = {
        "name": "WNBA_R3B2_FROZEN_PROTOCOL_OOS_EVALUATION_EVIDENCE_V1",
        "status": "COMPLETED_FROZEN_PROTOCOL_EVALUATION",
        "protocol": {
            "file": str(m.PROTOCOL_PATH),
            "bytes": len(protocol_raw),
            "sha256": m.sha256_bytes(protocol_raw),
            "outcome_values_read_before_protocol_freeze": False,
        },
        "feature_rowset": row_ev,
        "outcome_custody": outcome_ev,
        "anti_leakage": {
            "feature_rowset_pre_frozen_outcome_blind": True,
            "same_game_outcome_used_as_feature": False,
            "same_date_outcome_used_as_feature": False,
            "future_outcome_used_as_feature": False,
            "market_fields_used": False,
            "target_season_threshold_search": False,
            "post_result_row_dropping": False,
            "manual_candidate_switching": False,
            "hyperparameter_search": False,
        },
        "base": m.public_eval(base),
        "single_family_ablations": single_public,
        "family_input_audits": family_input_audits,
        "operational_fail_closed_note": {
            "first_outcome_open_attempt_run_id": 33261132319,
            "first_attempt_science_result_produced": False,
            "science_changed_after_outcome_opening": False,
            "rule_applied": "Frozen preprocessing requires FAIL_CLOSED with no imputation and no target-row dropping; any family with undefined inputs is unscorable and cannot qualify.",
        },
        "eligible_single_families": eligible,
        "best_qualifying_single": best_single["candidate"] if best_single else None,
        "bounded_combinations": combo_public,
        "advancing_combinations": sorted(x["candidate"] for x in advancing),
        "final_candidate": m.public_eval(final_eval),
        "elite_feasibility": elite,
        "scientific_decision": decision,
        "cross_sport_certified": False,
        "production_mutation": False,
        "global_ranker_mutation": False,
        "next_action": (
            "FREEZE_R3_DEVELOPMENT_CANDIDATE_AND_REQUIRE_INDEPENDENT_PROSPECTIVE_COHORT"
            if elite.get("development_feasibility_pass")
            else "RECORD_FROZEN_R3B2_FAILURE_OR_LIMITATION; ANY SCIENCE CHANGE REQUIRES_NEW_VERSION"
        ),
        "artifacts": {},
    }

    for path, key in (
        (m.OUT_PREDICTIONS, "all_oos_predictions"),
        (m.OUT_FINAL, "final_candidate_predictions"),
    ):
        raw = path.read_bytes()
        evidence["artifacts"][key] = {
            "file": path.name,
            "bytes": len(raw),
            "sha256": m.sha256_bytes(raw),
            "rows": sum(1 for _ in path.open("r", encoding="utf-8")),
        }
    m.OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "decision": decision,
        "family_input_audits": family_input_audits,
        "eligible_single_families": eligible,
        "best_qualifying_single": best_single["candidate"] if best_single else None,
        "advancing_combinations": sorted(x["candidate"] for x in advancing),
        "final_candidate": final_eval["candidate"],
        "final_pooled": final_eval["pooled"],
        "elite_feasibility": elite,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
