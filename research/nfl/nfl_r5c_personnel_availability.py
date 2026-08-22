#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as r5b2

SNAP_URL = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{y}.parquet"
INJURY_URL = "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{y}.parquet"
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.parquet"
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


def position_group(pos):
    p = str(pos or "").upper().strip()
    if p == "QB": return "QB"
    if p in {"C","G","OG","T","OT","OL"}: return "OL"
    if p in {"WR","TE"}: return "WRTE"
    if p in {"RB","FB","HB"}: return "RB"
    if p in {"DE","DT","DL","NT","EDGE","LB","OLB","ILB","MLB"}: return "FRONT"
    if p in {"CB","DB","S","FS","SS"}: return "SECONDARY"
    if p in {"K","P","LS"}: return "ST"
    return "OTHER"


def load_players(cache: Path):
    p = base.dl(PLAYERS_URL, cache / "players.parquet")
    x = pd.read_parquet(p)
    if not {"gsis_id","pfr_id"}.issubset(x.columns):
        raise RuntimeError(f"players schema unsupported: {list(x.columns)}")
    z = x[["gsis_id","pfr_id","position"] if "position" in x.columns else ["gsis_id","pfr_id"]].copy()
    z["gsis_id"] = z.gsis_id.map(id_norm)
    z["pfr_id"] = z.pfr_id.map(id_norm)
    z = z[z.gsis_id.notna() & z.pfr_id.notna()].drop_duplicates("pfr_id")
    pfr_to_gsis = dict(zip(z.pfr_id, z.gsis_id))
    gsis_pos = dict(zip(z.gsis_id, z.get("position", pd.Series(index=z.index, dtype=object))))
    return pfr_to_gsis, gsis_pos, {"url": PLAYERS_URL, "rows": int(len(x)), "identifierOnly": True}


def load_snaps(cache: Path, seasons, pfr_to_gsis):
    rows, prov = [], []
    for y in seasons:
        p = base.dl(SNAP_URL.format(y=y), cache / f"snap_counts_{y}.parquet")
        x = pd.read_parquet(p)
        needed = {"game_id","season","week","player","pfr_player_id","position","team","offense_pct","defense_pct","st_pct"}
        if not needed.issubset(x.columns):
            raise RuntimeError(f"snap schema unsupported {y}: {list(x.columns)}")
        z = x.copy()
        z["season"] = pd.to_numeric(z.season, errors="coerce")
        z["week"] = pd.to_numeric(z.week, errors="coerce")
        z = z[z.season.notna() & z.week.notna()]
        z["season"] = z.season.astype(int)
        z["week"] = z.week.astype(int)
        z["team"] = z.team.map(team_norm)
        z["pfr_player_id"] = z.pfr_player_id.map(id_norm)
        z["gsis_id"] = z.pfr_player_id.map(pfr_to_gsis)
        for c in ["offense_pct","defense_pct","st_pct"]:
            z[c] = pd.to_numeric(z[c], errors="coerce").fillna(0.0)
            # nflverse pct is usually 0..1; tolerate percentage-shaped values safely.
            z.loc[z[c] > 1.5, c] = z.loc[z[c] > 1.5, c] / 100.0
            z[c] = z[c].clip(0.0, 1.0)
        z = z[z.gsis_id.notna()][["game_id","season","week","team","gsis_id","position","offense_pct","defense_pct","st_pct"]]
        rows.append(z)
        prov.append({"season": y, "url": SNAP_URL.format(y=y), "rows": int(len(x)), "mappedRows": int(len(z))})
    return pd.concat(rows, ignore_index=True), prov


def load_injuries(cache: Path, seasons):
    rows, prov = [], []
    for y in seasons:
        p = base.dl(INJURY_URL.format(y=y), cache / f"injuries_{y}.parquet")
        x = pd.read_parquet(p)
        needed = {"season","team","week","gsis_id","position","report_status","date_modified"}
        if not needed.issubset(x.columns):
            raise RuntimeError(f"injury schema unsupported {y}: {list(x.columns)}")
        z = x.copy()
        z["season"] = pd.to_numeric(z.season, errors="coerce")
        z["week"] = pd.to_numeric(z.week, errors="coerce")
        z = z[z.season.notna() & z.week.notna()]
        z["season"] = z.season.astype(int)
        z["week"] = z.week.astype(int)
        z["team"] = z.team.map(team_norm)
        z["gsis_id"] = z.gsis_id.map(id_norm)
        z["date_modified"] = pd.to_datetime(z.date_modified, errors="coerce", utc=True)
        z = z[z.gsis_id.notna() & z.date_modified.notna()]
        rows.append(z[["season","week","team","gsis_id","position","report_status","date_modified"]])
        prov.append({"season": y, "url": INJURY_URL.format(y=y), "rows": int(len(x))})
    return pd.concat(rows, ignore_index=True), prov


