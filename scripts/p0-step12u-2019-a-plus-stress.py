#!/usr/bin/env python3
import argparse, json, math, os

FEATURE_SCHEMA='courtedge-p0-step12i-clean-t5-feature-table.v1'
MANIFEST_SCHEMA='courtedge-p0-step12u-a-plus-frozen.v1'
REPORT_SCHEMA='courtedge-p0-step12u-2019-a-plus-stress.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)


def atom_ok(r,a):
    v=r.get(a['feature'])
    if v is None:return False
    try:v=float(v);t=float(a['threshold'])
    except:return False
    if not math.isfinite(v):return False
    op=a['operator']
    if op=='GTE':return v>=t
    if op=='LTE':return v<=t
    if op=='GT':return v>t
    if op=='LT':return v<t
    raise ValueError(op)


def metrics(rows):
    n=len(rows);w=sum(r['fullResult']=='HOME' for r in rows);l=n-w
    return {'rows':n,'wins':w,'losses':l,'hitRate':w/n if n else None}


def wilson(w,n,z=1.959963984540054):
    if n<=0:return None
    p=w/n;den=1+z*z/n
    c=(p+z*z/(2*n))/den
    h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [c-h,c+h]


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--feature-table',required=True)
    ap.add_argument('--manifest',required=True)
    ap.add_argument('--out',required=True)
    a=ap.parse_args()
    ft=load(a.feature_table);m=load(a.manifest)
    if ft.get('schemaVersion')!=FEATURE_SCHEMA:raise SystemExit('STEP12U_FEATURE_SCHEMA_INVALID')
    if m.get('schemaVersion')!=MANIFEST_SCHEMA:raise SystemExit('STEP12U_MANIFEST_SCHEMA_INVALID')
    sh=m['selectionHistory'];pol=m['external2019StressPolicy']
    if sh['externalStressJudge']!='2019_FULL_REGULAR_SEASON_CLEAN_T5_REBUILD':raise SystemExit('STEP12U_2019_JUDGE_INVALID')
    if sh['candidateSearchAllowedIn2019'] is not False or sh['thresholdRetuningAllowedAfter2019'] is not False:raise SystemExit('STEP12U_FREEZE_INVALID')
    if pol['newCandidateSearchIn2019Allowed'] is not False or pol['noThresholdChangesAfterSeeing2019'] is not True:raise SystemExit('STEP12U_2019_RETUNING_FORBIDDEN')

    labeled=[r for r in ft['rows'] if r.get('fullResult') in ('HOME','AWAY')]
    core=[r for r in labeled if all(atom_ok(r,x) for x in m['aCore']['atoms'])]
    cm=metrics(core);cm['wilson95']=wilson(cm['wins'],cm['rows'])
    results=[]
    for c in m['frozenCandidates']:
        selected=[r for r in core if all(atom_ok(r,x) for x in c['additionalAtoms'])]
        ids={int(r['gamePk']) for r in selected}
        outside=[r for r in core if int(r['gamePk']) not in ids]
        sm=metrics(selected);om=metrics(outside)
        sm['wilson95']=wilson(sm['wins'],sm['rows'])
        lift=sm['hitRate']-cm['hitRate'] if sm['hitRate'] is not None and cm['hitRate'] is not None else None
        strat=sm['hitRate']-om['hitRate'] if sm['hitRate'] is not None and om['hitRate'] is not None else None
        vol=100*sm['rows']/cm['rows'] if cm['rows'] else None
        months=sorted({r['officialDate'][:7] for r in core})
        loo=[]
        for month in months:
            cbase=[r for r in core if r['officialDate'][:7]!=month]
            csel=[r for r in cbase if all(atom_ok(r,x) for x in c['additionalAtoms'])]
            bm=metrics(cbase);xm=metrics(csel)
            if xm['rows'] and bm['rows']:
                loo.append({'leftOutMonth':month,'liftVsACore':xm['hitRate']-bm['hitRate'],'candidateRows':xm['rows']})
        minloo=min((x['liftVsACore'] for x in loo),default=None)
        checks={
            'minimumRows':sm['rows']>=int(pol['minimumDecisiveRows'][c['id']]),
            'minimumVolume':vol is not None and vol>=float(pol['minimumCandidateVolumePctOfA'][c['id']]),
            'minimumLiftVsACore':lift is not None and lift>=float(pol['minimumLiftVsACore']),
            'positiveVsAOutside':strat is not None and strat>0,
            'positiveLeaveOneMonthOutLift':minloo is not None and minloo>0,
        }
        classification='EXTERNAL_2019_STRESS_DIRECTIONALLY_SUPPORTED' if all(checks.values()) else 'NOT_EXTERNALLY_SUPPORTED_2019_STRESS'
        results.append({
            'id':c['id'],'role':c['role'],'metrics':sm,'outsideACore':om,
            'retainedVolumePctOfA':vol,'liftVsACore':lift,'candidateVsAOutsideLift':strat,
            'minLeaveOneMonthOutLiftVsACore':minloo,'leaveOneMonthOut':loo,
            'checks':checks,'classification':classification
        })
    report={
        'schemaVersion':REPORT_SCHEMA,
        'evidenceStatus':'EXTERNAL_2019_REGIME_STRESS_TEST_NO_RETUNING',
        'aCore':cm,'candidates':results,
        'policy':{
            'thresholdRetuningPerformed':False,'candidateSearchPerformedIn2019':False,
            'historicalPricesUsed':False,'historicalEvOrRoiClaimProduced':False,
            'liveFilterChanged':False,'stakeChanged':False,'betEliteProduced':False,
            'prospective11cStillRequired':True
        }
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'aCore':cm,'candidates':[{k:r[k] for k in ('id','metrics','retainedVolumePctOfA','liftVsACore','candidateVsAOutsideLift','minLeaveOneMonthOutLiftVsACore','classification')} for r in results]},indent=2))

if __name__=='__main__':main()
