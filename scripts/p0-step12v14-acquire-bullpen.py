#!/usr/bin/env python3
import argparse,json,os,time
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v14-game-bullpen-summary.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
API='https://statsapi.mlb.com/api/v1/game/{gamePk}/boxscore'


def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)


def fetch(game_pk,attempts=3):
    url=API.format(gamePk=game_pk);last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V14/1.0','Accept':'application/json'})
            with urlopen(req,timeout=20) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(0.3*(2**i))
    raise RuntimeError(f'{type(last).__name__}:{last}')


def side_summary(team_blob,team_id,starter_id):
    pitchers=[int(x) for x in (team_blob.get('pitchers') or []) if str(x).isdigit()]
    players=team_blob.get('players') or {}
    starter_id=int(starter_id) if starter_id is not None else None
    starter_present=starter_id in pitchers if starter_id is not None else False
    relievers=[]
    if starter_id is not None and starter_present:
        for pid in pitchers:
            if pid==starter_id:continue
            p=players.get(f'ID{pid}') or {}
            stats=((p.get('stats') or {}).get('pitching') or {})
            pitches=stats.get('pitchesThrown')
            try:pitches=int(pitches)
            except:pitches=0
            if pitches<0:pitches=0
            relievers.append({'pitcherId':pid,'pitches':pitches})
    return {
        'teamId':int(team_id),
        'starterId':starter_id,
        'starterPresent':starter_present,
        'pitchersListed':len(pitchers),
        'bullpenPitches':sum(x['pitches'] for x in relievers),
        'relieversUsed':len(relievers),
        'relievers':sorted(relievers,key=lambda x:x['pitcherId'])
    }


def one(row):
    gp=int(row['gamePk']);ht=int(row['homeTeamId']);at=int(row['awayTeamId'])
    try:
        payload=fetch(gp);teams=payload.get('teams') or {}
        home=side_summary(teams.get('home') or {},ht,row.get('t5HomeProbablePitcherId'))
        away=side_summary(teams.get('away') or {},at,row.get('t5AwayProbablePitcherId'))
        return {
            'gamePk':gp,'officialDate':row['officialDate'],'homeTeamId':ht,'awayTeamId':at,'ok':True,
            'identityComplete':bool(home['starterPresent'] and away['starterPresent']),
            'home':home,'away':away
        }
    except Exception as e:
        return {'gamePk':gp,'officialDate':row.get('officialDate'),'ok':False,'error':str(e)[:240]}


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=8)
    a=ap.parse_args();table=load(a.table);contract=load(a.contract)
    if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V14_BASE_SCHEMA_INVALID')
    if contract.get('schemaVersion')!='courtedge-p0-step12v14-bullpen-availability-routing-contract.v1':raise SystemExit('STEP12V14_CONTRACT_INVALID')
    if a.workers<1 or a.workers>8:raise SystemExit('STEP12V14_WORKERS_INVALID')
    rows=[];seen=set()
    for r in table['rows']:
        gp=int(r['gamePk'])
        if gp in seen:raise SystemExit(f'STEP12V14_DUPLICATE_GAME:{gp}')
        seen.add(gp)
        rows.append({
            'gamePk':gp,'officialDate':r['officialDate'],'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId']),
            't5HomeProbablePitcherId':r.get('t5HomeProbablePitcherId'),'t5AwayProbablePitcherId':r.get('t5AwayProbablePitcherId')
        })
    games=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(one,r):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda x:(x.get('officialDate') or '9999',x['gamePk']))
    failures=[x for x in games if not x.get('ok')];good=[x for x in games if x.get('ok')]
    complete=[x for x in good if x.get('identityComplete')]
    out={
        'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'gamesFetched':len(good),
        'identityCompleteGames':len(complete),'identityCompleteShare':len(complete)/len(good) if good else 0.0,
        'failures':failures,'games':good,
        'policy':{'sameDateOutcomeLeakageAllowed':False,'currentMetadataFallbackAllowed':False,'starterIdentityFrozenT5Only':True}
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({k:out[k] for k in ('schemaVersion','season','gamesExpected','gamesFetched','identityCompleteGames','identityCompleteShare')},indent=2))
    if failures:raise SystemExit(f'STEP12V14_FETCH_FAILURES:{len(failures)}')
    if out['identityCompleteShare']<0.90:raise SystemExit(f"STEP12V14_STARTER_IDENTITY_COVERAGE_LOW:{out['identityCompleteShare']:.4f}")

if __name__=='__main__':main()
