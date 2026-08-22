#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error

import nfl_r5_leakage_safe as base

DEPTH_URL = "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_{y}.parquet"
INJURY_URL = "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{y}.parquet"
TEAM_MAP = {"OAK":"LV","SD":"LAC","STL":"LA","LAR":"LA","JAC":"JAX","WSH":"WAS"}


def team_norm(x):
    s = str(x).upper().strip()
    return TEAM_MAP.get(s, s)


def id_norm(x):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    s = str(x).strip()
    if not s or s.lower() == "nan":
        return None
    if s.endswith(".0"):
        s = s[:-2]
    return s


def rank_num(x, fallback=99):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return fallback
    try:
        return int(float(x))
    except Exception:
        m = re.search(r"(\d+)", str(x))
        return int(m.group(1)) if m else fallback


def load_depth(cache: Path, seasons):
    old_rows, new_rows, prov = [], [], []
    for y in seasons:
        p = base.dl(DEPTH_URL.format(y=y), cache / f"depth_charts_{y}.parquet")
        x = pd.read_parquet(p)
        cols = list(x.columns)
        if y <= 2024:
            team_col = "club_code" if "club_code" in x else "team"
            week_col = "week"
            id_col = "gsis_id"
            if team_col not in x or week_col not in x or id_col not in x:
                raise RuntimeError(f"R5B old depth schema unsupported {y}: {cols}")
            qb_mask = pd.Series(False, index=x.index)
            for c in ["position", "depth_position", "formation"]:
                if c in x:
                    qb_mask = qb_mask | x[c].astype(str).str.upper().str.contains(r"\bQB\b|QUARTERBACK", regex=True)
            z = x[qb_mask].copy()
            z["team"] = z[team_col].map(team_norm)
            z["season"] = pd.to_numeric(z.get("season", y), errors="coerce").fillna(y).astype(int)
            z["week"] = pd.to_numeric(z[week_col], errors="coerce")
            z = z[z.week.notna()]
            z["week"] = z.week.astype(int)
            z["qb_id"] = z[id_col].map(id_norm)
            if "depth_team" in z:
                z["rank"] = z.depth_team.map(rank_num)
            elif "depth_position" in z:
                z["rank"] = z.depth_position.map(rank_num)
            else:
                z["rank"] = z.groupby(["season","week","team"]).cumcount() + 1
            z = z[z.qb_id.notna()][["season","week","team","qb_id","rank"]]
            old_rows.append(z)
        else:
            needed = {"dt","team","gsis_id"}
            if not needed.issubset(x.columns):
                raise RuntimeError(f"R5B timestamp depth schema unsupported {y}: {cols}")
            qb_mask = pd.Series(False, index=x.index)
            for c in ["pos_abb", "pos_name"]:
                if c in x:
                    qb_mask = qb_mask | x[c].astype(str).str.upper().str.contains(r"\bQB\b|QUARTERBACK", regex=True)
            z = x[qb_mask].copy()
            z["dt"] = pd.to_datetime(z.dt, errors="coerce", utc=True)
            z = z[z.dt.notna()]
            z["team"] = z.team.map(team_norm)
            z["qb_id"] = z.gsis_id.map(id_norm)
            z["rank"] = pd.to_numeric(z.get("pos_rank", np.nan), errors="coerce").fillna(99).astype(int)
            z["season"] = y
            z = z[z.qb_id.notna()][["season","dt","team","qb_id","rank"]]
            new_rows.append(z)
        prov.append({"season": y, "url": DEPTH_URL.format(y=y), "rows": int(len(x)), "columns": cols})
    old = pd.concat(old_rows, ignore_index=True) if old_rows else pd.DataFrame(columns=["season","week","team","qb_id","rank"])
    new = pd.concat(new_rows, ignore_index=True) if new_rows else pd.DataFrame(columns=["season","dt","team","qb_id","rank"])
    return old, new, prov


