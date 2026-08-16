#!/usr/bin/env python3
import argparse,hashlib,json,os,time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v60-pregame-starter-hands.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
LINEUP_SCHEMA='courtedge-p0-step12m-cohort-pregame-lineups.v1'
API='https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live?timecode={timecode}'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def norm_order(v):
    if not isinstance(v,list):return []
    out=[]
    for x in v:
        try:i=int(x)
        except:return []
        if i<=0:return []
        out.append(i)
    return out

def fetch_json(game_pk,timecode,attempts=4):
    url=API.format(gamePk=game_pk,timecode=timecode);last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V60-PregameHands/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:return json.loads(r.read().decode('utf-8')),url
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(0.45*(2**i))
    raise RuntimeError(f'FETCH_FAILED:{type(last).__name__}:{last}')

def hand_for(players,pid,key,allowed):
    p=players.get(f'ID{int(pid)}') if pid else None
    code=str((p or {}).get(key,{}).get('code','')).strip().upper()
    return code if code in allowed else None

def probable_id(prob,side):
    try:return int(((prob.get(side) or {}).get('id')) or 0)
    except:return 0

def acquire(item):
    base={k:item[k] for k in ('season','gamePk','officialDate','homeTeamId','awayTeamId','homePitcherId','awayPitcherId','requestedTimecode')}
    if item['homePitcherId']<=0 or item['awayPitcherId']<=0:
        return {**base,'usable':False,'reason':'FROZEN_T5_PROBABLE_STARTER_ID_MISSING'}
    try:
        payload,url=fetch_json(item['gamePk'],item['requestedTimecode'])
        base['urlDigest']=hashlib.sha256(url.encode()).hexdigest()
        if int(payload.get('gamePk') or 0)!=item['gamePk']:return {**base,'usable':False,'reason':'GAME_PK_MISMATCH'}
        gd=payload.get('gameData') or {};teams=gd.get('teams') or {}
        if int(((teams.get('home') or {}).get('id')) or 0)!=item['homeTeamId'] or int(((teams.get('away') or {}).get('id')) or 0)!=item['awayTeamId']:
            return {**base,'usable':False,'reason':'TEAM_ID_MISMATCH'}
        source_tc=str((payload.get('metaData') or {}).get('timeStamp') or '').strip()
        if not source_tc or source_tc>item['requestedTimecode']:
            return {**base,'usable':False,'reason':'NON_HISTORICAL_SOURCE_TIMECODE','sourceMetadataTimecode':source_tc or None}
        box=((payload.get('liveData') or {}).get('boxscore') or {}).get('teams') or {}
        ho=norm_order(((box.get('home') or {}).get('battingOrder')));ao=norm_order(((box.get('away') or {}).get('battingOrder')))
        if ho!=item['homeBattingOrder'] or ao!=item['awayBattingOrder']:
            return {**base,'usable':False,'reason':'BATTING_ORDER_MISMATCH','sourceMetadataTimecode':source_tc}
        prob=gd.get('probablePitchers') or {};hp_prob=probable_id(prob,'home');ap_prob=probable_id(prob,'away')
        if hp_prob!=item['homePitcherId'] or ap_prob!=item['awayPitcherId']:
            return {**base,'usable':False,'reason':'PROBABLE_STARTER_ID_MISMATCH','sourceMetadataTimecode':source_tc,'sourceHomeProbablePitcherId':hp_prob or None,'sourceAwayProbablePitcherId':ap_prob or None}
        players=gd.get('players') or {};hp=hand_for(players,item['homePitcherId'],'pitchHand',{'R','L'});ap=hand_for(players,item['awayPitcherId'],'pitchHand',{'R','L'})
        if hp is None or ap is None:return {**base,'usable':False,'reason':'STARTER_HAND_MISSING','sourceMetadataTimecode':source_tc}
        hb=[hand_for(players,p,'batSide',{'R','L','S'}) for p in ho];ab=[hand_for(players,p,'batSide',{'R','L','S'}) for p in ao]
        return {**base,'usable':True,'reason':None,'sourceMetadataTimecode':source_tc,'sourceDigest':digest(payload),'homeStarterHand':hp,'awayStarterHand':ap,'starterHandPair':hp+ap,'homeBatterSides':hb,'awayBatterSides':ab}
    except Exception as e:return {**base,'usable':False,'reason':str(e)[:240]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table',required=True);ap.add_argument('--lineups',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();table=load(a.table);lineups=load(a.lineups)
    if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('V60_PREGAME_HANDS_BASE_SCHEMA_INVALID')
    if lineups.get('schemaVersion')!=LINEUP_SCHEMA:raise SystemExit('V60_PREGAME_HANDS_LINEUP_SCHEMA_INVALID')
    if a.workers<1 or a.workers>8:raise SystemExit('V60_PREGAME_HANDS_WORKERS_INVALID')
    lm={int(x['gamePk']):x for x in lineups.get('snapshots',[])};rows=[];seen=set()
    for r in table.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V60_PREGAME_HANDS_DUPLICATE_GAME:{pk}')
        seen.add(pk);ls=lm.get(pk)
        if not ls or ls.get('complete') is not True:raise SystemExit(f'V60_PREGAME_HANDS_CANONICAL_LINEUP_MISSING:{pk}')
        hpid=int(r.get('t5HomeProbablePitcherId') or 0);apid=int(r.get('t5AwayProbablePitcherId') or 0)
        rows.append({'season':a.season,'gamePk':pk,'officialDate':str(r['officialDate']),'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),'homePitcherId':hpid,'awayPitcherId':apid,'requestedTimecode':str(ls['requestedTimecode']),'homeBattingOrder':[int(x) for x in ls['homeBattingOrder']],'awayBattingOrder':[int(x) for x in ls['awayBattingOrder']]})
    snaps=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(acquire,r):r['gamePk'] for r in rows}
        for f in as_completed(fut):snaps.append(f.result())
    snaps.sort(key=lambda x:(x.get('officialDate','9999'),x['gamePk']))
    usable=[x for x in snaps if x.get('usable') is True];reasons=Counter(x.get('reason') for x in snaps if x.get('usable') is not True)
    out={'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'usableGames':len(usable),'usableShare':len(usable)/len(rows) if rows else 0.0,'unusableReasons':dict(reasons),'snapshots':snaps,'policy':{'source':'MLB_STATS_API_TIMECODE_FEED','exactT5BattingOrderRequired':True,'probableStarterIdentityMatchRequired':True,'missingFrozenProbableStarterClassifiedUnusable':True,'currentPlayerMetadataFallbackAllowed':False,'currentGamePlayByPlayMaySupplyStarterHand':False,'futureGameDataAllowed':False}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'usableGames':len(usable),'usableShare':out['usableShare'],'unusableReasons':dict(reasons)},indent=2))
if __name__=='__main__':main()
