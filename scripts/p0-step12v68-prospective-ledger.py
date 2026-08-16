#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone

AUDIT_SCHEMA = "courtedge-p0-step12h-t5-starter-identity-audit.v1"
PITCH_SCHEMA = "courtedge-p0-step12v62-pitch-quality-pbp.v1"
STATE_SCHEMA = "courtedge-p0-step12v68-prospective-state.v1"
SOURCE_SCHEMA = "courtedge-p0-step12v68-prospective-source-input.v1"
LEDGER_SCHEMA = "courtedge-p0-step12v68-prospective-ledger.v1"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def merge_unique(existing, incoming, key_fn, label):
    out = {}
    for row in existing:
        key = key_fn(row)
        if key in out:
            raise SystemExit(f"V68_LEDGER_EXISTING_DUPLICATE:{label}:{key}")
        out[key] = row
    added = 0
    duplicates = 0
    for row in incoming:
        key = key_fn(row)
        if key in out:
            if digest(out[key]) != digest(row):
                raise SystemExit(f"V68_LEDGER_IMMUTABLE_CONFLICT:{label}:{key}")
            duplicates += 1
            continue
        out[key] = row
        added += 1
    rows = list(out.values())
    rows.sort(key=lambda r: (str(r.get("officialDate", "")), int(r.get("gamePk", 0))))
    return rows, added, duplicates


def dates(rows):
    values = sorted({str(r.get("officialDate")) for r in rows if r.get("officialDate")})
    return {
        "firstOfficialDate": values[0] if values else None,
        "lastOfficialDate": values[-1] if values else None,
        "distinctOfficialDates": len(values),
    }


def merge_gap(args):
    daily_official = load(os.path.join(args.daily_root, "official-acquisition.json"))
    daily_starter = load(os.path.join(args.daily_root, "starting-pitcher-history.json"))
    daily_lineup = load(os.path.join(args.daily_root, "pregame-lineup-history.json"))
    daily_audit = load(os.path.join(args.daily_root, "t5-starter-identity-audit.json"))
    daily_pitch = load(args.daily_pitch)
    if daily_audit.get("schemaVersion") != AUDIT_SCHEMA:
        raise SystemExit("V68_LEDGER_DAILY_AUDIT_SCHEMA_INVALID")
    if daily_pitch.get("schemaVersion") != PITCH_SCHEMA:
        raise SystemExit("V68_LEDGER_DAILY_PITCH_SCHEMA_INVALID")

    os.makedirs(args.ledger_root, exist_ok=True)
    paths = {
        "official": os.path.join(args.ledger_root, "official-acquisition.json"),
        "starter": os.path.join(args.ledger_root, "starting-pitcher-history.json"),
        "lineup": os.path.join(args.ledger_root, "pregame-lineup-history.json"),
        "audit": os.path.join(args.ledger_root, "t5-starter-identity-audit.json"),
        "pitch": os.path.join(args.ledger_root, "pitch-quality-gap.json"),
        "manifest": os.path.join(args.ledger_root, "ledger-manifest.json"),
    }

    prior_official = load(paths["official"]).get("games", []) if os.path.exists(paths["official"]) else []
    prior_starter = load(paths["starter"]).get("games", []) if os.path.exists(paths["starter"]) else []
    prior_lineup = load(paths["lineup"]).get("snapshots", []) if os.path.exists(paths["lineup"]) else []
    prior_audit = load(paths["audit"]).get("rows", []) if os.path.exists(paths["audit"]) else []
    prior_pitch = load(paths["pitch"]).get("games", []) if os.path.exists(paths["pitch"]) else []

    official, add_official, dup_official = merge_unique(prior_official, daily_official.get("games", []), lambda r: int(r["gamePk"]), "OFFICIAL")
    starter, add_starter, dup_starter = merge_unique(prior_starter, daily_starter.get("games", []), lambda r: int(r["gamePk"]), "STARTER")
    lineup, add_lineup, dup_lineup = merge_unique(prior_lineup, daily_lineup.get("snapshots", []), lambda r: int(r["gamePk"]), "LINEUP")
    audit, add_audit, dup_audit = merge_unique(prior_audit, daily_audit.get("rows", []), lambda r: int(r["gamePk"]), "AUDIT")
    pitch, add_pitch, dup_pitch = merge_unique(prior_pitch, daily_pitch.get("games", []), lambda r: int(r["gamePk"]), "PITCH")

    pks = {
        "official": {int(r["gamePk"]) for r in official},
        "starter": {int(r["gamePk"]) for r in starter},
        "lineup": {int(r["gamePk"]) for r in lineup},
        "audit": {int(r["gamePk"]) for r in audit},
    }
    if not (pks["official"] == pks["starter"] == pks["lineup"] == pks["audit"]):
        raise SystemExit("V68_LEDGER_GAP_IDENTITY_SET_MISMATCH")
    canonical = {
        int(r["gamePk"])
        for r in audit
        if r.get("identityOk") and r.get("sourceHistorical") and r.get("pregame") and r.get("lineupComplete")
    }
    pitch_pks = {int(r["gamePk"]) for r in pitch}
    if not pitch_pks.issubset(canonical):
        extra = sorted(pitch_pks - canonical)[:10]
        raise SystemExit(f"V68_LEDGER_PITCH_NOT_CANONICAL:{extra}")

    generated = datetime.now(timezone.utc).isoformat()
    common = {"schemaVersion": LEDGER_SCHEMA, "generatedAt": generated, **dates(official), "researchOnly": True}
    dump(paths["official"], {**common, "kind": "OFFICIAL_FINAL_HISTORY", "games": official, "failures": []})
    dump(paths["starter"], {**common, "kind": "STARTING_PITCHER_HISTORY", "games": starter, "failures": []})
    dump(paths["lineup"], {
        **common,
        "kind": "PREGAME_T5_LINEUP_HISTORY",
        "sourceVersion": "statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4",
        "cutoffSecondsBeforeScheduledStart": 300,
        "snapshots": lineup,
    })
    dump(paths["audit"], {
        "schemaVersion": AUDIT_SCHEMA,
        "evidenceStatus": "V68_CUMULATIVE_PROSPECTIVE_HISTORY_ADAPTER_ONLY",
        "generatedAt": generated,
        "counts": {
            "snapshots": len(audit),
            "canonicalT5EquivalentGames": len(canonical),
            "probableBothKnown": sum(bool(r.get("probableBothKnown")) for r in audit),
        },
        "rows": audit,
        "policy": {"researchOnly": True, "currentMetadataFallbackAllowed": False, "sameDateHistoryAllowed": False},
    })
    dump(paths["pitch"], {
        "schemaVersion": PITCH_SCHEMA,
        "season": "2026_V68_CUMULATIVE_GAP",
        "warmupOnly": False,
        "generatedAt": generated,
        "gamesExpected": len(canonical),
        "gamesFetched": len(pitch),
        "games": pitch,
        "policy": {"researchOnly": True, "sameDateOutcomeMayTrainSameDate": False, "futureGameDataAllowed": False},
    })
    manifest = {
        "schemaVersion": LEDGER_SCHEMA,
        "kind": "V68_CUMULATIVE_GAP_LEDGER",
        "generatedAt": generated,
        "officialGames": len(official),
        "canonicalT5EquivalentGames": len(canonical),
        "pitchQualityGames": len(pitch),
        **dates(official),
        "lastMerge": {
            "officialAdded": add_official,
            "starterAdded": add_starter,
            "lineupAdded": add_lineup,
            "auditAdded": add_audit,
            "pitchAdded": add_pitch,
            "duplicates": {
                "official": dup_official,
                "starter": dup_starter,
                "lineup": dup_lineup,
                "audit": dup_audit,
                "pitch": dup_pitch,
            },
        },
        "policy": {"researchOnly": True, "outcomesUsedOnlyAsStrictlyPriorDateHistory": True, "marketPricesUsed": False, "realFinancialExposure": 0},
    }
    dump(paths["manifest"], manifest)
    print(json.dumps(manifest, indent=2))


