#!/usr/bin/env python3
import argparse,json,math,os
from collections import Counter,defaultdict
from datetime import date,timedelta
import numpy as np
from scipy.stats import mannwhitneyu

SCHEMA='courtedge-p0-step12v12-pitchmix-lineup-matchup.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PACK_SCHEMA='courtedge-p0-step12v12-game-pitchmix-summary.v1'
EVAL=('2024','2025','2026_YTD')
ALL=('2023','2024','2025','2026_YTD')
CATS=('FASTBALL','BREAKING','OFFSPEED')
METRICS=('pitchmix_rel_contact_adv','pitchmix_rel_whiff_adv','pitchmix_rel_tbpa_adv','pitchmix_rel_hrpa_adv')


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)


def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False


def sigmoid(z):return 1.0/(1.0+math.exp(-max(-50.0,min(50.0,float(z)))))


def frozen_aplus_prob(features,model):
    z=float(model['intercept'])
    for f in model['features']:
        x=features.get(f['name'])
        if not finite(x):x=f['medianImpute']
        z+=float(f['coef'])*((float(x)-float(f['mean']))/float(f['scale']))
    return sigmoid(z)


def frozen_v7_prob(features,model):
    z=float(model['intercept'])
    for i,name in enumerate(model['features']):
        x=features.get(name)
        if not finite(x):x=model['medianImpute'][i]
        z+=float(model['coef'][i])*((float(x)-float(model['mean'][i]))/float(model['scale'][i]))
    return sigmoid(z)


def is_a(features,contract):
    return all(finite(features.get(x['feature'])) and float(features[x['feature']])>=float(x['threshold']) for x in contract['premiumA']['all'])


def is_aplus(features,contract):
    if not is_a(features,contract):return False
    ap=contract['aPlusConsensus']
    return frozen_aplus_prob(features,ap['models']['ML_C4_2022_FROZEN'])>=float(ap['thresholds']['c4PHomeGTE']) and frozen_aplus_prob(features,ap['models']['ML_FULL13_2022_FROZEN'])>=float(ap['thresholds']['full13PHomeGTE'])


def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}


def holm(ps):
    m=len(ps);order=sorted(range(m),key=lambda i:ps[i]);out=[1.0]*m;running=0.0
    for rank,i in enumerate(order):
        v=min(1.0,(m-rank)*ps[i]);running=max(running,v);out[i]=running
    return out


def cliffs_delta(x,y):
    if not x or not y:return None
    gt=lt=0
    for a in x:
        for b in y:
            if a>b:gt+=1
            elif a<b:lt+=1
    return (gt-lt)/(len(x)*len(y))


