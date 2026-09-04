#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as r5b2

NGS_URL = "https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_{kind}.parquet"
TEAM_MAP = {"OAK":"LV","SD":"LAC","STL":"LA","LAR":"LA","JAC":"JAX","WSH":"WAS"}
NGS_ALPHA = 0.25
OFFSEASON_DECAY = 0.75

PASS_METRICS = [
    "avg_time_to_throw",
    "avg_intended_air_yards",
    "aggressiveness",
    "expected_completion_percentage",
    "completion_percentage_above_expectation",
    "avg_air_yards_to_sticks",
]
REC_METRICS = [
    "avg_cushion",
    "avg_separation",
    "avg_yac",
    "avg_expected_yac",
    "avg_yac_above_expectation",
]
RUSH_METRICS = [
    "efficiency",
    "percent_attempts_gte_eight_defenders",
    "avg_time_to_los",
    "rush_yards_over_expected_per_att",
    "rush_pct_over_expected",
]


def team_norm(x):
    s = str(x).upper().strip()
    return TEAM_MAP.get(s, s)


def load_ngs(cache: Path, kind: str):
    p = base.dl(NGS_URL.format(kind=kind), cache / f"ngs_{kind}.parquet")
    x = pd.read_parquet(p)
    need = {"season", "week", "team_abbr"}
    if not need.issubset(x.columns):
        raise RuntimeError(f"R5E {kind} schema missing {sorted(need-set(x.columns))}; got={list(x.columns)}")
    x = x.copy()
    if "season_type" in x:
        x = x[x.season_type.astype(str).str.upper().eq("REG")]
    x["season"] = pd.to_numeric(x.season, errors="coerce")
    x["week"] = pd.to_numeric(x.week, errors="coerce")
    x = x[x.season.notna() & x.week.notna()]
    x["season"] = x.season.astype(int)
    x["week"] = x.week.astype(int)
    x = x[x.week.gt(0)]  # week 0 is season summary and is forbidden
    x["team"] = x.team_abbr.map(team_norm)
    return x, {"kind":kind,"url":NGS_URL.format(kind=kind),"rows":int(len(x)),"columns":list(x.columns)}


def weighted_mean(g, metric, weight):
    if metric not in g:
        return np.nan
    v = pd.to_numeric(g[metric], errors="coerce")
    ok = v.notna() & np.isfinite(v)
    if not ok.any():
        return np.nan
    if weight in g:
        w = pd.to_numeric(g[weight], errors="coerce").fillna(0.0).clip(lower=0.0)
        q = ok & w.gt(0)
        if q.any() and float(w[q].sum()) > 0:
            return float(np.average(v[q], weights=w[q]))
    return float(v[ok].mean())


def weekly_team(x, metrics, weight):
    rows=[]
    for (season,week,team), g in x.groupby(["season","week","team"], sort=False):
        r={"season":int(season),"week":int(week),"team":team}
        for m in metrics:
            r[m]=weighted_mean(g,m,weight)
        rows.append(r)
    return pd.DataFrame(rows)


def ew_update(old, new, alpha=NGS_ALPHA):
    if new is None or not np.isfinite(new):
        return old
    if old is None or not np.isfinite(old):
        return float(new)
    return float((1-alpha)*old + alpha*float(new))