def install_state(args):
    state = load(args.input)
    if state.get("schemaVersion") != STATE_SCHEMA:
        raise SystemExit("V68_LEDGER_STATE_SCHEMA_INVALID")
    if str(state.get("targetOfficialDate")) != args.date:
        raise SystemExit("V68_LEDGER_STATE_DATE_MISMATCH")
    chronology = state.get("chronology") or {}
    if chronology.get("historyStrictlyBeforeTargetDate") is not True or chronology.get("sameDateOutcomesUsed") is not False:
        raise SystemExit("V68_LEDGER_STATE_CHRONOLOGY_INVALID")
    out = os.path.join(args.ledger_root, "states", f"{args.date}.json")
    if os.path.exists(out):
        existing = load(out)
        if existing.get("schemaVersion") != STATE_SCHEMA or str(existing.get("targetOfficialDate")) != args.date:
            raise SystemExit("V68_LEDGER_EXISTING_STATE_INVALID")
        print(json.dumps({"status": "EXISTING_IMMUTABLE_STATE_REUSED", "path": out, "stateDigest": existing.get("stateDigest")}, indent=2))
        return
    os.makedirs(os.path.dirname(out), exist_ok=True)
    shutil.copyfile(args.input, out)
    print(json.dumps({"status": "FIRST_IMMUTABLE_STATE_INSTALLED", "path": out, "stateDigest": state.get("stateDigest")}, indent=2))


def install_sources(args):
    payload = load(args.input)
    if payload.get("schemaVersion") != SOURCE_SCHEMA:
        raise SystemExit("V68_LEDGER_SOURCE_SCHEMA_INVALID")
    installed = 0
    duplicates = 0
    for row in payload.get("rows", []):
        gp = int(row["gamePk"])
        date = str(row["officialDate"])
        out = os.path.join(args.ledger_root, "source-records", date, f"{gp}.json")
        if os.path.exists(out):
            existing = load(out)
            if digest(existing) != digest(row):
                # First pregame source record is immutable. A later poll is not allowed to replace it.
                duplicates += 1
                continue
            duplicates += 1
            continue
        dump(out, row)
        installed += 1
    print(json.dumps({"installed": installed, "duplicatesPreservedFirst": duplicates}, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    m = sub.add_parser("merge-gap")
    m.add_argument("--daily-root", required=True)
    m.add_argument("--daily-pitch", required=True)
    m.add_argument("--ledger-root", required=True)
    s = sub.add_parser("install-state")
    s.add_argument("--input", required=True)
    s.add_argument("--ledger-root", required=True)
    s.add_argument("--date", required=True)
    r = sub.add_parser("install-sources")
    r.add_argument("--input", required=True)
    r.add_argument("--ledger-root", required=True)
    args = ap.parse_args()
    if args.mode == "merge-gap":
        merge_gap(args)
    elif args.mode == "install-state":
        install_state(args)
    else:
        install_sources(args)


if __name__ == "__main__":
    main()
