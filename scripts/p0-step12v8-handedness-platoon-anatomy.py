#!/usr/bin/env python3
import argparse,hashlib,json,math,os,time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
import numpy as np
from scipy.stats import fisher_exact

SCHEMA='courtedge-p0-step12v8-handedness-platoon-anatomy.v1'
SEASONS=('2024','2025','2026_YTD')
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
LINEUP_SCHEMA='courtedge-p0-step12m-cohort-pregame-lineups.v1'
API='https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live?timecode={timecode}'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def sha(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def sigmoid(z):return 1/(1+math.exp(-max(-50,min(50,z))))

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

def fetch_json(game_pk,timecode,attempts=3):
    url=API.format(gamePk=game_pk,timecode=timecode)
    last=None
    for attempt in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V8/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:
                return json.loads(r.read().decode('utf-8')),url
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if attempt+1<attempts:time.sleep(0.4*(2**attempt))
    raise RuntimeError(f'FETCH_FAILED:{type(last).__name__}:{last}')

def norm_order(v):
    if not isinstance(v,list):return []
    out=[]
    for x in v:
        try:i=int(x)
        except:return []
        if i<=0:return []
        out.append(i)
    return out

def hand_for(players,pid,key,allowed):
    p=players.get(f'ID{int(pid)}') if pid else None
    code=str((p or {}).get(key,{}).get('code','')).strip().upper()
    return code if code in allowed else None

def classify_batter(bat,pitch):
    if bat=='S':return 'switch'
    if (bat=='L' and pitch=='R') or (bat=='R' and pitch=='L'):return 'natural'
    if bat==pitch:return 'same'
    return None

def acquire(item):
    base={k:item[k] for k in ('season','gamePk','officialDate','homeTeamId','awayTeamId','homePitcherId','awayPitcherId','aPlus','homeWin','requestedTimecode')}
    try:
        payload,url=fetch_json(item['gamePk'],item['requestedTimecode'])
        base['urlDigest']=hashlib.sha256(url.encode()).hexdigest()
        if int(payload.get('gamePk') or 0)!=item['gamePk']:return {**base,'usable':False,'reason':'GAME_PK_MISMATCH'}
        gd=payload.get('gameData') or {};teams=gd.get('teams') or {}
        if int(((teams.get('home') or {}).get('id')) or 0)!=item['homeTeamId'] or int(((teams.get('away') or {}).get('id')) or 0)!=item['awayTeamId']:
            return {**base,'usable':False,'reason':'TEAM_ID_MISMATCH'}
        source_tc=str((payload.get('metaData') or {}).get('timeStamp') or '').strip()
        if not source_tc or source_tc>item['requestedTimecode']:return {**base,'usable':False,'reason':'NON_HISTORICAL_SOURCE_TIMECODE','sourceMetadataTimecode':source_tc or None}
        box=((payload.get('liveData') or {}).get('boxscore') or {}).get('teams') or {}
        ho=norm_order(((box.get('home') or {}).get('battingOrder')));ao=norm_order(((box.get('away') or {}).get('battingOrder')))
        if ho!=item['homeBattingOrder'] or ao!=item['awayBattingOrder']:
            return {**base,'usable':False,'reason':'BATTING_ORDER_MISMATCH','sourceMetadataTimecode':source_tc}
        players=gd.get('players') or {}
        hp=hand_for(players,item['homePitcherId'],'pitchHand',{'R','L'});ap=hand_for(players,item['awayPitcherId'],'pitchHand',{'R','L'})
        if hp is None or ap is None:return {**base,'usable':False,'reason':'STARTER_HAND_MISSING','sourceMetadataTimecode':source_tc}
        hb=[hand_for(players,p,'batSide',{'R','L','S'}) for p in ho];ab=[hand_for(players,p,'batSide',{'R','L','S'}) for p in ao]
        if any(x is None for x in hb+ab):return {**base,'usable':False,'reason':'BATTER_SIDE_MISSING','sourceMetadataTimecode':source_tc}
        hc=Counter(classify_batter(b,ap) for b in hb);ac=Counter(classify_batter(b,hp) for b in ab)
        hn,an=hc['natural'],ac['natural'];hs,ass=hc['switch'],ac['switch'];hh,ah=hc['same'],ac['same']
        hf,af=hn+hs,an+ass
        snap={**base,'usable':True,'reason':None,'sourceMetadataTimecode':source_tc,'sourceDigest':sha(payload),'homeStarterHand':hp,'awayStarterHand':ap,'starter_hand_pair':hp+ap,'homeBatterSides':hb,'awayBatterSides':ab,'home_natural_opp_count':hn,'away_natural_opp_count':an,'natural_opp_diff':hn-an,'home_switch_count':hs,'away_switch_count':ass,'switch_diff':hs-ass,'home_same_hand_count':hh,'away_same_hand_count':ah,'same_hand_diff':hh-ah,'home_flexible_count':hf,'away_flexible_count':af,'flexible_diff':hf-af}
        return snap
    except Exception as e:return {**base,'usable':False,'reason':str(e)[:240]}

def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n;mid=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def holm(vals):
    m=len(vals);order=sorted(range(m),key=lambda i:vals[i]);out=[1.0]*m;run=0.0
    for rank,i in enumerate(order):
        run=max(run,min(1.0,(m-rank)*vals[i]));out[i]=run
    return out

def cond(row,spec):
    v=row.get(spec['feature']);t=float(spec['threshold'])
    return v is not None and ((v>=t) if spec['operator']=='GTE' else (v<=t))

def stats(rows):
    n=len(rows);w=sum(int(x['homeWin']) for x in rows)
    by={}
    for s in SEASONS:
        z=[x for x in rows if x['season']==s];ns=len(z);ws=sum(int(x['homeWin']) for x in z)
        by[s]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
    teams=Counter(x['homeTeamId'] for x in rows);pitch=Counter(x['homePitcherId'] for x in rows)
    loo=None
    if n:
        vals=[]
        months=sorted(set(x['officialDate'][:7] for x in rows))
        for mon in months:
            z=[x for x in rows if x['officialDate'][:7]!=mon];nn=len(z);ww=sum(int(x['homeWin']) for x in z)
            vals.append((ww/nn if nn else 0,mon,nn,ww))
        h,m,nn,ww=min(vals);loo={'removedMonth':m,'rows':nn,'wins':ww,'hitRate':h}
    return {'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'bySeason':by,'minimumLeaveOneMonth':loo,'concentration':{'uniqueHomeTeams':len(teams),'maxHomeTeamShare':max(teams.values())/n if n and teams else None,'uniqueHomePitchers':len(pitch),'maxHomePitcherShare':max(pitch.values())/n if n and pitch else None}}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();c=load(a.contract);ac=load(a.a_contract)
    if a.workers<1 or a.workers>8:raise SystemExit('STEP12V8_INVALID_WORKERS')
    selected=[]
    for s in SEASONS:
        table=load(f'{a.root}/{s}/game-anatomy-feature-table.json');lineups=load(f'{a.root}/{s}/cohort/pregame-lineup-history.json')
        if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V8_BASE_SCHEMA_INVALID')
        if lineups.get('schemaVersion')!=LINEUP_SCHEMA:raise SystemExit('STEP12V8_LINEUP_SCHEMA_INVALID')
        bypk={int(x['gamePk']):x for x in lineups['snapshots']}
        for r in table['rows']:
            if not r.get('t5PregameValid') or not is_a(r['features'],ac):continue
            gp=int(r['gamePk']);ls=bypk.get(gp)
            if not ls:raise SystemExit(f'STEP12V8_CANONICAL_LINEUP_MISSING:{gp}')
            o=r['outcomes']['FULL_GAME'];home_win=int(o['homeRuns']>o['awayRuns'])
            selected.append({'season':s,'gamePk':gp,'officialDate':r['officialDate'],'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homePitcherId':int(r['t5HomeProbablePitcherId']) if r.get('t5HomeProbablePitcherId') else None,'awayPitcherId':int(r['t5AwayProbablePitcherId']) if r.get('t5AwayProbablePitcherId') else None,'aPlus':is_aplus(r['features'],ac),'homeWin':home_win,'requestedTimecode':ls['requestedTimecode'],'homeBattingOrder':[int(x) for x in ls['homeBattingOrder']],'awayBattingOrder':[int(x) for x in ls['awayBattingOrder']],'canonicalComplete':bool(ls['complete'])})
    if len(selected)!=int(c['population']['expectedPremiumARows']):raise SystemExit(f"STEP12V8_A_COUNT:{len(selected)}")
    if sum(x['aPlus'] for x in selected)!=int(c['population']['expectedAPlusRows']):raise SystemExit('STEP12V8_APLUS_COUNT')

    snapshots=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs={ex.submit(acquire,x):x['gamePk'] for x in selected}
        for f in as_completed(futs):snapshots.append(f.result())
    snapshots.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    usable=[x for x in snapshots if x['usable']];aplus=[x for x in usable if x['aPlus']];anon=[x for x in usable if not x['aPlus']]
    coverage={'premiumA':{'expected':len(selected),'usable':len(usable),'share':len(usable)/len(selected)},'aPlus':{'expected':sum(x['aPlus'] for x in selected),'usable':len(aplus),'share':len(aplus)/sum(x['aPlus'] for x in selected)},'unusableReasons':dict(Counter(x['reason'] for x in snapshots if not x['usable']))}
    coverage_ok=coverage['premiumA']['share']>=float(c['coverageGate']['minimumPremiumAUsableShare']) and coverage['aPlus']['share']>=float(c['coverageGate']['minimumAPlusUsableShare'])

    populations={'A_PLUS':aplus,'A_NONPLUS':anon,'PREMIUM_A_USABLE':usable}
    baselines={k:stats(v) for k,v in populations.items()}
    bins={}
    tests=[]
    test_names=set(c['inferentialTests']['primaryBins']+c['inferentialTests']['secondaryBins'])
    for pop_name,pop in populations.items():
        bins[pop_name]={}
        if pop_name=='PREMIUM_A_USABLE':continue
        for name,spec in c['predeclaredBins'].items():
            yes=[x for x in pop if cond(x,spec)];no=[x for x in pop if not cond(x,spec)]
            ys,ns=stats(yes),stats(no);entry={'condition':spec,'inside':ys,'outside':ns,'descriptiveLiftPp':(ys['hitRate']-ns['hitRate'])*100 if ys['hitRate'] is not None and ns['hitRate'] is not None else None}
            bins[pop_name][name]=entry
            should=(pop_name=='A_PLUS' and name in c['inferentialTests']['primaryBins']) or (pop_name=='A_NONPLUS' and name in c['inferentialTests']['secondaryBins'])
            if should:
                a1=ys['wins'];b1=ys['losses'];a2=ns['wins'];b2=ns['losses'];p=float(fisher_exact([[a1,b1],[a2,b2]],alternative='two-sided').pvalue) if (ys['rows'] and ns['rows']) else 1.0
                tests.append({'population':pop_name,'bin':name,'insideRows':ys['rows'],'outsideRows':ns['rows'],'insideHitRate':ys['hitRate'],'outsideHitRate':ns['hitRate'],'descriptiveLiftPp':entry['descriptiveLiftPp'],'rawFisherP':p})
    adj=holm([x['rawFisherP'] for x in tests])
    for x,p in zip(tests,adj):x['holmAdjustedP']=p

    feat_names=['natural_opp_diff','switch_diff','same_hand_diff','flexible_diff','home_natural_opp_count','home_flexible_count']
    feature_anatomy={}
    for pop_name,pop in populations.items():
        if pop_name=='PREMIUM_A_USABLE':continue
        w=[x for x in pop if x['homeWin']];l=[x for x in pop if not x['homeWin']]
        feature_anatomy[pop_name]={f:{'winnerMean':float(np.mean([x[f] for x in w])) if w else None,'loserMean':float(np.mean([x[f] for x in l])) if l else None,'winnerMedian':float(np.median([x[f] for x in w])) if w else None,'loserMedian':float(np.median([x[f] for x in l])) if l else None} for f in feat_names}
    pair_stats={}
    for pop_name,pop in populations.items():
        if pop_name=='PREMIUM_A_USABLE':continue
        pair_stats[pop_name]={pair:stats([x for x in pop if x['starter_hand_pair']==pair]) for pair in ('RR','RL','LR','LL')}

    classification='ORTHOGONAL_HANDEDNESS_DISCOVERY_NOT_CONFIRMATION' if coverage_ok else c['coverageGate']['belowGateClassification']
    report={'schemaVersion':SCHEMA,'classification':classification,'coverage':coverage,'baselines':baselines,'bins':bins,'inferentialTests':tests,'winnerLoserFeatureAnatomy':feature_anatomy,'starterHandPairStats':pair_stats,'snapshotDigest':sha([{k:v for k,v in x.items() if k!='urlDigest'} for x in snapshots]),'snapshots':snapshots,'policy':c['policy']}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'classification':classification,'coverage':coverage,'baselines':baselines,'inferentialTests':tests,'winnerLoserFeatureAnatomy':feature_anatomy,'starterHandPairStats':pair_stats},indent=2))
if __name__=='__main__':main()
