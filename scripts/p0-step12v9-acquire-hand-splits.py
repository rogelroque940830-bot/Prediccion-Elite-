#!/usr/bin/env python3
import argparse,json,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v9-game-team-hand-aggregates.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
API='https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay'
HIT_TB={'single':1,'double':2,'triple':3,'home_run':4}
WALKS={'walk','intent_walk'}
HBP={'hit_by_pitch'}
SO={'strikeout','strikeout_double_play'}
SF={'sac_fly','sac_fly_double_play'}
NON_AB=WALKS|HBP|{'sac_bunt','sac_bunt_double_play','sac_fly','sac_fly_double_play','catcher_interf'}

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def blank():return {'pa':0,'ab':0,'h':0,'doubles':0,'triples':0,'hr':0,'tb':0,'bb':0,'hbp':0,'so':0,'sf':0}

def fetch(game_pk,attempts=3):
    url=API.format(gamePk=game_pk);last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V9/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(0.35*(2**i))
    raise RuntimeError(f'{type(last).__name__}:{last}')

def add(c,event):
    c['pa']+=1
    if event not in NON_AB:c['ab']+=1
    if event in HIT_TB:
        c['h']+=1;c['tb']+=HIT_TB[event]
        if event=='double':c['doubles']+=1
        elif event=='triple':c['triples']+=1
        elif event=='home_run':c['hr']+=1
    if event in WALKS:c['bb']+=1
    if event in HBP:c['hbp']+=1
    if event in SO:c['so']+=1
    if event in SF:c['sf']+=1

def one(row):
    gp=int(row['gamePk']);ht=int(row['homeTeamId']);at=int(row['awayTeamId'])
    try:
        p=fetch(gp);plays=p.get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'ok':False,'error':'ALL_PLAYS_MISSING'}
        agg={(ht,'R'):blank(),(ht,'L'):blank(),(at,'R'):blank(),(at,'L'):blank()};events=Counter();excluded=Counter();valid=0
        for play in plays:
            about=play.get('about') or {};match=play.get('matchup') or {};res=play.get('result') or {}
            half=str(about.get('halfInning') or '').lower();hand=str((match.get('pitchHand') or {}).get('code') or '').upper();event=str(res.get('eventType') or '').strip()
            batter=(match.get('batter') or {}).get('id');pitcher=(match.get('pitcher') or {}).get('id')
            if half not in ('top','bottom') or hand not in ('R','L') or not event or not batter or not pitcher:
                excluded['INVALID_PA_IDENTITY']+=1;continue
            team=at if half=='top' else ht
            add(agg[(team,hand)],event);events[event]+=1;valid+=1
        return {'gamePk':gp,'officialDate':row['officialDate'],'homeTeamId':ht,'awayTeamId':at,'ok':True,'validPlateAppearances':valid,'excludedPlateAppearances':sum(excluded.values()),'excludedReasons':dict(excluded),'eventTypeCounts':dict(events),'teamHandTotals':[{'teamId':tid,'vsHand':hand,**vals} for (tid,hand),vals in sorted(agg.items())]}
    except Exception as e:return {'gamePk':gp,'ok':False,'error':str(e)[:240]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();d=load(a.table)
    if d.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V9_BASE_SCHEMA_INVALID')
    if a.workers<1 or a.workers>6:raise SystemExit('STEP12V9_WORKERS_INVALID')
    rows=[];seen=set()
    for r in d['rows']:
        gp=int(r['gamePk'])
        if gp in seen:raise SystemExit(f'STEP12V9_DUPLICATE_GAME:{gp}')
        seen.add(gp);rows.append({'gamePk':gp,'officialDate':r['officialDate'],'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId'])})
    games=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(one,r):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda x:(x.get('officialDate','9999'),x['gamePk']))
    failures=[x for x in games if not x['ok']];good=[x for x in games if x['ok']]
    events=Counter();excluded=Counter();pa=0
    for g in good:
        events.update(g['eventTypeCounts']);excluded.update(g['excludedReasons']);pa+=g['validPlateAppearances']
    out={'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failures':failures,'validPlateAppearances':pa,'excludedPlateAppearances':sum(excluded.values()),'excludedReasons':dict(excluded),'eventTypeCounts':dict(events),'games':good,'policy':{'sameDateOutcomeLeakageAllowed':False,'thisFileContainsFinalPastGameAggregatesOnly':True,'featureScorerMustApplyGamesOnlyAfterCompletingThatOfficialDate':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({k:out[k] for k in ('schemaVersion','season','gamesExpected','gamesFetched','validPlateAppearances','excludedPlateAppearances','excludedReasons')},indent=2))
    if failures:raise SystemExit(f'STEP12V9_FETCH_FAILURES:{len(failures)}')
if __name__=='__main__':main()
