#!/usr/bin/env python3
import argparse, collections, datetime as dt, gzip, hashlib, json, math, os, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

STATE_SCHEMA='courtedge-p0-step12v68-prospective-state.v1'
SOURCE_SCHEMA='courtedge-p0-step12v68-prospective-source-input.v1'
QUALITY_KEYS=('velocity','spin','whiff','strike','hard')
QUALITY_NAMES=('starter_velocity_adv','starter_spin_adv','starter_swing_miss_adv','starter_in_zone_adv','starter_weak_contact_adv')
CONTROL4=('lineup_exposure_rate_adv','starter_kbb_adv','combined_team_rs10','team_rd10_diff')
REQUEST_TIMEOUT=20
MAX_ATTEMPTS=3

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,x):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(x,f,indent=2,sort_keys=True);f.write('\n')
def canonical_digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False
def valid_date(s):
    try:return dt.date.fromisoformat(str(s)).isoformat()==str(s)
    except:return False

def fetch_json(url,label):
    last=None
    for i in range(MAX_ATTEMPTS):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-V68-Prospective/1.0','Accept':'application/json'})
            with urlopen(req,timeout=REQUEST_TIMEOUT) as r:return json.loads(r.read().decode('utf-8'))
        except (HTTPError,URLError,TimeoutError,OSError,ValueError) as e:
            last=e
            if isinstance(e,HTTPError) and e.code<500 and e.code not in (408,425,429):break
            if i+1<MAX_ATTEMPTS:time.sleep(.3*(2**i))
    raise RuntimeError(f'{label}:{type(last).__name__}:{last}')

def parse_iso(value):
    s=str(value or '').strip()
    if s.endswith('Z'):s=s[:-1]+'+00:00'
    x=dt.datetime.fromisoformat(s)
    if x.tzinfo is None:raise ValueError('timezone required')
    return x.astimezone(dt.timezone.utc)

def complete_order(raw):
    if not isinstance(raw,list):return None
    try:o=[int(x) for x in raw]
    except:return None
    if len(o)!=9 or len(set(o))!=9 or min(o)<=0:return None
    return o

def read_base(base_root):
    cohort=os.path.join(base_root,'cohort')
    return {
      'official':load(os.path.join(cohort,'official-acquisition.json')),
      'starter':load(os.path.join(cohort,'starting-pitcher-history.json')),
      'lineup':load(os.path.join(cohort,'pregame-lineup-history.json')),
      'audit':load(os.path.join(base_root,'t5-audit','t5-starter-identity-audit.json')),
      'table':load(os.path.join(base_root,'game-anatomy-feature-table.json')),
    }
def read_gap(root):
    if not root:return None
    return {
      'official':load(os.path.join(root,'official-acquisition.json')),
      'starter':load(os.path.join(root,'starting-pitcher-history.json')),
      'lineup':load(os.path.join(root,'pregame-lineup-history.json')),
      'audit':load(os.path.join(root,'t5-starter-identity-audit.json')),
    }
def merge_unique(items,key,label):
    out={}
    for x in items:
        k=key(x)
        if k in out:
            if canonical_digest(out[k])!=canonical_digest(x):raise SystemExit(f'V68_STATE_{label}_CONFLICT:{k}')
        else:out[k]=x
    return list(out.values())

def parse_starter(raw):
    return {'pitcherId':int(raw['pitcherId']),'bf':float(raw.get('battersFaced',0)),'outs':float(raw.get('outsRecorded',0)),
      'pitches':float(raw.get('numberOfPitches',0)),'k':float(raw.get('strikeOuts',0)),'bb':float(raw.get('baseOnBalls',0)),'er':float(raw.get('earnedRuns',0))}
def blank_v39_pitcher():return {'starts':0,'bf':0.,'outs':0.,'pitches':0.,'k':0.,'bb':0.,'er':0.,'recent':[]}
def add_v39(s,l):
    s['starts']+=1
    for k in ('bf','outs','pitches','k','bb','er'):s[k]+=float(l[k])
    s['recent'].append({'outs':float(l['outs']),'pitches':float(l['pitches'])})
    if len(s['recent'])>5:s['recent']=s['recent'][-5:]
