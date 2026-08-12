#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from collections import defaultdict

SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
HORIZONS = ("FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME")


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(float(v))


def build_features(dataset, starter_history, lineup_history, t5_audit):
    obs = {}
    for r in dataset.get("observations", []):
        h = r.get("horizon")
        if h in HORIZONS:
            obs[(int(r["gamePk"]), h)] = r

    full = [r for (gpk, h), r in obs.items() if h == "FULL_GAME"]
    full.sort(key=lambda r: (r["officialDate"], int(r["gamePk"])))
    final_starters = {int(g["gamePk"]): g for g in starter_history.get("games", [])}
    lineups = {int(s["gamePk"]): s for s in lineup_history.get("snapshots", [])}
    t5 = {int(r["gamePk"]): r for r in t5_audit.get("rows", [])}

    by_date = defaultdict(list)
    for r in full:
        by_date[r["officialDate"]].append(r)

    team_hist = defaultdict(list)
    pitcher_hist = defaultdict(list)
    league_pitcher = []
    team_player_apps = defaultdict(int)
    team_prior_games = defaultdict(int)
    previous_lineup = {}
    rows = []

    def team_stats(tid):
        hist = team_hist[tid]
        if len(hist) < 5:
            return None
        recent = hist[-10:]
        return {
            "rs": mean([x["rs"] for x in recent]),
            "ra": mean([x["ra"] for x in recent]),
            "rd": mean([x["rs"] - x["ra"] for x in recent]),
            "win": mean([x["win"] for x in recent]),
            "prior_games": len(hist),
        }

    def league_rates():
        valid_lines = [x for x in league_pitcher if x.get("battersFaced")]
        lbf = sum(x["battersFaced"] for x in valid_lines)
        if lbf <= 0:
            return None
        return {
            "erbf": sum(x["earnedRuns"] for x in valid_lines) / lbf,
            "kbb": sum(x["strikeOuts"] - x["baseOnBalls"] for x in valid_lines) / lbf,
            "hrbf": sum(x["homeRuns"] for x in valid_lines) / lbf,
        }

    def pitcher_stats(pid, prior_bf=72):
        lr = league_rates()
        if lr is None:
            return None
        hist = [x for x in pitcher_hist[pid] if x.get("battersFaced")]
        bf = sum(x["battersFaced"] for x in hist)
        er = sum(x["earnedRuns"] for x in hist)
        kbb = sum(x["strikeOuts"] - x["baseOnBalls"] for x in hist)
        hr = sum(x["homeRuns"] for x in hist)
        return {
            "bf": bf,
            "erbf": (er + prior_bf * lr["erbf"]) / (bf + prior_bf),
            "kbb": (kbb + prior_bf * lr["kbb"]) / (bf + prior_bf),
            "hrbf": (hr + prior_bf * lr["hrbf"]) / (bf + prior_bf),
            "league": lr,
        }

    def lineup_exposure_rate(tid, order):
        prior_games = team_prior_games[tid]
        if prior_games <= 0:
            return None
        return mean([team_player_apps[(tid, pid)] / prior_games for pid in order])

    def continuity_rate(tid, order):
        prev = previous_lineup.get(tid)
        if not prev:
            return None
        return len(set(order) & set(prev)) / 9.0

    for date in sorted(by_date):
        # Every game on this date is featurized before any same-date outcome can
        # update team, pitcher, league or lineup historical state.
        for r in sorted(by_date[date], key=lambda x: int(x["gamePk"])):
            gpk = int(r["gamePk"])
            h, a = int(r["homeTeamId"]), int(r["awayTeamId"])
            audit = t5.get(gpk)
            lineup = lineups.get(gpk)

            outcomes = {}
            missing_horizon = False
            for horizon in HORIZONS:
                o = obs.get((gpk, horizon))
                if o is None:
                    missing_horizon = True
                    break
                home_runs = int(o["homeRuns"])
                away_runs = int(o["awayRuns"])
                outcomes[horizon] = {
                    "homeRuns": home_runs,
                    "awayRuns": away_runs,
                    "totalRuns": int(o["totalRuns"]),
                    "result": "HOME" if home_runs > away_runs else ("AWAY" if home_runs < away_runs else "TIE"),
                }
            if missing_horizon:
                continue

            audit_valid = bool(audit and audit.get("identityOk") and audit.get("sourceHistorical") and audit.get("pregame"))
            probable_known = bool(audit_valid and audit.get("probableBothKnown"))
            lineup_complete = bool(lineup and lineup.get("complete"))

            f = {}
            hs, aas = team_stats(h), team_stats(a)
            if hs and aas:
                f.update({
                    "home_team_rs10": hs["rs"],
                    "away_team_rs10": aas["rs"],
                    "combined_team_rs10": hs["rs"] + aas["rs"],
                    "team_rs10_diff": hs["rs"] - aas["rs"],
                    "home_team_ra10": hs["ra"],
                    "away_team_ra10": aas["ra"],
                    "combined_team_ra10": hs["ra"] + aas["ra"],
                    "team_ra10_adv": aas["ra"] - hs["ra"],
                    "home_team_rd10": hs["rd"],
                    "away_team_rd10": aas["rd"],
                    "team_rd10_diff": hs["rd"] - aas["rd"],
                    "home_team_win10": hs["win"],
                    "away_team_win10": aas["win"],
                    "team_win10_diff": hs["win"] - aas["win"],
                    "home_team_prior_games": hs["prior_games"],
                    "away_team_prior_games": aas["prior_games"],
                    "min_team_prior_games": min(hs["prior_games"], aas["prior_games"]),
                })

            hp = ap = None
            if probable_known:
                hp_id = int(audit["homeProbablePitcherId"])
                ap_id = int(audit["awayProbablePitcherId"])
                hp, ap = pitcher_stats(hp_id), pitcher_stats(ap_id)
            else:
                hp_id = ap_id = None

            if hp and ap:
                f.update({
                    "home_starter_erbf": hp["erbf"],
                    "away_starter_erbf": ap["erbf"],
                    "combined_starter_erbf": hp["erbf"] + ap["erbf"],
                    "starter_runrisk_adv": ap["erbf"] - hp["erbf"],
                    "home_starter_kbb": hp["kbb"],
                    "away_starter_kbb": ap["kbb"],
                    "combined_starter_kbb": hp["kbb"] + ap["kbb"],
                    "starter_kbb_adv": hp["kbb"] - ap["kbb"],
                    "home_starter_hrbf": hp["hrbf"],
                    "away_starter_hrbf": ap["hrbf"],
                    "combined_starter_hrbf": hp["hrbf"] + ap["hrbf"],
                    "starter_hr_adv": ap["hrbf"] - hp["hrbf"],
                    "home_probable_prior_bf": hp["bf"],
                    "away_probable_prior_bf": ap["bf"],
                    "min_probable_prior_bf": min(hp["bf"], ap["bf"]),
                    "sum_probable_prior_bf": hp["bf"] + ap["bf"],
                    "league_pitcher_erbf_prior": hp["league"]["erbf"],
                    "league_pitcher_kbb_prior": hp["league"]["kbb"],
                    "league_pitcher_hrbf_prior": hp["league"]["hrbf"],
                })

            if audit_valid and lineup_complete:
                hl, al = list(lineup["homeBattingOrder"]), list(lineup["awayBattingOrder"])
                he, ae = lineup_exposure_rate(h, hl), lineup_exposure_rate(a, al)
                hc, ac = continuity_rate(h, hl), continuity_rate(a, al)
                if he is not None and ae is not None:
                    f.update({
                        "home_lineup_exposure_rate": he,
                        "away_lineup_exposure_rate": ae,
                        "lineup_exposure_rate_adv": he - ae,
                        "combined_lineup_exposure_rate": he + ae,
                    })
                if hc is not None and ac is not None:
                    f.update({
                        "home_lineup_continuity_rate": hc,
                        "away_lineup_continuity_rate": ac,
                        "lineup_continuity_rate_adv": hc - ac,
                        "combined_lineup_continuity_rate": hc + ac,
                    })

            rows.append({
                "gamePk": gpk,
                "officialDate": date,
                "homeTeamId": h,
                "awayTeamId": a,
                "t5PregameValid": audit_valid,
                "t5BothProbablesKnown": probable_known,
                "t5LineupComplete": lineup_complete,
                "t5HomeProbablePitcherId": hp_id,
                "t5AwayProbablePitcherId": ap_id,
                "features": f,
                "outcomes": outcomes,
            })

        # Only after the whole date is featurized may that date enter history.
        for r in sorted(by_date[date], key=lambda x: int(x["gamePk"])):
            gpk = int(r["gamePk"])
            h, a = int(r["homeTeamId"]), int(r["awayTeamId"])
            hw = 1 if int(r["homeRuns"]) > int(r["awayRuns"]) else 0
            team_hist[h].append({"rs": int(r["homeRuns"]), "ra": int(r["awayRuns"]), "win": hw})
            team_hist[a].append({"rs": int(r["awayRuns"]), "ra": int(r["homeRuns"]), "win": 1 - hw})

            sg = final_starters.get(gpk)
            if sg:
                for side in ("homeStarter", "awayStarter"):
                    line = sg[side]
                    pitcher_hist[int(line["pitcherId"])].append(line)
                    league_pitcher.append(line)

            lineup = lineups.get(gpk)
            audit = t5.get(gpk)
            audit_valid = bool(audit and audit.get("identityOk") and audit.get("sourceHistorical") and audit.get("pregame"))
            if audit_valid and lineup and lineup.get("complete"):
                for tid, key in ((h, "homeBattingOrder"), (a, "awayBattingOrder")):
                    order = list(lineup[key])
                    for pid in order:
                        team_player_apps[(tid, int(pid))] += 1
                    previous_lineup[tid] = order
            team_prior_games[h] += 1
            team_prior_games[a] += 1

    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--starter-history", required=True)
    ap.add_argument("--lineup-history", required=True)
    ap.add_argument("--t5-audit", required=True)
    ap.add_argument("--season", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    dataset = load(args.dataset)
    starter = load(args.starter_history)
    lineup = load(args.lineup_history)
    audit = load(args.t5_audit)
    if audit.get("schemaVersion") != "courtedge-p0-step12h-t5-starter-identity-audit.v1":
        raise SystemExit("STEP12V_T5_AUDIT_SCHEMA_INVALID")

    rows = build_features(dataset, starter, lineup, audit)
    if not rows:
        raise SystemExit("STEP12V_EMPTY_FEATURE_TABLE")

    valid = [r for r in rows if r["t5PregameValid"]]
    complete = [r for r in valid if r["t5BothProbablesKnown"] and r["t5LineupComplete"]]
    feature_names = sorted({k for r in rows for k, v in r["features"].items() if finite(v)})
    required = {
        "team_win10_diff",
        "starter_runrisk_adv",
        "starter_kbb_adv",
        "starter_hr_adv",
        "lineup_exposure_rate_adv",
    }
    usable = [r for r in complete if required.issubset(r["features"]) and all(finite(r["features"][k]) for k in required)]

    report = {
        "schemaVersion": SCHEMA,
        "evidenceStatus": "GAME_BY_GAME_T5_ANATOMY_RESEARCH_ONLY_NO_PRICE_NO_LIVE_PROMOTION",
        "season": args.season,
        "source": {
            "datasetSha256": sha256_file(args.dataset),
            "starterHistorySha256": sha256_file(args.starter_history),
            "lineupHistorySha256": sha256_file(args.lineup_history),
            "t5AuditSha256": sha256_file(args.t5_audit),
        },
        "counts": {
            "rows": len(rows),
            "validT5PregameRows": len(valid),
            "completeLineupAndBothProbablesRows": len(complete),
            "coreFeatureUsableRows": len(usable),
            "numericFeatureCount": len(feature_names),
        },
        "featureNames": feature_names,
        "featureContract": {
            "currentGameStarterIdentity": "T5_PROBABLE_PITCHER_ONLY",
            "sameDateHistoryAllowed": False,
            "currentGameOutcomeUsedAsFeature": False,
            "finalSeasonStatsUsedForEarlierGames": False,
            "teamHistoryUpdatesAfterWholeDateScored": True,
            "pitcherHistoryUpdatesAfterWholeDateScored": True,
            "lineupHistoryUpdatesAfterWholeDateScored": True,
            "labelsStoredSeparatelyFromFeatures": True,
        },
        "policy": {
            "historicalPricesUsed": False,
            "evOrRoiClaimAllowed": False,
            "livePickFilterChanged": False,
            "betEliteProduced": False,
            "automaticBetPlacement": False,
        },
        "rows": rows,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps({"ok": True, "season": args.season, "counts": report["counts"]}, indent=2))


if __name__ == "__main__":
    main()