def load_injuries(cache: Path, seasons):
    rows, prov = [], []
    for y in seasons:
        if y > 2024:
            continue
        p = base.dl(INJURY_URL.format(y=y), cache / f"injuries_{y}.parquet")
        x = pd.read_parquet(p)
        needed = {"season","team","week","gsis_id","date_modified"}
        if not needed.issubset(x.columns):
            raise RuntimeError(f"R5B injury schema unsupported {y}: {list(x.columns)}")
        z = x.copy()
        z["season"] = pd.to_numeric(z.season, errors="coerce")
        z["week"] = pd.to_numeric(z.week, errors="coerce")
        z = z[z.season.notna() & z.week.notna()]
        z["season"] = z.season.astype(int)
        z["week"] = z.week.astype(int)
        z["team"] = z.team.map(team_norm)
        z["qb_id"] = z.gsis_id.map(id_norm)
        z["date_modified"] = pd.to_datetime(z.date_modified, errors="coerce", utc=True)
        z = z[z.qb_id.notna() & z.date_modified.notna()]
        keep = ["season","week","team","qb_id","date_modified"]
        for c in ["report_status","practice_status","report_primary_injury"]:
            if c not in z:
                z[c] = None
            keep.append(c)
        rows.append(z[keep])
        prov.append({"season": y, "url": INJURY_URL.format(y=y), "rows": int(len(x))})
    out = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()
    return out, prov


def old_depth_index(old):
    idx = {}
    if old.empty:
        return idx
    for (season, week, team), z in old.groupby(["season","week","team"], sort=False):
        q = z.sort_values(["rank","qb_id"]).drop_duplicates("qb_id")
        idx.setdefault(team, []).append((int(season), int(week), [(str(r.qb_id), int(r.rank)) for r in q.itertuples(index=False)]))
    for team in idx:
        idx[team].sort(key=lambda t: (t[0], t[1]))
    return idx


def new_depth_index(new):
    idx = {}
    if new.empty:
        return idx
    for (team, dt), z in new.groupby(["team","dt"], sort=False):
        q = z.sort_values(["rank","qb_id"]).drop_duplicates("qb_id")
        idx.setdefault(team, []).append((pd.Timestamp(dt), [(str(r.qb_id), int(r.rank)) for r in q.itertuples(index=False)]))
    for team in idx:
        idx[team].sort(key=lambda t: t[0])
    return idx


def injury_index(inj):
    idx = {}
    if inj is None or inj.empty:
        return idx
    for key, z in inj.groupby(["season","week","team","qb_id"], sort=False):
        idx[key] = z.sort_values("date_modified")
    return idx


def depth_candidates(old_idx, new_idx, season, week, team, cutoff):
    team = team_norm(team)
    if season >= 2025:
        snaps = new_idx.get(team, [])
        eligible = [x for x in snaps if x[0] < cutoff]
        if eligible:
            dt, qbs = eligible[-1]
            return qbs, "timestamped_depth", dt.isoformat()
    snaps = old_idx.get(team, [])
    eligible = [x for x in snaps if (x[0] < season) or (x[0] == season and x[1] < week)]
    if eligible:
        sy, sw, qbs = eligible[-1]
        return qbs, "lagged_week_depth", f"{sy}-W{sw}"
    return [], "none", None


def injury_at(inj_idx, season, week, team, qb_id, cutoff):
    if qb_id is None:
        return None
    z = inj_idx.get((int(season), int(week), team_norm(team), str(qb_id)))
    if z is None or z.empty:
        return None
    q = z[z.date_modified < cutoff]
    if q.empty:
        return None
    return q.iloc[-1]


def status_flags(row):
    out = {
        "injury_known": 0,
        "report_out": 0,
        "report_doubtful": 0,
        "report_questionable": 0,
        "practice_dnp": 0,
        "practice_limited": 0,
        "practice_full": 0,
    }
    if row is None:
        return out
    out["injury_known"] = 1
    rs = str(row.get("report_status", "")).strip().lower()
    ps = str(row.get("practice_status", "")).strip().lower()
    out["report_out"] = int("out" == rs or rs.startswith("out"))
    out["report_doubtful"] = int("doubt" in rs)
    out["report_questionable"] = int("question" in rs)
    out["practice_dnp"] = int("did not" in ps or ps in {"dnp","did not participate"})
    out["practice_limited"] = int("limited" in ps)
    out["practice_full"] = int("full" in ps)
    return out


