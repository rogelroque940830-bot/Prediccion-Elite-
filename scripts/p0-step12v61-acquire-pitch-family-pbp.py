#!/usr/bin/env python3
import argparse,json,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v61-pitch-family-pbp.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PBP='https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay'
SCHEDULE='https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2021&gameType=R'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def fetch_json(url,agent,attempts=4):
    last=None
    for i in range(attempts):
        try:
            req=Request(url,headers={'User-Agent':agent,'Accept':'application/json'})
            with urlopen(req,timeout=35) as r:return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            last=e
            if e.code not in (408,425,429) and e.code<500:break
        except (URLError,TimeoutError,OSError,ValueError) as e:last=e
        if i+1<attempts:time.sleep(.45*(2**i))
    raise RuntimeError(f'{type(last).__name__}:{last}')

def mapped_family(code,mapping):
    return mapping.get(str(code or '').strip().upper())

def empty_outcome():return {'pa':0,'h':0,'tb':0,'bb':0,'k':0,'hr':0}
def add_outcome(rec,event,c):
    rec['pa']+=1
    if event in c['eventDefinitions']['hits']:rec['h']+=1
    rec['tb']+=int(c['eventDefinitions']['totalBases'].get(event,0))
    if event in c['eventDefinitions']['walks']:rec['bb']+=1
    if event in c['eventDefinitions']['strikeouts']:rec['k']+=1
    if event in c['eventDefinitions']['homeRuns']:rec['hr']+=1

def target_rows(season,table):
    t=load(table)
    if t.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V61_BASE_SCHEMA_INVALID:{season}')
    rows=[];seen=set()
    for r in t.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V61_DUPLICATE_TARGET_GAME:{season}:{pk}')
        seen.add(pk);rows.append({'gamePk':pk,'officialDate':str(r['officialDate'])})
    return rows

def warmup_rows():
    p=fetch_json(SCHEDULE,'CourtEdge-Step12V61-WarmupSchedule/1.0')
    out=[];seen=set()
    for d in p.get('dates',[]):
        for g in d.get('games',[]):
            if str(g.get('gameType') or '')!='R':continue
            if str(((g.get('status') or {}).get('abstractGameState')) or '')!='Final':continue
            pk=int(g.get('gamePk') or 0);od=str(g.get('officialDate') or d.get('date') or '')
            if pk<=0 or not od:continue
            if pk in seen:continue
            seen.add(pk);out.append({'gamePk':pk,'officialDate':od})
    out.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    if len(out)<2000:raise SystemExit(f'V61_WARMUP_SCHEDULE_TOO_SMALL:{len(out)}')
    return out