def blank_pitch():return {'pitches':0.,'strikes':0.,'swings':0.,'whiffs':0.,'velocityN':0.,'velocitySum':0.,'spinN':0.,'spinSum':0.,'battedBallN':0.,'hardHitN':0.}
def add_pitch(dst,src):
    for k in dst:dst[k]+=float(src.get(k,0))

def canonical_gap_pks(gap):
    if not gap:return set()
    return {int(r['gamePk']) for r in gap['audit'].get('rows',[]) if r.get('identityOk') and r.get('sourceHistorical') and r.get('pregame') and r.get('lineupComplete')}

def build_state(base,gap,pitch2025,pitch2026,gap_pitch,target_date,source_manifest,v62_contract):
    target=dt.date.fromisoformat(target_date)
    official=list(base['official'].get('games',[])) + (list(gap['official'].get('games',[])) if gap else [])
    starters=list(base['starter'].get('games',[])) + (list(gap['starter'].get('games',[])) if gap else [])
    lineups=list(base['lineup'].get('snapshots',[])) + (list(gap['lineup'].get('snapshots',[])) if gap else [])
    official=merge_unique([x for x in official if str(x['officialDate'])<target_date],lambda x:int(x['gamePk']),'OFFICIAL')
    starters=merge_unique([x for x in starters if str(x['officialDate'])<target_date],lambda x:int(x['gamePk']),'STARTER')
    lineups=merge_unique([x for x in lineups if str(x['officialDate'])<target_date],lambda x:int(x['gamePk']),'LINEUP')
    official.sort(key=lambda x:(str(x['officialDate']),int(x['gamePk'])))
    smap={int(x['gamePk']):x for x in starters};lmap={int(x['gamePk']):x for x in lineups}

    # Frozen C4 historical semantics: all prior official finals; prior complete T-5 lineup snapshots.
    teams=collections.defaultdict(lambda:{'games':0,'recent':[],'lineupAppearances':collections.Counter()})
    c4pitch=collections.defaultdict(lambda:{'bf':0.,'k':0.,'bb':0.});league_c4={'bf':0.,'k':0.,'bb':0.}
    for g in official:
        gp=int(g['gamePk']);h=int(g['homeTeamId']);a=int(g['awayTeamId']);hr=float(g['homeFinalRuns']);ar=float(g['awayFinalRuns'])
        for tid,rf,ra in ((h,hr,ar),(a,ar,hr)):
            z=teams[tid];z['games']+=1;z['recent'].append([rf,ra]);z['recent']=z['recent'][-10:]
        sg=smap.get(gp)
        if sg:
            for side in ('homeStarter','awayStarter'):
                q=parse_starter(sg[side]);z=c4pitch[q['pitcherId']];z['bf']+=q['bf'];z['k']+=q['k'];z['bb']+=q['bb'];league_c4['bf']+=q['bf'];league_c4['k']+=q['k'];league_c4['bb']+=q['bb']
        lu=lmap.get(gp)
        if lu and lu.get('complete'):
            ho=complete_order(lu.get('homeBattingOrder'));ao=complete_order(lu.get('awayBattingOrder'))
            if ho:
                for pid in ho:teams[h]['lineupAppearances'][pid]+=1
            if ao:
                for pid in ao:teams[a]['lineupAppearances'][pid]+=1

    # Frozen V39 state is season-reset and uses only canonical T-5 target-universe games.
    base_valid={int(r['gamePk']) for r in base['table'].get('rows',[]) if r.get('t5PregameValid') is True and str(r['officialDate'])<target_date}
    canon=base_valid|canonical_gap_pks(gap)
    v39p=collections.defaultdict(blank_v39_pitcher);league39=blank_v39_pitcher();opp=collections.defaultdict(lambda:{'games':0,'outs':0.});prev={}
    for g in official:
        gp=int(g['gamePk'])
        if gp not in canon:continue
        sg=smap.get(gp)
        if not sg:raise SystemExit(f'V68_STATE_V39_STARTER_MISSING:{gp}')
        h=int(g['homeTeamId']);a=int(g['awayTeamId']);hl=parse_starter(sg['homeStarter']);al=parse_starter(sg['awayStarter'])
        if hl['bf']>0:add_v39(v39p[hl['pitcherId']],hl);add_v39(league39,hl);opp[a]['games']+=1;opp[a]['outs']+=hl['outs']
        if al['bf']>0:add_v39(v39p[al['pitcherId']],al);add_v39(league39,al);opp[h]['games']+=1;opp[h]['outs']+=al['outs']
        lu=lmap.get(gp)
        if lu and lu.get('complete'):
            ho=complete_order(lu.get('homeBattingOrder'));ao=complete_order(lu.get('awayBattingOrder'))
            if ho:prev[h]=ho
            if ao:prev[a]=ao

    # Frozen V62 quality state: exactly the prior 365 days of frozen pitch packs plus chronology-safe gap PBP.
    cutoff=target-dt.timedelta(days=int(v62_contract['dataBoundary']['rollingLookbackDays']))
    qp=collections.defaultdict(dict);ql={};seen=set();pitch_games=0
    for pack in [pitch2025,pitch2026]+([gap_pitch] if gap_pitch else []):
        if not pack:continue
        for g in pack.get('games',[]):
            gd=dt.date.fromisoformat(str(g['officialDate']));gp=int(g['gamePk'])
            if gd<cutoff or gd>=target or gp in seen:continue
            seen.add(gp);pitch_games+=1
            for r in g.get('pitcherPitchTypeTotals',[]):
                pid=int(r['pitcherId']);pt=str(r['pitchType'])
                if pt not in qp[pid]:qp[pid][pt]=blank_pitch()
                if pt not in ql:ql[pt]=blank_pitch()
                add_pitch(qp[pid][pt],r);add_pitch(ql[pt],r)

    jteams={str(k):{'games':v['games'],'recent':v['recent'],'lineupAppearances':{str(pid):n for pid,n in v['lineupAppearances'].items()}} for k,v in teams.items()}
    state={'schemaVersion':STATE_SCHEMA,'targetOfficialDate':target_date,'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
      'chronology':{'historyStrictlyBeforeTargetDate':True,'wholeOfficialDatePriorStateOnly':True,'sameDateOutcomesUsed':False,'latestHistoricalOfficialDate':max([str(x['officialDate']) for x in official],default=None)},
      'c4':{'teams':jteams,'pitchers':{str(k):v for k,v in c4pitch.items()},'leagueStarter':league_c4},
      'v39':{'pitchers':{str(k):v for k,v in v39p.items()},'league':league39,'opponents':{str(k):v for k,v in opp.items()},'previousCompleteLineup':{str(k):v for k,v in prev.items()}},
      'v62':{'pitchers':{str(pid):m for pid,m in qp.items()},'leagueByPitchType':ql,'lookbackDays':int(v62_contract['dataBoundary']['rollingLookbackDays']),'pitchGamesInWindow':pitch_games},
      'custody':{'historicalOfficialGames':len(official),'historicalStarterGames':len(starters),'historicalLineupSnapshots':len(lineups),'v39CanonicalGames':len(canon),'pitchQualityGamesInWindow':pitch_games,'baseFrozenRangeEnd':source_manifest['canonicalHistoricalBase']['frozenRangeEnd'],'gapFirstDate':source_manifest['gapCanonicalization']['firstGapDate']},
      'policy':{'researchOnly':True,'containsTargetOutcomes':False,'containsMarketPrices':False,'productionChanged':False,'betEliteAllowed':False,'realFinancialExposure':0}}
    state['stateDigest']=canonical_digest({k:v for k,v in state.items() if k!='stateDigest'})
    return state