def build_pregame_ngs(games, passing, receiving, rushing):
    pw = weekly_team(passing, PASS_METRICS, "attempts")
    rw = weekly_team(receiving, REC_METRICS, "targets")
    uw = weekly_team(rushing, RUSH_METRICS, "rush_attempts")
    look={
        "pass": {(int(r.season),int(r.week),team_norm(r.team)):r._asdict() for r in pw.itertuples(index=False)},
        "rec": {(int(r.season),int(r.week),team_norm(r.team)):r._asdict() for r in rw.itertuples(index=False)},
        "rush": {(int(r.season),int(r.week),team_norm(r.team)):r._asdict() for r in uw.itertuples(index=False)},
    }
    blocks={"pass":PASS_METRICS,"rec":REC_METRICS,"rush":RUSH_METRICS}
    state={}
    current_season=None
    rows=[]

    def team_state(team):
        return state.setdefault(team, {
            "pass":{},"rec":{},"rush":{},
            "n_pass":0,"n_rec":0,"n_rush":0,
            "season_n_pass":0,"season_n_rec":0,"season_n_rush":0,
        })

    for g in games.sort_values(["gameday","game_id"]).itertuples(index=False):
        season=int(g.season); week=int(g.week)
        if current_season is not None and season != current_season:
            for st in state.values():
                for block, metrics in blocks.items():
                    for m in metrics:
                        v=st[block].get(m,np.nan)
                        if np.isfinite(v): st[block][m]=float(v)*OFFSEASON_DECAY
                    st[f"season_n_{block}"]=0
        current_season=season

        row={"game_id":str(g.game_id),"season":season,"week":week}
        for side, team0 in (("home",g.home_team),("away",g.away_team)):
            team=team_norm(team0); st=team_state(team)
            for block, metrics in blocks.items():
                known=int(st[f"n_{block}"]>0)
                row[f"{side}_ngs_{block}_known"]=known
                row[f"{side}_ngs_{block}_uncertainty"]=1/math.sqrt(st[f"season_n_{block}"]+2.0)
                for m in metrics:
                    row[f"{side}_ngs_{block}_{m}"]=st[block].get(m,np.nan)
        rows.append(row)

        # CRITICAL LEAKAGE LOCK: only after target-game row is emitted do we ingest
        # the NGS record for that team's target week. Thus target-week NGS is never
        # available to the target prediction.
        for team0 in (g.home_team,g.away_team):
            team=team_norm(team0); st=team_state(team)
            for block, metrics in blocks.items():
                obs=look[block].get((season,week,team))
                if obs is None:
                    continue
                any_obs=False
                for m in metrics:
                    v=obs.get(m,np.nan)
                    if v is not None and np.isfinite(v):
                        st[block][m]=ew_update(st[block].get(m,np.nan),float(v))
                        any_obs=True
                if any_obs:
                    st[f"n_{block}"] += 1
                    st[f"season_n_{block}"] += 1
    return pd.DataFrame(rows)


def ngs_cols(block, metrics):
    return [
        c
        for side in ("home","away")
        for c in ([f"{side}_ngs_{block}_known",f"{side}_ngs_{block}_uncertainty"] + [f"{side}_ngs_{block}_{m}" for m in metrics])
    ]


def feature_sets():
    foundation=r5b2.feature_sets()["R5B2_HICONF_SWITCH"]
    pc=ngs_cols("pass",PASS_METRICS)
    rc=ngs_cols("rec",REC_METRICS)
    uc=ngs_cols("rush",RUSH_METRICS)
    return {
        "R5B2_MODERN_REFERENCE": foundation,
        "R5E_NGS_PASS": foundation+pc,
        "R5E_NGS_RECEIVING": foundation+rc,
        "R5E_NGS_RUSHING": foundation+uc,
        "R5E_NGS_PASS_REC": foundation+pc+rc,
        "R5E_NGS_ALL": foundation+pc+rc+uc,
    }


