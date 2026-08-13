#!/usr/bin/env python3
import argparse,hashlib,json,math,os
from collections import defaultdict
import numpy as np
from scipy.stats import mannwhitneyu

SCHEMA='courtedge-p0-step12v9-rolling-platoon-performance.v1'
SPLIT_SCHEMA='courtedge-p0-step12v9-game-team-hand-aggregates.v1'
SEASONS=('2024','2025','2026_YTD')
COUNT_KEYS=('pa','ab','h','doubles','triples','hr','tb','bb','hbp','so','sf')

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def blank():return {k:0 for k in COUNT_KEYS}

def merge(a,b):
    for k in COUNT_KEYS:a[k]+=int(b.get(k,0))

def rates(c):
    pa=c['pa'];ab=c['ab'];obpd=ab+c['bb']+c['hbp']+c['sf']
    if pa<=0 or ab<=0 or obpd<=0:return None
    avg=c['h']/ab;obp=(c['h']+c['bb']+c['hbp'])/obpd;slg=c['tb']/ab
    return {'avg':avg,'obp':obp,'slg':slg,'ops':obp+slg,'onbase_pa':(c['h']+c['bb']+c['hbp'])/pa,'tb_pa':c['tb']/pa,'hr_pa':c['hr']/pa,'xbh_pa':(c['doubles']+c['triples']+c['hr'])/pa,'bb_pa':c['bb']/pa,'k_pa':c['so']/pa,'bb_minus_k_pa':(c['bb']-c['so'])/pa}