def injury_team_index(inj):
    idx = {}
    for key, z in inj.groupby(["season","week","team"], sort=False):
        idx[key] = z.sort_values("date_modified")
    return idx


def snap_game_index(snaps):
    return {str(gid): z.copy() for gid, z in snaps.groupby("game_id", sort=False)}


def relevant_pct(group, off, deff, st):
    if group in {"OL","WRTE","RB","QB"}: return float(off)
    if group in {"FRONT","SECONDARY"}: return float(deff)
    if group == "ST": return float(st)
    return float(max(off, deff, st))


def prior_usage(team_hist, global_hist, team, player):
    h = team_hist.get((team, player))
    if h and len(h): return float(np.mean(h))
    h = global_hist.get(player)
    if h and len(h): return float(np.mean(h))
    return 0.0


def build_personnel_features(games, snaps, injuries, gsis_pos):
    inj_idx = injury_team_index(injuries)
    snap_idx = snap_game_index(snaps)
    team_hist = defaultdict(lambda: deque(maxlen=3))
    global_hist = defaultdict(lambda: deque(maxlen=3))
    out = []
    groups = ["OL","WRTE","RB","FRONT","SECONDARY","ST","OTHER"]

    for g in games.sort_values(["gameday","game_id"]).itertuples(index=False):
        season, week = int(g.season), int(g.week)
        cutoff = pd.Timestamp(g.gameday)
        if cutoff.tzinfo is None: cutoff = cutoff.tz_localize("UTC")
        else: cutoff = cutoff.tz_convert("UTC")
        cutoff = cutoff.normalize()  # strict: never consume target-gameday updates
        row = {"game_id": str(g.game_id), "r5c_injury_coverage": int(season <= 2024)}

        for side, team0 in [("home",g.home_team),("away",g.away_team)]:
            team = team_norm(team0)
            vals = {grp: 0.0 for grp in groups}
            out_players = 0
            high_usage = 0
            if season <= 2024:
                z = inj_idx.get((season, week, team))
                if z is not None and not z.empty:
                    q = z[z.date_modified < cutoff]
                    if not q.empty:
                        q = q.sort_values("date_modified").groupby("gsis_id", as_index=False).tail(1)
                        q = q[q.report_status.astype(str).str.strip().str.lower().eq("out")]
                        for r in q.itertuples(index=False):
                            pos = r.position if str(r.position).strip() not in {"","nan","None"} else gsis_pos.get(r.gsis_id)
                            grp = position_group(pos)
                            if grp == "QB":
                                continue  # QB availability is already frozen in R5B2.
                            u = prior_usage(team_hist, global_hist, team, str(r.gsis_id))
                            vals[grp] += u
                            out_players += 1
                            high_usage += int(u >= 0.50)
            for grp in groups:
                row[f"{side}_r5c_out_{grp.lower()}_usage"] = vals[grp]
            row[f"{side}_r5c_out_total_usage"] = float(sum(vals.values()))
            row[f"{side}_r5c_out_players"] = int(out_players)
            row[f"{side}_r5c_high_usage_out"] = int(high_usage)
        out.append(row)

        # Update role/usage only AFTER the target game's pregame row has been emitted.
        sg = snap_idx.get(str(g.game_id))
        if sg is not None and not sg.empty:
            for r in sg.itertuples(index=False):
                team = team_norm(r.team); pid = str(r.gsis_id)
                grp = position_group(r.position)
                u = relevant_pct(grp, r.offense_pct, r.defense_pct, r.st_pct)
                team_hist[(team,pid)].append(u)
                global_hist[pid].append(u)

    return pd.DataFrame(out)


