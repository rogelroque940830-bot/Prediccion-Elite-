#!/usr/bin/env python3
import argparse,itertools,json,math,os
from collections import defaultdict

SCHEMA='courtedge-p0-step12q-virgin-2022-confirmation.v1'
MANIFEST='courtedge-p0-step12q-premium-interactions-frozen.v2'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def applies(r,atoms):
    for a in atoms:
        v=r.get(a['feature'])
        if v is None or not math.isfinite(float(v)):return False
        x=float(v);t=float(a['threshold']);op=a['operator']
        if op=='GTE' and x<t:return False
        if op=='LTE' and x>t:return False
        if op not in ('GTE','LTE'):raise ValueError(f'UNSUPPORTED_OPERATOR:{op}')
    return True

def outcome(r,target):
    p=target.split(':')
    if len(p)==3 and p[1]=='RESULT' and p[2] in ('HOME','AWAY'):
        v=r['targets'].get(f'{p[0]}:RESULT')
        if v=='TIE':return None
        return 1 if v==p[2] else 0
    v=r['targets'].get(target)
    if v=='WIN':return 1
    if v=='LOSS':return 0
    return None

def stats(rows,atoms,target):
    ys=[];dates=set();all_y=[]
    for r in rows:
        y=outcome(r,target)
        if y is None:continue
        all_y.append(y)
        if applies(r,atoms):ys.append(y);dates.add(r['officialDate'])
    if not ys or not all_y:return None
    rate=sum(ys)/len(ys);base=sum(all_y)/len(all_y)
    return {'decisiveRows':len(ys),'hits':sum(ys),'losses':len(ys)-sum(ys),'decisiveHitRate':rate,'baselineHitRate':base,'liftVsBaseline':rate-base,'decisiveUniqueDates':len(dates)}

def cmh(rows,atoms,target):
    tabs=defaultdict(lambda:[0,0,0,0])
    for r in rows:
        y=outcome(r,target)
        if y is None:continue
        s=applies(r,atoms);q=tabs[r['officialDate']]
        if s and y:q[0]+=1
        elif s:q[1]+=1
        elif y:q[2]+=1
        else:q[3]+=1
    num=var=0.0;strata=0
    for a,b,c,d in tabs.values():
        N=a+b+c+d
        if N<=1:continue
        n1=a+b;n0=c+d;m1=a+c;m0=b+d
        if min(n1,n0,m1,m0)<=0:continue
        num+=a-(n1*m1/N);var+=n1*n0*m1*m0/(N*N*(N-1));strata+=1
    z=num/math.sqrt(var) if var>0 else 0.0
    return {'cmhZ':z,'cmhOneSidedP':0.5*math.erfc(z/math.sqrt(2)),'informativeDateStrata':strata}

def leaveout(rows,atoms,target,unit):
    groups=sorted({r['officialDate'][:7] if unit=='month' else r['officialDate'] for r in rows});vals=[]
    for g in groups:
        sub=[r for r in rows if (r['officialDate'][:7] if unit=='month' else r['officialDate'])!=g]
        s=stats(sub,atoms,target)
        if s:vals.append(s['liftVsBaseline'])
    return min(vals) if vals else None

def wilson(h,n,z=1.959963984540054):
    if n<=0:return [None,None]
    p=h/n;den=1+z*z/n;ctr=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [max(0,ctr-half),min(1,ctr+half)]

def subsets(rows,atoms,target):
    out=[]
    for k in range(1,len(atoms)):
        for idx in itertools.combinations(range(len(atoms)),k):
            aa=[atoms[i] for i in idx];s=stats(rows,aa,target)
            if s:out.append({'atomIndexes':list(idx),'features':[x['feature'] for x in aa],**s})
    out.sort(key=lambda x:(x['decisiveHitRate'],x['decisiveRows']),reverse=True)
    return (out[0] if out else None),out