def team_form(z):
    if not z or int(z.get('games',0))<5:return None
    r=z.get('recent',[])[-10:]
    return {'rs':sum(float(x[0]) for x in r)/len(r),'rd':sum(float(x[0])-float(x[1]) for x in r)/len(r)} if r else None
def lineup_exposure(z,order):
    if not z or int(z.get('games',0))<=0 or order is None:return None
    app=z.get('lineupAppearances',{});den=float(z['games']);return sum(float(app.get(str(pid),0))/den for pid in order)/9.0
def c4_features(state,home,away,hpid,apid,horder,aorder):
    teams=state['c4']['teams'];hz=teams.get(str(home));az=teams.get(str(away));hf=team_form(hz);af=team_form(az)
    combined=hf['rs']+af['rs'] if hf and af else None;rd=hf['rd']-af['rd'] if hf and af else None
    lg=state['c4']['leagueStarter'];lr=(float(lg['k'])-float(lg['bb']))/float(lg['bf']) if float(lg.get('bf',0))>0 else None
    adv=None
    if lr is not None:
        def shr(pid):
            z=state['c4']['pitchers'].get(str(pid),{'bf':0.,'k':0.,'bb':0.});bf=float(z.get('bf',0));return ((float(z.get('k',0))-float(z.get('bb',0)))+72.0*lr)/(bf+72.0)
        adv=shr(hpid)-shr(apid)
    he=lineup_exposure(hz,horder);ae=lineup_exposure(az,aorder);lex=he-ae if he is not None and ae is not None else None
    return {'lineup_exposure_rate_adv':lex,'starter_kbb_adv':adv,'combined_team_rs10':combined,'team_rd10_diff':rd},hf,af