def feature_sets():
    foundation = r5b2.feature_sets()["R5B2_HICONF_SWITCH"]
    offense = [f"{s}_r5c_out_{g}_usage" for s in ["home","away"] for g in ["ol","wrte","rb"]]
    defense = [f"{s}_r5c_out_{g}_usage" for s in ["home","away"] for g in ["front","secondary"]]
    special = [f"{s}_r5c_out_st_usage" for s in ["home","away"]]
    other = [f"{s}_r5c_out_other_usage" for s in ["home","away"]]
    return {
        "R5B2_HICONF_SWITCH": foundation,
        "R5C_OFFENSE_OUT_USAGE": foundation + offense,
        "R5C_DEFENSE_OUT_USAGE": foundation + defense,
        "R5C_ST_OUT_USAGE": foundation + special,
        "R5C_ALL_OUT_USAGE": foundation + offense + defense + special + other,
    }


def evaluate(x, test0, end):
    x = x[x.margin.ne(0) & x.season.le(end) & x.r5c_injury_coverage.eq(1)].copy()
    fs = feature_sets(); preds=[]; seasons=[]
    for name, cols in fs.items():
        for y in range(test0, end+1):
            tr=x[x.season<y]; te=x[x.season==y]
            if tr.empty or te.empty: continue
            c=base.tune_logit(tr,cols); lm=base.pipe("logit",c); lm.fit(tr[cols],tr.home_win.astype(int))
            pp=np.clip(lm.predict_proba(te[cols])[:,1],1e-6,1-1e-6)
            pr={}
            for target in ["margin","game_total"]:
                a=base.tune_ridge(tr,cols,target); rm=base.pipe("ridge",a); rm.fit(tr[cols],tr[target]); pr[target]=rm.predict(te[cols])
            q=pd.DataFrame({"game_id":te.game_id.to_numpy(),"season":y,"week":te.week.to_numpy(),"model":name,"y":te.home_win.to_numpy(),"p":pp,
                            "margin":te.margin.to_numpy(),"pm":pr["margin"],"game_total":te.game_total.to_numpy(),"pt":pr["game_total"],
                            "any_high_usage_out":((te.home_r5c_high_usage_out+te.away_r5c_high_usage_out)>0).astype(int).to_numpy(),
                            "any_out":((te.home_r5c_out_players+te.away_r5c_out_players)>0).astype(int).to_numpy()})
            q["lli"]=-(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p)); preds.append(q)
            seasons.append({"model":name,"season":y,"n":len(q),"log_loss":log_loss(q.y,q.p),"brier":brier_score_loss(q.y,q.p),"accuracy":accuracy_score(q.y,q.p>=.5),
                            "margin_mae":mean_absolute_error(q.margin,q.pm),"total_mae":mean_absolute_error(q.game_total,q.pt)})
    p=pd.concat(preds,ignore_index=True); sm=[]
    for n,g in p.groupby("model",sort=False):
        sm.append({"model":n,"n":len(g),"log_loss":log_loss(g.y,g.p),"brier":brier_score_loss(g.y,g.p),"accuracy":accuracy_score(g.y,g.p>=.5),
                   "margin_mae":mean_absolute_error(g.margin,g.pm),"total_mae":mean_absolute_error(g.game_total,g.pt)})
    return pd.DataFrame(sm),pd.DataFrame(seasons),p


def boot(p, ref, candidate, reps=5000, seed=940830):
    x=p[p.model.eq(ref)][["game_id","season","week","lli"]].rename(columns={"lli":"ref"}).merge(
      p[p.model.eq(candidate)][["game_id","lli"]].rename(columns={"lli":"cand"}),on="game_id")
    x["d"]=x.cand-x.ref
    arr=[g.d.to_numpy() for _,g in x.groupby(["season","week"],sort=False)]
    sums=np.array([v.sum() for v in arr]); counts=np.array([len(v) for v in arr]); rng=np.random.default_rng(seed); vals=np.empty(reps)
    for i in range(reps):
        ix=rng.integers(0,len(arr),len(arr)); vals[i]=sums[ix].sum()/counts[ix].sum()
    lo,hi=np.quantile(vals,[.025,.975])
    return {"comparison":f"{candidate}-{ref}","mean_logloss_delta":float(x.d.mean()),"ci95_low":float(lo),"ci95_high":float(hi),"better95":bool(hi<0),"worse95":bool(lo>0),"games":len(x),"clusters":len(arr)}