def evaluate(x, train_start, test_start, end):
    x=x[x.margin.ne(0) & x.season.ge(train_start) & x.season.le(end)].copy()
    preds=[]; seasons=[]
    for name, cols in feature_sets().items():
        for y in range(test_start,end+1):
            tr=x[(x.season>=train_start)&(x.season<y)]
            te=x[x.season.eq(y)]
            if tr.empty or te.empty: continue
            c=base.tune_logit(tr,cols); lm=base.pipe("logit",c); lm.fit(tr[cols],tr.home_win.astype(int))
            pp=np.clip(lm.predict_proba(te[cols])[:,1],1e-6,1-1e-6)
            pr={}
            for target in ("margin","game_total"):
                a=base.tune_ridge(tr,cols,target); rm=base.pipe("ridge",a); rm.fit(tr[cols],tr[target]); pr[target]=rm.predict(te[cols])
            q=pd.DataFrame({
                "game_id":te.game_id.to_numpy(),"season":y,"week":te.week.to_numpy(),"model":name,
                "y":te.home_win.to_numpy(),"p":pp,"margin":te.margin.to_numpy(),"pm":pr["margin"],
                "game_total":te.game_total.to_numpy(),"pt":pr["game_total"],
            })
            q["lli"]=-(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p)); preds.append(q)
            seasons.append({"model":name,"season":y,"n":len(q),"log_loss":log_loss(q.y,q.p),"brier":brier_score_loss(q.y,q.p),
                            "accuracy":accuracy_score(q.y,q.p>=.5),"margin_mae":mean_absolute_error(q.margin,q.pm),"total_mae":mean_absolute_error(q.game_total,q.pt)})
    p=pd.concat(preds,ignore_index=True)
    summary=[]
    for name,g in p.groupby("model",sort=False):
        summary.append({"model":name,"n":len(g),"log_loss":log_loss(g.y,g.p),"brier":brier_score_loss(g.y,g.p),
                        "accuracy":accuracy_score(g.y,g.p>=.5),"margin_mae":mean_absolute_error(g.margin,g.pm),"total_mae":mean_absolute_error(g.game_total,g.pt)})
    return pd.DataFrame(summary),pd.DataFrame(seasons),p


def boot(p,candidate,reps=5000,seed=940830):
    ref=p[p.model.eq("R5B2_MODERN_REFERENCE")][["game_id","season","week","lli"]].rename(columns={"lli":"ref"})
    z=ref.merge(p[p.model.eq(candidate)][["game_id","lli"]].rename(columns={"lli":"cand"}),on="game_id")
    z["d"]=z.cand-z.ref
    groups=[g.d.to_numpy() for _,g in z.groupby(["season","week"],sort=False)]
    sums=np.array([v.sum() for v in groups]); counts=np.array([len(v) for v in groups])
    rng=np.random.default_rng(seed); vals=np.empty(reps)
    for i in range(reps):
        ix=rng.integers(0,len(groups),len(groups)); vals[i]=sums[ix].sum()/counts[ix].sum()
    lo,hi=np.quantile(vals,[.025,.975])
    return {"comparison":f"{candidate}-R5B2_MODERN_REFERENCE","mean_logloss_delta":float(z.d.mean()),
            "ci95_low":float(lo),"ci95_high":float(hi),"better95":bool(hi<0),"worse95":bool(lo>0),"games":len(z),"clusters":len(groups)}


def week_bands(p):
    z=p.copy(); z["week_band"]=pd.cut(z.week,bins=[0,4,9,14,18],labels=["W01_04","W05_09","W10_14","W15_18"])
    rows=[]
    for (model,band),g in z.groupby(["model","week_band"],observed=True):
        rows.append({"model":model,"week_band":str(band),"n":len(g),"log_loss":log_loss(g.y,g.p),"accuracy":accuracy_score(g.y,g.p>=.5)})
    return pd.DataFrame(rows)


