#!/usr/bin/env python3
import argparse, gzip, hashlib, importlib.util, json, math, os
from collections import defaultdict, deque
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

CONTRACT_SCHEMA = "courtedge-p0-step12v66-game-horizon-exposure-suite-contract.v1"
OUT_SCHEMA = "courtedge-p0-step12v66-game-horizon-exposure-custody.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
V62_PACK_SCHEMA = "courtedge-p0-step12v62-pitch-quality-pbp.v1"
V14_PACK_SCHEMA = "courtedge-p0-step12v14-game-bullpen-summary.v1"
V66_BP_PACK_SCHEMA = "courtedge-p0-step12v66-bullpen-source.v1"
SEASONS = ("2022", "2023", "2024", "2025", "2026_YTD")
EXPECTED_ROWS = {"2022": 2398, "2023": 2399, "2024": 2406, "2025": 2423, "2026_YTD": 1781}
QUALITY_NAMES = (
    "starter_velocity_adv",
    "starter_spin_adv",
    "starter_swing_miss_adv",
    "starter_in_zone_adv",
    "starter_weak_contact_adv",
)
QUALITY_KEYS = ("velocity", "spin", "whiff", "strike", "hard")
BP_NAMES = ("bullpen_pitches_1d", "bullpen_pitches_3d", "bullpen_core3_pitches_2d", "bullpen_b2b_arms")
CONTROL4 = ("lineup_exposure_rate_adv", "starter_kbb_adv", "combined_team_rs10", "team_rd10_diff")
FORBIDDEN_OUTPUT_TOKENS = ("outcome", "homeruns", "awayruns", "final_", "winner", "homewin", "target", "settlement", "result")

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def dump(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False

def fval(v):
    return float(v) if finite(v) else None

def clip01(x):
    if not finite(x):
        return None
    return max(0.0, min(1.0, float(x)))

def mean2(a, b):
    return None if not finite(a) or not finite(b) else (float(a) + float(b)) / 2.0

def sum2(a, b):
    return None if not finite(a) or not finite(b) else float(a) + float(b)

def mul(a, b):
    return None if not finite(a) or not finite(b) else float(a) * float(b)

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def target_rows(control_root):
    out = {}
    for s in SEASONS:
        p = os.path.join(control_root, s, "game-anatomy-feature-table.json")
        t = load(p)
        if t.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"V66_CONTROL_SCHEMA_INVALID:{s}")
        rows = [r for r in t.get("rows", []) if r.get("t5PregameValid") is True]
        if len(rows) != EXPECTED_ROWS[s]:
            raise SystemExit(f"V66_TARGET_ROW_COUNT_DRIFT:{s}:{len(rows)}:{EXPECTED_ROWS[s]}")
        seen = set()
        for r in rows:
            pk = int(r["gamePk"])
            if pk in seen:
                raise SystemExit(f"V66_DUPLICATE_TARGET_GAME:{s}:{pk}")
            seen.add(pk)
        out[s] = rows
    return out

def build_expected_outs(step12v3_root, c39, v39):
    all_rows = []
    by_season = {}
    for s in SEASONS:
        rows, diag = v39.build(step12v3_root, s, c39)
        by_season[s] = diag
        all_rows.extend(rows)
    df = pd.DataFrame(all_rows)
    feats = tuple(c39["features"]["exactly"])
    tr = df[df.season == "2022"].copy()
    imp = SimpleImputer(strategy="median")
    sc = StandardScaler()
    X = sc.fit_transform(imp.fit_transform(tr[list(feats)]))
    y = tr.outsRecorded.to_numpy(float)
    cfg = c39["model"]
    model = PoissonRegressor(alpha=float(cfg["poissonAlpha"]), max_iter=int(cfg["maxIter"]))
    model.fit(X, y)
    pred = {}
    for s in SEASONS:
        d = df[df.season == s].copy()
        if len(d) == 0:
            continue
        mu = np.maximum(model.predict(sc.transform(imp.transform(d[list(feats)]))), 1e-9)
        for (_, r), m in zip(d.iterrows(), mu):
            pred[(s, int(r["gamePk"]), str(r["side"]))] = float(m)
    manifest = {
        "source": "FROZEN_V39_POISSON_MODEL_RECONSTRUCTION",
        "features": list(feats),
        "alpha": float(cfg["poissonAlpha"]),
        "maxIter": int(cfg["maxIter"]),
        "fitSeason": "2022",
        "intercept": float(model.intercept_),
        "coefficients": [float(x) for x in model.coef_],
        "medianImpute": [float(x) for x in imp.statistics_],
        "mean": [float(x) for x in sc.mean_],
        "scale": [float(x) for x in sc.scale_],
        "slotsWithPredictionBySeason": {s: sum(1 for k in pred if k[0] == s) for s in SEASONS},
        "sourceCustodyBySeason": by_season,
    }
    return pred, manifest