def v39_priors(z):
    if not z or float(z.get('starts',0))<=0 or float(z.get('bf',0))<=0:return None
    return {'outsPerStart':z['outs']/z['starts'],'bfPerStart':z['bf']/z['starts'],'pitchesPerStart':z['pitches']/z['starts'],'kbf':z['k']/z['bf'],'bbbf':z['bb']/z['bf'],'erbf':z['er']/z['bf']}
def shr_mean(total,n,anchor,w):return (float(total)+float(w)*float(anchor))/(float(n)+float(w))
def shr_rate(num,den,anchor,w):return (float(num)+float(w)*float(anchor))/(float(den)+float(w))
def v39_vector(state,pid,opp_id,opp_rs,opp_order,manifest):
    lg=state['v39']['league'];pr=v39_priors(lg);p=state['v39']['pitchers'].get(str(pid),blank_v39_pitcher());recent=p.get('recent',[])
    if pr is None:vals=[None]*12
    else:
        vals=[shr_mean(p['outs'],p['starts'],pr['outsPerStart'],5),shr_mean(p['bf'],p['starts'],pr['bfPerStart'],5),shr_mean(p['pitches'],p['starts'],pr['pitchesPerStart'],5),shr_rate(p['k'],p['bf'],pr['kbf'],72),shr_rate(p['bb'],p['bf'],pr['bbbf'],72),shr_rate(p['er'],p['bf'],pr['erbf'],72),sum(float(x['outs']) for x in recent)/len(recent) if recent else None,sum(float(x['pitches']) for x in recent)/len(recent) if recent else None]
        oz=state['v39']['opponents'].get(str(opp_id),{'games':0,'outs':0.});oppouts=shr_mean(oz['outs'],oz['games'],pr['outsPerStart'],5)
        prev=state['v39']['previousCompleteLineup'].get(str(opp_id));cont=len(set(opp_order)&set(prev))/9.0 if opp_order and prev else None
        vals += [oppouts,opp_rs,cont,float(p.get('starts',0))]
    m=manifest['expectedStarterOuts'];z=float(m['intercept'])
    for i,x in enumerate(vals):
        value=float(x) if finite(x) else float(m['medianImpute'][i]);z+=float(m['coefficients'][i])*((value-float(m['mean'][i]))/float(m['scale'][i]))
    return math.exp(z)