def holm(items):
    order=sorted(range(len(items)),key=lambda i:items[i]['cmhOneSidedP']);m=len(items);prev=0.0
    for rank,i in enumerate(order,1):
        adj=max(prev,min(1.0,(m-rank+1)*items[i]['cmhOneSidedP']));items[i]['holmAdjustedP']=adj;prev=adj

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--manifest',required=True);ap.add_argument('--out',required=True);a=ap.parse_args()
    matrix=load(a.matrix);m=load(a.manifest);rows=matrix['rows'];pol=m['finalConfirmationPolicy']
    if matrix.get('schemaVersion')!='courtedge-p0-step12n-multimarket-target-matrix.v1':raise SystemExit('STEP12Q_MATRIX_SCHEMA_INVALID')
    if m.get('schemaVersion')!=MANIFEST:raise SystemExit('STEP12Q_MANIFEST_SCHEMA_INVALID')
    if len(m['candidates'])!=pol['familywiseCandidateCount']:raise SystemExit('STEP12Q_FAMILY_SIZE_MISMATCH')
    results=[]
    for c in m['candidates']:
        if len(c['atoms'])!=3 or len({x['feature'] for x in c['atoms']})!=3:raise SystemExit(f"STEP12Q_NOT_THREE_DISTINCT:{c['id']}")
        s=stats(rows,c['atoms'],c['target']) or {'decisiveRows':0,'hits':0,'losses':0,'decisiveHitRate':None,'baselineHitRate':None,'liftVsBaseline':None,'decisiveUniqueDates':0}
        best,allsubs=subsets(rows,c['atoms'],c['target']);synergy=(s['decisiveHitRate']-best['decisiveHitRate']) if s['decisiveHitRate'] is not None and best else None
        r={'id':c['id'],'target':c['target'],'role':c['role'],'atoms':c['atoms'],**s,'wilson95':wilson(s['hits'],s['decisiveRows']),'bestProperSubset':best,'incrementalSynergyVsBestProperSubset':synergy,'properSubsets':allsubs,**cmh(rows,c['atoms'],c['target']),'minLeaveOneMonthOutLift':leaveout(rows,c['atoms'],c['target'],'month'),'minLeaveOneDateOutLift':leaveout(rows,c['atoms'],c['target'],'date')}
        results.append(r)
    holm(results)
    for r in results:
        ck={'minimumDecisiveRows':r['decisiveRows']>=pol['minimumDecisiveRowsForPremium'],'minimumDecisiveDates':r['decisiveUniqueDates']>=pol['minimumDecisiveDatesForPremium'],'minimumHitRate':r['decisiveHitRate'] is not None and r['decisiveHitRate']>=pol['minimumHitRateForPremium'],'minimumLift':r['liftVsBaseline'] is not None and r['liftVsBaseline']>=pol['minimumLiftVsBaselineForPremium'],'positiveIncrementalSynergy':r['incrementalSynergyVsBestProperSubset'] is not None and r['incrementalSynergyVsBestProperSubset']>0,'familywiseSignificance':r['holmAdjustedP']<=pol['holmAlpha'],'positiveLeaveOneMonthLift':r['minLeaveOneMonthOutLift'] is not None and r['minLeaveOneMonthOutLift']>0,'positiveLeaveOneDateLift':r['minLeaveOneDateOutLift'] is not None and r['minLeaveOneDateOutLift']>0}
        r['premiumChecks']=ck;r['classification']='PREMIUM_CONFIRMED_2022' if all(ck.values()) else ('EDGE_REPLICATED_NOT_PREMIUM' if r['liftVsBaseline'] is not None and r['liftVsBaseline']>0 else 'NOT_CONFIRMED_2022')
    primary=next(r for r in results if r['id']==m['primaryCandidateId'])
    report={'schemaVersion':SCHEMA,'evidenceStatus':'VIRGIN_2022_CONFIRMATION_RESEARCH_ONLY_NO_BET_ELITE','season':2022,'rows':len(rows),'manifestSchemaVersion':m['schemaVersion'],'primaryCandidateId':m['primaryCandidateId'],'confirmationContract':pol,'results':results,'primaryResult':primary,'counts':{'premiumConfirmed':sum(r['classification']=='PREMIUM_CONFIRMED_2022' for r in results),'edgeReplicatedNotPremium':sum(r['classification']=='EDGE_REPLICATED_NOT_PREMIUM' for r in results),'notConfirmed':sum(r['classification']=='NOT_CONFIRMED_2022' for r in results)},'policy':{'thresholdRetuningPerformed':False,'candidateSearchPerformedIn2022':False,'historicalPricesUsed':False,'historicalEvClaimProduced':False,'betEliteProduced':False,'livePickFiltersChanged':False,'automaticBetPlacement':False}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'primary':{k:primary[k] for k in ['id','hits','losses','decisiveHitRate','baselineHitRate','liftVsBaseline','decisiveUniqueDates','incrementalSynergyVsBestProperSubset','holmAdjustedP','classification']},'counts':report['counts']},indent=2))
if __name__=='__main__':main()
