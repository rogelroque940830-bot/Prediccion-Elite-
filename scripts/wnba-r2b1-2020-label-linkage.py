#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT=Path('research/wnba/WNBA_R2B_FIVE_FOLD_PLATT_CERTIFICATION_CONTRACT.json')
PROB=Path('wnba-r2a2-2020-probability-rowset.jsonl')
ASSET=Path('wnba-r2b1-2020-label-source.parquet')
OUT=Path('wnba-r2b1-2020-labeled-seed.jsonl')
EVIDENCE=Path('wnba-r2b1-2020-label-linkage-evidence.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'


def sha256(b:bytes)->str:return hashlib.sha256(b).hexdigest()
def stable(v):
    if isinstance(v,dict):return '{'+','.join(json.dumps(str(k),separators=(',',':'))+':'+stable(v[k]) for k in sorted(v))+'}'
    if isinstance(v,list):return '['+','.join(stable(x) for x in v)+']'
    return json.dumps(v,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def cid(v)->str:
    if v is None or isinstance(v,bool):raise ValueError('invalid id')
    if isinstance(v,float):
        if not math.isfinite(v) or not v.is_integer():raise ValueError('noninteger id')
        return str(int(v))
    s=str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit():s=s[:-2]
    if not s.isdigit():raise ValueError(f'noncanonical id {s!r}')
    return str(int(s))
def strict_bool(v)->bool:
    if isinstance(v,bool):return v
    if v in (0,1):return bool(v)
    s=str(v).strip().lower()
    if s=='true':return True
    if s=='false':return False
    raise ValueError(f'nonboolean {v!r}')
def score(v)->float:
    x=float(v)
    if not math.isfinite(x):raise ValueError('nonfinite score')
    return x
def side(v)->str:return str(v or '').strip().lower().replace('_','').replace('-','').replace(' ','')
def regular(v)->bool:
    try:return int(v)==2
    except Exception:return str(v or '').strip().lower().replace(' ','') in {'regular','regularseason'}

c=json.loads(CONTRACT.read_text())
pb=PROB.read_bytes();psha=sha256(pb);prows=[json.loads(x) for x in pb.splitlines() if x.strip()]
if psha!=c['seed']['probability_sha256'] or len(prows)!=c['seed']['probability_rows']:
    raise RuntimeError('R2B1_PROBABILITY_CUSTODY_MISMATCH')
ids=[cid(r['gameId']) for r in prows]
if len(set(ids))!=len(ids):raise RuntimeError('R2B1_DUPLICATE_PROBABILITY_IDS')

src=c['2020_label_source'];aid=int(src['asset_id'])
h={'Accept':'application/octet-stream','User-Agent':'Prediccion-Elite-WNBA-R2B1/1.0','X-GitHub-Api-Version':'2022-11-28'}
tok=os.getenv('GITHUB_TOKEN','').strip()
if tok:h['Authorization']=f'Bearer {tok}'
with urlopen(Request(API.format(asset_id=aid),headers=h),timeout=120) as r:data=r.read()
ash=sha256(data)
if len(data)!=int(src['asset_size']) or ash!=src['sha256']:raise RuntimeError('R2B1_LABEL_ASSET_CUSTODY_MISMATCH')
ASSET.write_bytes(data)

# FIRST 2020 OUTCOME OPENING OCCURS ONLY BELOW, after probability and asset SHA verification.
allowed=src['allowed_columns_only']
table=pq.read_table(ASSET,columns=allowed)
groups=defaultdict(list)
for r in table.to_pylist():
    try:
        if int(r.get('season') or 0)!=2020 or not regular(r.get('season_type')):continue
        gid=cid(r.get('game_id'))
    except Exception:continue
    if gid in set(ids):groups[gid].append(r)

labeled=[];errors=[];dup_source=0
for p in prows:
    gid=cid(p['gameId']);rows=groups.get(gid,[])
    if len(rows)!=2:
        errors.append({'gameId':gid,'error':f'expected 2 source rows got {len(rows)}'});continue
    sm={side(r.get('team_home_away')):r for r in rows}
    home,away=sm.get('home'),sm.get('away')
    if not home or not away:
        errors.append({'gameId':gid,'error':'missing HOME/AWAY source side'});continue
    try:
        hid,aid2=cid(home['team_id']),cid(away['team_id'])
        ph,pa=cid(p['homeTeamId']),cid(p['awayTeamId'])
        if (hid,aid2)!=(ph,pa):raise ValueError(f'team mismatch {hid}/{aid2}!={ph}/{pa}')
        if cid(home['opponent_team_id'])!=aid2 or cid(away['opponent_team_id'])!=hid:raise ValueError('reciprocal opponent mismatch')
        hs,aws=score(home['team_score']),score(away['team_score'])
        if score(home['opponent_team_score'])!=aws or score(away['opponent_team_score'])!=hs:raise ValueError('reciprocal score mismatch')
        hw,aw=strict_bool(home['team_winner']),strict_bool(away['team_winner'])
        if hw==aw:raise ValueError('winner flags not complementary')
        if hs==aws:raise ValueError('tied final score')
        if hw!=(hs>aws) or aw!=(aws>hs):raise ValueError('winner disagrees with score')
        winner=hid if hw else aid2
        selected=cid(p['selectedTeamId'])
        y=1 if selected==winner else 0
        x=dict(p);x.update({'homeOutcome':1 if hw else 0,'winnerTeamId':winner,'selectedSideOutcome':y,'homeScore':hs,'awayScore':aws,'labelSourceAssetId':int(src['asset_id']),'labelSourceAssetSha256':src['sha256']})
        labeled.append(x)
    except Exception as exc:
        if len(errors)<20:errors.append({'gameId':gid,'error':str(exc)})

canonical=('\n'.join(stable(x) for x in labeled)+'\n').encode() if labeled else b''
OUT.write_bytes(canonical);osha=sha256(canonical)
passed=len(labeled)==126 and not errors and len(groups)==126 and psha==c['seed']['probability_sha256']
ev={
 'name':'WNBA_R2B1_2020_SEED_LABEL_LINKAGE_EVIDENCE_V1',
 'decision':'R2B1_2020_LABELED_SEED_FROZEN_NO_METRICS_YET' if passed else 'R2B1_FAIL_CLOSED_NO_CALIBRATION',
 'candidate':c['candidate'],'seedSeason':2020,'seedRole':'TRAINING_ONLY_NEVER_TARGET_FOLD',
 'chronology':{'probabilityShaVerifiedBeforeOutcomeOpening':True,'assetShaVerifiedBeforeOutcomeOpening':True,'first2020OutcomeOpeningOccurred':True},
 'probabilityCustody':{'rows':len(prows),'sha256':psha,'match':psha==c['seed']['probability_sha256']},
 'labelAssetCustody':{'assetId':int(src['asset_id']),'bytes':len(data),'sha256':ash,'match':ash==src['sha256']},
 'linkage':{'expectedRows':126,'matchedRows':len(labeled),'gameIdsWithExactlyTwoSourceRows':sum(1 for gid in ids if len(groups.get(gid,[]))==2),'errors':errors},
 'labeledSeedRowset':{'rows':len(labeled),'bytes':len(canonical),'sha256':osha},
 'metricsComputed':False,'calibrationFitPerformed':False,'thresholdSearchPerformed':False,'rowsDroppedAfterOutcome':126-len(labeled),
 'r2b2FiveFoldCalibrationAuthorized':passed,'productionChangeAuthorized':False,'globalRankerPromotionAuthorized':False
}
EVIDENCE.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n');print(json.dumps(ev,indent=2,sort_keys=True))
if not passed:raise SystemExit(2)
