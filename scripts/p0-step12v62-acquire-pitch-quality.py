#!/usr/bin/env python3
import argparse,json,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v62-pitch-quality-pbp.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PBP='https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live'
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

def finite(v):
    try:return float(v) if v is not None and float(v)==float(v) else None
    except:return None

def empty_pitch():
    return {'pitches':0,'strikes':0,'swings':0,'whiffs':0,'velocityN':0,'velocitySum':0.0,'spinN':0,'spinSum':0.0,'battedBallN':0,'hardHitN':0}
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
    if t.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V62_BASE_SCHEMA_INVALID:{season}')
    rows=[];seen=set()
    for r in t.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V62_DUPLICATE_TARGET_GAME:{season}:{pk}')
        seen.add(pk);rows.append({'gamePk':pk,'officialDate':str(r['officialDate'])})
    return rows

def warmup_rows():
    p=fetch_json(SCHEDULE,'CourtEdge-Step12V62-WarmupSchedule/1.0')
    out=[];seen=set()
    for d in p.get('dates',[]):
        for g in d.get('games',[]):
            if str(g.get('gameType') or '')!='R':continue
            if str(((g.get('status') or {}).get('abstractGameState')) or '')!='Final':continue
            pk=int(g.get('gamePk') or 0);od=str(g.get('officialDate') or d.get('date') or '')
            if pk<=0 or not od or pk in seen:continue
            seen.add(pk);out.append({'gamePk':pk,'officialDate':od})
    out.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    if len(out)<2000:raise SystemExit(f'V62_WARMUP_SCHEDULE_TOO_SMALL:{len(out)}')
    return out

