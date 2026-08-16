#!/usr/bin/env python3
import argparse,json,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v60-batter-hand-pbp.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
API='https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay'
HIT_TB={'single':1,'double':2,'triple':3,'home_run':4}
WALKS={'walk','intent_walk'}
SO={'strikeout','strikeout_double_play'}

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def blank():return {'pa':0,'h':0,'tb':0,'bb':0,'k':0,'hr':0}
def fetch(game_pk,attempts=4):
    url=API.format(gamePk=game_pk);last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V60-BatterHand/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(0.45*(2**i))
    raise RuntimeError(f'{type(last).__name__}:{last}')
def add(c,event):
    c['pa']+=1
    if event in HIT_TB:
        c['h']+=1;c['tb']+=HIT_TB[event]
        if event=='home_run':c['hr']+=1
    if event in WALKS:c['bb']+=1
    if event in SO:c['k']+=1

def one(row):
    pk=int(row['gamePk'])
    try:
        p=fetch(pk);plays=p.get('allPlays')
        if not isinstance(plays,list):return {'gamePk':pk,'officialDate':row['officialDate'],'ok':False,'error':'ALL_PLAYS_MISSING'}
        agg=defaultdict(blank);events=Counter();excluded=Counter();valid=0
        for play in plays:
            match=play.get('matchup') or {};res=play.get('result') or {}
            hand=str((match.get('pitchHand') or {}).get('code') or '').upper();event=str(res.get('eventType') or '').strip();batter=(match.get('batter') or {}).get('id');pitcher=(match.get('pitcher') or {}).get('id')
            try:bid=int(batter or 0);pid=int(pitcher or 0)
            except:bid=0;pid=0
            if bid<=0 or pid<=0 or hand not in ('R','L') or not event:
                excluded['INVALID_PA_IDENTITY']+=1;continue
            add(agg[(bid,hand)],event);events[event]+=1;valid+=1
        totals=[{'batterId':bid,'vsHand':hand,**vals} for (bid,hand),vals in sorted(agg.items())]
        return {'gamePk':pk,'officialDate':row['officialDate'],'homeTeamId':int(row['homeTeamId']),'awayTeamId':int(row['awayTeamId']),'ok':True,'validPlateAppearances':valid,'excludedPlateAppearances':sum(excluded.values()),'excludedReasons':dict(excluded),'eventTypeCounts':dict(events),'batterHandTotals':totals}
    except Exception as e:return {'gamePk':pk,'officialDate':row['officialDate'],'ok':False,'error':str(e)[:240]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();d=load(a.table)
    if d.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('V60_BATTER_HAND_BASE_SCHEMA_INVALID')
    if a.workers<1 or a.workers>6:raise SystemExit('V60_BATTER_HAND_WORKERS_INVALID')
    rows=[];seen=set()
    for r in d.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V60_BATTER_HAND_DUPLICATE_GAME:{pk}')
        seen.add(pk);rows.append({'gamePk':pk,'officialDate':str(r['officialDate']),'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId'])})
    games=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(one,r):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda x:(x.get('officialDate','9999'),x['gamePk']))
    failures=[x for x in games if not x.get('ok')];good=[x for x in games if x.get('ok')]
    events=Counter();excluded=Counter();valid=0
    for g in good:
        events.update(g.get('eventTypeCounts',{}));excluded.update(g.get('excludedReasons',{}));valid+=int(g.get('validPlateAppearances',0))
    out={'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failures':failures,'validPlateAppearances':valid,'excludedPlateAppearances':sum(excluded.values()),'excludedReasons':dict(excluded),'eventTypeCounts':dict(events),'games':good,'policy':{'source':'MLB_STATS_API_FINAL_PLAY_BY_PLAY','containsFinalPastGameAggregatesOnly':True,'sameDateOutcomeMayTrainSameDate':False,'featureStateMustUpdateOnlyAfterWholeOfficialDateIsScored':True,'futureGameDataAllowed':False}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    denom=valid+sum(excluded.values());share=(sum(excluded.values())/denom) if denom else 0.0
    print(json.dumps({'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failures':len(failures),'validPlateAppearances':valid,'excludedPlateAppearances':sum(excluded.values()),'excludedShare':share,'excludedReasons':dict(excluded)},indent=2))
    if failures:raise SystemExit(f'V60_BATTER_HAND_FETCH_FAILURES:{len(failures)}')
if __name__=='__main__':main()
