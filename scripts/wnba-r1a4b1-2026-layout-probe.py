#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,os,tempfile
from collections import Counter
from pathlib import Path
from urllib.request import Request,urlopen
import pyarrow.parquet as pq

OUT=Path('wnba-r1a4b1-2026-layout-evidence.json')
AID=493743208; SIZE=79175; SHA='3eb8abfef0ff0a65e124bfaf743feda884eff9a8bc9caff293e868108b62b41b'
URL=f'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{AID}'
COLS=['team_id','team_name','season','season_type','measure_type','per_mode','gp','fga','fta','oreb','tov','pts','off_rating','def_rating','net_rating','pace','poss']

def hdr(a):
 h={'Accept':a,'User-Agent':'Prediccion-Elite-WNBA-R1A4B1-layout/1.0','X-GitHub-Api-Version':'2022-11-28'}
 if os.getenv('GITHUB_TOKEN'): h['Authorization']='Bearer '+os.environ['GITHUB_TOKEN']
 return h

def get(a):
 with urlopen(Request(URL,headers=hdr(a)),timeout=90) as r:return r.read()

def present(v):
 try:return v is not None and float(v)==float(v)
 except:return v is not None

raw=get('application/octet-stream'); custody=len(raw)==SIZE and hashlib.sha256(raw).hexdigest()==SHA
with tempfile.NamedTemporaryFile(suffix='.parquet') as f:
 f.write(raw);f.flush(); names=set(pq.ParquetFile(f.name).schema_arrow.names); use=[c for c in COLS if c in names]; rows=pq.read_table(f.name,columns=use).to_pylist()
 combos=Counter(); patterns=Counter(); team_counts=Counter()
 samples={}
 for r in rows:
  combo=(str(r.get('season_type')),str(r.get('measure_type')),str(r.get('per_mode')))
  combos[combo]+=1
  base=all(present(r.get(k)) for k in ('gp','fga','fta','oreb','tov','pts'))
  adv=all(present(r.get(k)) for k in ('off_rating','def_rating','net_rating'))
  pace=present(r.get('pace')); poss=present(r.get('poss'))
  pat=(base,adv,pace,poss); patterns[(combo,pat)]+=1
  if r.get('team_id') is not None: team_counts[(combo,str(r.get('team_id')))]+=1
  key=str((combo,pat))
  if key not in samples:
   samples[key]={k:r.get(k) for k in ('team_id','team_name','season','season_type','measure_type','per_mode','gp','fga','fta','oreb','tov','pts','off_rating','def_rating','net_rating','pace','poss')}

ev={'name':'WNBA_R1A4B1_2026_LAYOUT_EVIDENCE_V1','target_outcomes_opened':False,'historical_2021_2025_values_loaded':False,'validation_season':2026,'custody_verified':custody,'row_count':len(rows),'columns_loaded':use,'layout_combinations':[{'season_type':k[0],'measure_type':k[1],'per_mode':k[2],'rows':v} for k,v in sorted(combos.items())],'presence_patterns':[{'season_type':k[0][0],'measure_type':k[0][1],'per_mode':k[0][2],'basic_complete':k[1][0],'advanced_complete':k[1][1],'pace_present':k[1][2],'poss_present':k[1][3],'rows':v} for k,v in sorted(patterns.items(),key=lambda x:str(x[0]))],'sample_rows':samples,'decision':'LAYOUT_CHARACTERIZATION_ONLY_NO_SCIENTIFIC_RULE_CHANGED'}
OUT.write_text(json.dumps(ev,indent=2,sort_keys=True,default=str)+'\n');print(json.dumps(ev,indent=2,sort_keys=True,default=str))