def v62_quality(state,pid,c):
    sp=state['v62']['pitchers'].get(str(pid),{});lp=state['v62']['leagueByPitchType'];total=sum(float(r.get('pitches',0)) for r in sp.values());w=c['starterQualityEngineering']
    if pid<=0 or total<float(w['hardEligibilityMinimumPriorRecognizedPitches']):return None
    out={'velocity':0.,'spin':0.,'whiff':0.,'strike':0.,'hard':0.}
    for pt,r in sp.items():
        if float(r.get('pitches',0))<=0:continue
        u=float(r['pitches'])/total;lg=lp.get(pt)
        if not lg or float(lg.get('pitches',0))<=0:continue
        mean=lambda s,n:float(lg[s])/float(lg[n]) if float(lg.get(n,0))>0 else None
        rate=lambda n,d:float(lg[n])/float(lg[d]) if float(lg.get(d,0))>0 else None
        lv=mean('velocitySum','velocityN');ls=mean('spinSum','spinN');lw=rate('whiffs','swings');lstr=rate('strikes','pitches');lh=rate('hardHitN','battedBallN')
        if lv is not None:out['velocity']+=u*(shr_mean(r.get('velocitySum',0),r.get('velocityN',0),lv,w['velocityShrinkagePriorPitches'])-lv)
        if ls is not None:out['spin']+=u*(shr_mean(r.get('spinSum',0),r.get('spinN',0),ls,w['spinShrinkagePriorPitches'])-ls)
        if lw is not None:out['whiff']+=u*(shr_rate(r.get('whiffs',0),r.get('swings',0),lw,w['whiffShrinkagePriorSwings'])-lw)
        if lstr is not None:out['strike']+=u*(shr_rate(r.get('strikes',0),r.get('pitches',0),lstr,w['strikeShrinkagePriorPitches'])-lstr)
        if lh is not None:out['hard']+=u*(lh-shr_rate(r.get('hardHitN',0),r.get('battedBallN',0),lh,w['hardHitShrinkagePriorBallsInPlay']))
    return out

def feature_row(state,identity,manifest,v62c):
    home=int(identity['homeTeamId']);away=int(identity['awayTeamId']);hp=int(identity['homePitcherId']);ap=int(identity['awayPitcherId']);ho=identity['homeBattingOrder'];ao=identity['awayBattingOrder']
    c4,hf,af=c4_features(state,home,away,hp,ap,ho,ao)
    hmu=v39_vector(state,hp,away,af['rs'] if af else None,ao,manifest);amu=v39_vector(state,ap,home,hf['rs'] if hf else None,ho,manifest)
    hq=v62_quality(state,hp,v62c);aq=v62_quality(state,ap,v62c);qadv={}
    for name,key in zip(QUALITY_NAMES,QUALITY_KEYS):qadv[name]=None if hq is None or aq is None else float(hq[key])-float(aq[key])
    hs=max(0.,min(1.,hmu/27.0));aws=max(0.,min(1.,amu/27.0));mean=(hs+aws)/2.0
    feats=dict(c4);feats.update(qadv);feats['fg_exposure_adv']=hs-aws
    for name in QUALITY_NAMES:feats[f'{name}_x_fg_mean_starter_share']=None if qadv[name] is None else qadv[name]*mean
    return feats,{'homeExpectedStarterOuts':hmu,'awayExpectedStarterOuts':amu,'homeFgStarterShare':hs,'awayFgStarterShare':aws,'meanFgStarterShare':mean}

def pregame(feed):
    st=(feed.get('gameData') or {}).get('status') or {};coded=str(st.get('codedGameState') or '').upper();abstract=str(st.get('abstractGameState') or '').lower();detailed=str(st.get('detailedState') or '').lower()
    return coded not in ('I','F','O') and abstract not in ('live','final') and not any(x in detailed for x in ('in progress','final','game over','completed early'))
