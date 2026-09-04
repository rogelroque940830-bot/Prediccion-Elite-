#!/usr/bin/env python3
"""MLB Unified Sporting Authority R1B — feature-only pregame materializer.

This utility deliberately accepts only already-normalized, pregame-custodied feature
packs. It never reads outcomes or prices and creates no weights, score, thresholds,
or winner recommendation.
"""
import argparse
import hashlib
import json
from pathlib import Path

SCHEMA = "courtedge-mlb-unified-sporting-authority-r1b-pregame.v1"
FAMILIES = (
    "V16_BASELINE",
    "FROZEN_ROUTE_EVIDENCE",
    "STATCAST_QUALITY",
    "DISCIPLINE_SPEED",
    "SOS",
    "ADVANCED_CONTEXT",
    "BULLPEN_FULL_GAME",
    "HAND_SPLIT_SLG_MATCHUP",
    "PITCHMIX_MATCHUP",
)
OUTCOME_TOKENS = ("outcome", "result", "winner", "finalscore", "final_score", "settled", "settlement", "homewin", "target", "hit")
PRICE_TOKENS = ("price", "odds", "impliedprobability", "implied_probability", "bookmaker", "marketprice", "market_price")
IDENTITY = ("officialDate", "gamePk", "side", "market", "horizon")


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def scan_forbidden(value, path="$"):
    findings = []
    if isinstance(value, dict):
        for key, child in value.items():
            low = str(key).lower().replace("-", "")
            # 'market' is a canonical sporting identity and is intentionally allowed.
            if any(token in low for token in OUTCOME_TOKENS):
                findings.append((path + "." + str(key), "OUTCOME"))
            if str(key) != "market" and any(token in low for token in PRICE_TOKENS):
                findings.append((path + "." + str(key), "PRICE"))
            findings.extend(scan_forbidden(child, path + "." + str(key)))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            findings.extend(scan_forbidden(child, f"{path}[{i}]"))
    return findings


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            bad = scan_forbidden(row)
            if bad:
                raise SystemExit(f"R1B_FORBIDDEN_FIELD:{path}:{line_no}:{bad[0][1]}:{bad[0][0]}")
            rows.append(row)
    return rows


def key(row):
    missing = [field for field in IDENTITY if field not in row]
    if missing:
        raise SystemExit(f"R1B_IDENTITY_MISSING:{','.join(missing)}")
    return tuple(row[field] for field in IDENTITY)


def validate_family_payload(family, payload, horizon):
    required = ("eligible", "values", "sourceVersion", "sourceTimestampOrPriorWindow", "inputStage", "missingnessReason")
    if not isinstance(payload, dict) or any(field not in payload for field in required):
        raise SystemExit(f"R1B_CUSTODY_FIELDS_MISSING:{family}")
    if payload["eligible"] is False and payload["missingnessReason"] in (None, ""):
        raise SystemExit(f"R1B_MISSINGNESS_REASON_REQUIRED:{family}")
    if family == "BULLPEN_FULL_GAME" and str(horizon).upper() not in ("FG", "FULL_GAME"):
        if payload["eligible"] is not False or payload["missingnessReason"] != "NOT_APPLICABLE_EARLY_HORIZON":
            raise SystemExit("R1B_BULLPEN_HORIZON_LEAKAGE")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", action="append", nargs=2, metavar=("NAME", "JSONL"), required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--sha-out", required=True)
    args = parser.parse_args()

    supplied = {name: path for name, path in args.family}
    if set(supplied) != set(FAMILIES):
        missing = sorted(set(FAMILIES) - set(supplied))
        extra = sorted(set(supplied) - set(FAMILIES))
        raise SystemExit(f"R1B_REQUIRED_SOURCE_FAMILY_DRIFT:missing={missing}:extra={extra}")

    by_family = {}
    universe = set()
    for family in FAMILIES:
        rows = read_jsonl(supplied[family])
        index = {}
        for row in rows:
            k = key(row)
            if k in index:
                raise SystemExit(f"R1B_DUPLICATE_IDENTITY:{family}:{k}")
            payload = row.get("feature")
            validate_family_payload(family, payload, row["horizon"])
            index[k] = payload
            universe.add(k)
        by_family[family] = index

    output_rows = []
    coverage = {family: {"present": 0, "eligible": 0, "missing": 0} for family in FAMILIES}
    for k in sorted(universe, key=lambda x: (str(x[0]), int(x[1]), str(x[2]), str(x[3]), str(x[4]))):
        identity = dict(zip(IDENTITY, k))
        features = {}
        for family in FAMILIES:
            payload = by_family[family].get(k)
            if payload is None:
                # Missing rows are never converted to numerical zero.
                payload = {
                    "eligible": False,
                    "values": None,
                    "sourceVersion": None,
                    "sourceTimestampOrPriorWindow": None,
                    "inputStage": "PREGAME",
                    "missingnessReason": "SOURCE_ROW_ABSENT",
                }
            validate_family_payload(family, payload, identity["horizon"])
            coverage[family]["present"] += int(k in by_family[family])
            coverage[family]["eligible"] += int(payload["eligible"] is True)
            coverage[family]["missing"] += int(payload["eligible"] is not True)
            features[family] = payload
        row = {**identity, "schemaVersion": SCHEMA, "features": features}
        bad = scan_forbidden(row)
        if bad:
            raise SystemExit(f"R1B_INTERNAL_FORBIDDEN_FIELD:{bad[0]}")
        output_rows.append(row)

    if len({key(row) for row in output_rows}) != len(output_rows):
        raise SystemExit("R1B_OUTPUT_DUPLICATE_IDENTITY")

    encoded = "".join(canonical(row) + "\n" for row in output_rows).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(encoded)
    Path(args.sha_out).write_text(digest + "\n", encoding="utf-8")
    manifest = {
        "schemaVersion": "courtedge-mlb-unified-sporting-authority-r1b-manifest.v1",
        "classification": "R1B_FEATURE_ONLY_PREGAME_ROWSET_FROZEN",
        "rows": len(output_rows),
        "dateRange": [str(output_rows[0]["officialDate"]), str(output_rows[-1]["officialDate"])] if output_rows else [None, None],
        "duplicateCount": 0,
        "forbiddenOutcomeFields": 0,
        "forbiddenPriceFields": 0,
        "sha256": digest,
        "coverage": coverage,
        "policy": {
            "outcomesRead": False,
            "marketPricesRead": False,
            "weightsCreated": False,
            "thresholdSearch": False,
            "productionChanged": False,
        },
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
