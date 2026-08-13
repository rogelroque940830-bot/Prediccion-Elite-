#!/usr/bin/env python3
import argparse,json,math,os
from collections import defaultdict
from datetime import date,timedelta

SCHEMA='courtedge-p0-step12v15-aplus-fg-f5-router-freeze.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PACK_SCHEMA='courtedge-p0-step12v14-game-bullpen-summary.v1'
EVAL=('2024','2025','2026_YTD')
ALL=('2023','2024','2025','2026_YTD')


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


def stats(pop,target):
    selected=len(pop);dec=[x for x in pop if x[target] is not None];n=len(dec);w=sum(int(x[target]) for x in dec)
    by={}
    for s in EVAL:
        rows=[x for x in pop if x['season']==s];d=[x for x in rows if x[target] is not None];nn=len(d);ww=sum(int(x[target]) for x in d)
        by[s]={'selectedRows':len(rows),'decisiveRows':nn,'pushes':len(rows)-nn,'wins':ww,'losses':nn-ww,'hitRate':ww/nn if nn else None}
    months=sorted(set(x['date'][:7] for x in dec));loo=None
    if n and len(months)>1:
        candidates=[]
        for month in months:
            rows=[x for x in dec if x['date'][:7]!=month];nn=len(rows);ww=sum(int(x[target]) for x in rows)
            if nn:candidates.append((ww/nn,month,ww,nn))
        if candidates:
            rate,month,ww,nn=min(candidates)
            loo={'hitRate':rate,'removedMonth':month,'wins':ww,'decisiveRows':nn}
    return {'selectedRows':selected,'decisiveRows':n,'pushes':selected-n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'bySeason':by,'leaveOneMonthOutMinimum':loo}