def target_identity(feed,game,target_date,now,max_lead):
    gd=feed.get('gameData') or {};gp=int(feed.get('gamePk') or game.get('gamePk') or 0);od=str((gd.get('datetime') or {}).get('officialDate') or game.get('officialDate') or '')
    if gp<=0 or od!=target_date or not pregame(feed):return None
    start_s=str((gd.get('datetime') or {}).get('dateTime') or game.get('gameDate') or '')
    try:start=parse_iso(start_s)
    except:return None
    lead=(start-now).total_seconds()/60.0
    if lead<=0 or lead>max_lead:return None
    teams=gd.get('teams') or {};home=int(((teams.get('home') or {}).get('id')) or 0);away=int(((teams.get('away') or {}).get('id')) or 0);probs=gd.get('probablePitchers') or {};hp=int(((probs.get('home') or {}).get('id')) or 0);ap=int(((probs.get('away') or {}).get('id')) or 0)
    box=((feed.get('liveData') or {}).get('boxscore') or {}).get('teams') or {};ho=complete_order(((box.get('home') or {}).get('battingOrder')));ao=complete_order(((box.get('away') or {}).get('battingOrder')))
    if min(home,away,hp,ap)<=0 or not ho or not ao:return None
    return {'gamePk':gp,'officialDate':od,'homeTeamId':home,'awayTeamId':away,'homePitcherId':hp,'awayPitcherId':ap,'homeBattingOrder':ho,'awayBattingOrder':ao,'startTime':start_s,'leadMinutes':lead}

def live_source(state,manifest,v62c,target_date,now,max_lead):
    if state.get('schemaVersion')!=STATE_SCHEMA or state.get('targetOfficialDate')!=target_date:raise SystemExit('V68_SOURCE_STATE_DATE_OR_SCHEMA_INVALID')
    sched=fetch_json(f'https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&date={target_date}','schedule');games=[]
    for d in sched.get('dates',[]):games.extend(d.get('games',[]))
    rows=[];diag={'scheduleGames':len(games),'exactReadyGamesInCaptureWindow':0};captured=now.isoformat().replace('+00:00','Z')
    for g in games:
        gp=int(g.get('gamePk') or 0)
        if gp<=0:continue
        ident=target_identity(fetch_json(f'https://statsapi.mlb.com/api/v1.1/game/{gp}/feed/live',f'feed:{gp}'),g,target_date,now,max_lead)
        if ident is None:continue
        diag['exactReadyGamesInCaptureWindow']+=1;feats,mechanism=feature_row(state,ident,manifest,v62c)
        evidence={'stateDigest':state['stateDigest'],'gamePk':gp,'officialDate':target_date,'homeTeamId':ident['homeTeamId'],'awayTeamId':ident['awayTeamId'],'homePitcherId':ident['homePitcherId'],'awayPitcherId':ident['awayPitcherId'],'homeBattingOrder':ident['homeBattingOrder'],'awayBattingOrder':ident['awayBattingOrder'],'capturedAt':captured}
        rows.append({'gamePk':gp,'officialDate':target_date,'homeTeamId':ident['homeTeamId'],'awayTeamId':ident['awayTeamId'],'startTime':ident['startTime'],'capturedAt':captured,'sourceCutoffAt':captured,'exactPregameLineupSemantics':True,'exactPregameProbableStarterSemantics':True,'wholeOfficialDatePriorStateOnly':True,'featureSource':'V68_FROZEN_PROSPECTIVE_ADAPTER_V1','sourceEvidenceDigest':canonical_digest(evidence),'features':feats,'mechanismDiagnostics':mechanism})
    return {'schemaVersion':SOURCE_SCHEMA,'targetOfficialDate':target_date,'capturedAt':captured,'rows':rows,'diagnostics':diag,'policy':{'containsOutcomes':False,'containsMarketPrices':False,'researchOnly':True,'realFinancialExposure':0}}