def coverage(x):
    rows=[]
    for y,g in x[x.season.ge(2016)].groupby("season"):
        r={"season":int(y),"games":int(len(g))}
        for block in ("pass","rec","rush"):
            vals=[]
            for side in ("home","away"):
                vals.extend(g[f"{side}_ngs_{block}_known"].fillna(0).astype(float).tolist())
            r[f"{block}_known_rate"]=float(np.mean(vals)) if vals else 0.0
        rows.append(r)
    return pd.DataFrame(rows)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-dir",default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir",default="nfl-r5e-output")
    ap.add_argument("--cache-dir",default=".cache/nflverse")
    ap.add_argument("--start-season",type=int,default=2016)
    ap.add_argument("--end-season",type=int,default=2025)
    ap.add_argument("--test-start",type=int,default=2018)
    a=ap.parse_args()
    src=Path(a.input_dir); out=Path(a.out_dir); cache=Path(a.cache_dir); out.mkdir(parents=True,exist_ok=True); cache.mkdir(parents=True,exist_ok=True)

    x=pd.read_parquet(src/"nfl_r5b_hybrid_dataset.parquet")
    # Re-attach only schedule identity fields required to align team NGS states.
    games=base.schedule(cache,list(range(a.start_season,a.end_season+1)))
    idcols=games[["game_id","season","week","gameday","home_team","away_team"]].copy()
    x=x.merge(idcols,on=["game_id","season","week"],how="inner",validate="one_to_one")

    passing,pprov=load_ngs(cache,"passing")
    receiving,rprov=load_ngs(cache,"receiving")
    rushing,uprov=load_ngs(cache,"rushing")
    passing=passing[passing.season.between(a.start_season,a.end_season)]
    receiving=receiving[receiving.season.between(a.start_season,a.end_season)]
    rushing=rushing[rushing.season.between(a.start_season,a.end_season)]
    ng=build_pregame_ngs(games,passing,receiving,rushing)
    x=x.merge(ng,on=["game_id","season","week"],how="left",validate="one_to_one")

    bad=[c for c in x.columns if any(t in c.lower() for t in base.FORBIDDEN)]
    if bad: raise RuntimeError(f"R5E market column leak {bad}")
    fbad=[c for vv in feature_sets().values() for c in vv if any(t in c.lower() for t in base.FORBIDDEN)]
    if fbad: raise RuntimeError(f"R5E market feature leak {fbad}")

    x.to_parquet(out/"nfl_r5e_dataset.parquet",index=False)
    s,by,p=evaluate(x,a.start_season,a.test_start,a.end_season)
    s.to_csv(out/"nfl_r5e_model_summary.csv",index=False); by.to_csv(out/"nfl_r5e_by_season.csv",index=False); p.to_parquet(out/"nfl_r5e_predictions.parquet",index=False)
    candidates=[m for m in feature_sets() if m!="R5B2_MODERN_REFERENCE"]
    bt=pd.DataFrame([boot(p,m) for m in candidates]); bt.to_csv(out/"nfl_r5e_bootstrap.csv",index=False)
    wb=week_bands(p); wb.to_csv(out/"nfl_r5e_week_bands.csv",index=False)
    cov=coverage(x); cov.to_csv(out/"nfl_r5e_coverage.csv",index=False)

    manifest={
        "schemaVersion":"courtedge-nfl-r5e-nextgen-stats.v1","researchOnly":True,"marketDataUsedAsFeatures":False,
        "ngsPublicCoverageStart":2016,"primaryTrainStart":a.start_season,"testStart":a.test_start,"endSeason":a.end_season,
        "targetWeekNGSUsedAsFeature":False,"weekZeroSeasonSummaryUsed":False,"ngsAlpha":NGS_ALPHA,"offseasonDecay":OFFSEASON_DECAY,
        "publicationCustody":"Weekly NGS is lagged by construction; target-team target-week NGS is ingested only after emitting target pregame row. Exact immutable historical publication timestamp is not claimed.",
        "featureBlocks":{"passing":PASS_METRICS,"receiving":REC_METRICS,"rushing":RUSH_METRICS},"featureSets":feature_sets(),
        "provenance":[pprov,rprov,uprov],
    }
    (out/"nfl_r5e_manifest.json").write_text(json.dumps(manifest,indent=2))
    audit={"marketLeakageCheck":"PASS","sameTargetWeekNGSLeakageCheck":"PASS_BY_CONSTRUCTION","weekZeroSummaryCheck":"FORBIDDEN",
           "validation":"NESTED_EXPANDING_SEASON_WALK_FORWARD_MODERN_2016_PLUS","postHocFeatureBlockSelection":"NONE"}
    (out/"nfl_r5e_audit.json").write_text(json.dumps(audit,indent=2))

    print("NFL_R5E_MODEL_SUMMARY"); print(s.to_string(index=False))
    print("NFL_R5E_BOOTSTRAP"); print(bt.to_string(index=False))
    print("NFL_R5E_COVERAGE"); print(cov.to_string(index=False))
    print("NFL_R5E_WEEK_BANDS"); print(wb.to_string(index=False))
    print("NFL_R5E_COMPLETE")

if __name__=="__main__": main()