def acquire(row,c,recognized):
    gp=int(row['gamePk']);od=str(row['officialDate'])
    try:
        p=fetch_json(PBP.format(gamePk=gp),'CourtEdge-Step12V62-PitchQuality/1.0')
        plays=((p.get('liveData') or {}).get('plays') or {}).get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'officialDate':od,'ok':False,'error':'ALL_PLAYS_MISSING'}
        pitcher=defaultdict(empty_pitch);batter=defaultdict(empty_outcome);allp=recp=veln=spinn=0;ptype=Counter();excluded=Counter();terminal=0
        swing_desc=set(c['eventDefinitions']['swingDescriptions']);whiff_desc=set(c['eventDefinitions']['whiffDescriptions'])
        for play in plays:
            m=play.get('matchup') or {};pid=int(((m.get('pitcher') or {}).get('id')) or 0);bid=int(((m.get('batter') or {}).get('id')) or 0)
            last_type=None
            for ev in play.get('playEvents') or []:
                if not bool(ev.get('isPitch')):continue
                allp+=1;details=ev.get('details') or {};pt=str(((details.get('type') or {}).get('code')) or '').strip().upper();desc=str(details.get('description') or '').strip().lower()
                if pt:ptype[pt]+=1
                if pt not in recognized:
                    excluded['UNRECOGNIZED_PITCH_TYPE']+=1;continue
                recp+=1;last_type=pt
                if pid<=0:
                    excluded['PITCHER_ID_MISSING']+=1;continue
                z=pitcher[(pid,pt)];z['pitches']+=1
                if details.get('isStrike') is True:z['strikes']+=1
                if desc in swing_desc:z['swings']+=1
                if desc in whiff_desc:z['whiffs']+=1
                pd=ev.get('pitchData') or {};v=finite(pd.get('startSpeed'));spin=finite(((pd.get('breaks') or {}).get('spinRate')))
                if v is not None and 50<=v<=110:z['velocityN']+=1;z['velocitySum']+=v;veln+=1
                if spin is not None and 300<=spin<=4000:z['spinN']+=1;z['spinSum']+=spin;spinn+=1
                hd=ev.get('hitData') or {};ls=finite(hd.get('launchSpeed'))
                if ls is not None and 20<=ls<=125:
                    z['battedBallN']+=1
                    if ls>=95:z['hardHitN']+=1
            event=str(((play.get('result') or {}).get('eventType')) or '').strip()
            if bid>0 and last_type is not None and event:
                terminal+=1;add_outcome(batter[(bid,last_type)],event,c)
            elif event:excluded['TERMINAL_PA_NO_RECOGNIZED_PITCH_OR_BATTER']+=1
        pr=[{'pitcherId':pid,'pitchType':pt,**v} for (pid,pt),v in sorted(pitcher.items())]
        br=[{'batterId':bid,'pitchType':pt,**v} for (bid,pt),v in sorted(batter.items())]
        return {'gamePk':gp,'officialDate':od,'ok':True,'allPitchEvents':allp,'recognizedPitchEvents':recp,'velocityTelemetryPitchEvents':veln,'spinTelemetryPitchEvents':spinn,'terminalPaWithRecognizedPitchType':terminal,'pitchTypeCounts':dict(ptype),'excludedReasons':dict(excluded),'pitcherPitchTypeTotals':pr,'batterPitchTypeTotals':br}
    except Exception as e:return {'gamePk':gp,'officialDate':od,'ok':False,'error':str(e)[:300]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table');ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6);x=ap.parse_args();c=load(x.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v62-pitch-quality-winner-contract.v1':raise SystemExit('V62_CONTRACT_INVALID')
    if x.workers<1 or x.workers>6:raise SystemExit('V62_WORKERS_INVALID')
    recognized=set(c['recognizedPitchTypes']);warm=x.season==str(c['dataBoundary']['warmupSeason']);rows=warmup_rows() if warm else target_rows(x.season,x.table)
    if not warm:
        exp=int(c['dataBoundary']['expectedRowsBySeason'][x.season])
        if len(rows)!=exp:raise SystemExit(f'V62_TARGET_ROW_COUNT_DRIFT:{x.season}:{len(rows)}:{exp}')
    games=[]
    with ThreadPoolExecutor(max_workers=x.workers) as ex:
        fut={ex.submit(acquire,r,c,recognized):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda z:(z.get('officialDate','9999'),z['gamePk']));good=[g for g in games if g.get('ok') is True];fail=[g for g in games if g.get('ok') is not True]
    allp=sum(g['allPitchEvents'] for g in good);recp=sum(g['recognizedPitchEvents'] for g in good);veln=sum(g['velocityTelemetryPitchEvents'] for g in good);spinn=sum(g['spinTelemetryPitchEvents'] for g in good);terminal=sum(g['terminalPaWithRecognizedPitchType'] for g in good);pt=Counter();excl=Counter()
    for g in good:pt.update(g['pitchTypeCounts']);excl.update(g['excludedReasons'])
    share=recp/allp if allp else 0.;vshare=veln/recp if recp else 0.;sshare=spinn/recp if recp else 0.;fshare=len(fail)/len(rows) if rows else 1.
    out={'schemaVersion':SCHEMA,'season':x.season,'warmupOnly':warm,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'failures':fail,'allPitchEvents':allp,'recognizedPitchEvents':recp,'recognizedPitchTypeShare':share,'velocityTelemetryPitchEvents':veln,'velocityTelemetryShare':vshare,'spinTelemetryPitchEvents':spinn,'spinTelemetryShare':sshare,'terminalPaWithRecognizedPitchType':terminal,'pitchTypeCounts':dict(pt),'excludedReasons':dict(excl),'games':good,'policy':{'sameDateOutcomeMayTrainSameDate':False,'futureGameDataAllowed':False,'containsFinalHistoricalPbpOnly':True,'targetRowsComeOnlyFromCanonicalStep12V3':not warm,'warmupRowsComeOnlyFrom2021RegularSeasonFinalSchedule':warm}}
    os.makedirs(os.path.dirname(x.out) or '.',exist_ok=True)
    with open(x.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':SCHEMA,'season':x.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'recognizedPitchTypeShare':share,'velocityTelemetryShare':vshare,'spinTelemetryShare':sshare,'terminalPaWithRecognizedPitchType':terminal},indent=2))
    h=c['historicalPitchTelemetryCustody']
    if share<float(h['minimumRecognizedPitchTypeShareEachSeason']):raise SystemExit(f'V62_RECOGNIZED_PITCH_SHARE_LOW:{x.season}:{share}')
    if vshare<float(h['minimumVelocityTelemetryShareEachSeason']):raise SystemExit(f'V62_VELOCITY_TELEMETRY_SHARE_LOW:{x.season}:{vshare}')
    if sshare<float(h['minimumSpinTelemetryShareEachSeason']):raise SystemExit(f'V62_SPIN_TELEMETRY_SHARE_LOW:{x.season}:{sshare}')
    if not warm and fshare>float(h['maximumTargetGameFetchFailureShareEachSeason']):raise SystemExit(f'V62_TARGET_FETCH_FAILURE_SHARE_HIGH:{x.season}:{fshare}')
    if warm and fshare>0.01:raise SystemExit(f'V62_WARMUP_FETCH_FAILURE_SHARE_HIGH:{fshare}')
if __name__=='__main__':main()
