#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone

SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-capture.v1"
V16_SCHEMA = "courtedge-p0-step12v16-pure-settlement-model-manifest.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-confirmation-contract.v1"
FORBIDDEN_FEATURE_TOKENS = (
    "outcome", "result", "winner", "home_win", "away_win",
    "odds", "price", "implied", "ev", "settlement", "final_runs",
)

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def dump(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False

def parse_dt(value):
    text = str(value or "").strip()
    if not text:
        raise SystemExit("V68_CAPTURE_TIMESTAMP_MISSING")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise SystemExit(f"V68_CAPTURE_TIMESTAMP_INVALID:{value}")
    if dt.tzinfo is None:
        raise SystemExit(f"V68_CAPTURE_TIMESTAMP_TZ_REQUIRED:{value}")
    return dt.astimezone(timezone.utc)

def valid_date(value):
    text = str(value or "")
    try:
        return datetime.strptime(text, "%Y-%m-%d").strftime("%Y-%m-%d") == text
    except ValueError:
        return False

def sigmoid(z):
    z = max(-50.0, min(50.0, float(z)))
    return 1.0 / (1.0 + math.exp(-z))

def score_binary(model, features):
    p = model["preprocessor"]
    names = list(p["features"])
    x = []
    for name, median, mean, scale in zip(names, p["medianImpute"], p["mean"], p["scale"]):
        raw = features.get(name)
        value = float(raw) if finite(raw) else float(median)
        s = float(scale)
        if not math.isfinite(s) or s <= 0:
            raise SystemExit(f"V68_CAPTURE_INVALID_FROZEN_SCALE:{name}:{s}")
        x.append((value - float(mean)) / s)
    z = float(model["intercept"]) + sum(float(c) * v for c, v in zip(model["coefficients"], x))
    c = model["calibration"]
    calibrated = sigmoid(float(c["slope"]) * z + float(c["intercept"]))
    return {
        "rawLogit": z,
        "homeWinProbability": calibrated,
        "awayWinProbability": 1.0 - calibrated,
    }

def validate_contract(contract):
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V68_CAPTURE_CONTRACT_SCHEMA_INVALID")
    if contract.get("scientificStatus") != "FROZEN_BEFORE_ANY_V68_PROSPECTIVE_CAPTURE_OR_OUTCOME_SCORER_EXISTS":
        raise SystemExit("V68_CAPTURE_CONTRACT_NOT_FROZEN")
    cand = contract["primaryCandidate"]
    if cand.get("featureCount") != 15 or len(cand.get("featuresExactly", [])) != 15:
        raise SystemExit("V68_CAPTURE_FEATURE_CONTRACT_INVALID")
    if cand.get("refitAllowed") or cand.get("recalibrationAllowed"):
        raise SystemExit("V68_CAPTURE_REFIT_BOUNDARY_INVALID")
    return tuple(cand["featuresExactly"])

def validate_v16(path, manifest, contract):
    if manifest.get("schemaVersion") != V16_SCHEMA:
        raise SystemExit("V68_CAPTURE_V16_SCHEMA_INVALID")
    expected = contract["parentEvidence"]["v16ManifestSha256"]
    actual = canonical_digest(manifest)
    if actual != expected:
        raise SystemExit(f"V68_CAPTURE_V16_MANIFEST_DIGEST_DRIFT:{actual}:{expected}")
    full = manifest.get("fullGame") or {}
    if tuple((full.get("preprocessor") or {}).get("features", [])) != tuple(contract["formalControl"]["featuresExactly"]):
        raise SystemExit("V68_CAPTURE_V16_FEATURE_DRIFT")
    return full

def load_records(path):
    with open(path, encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        return []
    if text.startswith("["):
        data = json.loads(text)
        return data if isinstance(data, list) else []
    if text.startswith("{"):
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return data["rows"]
        return [data]
    return [json.loads(line) for line in text.splitlines() if line.strip()]

def no_forbidden_feature_names(features):
    for name in features:
        low = str(name).lower()
        if any(token in low for token in FORBIDDEN_FEATURE_TOKENS):
            raise SystemExit(f"V68_CAPTURE_FORBIDDEN_FEATURE_NAME:{name}")

def validate_source_record(row, contract, feature_names):
    date = str(row.get("officialDate") or "")
    if not valid_date(date):
        raise SystemExit(f"V68_CAPTURE_DATE_INVALID:{date}")
    first = contract["prospectiveCohort"]["firstEligibleOfficialDate"]
    if date < first:
        raise SystemExit(f"V68_CAPTURE_PRE_FREEZE_GAME_FORBIDDEN:{date}:{first}")
    try:
        game_pk = int(row["gamePk"])
        home_id = int(row["homeTeamId"])
        away_id = int(row["awayTeamId"])
    except Exception:
        raise SystemExit("V68_CAPTURE_IDENTITY_INVALID")
    if min(game_pk, home_id, away_id) <= 0 or home_id == away_id:
        raise SystemExit(f"V68_CAPTURE_IDENTITY_INVALID:{game_pk}:{home_id}:{away_id}")
    start = parse_dt(row.get("startTime"))
    captured = parse_dt(row.get("capturedAt"))
    cutoff = parse_dt(row.get("sourceCutoffAt"))
    if captured >= start or cutoff >= start:
        raise SystemExit(f"V68_CAPTURE_NOT_STRICTLY_PREGAME:{game_pk}")
    if cutoff > captured:
        raise SystemExit(f"V68_CAPTURE_SOURCE_AFTER_CAPTURE:{game_pk}")
    if row.get("exactPregameLineupSemantics") is not True:
        raise SystemExit(f"V68_CAPTURE_LINEUP_SEMANTICS_NOT_EXACT:{game_pk}")
    if row.get("exactPregameProbableStarterSemantics") is not True:
        raise SystemExit(f"V68_CAPTURE_STARTER_SEMANTICS_NOT_EXACT:{game_pk}")
    if row.get("wholeOfficialDatePriorStateOnly") is not True:
        raise SystemExit(f"V68_CAPTURE_SAME_DATE_STATE_BOUNDARY_INVALID:{game_pk}")
    features = row.get("features")
    if not isinstance(features, dict):
        raise SystemExit(f"V68_CAPTURE_FEATURES_MISSING:{game_pk}")
    if set(features) != set(feature_names):
        missing = sorted(set(feature_names) - set(features))
        extra = sorted(set(features) - set(feature_names))
        raise SystemExit(f"V68_CAPTURE_FEATURE_SET_DRIFT:{game_pk}:missing={missing}:extra={extra}")
    no_forbidden_feature_names(features)
    clean_features = {name: (float(features[name]) if finite(features[name]) else None) for name in feature_names}
    return {
        "gamePk": game_pk,
        "officialDate": date,
        "homeTeamId": home_id,
        "awayTeamId": away_id,
        "startTime": str(row["startTime"]),
        "capturedAt": str(row["capturedAt"]),
        "sourceCutoffAt": str(row["sourceCutoffAt"]),
        "exactPregameLineupSemantics": True,
        "exactPregameProbableStarterSemantics": True,
        "wholeOfficialDatePriorStateOnly": True,
        "features": clean_features,
        "featureSource": str(row.get("featureSource") or "UNSPECIFIED_STRICT_V68_SOURCE"),
        "sourceEvidenceDigest": str(row.get("sourceEvidenceDigest") or ""),
    }

def existing_map(path):
    if not path:
        return {}
    payload = load(path)
    if payload.get("schemaVersion") != SCHEMA:
        raise SystemExit("V68_CAPTURE_EXISTING_SCHEMA_INVALID")
    out = {}
    for row in payload.get("rows", []):
        key = int(row["gamePk"])
        if key in out:
            raise SystemExit(f"V68_CAPTURE_EXISTING_DUPLICATE:{key}")
        out[key] = row
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--existing")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    contract = load(args.contract)
    feature_names = validate_contract(contract)
    v16_manifest = load(args.v16_manifest)
    v16_model = validate_v16(args.v16_manifest, v16_manifest, contract)
    v68_model = contract["primaryCandidate"]["modelSnapshot"]
    if tuple(v68_model["features"]) != feature_names:
        raise SystemExit("V68_CAPTURE_EMBEDDED_MODEL_FEATURE_DRIFT")

    old = existing_map(args.existing)
    incoming = load_records(args.input)
    if not incoming:
        raise SystemExit("V68_CAPTURE_NO_INPUT_ROWS")
    seen = set()
    added = 0
    duplicate_returns = 0
    for source in incoming:
        row = validate_source_record(source, contract, feature_names)
        gp = row["gamePk"]
        if gp in seen:
            raise SystemExit(f"V68_CAPTURE_DUPLICATE_INPUT_GAME:{gp}")
        seen.add(gp)
        if gp in old:
            existing = old[gp]
            if str(existing["officialDate"]) != row["officialDate"] or int(existing["homeTeamId"]) != row["homeTeamId"] or int(existing["awayTeamId"]) != row["awayTeamId"]:
                raise SystemExit(f"V68_CAPTURE_DUPLICATE_IDENTITY_CONFLICT:{gp}")
            duplicate_returns += 1
            continue

        v16_score = score_binary(v16_model, row["features"])
        v68_score = score_binary(v68_model, row["features"])
        source_record = {
            "gamePk": gp,
            "officialDate": row["officialDate"],
            "homeTeamId": row["homeTeamId"],
            "awayTeamId": row["awayTeamId"],
            "startTime": row["startTime"],
            "capturedAt": row["capturedAt"],
            "sourceCutoffAt": row["sourceCutoffAt"],
            "exactPregameLineupSemantics": True,
            "exactPregameProbableStarterSemantics": True,
            "wholeOfficialDatePriorStateOnly": True,
            "featureSource": row["featureSource"],
            "sourceEvidenceDigest": row["sourceEvidenceDigest"],
            "features": row["features"],
        }
        old[gp] = {
            "gamePk": gp,
            "officialDate": row["officialDate"],
            "homeTeamId": row["homeTeamId"],
            "awayTeamId": row["awayTeamId"],
            "startTime": row["startTime"],
            "capturedAt": row["capturedAt"],
            "sourceCutoffAt": row["sourceCutoffAt"],
            "featureSource": row["featureSource"],
            "sourceEvidenceDigest": row["sourceEvidenceDigest"],
            "featureDigest": canonical_digest(row["features"]),
            "canonicalSourceRecordDigest": canonical_digest(source_record),
            "v16": v16_score,
            "v68": v68_score,
            "containsOutcome": False,
            "containsMarketPrice": False,
            "canonicalFirstCaptureImmutable": True,
        }
        added += 1

    rows = sorted(old.values(), key=lambda r: (str(r["officialDate"]), int(r["gamePk"])))
    if len({int(r["gamePk"]) for r in rows}) != len(rows):
        raise SystemExit("V68_CAPTURE_OUTPUT_DUPLICATE_GAME")
    dates = sorted({str(r["officialDate"]) for r in rows})
    payload = {
        "schemaVersion": SCHEMA,
        "scientificStatus": "PROSPECTIVE_PREGAME_PROBABILITIES_CAPTURED_WITHOUT_OUTCOMES",
        "contractSha256": sha256_file(args.contract),
        "v16ManifestSha256": canonical_digest(v16_manifest),
        "candidateSnapshotDigest": canonical_digest(v68_model),
        "rows": rows,
        "summary": {
            "canonicalGames": len(rows),
            "distinctOfficialDates": len(dates),
            "firstOfficialDate": dates[0] if dates else None,
            "lastOfficialDate": dates[-1] if dates else None,
            "newCaptures": added,
            "duplicateCapturesReturnedExisting": duplicate_returns,
        },
        "policy": {
            "researchOnly": True,
            "outcomesRead": False,
            "pricesRead": False,
            "oddsUsedAsFeatures": False,
            "refitPerformed": False,
            "recalibrationPerformed": False,
            "productionV16Changed": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(args.out, payload)
    print(json.dumps(payload["summary"], indent=2))

if __name__ == "__main__":
    main()
