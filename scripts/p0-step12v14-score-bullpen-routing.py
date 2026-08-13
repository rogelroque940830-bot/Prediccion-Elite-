#!/usr/bin/env python3
import argparse,json,math,os
from collections import Counter,defaultdict
from datetime import date,timedelta
from scipy.stats import mannwhitneyu

SCHEMA='courtedge-p0-step12v14-bullpen-availability-routing.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PACK_SCHEMA='courtedge-p0-step12v14-game-bullpen-summary.v1'
EVAL=('2024','2025','2026_YTD')
ALL=('2023','2024','2025','2026_YTD')
METRICS=('bullpen_pitches_1d_adv','bullpen_pitches_3d_adv','bullpen_core3_pitches_2d_adv','bullpen_b2b_arms_adv')


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)


def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False


def sigmoid(z):return 1.0/(1.0+math.exp(-max(-50.0,min(50.0,float(z)))))


def frozen_prob(features,model):
    z=float(model['intercept'])
    for f in model['features']:
        x=features.get(f['name'])
        if not finite(x):x=f['medianImpute']
        z+=float(f['coef'])*((float(x)-float(f['mean']))/float(f['scale']))
    return sigmoid(z)


def is_a(features,contract):
    return all(finite(features.get(x['feature'])) and float(features[x['feature']])>=float(x['threshold']) for x in contract['premiumA']['all'])


def is_aplus(features,contract):
    if not is_a(features,contract):return False
    ap=contract['aPlusConsensus']
    return frozen_prob(features,ap['models']['ML_C4_2022_FROZEN'])>=float(ap['thresholds']['c4PHomeGTE']) and frozen_prob(features,ap['models']['ML_FULL13_2022_FROZEN'])>=float(ap['thresholds']['full13PHomeGTE'])


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


def stats(pop,target):
    sel=len(pop);dec=[x for x in pop if x[target] is not None];n=len(dec);w=sum(int(x[target]) for x in dec)
    by={}
    for s in EVAL:
        z=[x for x in pop if x['season']==s];zd=[x for x in z if x[target] is not None];nw=len(zd);ww=sum(int(x[target]) for x in zd)
        by[s]={'selectedRows':len(z),'decisiveRows':nw,'pushes':len(z)-nw,'wins':ww,'losses':nw-ww,'hitRate':ww/nw if nw else None}
    months=sorted(set(x['date'][:7] for x in dec));loo=None
    if n and len(months)>1:
        cand=[]
        for m in months:
            z=[x for x in dec if x['date'][:7]!=m];nn=len(z);ww=sum(int(x[target]) for x in z)
            if nn:cand.append((ww/nn,m,ww,nn))
        if cand:
            r,m,ww,nn=min(cand)
            loo={'hitRate':r,'removedMonth':m,'wins':ww,'decisiveRows':nn}
    return {'selectedRows':sel,'decisiveRows':n,'pushes':sel-n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'bySeason':by,'leaveOneMonthOutMinimum':loo}