def qval(state, qid, key):
    if qid is None or qid not in state:
        return np.nan
    v = state[qid]["v"].get(key, np.nan)
    return float(v) if v is not None and np.isfinite(v) else np.nan


def q_unc(state, qid):
    if qid is None or qid not in state:
        return 1.0
    return 1 / math.sqrt(max(int(state[qid]["dropbacks"]), 1))


def qb_features(games, qb_games, old_depth, new_depth, injuries, qb_alpha=0.18):
    old_idx = old_depth_index(old_depth)
    new_idx = new_depth_index(new_depth)
    inj_idx = injury_index(injuries)
    qb_lk = {
        (str(gid), team_norm(team)): z.copy()
        for (gid, team), z in qb_games.groupby(["game_id","team"], sort=False)
    }
    state, last_obs, out = {}, {}, []
    current_season = None

    for g in games.sort_values(["gameday","game_id"]).itertuples(index=False):
        if current_season is not None and int(g.season) != current_season:
            for qs in state.values():
                for k in list(qs["v"]):
                    if np.isfinite(qs["v"][k]):
                        qs["v"][k] *= 0.80
        current_season = int(g.season)
        cutoff = pd.Timestamp(g.gameday)
        if cutoff.tzinfo is None:
            cutoff = cutoff.tz_localize("UTC")
        else:
            cutoff = cutoff.tz_convert("UTC")
        cutoff = cutoff.normalize()  # strict: no target-gameday updates

        row = {"game_id": str(g.game_id), "season": int(g.season), "week": int(g.week)}
        for side, team0 in [("home", g.home_team), ("away", g.away_team)]:
            team = team_norm(team0)
            candidates, source, source_asof = depth_candidates(old_idx, new_idx, int(g.season), int(g.week), team, cutoff)
            original_qb1 = candidates[0][0] if candidates else None
            original_status = injury_at(inj_idx, int(g.season), int(g.week), team, original_qb1, cutoff)
            original_flags = status_flags(original_status)

            chosen_id, chosen_rank = None, 99
            out_ahead = 0
            for qid, rank in candidates[:4]:
                st = injury_at(inj_idx, int(g.season), int(g.week), team, qid, cutoff)
                fl = status_flags(st)
                if fl["report_out"]:
                    out_ahead += 1
                    continue
                chosen_id, chosen_rank = qid, rank
                break
            fallback = 0
            if chosen_id is None:
                chosen_id = last_obs.get(team)
                chosen_rank = 99
                source = "prior_observed_qb"
                source_asof = None
                fallback = 1

            chosen_status = injury_at(inj_idx, int(g.season), int(g.week), team, chosen_id, cutoff)
            chosen_flags = status_flags(chosen_status)
            backup_id = None
            for qid, rank in candidates:
                if qid == chosen_id:
                    continue
                st = injury_at(inj_idx, int(g.season), int(g.week), team, qid, cutoff)
                if not status_flags(st)["report_out"]:
                    backup_id = qid
                    break

            row[f"{side}_r5b_qb_id"] = chosen_id
            row[f"{side}_r5b_source"] = source
            row[f"{side}_r5b_source_asof"] = source_asof
            row[f"{side}_r5b_qb_known"] = int(chosen_id is not None)
            row[f"{side}_r5b_depth_rank"] = int(chosen_rank)
            row[f"{side}_r5b_depth_fallback"] = int(fallback)
            row[f"{side}_r5b_changed_vs_last"] = int(chosen_id is not None and last_obs.get(team) is not None and chosen_id != last_obs.get(team))
            row[f"{side}_r5b_qb1_out"] = int(original_flags["report_out"])
            row[f"{side}_r5b_qb1_doubtful"] = int(original_flags["report_doubtful"])
            row[f"{side}_r5b_qb1_questionable"] = int(original_flags["report_questionable"])
            row[f"{side}_r5b_qb1_injury_known"] = int(original_flags["injury_known"])
            row[f"{side}_r5b_qb1_practice_dnp"] = int(original_flags["practice_dnp"])
            row[f"{side}_r5b_replacement_used"] = int(out_ahead > 0 and chosen_id is not None)
            row[f"{side}_r5b_qb_epa"] = qval(state, chosen_id, "qb_epa")
            row[f"{side}_r5b_qb_cpoe"] = qval(state, chosen_id, "qb_cpoe")
            row[f"{side}_r5b_qb_sack_rate"] = qval(state, chosen_id, "qb_sack_rate")
            row[f"{side}_r5b_qb_uncertainty"] = q_unc(state, chosen_id)
            row[f"{side}_r5b_backup_known"] = int(backup_id is not None)
            row[f"{side}_r5b_backup_epa"] = qval(state, backup_id, "qb_epa")
            row[f"{side}_r5b_backup_cpoe"] = qval(state, backup_id, "qb_cpoe")
            ce, be = row[f"{side}_r5b_qb_epa"], row[f"{side}_r5b_backup_epa"]
            cc, bc = row[f"{side}_r5b_qb_cpoe"], row[f"{side}_r5b_backup_cpoe"]
            row[f"{side}_r5b_delta_epa"] = ce - be if np.isfinite(ce) and np.isfinite(be) else np.nan
            row[f"{side}_r5b_delta_cpoe"] = cc - bc if np.isfinite(cc) and np.isfinite(bc) else np.nan

        out.append(row)

        for team0 in [g.home_team, g.away_team]:
            team = team_norm(team0)
            z = qb_lk.get((str(g.game_id), team))
            if z is None or z.empty:
                continue
            primary = z.sort_values("qb_dropbacks", ascending=False).iloc[0]
            last_obs[team] = str(primary.qb_id)
            for qr in z.itertuples(index=False):
                qid = str(qr.qb_id)
                qs = state.setdefault(qid, {"v": {}, "dropbacks": 0})
                for k in ["qb_epa","qb_cpoe","qb_sack_rate"]:
                    v = getattr(qr, k)
                    if v is not None and np.isfinite(v):
                        old = qs["v"].get(k, np.nan)
                        qs["v"][k] = float(v) if not np.isfinite(old) else float((1-qb_alpha)*old + qb_alpha*float(v))
                qs["dropbacks"] += int(qr.qb_dropbacks)
    return pd.DataFrame(out)


