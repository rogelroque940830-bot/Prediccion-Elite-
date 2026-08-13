#!/usr/bin/env python3
import argparse,json,math,os,time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
from scipy.stats import fisher_exact

SCHEMA='courtedge-p0-step12v11-f5-independent-platoon-route.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
LINEUP_SCHEMA='courtedge-p0-step12m-cohort-pregame-lineups.v1'
SPLIT_SCHEMA='courtedge-p0-step12v9-game-team-hand-aggregates.v1'
EVAL=('2024','2025','2026_YTD')
COUNT_KEYS=('pa','ab','h','doubles','triples','hr','tb','bb','hbp','so','sf')
API='https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live?timecode={timecode}'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def sigmoid(z):
    return 1.0/(1.0+math.exp(-max(-50.0,min(50.0,float(z)))))

def frozen_prob(features,model):
    z=float(model['intercept'])
    names=model['features'];coef=model['coef'];means=model['mean'];scales=model['scale'];med=model['medianImpute']
    for i,name in enumerate(names):
        x=features.get(name)
        if not finite(x):x=med[i]
        z+=float(coef[i])*((float(x)-float(means[i]))/float(scales[i]))
    return sigmoid(z)

def is_a(features,contract):
    return all(finite(features.get(r['feature'])) and float(features[r['feature']])>=float(r['threshold']) for r in contract['premiumA']['all'])

def norm_order(v):
    if not isinstance(v,list):return []
    out=[]
    for x in v:
        try:i=int(x)
        except:return []
        if i<=0:return []
        out.append(i)
    return out

def fetch_json(game_pk,timecode,attempts=3):
    url=API.format(gamePk=game_pk,timecode=timecode);last=None
    for attempt in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V11/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if attempt+1<attempts:time.sleep(0.4*(2**attempt))
    raise RuntimeError(f'FETCH_FAILED:{type(last).__name__}:{last}')

def player_hand(players,pid):
    p=players.get(f'ID{int(pid)}') if pid else None
    code=str((p or {}).get('pitchHand',{}).get('code','')).strip().upper()
    return code if code in ('R','L') else None

def acquire_hands(item):
    base={k:item[k] for k in ('season','gamePk','officialDate','homeTeamId','awayTeamId','homePitcherId','awayPitcherId','requestedTimecode')}
    try:
        p=fetch_json(item['gamePk'],item['requestedTimecode'])
        if int(p.get('gamePk') or 0)!=item['gamePk']:return {**base,'usable':False,'reason':'GAME_PK_MISMATCH'}
        teams=(p.get('gameData') or {}).get('teams') or {}
        if int(((teams.get('home') or {}).get('id')) or 0)!=item['homeTeamId'] or int(((teams.get('away') or {}).get('id')) or 0)!=item['awayTeamId']:
            return {**base,'usable':False,'reason':'TEAM_ID_MISMATCH'}
        source_tc=str((p.get('metaData') or {}).get('timeStamp') or '').strip()
        if not source_tc or source_tc>item['requestedTimecode']:
            return {**base,'usable':False,'reason':'NON_HISTORICAL_SOURCE_TIMECODE','sourceMetadataTimecode':source_tc or None}
        box=((p.get('liveData') or {}).get('boxscore') or {}).get('teams') or {}
        ho=norm_order(((box.get('home') or {}).get('battingOrder')));ao=norm_order(((box.get('away') or {}).get('battingOrder')))
        if ho!=item['homeBattingOrder'] or ao!=item['awayBattingOrder']:
            return {**base,'usable':False,'reason':'BATTING_ORDER_MISMATCH','sourceMetadataTimecode':source_tc}
        players=(p.get('gameData') or {}).get('players') or {}
        hp=player_hand(players,item['homePitcherId']);ap=player_hand(players,item['awayPitcherId'])
        if hp is None or ap is None:return {**base,'usable':False,'reason':'STARTER_HAND_MISSING','sourceMetadataTimecode':source_tc}
        return {**base,'usable':True,'reason':None,'sourceMetadataTimecode':source_tc,'homeStarterHand':hp,'awayStarterHand':ap}
    except Exception as e:return {**base,'usable':False,'reason':str(e)[:240]}

def blank():return {k:0 for k in COUNT_KEYS}

def merge(a,b):
    for k in COUNT_KEYS:a[k]+=int(b.get(k,0))

