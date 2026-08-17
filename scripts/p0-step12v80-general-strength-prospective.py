#!/usr/bin/env python3
"""Outcome-free V80 prospective capture and exact V69 TOP1 materialization.

The scorer intentionally has no outcome-query code. Capture consumes only an immutable
prior-date state plus exact pregame identity/context. Materialization consumes only
first-write game snapshots and reproduces the frozen V69 CONFLUENCE_LEDGER_TOP1_T0.550
priority/tie-break semantics. V80 outcomes remain embargoed for a separate final scorer.
"""

import argparse
import hashlib
import importlib.util
import json
import math
import os
from datetime import datetime, timezone

CAPTURE_SCHEMA = "courtedge-p0-step12v80-general-strength-prospective-capture.v1"
CONTEXT_SCHEMA = "courtedge-p0-step12v80-general-strength-live-context.v1"
DAILY_SCHEMA = "courtedge-p0-step12v80-general-strength-daily-top1.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v80-general-strength-prospective-confirmation-contract.v1"
CONTRACT_STATUS = "FROZEN_GENERAL_STRENGTH_PROSPECTIVE_CONFIRMATION_BEFORE_ANY_V80_SCORER_OR_CAPTURE_EXISTS"
V68_STATE_SCHEMA = "courtedge-p0-step12v68-prospective-state.v1"
GENERAL_ROUTE = "V16_V68_CONSENSUS_T0.550"
CONTROL4 = ("lineup_exposure_rate_adv", "starter_kbb_adv", "combined_team_rs10", "team_rd10_diff")
TIER_ORD = {"BOTTOM": 0, "MID": 1, "TOP": 2}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V80_PROSPECTIVE_IMPORT_FAILED:{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def parse_time(value):
    text = str(value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise SystemExit(f"V80_PROSPECTIVE_INVALID_TIMESTAMP:{value}")
    if dt.tzinfo is None:
        raise SystemExit(f"V80_PROSPECTIVE_TIMESTAMP_TZ_REQUIRED:{value}")
    return dt.astimezone(timezone.utc)


def validate_contract(c):
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != CONTRACT_STATUS:
        raise SystemExit("V80_PROSPECTIVE_CONTRACT_INVALID")
    if c["prospectiveCohort"].get("targetRouteExactly") != GENERAL_ROUTE:
        raise SystemExit("V80_PROSPECTIVE_GENERAL_ROUTE_DRIFT")
    if c["prospectiveCohort"].get("parentPortfolioExactly") != "CONFLUENCE_LEDGER_TOP1_T0.550":
        raise SystemExit("V80_PROSPECTIVE_PARENT_PORTFOLIO_DRIFT")
    if float(c["prospectiveCohort"].get("generalConsensusThreshold")) != 0.55:
        raise SystemExit("V80_PROSPECTIVE_GENERAL_THRESHOLD_DRIFT")
    if c["marketBoundary"].get("oddsMayBeModelFeatures") is not False:
        raise SystemExit("V80_PROSPECTIVE_ODDS_BOUNDARY_DRIFT")


def relation(selected_tier, opponent_tier):
    if selected_tier not in TIER_ORD or opponent_tier not in TIER_ORD:
        raise SystemExit(f"V80_PROSPECTIVE_STRENGTH_TIER_INVALID:{selected_tier}:{opponent_tier}")
    a, b = TIER_ORD[selected_tier], TIER_ORD[opponent_tier]
    if a > b:
        return "SELECTED_STRONGER"
    if a < b:
        return "SELECTED_WEAKER"
    return "PEER"


def existing_capture(path):
    if not path or not os.path.exists(path):
        return {}
    x = load(path)
    if x.get("schemaVersion") != CAPTURE_SCHEMA:
        raise SystemExit("V80_PROSPECTIVE_EXISTING_CAPTURE_SCHEMA_INVALID")
    out = {}
    for row in x.get("rows", []):
        gp = int(row["gamePk"])
        if gp in out:
            raise SystemExit(f"V80_PROSPECTIVE_EXISTING_DUPLICATE:{gp}")
        out[gp] = row
    return out


def classifier_score(row):
    c = row.get("frozenClassifier") or {}
    if c.get("version") != "mlb-frozen-a-plus-classifier.v1":
        raise SystemExit(f"V80_PROSPECTIVE_CLASSIFIER_VERSION_DRIFT:{row.get('gamePk')}")
    p = c.get("probabilities") or {}
    a, b = p.get("aPlusC4PHome"), p.get("aPlusFull13PHome")
    if not finite(a) or not finite(b):
        raise SystemExit(f"V80_PROSPECTIVE_CLASSIFIER_SCORE_MISSING:{row.get('gamePk')}")
    return min(float(a), float(b))


def capture(args):
    c80 = load(args.contract)
    validate_contract(c80)
    ctx = load(args.context)
    if ctx.get("schemaVersion") != CONTEXT_SCHEMA:
        raise SystemExit("V80_PROSPECTIVE_CONTEXT_SCHEMA_INVALID")
    target_date = str(ctx.get("targetOfficialDate") or "")
    if target_date < c80["prospectiveCohort"]["firstEligibleOfficialDate"]:
        raise SystemExit(f"V80_PROSPECTIVE_PRE_FREEZE_DATE:{target_date}")
    if ctx.get("policy", {}).get("outcomesRead") is not False or ctx.get("policy", {}).get("pricesRead") is not False:
        raise SystemExit("V80_PROSPECTIVE_CONTEXT_OUTCOME_OR_PRICE_BOUNDARY_INVALID")

    v68_state = load(args.v68_state)
    if v68_state.get("schemaVersion") != V68_STATE_SCHEMA or str(v68_state.get("targetOfficialDate")) != target_date:
        raise SystemExit("V80_PROSPECTIVE_V68_STATE_DATE_OR_SCHEMA_INVALID")
    chronology = v68_state.get("chronology") or {}
    if chronology.get("wholeOfficialDatePriorStateOnly") is not True or chronology.get("sameDateOutcomesUsed") is not False:
        raise SystemExit("V80_PROSPECTIVE_V68_STATE_CHRONOLOGY_INVALID")

    src = module(args.v68_source_script, "v80_v68_source")
    cap = module(args.v68_capture_script, "v80_v68_capture")
    manifest = load(args.v68_source_manifest)
    v62c = load(args.v62_contract)
    v68c = load(args.v68_contract)
    v16 = load(args.v16_manifest)
    feature_names = cap.validate_contract(v68c)
    v16_model = cap.validate_v16(args.v16_manifest, v16, v68c)
    v68_model = v68c["primaryCandidate"]["modelSnapshot"]
    if tuple(v68_model["features"]) != feature_names:
        raise SystemExit("V80_PROSPECTIVE_V68_MODEL_FEATURE_DRIFT")

    old = existing_capture(args.existing)
    incoming = ctx.get("rows") or []
    seen = set()
    added = 0
    duplicates = 0
    max_c4_diff = 0.0
    for row in incoming:
        gp = int(row["gamePk"])
        if gp in seen:
            raise SystemExit(f"V80_PROSPECTIVE_DUPLICATE_CONTEXT_GAME:{gp}")
        seen.add(gp)
        if str(row.get("officialDate")) != target_date:
            raise SystemExit(f"V80_PROSPECTIVE_CONTEXT_DATE_MISMATCH:{gp}")
        start, captured, cutoff = parse_time(row.get("startTime")), parse_time(row.get("capturedAt")), parse_time(row.get("sourceCutoffAt"))
        if captured >= start or cutoff >= start or cutoff > captured:
            raise SystemExit(f"V80_PROSPECTIVE_NOT_STRICTLY_PREGAME:{gp}")
        if row.get("exactPregameLineupSemantics") is not True or row.get("exactPregameProbableStarterSemantics") is not True:
            raise SystemExit(f"V80_PROSPECTIVE_EXACT_IDENTITY_REQUIRED:{gp}")
        if row.get("wholeOfficialDatePriorStateOnly") is not True or row.get("containsOutcome") is not False or row.get("containsMarketPrice") is not False:
            raise SystemExit(f"V80_PROSPECTIVE_SOURCE_BOUNDARY_INVALID:{gp}")
        if gp in old:
            e = old[gp]
            if str(e["officialDate"]) != target_date or int(e["homeTeamId"]) != int(row["homeTeamId"]) or int(e["awayTeamId"]) != int(row["awayTeamId"]):
                raise SystemExit(f"V80_PROSPECTIVE_DUPLICATE_IDENTITY_CONFLICT:{gp}")
            duplicates += 1
            continue

        identity = {
            "gamePk": gp,
            "homeTeamId": int(row["homeTeamId"]),
            "awayTeamId": int(row["awayTeamId"]),
            "homePitcherId": int(row["homePitcherId"]),
            "awayPitcherId": int(row["awayPitcherId"]),
            "homeBattingOrder": [int(x) for x in row["homeBattingOrder"]],
            "awayBattingOrder": [int(x) for x in row["awayBattingOrder"]],
        }
        v68_features, v68_mechanism = src.feature_row(v68_state, identity, manifest, v62c)
        full13 = row.get("full13Features") or {}
        if len(full13) != 13:
            raise SystemExit(f"V80_PROSPECTIVE_FULL13_FEATURE_COUNT_DRIFT:{gp}:{len(full13)}")
        for name in CONTROL4:
            a, b = v68_features.get(name), full13.get(name)
            if a is None or b is None:
                if a != b:
                    raise SystemExit(f"V80_PROSPECTIVE_C4_NULL_PARITY_FAILED:{gp}:{name}:{a}:{b}")
                continue
            diff = abs(float(a) - float(b))
            max_c4_diff = max(max_c4_diff, diff)
            if diff > 1e-12:
                raise SystemExit(f"V80_PROSPECTIVE_C4_NUMERIC_PARITY_FAILED:{gp}:{name}:{diff}")

        s16 = cap.score_binary(v16_model, v68_features)
        s68 = cap.score_binary(v68_model, v68_features)
        p16, p68 = float(s16["homeWinProbability"]), float(s68["homeWinProbability"])
        side16, side68 = ("HOME" if p16 >= 0.5 else "AWAY"), ("HOME" if p68 >= 0.5 else "AWAY")
        agree = side16 == side68
        p16_sel = p16 if side16 == "HOME" else 1.0 - p16
        p68_sel = p68 if side16 == "HOME" else 1.0 - p68
        consensus = min(p16_sel, p68_sel) if agree else None
        hs, aws = row.get("homeStrength"), row.get("awayStrength")
        if not isinstance(hs, dict) or not isinstance(aws, dict):
            raise SystemExit(f"V80_PROSPECTIVE_STRENGTH_MISSING:{gp}")
        for z in (hs, aws):
            if not finite(z.get("strengthScore")) or z.get("primaryTier") not in TIER_ORD:
                raise SystemExit(f"V80_PROSPECTIVE_STRENGTH_INVALID:{gp}")
        d1 = row.get("bullpenPitches1dAdv")
        if not finite(d1):
            raise SystemExit(f"V80_PROSPECTIVE_D1_MISSING:{gp}")
        cls = row.get("frozenClassifier") or {}
        score = classifier_score(row)
        source_record = {
            "gamePk": gp,
            "officialDate": target_date,
            "homeTeamId": identity["homeTeamId"],
            "awayTeamId": identity["awayTeamId"],
            "homePitcherId": identity["homePitcherId"],
            "awayPitcherId": identity["awayPitcherId"],
            "homeBattingOrder": identity["homeBattingOrder"],
            "awayBattingOrder": identity["awayBattingOrder"],
            "startTime": row["startTime"],
            "capturedAt": row["capturedAt"],
            "sourceCutoffAt": row["sourceCutoffAt"],
            "contextSourceEvidenceDigest": row.get("sourceEvidenceDigest"),
            "contextStateDigest": ctx.get("stateDigest"),
        }
        old[gp] = {
            **source_record,
            "canonicalFirstCaptureImmutable": True,
            "canonicalSourceRecordDigest": canonical_digest(source_record),
            "v68FeatureDigest": canonical_digest(v68_features),
            "v68MechanismDiagnostics": v68_mechanism,
            "full13FeatureDigest": canonical_digest(full13),
            "v16": s16,
            "v68": s68,
            "p16Home": p16,
            "p68Home": p68,
            "selectedSide": side16,
            "v16V68Agree": agree,
            "p16Selected": p16_sel if agree else None,
            "p68Selected": p68_sel if agree else None,
            "consensusScore": consensus,
            "frozenClassifier": cls,
            "classifierScore": score,
            "bullpenPitches1dAdv": float(d1),
            "homeBullpenPitches1d": float(row.get("homeBullpenPitches1d", 0.0)),
            "awayBullpenPitches1d": float(row.get("awayBullpenPitches1d", 0.0)),
            "homeStrength": hs,
            "awayStrength": aws,
            "containsOutcome": False,
            "containsMarketPrice": False,
        }
        added += 1

    rows = sorted(old.values(), key=lambda r: (str(r["officialDate"]), int(r["gamePk"])))
    payload = {
        "schemaVersion": CAPTURE_SCHEMA,
        "scientificStatus": "V80_OUTCOME_FREE_PREGAME_GAME_SNAPSHOTS_CAPTURED",
        "targetRoute": GENERAL_ROUTE,
        "rows": rows,
        "summary": {
            "canonicalGames": len(rows),
            "newCaptures": added,
            "duplicateCapturesReturnedExisting": duplicates,
            "distinctOfficialDates": len({str(r["officialDate"]) for r in rows}),
            "maximumC4LiveParityAbsoluteDifferenceThisRun": max_c4_diff,
        },
        "policy": {
            "researchOnly": True,
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "v68Changed": False,
            "productionChanged": False,
            "rankingChanged": False,
            "routingChanged": False,
            "stakingChanged": False,
            "betEliteAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, payload)
    print(json.dumps(payload["summary"], indent=2))


def candidate(row, market, side, route, priority):
    return {
        "officialDate": str(row["officialDate"]),
        "gamePk": int(row["gamePk"]),
        "market": market,
        "side": side,
        "route": route,
        "priority": int(priority),
        "consensusScore": float(row["consensusScore"]) if finite(row.get("consensusScore")) else None,
        "classifierScore": float(row["classifierScore"]),
        "p16Selected": float(row["p16Selected"]) if finite(row.get("p16Selected")) else None,
        "p68Selected": float(row["p68Selected"]) if finite(row.get("p68Selected")) else None,
    }


def sort_key(o):
    return (
        int(o["priority"]),
        -(float(o["consensusScore"]) if finite(o.get("consensusScore")) else -1.0),
        -(float(o["classifierScore"]) if finite(o.get("classifierScore")) else -1.0),
        int(o["gamePk"]),
    )


def materialize(args):
    c80 = load(args.contract)
    validate_contract(c80)
    cap = load(args.capture)
    if cap.get("schemaVersion") != CAPTURE_SCHEMA:
        raise SystemExit("V80_DAILY_CAPTURE_SCHEMA_INVALID")
    if cap.get("policy", {}).get("outcomesRead") is not False or cap.get("policy", {}).get("pricesRead") is not False:
        raise SystemExit("V80_DAILY_CAPTURE_BOUNDARY_INVALID")
    target = args.date
    if target < c80["prospectiveCohort"]["firstEligibleOfficialDate"]:
        raise SystemExit(f"V80_DAILY_PRE_FREEZE_DATE:{target}")
    rows = [r for r in cap.get("rows", []) if str(r["officialDate"]) == target]
    candidates = []
    by_game = {int(r["gamePk"]): r for r in rows}
    for r in rows:
        cls = r.get("frozenClassifier") or {}
        premium, aplus, f5 = bool(cls.get("premiumA")), bool(cls.get("aPlus")), bool(cls.get("f5Consensus"))
        p68 = float(r["p68Home"])
        d1 = float(r["bullpenPitches1dAdv"])
        if aplus and p68 >= 0.5:
            candidates.append(candidate(r, "FIRST_5_ML" if d1 > 0 else "FULL_GAME_ML", "HOME", "A_PLUS_V68_AGREE_D1_ROUTER", 0))
        if premium and p68 >= 0.5:
            candidates.append(candidate(r, "FIRST_5_ML" if f5 else "FULL_GAME_ML", "HOME", "PREMIUM_A_V68_AGREE_ROUTE_SWITCH", 1))
        if aplus:
            candidates.append(candidate(r, "FIRST_5_ML" if d1 > 0 else "FULL_GAME_ML", "HOME", "A_PLUS_D1_ROUTER", 2))
        if premium:
            candidates.append(candidate(r, "FIRST_5_ML" if f5 else "FULL_GAME_ML", "HOME", "PREMIUM_A_ROUTE_SWITCH", 3))
        if r.get("v16V68Agree") is True and finite(r.get("consensusScore")) and float(r["consensusScore"]) >= 0.55:
            candidates.append(candidate(r, "FULL_GAME_ML", str(r["selectedSide"]), GENERAL_ROUTE, 4))

    # Exact V69 dedupe_ledger: keep the highest-priority/tie-break route within each game.
    ledger = []
    groups = {}
    for o in candidates:
        groups.setdefault(int(o["gamePk"]), []).append(o)
    for gp in sorted(groups):
        ledger.append(sorted(groups[gp], key=sort_key)[0])
    # Exact V69 daily_cap(..., 1): same frozen key across games.
    selected = sorted(ledger, key=sort_key)[:1]
    top1 = selected[0] if selected else None
    general = None
    if top1 and top1["route"] == GENERAL_ROUTE:
        r = by_game[int(top1["gamePk"])]
        side = top1["side"]
        ss = r["homeStrength"] if side == "HOME" else r["awayStrength"]
        os_ = r["awayStrength"] if side == "HOME" else r["homeStrength"]
        general = {
            **top1,
            "selectedTeamId": int(r["homeTeamId"] if side == "HOME" else r["awayTeamId"]),
            "opponentTeamId": int(r["awayTeamId"] if side == "HOME" else r["homeTeamId"]),
            "selectedStrength": ss,
            "opponentStrength": os_,
            "strengthGap": float(os_["strengthScore"]) - float(ss["strengthScore"]),
            "tierRelation": relation(ss["primaryTier"], os_["primaryTier"]),
        }
    payload = {
        "schemaVersion": DAILY_SCHEMA,
        "scientificStatus": "V80_DAILY_PORTFOLIO_MATERIALIZED_WITHOUT_OUTCOMES",
        "officialDate": target,
        "parentPortfolio": "CONFLUENCE_LEDGER_TOP1_T0.550",
        "capturedEligibleGames": len(rows),
        "candidateRowsBeforeDedupe": len(candidates),
        "ledgerGamesAfterDedupe": len(ledger),
        "top1": top1,
        "generalTop1Decision": general,
        "generalTop1DecisionExists": general is not None,
        "captureDigest": canonical_digest(cap),
        "policy": {
            "outcomesRead": False,
            "pricesRead": False,
            "sameDateCompletedGameOutcomesUsed": False,
            "researchOnly": True,
            "v68Changed": False,
            "productionChanged": False,
            "rankingChanged": False,
            "routingChanged": False,
            "stakingChanged": False,
            "betEliteAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    if args.existing and os.path.exists(args.existing):
        old = load(args.existing)
        if canonical_digest(old) != canonical_digest(payload):
            raise SystemExit(f"V80_DAILY_FIRST_WRITE_IMMUTABLE_CONFLICT:{target}")
        print(json.dumps({"status": "EXISTING_IMMUTABLE_DAILY_TOP1_REUSED", "officialDate": target, "generalTop1DecisionExists": old.get("generalTop1DecisionExists")}, indent=2))
        if args.out != args.existing:
            dump(args.out, old)
        return
    dump(args.out, payload)
    print(json.dumps({"officialDate": target, "capturedEligibleGames": len(rows), "top1": top1, "generalTop1Decision": general}, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    c = sub.add_parser("capture")
    c.add_argument("--context", required=True)
    c.add_argument("--contract", required=True)
    c.add_argument("--v68-state", required=True)
    c.add_argument("--v68-source-script", required=True)
    c.add_argument("--v68-capture-script", required=True)
    c.add_argument("--v68-source-manifest", required=True)
    c.add_argument("--v62-contract", required=True)
    c.add_argument("--v68-contract", required=True)
    c.add_argument("--v16-manifest", required=True)
    c.add_argument("--existing")
    c.add_argument("--out", required=True)
    d = sub.add_parser("materialize")
    d.add_argument("--capture", required=True)
    d.add_argument("--contract", required=True)
    d.add_argument("--date", required=True)
    d.add_argument("--existing")
    d.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.mode == "capture":
        capture(a)
    else:
        materialize(a)


if __name__ == "__main__":
    main()