def acquire(row,c,mapping):
    gp=int(row['gamePk']);od=str(row['officialDate'])
    try:
        p=fetch_json(PBP.format(gamePk=gp),'CourtEdge-Step12V61-PitchFamily/1.0')
        plays=p.get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'officialDate':od,'ok':False,'error':'ALL_PLAYS_MISSING'}
        pitcher=defaultdict(lambda:{'allPitches':0,'categorizedPitches':0,'FASTBALL':0,'BREAKING':0,'OFFSPEED':0})
        batter=defaultdict(empty_outcome);all_p=cat_p=terminal=0;excluded=Counter();ptype=Counter()
        for play in plays:
            m=play.get('matchup') or {};pid=int(((m.get('pitcher') or {}).get('id')) or 0);bid=int(((m.get('batter') or {}).get('id')) or 0)
            events=play.get('playEvents') or [];last=None
            for ev in events:
                if not bool(ev.get('isPitch')):continue
                all_p+=1;details=ev.get('details') or {};code=str(((details.get('type') or {}).get('code')) or '').strip().upper()
                if code:ptype[code]+=1
                if pid>0:pitcher[pid]['allPitches']+=1
                fam=mapped_family(code,mapping)
                if fam is None:
                    excluded['UNMAPPED_PITCH_TYPE']+=1;continue
                cat_p+=1;last=fam
                if pid>0:
                    pitcher[pid]['categorizedPitches']+=1;pitcher[pid][fam]+=1
            event=str(((play.get('result') or {}).get('eventType')) or '').strip()
            if bid>0 and last is not None and event:
                terminal+=1;add_outcome(batter[(bid,last)],event,c)
            elif event:
                excluded['TERMINAL_PA_NO_MAPPED_FAMILY_OR_BATTER']+=1
        pr=[{'pitcherId':pid,**v} for pid,v in sorted(pitcher.items())]
        br=[{'batterId':bid,'pitchFamily':fam,**v} for (bid,fam),v in sorted(batter.items())]
        return {'gamePk':gp,'officialDate':od,'ok':True,'allPitchEvents':all_p,'categorizedPitchEvents':cat_p,'terminalPaWithMappedFamily':terminal,'pitchTypeCounts':dict(ptype),'excludedReasons':dict(excluded),'pitcherFamilyTotals':pr,'batterFamilyTotals':br}
    except Exception as e:return {'gamePk':gp,'officialDate':od,'ok':False,'error':str(e)[:300]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table');ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6)
    x=ap.parse_args();c=load(x.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v61-individual-pitchmix-winner-contract.v1':raise SystemExit('V61_CONTRACT_INVALID')
    if x.workers<1 or x.workers>6:raise SystemExit('V61_WORKERS_INVALID')
    mapping={}
    for fam,codes in c['pitchFamilies'].items():
        for code in codes:
            code=str(code).upper()
            if code in mapping:raise SystemExit(f'V61_DUPLICATE_PITCH_CODE:{code}')
            mapping[code]=fam
    warm=(x.season==str(c['dataBoundary']['warmupSeason']))
    rows=warmup_rows() if warm else target_rows(x.season,x.table)
    if not warm:
        exp=int(c['dataBoundary']['expectedRowsBySeason'][x.season])
        if len(rows)!=exp:raise SystemExit(f'V61_TARGET_ROW_COUNT_DRIFT:{x.season}:{len(rows)}:{exp}')
    games=[]
    with ThreadPoolExecutor(max_workers=x.workers) as ex:
        fut={ex.submit(acquire,r,c,mapping):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda z:(z.get('officialDate','9999'),z['gamePk']))
    good=[g for g in games if g.get('ok') is True];fail=[g for g in games if g.get('ok') is not True]
    all_p=sum(int(g['allPitchEvents']) for g in good);cat_p=sum(int(g['categorizedPitchEvents']) for g in good);terminal=sum(int(g['terminalPaWithMappedFamily']) for g in good)
    excluded=Counter();pt=Counter()
    for g in good:excluded.update(g['excludedReasons']);pt.update(g['pitchTypeCounts'])
    share=cat_p/all_p if all_p else 0.;failure_share=len(fail)/len(rows) if rows else 1.
    out={'schemaVersion':SCHEMA,'season':x.season,'warmupOnly':warm,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':failure_share,'failures':fail,'allPitchEvents':all_p,'categorizedPitchEvents':cat_p,'categorizedPitchShare':share,'terminalPaWithMappedFamily':terminal,'pitchTypeCounts':dict(pt),'excludedReasons':dict(excluded),'games':good,'policy':{'sameDateOutcomeMayTrainSameDate':False,'futureGameDataAllowed':False,'containsFinalHistoricalPbpOnly':True,'targetRowsComeOnlyFromCanonicalStep12V3':not warm,'warmupRowsComeOnlyFrom2021RegularSeasonFinalSchedule':warm}}
    os.makedirs(os.path.dirname(x.out) or '.',exist_ok=True)
    with open(x.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':SCHEMA,'season':x.season,'warmupOnly':warm,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':failure_share,'categorizedPitchShare':share,'terminalPaWithMappedFamily':terminal},indent=2))
    if share<float(c['historicalPitchCustody']['minimumMappedPitchShareEachSeason']):raise SystemExit(f'V61_MAPPED_PITCH_SHARE_LOW:{x.season}:{share}')
    if not warm and failure_share>float(c['historicalPitchCustody']['maximumTargetGameFetchFailureShareEachSeason']):raise SystemExit(f'V61_TARGET_FETCH_FAILURE_SHARE_HIGH:{x.season}:{failure_share}')
    if warm and failure_share>0.01:raise SystemExit(f'V61_WARMUP_FETCH_FAILURE_SHARE_HIGH:{failure_share}')
if __name__=='__main__':main()
