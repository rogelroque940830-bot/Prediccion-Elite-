#!/usr/bin/env python3
import argparse, gzip, importlib.util, json, math, os
from collections import Counter
import numpy as np

SCHEMA="courtedge-mlb-unified-elite-live-authority.v1"
SEASONS=("2022","2023","2024","2025","2026_YTD")
VARIANTS={
  "F3_RL_HOME_PLUS_0_5":"F3",
  "F5_ML":"F5",
  "F5_RL_HOME_MINUS_0_5":"F5",
  "F5_RL_HOME_PLUS_0_5":"F5",
  "FG_ML":"FG",
  "FG_RL_HOME_MINUS_1_5":"FG",
  "FG_RL_HOME_PLUS_1_5":"FG",
}
PREMIUM_PILLARS=("team_win10_diff","starter_kbb_adv","lineup_exposure_rate_adv")

def args():
  p=argparse.ArgumentParser()
  for n in ("root","custody","multi-scorer","multi-contract","modular-scorer","modular-contract","full-scorer","full-contract","out"):
    p.add_argument("--"+n,required=True)
  return p.parse_args()

def load(path):
  with open(path,encoding="utf-8") as f:return json.load(f)

def mod(path,name):
  s=importlib.util.spec_from_file_location(name,path)
  if not s or not s.loader: raise SystemExit("AUTHORITY_IMPORT_FAILED:"+path)
  m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def py(v):
  if isinstance(v,np.ndarray): return [py(x) for x in v.tolist()]
  if isinstance(v,(np.floating,)): return float(v)
  if isinstance(v,(np.integer,)): return int(v)
  if isinstance(v,dict): return {str(k):py(x) for k,x in v.items() if k!="_prep"}
  if isinstance(v,(list,tuple)): return [py(x) for x in v]
  return v

def finite(v):
  try:
    x=float(v);return x if math.isfinite(x) else math.nan
  except Exception:return math.nan