def exact_anchor(actual,expected,label):
    for key in ('selectedRows','decisiveRows','wins','losses'):
        if key in expected and actual.get(key)!=expected[key]:raise SystemExit(f'STEP12V15_ANCHOR_DRIFT:{label}:{key}:{actual.get(key)}:{expected[key]}')
    if 'pushes' in expected and actual.get('pushes')!=expected['pushes']:raise SystemExit(f'STEP12V15_ANCHOR_DRIFT:{label}:pushes')
    if 'hitRate' in expected and abs(float(actual.get('hitRate'))-float(expected['hitRate']))>1e-12:raise SystemExit(f'STEP12V15_ANCHOR_DRIFT:{label}:hitRate')


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--bullpen-dir',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--v14-contract',required=True);ap.add_argument('--v14-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    args=ap.parse_args();c=load(args.contract);ac=load(args.a_contract);v14c=load(args.v14_contract);v14r=load(args.v14_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v15-aplus-fg-f5-router-freeze-contract.v1':raise SystemExit('STEP12V15_CONTRACT_INVALID')
    if v14r.get('schemaVersion')!='courtedge-p0-step12v14-bullpen-availability-routing.v1':raise SystemExit('STEP12V15_V14_REPORT_INVALID')
    if c['router']['alternativeRoutersAllowed'] or c['router']['numericThresholdSearchAllowed']:raise SystemExit('STEP12V15_ROUTER_NOT_FROZEN')

    hist=defaultdict(list)
    for s in ALL:
        p=load(os.path.join(args.bullpen_dir,f'bullpen-{s}.json'))
        if p.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'STEP12V15_PACK_SCHEMA:{s}')
        for g in p['games']:
            if not g.get('identityComplete'):continue
            d=date.fromisoformat(g['officialDate'])
            for side in ('home','away'):
                r=g[side];rel={int(x['pitcherId']):int(x['pitches']) for x in r['relievers']}
                hist[int(r['teamId'])].append({'date':d,'gamePk':int(g['gamePk']),'bullpenPitches':int(r['bullpenPitches']),'relievers':rel})
    for rows in hist.values():rows.sort(key=lambda x:(x['date'],x['gamePk']))

    lookback=int(v14c['rollingDefinitions']['coreRelieverLookbackDays']);min_games=int(v14c['reliability']['minimumPriorBullpenGames30dPerTeam']);min_pool=int(v14c['reliability']['minimumCoreRelieverPool'])
    cache={}
    def profile(tid,target):
        key=(tid,target)
        if key in cache:return cache[key]
        rows=[r for r in hist.get(int(tid),[]) if target-timedelta(days=lookback)<=r['date']<target]
        pool=set(pid for r in rows for pid in r['relievers']);d1=target-timedelta(days=1)
        out={'pitches1d':sum(r['bullpenPitches'] for r in rows if r['date']==d1),'eligible':len(rows)>=min_games and len(pool)>=min_pool}
        cache[key]=out;return out

    rows=[]
    for s in EVAL:
        table=load(os.path.join(args.root,s,'game-anatomy-feature-table.json'))
        if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'STEP12V15_BASE_SCHEMA:{s}')
        for r in table['rows']:
            if not r.get('t5PregameValid'):continue
            features=r['features']
            if not is_aplus(features,ac):continue
            target=date.fromisoformat(r['officialDate']);home=profile(int(r['homeTeamId']),target);away=profile(int(r['awayTeamId']),target)
            if not home['eligible'] or not away['eligible']:raise SystemExit(f"STEP12V15_APLUS_BULLPEN_INELIGIBLE:{r['gamePk']}")
            adv=away['pitches1d']-home['pitches1d']
            fg=r['outcomes']['FULL_GAME'];f5=r['outcomes']['FIRST_5'];fgy=int(fg['homeRuns']>fg['awayRuns']);f5y=None if f5['homeRuns']==f5['awayRuns'] else int(f5['homeRuns']>f5['awayRuns'])
            route='F5_HOME' if adv>0 else 'FULL_GAME_HOME';router_y=f5y if route=='F5_HOME' else fgy
            rows.append({'season':s,'date':r['officialDate'],'gamePk':int(r['gamePk']),'bullpen_pitches_1d_adv':adv,'route':route,'fgy':fgy,'f5y':f5y,'routerY':router_y})

    if len(rows)!=int(c['frozenPopulation']['expectedSelectedRows']):raise SystemExit(f'STEP12V15_APLUS_COUNT:{len(rows)}')
    fg=stats(rows,'fgy');f5=stats(rows,'f5y');routed=stats(rows,'routerY');f5_group=[x for x in rows if x['route']=='F5_HOME'];fg_group=[x for x in rows if x['route']=='FULL_GAME_HOME']
    f5_group_fg=stats(f5_group,'fgy');f5_group_f5=stats(f5_group,'f5y');fg_group_fg=stats(fg_group,'fgy')

    exact_anchor(fg,c['frozenPopulation']['fullGameBaseline'],'FG_BASELINE')
    exact_anchor(f5,c['frozenPopulation']['sameGameF5Baseline'],'F5_BASELINE')
    anchor=c['v14Anchor'];exact_anchor(f5_group_fg,{'selectedRows':anchor['selectedRows'],**anchor['fullGame']},'V14_F5_GROUP_FG');exact_anchor(f5_group_f5,anchor['first5'],'V14_F5_GROUP_F5');exact_anchor(fg_group_fg,{'selectedRows':46,**anchor['complementFullGame']},'V14_COMPLEMENT_FG')

    lift_fg=(routed['hitRate']-fg['hitRate'])*100;lift_f5=(routed['hitRate']-f5['hitRate'])*100
    gates=c['prospectiveCandidateDiagnostics'];season_rates=[routed['bySeason'][s]['hitRate'] for s in EVAL]
    checks={
      'selectedRows':routed['selectedRows']>=int(gates['minimumSelectedRows']),
      'decisiveRows':routed['decisiveRows']>=int(gates['minimumDecisiveRows']),
      'liftVsFg':lift_fg>=float(gates['minimumLiftVsFrozenFullGameBaselinePp']),
      'everySeason':all(x is not None and x>=float(gates['minimumEverySeasonHitRate']) for x in season_rates),
      'leaveOneMonthOut':routed['leaveOneMonthOutMinimum'] is not None and routed['leaveOneMonthOutMinimum']['hitRate']>=float(gates['minimumLeaveOneMonthOutHitRate'])
    }
    passes=all(checks.values())
    classification='FROZEN_PROSPECTIVE_ROUTER_CANDIDATE_NOT_CONFIRMATION' if passes else 'FROZEN_ROUTER_DISCOVERY_WEAK_NOT_CONFIRMATION'
    out={
      'schemaVersion':SCHEMA,'classification':classification,'routerId':c['router']['id'],
      'population':{'selectedRows':len(rows),'routeCounts':{'F5_HOME':len(f5_group),'FULL_GAME_HOME':len(fg_group)}},
      'comparators':{'allAPlusFullGame':fg,'allAPlusFirst5':f5},
      'router':{'stats':routed,'liftVsAllAPlusFullGamePp':lift_fg,'liftVsAllAPlusFirst5Pp':lift_f5,'opportunityRetentionPct':len(rows)/int(c['frozenPopulation']['expectedSelectedRows'])*100,'decisiveRetentionVsFullGamePct':routed['decisiveRows']/fg['decisiveRows']*100},
      'components':{'routedToF5':{'fullGame':f5_group_fg,'first5':f5_group_f5},'routedToFullGame':{'fullGame':fg_group_fg}},
      'prospectiveCandidateGates':{'checks':checks,'allPassed':passes},
      'policy':{'singleFrozenRouterOnly':True,'numericThresholdSearchAllowed':False,'alternativeRoutersAllowed':False,'newMlbAcquisitionUsed':False,'sameDateOutcomeLeakageAllowed':False,'historicalPricesUsed':False,'liveFilterChangeAllowed':False,'rankingChangeAllowed':False,'stakeChangeAllowed':False,'betEliteAllowed':False,'aPlusOpportunityMayBeRemoved':False,'prospective11cRequiredBeforePromotion':True}
    }
    os.makedirs(os.path.dirname(args.out) or '.',exist_ok=True)
    with open(args.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps(out,indent=2))

if __name__=='__main__':main()