def rates(c):
    pa=c['pa'];ab=c['ab'];obpd=ab+c['bb']+c['hbp']+c['sf']
    if pa<=0 or ab<=0 or obpd<=0:return None
    obp=(c['h']+c['bb']+c['hbp'])/obpd;slg=c['tb']/ab
    return {'ops':obp+slg,'slg':slg,'hr_pa':c['hr']/pa}

def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n;mid=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def holm(vals):
    m=len(vals);order=sorted(range(m),key=lambda i:vals[i]);out=[1.0]*m;running=0.0
    for rank,i in enumerate(order):
        running=max(running,min(1.0,(m-rank)*vals[i]));out[i]=running
    return out

def decisive_stats(rows):
    d=[x for x in rows if x['f5y'] is not None];n=len(d);w=sum(int(x['f5y']) for x in d)
    return n,w,n-w

def summarize(rows,original_selected,original_decisive,eligible_hit):
    selected=len(rows);n,w,l=decisive_stats(rows);pushes=selected-n
    by={}
    for s in EVAL:
        z=[x for x in rows if x['season']==s];dn,dw,dl=decisive_stats(z)
        by[s]={'selectedRows':len(z),'decisiveRows':dn,'pushes':len(z)-dn,'wins':dw,'losses':dl,'hitRate':dw/dn if dn else None}
    months=sorted(set(x['officialDate'][:7] for x in rows if x['f5y'] is not None));loo=None
    if n and months:
        vals=[]
        for mon in months:
            z=[x for x in rows if x['f5y'] is not None and x['officialDate'][:7]!=mon];nn=len(z);ww=sum(int(x['f5y']) for x in z)
            vals.append((ww/nn if nn else 0.0,mon,nn,ww))
        hr,mon,nn,ww=min(vals);loo={'removedMonth':mon,'decisiveRows':nn,'wins':ww,'hitRate':hr}
    hit=w/n if n else None;dec_pct=100*n/original_decisive if original_decisive else 0.0;sel_pct=100*selected/original_selected if original_selected else 0.0
    loss_pct=max(0.0,100.0-dec_pct);gain=(hit-eligible_hit)*100 if hit is not None and eligible_hit is not None else None
    gain10=(gain/(loss_pct/10.0)) if gain is not None and loss_pct>0 else None
    seasons=sum(1 for s in EVAL if by[s]['decisiveRows']>0)
    if n>=50 and seasons==3:label='CORE_VOLUME'
    elif n>=35 and seasons==3:label='SELECTIVE_SHADOW_VOLUME'
    else:label='TOO_THIN_FOR_INDEPENDENT_ROUTE'
    return {'selectedRows':selected,'decisiveRows':n,'pushes':pushes,'wins':w,'losses':l,'hitRate':hit,'wilson95':wilson(w,n),'retainedSelectedPctOfOriginal':sel_pct,'retainedDecisivePctOfOriginal':dec_pct,'decisiveVolumeLostPp':loss_pct,'precisionGainVsEligibleBaselinePp':gain,'precisionGainPer10PctDecisiveVolumeLost':gain10,'volumeLabel':label,'bySeason':by,'minimumLeaveOneMonthOut':loo,'activeMonths':len(months)}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--v7-report',required=True);ap.add_argument('--split-dir',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();c=load(a.contract);v7=load(a.v7_report);ac=load(a.a_contract)
    if a.workers<1 or a.workers>8:raise SystemExit('STEP12V11_INVALID_WORKERS')
    if v7.get('schemaVersion')!='courtedge-p0-step12v7-f5-elite-route-anatomy.v1':raise SystemExit('STEP12V11_V7_SCHEMA')
    expected=c['population'];thr=v7['thresholdSelection2023'];models=v7['fitted2022Models']
    targets=[]
    for s in EVAL:
        table=load(f'{a.root}/{s}/game-anatomy-feature-table.json');lineups=load(f'{a.root}/{s}/cohort/pregame-lineup-history.json')
        if table.get('schemaVersion')!=BASE_SCHEMA or lineups.get('schemaVersion')!=LINEUP_SCHEMA:raise SystemExit(f'STEP12V11_PARENT_SCHEMA:{s}')
        lp={int(x['gamePk']):x for x in lineups['snapshots']}
        for r in table['rows']:
            if not r.get('t5PregameValid'):continue
            f=r['features'];p1=frozen_prob(f,models['F5_C4']);p2=frozen_prob(f,models['F5_FULL13'])
            if p1<float(thr['c4']) or p2<float(thr['full13']) or is_a(f,ac):continue
            gp=int(r['gamePk']);ls=lp.get(gp)
            if not ls or not ls.get('complete'):raise SystemExit(f'STEP12V11_LINEUP_MISSING:{gp}')
            o=r['outcomes']['FIRST_5'];f5y=None if o['homeRuns']==o['awayRuns'] else int(o['homeRuns']>o['awayRuns'])
            targets.append({'season':s,'gamePk':gp,'officialDate':r['officialDate'],'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homePitcherId':int(r['t5HomeProbablePitcherId']),'awayPitcherId':int(r['t5AwayProbablePitcherId']),'requestedTimecode':ls['requestedTimecode'],'homeBattingOrder':[int(x) for x in ls['homeBattingOrder']],'awayBattingOrder':[int(x) for x in ls['awayBattingOrder']],'f5y':f5y,'pC4':p1,'pFull13':p2})
    n,w,l=decisive_stats(targets)
    if len(targets)!=int(expected['expectedSelectedRows']) or n!=int(expected['expectedDecisiveRows']) or w!=int(expected['expectedWins']) or l!=int(expected['expectedLosses']) or len(targets)-n!=int(expected['expectedPushes']):
        raise SystemExit(f'STEP12V11_BASELINE_DRIFT:selected={len(targets)} decisive={n} wins={w} losses={l}')

    hands=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs={ex.submit(acquire_hands,x):x['gamePk'] for x in targets}
        for f in as_completed(futs):hands.append(f.result())
    hands.sort(key=lambda x:(x['officialDate'],x['gamePk']));hand_by={x['gamePk']:x for x in hands if x['usable']}
    hand_share=len(hand_by)/len(targets)

    splits={}
    for s in EVAL:
        d=load(os.path.join(a.split_dir,f'hand-splits-{s}.json'))
        if d.get('schemaVersion')!=SPLIT_SCHEMA or d.get('season')!=s or d.get('failures'):raise SystemExit(f'STEP12V11_SPLIT_INVALID:{s}')
        splits[s]=d
    target_by=defaultdict(list)
    for x in targets:
        h=hand_by.get(x['gamePk'])
        if h:target_by[(x['season'],x['officialDate'])].append({**x,'homeStarterHand':h['homeStarterHand'],'awayStarterHand':h['awayStarterHand']})
    primary_min=int(c['rollingPlatoon']['minimumPriorPaPerRequiredHand']);high_min=int(c['rollingPlatoon']['highReliabilityPriorPaPerRequiredHand'])
    features=[];audit=[]
    for s in EVAL:
        acc=defaultdict(lambda:{'R':blank(),'L':blank()});bydate=defaultdict(list)
        for g in splits[s]['games']:bydate[g['officialDate']].append(g)
        for d in sorted(bydate):
            frozen=target_by.get((s,d),[])
            for x in frozen:
                hc=acc[x['homeTeamId']][x['awayStarterHand']];acnt=acc[x['awayTeamId']][x['homeStarterHand']];hr=rates(hc);ar=rates(acnt);minpa=min(hc['pa'],acnt['pa'])
                row=dict(x);row.update({'homePriorPaRequiredHand':hc['pa'],'awayPriorPaRequiredHand':acnt['pa'],'minimumPriorPa':minpa,'primaryEligible':bool(hr and ar and minpa>=primary_min),'highReliability':bool(hr and ar and minpa>=high_min)})
                if hr and ar:
                    row['ops_adv']=hr['ops']-ar['ops'];row['slg_adv']=hr['slg']-ar['slg'];row['hr_pa_adv']=hr['hr_pa']-ar['hr_pa']
                features.append(row)
            before=sum(acc[t][h]['pa'] for t in acc for h in ('R','L'))
            for g in bydate[d]:
                for rec in g['teamHandTotals']:merge(acc[int(rec['teamId'])][rec['vsHand']],rec)
            after=sum(acc[t][h]['pa'] for t in acc for h in ('R','L'))
            audit.append({'season':s,'officialDate':d,'targetRowsFrozenBeforeDateUpdate':len(frozen),'priorPaBeforeDate':before,'priorPaAfterDate':after})

    primary=[x for x in features if x['primaryEligible']];high=[x for x in features if x['highReliability']];pn,pw,pl=decisive_stats(primary);eligible_hit=pw/pn if pn else None
    coverage={'historicalHands':{'usable':len(hand_by),'expected':len(targets),'share':hand_share},'primarySelected':{'eligible':len(primary),'expected':len(targets),'share':len(primary)/len(targets)},'primaryDecisive':{'eligible':pn,'expected':n,'share':pn/n if n else 0.0},'highReliabilitySelected':{'eligible':len(high),'share':len(high)/len(targets)}}
    gate=c['coverageGate'];coverage_ok=hand_share>=float(gate['minimumHistoricalHandRecoveryShare']) and coverage['primarySelected']['share']>=float(gate['minimumPrimarySelectedCoverageShare']) and coverage['primaryDecisive']['share']>=float(gate['minimumPrimaryDecisiveCoverageShare'])
    original={'selectedRows':len(targets),'decisiveRows':n,'pushes':len(targets)-n,'wins':w,'losses':l,'hitRate':w/n}
    eligible={'selectedRows':len(primary),'decisiveRows':pn,'pushes':len(primary)-pn,'wins':pw,'losses':pl,'hitRate':eligible_hit}

    def positive(x,k):return finite(x.get(k)) and float(x[k])>0.0
    cohort_masks={
      'ANY_1_OF_3':lambda x:sum(positive(x,k) for k in ('ops_adv','slg_adv','hr_pa_adv'))>=1,
      'OPS_POS':lambda x:positive(x,'ops_adv'),
      'AT_LEAST_2_OF_3':lambda x:sum(positive(x,k) for k in ('ops_adv','slg_adv','hr_pa_adv'))>=2,
      'SLG_POS':lambda x:positive(x,'slg_adv'),
      'HR_POS':lambda x:positive(x,'hr_pa_adv'),
      'SLG_AND_HR':lambda x:positive(x,'slg_adv') and positive(x,'hr_pa_adv')
    }
    if list(cohort_masks.keys())!=c['predeclaredCohorts']:raise SystemExit('STEP12V11_COHORT_CONTRACT_DRIFT')
    cohorts={};tests=[]
    for name,fn in cohort_masks.items():
        yes=[x for x in primary if fn(x)];no=[x for x in primary if not fn(x)]
        cohorts[name]=summarize(yes,len(targets),n,eligible_hit)
        yd=[x for x in yes if x['f5y'] is not None];nd=[x for x in no if x['f5y'] is not None];yw=sum(int(x['f5y']) for x in yd);nw=sum(int(x['f5y']) for x in nd)
        p=float(fisher_exact([[yw,len(yd)-yw],[nw,len(nd)-nw]],alternative='two-sided').pvalue) if yd and nd else 1.0
        tests.append({'cohort':name,'selectedDecisiveRows':len(yd),'complementDecisiveRows':len(nd),'selectedHitRate':yw/len(yd) if yd else None,'complementHitRate':nw/len(nd) if nd else None,'rawFisherP':p})
    adj=holm([x['rawFisherP'] for x in tests])
    for x,p in zip(tests,adj):x['holmAdjustedP']=p
    pareto=[]
    for name,v in cohorts.items():
        if v['hitRate'] is None:continue
        dominated=False
        for oname,o in cohorts.items():
            if oname==name or o['hitRate'] is None:continue
            if o['decisiveRows']>=v['decisiveRows'] and o['hitRate']>=v['hitRate'] and (o['decisiveRows']>v['decisiveRows'] or o['hitRate']>v['hitRate']):dominated=True;break
        if not dominated:pareto.append(name)
    classification='F5_INDEPENDENT_PLATOON_DISCOVERY_NOT_CONFIRMATION' if coverage_ok else gate['belowGateClassification']
    report={'schemaVersion':SCHEMA,'classification':classification,'originalFrozenBaseline':original,'eligibleBaseline':eligible,'coverage':coverage,'cohorts':cohorts,'paretoEfficientCohorts':pareto,'inferentialTests':tests,'starterHandSnapshots':hands,'features':features,'dailyChronologyAudit':audit,'policy':c['policy']}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'classification':classification,'originalFrozenBaseline':original,'eligibleBaseline':eligible,'coverage':coverage,'pareto':pareto,'cohorts':cohorts,'tests':tests},indent=2))
if __name__=='__main__':main()