def main():
  a=args();multi=mod(a.multi_scorer,"auth_multi");modular=mod(a.modular_scorer,"auth_modular");full=mod(a.full_scorer,"auth_full")
  mc=load(a.multi_contract);fc=load(a.full_contract);modc=load(a.modular_contract)
  if mc.get("schemaVersion")!="courtedge-mlb-multi-market-coverage-expansion-contract.v1": raise SystemExit("AUTH_MULTI_CONTRACT")
  if fc.get("schemaVersion")!="courtedge-mlb-market-state-matchup-modular-router-contract.v1": raise SystemExit("AUTH_FULL_CONTRACT")
  if modc.get("schemaVersion")!="courtedge-mlb-modular-team-structure-nrfi-yrfi-contract.v1": raise SystemExit("AUTH_MODULAR_CONTRACT")
  with gzip.open(a.custody,"rt",encoding="utf-8") as f: custody=[json.loads(x) for x in f if x.strip()]
  if len(custody)!=11407: raise SystemExit(f"AUTH_CUSTODY_ROWS:{len(custody)}")
  snapshots,_=modular.build_standings_snapshots(a.root,int(fc["teamState"]["minimumPriorGamesForStableTier"]))
  joined,_=modular.load_joined_rows(a.root,custody,snapshots)
  by={s:[r for r in joined if r["season"]==s] for s in SEASONS}
  expected={"2022":2398,"2023":2399,"2024":2406,"2025":2423,"2026_YTD":1781}
  if {s:len(by[s]) for s in SEASONS}!=expected: raise SystemExit("AUTH_SEASON_COUNT_DRIFT")
  source_index={(r["season"],int(r["gamePk"])):r for r in joined}

  direction={}; margin_2023={}
  for h in ("F3","F5","FG"):
    features=list(mc["directionalMarginModels"]["features"][h])
    x,prep=multi.fit_matrix(by["2022"],features)
    y=np.asarray([multi.margin_class(r[f"{h}_diff"],h) for r in by["2022"]],dtype=int)
    k=4 if h=="FG" else 5
    w=multi.fit_multinomial(x,y,k,float(mc["directionalMarginModels"]["l2Strength"]),int(mc["directionalMarginModels"]["maxIter"]))
    margin_2023[h]=multi.predict_multinomial(multi.apply_matrix(by["2023"],prep),w,k)
    direction[h]={"features":features,"classCount":k,"median":py(prep["median"]),"mean":py(prep["mean"]),"scale":py(prep["scale"]),"weights":py(w)}

  minp=float(fc["qualityFrontiers"]["minimumSelectedSideModelProbability"]); quantiles=[.80,.85,.90,.95]
  variants={}; rows23={}
  for variant,h in VARIANTS.items():
    y=[multi.home_settlement(r[f"{h}_diff"],h,variant) for r in by["2022"]]
    d=[v for v in y if v is not None]
    baseline=sum(v==1 for v in d)/len(d)
    rb=modular.directional_rows(multi,{"2023":by["2023"]},h,variant,{"2023":margin_2023[h]},baseline)
    r23=rb["2023"];rows23[variant]=r23
    thresholds=modular.tier_thresholds(r23,quantiles,minp)
    val=full.validation_quality_distributions(r23,modular,minp)
    variants[variant]={"horizon":h,"baselineHomeProbability":baseline,"thresholdsByTeamState":py(thresholds),"validationQualityScoresByTeamState":py(val)}

  scfg=json.loads(json.dumps(fc["matchupStructure"]))
  prep=full.preprocess_structure(by["2022"],scfg);scfg["_prep"]=prep
  boundaries=full.build_structure_boundaries(rows23,source_index,fc["marketScope"]["horizonByVariant"],scfg,modular)

  premium={}
  for feature in PREMIUM_PILLARS:
    vals=np.asarray([finite(r.get(feature)) for r in by["2022"]],dtype=float);vals=vals[np.isfinite(vals)]
    if vals.size==0: raise SystemExit("AUTH_PREMIUM_FEATURE_EMPTY:"+feature)
    premium[feature]={"median":float(np.median(vals)),"std":float(np.std(vals))}

  out={
    "schemaVersion":SCHEMA,
    "frozenFrom":{"fullModularHead":"e352e25c131a53536745323bcd3268dcec75a66d","multiMarketHead":"236a6af9db8b5d03699abb402333a6fff8b44484","teamStateHead":"b2cd717f49d3063c6b7ed679674661961679d2a2","trainingSeason":"2022","calibrationSeason":"2023","sourceRows":expected},
    "runtimePolicy":{"maximumDailySelections":1,"runtimeRefitAllowed":False,"runtimeThresholdFitAllowed":False,"sameDateStateUpdateAllowed":False,"outcomeInputAllowed":False,"sportsbookPriceInputAllowed":False},
    "directionalModels":direction,
    "variants":variants,
    "teamState":py(fc["teamState"]),
    "matchupStructure":{"config":py(fc["matchupStructure"]),"preprocessing":py(prep),"boundariesByHorizonAndTeamState":py(boundaries)},
    "fullModularPolicy":py(fc["policies"]["CHALLENGER_FULL_MODULAR"]),
    "stateStructurePolicy":py(fc["policies"]["CHALLENGER_STATE_X_STRUCTURE"]),
    "minimumSelectedSideModelProbability":minp,
    "dailyRanking":py(fc["dailyShadowRouter"]["candidateRankingExactly"]),
    "premiumHeritageTrainingStats":premium,
  }
  os.makedirs(os.path.dirname(a.out) or ".",exist_ok=True)
  with open(a.out,"w",encoding="utf-8") as f:json.dump(out,f,indent=2,sort_keys=True);f.write("\n")
  print("MLB_UNIFIED_ELITE_LIVE_AUTHORITY_EXTRACTED",os.path.getsize(a.out))

if __name__=="__main__":main()
