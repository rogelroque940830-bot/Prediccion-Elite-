#!/usr/bin/env python3
import argparse, hashlib, json, os

SCHEMA='courtedge-p0-step12n-multimarket-target-matrix.v1'
HORIZONS=('FIRST_INNING','FIRST_3','FIRST_5','FULL_GAME')
# Predeclared sporting-outcome cut grid. These are NOT betting recommendations or historical price claims.
TOTAL_LINES={
  'FIRST_INNING':(0.5,1.5,2.5),
  'FIRST_3':(1.5,2.5,3.5,4.5),
  'FIRST_5':(2.5,3.5,4.5,5.5,6.5),
  'FULL_GAME':(6.5,7.5,8.5,9.5,10.5),
}


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
    return h.hexdigest()

def result(home,away):
    return 'HOME' if home>away else ('AWAY' if home<away else 'TIE')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--feature-table',required=True);ap.add_argument('--dataset',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args(); ft=load(a.feature_table); ds=load(a.dataset)
    if ft.get('schemaVersion')!='courtedge-p0-step12i-clean-t5-feature-table.v1':raise SystemExit('STEP12N_FEATURE_SCHEMA_INVALID')
    obs={}
    for r in ds.get('observations',[]):
        h=r.get('horizon')
        if h in HORIZONS: obs[(int(r['gamePk']),h)]=r
    rows=[]
    for base in ft['rows']:
        g=int(base['gamePk']); targets={}
        for h in HORIZONS:
            r=obs.get((g,h))
            if r is None: raise SystemExit(f'STEP12N_OUTCOME_MISSING:{g}:{h}')
            home=int(r['homeRuns']); away=int(r['awayRuns']); total=int(r['totalRuns'])
            targets[f'{h}:RESULT']=result(home,away)
            targets[f'{h}:HOME_RUNS']=home;targets[f'{h}:AWAY_RUNS']=away;targets[f'{h}:TOTAL_RUNS']=total
            for line in TOTAL_LINES[h]:
                targets[f'{h}:TOTAL:{line}:OVER']='WIN' if total>line else 'LOSS'
                targets[f'{h}:TOTAL:{line}:UNDER']='WIN' if total<line else 'LOSS'
        fi=obs[(g,'FIRST_INNING')]
        targets['FIRST_INNING:NRFI']='WIN' if int(fi['totalRuns'])==0 else 'LOSS'
        targets['FIRST_INNING:YRFI']='WIN' if int(fi['totalRuns'])>0 else 'LOSS'
        rows.append({**base,'targets':targets})
    report={
      'schemaVersion':SCHEMA,
      'evidenceStatus':'MULTIMARKET_SPORTING_TARGETS_RESEARCH_ONLY_NO_PRICE_NO_EV',
      'source':{'featureTableSha256':sha256_file(a.feature_table),'datasetSha256':sha256_file(a.dataset)},
      'targetContract':{
        'winnerHorizons':['FIRST_3','FIRST_5','FULL_GAME'],
        'firstInningSpecial':['NRFI','YRFI'],
        'totalLinesByHorizon':{k:list(v) for k,v in TOTAL_LINES.items()},
        'historicalPricesUsed':False,
        'targetLinesAreSportingOutcomeCutpointsNotPriceClaims':True,
        'samePregameFeaturesForAllTargets':True,
      },
      'policy':{'betEliteProduced':False,'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,'automaticBetPlacement':False},
      'rows':rows,
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'rows':len(rows),'targetCountPerRow':len(rows[0]['targets']) if rows else 0},indent=2))
if __name__=='__main__':main()