def sum_dict(dst,src,sign=1):
    for k,v in src.items():
        if isinstance(v,(int,float)):dst[k]+=sign*v


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--pitch-dir',required=True);ap.add_argument('--v7-report',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);ac=load(a.a_contract);v7=load(a.v7_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v12-pitchmix-lineup-matchup-contract.v1':raise SystemExit('STEP12V12_CONTRACT_INVALID')
    lookback=int(c['dataBoundary']['rollingLookbackDays']);rel=c['reliability']

    pitcher_hist=defaultdict(list);team_hist=defaultdict(list);league_hist=[]
    pack_diag={}
    for s in ALL:
        pack=load(os.path.join(a.pitch_dir,f'pitchmix-{s}.json'))
        if pack.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'STEP12V12_PACK_SCHEMA:{s}')
        pack_diag[s]={k:pack[k] for k in ('gamesExpected','gamesFetched','allPitchEvents','categorizedPitchEvents','categorizedPitchShare','terminalPaWithFamily')}
        for g in pack['games']:
            d=date.fromisoformat(g['officialDate'])
            for pr in g['pitcherTotals']:pitcher_hist[int(pr['pitcherId'])].append((d,pr))
            byteam=defaultdict(list)
            for tr in g['teamPitchFamilyTotals']:byteam[int(tr['teamId'])].append(tr)
            for tid,recs in byteam.items():team_hist[tid].append((d,recs))
            league_hist.append((d,g['teamPitchFamilyTotals']))
    for h in pitcher_hist.values():h.sort(key=lambda x:x[0])
    for h in team_hist.values():h.sort(key=lambda x:x[0])
    league_hist.sort(key=lambda x:x[0])

    pcache={};tcache={};lcache={}
    def in_window(d,target):return target-timedelta(days=lookback)<=d<target
    def pitcher_agg(pid,target):
        key=(pid,target);z=pcache.get(key)
        if z is not None:return z
        out=defaultdict(float)
        for d,r in pitcher_hist.get(int(pid),[]):
            if in_window(d,target):sum_dict(out,r)
        z=dict(out);pcache[key]=z;return z
    def team_agg(tid,target):
        key=(tid,target);z=tcache.get(key)
        if z is not None:return z
        out={cat:defaultdict(float) for cat in CATS}
        for d,recs in team_hist.get(int(tid),[]):
            if not in_window(d,target):continue
            for r in recs:
                cat=r['pitchFamily']
                if cat in out:sum_dict(out[cat],r)
        z={cat:dict(v) for cat,v in out.items()};tcache[key]=z;return z
    def league_agg(target):
        z=lcache.get(target)
        if z is not None:return z
        out={cat:defaultdict(float) for cat in CATS}
        for d,recs in league_hist:
            if not in_window(d,target):continue
            for r in recs:
                cat=r['pitchFamily']
                if cat in out:sum_dict(out[cat],r)
        z={cat:dict(v) for cat,v in out.items()};lcache[target]=z;return z

    def starter_mix(pid,target):
        p=pitcher_agg(pid,target);allp=float(p.get('allPitches',0));catp=float(p.get('categorizedPitches',0))
        mix={cat:(float(p.get(cat,0))/catp if catp else 0.0) for cat in CATS}
        return {'allPitches':allp,'categorizedPitches':catp,'categorizedShare':catp/allp if allp else 0.0,'mix':mix}

    def rate(rec,metric):
        if metric in ('contact','whiff'):
            den=float(rec.get('swings',0));num=float(rec.get('contacts' if metric=='contact' else 'whiffs',0));minimum=float(rel['minimumTeamSwingsPerPitchFamily'])
        else:
            den=float(rec.get('terminalPa',0));num=float(rec.get('tb' if metric=='tbpa' else 'hr',0));minimum=float(rel['minimumTeamTerminalPaPerPitchFamily'])
        return (num/den if den>=minimum and den>0 else None,den)

    def weighted_relative(team_id,starter_id,target,metric):
        sm=starter_mix(starter_id,target);ta=team_agg(team_id,target);la=league_agg(target)
        num=0.0;coverage=0.0
        for cat,w in sm['mix'].items():
            tr,_=rate(ta[cat],metric);lr,_=rate(la[cat],metric)
            if tr is None or lr is None:continue
            num+=w*(tr-lr);coverage+=w
        return {'value':num/coverage if coverage>0 else None,'coverage':coverage,'starter':sm}

    # Recreate frozen target populations exactly. Missing probable-starter IDs remain
    # in the frozen population and are handled later as ineligible matchup rows.
    rows=[]
    thresholds=v7['thresholdSelection2023'];m1=v7['fitted2022Models']['F5_C4'];m2=v7['fitted2022Models']['F5_FULL13']
    for s in EVAL:
        table=load(os.path.join(a.root,s,'game-anatomy-feature-table.json'))
        if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'STEP12V12_BASE_SCHEMA:{s}')
        for r in table['rows']:
            if not r.get('t5PregameValid'):continue
            f=r['features'];A=is_a(f,ac);Aplus=is_aplus(f,ac)
            p1=frozen_v7_prob(f,m1);p2=frozen_v7_prob(f,m2);F5route=p1>=float(thresholds['c4']) and p2>=float(thresholds['full13'])
            fg=r['outcomes']['FULL_GAME'];f5=r['outcomes']['FIRST_5'];f5y=None if f5['homeRuns']==f5['awayRuns'] else int(f5['homeRuns']>f5['awayRuns'])
            hp=r.get('t5HomeProbablePitcherId');ap_=r.get('t5AwayProbablePitcherId')
            rows.append({'season':s,'date':r['officialDate'],'gamePk':int(r['gamePk']),'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homeStarterId':int(hp) if hp is not None else None,'awayStarterId':int(ap_) if ap_ is not None else None,'A':A,'Aplus':Aplus,'F5route':F5route,'fgy':int(fg['homeRuns']>fg['awayRuns']),'f5y':f5y})
    aplus=[x for x in rows if x['Aplus']];f5out=[x for x in rows if x['F5route'] and not x['A']]
    fp=c['frozenPopulations']
    if len(aplus)!=int(fp['A_PLUS_FULL_GAME_HOME']['expectedSelectedRows']):raise SystemExit(f'STEP12V12_APLUS_COUNT:{len(aplus)}')
    dec=[x for x in f5out if x['f5y'] is not None];wins=sum(x['f5y'] for x in dec)
    exp=fp['F5_CONSENSUS_OUTSIDE_A']
    actual=(len(f5out),len(dec),wins,len(dec)-wins,len(f5out)-len(dec));expected=(int(exp['expectedSelectedRows']),int(exp['expectedDecisiveRows']),int(exp['expectedWins']),int(exp['expectedLosses']),int(exp['expectedPushes']))
    if actual!=expected:raise SystemExit(f'STEP12V12_F5_BASELINE_DRIFT:{actual}:{expected}')

    reasons=Counter()
    def enrich(x):
        target=date.fromisoformat(x['date'])
        if x['homeStarterId'] is None or x['awayStarterId'] is None:
            vals={m:None for m in METRICS};x=dict(x);x.update(vals);x['eligible']=False;x['eligibilityReasons']=['STARTER_ID_MISSING'];x['positiveCount']=0
            x['diagnostic']={'homeStarterAllPitches':None,'awayStarterAllPitches':None,'homeStarterCategorizedShare':None,'awayStarterCategorizedShare':None,'metricCoverage':{k:{'home':0.0,'away':0.0} for k in ('CONTACT','WHIFF','TBPA','HRPA')}}
            reasons['STARTER_ID_MISSING']+=1
            return x
        hs=starter_mix(x['homeStarterId'],target);aws=starter_mix(x['awayStarterId'],target)
        reason=[]
        for label,sm in (('HOME_STARTER',hs),('AWAY_STARTER',aws)):
            if sm['allPitches']<float(rel['minimumStarterAllPitches365d']):reason.append(label+'_LOW_PITCHES')
            if sm['categorizedShare']<float(rel['minimumStarterCategorizedShare']):reason.append(label+'_LOW_CATEGORY_SHARE')
        h_contact=weighted_relative(x['homeTeamId'],x['awayStarterId'],target,'contact');a_contact=weighted_relative(x['awayTeamId'],x['homeStarterId'],target,'contact')
        h_whiff=weighted_relative(x['homeTeamId'],x['awayStarterId'],target,'whiff');a_whiff=weighted_relative(x['awayTeamId'],x['homeStarterId'],target,'whiff')
        h_tb=weighted_relative(x['homeTeamId'],x['awayStarterId'],target,'tbpa');a_tb=weighted_relative(x['awayTeamId'],x['homeStarterId'],target,'tbpa')
        h_hr=weighted_relative(x['homeTeamId'],x['awayStarterId'],target,'hrpa');a_hr=weighted_relative(x['awayTeamId'],x['homeStarterId'],target,'hrpa')
        parts={'CONTACT':(h_contact,a_contact),'WHIFF':(h_whiff,a_whiff),'TBPA':(h_tb,a_tb),'HRPA':(h_hr,a_hr)}
        for name,(h,a_) in parts.items():
            if h['coverage']<float(rel['minimumWeightedMetricCoverageShare']) or a_['coverage']<float(rel['minimumWeightedMetricCoverageShare']):reason.append(name+'_LOW_COVERAGE')
        vals={
            'pitchmix_rel_contact_adv':None if h_contact['value'] is None or a_contact['value'] is None else h_contact['value']-a_contact['value'],
            'pitchmix_rel_whiff_adv':None if h_whiff['value'] is None or a_whiff['value'] is None else a_whiff['value']-h_whiff['value'],
            'pitchmix_rel_tbpa_adv':None if h_tb['value'] is None or a_tb['value'] is None else h_tb['value']-a_tb['value'],
            'pitchmix_rel_hrpa_adv':None if h_hr['value'] is None or a_hr['value'] is None else h_hr['value']-a_hr['value']
        }
        if any(v is None for v in vals.values()):reason.append('METRIC_VALUE_MISSING')
        x=dict(x);x.update(vals);x['eligible']=not reason;x['eligibilityReasons']=reason;x['positiveCount']=sum(1 for v in vals.values() if v is not None and v>0)
        x['diagnostic']={'homeStarterAllPitches':hs['allPitches'],'awayStarterAllPitches':aws['allPitches'],'homeStarterCategorizedShare':hs['categorizedShare'],'awayStarterCategorizedShare':aws['categorizedShare'],'metricCoverage':{k:{'home':v[0]['coverage'],'away':v[1]['coverage']} for k,v in parts.items()}}
        for rr in reason:reasons[rr]+=1
        return x
    aplus=[enrich(x) for x in aplus];f5out=[enrich(x) for x in f5out]

    def basic_stats(pop,target,original_selected,core_floor,core_on_decisive):
        sel=len(pop);dec=[x for x in pop if x[target] is not None];n=len(dec);w=sum(int(x[target]) for x in dec);months=sorted(set(x['date'][:7] for x in dec))
        by={}
        for s in EVAL:
            z=[x for x in pop if x['season']==s];zd=[x for x in z if x[target] is not None];nw=len(zd);ww=sum(int(x[target]) for x in zd)
            by[s]={'selectedRows':len(z),'decisiveRows':nw,'pushes':len(z)-nw,'wins':ww,'losses':nw-ww,'hitRate':ww/nw if nw else None}
        loo=None
        if n and len(months)>1:
            candidates=[]
            for mon in months:
                z=[x for x in dec if x['date'][:7]!=mon];nn=len(z);ww=sum(int(x[target]) for x in z);candidates.append((ww/nn if nn else 0,mon,nn,ww))
            hr,mon,nn,ww=min(candidates);loo={'removedMonth':mon,'decisiveRows':nn,'wins':ww,'hitRate':hr}
        vol=n if core_on_decisive else sel
        if vol>=core_floor:label='CORE_VOLUME'
        elif n>=int(c['volumePolicy']['selectiveShadowMinimumDecisiveRows']):label='SELECTIVE_SHADOW_VOLUME'
        else:label='TOO_THIN'
        return {'selectedRows':sel,'decisiveRows':n,'pushes':sel-n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'retainedSelectedPctOfOriginal':100*sel/original_selected if original_selected else None,'bySeason':by,'minimumLeaveOneMonthOut':loo,'activeMonths':len(months),'volumeLabel':label}

    populations={
        'A_PLUS_FULL_GAME_HOME':{'rows':aplus,'target':'fgy','original':len(aplus),'coreFloor':int(c['volumePolicy']['aPlusCoreMinimumSelectedRows']),'coreOnDecisive':False},
        'F5_CONSENSUS_OUTSIDE_A':{'rows':f5out,'target':'f5y','original':len(f5out),'coreFloor':int(c['volumePolicy']['f5OutsideACoreMinimumDecisiveRows']),'coreOnDecisive':True}
    }
    pop_reports={};tests=[];cohorts={};pareto={}
    for pname,spec in populations.items():
        eligible=[x for x in spec['rows'] if x['eligible']];target=spec['target']
        full=basic_stats(spec['rows'],target,spec['original'],spec['coreFloor'],spec['coreOnDecisive']);elig=basic_stats(eligible,target,spec['original'],spec['coreFloor'],spec['coreOnDecisive'])
        full['eligibleRows']=len(eligible);full['eligibleShare']=len(eligible)/len(spec['rows']) if spec['rows'] else 0.0
        pop_reports[pname]={'frozenBaseline':full,'eligibleBaseline':elig}
        decisive=[x for x in eligible if x[target] is not None]
        for metric in METRICS:
            win=[float(x[metric]) for x in decisive if x[target]==1 and finite(x[metric])];loss=[float(x[metric]) for x in decisive if x[target]==0 and finite(x[metric])]
            p=float(mannwhitneyu(win,loss,alternative='two-sided').pvalue) if win and loss else 1.0
            tests.append({'population':pname,'feature':metric,'winnerN':len(win),'loserN':len(loss),'winnerMean':float(np.mean(win)) if win else None,'loserMean':float(np.mean(loss)) if loss else None,'winnerMedian':float(np.median(win)) if win else None,'loserMedian':float(np.median(loss)) if loss else None,'cliffsDelta':cliffs_delta(win,loss),'rawP':p})
        base_hr=elig['hitRate'];base_dec=elig['decisiveRows'];cohorts[pname]={}
        for cname,cs in c['predeclaredSignCohorts'].items():
            if 'feature' in cs:z=[x for x in eligible if finite(x[cs['feature']]) and float(x[cs['feature']])>float(cs['threshold'])]
            else:z=[x for x in eligible if int(x['positiveCount'])>=int(cs['positiveCountGTE'])]
            st=basic_stats(z,target,spec['original'],spec['coreFloor'],spec['coreOnDecisive']);st['retainedDecisivePctOfEligible']=100*st['decisiveRows']/base_dec if base_dec else None
            st['precisionGainVsEligibleBaselinePp']=100*(st['hitRate']-base_hr) if st['hitRate'] is not None and base_hr is not None else None
            lost=100-(st['retainedDecisivePctOfEligible'] or 0);st['precisionGainPer10PctDecisiveVolumeLost']=(st['precisionGainVsEligibleBaselinePp']/(lost/10)) if lost>0 and st['precisionGainVsEligibleBaselinePp'] is not None else None
            cohorts[pname][cname]=st
        names=list(cohorts[pname]);front=[]
        for n in names:
            a_=cohorts[pname][n];dom=False
            for m in names:
                if m==n:continue
                b=cohorts[pname][m]
                if b['hitRate'] is None or a_['hitRate'] is None:continue
                if b['hitRate']>=a_['hitRate'] and b['decisiveRows']>=a_['decisiveRows'] and (b['hitRate']>a_['hitRate'] or b['decisiveRows']>a_['decisiveRows']):dom=True;break
            if not dom:front.append(n)
        pareto[pname]=front
    adj=holm([x['rawP'] for x in tests])
    for t,p in zip(tests,adj):t['holmAdjustedP']=p

    a_cov=pop_reports['A_PLUS_FULL_GAME_HOME']['frozenBaseline']['eligibleShare'];f_cov=pop_reports['F5_CONSENSUS_OUTSIDE_A']['frozenBaseline']['eligibleShare']
    coverage_ok=a_cov>=float(rel['minimumAPlusEligibleShare']) and f_cov>=float(rel['minimumF5OutsideASelectedEligibleShare'])
    classification='PITCH_MIX_MATCHUP_DISCOVERY_NOT_CONFIRMATION' if coverage_ok else rel['belowCoverageClassification']
    report={
        'schemaVersion':SCHEMA,'classification':classification,'packDiagnostics':pack_diag,
        'coverage':{'aPlusEligibleShare':a_cov,'f5OutsideASelectedEligibleShare':f_cov,'requirements':{'aPlus':rel['minimumAPlusEligibleShare'],'f5OutsideA':rel['minimumF5OutsideASelectedEligibleShare']},'ineligibleReasons':dict(reasons)},
        'populations':pop_reports,'continuousTests':tests,'signCohorts':cohorts,'paretoEfficientCohorts':pareto,
        'policy':{'sameDateOutcomeLeakageAllowed':False,'futureGamePitchDataAllowed':False,'liveFilterChangeAllowed':False,'rankingChangeAllowed':False,'stakeChangeAllowed':False,'betEliteAllowed':False,'prospective11cRequired':True}
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'classification':classification,'coverage':report['coverage'],'populations':pop_reports,'tests':tests,'cohorts':cohorts,'pareto':pareto},indent=2))

if __name__=='__main__':main()