def parity(state,base,custody_path,target_date,manifest,v62c,tol):
    lmap={int(x['gamePk']):x for x in base['lineup'].get('snapshots',[])};amap={int(x['gamePk']):x for x in base['audit'].get('rows',[])};expected={}
    with gzip.open(custody_path,'rt',encoding='utf-8') as fz:
        for line in fz:
            r=json.loads(line)
            if r.get('season')=='2026_YTD' and str(r.get('officialDate'))==target_date:expected[int(r['gamePk'])]=r
    exact=list(CONTROL4)+list(QUALITY_NAMES)+['fg_exposure_adv']+[f'{x}_x_fg_mean_starter_share' for x in QUALITY_NAMES];checked=0;mx=0.;fail=[]
    for r in base['table'].get('rows',[]):
        if str(r['officialDate'])!=target_date or r.get('t5PregameValid') is not True:continue
        gp=int(r['gamePk']);lu=lmap[gp];au=amap[gp]
        if not au.get('homeProbablePitcherId') or not au.get('awayProbablePitcherId'):continue
        ident={'gamePk':gp,'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homePitcherId':int(au['homeProbablePitcherId']),'awayPitcherId':int(au['awayProbablePitcherId']),'homeBattingOrder':complete_order(lu['homeBattingOrder']),'awayBattingOrder':complete_order(lu['awayBattingOrder'])}
        got,_=feature_row(state,ident,manifest,v62c);exp=expected.get(gp)
        if not exp:raise SystemExit(f'V68_PARITY_CUSTODY_MISSING:{gp}')
        for name in exact:
            a=got[name];b=exp[name]
            if a is None or b is None:
                if a!=b:fail.append((gp,name,a,b))
            else:
                d=abs(float(a)-float(b));mx=max(mx,d)
                if d>tol:fail.append((gp,name,a,b,d))
        checked+=1
    if fail:raise SystemExit(f'V68_PARITY_FAILED:{fail[:5]}')
    return {'checkedGames':checked,'maxAbsoluteFeatureDiff':mx,'tolerance':tol,'passed':checked>0 and mx<=tol}

def main():
    ap=argparse.ArgumentParser();sub=ap.add_subparsers(dest='mode',required=True)
    p=sub.add_parser('prepare');p.add_argument('--base-root',required=True);p.add_argument('--v62-2025',required=True);p.add_argument('--v62-2026',required=True);p.add_argument('--gap-root');p.add_argument('--gap-pitch');p.add_argument('--target-date',required=True);p.add_argument('--source-manifest',required=True);p.add_argument('--v62-contract',required=True);p.add_argument('--out',required=True)
    l=sub.add_parser('live');l.add_argument('--state',required=True);l.add_argument('--target-date',required=True);l.add_argument('--source-manifest',required=True);l.add_argument('--v62-contract',required=True);l.add_argument('--max-lead-minutes',type=float,default=20.0);l.add_argument('--now');l.add_argument('--out',required=True)
    q=sub.add_parser('parity');q.add_argument('--state',required=True);q.add_argument('--base-root',required=True);q.add_argument('--v66-custody',required=True);q.add_argument('--target-date',required=True);q.add_argument('--source-manifest',required=True);q.add_argument('--v62-contract',required=True);q.add_argument('--tolerance',type=float,default=1e-12);q.add_argument('--out',required=True)
    a=ap.parse_args();manifest=load(a.source_manifest);v62c=load(a.v62_contract)
    if a.mode=='prepare':
        if not valid_date(a.target_date):raise SystemExit('V68_STATE_TARGET_DATE_INVALID')
        base=read_base(a.base_root);gap=read_gap(a.gap_root) if a.gap_root else None;gp=load(a.gap_pitch) if a.gap_pitch else None;s=build_state(base,gap,load(a.v62_2025),load(a.v62_2026),gp,a.target_date,manifest,v62c);dump(a.out,s);print(json.dumps({'targetOfficialDate':a.target_date,'stateDigest':s['stateDigest'],'custody':s['custody']},indent=2))
    elif a.mode=='live':
        if not (0<a.max_lead_minutes<=60):raise SystemExit('V68_SOURCE_CAPTURE_WINDOW_INVALID')
        now=parse_iso(a.now) if a.now else dt.datetime.now(dt.timezone.utc);x=live_source(load(a.state),manifest,v62c,a.target_date,now,a.max_lead_minutes);dump(a.out,x);print(json.dumps({'rows':len(x['rows']),'diagnostics':x['diagnostics']},indent=2))
    else:
        r=parity(load(a.state),read_base(a.base_root),a.v66_custody,a.target_date,manifest,v62c,a.tolerance);dump(a.out,r);print(json.dumps(r,indent=2))
if __name__=='__main__':main()
