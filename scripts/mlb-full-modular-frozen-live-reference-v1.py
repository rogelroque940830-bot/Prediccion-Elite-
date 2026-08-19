#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os
import numpy as np

VARIANTS=(
    "F3_RL_HOME_PLUS_0_5","F5_ML","F5_RL_HOME_MINUS_0_5","F5_RL_HOME_PLUS_0_5",
    "FG_ML","FG_RL_HOME_MINUS_1_5","FG_RL_HOME_PLUS_1_5",
)
TIERS=("STRONG","MIDDLE","WEAK","UNSTABLE")

def load(path):
    with open(path,encoding="utf-8") as f:return json.load(f)

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None: raise SystemExit("REFERENCE_IMPORT_FAILED:"+path)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod

def finite(x):
    try:
        v=float(x);return math.isfinite(v)
    except Exception:return False

def make_feature_vector(authority,case_index):
    values={}
    # Directional features use the exact frozen preprocessing. First occurrence wins for shared features.
    for horizon in ("F3","F5","FG"):
        model=authority["directionalModels"][horizon]
        for i,name in enumerate(model["features"]):
            if name in values: continue
            shift=(((case_index+i)%7)-3)*0.65
            values[name]=float(model["mean"][i])+shift*float(model["scale"][i])
    # Structure-only fields are made observable using their frozen training preprocessing.
    for role_fields in authority["matchupStructure"]["config"]["roles"].values():
        for i,name in enumerate(role_fields):
            if name in values: continue
            p=authority["matchupStructure"]["preprocessing"][name]
            shift=(((case_index+i+2)%5)-2)*0.75
            values[name]=float(p["mean"])+shift*float(p["std"])
    return values

def probabilities(multi,authority,features,horizon):
    model=authority["directionalModels"][horizon]
    x=[]
    for i,name in enumerate(model["features"]):
        raw=features.get(name)
        value=float(raw) if finite(raw) else float(model["median"][i])
        scale=float(model["scale"][i])
        x.append((value-float(model["mean"][i]))/scale if scale>1e-12 else 0.0)
    p=multi.predict_multinomial(np.asarray([x],dtype=float),np.asarray(model["weights"],dtype=float),int(model["classCount"]))[0]
    return p

def score_case(multi,modular,full,authority,case_index,game_pk,home_tier,away_tier):
    fv=make_feature_vector(authority,case_index)
    probs={h:probabilities(multi,authority,fv,h) for h in ("F3","F5","FG")}
    cfg=json.loads(json.dumps(authority["matchupStructure"]["config"]))
    cfg["_prep"]=authority["matchupStructure"]["preprocessing"]
    contract={"policies":{
        "CHALLENGER_FULL_MODULAR":authority["fullModularPolicy"],
        "CHALLENGER_STATE_X_STRUCTURE":authority["stateStructurePolicy"],
    }}
    candidates=[]
    for variant in VARIANTS:
        info=authority["variants"][variant];horizon=info["horizon"]
        ph,pa=multi.pair_probability(np.asarray([probs[horizon]],dtype=float),horizon,variant)
        row={
            "homeProbability":float(ph[0]),"awayProbability":float(pa[0]),
            "baselineHomeProbability":float(info["baselineHomeProbability"]),
            "baselineAwayProbability":1.0-float(info["baselineHomeProbability"]),
            "homeTier":home_tier,"awayTier":away_tier,"homeOutcome":None,
        }
        side,score,probability,tier,_=modular.selected_direction(row)
        structure_score,diag=full.structure_score(fv,side,horizon,cfg,cfg["_prep"])
        boundary=authority["matchupStructure"]["boundariesByHorizonAndTeamState"][horizon][tier]
        state=full.classify_structure(structure_score,boundary)
        geometry,selected_line=full.selected_line_geometry(variant,side)
        percentile=full.empirical_percentile(info["validationQualityScoresByTeamState"][tier],score)
        if percentile is None: continue
        frontier=full.resolve_frontier("CHALLENGER_FULL_MODULAR",tier,state,geometry,contract)
        if frontier=="NO_PLAY": continue
        threshold=info["thresholdsByTeamState"][tier].get(frontier)
        if threshold is None or score<=0 or probability<float(authority["minimumSelectedSideModelProbability"]) or score+1e-15<float(threshold):
            continue
        candidates.append({
            "officialDate":"2026-08-19","gamePk":game_pk,"market":variant,"horizon":horizon,"side":side,
            "selectedLine":selected_line,"lineGeometry":geometry,"strengthTier":tier,"matchupStructure":state,
            "structureScore":structure_score,"structureObservedFeatureFraction":diag["observedFeatureFraction"],
            "frontier":frontier,"qualityScore":float(score),"qualityPercentile":float(percentile),
            "modelProbability":float(probability),
        })
    candidates.sort(key=lambda r:(-r["qualityPercentile"],-r["modelProbability"],r["market"],r["gamePk"]))
    return {"featureVector":fv,"homeStrengthTier":home_tier,"awayStrengthTier":away_tier,"candidates":candidates}

def main():
    p=argparse.ArgumentParser();p.add_argument("--authority",required=True);p.add_argument("--multi",required=True);p.add_argument("--modular",required=True);p.add_argument("--full",required=True);p.add_argument("--out",required=True);a=p.parse_args()
    authority=load(a.authority);multi=module(a.multi,"ref_multi");modular=module(a.modular,"ref_modular");full=module(a.full,"ref_full")
    cases=[]
    for i in range(12):
        cases.append(score_case(multi,modular,full,authority,i,990000+i,TIERS[i%4],TIERS[(i+1)%4]))
    payload={"schemaVersion":"courtedge-mlb-full-modular-frozen-live-reference.v1","officialDate":"2026-08-19","cases":cases}
    os.makedirs(os.path.dirname(a.out) or ".",exist_ok=True)
    with open(a.out,"w",encoding="utf-8") as f:json.dump(payload,f,indent=2,sort_keys=True);f.write("\n")
    print("MLB_FULL_MODULAR_FROZEN_REFERENCE_GENERATED",len(cases),sum(len(x["candidates"]) for x in cases))
if __name__=="__main__":main()