def load_hands(hands_root):
    out = {}
    for s in SEASONS:
        p = load(os.path.join(hands_root, f"pregame-hands-{s}.json"))
        out[s] = {int(x["gamePk"]): x for x in p.get("snapshots", [])}
    return out

def build_quality_raw(rows_by_season, pitch_root, hands_root, c62, v62):
    hands = load_hands(hands_root)
    events = defaultdict(list)
    for s in ("2021", *SEASONS):
        p = load(os.path.join(pitch_root, f"pitch-quality-{s}.json"))
        if p.get("schemaVersion") != V62_PACK_SCHEMA:
            raise SystemExit(f"V66_V62_PACK_SCHEMA_INVALID:{s}")
        for item in v62.make_game_maps(p):
            events[item[0]].append(item)
    bydate = {s: defaultdict(list) for s in SEASONS}
    for s in SEASONS:
        for r in rows_by_season[s]:
            bydate[s][str(r["officialDate"])].append(r)
    ph = defaultdict(deque)
    lph = deque()
    raw = {}
    diag = {s: {"rows": len(rows_by_season[s]), "starterIdentityUsable": 0, "bothQualityAvailable": 0} for s in SEASONS}
    for ds in sorted(events):
        d = date.fromisoformat(ds)
        for s in SEASONS:
            for r in bydate[s].get(ds, []):
                pk = int(r["gamePk"])
                hs = hands[s].get(pk) or {}
                usable = hs.get("usable") is True
                hp = int(hs.get("homePitcherId") or 0) if usable else 0
                ap = int(hs.get("awayPitcherId") or 0) if usable else 0
                if usable:
                    diag[s]["starterIdentityUsable"] += 1
                hq, hd = v62.starter_quality(hp, d, ph, lph, c62)
                aq, ad = v62.starter_quality(ap, d, ph, lph, c62)
                if hq is not None and aq is not None:
                    diag[s]["bothQualityAvailable"] += 1
                raw[(s, pk)] = {
                    "home": hq,
                    "away": aq,
                    "homeStarterId": hp or None,
                    "awayStarterId": ap or None,
                    "homePriorRecognizedPitches": hd.get("starterPriorRecognizedPitches"),
                    "awayPriorRecognizedPitches": ad.get("starterPriorRecognizedPitches"),
                }
        for _, _, pm, _, lp, _ in events[ds]:
            for pid, m in pm.items():
                ph[pid].append((d, m))
            lph.append((d, lp))
    for s in SEASONS:
        n = max(1, diag[s]["rows"])
        diag[s]["starterIdentityUsableShare"] = diag[s]["starterIdentityUsable"] / n
        diag[s]["bothQualityAvailableShare"] = diag[s]["bothQualityAvailable"] / n
    return raw, diag

def quality_scaler(raw):
    vals = {k: [] for k in QUALITY_KEYS}
    for (s, _), q in raw.items():
        if s != "2022":
            continue
        for side in ("home", "away"):
            z = q.get(side)
            if z is None:
                continue
            for k in QUALITY_KEYS:
                if finite(z.get(k)):
                    vals[k].append(float(z[k]))
    params = {}
    for k in QUALITY_KEYS:
        a = np.asarray(vals[k], dtype=float)
        if len(a) == 0:
            raise SystemExit(f"V66_QUALITY_TRAINING_EMPTY:{k}")
        mean = float(np.mean(a))
        scale = float(np.std(a))
        if not finite(scale) or scale <= 0:
            raise SystemExit(f"V66_QUALITY_TRAINING_SCALE_INVALID:{k}:{scale}")
        params[k] = {"mean": mean, "scale": scale, "n": int(len(a))}
    return params

def quality_scalar(q, params):
    if q is None:
        return None
    z = []
    for k in QUALITY_KEYS:
        if not finite(q.get(k)):
            return None
        z.append((float(q[k]) - params[k]["mean"]) / params[k]["scale"])
    return float(np.mean(z))

