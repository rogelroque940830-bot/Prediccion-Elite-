#!/usr/bin/env python3
import argparse, hashlib, json, math, os
from collections import defaultdict

SCHEMA='courtedge-p0-step12p-condition-event-map.v1'
DISCOVERY_END='2025-07-31'
MIN_DISC_N=60
MIN_DISC_LIFT=0.05
HOLM_ALPHA=0.05
MIN_HOLDOUT_N=30
MIN_HOLDOUT_DATES=25

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def atom_sig(atoms):
    core=[{'feature':a['feature'],'operator':a['operator'],'threshold':a['threshold']} for a in atoms]
    return json.dumps(core,sort_keys=True,separators=(',',':'))

def cid(atoms): return hashlib.sha256(atom_sig(atoms).encode()).hexdigest()[:16]

def applies(r,atoms):
    for a in atoms:
        v=r.get(a['feature'])
        if v is None:return False
        if a['operator']=='GTE' and v<a['threshold']:return False
        if a['operator']=='LTE' and v>a['threshold']:return False
    return True

def outcome(r,t):
    p=t.split(':')
    if len(p)>=3 and p[1]=='RESULT':
        v=r['targets'].get(f'{p[0]}:RESULT')
        if v=='TIE':return None
        return 1 if v==p[2] else 0
    v=r['targets'].get(t)
    if v=='WIN':return 1
    if v=='LOSS':return 0
    return None

def market_family(t):
    if t.startswith('FIRST_INNING:'): return 'FIRST_INNING_RUN_ENV'
    h=t.split(':')[0]
    if ':RESULT:' in t:return f'{h}_WINNER'
    if ':TOTAL:' in t:return f'{h}_TOTAL'
    raise ValueError(t)

def stats(rows,atoms,t):
    sel=[]; allv=[]; dates=set()
    for r in rows:
        y=outcome(r,t)
        if y is None:continue
        allv.append(y)
        if applies(r,atoms):sel.append(y); dates.add(r['officialDate'])
    if not sel or not allv:return None
    rate=sum(sel)/len(sel); base=sum(allv)/len(allv)
    return {'decisiveRows':len(sel),'hits':sum(sel),'losses':len(sel)-sum(sel),'decisiveHitRate':rate,
            'baselineHitRate':base,'liftVsBaseline':rate-base,'decisiveUniqueDates':len(dates)}

def cmh(rows,atoms,t):
    tabs=defaultdict(lambda:[0,0,0,0])
    for r in rows:
        y=outcome(r,t)
        if y is None:continue
        s=applies(r,atoms); q=tabs[r['officialDate']]
        q[0 if s and y==1 else 1 if s else 2 if y==1 else 3]+=1
    num=var=0.0
    for a,b,c,d in tabs.values():
        N=a+b+c+d
        if N<=1:continue
        n1=a+b;n0=c+d;m1=a+c;m0=b+d
        if min(n1,n0,m1,m0)<=0:continue
        num += a-(n1*m1/N)
        var += n1*n0*m1*m0/(N*N*(N-1))
    z=num/math.sqrt(var) if var>0 else 0.0
    return {'cmhZ':z,'cmhOneSidedP':0.5*math.erfc(z/math.sqrt(2))}

def leaveout(rows,atoms,t,unit):
    vals=sorted({r['officialDate'][:7] if unit=='month' else r['officialDate'] for r in rows})
    lifts=[]
    for v in vals:
        sub=[r for r in rows if (r['officialDate'][:7] if unit=='month' else r['officialDate'])!=v]
        s=stats(sub,atoms,t)
        if s:lifts.append(s['liftVsBaseline'])
    return min(lifts) if lifts else None

def holm(items):
    order=sorted(range(len(items)),key=lambda i:items[i]['cmhOneSidedP'])
    prev=0.0;m=len(items)
    for rank,i in enumerate(order,1):
        adj=min(1.0,(m-rank+1)*items[i]['cmhOneSidedP']);adj=max(prev,adj);prev=adj
        items[i]['holmAdjustedP']=adj

