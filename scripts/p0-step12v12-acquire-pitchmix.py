#!/usr/bin/env python3
import argparse,json,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v12-game-pitchmix-summary.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
API='https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay'
HIT_TB={'single':1,'double':2,'triple':3,'home_run':4}


def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)


def fetch(game_pk,attempts=3):
    url=API.format(gamePk=game_pk);last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':'CourtEdge-Step12V12/1.0','Accept':'application/json'})
            with urlopen(req,timeout=25) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(0.35*(2**i))
    raise RuntimeError(f'{type(last).__name__}:{last}')


def blank_team():
    return {'pitches':0,'swings':0,'whiffs':0,'contacts':0,'terminalPa':0,'tb':0,'hr':0}


def blank_pitcher():
    return {'allPitches':0,'categorizedPitches':0,'FASTBALL':0,'BREAKING':0,'OFFSPEED':0}


def is_whiff(details):
    desc=str(details.get('description') or '').strip().lower()
    code=str(details.get('code') or '').strip().upper()
    return ('swinging strike' in desc) or ('missed bunt' in desc) or code in {'S','W','M'}


def is_swing(details):
    desc=str(details.get('description') or '').strip().lower()
    code=str(details.get('code') or '').strip().upper()
    if is_whiff(details):return True
    if bool(details.get('isInPlay')):return True
    return ('foul' in desc) or ('in play' in desc) or code in {'F','T','L','X','D','E'}


def one(row,pitch_code_to_family):
    gp=int(row['gamePk']);ht=int(row['homeTeamId']);at=int(row['awayTeamId'])
    try:
        payload=fetch(gp);plays=payload.get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'ok':False,'error':'ALL_PLAYS_MISSING'}
        pitchers=defaultdict(blank_pitcher)
        teams={(ht,f):blank_team() for f in ('FASTBALL','BREAKING','OFFSPEED')}
        teams.update({(at,f):blank_team() for f in ('FASTBALL','BREAKING','OFFSPEED')})
        pitch_types=Counter();families=Counter();excluded=Counter();all_pitch_events=0;categorized=0;terminal_pas=0
        for play in plays:
            about=play.get('about') or {};match=play.get('matchup') or {};result=play.get('result') or {}
            half=str(about.get('halfInning') or '').lower();pid=(match.get('pitcher') or {}).get('id')
            if half not in ('top','bottom') or not pid:
                excluded['PLAY_IDENTITY_MISSING']+=1;continue
            batting_team=at if half=='top' else ht
            last_family=None
            events=play.get('playEvents') or []
            for ev in events:
                if not bool(ev.get('isPitch')):continue
                all_pitch_events+=1
                details=ev.get('details') or {}
                ptype=str(((details.get('type') or {}).get('code')) or '').strip().upper()
                pitchers[int(pid)]['allPitches']+=1
                if ptype:pitch_types[ptype]+=1
                fam=pitch_code_to_family.get(ptype)
                if fam is None:
                    excluded['UNMAPPED_PITCH_TYPE']+=1;continue
                categorized+=1;families[fam]+=1;last_family=fam
                pitchers[int(pid)]['categorizedPitches']+=1;pitchers[int(pid)][fam]+=1
                rec=teams[(batting_team,fam)];rec['pitches']+=1
                if is_swing(details):
                    rec['swings']+=1
                    if is_whiff(details):rec['whiffs']+=1
                    else:rec['contacts']+=1
            event_type=str(result.get('eventType') or '').strip()
            if last_family is not None and event_type:
                rec=teams[(batting_team,last_family)];rec['terminalPa']+=1;terminal_pas+=1
                if event_type in HIT_TB:
                    rec['tb']+=HIT_TB[event_type]
                    if event_type=='home_run':rec['hr']+=1
        pitcher_rows=[]
        for pid,vals in sorted(pitchers.items()):pitcher_rows.append({'pitcherId':pid,**vals})
        team_rows=[]
        for (tid,fam),vals in sorted(teams.items()):team_rows.append({'teamId':tid,'pitchFamily':fam,**vals})
        return {
            'gamePk':gp,'officialDate':row['officialDate'],'homeTeamId':ht,'awayTeamId':at,'ok':True,
            'allPitchEvents':all_pitch_events,'categorizedPitchEvents':categorized,'terminalPaWithFamily':terminal_pas,
            'pitchTypeCounts':dict(pitch_types),'pitchFamilyCounts':dict(families),'excludedReasons':dict(excluded),
            'pitcherTotals':pitcher_rows,'teamPitchFamilyTotals':team_rows
        }
    except Exception as e:return {'gamePk':gp,'officialDate':row.get('officialDate'),'ok':False,'error':str(e)[:240]}


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    a=ap.parse_args();table=load(a.table);contract=load(a.contract)
    if table.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V12_BASE_SCHEMA_INVALID')
    if contract.get('schemaVersion')!='courtedge-p0-step12v12-pitchmix-lineup-matchup-contract.v1':raise SystemExit('STEP12V12_CONTRACT_INVALID')
    if a.workers<1 or a.workers>6:raise SystemExit('STEP12V12_WORKERS_INVALID')
    code_to_family={}
    for fam,codes in contract['pitchFamilies'].items():
        for code in codes:
            if code in code_to_family:raise SystemExit(f'STEP12V12_DUPLICATE_PITCH_CODE:{code}')
            code_to_family[str(code).upper()]=fam
    rows=[];seen=set()
    for r in table['rows']:
        gp=int(r['gamePk'])
        if gp in seen:raise SystemExit(f'STEP12V12_DUPLICATE_GAME:{gp}')
        seen.add(gp);rows.append({'gamePk':gp,'officialDate':r['officialDate'],'homeTeamId':int(r['homeTeamId']),'awayTeamId':int(r['awayTeamId'])})
    games=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(one,r,code_to_family):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda x:(x.get('officialDate') or '9999',x['gamePk']))
    failures=[x for x in games if not x.get('ok')];good=[x for x in games if x.get('ok')]
    pt=Counter();pf=Counter();excluded=Counter();all_p=cat_p=terminal=0
    for g in good:
        pt.update(g['pitchTypeCounts']);pf.update(g['pitchFamilyCounts']);excluded.update(g['excludedReasons'])
        all_p+=g['allPitchEvents'];cat_p+=g['categorizedPitchEvents'];terminal+=g['terminalPaWithFamily']
    out={
        'schemaVersion':SCHEMA,'season':a.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failures':failures,
        'allPitchEvents':all_p,'categorizedPitchEvents':cat_p,'categorizedPitchShare':cat_p/all_p if all_p else 0.0,
        'terminalPaWithFamily':terminal,'pitchTypeCounts':dict(pt),'pitchFamilyCounts':dict(pf),'excludedReasons':dict(excluded),'games':good,
        'policy':{'sameDateOutcomeLeakageAllowed':False,'containsFinalPastGameSummariesOnly':True,'rollingScorerMustUseOnlyOfficialDatesStrictlyBeforeTarget':True}
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({k:out[k] for k in ('schemaVersion','season','gamesExpected','gamesFetched','allPitchEvents','categorizedPitchEvents','categorizedPitchShare','terminalPaWithFamily','pitchFamilyCounts')},indent=2))
    if failures:raise SystemExit(f'STEP12V12_FETCH_FAILURES:{len(failures)}')
    if out['categorizedPitchShare']<0.80:raise SystemExit(f"STEP12V12_PITCH_TYPE_COVERAGE_LOW:{out['categorizedPitchShare']:.4f}")

if __name__=='__main__':main()
