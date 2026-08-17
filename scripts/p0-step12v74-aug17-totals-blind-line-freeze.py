#!/usr/bin/env python3
import argparse
import datetime as dt
import importlib.util
import json
import math
import os
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from scipy.stats import nbinom

SCHEMA = "courtedge-p0-step12v74-aug17-totals-blind-line-freeze.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v74-aug17-totals-blind-line-freeze-contract.v1"
STATE_SCHEMA = "courtedge-p0-step12v68-prospective-state.v1"
API = "https://statsapi.mlb.com"
TIMEOUT = 25
ATTEMPTS = 4
BP_NAMES = ("bullpen_pitches_1d", "bullpen_pitches_3d", "bullpen_core3_pitches_2d", "bullpen_b2b_arms")
QUALITY_KEYS = ("velocity", "spin", "whiff", "strike", "hard")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def clip01(v):
    if not finite(v):
        return None
    return max(0.0, min(1.0, float(v)))


def fetch_json(path, params=None, label="mlb"):
    url = API + path
    if params:
        url += "?" + urlencode(params)
    last = None
    for i in range(ATTEMPTS):
        try:
            req = Request(url, headers={"User-Agent": "CourtEdge-V74-BlindTotals/1.0", "Accept": "application/json"})
            with urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as e:
            last = e
            if isinstance(e, HTTPError) and e.code < 500 and e.code not in (408, 425, 429):
                break
            if i + 1 < ATTEMPTS:
                time.sleep(0.35 * (2 ** i))
    raise RuntimeError(f"{label}:{type(last).__name__}:{last}")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"V74_IMPORT_FAILED:{path}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def is_strict_pregame(feed):
    status = (feed.get("gameData") or {}).get("status") or {}
    coded = str(status.get("codedGameState") or "").upper()
    abstract = str(status.get("abstractGameState") or "").lower()
    detailed = str(status.get("detailedState") or "").lower()
    return coded not in ("I", "F", "O") and abstract not in ("live", "final") and not any(
        x in detailed for x in ("in progress", "final", "game over", "completed early")
    )


def parse_current_game(schedule_game, target_date):
    gp = int(schedule_game.get("gamePk") or 0)
    if gp <= 0:
        return None
    feed = fetch_json(f"/api/v1.1/game/{gp}/feed/live", label=f"target-feed:{gp}")
    if not is_strict_pregame(feed):
        return None
    gd = feed.get("gameData") or {}
    official = str((gd.get("datetime") or {}).get("officialDate") or schedule_game.get("officialDate") or "")
    if official != target_date:
        return None
    teams = gd.get("teams") or {}
    home_blob, away_blob = teams.get("home") or {}, teams.get("away") or {}
    home_id, away_id = int(home_blob.get("id") or 0), int(away_blob.get("id") or 0)
    probs = gd.get("probablePitchers") or {}
    hp, ap = probs.get("home") or {}, probs.get("away") or {}
    hp_id, ap_id = int(hp.get("id") or 0), int(ap.get("id") or 0)
    if min(home_id, away_id, hp_id, ap_id) <= 0:
        return {
            "gamePk": gp,
            "officialDate": official,
            "homeTeamId": home_id or None,
            "awayTeamId": away_id or None,
            "homeTeam": home_blob.get("name"),
            "awayTeam": away_blob.get("name"),
            "homeProbablePitcherId": hp_id or None,
            "awayProbablePitcherId": ap_id or None,
            "homeProbablePitcher": hp.get("fullName"),
            "awayProbablePitcher": ap.get("fullName"),
            "scheduledStart": str((gd.get("datetime") or {}).get("dateTime") or schedule_game.get("gameDate") or ""),
            "ready": False,
            "reason": "MISSING_BOTH_CURRENT_PROBABLE_PITCHERS_OR_TEAM_IDENTITY"
        }
    return {
        "gamePk": gp,
        "officialDate": official,
        "homeTeamId": home_id,
        "awayTeamId": away_id,
        "homeTeam": home_blob.get("name") or str(home_id),
        "awayTeam": away_blob.get("name") or str(away_id),
        "homeProbablePitcherId": hp_id,
        "awayProbablePitcherId": ap_id,
        "homeProbablePitcher": hp.get("fullName") or str(hp_id),
        "awayProbablePitcher": ap.get("fullName") or str(ap_id),
        "scheduledStart": str((gd.get("datetime") or {}).get("dateTime") or schedule_game.get("gameDate") or ""),
        "ready": True,
    }


