#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,os,tempfile
from collections import Counter,defaultdict
from datetime import datetime,date
from pathlib import Path
from typing import Any
from urllib.request import Request,urlopen
import pyarrow.parquet as pq

C=Path('research/wnba/WNBA_R3A1B2_2020_IDENTITY_RESOLUTION_CONTRACT.json')
SRC=Path('research/wnba/WNBA_R3A1B_2020_FOUR_FACTORS_SOURCE_CONTRACT.json')
OUT=Path('wnba-r3a1b2-2020-identity-resolution-evidence.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SCOLS=['game_id','season','season_type','game_date','home_id','away_id','home_is_active','away_is_active','notes_type','notes_headline']
BCOLS=['game_id','season','season_type','game_date','team_id','team_home_away','opponent_team_id']

def nid(v:Any)->str:
 s=str(v or '').strip(); return s[:-2] if s.endswith('.0') and s[:-2].isdigit() else s

def nt(v:Any)->str:return str(v or '').strip().lower().replace('_','').replace('-','').replace(' ','')
def reg(v:Any)->bool:return nt(v) in {'regular','regularseason','2'}
def pdate(v:Any)->str|None:
 if isinstance(v,datetime): return v.date().isoformat()
 if isinstance(v,date): return v.isoformat()
 s=str(v or '').strip()
 if not s:return None
 for z in (s,s[:10]):
  try:return datetime.fromisoformat(z.replace('Z','+00:00')).date().isoformat()
  except ValueError:pass
 return None

def hdr(a:str):
 h={'Accept':a,'User-Agent':'Prediccion-Elite-WNBA-R3A1B2/1.0','X-GitHub-Api-Version':'2022-11-28'}
 t=os.getenv('GITHUB_TOKEN','').strip()
 if t:h['Authorization']=f'Bearer {t}'
 return h

def dl(pin:dict[str,Any],p:Path):
 aid=int(pin['asset_id'])
 with urlopen(Request(API.format(asset_id=aid),headers=hdr('application/octet-stream')),timeout=120) as r:b=r.read()
 p.write_bytes(b); sha=hashlib.sha256(b).hexdigest(); exp=str(pin['sha256']).removeprefix('sha256:')
 return {'asset_id':aid,'bytes':len(b),'sha256':sha,'custody_verified':len(b)==int(pin['size']) and sha==exp}

def main():
 c=json.loads(C.read_text()); src=json.loads(SRC.read_text())
 ev={'name':'WNBA_R3A1B2_2020_IDENTITY_RESOLUTION_EVIDENCE_V1','contract':str(C),'outcome_values_projected':False,'market_data_consumed':False,'model_fit':False}
 with tempfile.TemporaryDirectory(prefix='r3a1b2-') as td:
  root=Path(td); sp=root/'s.parquet'; bp=root/'b.parquet'
  ev['schedule_asset']=dl(src['frozen_sources']['schedule_master'],sp); ev['team_box_asset']=dl(src['frozen_sources']['team_box_2020'],bp)
  sf=pq.ParquetFile(sp); bf=pq.ParquetFile(bp)
  ev['missing_schedule_columns']=[x for x in SCOLS if x not in sf.schema_arrow.names]; ev['missing_box_columns']=[x for x in BCOLS if x not in bf.schema_arrow.names]
  if ev['missing_schedule_columns'] or ev['missing_box_columns']:
   OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n'); raise SystemExit('schema gap')
  sched={}
  notes=[]
  for r in sf.read(columns=SCOLS).to_pylist():
   try:y=int(r.get('season'))
   except:continue
   if y!=2020 or not reg(r.get('season_type')):continue
   gid=nid(r.get('game_id'))
   if not gid:continue
   sched[gid]=r
   note=str(r.get('notes_headline') or '').strip(); typ=str(r.get('notes_type') or '').strip()
   if note or typ or r.get('home_is_active') is False or r.get('away_is_active') is False:
    notes.append({'game_id':gid,'notes_type':typ,'notes_headline':note,'home_is_active':r.get('home_is_active'),'away_is_active':r.get('away_is_active')})
  games=defaultdict(list)
  for r in bf.read(columns=BCOLS).to_pylist():
   try:y=int(r.get('season'))
   except:continue
   if y==2020 and reg(r.get('season_type')):
    gid=nid(r.get('game_id'))
    if gid:games[gid].append(r)
  teams=Counter(); pair_fail=[]; date_fail=[]; side_count=0; identity={}
  for gid,pair in sorted(games.items()):
   side_count+=len(pair)
   if len(pair)!=2:
    pair_fail.append(gid); continue
   a,b=pair; aid,bid=nid(a.get('team_id')),nid(b.get('team_id')); aa=nid(a.get('opponent_team_id')); bb=nid(b.get('opponent_team_id'))
   homes=[r for r in pair if nt(r.get('team_home_away'))=='home']; aways=[r for r in pair if nt(r.get('team_home_away'))=='away']
   if not aid or not bid or aid==bid or aa!=bid or bb!=aid or len(homes)!=1 or len(aways)!=1: pair_fail.append(gid)
   d1,d2=pdate(a.get('game_date')),pdate(b.get('game_date'))
   if not d1 or d1!=d2: date_fail.append(gid)
   for t in (aid,bid):
    if t:teams[t]+=1
   if gid=='401241311': identity={'game_id':gid,'game_date':d1,'home_team_id':nid(homes[0].get('team_id')) if homes else None,'away_team_id':nid(aways[0].get('team_id')) if aways else None,'home_opponent_id':nid(homes[0].get('opponent_team_id')) if homes else None,'away_opponent_id':nid(aways[0].get('opponent_team_id')) if aways else None}
  box_ids=set(games); sched_ids=set(sched); box_only=sorted(box_ids-sched_ids); sched_only=sorted(sched_ids-box_ids)
  rescheduled_ok=all(n['home_is_active'] is not False and n['away_is_active'] is not False and n['notes_type'].lower()=='event' and n['notes_headline'].upper().startswith('RESCHEDULED FROM ') for n in notes)
  ev.update({'team_box_games':len(games),'team_box_side_rows':side_count,'unique_teams':len(teams),'team_game_counts':dict(sorted(teams.items())),'all_teams_22_games':len(teams)==12 and all(v==22 for v in teams.values()),'pair_failures':pair_fail,'date_failures':date_fail,'schedule_games':len(sched),'team_box_only_game_ids':box_only,'schedule_only_game_ids':sched_only,'missing_game_identity':identity,'schedule_note_candidates':notes,'all_note_candidates_rescheduled_regular':rescheduled_ok})
  passed=(ev['schedule_asset']['custody_verified'] and ev['team_box_asset']['custody_verified'] and len(games)==132 and side_count==264 and ev['all_teams_22_games'] and not pair_fail and not date_fail and len(sched)==131 and box_only==['401241311'] and not sched_only and identity.get('game_id')=='401241311' and rescheduled_ok)
  ev['decision']='PASS_TEAM_BOX_2020_PRIMARY_IDENTITY_CUSTODY' if passed else 'BLOCKED_2020_IDENTITY_RESOLUTION'
  ev['next_gate']='R3A2_STRICT_PRIOR_DATE_PREFIX_FEATURE_CONSTRUCTOR' if passed else 'R3A1B2_REPAIR_OR_EXTERNAL_IDENTITY_REQUIRED'
 OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n')
 print(json.dumps({'decision':ev['decision'],'games':ev['team_box_games'],'teams':ev['unique_teams'],'all_teams_22':ev['all_teams_22_games'],'box_only':ev['team_box_only_game_ids'],'missing_identity':ev['missing_game_identity'],'notes_rescheduled':ev['all_note_candidates_rescheduled_regular'],'next_gate':ev['next_gate']},indent=2))

if __name__=='__main__':main()
