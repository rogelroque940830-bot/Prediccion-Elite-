#!/usr/bin/env python3
import argparse,json,math,os
from collections import defaultdict
from datetime import date,timedelta
from scipy.stats import fisher_exact

SCHEMA='courtedge-p0-step12v13-f5-damage-volume-generalization.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PACK_SCHEMA='courtedge-p0-step12v12-game-pitchmix-summary.v1'
EVAL=('2024','2025','2026_YTD'); ALL=('2023','2024','2025','2026_YTD')
CATS=('FASTBALL','BREAKING','OFFSPEED')
METRICS=('pitchmix_rel_contact_adv','pitchmix_rel_whiff_adv','pitchmix_rel_tbpa_adv','pitchmix_rel_hrpa_adv')

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def sigmoid(z):return 1/(1+math.exp(-max(-50,min(50,float(z)))))

def frozen_v7_prob(f,m):
    z=float(m['intercept'])
    for i,n in enumerate(m['features']):
        x=f.get(n); x=m['medianImpute'][i] if not finite(x) else x
        z+=float(m['coef'][i])*((float(x)-float(m['mean'][i]))/float(m['scale'][i]))
    return sigmoid(z)

def is_a(f,c):return all(finite(f.get(x['feature'])) and float(f[x['feature']])>=float(x['threshold']) for x in c['premiumA']['all'])

def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n;mid=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def holm(ps):
    m=len(ps);order=sorted(range(m),key=lambda i:ps[i]);out=[1.0]*m;run=0.0
    for rank,i in enumerate(order):run=max(run,min(1.0,(m-rank)*ps[i]));out[i]=run
    return out

def sum_dict(dst,src):
    for k,v in src.items():
        if isinstance(v,(int,float)):dst[k]+=v