def jaccard(rows,a,b):
    sa={r['gamePk'] for r in rows if applies(r,a)}; sb={r['gamePk'] for r in rows if applies(r,b)}
    return len(sa&sb)/len(sa|sb) if sa|sb else 0.0

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--discovery',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
    m=load(args.matrix);d=load(args.discovery)
    assert m['schemaVersion']=='courtedge-p0-step12n-multimarket-target-matrix.v1'
    assert d['schemaVersion']=='courtedge-p0-step12o-multimarket-clean-discovery.v1'
    assert d['searchContract']['holdoutUsedForSelection'] is False and d['searchContract']['holdoutUsedForThresholdTuning'] is False
    targets=list(d['searchContract']['targets']); rows=m['rows']; disc=[r for r in rows if r['officialDate']<=DISCOVERY_END]; hold=[r for r in rows if r['officialDate']>DISCOVERY_END]
    conditions=[];seen=set()
    for r in d['family']:
        s=atom_sig(r['atoms'])
        if s not in seen:seen.add(s);conditions.append({'conditionId':cid(r['atoms']),'atoms':r['atoms']})
    frozen=[]
    for c in conditions:
        byfam=defaultdict(list)
        for t in targets:
            s=stats(disc,c['atoms'],t)
            if not s or s['decisiveRows']<MIN_DISC_N or s['liftVsBaseline']<MIN_DISC_LIFT:continue
            byfam[market_family(t)].append((s['liftVsBaseline'],s['decisiveRows'],s['decisiveHitRate'],t,s))
        for fam,vals in byfam.items():
            vals.sort(key=lambda x:(x[0],x[1],x[2],x[3]),reverse=True)
            _,_,_,t,s=vals[0]
            frozen.append({'conditionId':c['conditionId'],'atoms':c['atoms'],'marketFamily':fam,'target':t,'discovery':s})
    evaluated=[]
    for h in frozen:
        s=stats(hold,h['atoms'],h['target']); c=cmh(hold,h['atoms'],h['target'])
        e={**h,'holdout':s,**c}
        e['minLeaveOneMonthOutLift']=leaveout(hold,h['atoms'],h['target'],'month')
        e['minLeaveOneDateOutLift']=leaveout(hold,h['atoms'],h['target'],'date')
        evaluated.append(e)
    holm(evaluated)
    for e in evaluated:
        h=e['holdout']
        e['classification']='GLOBAL_SUPPORTED' if (
            e['holmAdjustedP']<=HOLM_ALPHA and h['decisiveRows']>=MIN_HOLDOUT_N and h['decisiveUniqueDates']>=MIN_HOLDOUT_DATES
            and h['liftVsBaseline']>0 and (e['minLeaveOneMonthOutLift'] or -1)>0 and (e['minLeaveOneDateOutLift'] or -1)>0
        ) else 'NOT_GLOBALLY_SUPPORTED'
    supported=[e for e in evaluated if e['classification']=='GLOBAL_SUPPORTED']
    redundancy=[]
    for i,a in enumerate(supported):
        for b in supported[i+1:]:
            if a['target']==b['target']:
                redundancy.append({'a':a['conditionId'],'b':b['conditionId'],'target':a['target'],'jaccard':jaccard(hold,a['atoms'],b['atoms'])})
    report={'schemaVersion':SCHEMA,'evidenceStatus':'MULTIMARKET_CONDITION_EVENT_MAP_RESEARCH_ONLY_NO_PROMOTION',
      'split':{'discoveryEndDate':DISCOVERY_END,'discoveryRows':len(disc),'holdoutRows':len(hold)},
      'freezeContract':{'uniqueConditions':len(conditions),'marketFamilies':sorted({market_family(t) for t in targets}),
        'minimumDiscoveryDecisiveRows':MIN_DISC_N,'minimumDiscoveryLiftVsBaseline':MIN_DISC_LIFT,
        'targetSelection':'ONE_PER_CONDITION_PER_MARKET_FAMILY_BY_DISCOVERY_LIFT_ONLY','holdoutUsedForFreeze':False},
      'inferenceContract':{'frozenHypotheses':len(frozen),'test':'ONE_SIDED_CMH_STRATIFIED_BY_OFFICIAL_DATE','multiplicity':'HOLM_BONFERRONI_ACROSS_ALL_FROZEN_CONDITION_EVENT_HYPOTHESES','alpha':HOLM_ALPHA,
        'minimumHoldoutDecisiveRows':MIN_HOLDOUT_N,'minimumHoldoutDecisiveDates':MIN_HOLDOUT_DATES,'requirePositiveLeaveOneMonthOutLift':True,'requirePositiveLeaveOneDateOutLift':True},
      'counts':{'globallySupported':len(supported),'notGloballySupported':len(evaluated)-len(supported)},
      'supported':sorted(supported,key=lambda x:(x['holmAdjustedP'],-x['holdout']['liftVsBaseline'])),
      'redundancyAmongSupported':redundancy,
      'allHypotheses':evaluated,
      'policy':{'historicalPricesUsed':False,'historicalEvClaimProduced':False,'betEliteProduced':False,'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,'automaticBetPlacement':False}}
    os.makedirs(os.path.dirname(args.out) or '.',exist_ok=True)
    with open(args.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'conditions':len(conditions),'frozenHypotheses':len(frozen),'globallySupported':len(supported),'supported':[(x['conditionId'],x['target'],x['holdout']['decisiveHitRate'],x['holdout']['decisiveRows'],x['holmAdjustedP']) for x in report['supported']]},indent=2))
if __name__=='__main__':main()
