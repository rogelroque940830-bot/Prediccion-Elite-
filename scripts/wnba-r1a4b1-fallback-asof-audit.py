#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, tempfile
from pathlib import Path
from urllib.request import Request, urlopen
import pyarrow.parquet as pq

CONTRACT=Path('research/wnba/WNBA_R1A4B1_PRODUCTION_FALLBACK_ASOF_ANALOGUE.json')
PARENT=Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
OUT=Path('wnba-r1a4b1-fallback-asof-evidence.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{id}'
REQ_HIST={'game_id','season','season_type','game_date_time','team_id','team_home_away','opponent_team_id','field_goals_attempted','free_throws_attempted','offensive_rebounds','turnovers','team_score','opponent_team_score'}


def headers(accept):
    h={'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R1A4B1/1.0','X-GitHub-Api-Version':'2022-11-28'}
    if os.getenv('GITHUB_TOKEN'): h['Authorization']='Bearer '+os.environ['GITHUB_TOKEN']
    return h

def get_bytes(url,accept):
    with urlopen(Request(url,headers=headers(accept)),timeout=90) as r: return r.read()

def download(asset_id,path):
    b=get_bytes(API.format(id=asset_id),'application/octet-stream'); path.write_bytes(b); return len(b),hashlib.sha256(b).hexdigest()

def asset_meta(asset_id):
    return json.loads(get_bytes(API.format(id=asset_id),'application/vnd.github+json').decode())

def schema_only(path): return set(pq.ParquetFile(path).schema_arrow.names)
def norm(s): return str(s or '').lower().replace('_','').replace('-','').replace(' ','')
def finite(v):
    try:
        x=float(v); return x if x==x and abs(x)!=float('inf') else None
    except: return None

def round1(x): return round(float(x)+1e-12,1)

contract=json.loads(CONTRACT.read_text()); parent=json.loads(PARENT.read_text())
ev={'name':'WNBA_R1A4B1_FALLBACK_ASOF_EVIDENCE_V1','target_outcomes_opened':False,'historical_values_loaded':False,'production_mutation':False,'historical_schema':{},'validation_2026':{}}
all_schema=True
with tempfile.TemporaryDirectory(prefix='r1a4b1-') as d:
    root=Path(d)
    for season in (2021,2022,2023,2024,2025):
        pin=parent['frozen_asset_pins'][f'{season}_team_box']
        aid=int(pin['asset_id']); p=root/f'{season}.parquet'; meta=asset_meta(aid); size,sha=download(aid,p); cols=schema_only(p)
        missing=sorted(REQ_HIST-cols)
        custody=(size==int(pin['size']) and sha==pin['sha256'] and int(meta.get('id'))==aid)
        ok=custody and not missing
        all_schema &= ok
        ev['historical_schema'][str(season)]={'asset_id':aid,'custody_verified':custody,'schema_column_count':len(cols),'required_columns_missing':missing,'schema_pass':ok,'values_loaded':False}

    v=contract['validation_2026']; aid=int(v['asset_id']); p=root/v['name']; meta=asset_meta(aid); size,sha=download(aid,p)
    custody=(size==int(v['size']) and sha==v['sha256'] and int(meta.get('id'))==aid)
    cols=schema_only(p)
    required={'team_id','team_name','season_type','per_mode','gp','fga','fta','oreb','tov','pts','off_rating','def_rating','net_rating'}
    missing=sorted(required-cols)
    detail={'asset_id':aid,'custody_verified':custody,'required_columns_missing':missing,'schema_column_count':len(cols)}
    rows=[]
    if custody and not missing:
        table=pq.read_table(p,columns=sorted(required)).to_pylist()
        # deterministic selection: regular season, per-game, finite required basic+advanced fields.
        for r in table:
            if norm(r.get('season_type')) not in {'regularseason','regular'}: continue
            if norm(r.get('per_mode')) not in {'pergame','perg'}: continue
            vals={k:finite(r.get(k)) for k in ('gp','fga','fta','oreb','tov','pts','off_rating','def_rating','net_rating')}
            if any(vals[k] is None for k in vals): continue
            pace=vals['fga']+0.44*vals['fta']-vals['oreb']+vals['tov']
            if pace<=0: continue
            off=100*vals['pts']/pace
            # season snapshot does not expose opponent PPG in the frozen required set; exact fallback defRtg cannot be re-derived from this asset alone.
            rows.append({'team_id':r['team_id'],'team_name':r['team_name'],'gp':vals['gp'],'fallback_pace':round1(pace),'fallback_offRtg':round1(off),'official_offRtg':round1(vals['off_rating']),'official_defRtg':round1(vals['def_rating']),'official_netRtg':round1(vals['net_rating']),'off_delta':round(abs(round1(off)-round1(vals['off_rating'])),3)})
    detail['eligible_team_rows']=len(rows)
    detail['fallback_pace_off_finite_teams']=len(rows)
    detail['max_off_delta_descriptive']=max((x['off_delta'] for x in rows),default=None)
    detail['mean_off_delta_descriptive']=round(sum(x['off_delta'] for x in rows)/len(rows),3) if rows else None
    detail['team_evidence_digest_sha256']=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    detail['def_net_full_validation_possible_from_this_asset_alone']=False
    detail['def_net_note']='Opponent PPG is not a frozen required field in this season snapshot; def/net fallback validation requires a separate 2026 game-level score source or opponent aggregate. No formula is changed.'
    ev['validation_2026']=detail

if not all_schema:
    decision='HISTORICAL_STATIC_SCHEMA_INSUFFICIENT'
elif not ev['validation_2026'].get('custody_verified') or ev['validation_2026'].get('required_columns_missing'):
    decision='FALLBACK_SEMANTICS_NOT_VALIDATED'
elif ev['validation_2026'].get('eligible_team_rows',0)<10:
    decision='FALLBACK_SEMANTICS_NOT_VALIDATED'
else:
    decision='PARTIAL_FALLBACK_ANALOGUE_SCHEMA_AND_OFFENSE_VALIDATED_DEFENSE_NET_NEEDS_2026_GAME_SCORES'
ev['decision']=decision; ev['r1b_outcome_opening_authorized']=False
OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n'); print(json.dumps(ev,indent=2,sort_keys=True))