def feature_sets():
    b = base.fsets()
    foundation = b["B3_OA_CORE"]
    id_metrics = [f"{s}_r5b_{k}" for s in ["home","away"] for k in [
        "qb_known","depth_rank","depth_fallback","changed_vs_last",
        "qb_epa","qb_cpoe","qb_sack_rate","qb_uncertainty",
    ]]
    availability = [f"{s}_r5b_{k}" for s in ["home","away"] for k in [
        "qb1_out","qb1_doubtful","qb1_questionable","qb1_injury_known","qb1_practice_dnp","replacement_used",
    ]]
    delta = [f"{s}_r5b_{k}" for s in ["home","away"] for k in [
        "backup_known","backup_epa","backup_cpoe","delta_epa","delta_cpoe",
    ]]
    return {
        "B4_PROXY_OA": b["B4_QB_OA"],
        "R5B_ID_OA": foundation + id_metrics,
        "R5B_ID_AVAIL_OA": foundation + id_metrics + availability,
        "R5B_ID_AVAIL_DELTA_OA": foundation + id_metrics + availability + delta,
    }


def design(df, cols):
    return df[cols]


def evaluate(x, test0, end):
    x = x[x.margin.ne(0)].copy()
    fs = feature_sets()
    bad = [c for cols in fs.values() for c in cols if any(t in c.lower() for t in base.FORBIDDEN)]
    if bad:
        raise RuntimeError(f"R5B market leak {bad}")
    preds, seasons = [], []
    for name, cols in fs.items():
        for y in range(test0, end+1):
            tr, te = x[x.season < y], x[x.season == y]
            if tr.empty or te.empty:
                continue
            c = base.tune_logit(tr, cols)
            m = base.pipe("logit", c)
            m.fit(design(tr, cols), tr.home_win.astype(int))
            p = np.clip(m.predict_proba(design(te, cols))[:,1], 1e-6, 1-1e-6)
            pr = {}
            for target in ["margin","game_total","home_score","away_score"]:
                a = base.tune_ridge(tr, cols, target)
                rm = base.pipe("ridge", a)
                rm.fit(design(tr, cols), tr[target])
                pr[target] = rm.predict(design(te, cols))
            q = pd.DataFrame({
                "game_id": te.game_id.to_numpy(), "season": y, "week": te.week.to_numpy(), "model": name,
                "y": te.home_win.to_numpy(), "p": p, "margin": te.margin.to_numpy(), "pm": pr["margin"],
                "game_total": te.game_total.to_numpy(), "pt": pr["game_total"], "home_score": te.home_score.to_numpy(),
                "ph": pr["home_score"], "away_score": te.away_score.to_numpy(), "pa": pr["away_score"],
            })
            q["lli"] = -(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p))
            preds.append(q)
            seasons.append({
                "model":name,"season":y,"n":len(q),"log_loss":log_loss(q.y,q.p),"brier":brier_score_loss(q.y,q.p),
                "accuracy":accuracy_score(q.y,q.p>=.5),"margin_mae":mean_absolute_error(q.margin,q.pm),
                "total_mae":mean_absolute_error(q.game_total,q.pt),
            })
    p = pd.concat(preds, ignore_index=True)
    summary=[]
    for n,g in p.groupby("model", sort=False):
        summary.append({"model":n,"n":len(g),"log_loss":log_loss(g.y,g.p),"brier":brier_score_loss(g.y,g.p),
                        "accuracy":accuracy_score(g.y,g.p>=.5),"margin_mae":mean_absolute_error(g.margin,g.pm),
                        "total_mae":mean_absolute_error(g.game_total,g.pt)})
    return pd.DataFrame(summary), pd.DataFrame(seasons), p


