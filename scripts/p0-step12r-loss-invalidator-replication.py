#!/usr/bin/env python3
import argparse, json, math, os
from collections import defaultdict
from datetime import date

SCHEMA='courtedge-p0-step12r-loss-invalidator-replication.v1'
MANIFEST='courtedge-p0-step12r-loss-invalidators-frozen.v1'
FEATURE_SCHEMA='courtedge-p0-step12i-clean-t5-feature-table.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def applies_atoms(r,atoms):
    for a in atoms:
        v=r.get(a['feature'])
        if v is None or not math.isfinite(float(v)): return False
        x=float(v); t=float(a['threshold']); op=a['operator']
        if op=='GTE' and x<t:return False
        if op=='LTE' and x>t:return False
        if op not in ('GTE','LTE'):raise ValueError(f'UNSUPPORTED_OPERATOR:{op}')
    return True

def days_between(a,b):
    return (date.fromisoformat(a)-date.fromisoformat(b)).days

def build_derived(rows,starter_history,dataset):
    pitcher_hist=defaultdict(list)
    starter_game={}
    for g in starter_history['games']:
        starter_game[int(g['gamePk'])]=g
        for side in ('homeStarter','awayStarter'):
            line=g.get(side)
            if line:
                pitcher_hist[int(line['pitcherId'])].append(line)
    for pid in pitcher_hist:
        pitcher_hist[pid].sort(key=lambda x:(x['officialDate'],int(x['gamePk'])))

    team_games=defaultdict(list)
    full=[x for x in dataset['observations'] if x['horizon']=='FULL_GAME']
    full.sort(key=lambda x:(x['officialDate'],int(x['gamePk'])))
    for x in full:
        gpk=int(x['gamePk']); sg=starter_game.get(gpk)
        for side,tidkey in (('home','homeTeamId'),('away','awayTeamId')):
            tid=int(x[tidkey]); line=sg.get(side+'Starter') if sg else None
            outs=line.get('outsRecorded') if line else None
            bullpen=max(0,27-int(outs)) if outs is not None else None
            team_games[tid].append({'officialDate':x['officialDate'],'gamePk':gpk,'bullpenOutsProxy':bullpen})

    out=[]
    for src in rows:
        r=dict(src); cur=r['officialDate']
        away_pid=r.get('t5AwayProbablePitcherId')
        prior=[]
        if away_pid is not None:
            prior=[x for x in pitcher_hist.get(int(away_pid),[]) if x['officialDate']<cur]
        r['away_days_since_last_start']=days_between(cur,prior[-1]['officialDate']) if prior else None

        def bullpen_last3(tid):
            vals=[]
            for g in team_games.get(int(tid),[]):
                if g['officialDate']>=cur: continue
                d=days_between(cur,g['officialDate'])
                if 1<=d<=3 and g['bullpenOutsProxy'] is not None:
                    vals.append(g['bullpenOutsProxy'])
            return sum(vals)
        home_bp=bullpen_last3(r['homeTeamId']); away_bp=bullpen_last3(r['awayTeamId'])
        r['home_bullpen_outs_last3d']=home_bp
        r['away_bullpen_outs_last3d']=away_bp
        r['bullpen_outs_adv_last3d']=away_bp-home_bp
        out.append(r)
    return out

def applies_invalidator(r,inv):
    for a in inv['all']:
        v=r.get(a['feature'])
        if v is None or not math.isfinite(float(v)):return False
        x=float(v);t=float(a['threshold']);op=a['operator']
        if op=='GTE' and x<t:return False
        if op=='LTE' and x>t:return False
        if op not in ('GTE','LTE'):raise ValueError(f'UNSUPPORTED_OPERATOR:{op}')
    return True

def wl(rows):
    dec=[r for r in rows if r.get('fullResult') in ('HOME','AWAY')]
    w=sum(r['fullResult']=='HOME' for r in dec); l=len(dec)-w
    return {'rows':len(dec),'wins':w,'losses':l,'hitRate':w/len(dec) if dec else None,'uniqueDates':len({r['officialDate'] for r in dec})}

def evaluate_variant(rows,rule,invalidators):
    selected=[r for r in rows if applies_atoms(r,rule['atoms']) and r.get('fullResult') in ('HOME','AWAY')]
    base=wl(selected)
    inv_results=[]; union=set()
    for inv in invalidators:
        risk=[r for r in selected if applies_invalidator(r,inv)]
        risk_ids={int(r['gamePk']) for r in risk}; union|=risk_ids
        kept=[r for r in selected if int(r['gamePk']) not in risk_ids]
        rs=wl(risk); ks=wl(kept)
        inv_results.append({
            'id':inv['id'],'riskPocket':rs,'outsideRiskPocket':ks,
            'volumeRemovedPct':(100*rs['rows']/base['rows']) if base['rows'] else None,
            'lossesCaptured':rs['losses'],'winsRemoved':rs['wins'],
            'outsideLiftVsBase':(ks['hitRate']-base['hitRate']) if ks['hitRate'] is not None and base['hitRate'] is not None else None
        })
    risk_union=[r for r in selected if int(r['gamePk']) in union]
    retained=[r for r in selected if int(r['gamePk']) not in union]
    us=wl(risk_union); ks=wl(retained)
    return {
        'ruleId':rule['id'],'base':base,'invalidators':inv_results,
        'unionRiskPocket':us,'retainedOutsideAllInvalidators':ks,
        'retainedVolumePct':(100*ks['rows']/base['rows']) if base['rows'] else None,
        'retainedLiftVsBase':(ks['hitRate']-base['hitRate']) if ks['hitRate'] is not None and base['hitRate'] is not None else None,
        'lossesCapturedByUnion':us['losses'],'winsRemovedByUnion':us['wins']
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--feature-table',required=True);ap.add_argument('--starter-history',required=True);ap.add_argument('--dataset',required=True);ap.add_argument('--manifest',required=True);ap.add_argument('--season',required=True,type=int);ap.add_argument('--out',required=True)
    a=ap.parse_args();ft=load(a.feature_table);sh=load(a.starter_history);ds=load(a.dataset);m=load(a.manifest)
    if ft.get('schemaVersion')!=FEATURE_SCHEMA:raise SystemExit('STEP12R_FEATURE_SCHEMA_INVALID')
    if m.get('schemaVersion')!=MANIFEST:raise SystemExit('STEP12R_MANIFEST_SCHEMA_INVALID')
    if a.season!=m['externalReplicationPolicy']['reservedSeason']:raise SystemExit('STEP12R_RESERVED_SEASON_MISMATCH')
    rows=build_derived(ft['rows'],sh,ds)
    results={k:evaluate_variant(rows,v,m['invalidatorHypotheses']) for k,v in m['baseRules'].items()}
    report={
        'schemaVersion':SCHEMA,'season':a.season,
        'evidenceStatus':'EXTERNAL_INVALIDATOR_REPLICATION_RESEARCH_ONLY_NO_LIVE_FILTER',
        'results':results,
        'policy':{
            'thresholdRetuningPerformed':False,'newInvalidatorSearchPerformed':False,'historicalPricesUsed':False,
            'historicalEvClaimProduced':False,'liveFilterChanged':False,'betEliteProduced':False,
            'prospective11cValidationStillRequired':True
        }
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'season':a.season,'strict':results['strict'],'broad':results['broad']},indent=2))

if __name__=='__main__':main()
