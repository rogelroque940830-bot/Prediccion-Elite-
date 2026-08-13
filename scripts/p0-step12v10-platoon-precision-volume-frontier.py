#!/usr/bin/env python3
import argparse,json,math,os,statistics
from collections import Counter
import numpy as np
from scipy.stats import fisher_exact

SCHEMA='courtedge-p0-step12v10-platoon-precision-volume-frontier.v1'
SEASONS=('2024','2025','2026_YTD')


def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)

def wilson(w,n):
    if n<=0:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def holm(vals):
    m=len(vals);order=sorted(range(m),key=lambda i:vals[i]);out=[1.0]*m;running=0.0
    for rank,i in enumerate(order):
        running=max(running,min(1.0,(m-rank)*vals[i]));out[i]=running
    return out

def stats(rows,baseline_n,baseline_hit,contract):
    n=len(rows);w=sum(int(x['homeWin']) for x in rows);hit=w/n if n else None
    by={}
    for s in SEASONS:
        z=[x for x in rows if x['season']==s];ns=len(z);ws=sum(int(x['homeWin']) for x in z)
        by[s]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
    months=Counter(x['officialDate'][:7] for x in rows)
    loo=[]
    for mon in sorted(months):
        z=[x for x in rows if x['officialDate'][:7]!=mon];nn=len(z);ww=sum(int(x['homeWin']) for x in z)
        if nn:loo.append({'removedMonth':mon,'rows':nn,'wins':ww,'hitRate':ww/nn})
    minloo=min(loo,key=lambda x:x['hitRate']) if loo else None
    share=n/baseline_n if baseline_n else 0.0
    gain=(hit-baseline_hit)*100 if hit is not None else None
    loss=(1-share)*100
    per10=(gain/(loss/10)) if gain is not None and loss>0 else None
    if share>=float(contract['volumeInterpretation']['coreFriendlyMinimumShare']):label='CORE_FRIENDLY_VOLUME'
    elif share>=float(contract['volumeInterpretation']['selectiveMinimumShare']):label='SELECTIVE_VOLUME'
    else:label=contract['volumeInterpretation']['belowSelectiveLabel']
    seasonal_hits=[v['hitRate'] for v in by.values() if v['rows']>0]
    seasonal_rows=[v['rows'] for v in by.values() if v['rows']>0]
    return {
        'rows':n,'wins':w,'losses':n-w,'hitRate':hit,'wilson95':wilson(w,n),
        'retainedVolumeShare':share,'retainedVolumePct':100*share,'volumeLostPp':loss,
        'precisionGainVsAPlusPp':gain,'precisionGainPer10PctVolumeLost':per10,
        'volumeLabel':label,'bySeason':by,
        'minimumSeasonHitRate':min(seasonal_hits) if seasonal_hits else None,
        'minimumSeasonRows':min(seasonal_rows) if seasonal_rows else 0,
        'activeMonths':len(months),
        'medianGamesPerActiveMonth':statistics.median(months.values()) if months else 0,
        'minimumLeaveOneMonthOut':minloo
    }

def signal_value(row,spec):
    v=float(row[spec['feature']]);t=float(spec['threshold'])
    if spec['operator']=='GT':return v>t
    raise ValueError('STEP12V10_UNSUPPORTED_SIGNAL_OPERATOR')

def cohort_match(row,name,spec,signals):
    sig={k:signal_value(row,v) for k,v in signals.items()}
    if 'rule' in spec:return sig[spec['rule']]
    if 'minimumPositiveSignals' in spec:return sum(sig.values())>=int(spec['minimumPositiveSignals'])
    if 'allSignals' in spec:return all(sig[x] for x in spec['allSignals'])
    raise ValueError(f'STEP12V10_INVALID_COHORT:{name}')