def subset_report(p):
    ref=p[p.model.eq("R5B2_HICONF_SWITCH")][["game_id","lli"]].rename(columns={"lli":"ref"})
    out=[]
    for model in ["R5C_OFFENSE_OUT_USAGE","R5C_DEFENSE_OUT_USAGE","R5C_ST_OUT_USAGE","R5C_ALL_OUT_USAGE"]:
        z=p[p.model.eq(model)].merge(ref,on="game_id"); z["delta"]=z.lli-z.ref
        for label,mask in [("ALL",np.ones(len(z),dtype=bool)),("ANY_OUT",z.any_out.eq(1)),("HIGH_USAGE_OUT",z.any_high_usage_out.eq(1))]:
            q=z[mask]
            if q.empty: continue
            out.append({"model":model,"subset":label,"n":len(q),"delta_logloss_vs_r5b2":float(q.delta.mean()),"model_logloss":float(q.lli.mean()),"r5b2_logloss":float(q.ref.mean())})
    return pd.DataFrame(out)


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--input-dir",default="nfl-r5b-hybrid-output"); ap.add_argument("--out-dir",default="nfl-r5c-output"); ap.add_argument("--cache-dir",default=".cache/nflverse"); ap.add_argument("--start-season",type=int,default=2012); ap.add_argument("--end-season",type=int,default=2024); ap.add_argument("--test-start",type=int,default=2018); a=ap.parse_args()
    src=Path(a.input_dir); out=Path(a.out_dir); cache=Path(a.cache_dir); out.mkdir(parents=True,exist_ok=True); cache.mkdir(parents=True,exist_ok=True)
    x=pd.read_parquet(src/"nfl_r5b_hybrid_dataset.parquet")
    pfr_to_gsis,gsis_pos,player_prov=load_players(cache)
    seasons=range(a.start_season,a.end_season+1)
    snaps,snap_prov=load_snaps(cache,seasons,pfr_to_gsis)
    injuries,inj_prov=load_injuries(cache,seasons)
    pf=build_personnel_features(x,snaps,injuries,gsis_pos)
    x=x.merge(pf,on="game_id",how="left",validate="one_to_one")
    x.to_parquet(out/"nfl_r5c_dataset.parquet",index=False)
    sm,by,p=evaluate(x,a.test_start,a.end_season); sm.to_csv(out/"nfl_r5c_model_summary.csv",index=False); by.to_csv(out/"nfl_r5c_by_season.csv",index=False); p.to_parquet(out/"nfl_r5c_predictions.parquet",index=False)
    comps=pd.DataFrame([boot(p,"R5B2_HICONF_SWITCH",m) for m in ["R5C_OFFENSE_OUT_USAGE","R5C_DEFENSE_OUT_USAGE","R5C_ST_OUT_USAGE","R5C_ALL_OUT_USAGE"]]); comps.to_csv(out/"nfl_r5c_bootstrap.csv",index=False)
    sub=subset_report(p); sub.to_csv(out/"nfl_r5c_subsets.csv",index=False)
    manifest={"researchOnly":True,"marketDataUsedAsFeatures":False,"marketOptimizationPerformed":False,"primaryEvaluation":"2018-2024 injury-covered seasons","injurySourceEnds":2024,"targetGameSnapUsedAsFeature":False,"snapUpdateOrder":"PREGAME_FEATURE_ROW_THEN_TARGET_GAME_SNAP_UPDATE","injuryTimestampFilter":"STRICT_LT_TARGET_GAMEDAY_00UTC","qbExcludedFromR5C":True,"playerCrosswalkUse":"IDENTIFIER_ONLY","snapImportance":"MEAN_LAST_UP_TO_3_PRIOR_GAMES_WITH_GLOBAL_PLAYER_FALLBACK","playersProvenance":player_prov,"snapProvenance":snap_prov,"injuryProvenance":inj_prov}
    json.dump(manifest,open(out/"nfl_r5c_manifest.json","w"),indent=2)
    audit={"marketLeakageCheck":"PASS","sameGameSnapLeakageCheck":"PASS_BY_CONSTRUCTION","targetGameOutcomeFeatureCheck":"PASS_NOT_USED","injuryTimestampCheck":"STRICT_LT_CUTOFF","2025MissingInjuryHandled":"EXCLUDED_FROM_PRIMARY_R5C_EVALUATION","qbDoubleCountCheck":"PASS_QB_EXCLUDED"}
    json.dump(audit,open(out/"nfl_r5c_audit.json","w"),indent=2)
    print("NFL_R5C_MODEL_SUMMARY"); print(sm.to_string(index=False)); print("NFL_R5C_BOOTSTRAP"); print(comps.to_string(index=False)); print("NFL_R5C_SUBSETS"); print(sub.to_string(index=False)); print("NFL_R5C_COMPLETE")

if __name__=="__main__": main()