def load_bullpen_history(bullpen_dir):
    hist = defaultdict(list)
    pack_diag = {}
    for s in SEASONS:
        p = load(os.path.join(bullpen_dir, f"bullpen-{s}.json"))
        if p.get("schemaVersion") not in (V14_PACK_SCHEMA, V66_BP_PACK_SCHEMA):
            raise SystemExit(f"V66_BULLPEN_PACK_SCHEMA_INVALID:{s}:{p.get('schemaVersion')}")
        pack_diag[s] = {k: p.get(k) for k in ("schemaVersion", "gamesExpected", "gamesFetched", "identityCompleteGames", "identityCompleteShare")}
        for g in p.get("games", []):
            if not g.get("identityComplete"):
                continue
            d = date.fromisoformat(str(g["officialDate"]))
            for side in ("home", "away"):
                r = g[side]
                rel = {int(x["pitcherId"]): int(x["pitches"]) for x in r.get("relievers", [])}
                hist[int(r["teamId"])].append({
                    "date": d,
                    "gamePk": int(g["gamePk"]),
                    "bullpenPitches": int(r["bullpenPitches"]),
                    "relievers": rel,
                })
    for v in hist.values():
        v.sort(key=lambda x: (x["date"], x["gamePk"]))
    return hist, pack_diag