def cluster_bootstrap(p, a, b, reps=5000, seed=940830):
    x = p[p.model.eq(a)][["game_id","season","week","lli"]].rename(columns={"lli":"a"}).merge(
        p[p.model.eq(b)][["game_id","lli"]].rename(columns={"lli":"b"}), on="game_id")
    x["d"] = x.b-x.a
    arr=[g.d.to_numpy() for _,g in x.groupby(["season","week"], sort=False)]
    sums=np.array([v.sum() for v in arr]); counts=np.array([len(v) for v in arr])
    rng=np.random.default_rng(seed); vals=np.empty(reps)
    for i in range(reps):
        ix=rng.integers(0,len(arr),len(arr)); vals[i]=sums[ix].sum()/counts[ix].sum()
    lo,hi=np.quantile(vals,[.025,.975])
    return {"comparison":f"{b}-{a}","mean_logloss_delta":float(x.d.mean()),"ci95_low":float(lo),"ci95_high":float(hi),
            "improvement_supported_95":bool(hi<0),"games":len(x),"clusters":len(arr)}


def coverage(x):
    rows=[]
    for y,g in x.groupby("season"):
        for side in ["home","away"]:
            rows.append({
                "season":int(y),"side":side,"n":len(g),
                "qb_known_rate":float(g[f"{side}_r5b_qb_known"].mean()),
                "depth_fallback_rate":float(g[f"{side}_r5b_depth_fallback"].mean()),
                "changed_vs_last_rate":float(g[f"{side}_r5b_changed_vs_last"].mean()),
                "injury_known_rate":float(g[f"{side}_r5b_qb1_injury_known"].mean()),
                "qb1_out_rate":float(g[f"{side}_r5b_qb1_out"].mean()),
                "replacement_used_rate":float(g[f"{side}_r5b_replacement_used"].mean()),
            })
    return pd.DataFrame(rows)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--start-season",type=int,default=2012)
    ap.add_argument("--end-season",type=int,default=2025)
    ap.add_argument("--test-start",type=int,default=2018)
    ap.add_argument("--out-dir",default="nfl-r5b-output")
    ap.add_argument("--cache-dir",default=".cache/nflverse")
    a=ap.parse_args()
    seasons=list(range(a.start_season,a.end_season+1)); cache=Path(a.cache_dir); out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)

    games=base.schedule(cache,seasons)
    team_games,qb_games,pbp_prov=base.pbp_games(cache,seasons)
    x=base.dataset(games,team_games,qb_games)
    old_depth,new_depth,depth_prov=load_depth(cache,seasons)
    injuries,injury_prov=load_injuries(cache,seasons)
    qf=qb_features(games,qb_games,old_depth,new_depth,injuries)
    x=x.merge(qf,on=["game_id","season","week"],how="left",validate="one_to_one")
    x.to_parquet(out/"nfl_r5b_dataset.parquet",index=False)

    s,by,p=evaluate(x,a.test_start,a.end_season)
    s.to_csv(out/"nfl_r5b_model_summary.csv",index=False); by.to_csv(out/"nfl_r5b_by_season.csv",index=False)
    p.to_parquet(out/"nfl_r5b_oos_predictions.parquet",index=False)
    cov=coverage(x); cov.to_csv(out/"nfl_r5b_coverage.csv",index=False)
    comps=[("B4_PROXY_OA","R5B_ID_OA"),("B4_PROXY_OA","R5B_ID_AVAIL_OA"),("B4_PROXY_OA","R5B_ID_AVAIL_DELTA_OA"),
           ("R5B_ID_OA","R5B_ID_AVAIL_OA"),("R5B_ID_AVAIL_OA","R5B_ID_AVAIL_DELTA_OA")]
    boot=pd.DataFrame([cluster_bootstrap(p,a0,b0) for a0,b0 in comps]); boot.to_csv(out/"nfl_r5b_bootstrap.csv",index=False)

    manifest={
        "schemaVersion":"courtedge-nfl-r5b-qb-identity-availability.v1","researchOnly":True,
        "marketDataUsedAsFeatures":False,"targetActualStarterUsedAsFeature":False,
        "cutoffPolicy":"UTC midnight at start of target gameday; target-gameday depth/injury updates excluded",
        "pre2025DepthPolicy":"latest depth-chart week strictly earlier than target week; same-week un-timestamped depth charts forbidden",
        "2025DepthPolicy":"latest timestamped depth snapshot strictly before target-gameday UTC midnight",
        "injuryPolicy":"target-week injury row allowed only when date_modified is strictly before cutoff; OUT causes first non-OUT depth QB promotion",
        "identityCaveat":"2001-2024 depth data are week-labeled but lack original publication timestamps; lagging by >=1 week avoids same-week use but does not prove immutable historical publication provenance",
        "featureSets":feature_sets(),"pbpProvenance":pbp_prov,"depthProvenance":depth_prov,"injuryProvenance":injury_prov,
    }
    (out/"nfl_r5b_manifest.json").write_text(json.dumps(manifest,indent=2))
    audit={"marketLeakageCheck":"PASS","targetActualQBFeatureCheck":"PASS_NOT_USED","sameWeekUntimestampedDepth":"FORBIDDEN",
           "injuryTimestampFilter":"STRICT_LT_CUTOFF","validation":"NESTED_EXPANDING_SEASON_WALK_FORWARD"}
    (out/"nfl_r5b_audit.json").write_text(json.dumps(audit,indent=2))
    print("NFL_R5B_MODEL_SUMMARY"); print(s.to_string(index=False))
    print("NFL_R5B_BOOTSTRAP"); print(boot.to_string(index=False))
    print("NFL_R5B_COVERAGE"); print(cov.to_string(index=False))
    print("NFL_R5B_COMPLETE")

if __name__=="__main__":
    main()
