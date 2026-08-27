#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, tempfile
from pathlib import Path
from urllib.request import Request, urlopen
import pyarrow.parquet as pq

CONTRACT=Path('research/wnba/WNBA_R1A4B1_PRODUCTION_FALLBACK_ASOF_ANALOGUE.json')
PARENT=Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
LAYOUT=Path('research/wnba/WNBA_R1A4B1_2026_SOURCE_LAYOUT_AMENDMENT.json')
OUT=Path('wnba-r1a4b1-fallback-asof-evidence.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{id}'
REQ_HIST={'game_id','season','season_type','game_date_time','team_id','team_home_away','opponent_team_id','field_goals_attempted','free_throws_attempted','offensive_rebounds','turnovers','team_score','opponent_team_score'}


def headers(accept):
    h={'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R1A4B1/1.1','X-GitHub-Api-Version':'2022-11-28'}
    if os.getenv('GITHUB_TOKEN'): h['Authorization']='Bearer '+os.environ['GITHUB_TOKEN']
    return h

def get_bytes(url,accept):
    with urlopen(Request(url,headers=headers(accept)),timeout=90) as r: return r.read()

def download(asset_id,path):
    b=get_bytes(API.format(id=asset_id),'application/octet-stream'); path.write_bytes(b); return len(b),hashlib.sha256(b).hexdigest()

def asset_meta(asset_id): return json.loads(get_bytes(API.format(id=asset_id),'application/vnd.github+json').decode())
def schema_only(path): return set(pq.ParquetFile(path).schema_arrow.names)
def finite(v):
    try:
        x=float(v); return x if x==x and abs(x)!=float('inf') else None
    except: return None

def round1(x): return round(float(x)+1e-12,1)

def unique_surface(rows,measure):
    out={}; dup=[]
    for r in rows:
        if r.get('season_type')!='regular-season' or r.get('per_mode')!='pergame' or r.get('measure_type')!=measure: continue
        tid=r.get('team_id')
        if tid is None: continue
        if tid in out: dup.append(tid)
        out[tid]=r
    return out,sorted(set(dup))

contract=json.loads(CONTRACT.read_text()); parent=json.loads(PARENT.read_text()); layout=json.loads(LAYOUT.read_text())
ev={'name':'WNBA_R1A4B1_FALLBACK_ASOF_EVIDENCE_V2','target_outcomes_opened':False,'historical_values_loaded':False,'production_mutation':False,'historical_schema':{},'validation_2026':{},'source_layout_amendment':layout['name']}
all_schema=True
with tempfile.TemporaryDirectory(prefix='r1a4b1-') as d:
    root=Path(d)
    for season in (2021,2022,2023,2024,2025):
        pin=parent['frozen_asset_pins'][f'{season}_team_box']; aid=int(pin['asset_id']); p=root/f'{season}.parquet'
        meta=asset_meta(aid); size,sha=download(aid,p); cols=schema_only(p); missing=sorted(REQ_HIST-cols)
        custody=(size==int(pin['size']) and sha==pin['sha256'] and int(meta.get('id'))==aid); ok=custody and not missing; all_schema &= ok
        ev['historical_schema'][str(season)]={'asset_id':aid,'custody_verified':custody,'schema_column_count':len(cols),'required_columns_missing':missing,'schema_pass':ok,'values_loaded':False}

    v=contract['validation_2026']; aid=int(v['asset_id']); p=root/v['name']; meta=asset_meta(aid); size,sha=download(aid,p)
    custody=(size==int(v['size']) and sha==v['sha256'] and int(meta.get('id'))==aid); cols=schema_only(p)
    required={'team_id','team_name','season_type','measure_type','per_mode','gp','fga','fta','oreb','tov','pts','opp_pts','off_rating','def_rating','net_rating','pace','poss'}
    missing=sorted(required-cols); detail={'asset_id':aid,'custody_verified':custody,'required_columns_missing':missing,'schema_column_count':len(cols)}; results=[]
    if custody and not missing:
        data=pq.read_table(p,columns=sorted(required)).to_pylist()
        base,dup_base=unique_surface(data,'base'); opp,dup_opp=unique_surface(data,'opponent'); adv,dup_adv=unique_surface(data,'advanced')
        detail['surface_counts']={'base_pergame_regular':len(base),'opponent_pergame_regular':len(opp),'advanced_pergame_regular':len(adv)}
        detail['duplicate_team_ids']={'base':dup_base,'opponent':dup_opp,'advanced':dup_adv}
        common=sorted(set(base)&set(opp)&set(adv)) if not (dup_base or dup_opp or dup_adv) else []
        for tid in common:
            b,o,a=base[tid],opp[tid],adv[tid]
            vals={k:finite(b.get(k)) for k in ('gp','fga','fta','oreb','tov','pts')}; opp_pts=finite(o.get('opp_pts'))
            official={k:finite(a.get(k)) for k in ('off_rating','def_rating','net_rating','pace','poss')}
            if any(x is None for x in vals.values()) or opp_pts is None or any(official[k] is None for k in ('off_rating','def_rating','net_rating','pace')): continue
            pace=vals['fga']+0.44*vals['fta']-vals['oreb']+vals['tov']
            if pace<=0: continue
            off=100*vals['pts']/pace; deff=100*opp_pts/pace; net=off-deff
            results.append({'team_id':tid,'team_name':b.get('team_name'),'gp':vals['gp'],'fallback':{'pace':round1(pace),'offRtg':round1(off),'defRtg':round1(deff),'netRtg':round1(net)},'official_advanced':{'pace':round1(official['pace']),'offRtg':round1(official['off_rating']),'defRtg':round1(official['def_rating']),'netRtg':round1(official['net_rating'])},'abs_delta':{'pace':round(abs(round1(pace)-round1(official['pace'])),3),'offRtg':round(abs(round1(off)-round1(official['off_rating'])),3),'defRtg':round(abs(round1(deff)-round1(official['def_rating'])),3),'netRtg':round(abs(round1(net)-round1(official['net_rating'])),3)}})
    detail['eligible_joined_teams']=len(results)
    for fld in ('pace','offRtg','defRtg','netRtg'):
        ds=[r['abs_delta'][fld] for r in results]
        detail[f'{fld}_mean_abs_delta_descriptive']=round(sum(ds)/len(ds),3) if ds else None
        detail[f'{fld}_max_abs_delta_descriptive']=max(ds) if ds else None
    detail['distance_is_selection_gate']=False
    detail['team_evidence_digest_sha256']=hashlib.sha256(json.dumps(results,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    ev['validation_2026']=detail

if not all_schema: decision='HISTORICAL_STATIC_SCHEMA_INSUFFICIENT'
elif not ev['validation_2026'].get('custody_verified') or ev['validation_2026'].get('required_columns_missing'): decision='FALLBACK_SEMANTICS_NOT_VALIDATED'
elif ev['validation_2026'].get('eligible_joined_teams',0)<10: decision='FALLBACK_SEMANTICS_NOT_VALIDATED'
else: decision='CERTIFIED_DISTINCT_PRODUCTION_FALLBACK_ASOF_ANALOGUE'
ev['decision']=decision; ev['r1b_outcome_opening_authorized']=False
OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n'); print(json.dumps(ev,indent=2,sort_keys=True))