def sha(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def holm(vals):
    m=len(vals);order=sorted(range(m),key=lambda i:vals[i]);out=[1.0]*m;run=0.0
    for rank,i in enumerate(order):
        run=max(run,min(1.0,(m-rank)*vals[i]));out[i]=run
    return out

def binstats(rows):
    n=len(rows);w=sum(int(x['homeWin']) for x in rows)
    by={}
    for s in SEASONS:
        z=[x for x in rows if x['season']==s];ns=len(z);ws=sum(int(x['homeWin']) for x in z)
        by[s]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
    return {'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'bySeason':by}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--split-dir',required=True);ap.add_argument('--v8-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);v8=load(a.v8_report)
    split={}
    for s in SEASONS:
        p=os.path.join(a.split_dir,f'hand-splits-{s}.json');d=load(p)
        if d.get('schemaVersion')!=SPLIT_SCHEMA or d.get('season')!=s:raise SystemExit(f'STEP12V9_SPLIT_SCHEMA:{s}')
        if d.get('failures'):raise SystemExit(f'STEP12V9_SPLIT_FAILURES:{s}')
        split[s]=d
    snaps=[x for x in v8['snapshots'] if x.get('usable') and x['season'] in SEASONS]
    if len(snaps)!=268 or sum(x['aPlus'] for x in snaps)!=95:raise SystemExit('STEP12V9_V8_POPULATION_INVALID')
    snap_by=defaultdict(list)
    for x in snaps:snap_by[(x['season'],x['officialDate'])].append(x)

    primary_min=int(c['reliability']['minimumPriorPaPerRequiredHandPrimary']);high_min=int(c['reliability']['highReliabilityPriorPaPerRequiredHand'])
    features=[];daily_audit=[]
    for s in SEASONS:
        acc=defaultdict(lambda:{'R':blank(),'L':blank()});games=split[s]['games'];bydate=defaultdict(list)
        for g in games:bydate[g['officialDate']].append(g)
        for d in sorted(bydate):
            before=sum(acc[t][h]['pa'] for t in acc for h in ('R','L'))
            for x in snap_by.get((s,d),[]):
                hh=x['awayStarterHand'];ah=x['homeStarterHand'];hc=acc[int(x['homeTeamId'])][hh];ac=acc[int(x['awayTeamId'])][ah]
                hr=rates(hc);ar=rates(ac);minpa=min(hc['pa'],ac['pa']);row={k:x[k] for k in ('season','gamePk','officialDate','homeTeamId','awayTeamId','homePitcherId','awayPitcherId','aPlus','homeWin','homeStarterHand','awayStarterHand')};row.update({'homeRequiredHand':hh,'awayRequiredHand':ah,'homePriorPaRequiredHand':hc['pa'],'awayPriorPaRequiredHand':ac['pa'],'minimumPriorPa':minpa,'primaryEligible':bool(hr and ar and minpa>=primary_min),'highReliability':bool(hr and ar and minpa>=high_min)})
                if hr and ar:
                    for m in c['matchupFeatures']['metrics']:
                        row[f'home_{m}']=hr[m];row[f'away_{m}']=ar[m];row[f'{m}_adv']=hr[m]-ar[m]
                features.append(row)
            # Critical anti-leakage boundary: all games on this date update only after every target feature is frozen.
            for g in bydate[d]:
                for rec in g['teamHandTotals']:
                    merge(acc[int(rec['teamId'])][rec['vsHand']],rec)
            after=sum(acc[t][h]['pa'] for t in acc for h in ('R','L'))
            daily_audit.append({'season':s,'officialDate':d,'targetRowsFrozenBeforeUpdate':len(snap_by.get((s,d),[])),'priorPaBeforeDate':before,'priorPaAfterDate':after,'gamesAppliedAfterFreeze':len(bydate[d])})

    if len(features)!=268:raise SystemExit(f'STEP12V9_FEATURE_COUNT:{len(features)}')
    eligible=[x for x in features if x['primaryEligible']];high=[x for x in features if x['highReliability']]
    coverage={'premiumA':{'expected':268,'eligible':len(eligible),'share':len(eligible)/268},'aPlus':{'expected':95,'eligible':sum(x['aPlus'] for x in eligible),'share':sum(x['aPlus'] for x in eligible)/95},'aNonplus':{'expected':173,'eligible':sum(not x['aPlus'] for x in eligible),'share':sum(not x['aPlus'] for x in eligible)/173},'highReliabilityPremiumA':{'eligible':len(high),'share':len(high)/268},'highReliabilityAPlus':{'eligible':sum(x['aPlus'] for x in high),'share':sum(x['aPlus'] for x in high)/95}}
    coverage_ok=coverage['premiumA']['share']>=float(c['coverageGate']['minimumPremiumAEligibleShare']) and coverage['aPlus']['share']>=float(c['coverageGate']['minimumAPlusEligibleShare'])

    pops={'A_PLUS':[x for x in eligible if x['aPlus']],'A_NONPLUS':[x for x in eligible if not x['aPlus']]}
    high_pops={'A_PLUS':[x for x in high if x['aPlus']],'A_NONPLUS':[x for x in high if not x['aPlus']]}
    metrics=c['inferentialFamily']['metrics'];tests=[];diagnostics={};sign_bins={};high_summary={}
    for pop_name,pop in pops.items():
        diagnostics[pop_name]={};sign_bins[pop_name]={};high_summary[pop_name]=binstats(high_pops[pop_name])
        for metric in metrics:
            w=np.array([float(x[metric]) for x in pop if x['homeWin']],dtype=float);l=np.array([float(x[metric]) for x in pop if not x['homeWin']],dtype=float)
            if len(w) and len(l):
                u,p=mannwhitneyu(w,l,alternative='two-sided',method='auto');delta=2*float(u)/(len(w)*len(l))-1
            else:u,p,delta=0.0,1.0,0.0
            inside=[x for x in pop if float(x[metric])>0];outside=[x for x in pop if float(x[metric])<=0];si,so=binstats(inside),binstats(outside)
            diagnostics[pop_name][metric]={'winnerRows':len(w),'loserRows':len(l),'winnerMean':float(np.mean(w)) if len(w) else None,'loserMean':float(np.mean(l)) if len(l) else None,'winnerMedian':float(np.median(w)) if len(w) else None,'loserMedian':float(np.median(l)) if len(l) else None,'cliffsDelta':delta,'rawMannWhitneyP':float(p)}
            sign_bins[pop_name][metric]={'positive':si,'nonPositive':so,'descriptiveLiftPp':(si['hitRate']-so['hitRate'])*100 if si['hitRate'] is not None and so['hitRate'] is not None else None}
            tests.append({'population':pop_name,'metric':metric,'winnerRows':len(w),'loserRows':len(l),'winnerMean':diagnostics[pop_name][metric]['winnerMean'],'loserMean':diagnostics[pop_name][metric]['loserMean'],'cliffsDelta':delta,'rawMannWhitneyP':float(p),'positiveSignHitRate':si['hitRate'],'nonPositiveSignHitRate':so['hitRate'],'signLiftPp':sign_bins[pop_name][metric]['descriptiveLiftPp']})
    adj=holm([x['rawMannWhitneyP'] for x in tests])
    for x,p in zip(tests,adj):x['holmAdjustedP']=p
    ranked=sorted(tests,key=lambda x:(x['holmAdjustedP'],-abs(x['cliffsDelta']),x['population'],x['metric']))

    classification='ROLLING_PLATOON_DISCOVERY_NOT_CONFIRMATION' if coverage_ok else c['coverageGate']['belowGateClassification']
    report={'schemaVersion':SCHEMA,'classification':classification,'coverage':coverage,'eligibleBaselines':{k:binstats(v) for k,v in pops.items()},'highReliabilityBaselines':high_summary,'inferentialTests':tests,'ranking':ranked,'winnerLoserDiagnostics':diagnostics,'signBins':sign_bins,'features':features,'dailyChronologyAudit':daily_audit,'sourceDigest':sha({s:{'gamesExpected':split[s]['gamesExpected'],'gamesFetched':split[s]['gamesFetched'],'validPlateAppearances':split[s]['validPlateAppearances']} for s in SEASONS}),'policy':c['policy']}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'classification':classification,'coverage':coverage,'eligibleBaselines':report['eligibleBaselines'],'highReliabilityBaselines':high_summary,'ranking':ranked,'signBins':sign_bins},indent=2))
if __name__=='__main__':main()