def pareto(names,summary):
    out=[]
    for a in names:
        va=summary[a]['retainedVolumeShare'];ha=summary[a]['hitRate'] or 0.0
        dominated=False
        for b in names:
            if a==b:continue
            vb=summary[b]['retainedVolumeShare'];hb=summary[b]['hitRate'] or 0.0
            if vb>=va and hb>=ha and (vb>va or hb>ha):dominated=True;break
        if not dominated:out.append(a)
    return out

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--v9-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();r=load(a.v9_report);c=load(a.contract)
    if r.get('schemaVersion')!='courtedge-p0-step12v9-rolling-platoon-performance.v1':raise SystemExit('STEP12V10_V9_SCHEMA_INVALID')
    rows=[x for x in r['features'] if x.get('primaryEligible') and x.get('aPlus')]
    expected=int(c['population']['expectedRows'])
    if len(rows)!=expected:raise SystemExit(f'STEP12V10_APLUS_COUNT:{len(rows)}')
    basewins=sum(int(x['homeWin']) for x in rows);baseloss=len(rows)-basewins;basehit=basewins/len(rows)
    if basewins!=int(c['population']['baselineWins']) or baseloss!=int(c['population']['baselineLosses']):raise SystemExit('STEP12V10_BASELINE_IDENTITY_INVALID')

    signals=c['signals'];cohorts=c['cohorts'];summary={};tests=[]
    for name,spec in cohorts.items():
        selected=[x for x in rows if cohort_match(x,name,spec,signals)]
        complement=[x for x in rows if not cohort_match(x,name,spec,signals)]
        s=stats(selected,len(rows),basehit,c);summary[name]=s
        sw=s['wins'];sl=s['losses'];cw=sum(int(x['homeWin']) for x in complement);cl=len(complement)-cw
        p=float(fisher_exact([[sw,sl],[cw,cl]],alternative='two-sided').pvalue) if selected and complement else 1.0
        tests.append({'cohort':name,'selectedRows':len(selected),'complementRows':len(complement),'selectedHitRate':s['hitRate'],'complementHitRate':cw/len(complement) if complement else None,'descriptiveLiftVsComplementPp':((s['hitRate']-cw/len(complement))*100) if selected and complement else None,'rawFisherP':p})
    adj=holm([x['rawFisherP'] for x in tests])
    for x,p in zip(tests,adj):x['holmAdjustedP']=p

    signal_names=list(signals);jaccard={};continuous_corr={}
    for i,a1 in enumerate(signal_names):
        jaccard[a1]={};continuous_corr[a1]={}
        va=np.array([float(x[signals[a1]['feature']]) for x in rows],dtype=float)
        sa=np.array([signal_value(x,signals[a1]) for x in rows],dtype=bool)
        for b1 in signal_names:
            vb=np.array([float(x[signals[b1]['feature']]) for x in rows],dtype=float)
            sb=np.array([signal_value(x,signals[b1]) for x in rows],dtype=bool)
            union=np.logical_or(sa,sb).sum();inter=np.logical_and(sa,sb).sum()
            jaccard[a1][b1]=float(inter/union) if union else 1.0
            continuous_corr[a1][b1]=float(np.corrcoef(va,vb)[0,1]) if len(va)>1 else None

    frozen_names=list(cohorts)
    frontier=pareto(frozen_names,summary)
    baseline={'rows':len(rows),'wins':basewins,'losses':baseloss,'hitRate':basehit,'retainedVolumePct':100.0}
    report={'schemaVersion':SCHEMA,'classification':'PRECISION_VOLUME_FRONTIER_DISCOVERY_NOT_CONFIRMATION','baselineAPlus':baseline,'cohorts':summary,'inferentialTests':tests,'paretoEfficientCohorts':frontier,'signalRedundancy':{'positiveSignJaccard':jaccard,'continuousPearsonCorrelation':continuous_corr},'policy':c['policy']}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'classification':report['classification'],'baselineAPlus':baseline,'paretoEfficientCohorts':frontier,'cohorts':summary,'tests':tests,'redundancy':report['signalRedundancy']},indent=2))

if __name__=='__main__':main()