def pareto(rows):
    out=[]
    for a in rows:
        dominated=False
        for b in rows:
            if a is b:continue
            if b['selectedRows']>=a['selectedRows'] and b['fgHitRate']>=a['fgHitRate'] and (b['selectedRows']>a['selectedRows'] or b['fgHitRate']>a['fgHitRate']):
                dominated=True;break
        if not dominated:out.append(a['cohort'])
    return out


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--bullpen-dir',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);ac=load(a.a_contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v14-bullpen-availability-routing-contract.v1':raise SystemExit('STEP12V14_CONTRACT_INVALID')

    hist=defaultdict(list);pack_diag={}
    for s in ALL:
        p=load(os.path.join(a.bullpen_dir,f'bullpen-{s}.json'))
        if p.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'STEP12V14_PACK_SCHEMA:{s}')
        pack_diag[s]={k:p[k] for k in ('gamesExpected','gamesFetched','identityCompleteGames','identityCompleteShare')}
        for g in p['games']:
            if not g.get('identityComplete'):continue
            d=date.fromisoformat(g['officialDate'])
            for side in ('home','away'):
                r=g[side];rel={int(x['pitcherId']):int(x['pitches']) for x in r['relievers']}
                hist[int(r['teamId'])].append({'date':d,'gamePk':int(g['gamePk']),'bullpenPitches':int(r['bullpenPitches']),'relievers':rel})
    for v in hist.values():v.sort(key=lambda x:(x['date'],x['gamePk']))

    lookback=int(c['rollingDefinitions']['coreRelieverLookbackDays']);core_n=int(c['rollingDefinitions']['coreRelieverCount']);core_days=int(c['rollingDefinitions']['coreRelieverWorkloadDays'])
    min_games=int(c['reliability']['minimumPriorBullpenGames30dPerTeam']);min_pool=int(c['reliability']['minimumCoreRelieverPool'])
    cache={}
    def team_profile(tid,target):
        key=(tid,target);z=cache.get(key)
        if z is not None:return z
        rows=[r for r in hist.get(int(tid),[]) if target-timedelta(days=lookback)<=r['date']<target]
        pool=defaultdict(int)
        for r in rows:
            for pid,p in r['relievers'].items():pool[pid]+=p
        core=[pid for pid,_ in sorted(pool.items(),key=lambda kv:(-kv[1],kv[0]))[:core_n]]
        d1=target-timedelta(days=1);d2=target-timedelta(days=2);d3=target-timedelta(days=3)
        p1=sum(r['bullpenPitches'] for r in rows if r['date']==d1)
        p3=sum(r['bullpenPitches'] for r in rows if d3<=r['date']<target)
        core2=sum(p for r in rows if target-timedelta(days=core_days)<=r['date']<target for pid,p in r['relievers'].items() if pid in core)
        ids1=set(pid for r in rows if r['date']==d1 for pid in r['relievers'])
        ids2=set(pid for r in rows if r['date']==d2 for pid in r['relievers'])
        z={'priorGames30d':len(rows),'relieverPool':len(pool),'coreRelievers':core,'pitches1d':p1,'pitches3d':p3,'corePitches2d':core2,'backToBackArms':len(ids1&ids2),'eligible':len(rows)>=min_games and len(pool)>=min_pool}
        cache[key]=z;return z

    rows=[]
    for s in EVAL:
        table=load(os.path.join(a.root,s,'game-anatomy-feature-table.json'))
        if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'STEP12V14_BASE_SCHEMA:{s}')
        for r in table['rows']:
            if not r.get('t5PregameValid'):continue
            f=r['features'];A=is_a(f,ac);Ap=is_aplus(f,ac)
            if not A:continue
            fg=r['outcomes']['FULL_GAME'];f5=r['outcomes']['FIRST_5'];f5y=None if f5['homeRuns']==f5['awayRuns'] else int(f5['homeRuns']>f5['awayRuns'])
            target=date.fromisoformat(r['officialDate']);hp=team_profile(int(r['homeTeamId']),target);aprof=team_profile(int(r['awayTeamId']),target)
            eligible=bool(hp['eligible'] and aprof['eligible'])
            vals={
                'bullpen_pitches_1d_adv':aprof['pitches1d']-hp['pitches1d'],
                'bullpen_pitches_3d_adv':aprof['pitches3d']-hp['pitches3d'],
                'bullpen_core3_pitches_2d_adv':aprof['corePitches2d']-hp['corePitches2d'],
                'bullpen_b2b_arms_adv':aprof['backToBackArms']-hp['backToBackArms'],
            }
            rows.append({'season':s,'date':r['officialDate'],'gamePk':int(r['gamePk']),'A':A,'Aplus':Ap,'fgy':int(fg['homeRuns']>fg['awayRuns']),'f5y':f5y,'eligible':eligible,'homeProfile':hp,'awayProfile':aprof,**vals,'positiveCount':sum(1 for v in vals.values() if v>0)})

    popA=[x for x in rows if x['A']];popAp=[x for x in rows if x['Aplus']]
    fp=c['frozenPopulations']
    if len(popA)!=int(fp['PREMIUM_A_FULL_GAME_HOME']['expectedSelectedRows']):raise SystemExit(f'STEP12V14_A_COUNT:{len(popA)}')
    if len(popAp)!=int(fp['A_PLUS_FULL_GAME_HOME']['expectedSelectedRows']):raise SystemExit(f'STEP12V14_APLUS_COUNT:{len(popAp)}')
    eligA=[x for x in popA if x['eligible']];eligAp=[x for x in popAp if x['eligible']]
    covA=len(eligA)/len(popA);covAp=len(eligAp)/len(popAp)
    coveragePass=covA>=float(c['reliability']['minimumPremiumAEligibleShare']) and covAp>=float(c['reliability']['minimumAPlusEligibleShare'])

    tests=[];raw=[]
    for pname,pop in (('PREMIUM_A_FULL_GAME_HOME',eligA),('A_PLUS_FULL_GAME_HOME',eligAp)):
        for m in METRICS:
            w=[float(x[m]) for x in pop if x['fgy']==1];l=[float(x[m]) for x in pop if x['fgy']==0]
            if w and l:
                u,p=mannwhitneyu(w,l,alternative='two-sided');d=cliffs_delta(w,l)
            else:u=p=d=None
            tests.append({'population':pname,'metric':m,'winsN':len(w),'lossesN':len(l),'mannWhitneyU':u,'rawP':p,'cliffsDelta':d});raw.append(1.0 if p is None else float(p))
    adj=holm(raw)
    for i,v in enumerate(adj):tests[i]['holmP']=v

    defs=c['predeclaredSignCohorts']
    def match(x,name):
        d=defs[name]
        if 'feature' in d:return float(x[d['feature']])>float(d['threshold'])
        return int(x['positiveCount'])>=int(d['positiveCountGTE'])

    cohorts={};frontier={}
    for pname,pop,orig in (('PREMIUM_A_FULL_GAME_HOME',eligA,len(popA)),('A_PLUS_FULL_GAME_HOME',eligAp,len(popAp))):
        arr=[];by={}
        for name in defs:
            sel=[x for x in pop if match(x,name)];fgs=stats(sel,'fgy');f5s=stats(sel,'f5y');comp=[x for x in pop if not match(x,name)];cfg=stats(comp,'fgy');cf5=stats(comp,'f5y')
            lift=None if fgs['hitRate'] is None or f5s['hitRate'] is None else (f5s['hitRate']-fgs['hitRate'])*100
            min_shadow=int(c['routingDiagnostics']['minimumF5DecisiveRowsForRoutingShadow']);min_core=int(c['routingDiagnostics']['minimumF5DecisiveRowsForRoutingCore']);req=float(c['routingDiagnostics']['minimumAbsoluteF5MinusFullGameLiftPpForRouterCandidate'])
            if f5s['decisiveRows']>=min_core and lift is not None and abs(lift)>=req:routeClass='CORE_ROUTING_DIAGNOSTIC'
            elif f5s['decisiveRows']>=min_shadow and lift is not None and abs(lift)>=req:routeClass='SHADOW_ROUTING_DIAGNOSTIC'
            else:routeClass='NO_ROUTING_CLASSIFICATION'
            rec={'cohort':name,'selectedRows':len(sel),'retainedOriginalVolumePct':len(sel)/orig*100 if orig else 0.0,'fg':fgs,'f5':f5s,'f5MinusFgHitRatePp':lift,'routingDirection':('F5' if lift is not None and lift>0 else 'FULL_GAME' if lift is not None and lift<0 else 'NONE'),'routingClassification':routeClass,'complementFg':cfg,'complementF5':cf5}
            by[name]=rec;arr.append({'cohort':name,'selectedRows':len(sel),'fgHitRate':fgs['hitRate'] or 0.0})
        cohorts[pname]=by;frontier[pname]=pareto(arr)

    ineligible=Counter()
    for x in popA:
        if x['eligible']:continue
        if x['homeProfile']['priorGames30d']<min_games:ineligible['HOME_LOW_PRIOR_BULLPEN_GAMES']+=1
        if x['awayProfile']['priorGames30d']<min_games:ineligible['AWAY_LOW_PRIOR_BULLPEN_GAMES']+=1
        if x['homeProfile']['relieverPool']<min_pool:ineligible['HOME_LOW_RELIEVER_POOL']+=1
        if x['awayProfile']['relieverPool']<min_pool:ineligible['AWAY_LOW_RELIEVER_POOL']+=1

    classification='BULLPEN_AVAILABILITY_ROUTING_DISCOVERY_NOT_CONFIRMATION' if coveragePass else c['reliability']['belowCoverageClassification']
    out={
        'schemaVersion':SCHEMA,'classification':classification,'packDiagnostics':pack_diag,
        'coverage':{'premiumAEligibleRows':len(eligA),'premiumATotalRows':len(popA),'premiumAEligibleShare':covA,'aPlusEligibleRows':len(eligAp),'aPlusTotalRows':len(popAp),'aPlusEligibleShare':covAp,'coverageGatePassed':coveragePass,'ineligibleReasons':dict(ineligible)},
        'populations':{
            'PREMIUM_A_FULL_GAME_HOME':{'frozenBaseline':stats(popA,'fgy'),'eligibleBaseline':stats(eligA,'fgy'),'eligibleF5SameGames':stats(eligA,'f5y')},
            'A_PLUS_FULL_GAME_HOME':{'frozenBaseline':stats(popAp,'fgy'),'eligibleBaseline':stats(eligAp,'fgy'),'eligibleF5SameGames':stats(eligAp,'f5y')},
        },
        'continuousTests':tests,'signCohorts':cohorts,'paretoEfficientFgCohorts':frontier,
        'policy':{'sameDateOutcomeLeakageAllowed':False,'historicalPricesUsed':False,'liveFilterChangeAllowed':False,'rankingChangeAllowed':False,'stakeChangeAllowed':False,'betEliteAllowed':False,'prospective11cRequiredBeforePromotion':True,'premiumAOrAPlusPicksMayBeRemoved':False}
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'classification':classification,'coverage':out['coverage'],'populations':out['populations'],'continuousTests':tests,'signCohorts':cohorts,'pareto':frontier},indent=2))

if __name__=='__main__':main()