def main():
    ap=argparse.ArgumentParser()
    for x in ('root','pitch-dir','v7-report','a-contract','v12-contract','v12-report','contract','out'):ap.add_argument('--'+x,required=True)
    a=ap.parse_args(); c=load(a.contract); vc=load(a.v12_contract); vr=load(a.v12_report); ac=load(a.a_contract); v7=load(a.v7_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v13-f5-damage-volume-generalization-contract.v1':raise SystemExit('STEP12V13_CONTRACT_INVALID')
    if len(c['predeclaredGeneralizations'])!=6:raise SystemExit('STEP12V13_COHORT_COUNT_INVALID')
    lookback=int(vc['dataBoundary']['rollingLookbackDays']); rel=vc['reliability']

    ph=defaultdict(list);th=defaultdict(list);lh=[]
    for s in ALL:
        p=load(os.path.join(a.pitch_dir,f'pitchmix-{s}.json'))
        if p.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'STEP12V13_PACK_SCHEMA:{s}')
        for g in p['games']:
            d=date.fromisoformat(g['officialDate'])
            for r in g['pitcherTotals']:ph[int(r['pitcherId'])].append((d,r))
            bt=defaultdict(list)
            for r in g['teamPitchFamilyTotals']:bt[int(r['teamId'])].append(r)
            for tid,recs in bt.items():th[tid].append((d,recs))
            lh.append((d,g['teamPitchFamilyTotals']))
    for h in ph.values():h.sort(key=lambda x:x[0])
    for h in th.values():h.sort(key=lambda x:x[0])
    lh.sort(key=lambda x:x[0]); pc={};tc={};lc={}
    def inside(d,t):return t-timedelta(days=lookback)<=d<t
    def pagg(pid,t):
        k=(pid,t)
        if k in pc:return pc[k]
        o=defaultdict(float)
        for d,r in ph.get(int(pid),[]):
            if inside(d,t):sum_dict(o,r)
        pc[k]=dict(o);return pc[k]
    def tagg(tid,t):
        k=(tid,t)
        if k in tc:return tc[k]
        o={cat:defaultdict(float) for cat in CATS}
        for d,recs in th.get(int(tid),[]):
            if not inside(d,t):continue
            for r in recs:
                if r['pitchFamily'] in o:sum_dict(o[r['pitchFamily']],r)
        tc[k]={cat:dict(v) for cat,v in o.items()};return tc[k]
    def lagg(t):
        if t in lc:return lc[t]
        o={cat:defaultdict(float) for cat in CATS}
        for d,recs in lh:
            if not inside(d,t):continue
            for r in recs:
                if r['pitchFamily'] in o:sum_dict(o[r['pitchFamily']],r)
        lc[t]={cat:dict(v) for cat,v in o.items()};return lc[t]
    def smix(pid,t):
        p=pagg(pid,t);allp=float(p.get('allPitches',0));catp=float(p.get('categorizedPitches',0))
        return {'allPitches':allp,'categorizedShare':catp/allp if allp else 0.0,'mix':{cat:(float(p.get(cat,0))/catp if catp else 0.0) for cat in CATS}}
    def rate(r,m):
        if m in ('contact','whiff'):
            den=float(r.get('swings',0));num=float(r.get('contacts' if m=='contact' else 'whiffs',0));mn=float(rel['minimumTeamSwingsPerPitchFamily'])
        else:
            den=float(r.get('terminalPa',0));num=float(r.get('tb' if m=='tbpa' else 'hr',0));mn=float(rel['minimumTeamTerminalPaPerPitchFamily'])
        return num/den if den>=mn and den>0 else None
    def wr(tid,pid,t,m):
        sm=smix(pid,t);ta=tagg(tid,t);la=lagg(t);num=cov=0.0
        for cat,w in sm['mix'].items():
            tr=rate(ta[cat],m);lr=rate(la[cat],m)
            if tr is None or lr is None:continue
            num+=w*(tr-lr);cov+=w
        return {'value':num/cov if cov>0 else None,'coverage':cov,'starter':sm}

    rows=[];thr=v7['thresholdSelection2023'];m1=v7['fitted2022Models']['F5_C4'];m2=v7['fitted2022Models']['F5_FULL13']
    for s in EVAL:
        tab=load(os.path.join(a.root,s,'game-anatomy-feature-table.json'))
        if tab.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'STEP12V13_BASE_SCHEMA:{s}')
        for r in tab['rows']:
            if not r.get('t5PregameValid'):continue
            f=r['features'];A=is_a(f,ac);route=frozen_v7_prob(f,m1)>=float(thr['c4']) and frozen_v7_prob(f,m2)>=float(thr['full13'])
            f5=r['outcomes']['FIRST_5'];y=None if f5['homeRuns']==f5['awayRuns'] else int(f5['homeRuns']>f5['awayRuns'])
            hp=r.get('t5HomeProbablePitcherId');awp=r.get('t5AwayProbablePitcherId')
            if route and not A:rows.append({'season':s,'date':r['officialDate'],'gamePk':int(r['gamePk']),'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homeStarterId':int(hp) if hp is not None else None,'awayStarterId':int(awp) if awp is not None else None,'y':y})
    fb=c['frozenPopulation']['frozenBaseline'];dec=[x for x in rows if x['y'] is not None];w=sum(x['y'] for x in dec)
    actual=(len(rows),len(dec),w,len(dec)-w,len(rows)-len(dec));expected=tuple(int(fb[k]) for k in ('selectedRows','decisiveRows','wins','losses','pushes'))
    if actual!=expected:raise SystemExit(f'STEP12V13_FROZEN_BASELINE_DRIFT:{actual}:{expected}')

    def enrich(x):
        x=dict(x);t=date.fromisoformat(x['date']);reason=[]
        if x['homeStarterId'] is None or x['awayStarterId'] is None:
            x.update({m:None for m in METRICS});x['eligible']=False;x['positiveCount']=0;return x
        hs=smix(x['homeStarterId'],t);aws=smix(x['awayStarterId'],t)
        for label,sm in (('HOME',hs),('AWAY',aws)):
            if sm['allPitches']<float(rel['minimumStarterAllPitches365d']):reason.append(label+'_LOW_PITCHES')
            if sm['categorizedShare']<float(rel['minimumStarterCategorizedShare']):reason.append(label+'_LOW_CATEGORY_SHARE')
        pairs={}
        for name,m in (('CONTACT','contact'),('WHIFF','whiff'),('TBPA','tbpa'),('HRPA','hrpa')):
            h=wr(x['homeTeamId'],x['awayStarterId'],t,m);aa=wr(x['awayTeamId'],x['homeStarterId'],t,m);pairs[name]=(h,aa)
            if h['coverage']<float(rel['minimumWeightedMetricCoverageShare']) or aa['coverage']<float(rel['minimumWeightedMetricCoverageShare']):reason.append(name+'_LOW_COVERAGE')
        vals={
          'pitchmix_rel_contact_adv':None if any(z['value'] is None for z in pairs['CONTACT']) else pairs['CONTACT'][0]['value']-pairs['CONTACT'][1]['value'],
          'pitchmix_rel_whiff_adv':None if any(z['value'] is None for z in pairs['WHIFF']) else pairs['WHIFF'][1]['value']-pairs['WHIFF'][0]['value'],
          'pitchmix_rel_tbpa_adv':None if any(z['value'] is None for z in pairs['TBPA']) else pairs['TBPA'][0]['value']-pairs['TBPA'][1]['value'],
          'pitchmix_rel_hrpa_adv':None if any(z['value'] is None for z in pairs['HRPA']) else pairs['HRPA'][0]['value']-pairs['HRPA'][1]['value']}
        if any(v is None for v in vals.values()):reason.append('METRIC_VALUE_MISSING')
        x.update(vals);x['eligible']=not reason;x['positiveCount']=sum(1 for v in vals.values() if finite(v) and float(v)>0);return x
    rows=[enrich(x) for x in rows];eligible=[x for x in rows if x['eligible']]

    def stats(z):
        d=[x for x in z if x['y'] is not None];n=len(d);wins=sum(x['y'] for x in d);months=sorted(set(x['date'][:7] for x in d));by={}
        for s in EVAL:
            sd=[x for x in d if x['season']==s];sw=sum(x['y'] for x in sd);by[s]={'decisiveRows':len(sd),'wins':sw,'losses':len(sd)-sw,'hitRate':sw/len(sd) if sd else None}
        loo=None
        if len(months)>1:
            vals=[]
            for mon in months:
                q=[x for x in d if x['date'][:7]!=mon];qw=sum(x['y'] for x in q);vals.append((qw/len(q) if q else 0,mon,len(q),qw))
            hr,mon,nn,ww=min(vals);loo={'removedMonth':mon,'decisiveRows':nn,'wins':ww,'hitRate':hr}
        return {'selectedRows':len(z),'decisiveRows':n,'pushes':len(z)-n,'wins':wins,'losses':n-wins,'hitRate':wins/n if n else None,'wilson95':wilson(wins,n),'bySeason':by,'minimumLeaveOneMonthOut':loo}

    eb=c['frozenPopulation']['pitchmixEligibleBaseline'];es=stats(eligible);ea=tuple(es[k] for k in ('selectedRows','decisiveRows','wins','losses','pushes'));ee=tuple(int(eb[k]) for k in ('selectedRows','decisiveRows','wins','losses','pushes'))
    if ea!=ee:raise SystemExit(f'STEP12V13_ELIGIBLE_BASELINE_DRIFT:{ea}:{ee}')
    if abs(es['hitRate']-float(eb['hitRate']))>1e-12:raise SystemExit('STEP12V13_ELIGIBLE_HITRATE_DRIFT')

    def flags(x):
        hr=finite(x['pitchmix_rel_hrpa_adv']) and float(x['pitchmix_rel_hrpa_adv'])>0;tb=finite(x['pitchmix_rel_tbpa_adv']) and float(x['pitchmix_rel_tbpa_adv'])>0;at2=int(x['positiveCount'])>=2
        return hr,tb,at2
    anchors={'HRPA_POS':stats([x for x in eligible if flags(x)[0]]),'TBPA_POS':stats([x for x in eligible if flags(x)[1]]),'AT_LEAST_2_OF_4':stats([x for x in eligible if flags(x)[2]])}
    for name,exp in c['frozenV12Anchors'].items():
        a0=anchors[name];act=tuple(a0[k] for k in ('selectedRows','decisiveRows','wins','losses','pushes'));ex=tuple(int(exp[k]) for k in ('selectedRows','decisiveRows','wins','losses','pushes'))
        if act!=ex or abs(a0['hitRate']-float(exp['hitRate']))>1e-12:raise SystemExit(f'STEP12V13_ANCHOR_DRIFT:{name}:{act}:{ex}')
    for name in anchors:
        vr0=vr['signCohorts']['F5_CONSENSUS_OUTSIDE_A'][name]
        if tuple(anchors[name][k] for k in ('selectedRows','decisiveRows','wins','losses','pushes'))!=tuple(vr0[k] for k in ('selectedRows','decisiveRows','wins','losses','pushes')):raise SystemExit(f'STEP12V13_V12_REPORT_ANCHOR_DRIFT:{name}')

    def take(x,name):
        hr,tb,at2=flags(x)
        return {'DAMAGE_ANY_POS':hr or tb,'HRPA_OR_AT2':hr or at2,'TBPA_OR_AT2':tb or at2,'PARETO_UNION':hr or tb or at2,'DAMAGE_AND_AT2':(hr or tb) and at2,'HRPA_AND_TBPA':hr and tb}[name]
    base_hr=float(eb['hitRate']);base_n=int(eb['decisiveRows']);results={};tests=[];rubric=c['candidateRubric']['coreGeneralizationCandidate'];vp=c['volumePolicy']
    for name in c['predeclaredGeneralizations']:
        z=[x for x in eligible if take(x,name)];st=stats(z);st['retainedDecisivePctOfEligible']=100*st['decisiveRows']/base_n if base_n else None;st['liftVsEligibleBaselinePp']=100*(st['hitRate']-base_hr) if st['hitRate'] is not None else None;st['liftVsFrozenBaselinePp']=100*(st['hitRate']-float(fb['hitRate'])) if st['hitRate'] is not None else None
        lost=100-st['retainedDecisivePctOfEligible'];st['precisionGainPer10PctEligibleVolumeLost']=st['liftVsEligibleBaselinePp']/(lost/10) if lost>0 else None
        by_ok=all(v['decisiveRows']>0 and v['hitRate']>=float(rubric['minimumHitRateEverySeason']) for v in st['bySeason'].values());loo_ok=st['minimumLeaveOneMonthOut'] is not None and st['minimumLeaveOneMonthOut']['hitRate']>=float(rubric['minimumLeaveOneMonthOutHitRate'])
        if st['decisiveRows']<int(vp['selectiveShadowMinimumDecisiveRows']):label='TOO_THIN'
        elif st['decisiveRows']<int(vp['coreMinimumDecisiveRows']):label='SELECTIVE_SHADOW_ONLY'
        else:
            quality=st['liftVsEligibleBaselinePp']>=float(rubric['minimumLiftVsEligibleBaselinePp']) and by_ok and loo_ok and st['retainedDecisivePctOfEligible']>=float(vp['minimumCoreRetainedPctOfEligibleDecisions'])
            label='CORE_GENERALIZATION_CANDIDATE' if quality else 'CORE_VOLUME_ONLY'
        st['classification']=label;st['qualityGates']={'seasonStability':by_ok,'leaveOneMonthOut':loo_ok};results[name]=st
        dsel=[x for x in z if x['y'] is not None];comp=[x for x in eligible if not take(x,name) and x['y'] is not None];sw=sum(x['y'] for x in dsel);cw=sum(x['y'] for x in comp);p=float(fisher_exact([[sw,len(dsel)-sw],[cw,len(comp)-cw]],alternative='two-sided').pvalue) if dsel and comp else 1.0
        tests.append({'cohort':name,'selectedWins':sw,'selectedLosses':len(dsel)-sw,'complementWins':cw,'complementLosses':len(comp)-cw,'rawP':p})
    adj=holm([x['rawP'] for x in tests])
    for t,p in zip(tests,adj):t['holmAdjustedP']=p
    pareto=[]
    for n,a0 in results.items():
        dom=False
        for m,b in results.items():
            if m==n or a0['hitRate'] is None or b['hitRate'] is None:continue
            if b['hitRate']>=a0['hitRate'] and b['decisiveRows']>=a0['decisiveRows'] and (b['hitRate']>a0['hitRate'] or b['decisiveRows']>a0['decisiveRows']):dom=True;break
        if not dom:pareto.append(n)
    report={'schemaVersion':SCHEMA,'classification':'POST_V12_F5_DAMAGE_GENERALIZATION_DISCOVERY_NOT_CONFIRMATION','frozenBaseline':stats(rows),'eligibleBaseline':es,'reproducedV12Anchors':anchors,'generalizations':results,'fisherTests':tests,'paretoEfficientGeneralizations':pareto,'policy':{'sameDateOutcomeLeakageAllowed':False,'newMlbAcquisitionUsed':False,'liveFilterChangeAllowed':False,'rankingChangeAllowed':False,'stakeChangeAllowed':False,'betEliteAllowed':False,'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'classification':report['classification'],'eligibleBaseline':es,'anchors':anchors,'generalizations':results,'tests':tests,'pareto':pareto},indent=2))
if __name__=='__main__':main()