def bullpen_profile(hist, tid, target):
    rows = [r for r in hist.get(int(tid), []) if target - timedelta(days=30) <= r["date"] < target]
    pool = defaultdict(int)
    for r in rows:
        for pid, p in r["relievers"].items():
            pool[pid] += p
    core = [pid for pid, _ in sorted(pool.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
    d1, d2, d3 = target - timedelta(days=1), target - timedelta(days=2), target - timedelta(days=3)
    p1 = sum(r["bullpenPitches"] for r in rows if r["date"] == d1)
    p3 = sum(r["bullpenPitches"] for r in rows if d3 <= r["date"] < target)
    core2 = sum(p for r in rows if target - timedelta(days=2) <= r["date"] < target for pid, p in r["relievers"].items() if pid in core)
    ids1 = {pid for r in rows if r["date"] == d1 for pid in r["relievers"]}
    ids2 = {pid for r in rows if r["date"] == d2 for pid in r["relievers"]}
    return {
        "bullpen_pitches_1d": float(p1),
        "bullpen_pitches_3d": float(p3),
        "bullpen_core3_pitches_2d": float(core2),
        "bullpen_b2b_arms": float(len(ids1 & ids2)),
        "priorGames30d": len(rows),
        "relieverPool": len(pool),
    }

def record_for_game(s, r, expected, qraw, qparams, hist):
    pk = int(r["gamePk"])
    f = r.get("features") or {}
    rec = {
        "schemaVersion": OUT_SCHEMA,
        "season": s,
        "officialDate": str(r["officialDate"]),
        "gamePk": pk,
        "homeTeamId": int(r["homeTeamId"]),
        "awayTeamId": int(r["awayTeamId"]),
    }
    for name in CONTROL4:
        rec[name] = fval(f.get(name))
    rec["combined_team_ra10"] = fval(f.get("combined_team_ra10"))
    hmu = expected.get((s, pk, "home"))
    amu = expected.get((s, pk, "away"))
    rec["home_expected_starter_outs"] = fval(hmu)
    rec["away_expected_starter_outs"] = fval(amu)
    for horizon, denom in (("f3", 9.0), ("f5", 15.0), ("fg", 27.0)):
        hs = clip01(None if hmu is None else hmu / denom)
        aws = clip01(None if amu is None else amu / denom)
        rec[f"home_{horizon}_starter_share"] = hs
        rec[f"away_{horizon}_starter_share"] = aws
        rec[f"mean_{horizon}_starter_share"] = mean2(hs, aws)
        rec[f"min_{horizon}_starter_share"] = min(hs, aws) if finite(hs) and finite(aws) else None
        rec[f"{horizon}_exposure_adv"] = None if not finite(hs) or not finite(aws) else float(hs) - float(aws)
        if horizon in ("f5", "fg"):
            rec[f"home_{horizon}_expected_bullpen_share"] = None if hs is None else 1.0 - hs
            rec[f"away_{horizon}_expected_bullpen_share"] = None if aws is None else 1.0 - aws
            rec[f"combined_{horizon}_expected_bullpen_share"] = sum2(rec[f"home_{horizon}_expected_bullpen_share"], rec[f"away_{horizon}_expected_bullpen_share"])
    q = qraw.get((s, pk)) or {}
    hq, aq = q.get("home"), q.get("away")
    for name, key in zip(QUALITY_NAMES, QUALITY_KEYS):
        rec[name] = None if hq is None or aq is None else float(hq[key]) - float(aq[key])
    hqs, aqs = quality_scalar(hq, qparams), quality_scalar(aq, qparams)
    rec["home_starter_quality_index_z5"] = hqs
    rec["away_starter_quality_index_z5"] = aqs
    for horizon in ("f3", "f5", "fg"):
        mshare = rec[f"mean_{horizon}_starter_share"]
        for name in QUALITY_NAMES:
            rec[f"{name}_x_{horizon}_mean_starter_share"] = mul(rec[name], mshare)
        rec[f"quality_weighted_combined_{horizon}_starter_share"] = sum2(mul(hqs, rec[f"home_{horizon}_starter_share"]), mul(aqs, rec[f"away_{horizon}_starter_share"]))
    target = date.fromisoformat(str(r["officialDate"]))
    hp = bullpen_profile(hist, int(r["homeTeamId"]), target)
    ap = bullpen_profile(hist, int(r["awayTeamId"]), target)
    rec["home_bullpen_prior_games_30d"] = hp["priorGames30d"]
    rec["away_bullpen_prior_games_30d"] = ap["priorGames30d"]
    rec["home_bullpen_reliever_pool_30d"] = hp["relieverPool"]
    rec["away_bullpen_reliever_pool_30d"] = ap["relieverPool"]
    for name in BP_NAMES:
        rec[f"home_{name}"] = hp[name]
        rec[f"away_{name}"] = ap[name]
        adv = float(ap[name]) - float(hp[name])
        rec[f"{name}_adv"] = adv
        for horizon in ("f5", "fg"):
            bp_mean = mean2(rec[f"home_{horizon}_expected_bullpen_share"], rec[f"away_{horizon}_expected_bullpen_share"])
            rec[f"{name}_adv_weighted_{horizon}"] = mul(adv, bp_mean)
            rec[f"{name}_combined_weighted_{horizon}"] = mul(float(hp[name]) + float(ap[name]), bp_mean)
    return rec

def required_columns():
    cols = {
        "season", "officialDate", "gamePk", *CONTROL4, "combined_team_ra10", *QUALITY_NAMES,
        "home_expected_starter_outs", "away_expected_starter_outs", "f3_exposure_adv", "f5_exposure_adv", "fg_exposure_adv",
        "mean_f5_starter_share", "min_f5_starter_share", "combined_f5_expected_bullpen_share", "quality_weighted_combined_f5_starter_share",
        "mean_fg_starter_share", "min_fg_starter_share", "combined_fg_expected_bullpen_share", "quality_weighted_combined_fg_starter_share",
    }
    for h in ("f3", "f5", "fg"):
        cols.update(f"{q}_x_{h}_mean_starter_share" for q in QUALITY_NAMES)
    for b in BP_NAMES:
        cols.update((f"{b}_adv_weighted_f5", f"{b}_adv_weighted_fg", f"{b}_combined_weighted_f5", f"{b}_combined_weighted_fg"))
    return cols

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--control-root", required=True)
    ap.add_argument("--step12v3-root", required=True)
    ap.add_argument("--hands-root", required=True)
    ap.add_argument("--pitch-root", required=True)
    ap.add_argument("--bullpen-dir", required=True)
    ap.add_argument("--v39-contract", required=True)
    ap.add_argument("--v62-contract", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or int(c.get("contractRevision", 0)) != 2:
        raise SystemExit("V66_CONTRACT_INVALID")
    if c.get("scientificStatus") != "FROZEN_BEFORE_ANY_V66_OUTCOME_SCORER_EXISTS":
        raise SystemExit("V66_CONTRACT_NOT_PREOUTCOME_FROZEN")
    if tuple(c["starterQuality"]["featuresExactly"]) != QUALITY_NAMES:
        raise SystemExit("V66_QUALITY_NAME_DRIFT")
    v39 = module("scripts/p0-step12v39-pitcher-outs-baseline.py", "v39f")
    v62 = module("scripts/p0-step12v62-pitch-quality-winner.py", "v62f")
    c39, c62 = load(a.v39_contract), load(a.v62_contract)
    rows = target_rows(a.control_root)
    expected, v39_manifest = build_expected_outs(a.step12v3_root, c39, v39)
    qraw, qdiag = build_quality_raw(rows, a.pitch_root, a.hands_root, c62, v62)
    qparams = quality_scaler(qraw)
    hist, bpdiag = load_bullpen_history(a.bullpen_dir)
    records = []
    for s in SEASONS:
        for r in rows[s]:
            records.append(record_for_game(s, r, expected, qraw, qparams, hist))
    bad = sorted(k for k in records[0].keys() if any(tok in k.lower() for tok in FORBIDDEN_OUTPUT_TOKENS))
    if bad:
        raise SystemExit(f"V66_FORBIDDEN_OUTPUT_COLUMNS:{bad}")
    missing_cols = sorted(required_columns() - set(records[0].keys()))
    if missing_cols:
        raise SystemExit(f"V66_REQUIRED_COLUMNS_MISSING:{missing_cols}")
    for r in records:
        for h in ("f3", "f5", "fg"):
            for side in ("home", "away"):
                x = r[f"{side}_{h}_starter_share"]
                if finite(x) and not (0.0 <= float(x) <= 1.0):
                    raise SystemExit(f"V66_SHARE_OUT_OF_BOUNDS:{r['season']}:{r['gamePk']}:{side}:{h}:{x}")
    coverage = {}
    for s in SEASONS:
        rr = [r for r in records if r["season"] == s]
        coverage[s] = {
            "rows": len(rr),
            "expectedOutsPairAvailable": sum(finite(r["home_expected_starter_outs"]) and finite(r["away_expected_starter_outs"]) for r in rr),
            "quality5Available": sum(all(finite(r[q]) for q in QUALITY_NAMES) for r in rr),
            "control4Available": sum(all(finite(r[q]) for q in CONTROL4) for r in rr),
            "totalBaseAvailable": sum(finite(r["combined_team_rs10"]) and finite(r["combined_team_ra10"]) for r in rr),
            "bullpenProfilesPresent": len(rr),
        }
        for k in ("expectedOutsPairAvailable", "quality5Available", "control4Available", "totalBaseAvailable"):
            coverage[s][k + "Share"] = coverage[s][k] / len(rr) if rr else 0.0
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with gzip.open(a.out, "wt", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n")
    report = {
        "schemaVersion": OUT_SCHEMA,
        "classification": "V66_PREOUTCOME_CUSTODY_FROZEN_READY_FOR_SEPARATE_OUTCOME_SCORER",
        "rows": len(records),
        "rowsBySeason": {s: sum(r["season"] == s for r in records) for s in SEASONS},
        "coverageBySeason": coverage,
        "qualityCustodyBySeason": qdiag,
        "qualityTrainingStandardization": {
            "fitSeason": "2022",
            "sideLevelComponentParameters": qparams,
            "scalarDefinition": "UNWEIGHTED_MEAN_OF_FIVE_2022_STANDARDIZED_V62_SIDE_COMPONENTS",
        },
        "expectedStarterOutsModel": v39_manifest,
        "bullpenSourcePacks": bpdiag,
        "sourceSemantics": {
            "v39": "FROZEN_V39_EXPECTED_OUTS_RECONSTRUCTED_WITH_IDENTICAL_BUILD_AND_POISSON_MODEL",
            "v62": "FROZEN_V62_STARTER_QUALITY_FUNCTION_WITH_2021_WARMUP_AND_WHOLE_DATE_BEFORE_UPDATE",
            "v14": "FROZEN_V14_ARCHIVED_BOXSCORE_RELIEVERS_AND_EXACT_30D_1D_3D_CORE3_B2B_ROLLING_DEFINITIONS",
            "combinedExpectedBullpenShare": "HOME_PLUS_AWAY_EXPECTED_BULLPEN_SHARE",
            "weightedWinnerBullpen": "AWAY_MINUS_HOME_WORKLOAD_TIMES_MEAN_EXPECTED_BULLPEN_SHARE",
            "weightedTotalBullpen": "HOME_PLUS_AWAY_WORKLOAD_TIMES_MEAN_EXPECTED_BULLPEN_SHARE",
        },
        "chronology": {
            "sameDateOutcomeLeakageAllowed": False,
            "futureGameDataAllowed": False,
            "qualityStateUpdatedAfterWholeOfficialDate": True,
            "bullpenProfilesUseOfficialDateStrictlyBeforeTarget": True,
        },
        "output": {
            "path": a.out,
            "sha256": sha256_file(a.out),
            "gzipJsonLines": True,
            "containsOutcomeTargets": False,
            "columnCount": len(records[0]) if records else 0,
        },
        "policy": {
            "researchOnly": True,
            "historicalPricesUsed": False,
            "marketOddsUsedAsFeatures": False,
            "positiveEvEstablished": False,
            "v16ProductionChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "stakeChanged": False,
            "betEliteAllowed": False,
            "automaticBetPlacementAllowed": False,
            "realFinancialExposure": 0,
        },
    }
    dump(a.report, report)
    print(json.dumps({"classification": report["classification"], "rows": report["rows"], "rowsBySeason": report["rowsBySeason"], "coverageBySeason": report["coverageBySeason"], "outputSha256": report["output"]["sha256"]}, indent=2))

if __name__ == "__main__":
    main()