def target_games(target_date):
    sched = fetch_json("/api/v1/schedule", {"sportId": 1, "gameType": "R", "date": target_date}, "target-schedule")
    games = []
    for d in sched.get("dates", []):
        games.extend(d.get("games", []))
    out = []
    for g in games:
        x = parse_current_game(g, target_date)
        if x is not None:
            out.append(x)
    return sorted(out, key=lambda x: (x.get("scheduledStart") or "", int(x["gamePk"])))


def team_form(state, team_id):
    z = (state.get("c4") or {}).get("teams", {}).get(str(team_id))
    if not z or int(z.get("games", 0)) < 5:
        return None
    recent = list(z.get("recent", []))[-10:]
    if not recent:
        return None
    rs = sum(float(x[0]) for x in recent) / len(recent)
    ra = sum(float(x[1]) for x in recent) / len(recent)
    return {"gamesUsed": len(recent), "rs": rs, "ra": ra, "rd": rs - ra}


def quality_scalar(raw, params):
    if raw is None:
        return None
    vals = []
    for k in QUALITY_KEYS:
        if not finite(raw.get(k)):
            return None
        p = params[k]
        vals.append((float(raw[k]) - float(p["mean"])) / float(p["scale"]))
    return float(np.mean(vals))


def prior_schedule_games(start_date, end_date):
    sched = fetch_json("/api/v1/schedule", {
        "sportId": 1, "gameType": "R", "startDate": start_date, "endDate": end_date
    }, "prior-schedule")
    games = []
    for d in sched.get("dates", []):
        for g in d.get("games", []):
            status = g.get("status") or {}
            abstract = str(status.get("abstractGameState") or "").lower()
            coded = str(status.get("codedGameState") or "").upper()
            if abstract == "final" or coded == "F":
                games.append({
                    "gamePk": int(g["gamePk"]),
                    "officialDate": str(g["officialDate"]),
                    "homeTeamId": int(((g.get("teams") or {}).get("home") or {}).get("team", {}).get("id") or 0),
                    "awayTeamId": int(((g.get("teams") or {}).get("away") or {}).get("team", {}).get("id") or 0),
                })
    return games


def bullpen_game(row):
    gp = int(row["gamePk"])
    box = fetch_json(f"/api/v1/game/{gp}/boxscore", label=f"prior-box:{gp}")
    teams = box.get("teams") or {}
    result = {"gamePk": gp, "officialDate": row["officialDate"]}
    for side in ("home", "away"):
        blob = teams.get(side) or {}
        pitchers = [int(x) for x in (blob.get("pitchers") or []) if str(x).isdigit()]
        if not pitchers:
            raise RuntimeError(f"NO_PITCHERS:{gp}:{side}")
        starter = pitchers[0]
        players = blob.get("players") or {}
        relievers = {}
        for pid in pitchers[1:]:
            p = players.get(f"ID{pid}") or {}
            stats = ((p.get("stats") or {}).get("pitching") or {})
            try:
                pitches = max(0, int(stats.get("pitchesThrown") or 0))
            except Exception:
                pitches = 0
            relievers[pid] = pitches
        tid = int(row[f"{side}TeamId"])
        result[side] = {
            "teamId": tid,
            "starterId": starter,
            "bullpenPitches": int(sum(relievers.values())),
            "relievers": relievers,
        }
    return result


def build_bullpen_history(target_date):
    target = dt.date.fromisoformat(target_date)
    start = (target - dt.timedelta(days=30)).isoformat()
    end = (target - dt.timedelta(days=1)).isoformat()
    games = prior_schedule_games(start, end)
    hist = defaultdict(list)
    failures = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(bullpen_game, g): g for g in games}
        for f in as_completed(futs):
            g = futs[f]
            try:
                x = f.result()
            except Exception as e:
                failures.append({"gamePk": g["gamePk"], "officialDate": g["officialDate"], "error": str(e)[:200]})
                continue
            day = dt.date.fromisoformat(x["officialDate"])
            for side in ("home", "away"):
                b = x[side]
                hist[int(b["teamId"])].append({
                    "date": day,
                    "gamePk": int(x["gamePk"]),
                    "bullpenPitches": int(b["bullpenPitches"]),
                    "relievers": dict(b["relievers"]),
                })
    for rows in hist.values():
        rows.sort(key=lambda r: (r["date"], r["gamePk"]))
    return hist, {"rangeStart": start, "rangeEnd": end, "finalGamesScheduled": len(games), "boxscoreFailures": failures}


def bullpen_profile(hist, team_id, target):
    rows = [r for r in hist.get(int(team_id), []) if target - dt.timedelta(days=30) <= r["date"] < target]
    pool = defaultdict(int)
    for r in rows:
        for pid, p in r["relievers"].items():
            pool[int(pid)] += int(p)
    core = [pid for pid, _ in sorted(pool.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
    d1, d2, d3 = target - dt.timedelta(days=1), target - dt.timedelta(days=2), target - dt.timedelta(days=3)
    p1 = sum(r["bullpenPitches"] for r in rows if r["date"] == d1)
    p3 = sum(r["bullpenPitches"] for r in rows if d3 <= r["date"] < target)
    core2 = sum(p for r in rows if target - dt.timedelta(days=2) <= r["date"] < target for pid, p in r["relievers"].items() if int(pid) in core)
    ids1 = {int(pid) for r in rows if r["date"] == d1 for pid in r["relievers"]}
    ids2 = {int(pid) for r in rows if r["date"] == d2 for pid in r["relievers"]}
    return {
        "bullpen_pitches_1d": float(p1),
        "bullpen_pitches_3d": float(p3),
        "bullpen_core3_pitches_2d": float(core2),
        "bullpen_b2b_arms": float(len(ids1 & ids2)),
        "priorGames30d": len(rows),
        "relieverPool30d": len(pool),
        "core3RelieverIds": core,
    }


def frozen_mu(model, feature_row):
    pre = model["preprocessor"]
    x = []
    for name, median, mean, scale in zip(pre["features"], pre["medianImpute"], pre["mean"], pre["scale"]):
        raw = feature_row.get(name)
        value = float(raw) if finite(raw) else float(median)
        x.append((value - float(mean)) / float(scale))
    eta = float(model["intercept"]) + float(np.asarray(x, dtype=float) @ np.asarray(model["coefficients"], dtype=float))
    mu = math.exp(eta)
    if not math.isfinite(mu) or mu <= 0:
        raise SystemExit("V74_FROZEN_MU_INVALID")
    return mu


def count_distribution(mu, alpha, max_count):
    size = 1.0 / float(alpha)
    p = size / (size + float(mu))
    pmf = [float(nbinom.pmf(k, size, p)) for k in range(max_count + 1)]
    tail = max(0.0, 1.0 - sum(pmf))
    median = int(nbinom.ppf(0.5, size, p))
    return pmf, tail, median


def game_features(game, state, srcmod, srcmanifest, v62contract, qparams, hist):
    home, away = int(game["homeTeamId"]), int(game["awayTeamId"])
    hp, ap = int(game["homeProbablePitcherId"]), int(game["awayProbablePitcherId"])
    hf, af = team_form(state, home), team_form(state, away)
    if hf is None or af is None:
        raise RuntimeError("TEAM_FORM_UNAVAILABLE")
    # Night-before semantics: current lineup continuity is intentionally unavailable.
    houts = srcmod.v39_vector(state, hp, away, af["rs"], None, srcmanifest)
    aouts = srcmod.v39_vector(state, ap, home, hf["rs"], None, srcmanifest)
    hraw = srcmod.v62_quality(state, hp, v62contract)
    araw = srcmod.v62_quality(state, ap, v62contract)
    hq = quality_scalar(hraw, qparams)
    aq = quality_scalar(araw, qparams)
    target = dt.date.fromisoformat(game["officialDate"])
    hbp, abp = bullpen_profile(hist, home, target), bullpen_profile(hist, away, target)
    common = {
        "combined_team_rs10": float(hf["rs"] + af["rs"]),
        "combined_team_ra10": float(hf["ra"] + af["ra"]),
    }
    routes = {}
    for horizon, denom in (("f5", 15.0), ("fg", 27.0)):
        hs, aws = clip01(houts / denom), clip01(aouts / denom)
        mean_share = (hs + aws) / 2.0
        min_share = min(hs, aws)
        h_bull_share, a_bull_share = 1.0 - hs, 1.0 - aws
        mean_bull = (h_bull_share + a_bull_share) / 2.0
        feat = dict(common)
        feat[f"mean_{horizon}_starter_share"] = mean_share
        feat[f"min_{horizon}_starter_share"] = min_share
        feat[f"combined_{horizon}_expected_bullpen_share"] = h_bull_share + a_bull_share
        feat[f"quality_weighted_combined_{horizon}_starter_share"] = None if hq is None or aq is None else hq * hs + aq * aws
        for name in BP_NAMES:
            combined = float(hbp[name]) + float(abp[name])
            feat[f"{name}_combined_weighted_{horizon}"] = combined * mean_bull
        routes[horizon] = feat
    diag = {
        "homeForm": hf,
        "awayForm": af,
        "homeExpectedStarterOuts": houts,
        "awayExpectedStarterOuts": aouts,
        "homeStarterQualityIndexZ5": hq,
        "awayStarterQualityIndexZ5": aq,
        "homeStarterQualityRaw": hraw,
        "awayStarterQualityRaw": araw,
        "homeBullpenProfile": hbp,
        "awayBullpenProfile": abp,
        "currentLineupContinuityUsed": False,
        "v39CurrentLineupContinuityHandling": "FROZEN_MEDIAN_IMPUTATION"
    }
    return routes, diag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--v68-source-script", required=True)
    ap.add_argument("--v68-source-manifest", required=True)
    ap.add_argument("--v62-contract", required=True)
    ap.add_argument("--v66-totals-report", required=True)
    ap.add_argument("--v66-custody-report", required=True)
    ap.add_argument("--v67-report", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    c = load(a.contract)
    if c.get("schemaVersion") != CONTRACT_SCHEMA or c.get("scientificStatus") != "FROZEN_BEFORE_V74_SCORER_AND_BEFORE_ANY_SPORTSBOOK_LINE_IS_READ":
        raise SystemExit("V74_CONTRACT_INVALID")
    if c["targetOfficialDate"] != "2026-08-17":
        raise SystemExit("V74_TARGET_DATE_DRIFT")
    if c["marketLineEmbargo"]["assistantMayReadSportsbookLinesBeforePredictionArtifactFreeze"] is not False:
        raise SystemExit("V74_MARKET_EMBARGO_INVALID")
    state = load(a.state)
    if state.get("schemaVersion") != STATE_SCHEMA or state.get("targetOfficialDate") != c["targetOfficialDate"]:
        raise SystemExit("V74_STATE_INVALID")
    if state.get("policy", {}).get("containsMarketPrices") is not False or state.get("policy", {}).get("containsTargetOutcomes") is not False:
        raise SystemExit("V74_STATE_CONTAMINATED")

    srcmanifest = load(a.v68_source_manifest)
    v62contract = load(a.v62_contract)
    srcmod = load_module(a.v68_source_script, "v74_v68_source")
    v66 = load(a.v66_totals_report)
    custody_report = load(a.v66_custody_report)
    v67 = load(a.v67_report)

    f5_route = v67["routes"]["V67_A_F5_TOTAL_NB2"]
    fg_route = v67["routes"]["V67_B_FULL_GAME_TOTAL_NB2"]
    if f5_route["classification"] != c["frozenParents"]["v67F5Classification"] or fg_route["classification"] != c["frozenParents"]["v67FullGameClassification"]:
        raise SystemExit("V74_V67_CERTIFICATION_DRIFT")
    alpha_f5 = float(f5_route["dispersionFit2022"]["alpha"])
    alpha_fg = float(fg_route["dispersionFit2022"]["alpha"])
    f5_model = v66["routes"]["V66_D_F5_TOTAL"]["primaryCandidate"]["model"]
    fg_model = v66["routes"]["V66_E_FULL_GAME_TOTAL"]["primaryCandidate"]["model"]
    if list(f5_model["preprocessor"]["features"]) != c["predictionRoutes"]["F5_TOTAL"]["requiredFeatureSetExactly"]:
        raise SystemExit("V74_F5_FEATURE_SET_DRIFT")
    if list(fg_model["preprocessor"]["features"]) != c["predictionRoutes"]["FULL_GAME_TOTAL"]["requiredFeatureSetExactly"]:
        raise SystemExit("V74_FG_FEATURE_SET_DRIFT")
    qparams = custody_report["qualityTrainingStandardization"]["sideLevelComponentParameters"]

    games = target_games(c["targetOfficialDate"])
    ready = [g for g in games if g.get("ready") is True]
    not_ready = [g for g in games if g.get("ready") is not True]
    if not ready:
        raise SystemExit("V74_NO_TARGET_GAMES_WITH_BOTH_PROBABLE_STARTERS")
    hist, bpdiag = build_bullpen_history(c["targetOfficialDate"])
    if bpdiag["boxscoreFailures"]:
        # Fail closed: bullpen history is a required model input and must be complete for all final prior games.
        raise SystemExit(f"V74_PRIOR_BULLPEN_BOXSCORE_FAILURES:{len(bpdiag['boxscoreFailures'])}:{bpdiag['boxscoreFailures'][:3]}")

    rows, feature_failures = [], []
    for g in ready:
        try:
            routes, diag = game_features(g, state, srcmod, srcmanifest, v62contract, qparams, hist)
            mu_f5 = frozen_mu(f5_model, routes["f5"])
            mu_fg = frozen_mu(fg_model, routes["fg"])
            pmf_f5, tail_f5, med_f5 = count_distribution(mu_f5, alpha_f5, 20)
            pmf_fg, tail_fg, med_fg = count_distribution(mu_fg, alpha_fg, 25)
            rows.append({
                "gamePk": int(g["gamePk"]),
                "officialDate": g["officialDate"],
                "awayTeam": g["awayTeam"],
                "homeTeam": g["homeTeam"],
                "scheduledStart": g["scheduledStart"],
                "awayProbablePitcherId": int(g["awayProbablePitcherId"]),
                "homeProbablePitcherId": int(g["homeProbablePitcherId"]),
                "awayProbablePitcher": g["awayProbablePitcher"],
                "homeProbablePitcher": g["homeProbablePitcher"],
                "f5ExpectedRunsMu": mu_f5,
                "fullGameExpectedRunsMu": mu_fg,
                "f5Nb2Alpha": alpha_f5,
                "fullGameNb2Alpha": alpha_fg,
                "f5CountPmf0To20": pmf_f5,
                "f5TailProbabilityAbove20": tail_f5,
                "fullGameCountPmf0To25": pmf_fg,
                "fullGameTailProbabilityAbove25": tail_fg,
                "f5MedianCount": med_f5,
                "fullGameMedianCount": med_fg,
                "featureVectorF5": routes["f5"],
                "featureVectorFullGame": routes["fg"],
                "diagnostics": diag,
            })
        except Exception as e:
            feature_failures.append({"gamePk": g["gamePk"], "awayTeam": g["awayTeam"], "homeTeam": g["homeTeam"], "error": str(e)[:300]})
    if feature_failures:
        raise SystemExit(f"V74_TARGET_FEATURE_FAILURES:{feature_failures}")

    captured = dt.datetime.now(dt.timezone.utc).isoformat()
    report = {
        "schemaVersion": SCHEMA,
        "classification": "V74_AUG17_TOTALS_BLIND_LINE_PREDICTIONS_FROZEN",
        "targetOfficialDate": c["targetOfficialDate"],
        "capturedAtUtc": captured,
        "slate": {
            "pregameGamesObserved": len(games),
            "gamesWithBothProbableStarters": len(ready),
            "gamesNotReady": not_ready,
            "predictedRows": len(rows),
        },
        "rows": rows,
        "priorState": {
            "stateDigest": state.get("stateDigest"),
            "chronology": state.get("chronology"),
            "custody": state.get("custody"),
            "bullpenAcquisition": bpdiag,
        },
        "adapterDisclosure": {
            "currentLineupsUsed": False,
            "currentLineupContinuityMedianImputed": True,
            "priorBullpenActualFirstListedPitcherUsedAsStarter": True,
            "differenceFromHistoricalV66BullpenT5IdentityDisclosed": True,
        },
        "policy": {
            "sportsbookLinesRead": False,
            "sportsbookPricesRead": False,
            "targetOutcomesRead": False,
            "marketOddsUsedAsFeatures": False,
            "predictionMayChangeAfterLineDisclosure": False,
            "researchOnly": True,
            "productionChanged": False,
            "prospectiveV68Changed": False,
            "positiveEvEstablished": False,
            "realFinancialExposure": 0,
        }
    }
    forbidden = ("sportsbookLine", "marketLine", "odds", "price")
    for r in rows:
        if any(k in r for k in forbidden):
            raise SystemExit("V74_FORBIDDEN_MARKET_FIELD_EMITTED")
    dump(a.out, report)
    print(json.dumps({
        "classification": report["classification"],
        "capturedAtUtc": captured,
        "predictedRows": len(rows),
        "notReady": len(not_ready),
        "predictions": [
            {"game": f"{r['awayTeam']} @ {r['homeTeam']}", "F5_mu": round(r['f5ExpectedRunsMu'], 4), "FG_mu": round(r['fullGameExpectedRunsMu'], 4)}
            for r in rows
        ],
        "marketLinesRead": False,
    }, indent=2))


if __name__ == "__main__":
    main()
