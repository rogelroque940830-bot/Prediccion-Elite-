#!/usr/bin/env python3
import argparse,json,math,os,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v63-pitch-shape-pbp.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v63-batter-conditioned-pitch-shape-contract.v1'
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
    try:
        x=float(v)
        return x if math.isfinite(x) else None
    except:return None

def bounded(v,lo,hi):
    x=finite(v)
    return x if x is not None and lo<=x<=hi else None

def cell_index(v,w):return int(math.floor(float(v)/float(w)))

def empty_pitcher():
    return {'recognizedPitches':0,'shapeCompletePitches':0,'velocitySum':0.0,'horizontalMovementSum':0.0,'verticalMovementSum':0.0,'spinSum':0.0}

def empty_cell():
    return {'pitches':0,'swings':0,'whiffs':0,'battedBallN':0,'hardHitN':0,'pa':0,'h':0,'tb':0,'k':0,'hr':0}

def add_terminal(rec,event,c):
    rec['pa']+=1
    if event in c['eventDefinitions']['hits']:rec['h']+=1
    rec['tb']+=int(c['eventDefinitions']['totalBases'].get(event,0))
    if event in c['eventDefinitions']['strikeouts']:rec['k']+=1
    if event in c['eventDefinitions']['homeRuns']:rec['hr']+=1

def target_rows(season,table):
    t=load(table)
    if t.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V63_BASE_SCHEMA_INVALID:{season}')
    rows=[];seen=set()
    for r in t.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V63_DUPLICATE_TARGET_GAME:{season}:{pk}')
        seen.add(pk);rows.append({'gamePk':pk,'officialDate':str(r['officialDate'])})
    return rows

def warmup_rows():
    p=fetch_json(SCHEDULE,'CourtEdge-Step12V63-WarmupSchedule/1.0')
    out=[];seen=set()
    for d in p.get('dates',[]):
        for g in d.get('games',[]):
            if str(g.get('gameType') or '')!='R':continue
            if str(((g.get('status') or {}).get('abstractGameState')) or '')!='Final':continue
            pk=int(g.get('gamePk') or 0);od=str(g.get('officialDate') or d.get('date') or '')
            if pk<=0 or not od or pk in seen:continue
            seen.add(pk);out.append({'gamePk':pk,'officialDate':od})
    out.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    if len(out)<2000:raise SystemExit(f'V63_WARMUP_SCHEDULE_TOO_SMALL:{len(out)}')
    return out

def acquire(row,c,recognized):
    gp=int(row['gamePk']);od=str(row['officialDate']);bounds=c['physicalValidityBounds'];bw=c['shapeCellEngineering']['bucketWidth']
    try:
        p=fetch_json(PBP.format(gamePk=gp),'CourtEdge-Step12V63-PitchShape/1.0')
        plays=((p.get('liveData') or {}).get('plays') or {}).get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'officialDate':od,'ok':False,'error':'ALL_PLAYS_MISSING'}
        pitcher=defaultdict(empty_pitcher);cells=defaultdict(empty_cell)
        allp=recp=veln=xn=zn=spinn=shape_n=terminal=0;ptype=Counter();excluded=Counter()
        swing_desc=set(c['eventDefinitions']['swingDescriptions']);whiff_desc=set(c['eventDefinitions']['whiffDescriptions'])
        vlo,vhi=map(float,bounds['velocityMph']);xlo,xhi=map(float,bounds['horizontalMovementInches']);zlo,zhi=map(float,bounds['verticalMovementInches']);slo,shi=map(float,bounds['spinRpm']);llo,lhi=map(float,bounds['launchSpeedMph'])
        for play in plays:
            m=play.get('matchup') or {};pid=int(((m.get('pitcher') or {}).get('id')) or 0);bid=int(((m.get('batter') or {}).get('id')) or 0);last_cell=None
            for ev in play.get('playEvents') or []:
                if not bool(ev.get('isPitch')):continue
                allp+=1;details=ev.get('details') or {};pt=str(((details.get('type') or {}).get('code')) or '').strip().upper();desc=str(details.get('description') or '').strip().lower()
                if pt:ptype[pt]+=1
                if pt not in recognized:
                    excluded['UNRECOGNIZED_PITCH_TYPE']+=1;continue
                recp+=1
                if pid<=0:excluded['PITCHER_ID_MISSING']+=1
                pd=ev.get('pitchData') or {};br=pd.get('breaks') or {}
                v=bounded(pd.get('startSpeed'),vlo,vhi);xi=bounded(br.get('breakHorizontal'),xlo,xhi);zi=bounded(br.get('breakVerticalInduced'),zlo,zhi);spin=bounded(br.get('spinRate'),slo,shi)
                if v is not None:veln+=1
                if xi is not None:xn+=1
                if zi is not None:zn+=1
                if spin is not None:spinn+=1
                if pid>0:
                    pr=pitcher[(pid,pt)];pr['recognizedPitches']+=1
                if v is None or xi is None or zi is None or spin is None:
                    excluded['SHAPE_INCOMPLETE_PITCH']+=1;continue
                shape_n+=1
                if pid>0:
                    pr=pitcher[(pid,pt)];pr['shapeCompletePitches']+=1;pr['velocitySum']+=v;pr['horizontalMovementSum']+=xi;pr['verticalMovementSum']+=zi;pr['spinSum']+=spin
                if bid<=0:
                    excluded['BATTER_ID_MISSING']+=1;continue
                key=(bid,pt,cell_index(v,bw['velocityMph']),cell_index(xi,bw['horizontalMovementInches']),cell_index(zi,bw['verticalMovementInches']),cell_index(spin,bw['spinRpm']))
                z=cells[key];z['pitches']+=1
                if desc in swing_desc:z['swings']+=1
                if desc in whiff_desc:z['whiffs']+=1
                hd=ev.get('hitData') or {};ls=bounded(hd.get('launchSpeed'),llo,lhi)
                if ls is not None:
                    z['battedBallN']+=1
                    if ls>=95:z['hardHitN']+=1
                last_cell=key
            event=str(((play.get('result') or {}).get('eventType')) or '').strip()
            if event and last_cell is not None:
                terminal+=1;add_terminal(cells[last_cell],event,c)
            elif event:excluded['TERMINAL_PA_NO_SHAPE_COMPLETE_PITCH_OR_BATTER']+=1
        pr=[{'pitcherId':pid,'pitchType':pt,**v} for (pid,pt),v in sorted(pitcher.items())]
        cr=[{'batterId':bid,'pitchType':pt,'velocityBin':vb,'horizontalMovementBin':xb,'verticalMovementBin':zb,'spinBin':sb,**v} for (bid,pt,vb,xb,zb,sb),v in sorted(cells.items())]
        return {'gamePk':gp,'officialDate':od,'ok':True,'allPitchEvents':allp,'recognizedPitchEvents':recp,'velocityTelemetryPitchEvents':veln,'horizontalMovementTelemetryPitchEvents':xn,'verticalMovementTelemetryPitchEvents':zn,'spinTelemetryPitchEvents':spinn,'shapeCompletePitchEvents':shape_n,'terminalPaWithShapeCompletePitch':terminal,'pitchTypeCounts':dict(ptype),'excludedReasons':dict(excluded),'pitcherPitchTypeShapeTotals':pr,'batterShapeCellTotals':cr}
    except Exception as e:return {'gamePk':gp,'officialDate':od,'ok':False,'error':str(e)[:400]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table');ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6);x=ap.parse_args();c=load(x.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=3:raise SystemExit('V63_CONTRACT_INVALID')
    if x.workers<1 or x.workers>6:raise SystemExit('V63_WORKERS_INVALID')
    recognized=set(c['recognizedPitchTypes']);warm=x.season==str(c['dataBoundary']['warmupSeason']);rows=warmup_rows() if warm else target_rows(x.season,x.table)
    if not warm:
        exp=int(c['dataBoundary']['expectedRowsBySeason'][x.season])
        if len(rows)!=exp:raise SystemExit(f'V63_TARGET_ROW_COUNT_DRIFT:{x.season}:{len(rows)}:{exp}')
    games=[]
    with ThreadPoolExecutor(max_workers=x.workers) as ex:
        fut={ex.submit(acquire,r,c,recognized):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda z:(z.get('officialDate','9999'),z['gamePk']));good=[g for g in games if g.get('ok') is True];fail=[g for g in games if g.get('ok') is not True]
    allp=sum(g['allPitchEvents'] for g in good);recp=sum(g['recognizedPitchEvents'] for g in good);veln=sum(g['velocityTelemetryPitchEvents'] for g in good);xn=sum(g['horizontalMovementTelemetryPitchEvents'] for g in good);zn=sum(g['verticalMovementTelemetryPitchEvents'] for g in good);spinn=sum(g['spinTelemetryPitchEvents'] for g in good);shape_n=sum(g['shapeCompletePitchEvents'] for g in good);terminal=sum(g['terminalPaWithShapeCompletePitch'] for g in good);pt=Counter();excl=Counter()
    for g in good:pt.update(g['pitchTypeCounts']);excl.update(g['excludedReasons'])
    rshare=recp/allp if allp else 0.;vshare=veln/recp if recp else 0.;xshare=xn/recp if recp else 0.;zshare=zn/recp if recp else 0.;sshare=spinn/recp if recp else 0.;cshare=shape_n/recp if recp else 0.;fshare=len(fail)/len(rows) if rows else 1.
    out={'schemaVersion':SCHEMA,'season':x.season,'warmupOnly':warm,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'failures':fail,'allPitchEvents':allp,'recognizedPitchEvents':recp,'recognizedPitchTypeShare':rshare,'velocityTelemetryPitchEvents':veln,'velocityTelemetryShare':vshare,'horizontalMovementTelemetryPitchEvents':xn,'horizontalMovementTelemetryShare':xshare,'verticalMovementTelemetryPitchEvents':zn,'verticalMovementTelemetryShare':zshare,'spinTelemetryPitchEvents':spinn,'spinTelemetryShare':sshare,'shapeCompletePitchEvents':shape_n,'shapeCompleteShareOfRecognizedPitches':cshare,'terminalPaWithShapeCompletePitch':terminal,'pitchTypeCounts':dict(pt),'excludedReasons':dict(excl),'games':good,'policy':{'sameDateOutcomeMayTrainSameDate':False,'futureGameDataAllowed':False,'containsFinalHistoricalPbpOnly':True,'targetRowsComeOnlyFromCanonicalStep12V3':not warm,'warmupRowsComeOnlyFrom2021RegularSeasonFinalSchedule':warm,'containsWinnerTarget':False,'containsSportsbookPrice':False}}
    os.makedirs(os.path.dirname(x.out) or '.',exist_ok=True)
    with open(x.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':SCHEMA,'season':x.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'recognizedPitchTypeShare':rshare,'velocityTelemetryShare':vshare,'horizontalMovementTelemetryShare':xshare,'verticalMovementTelemetryShare':zshare,'spinTelemetryShare':sshare,'shapeCompleteShareOfRecognizedPitches':cshare,'terminalPaWithShapeCompletePitch':terminal},indent=2))
    h=c['historicalPitchShapeCustody']
    if rshare<float(h['minimumRecognizedPitchTypeShareEachSeason']):raise SystemExit(f'V63_RECOGNIZED_PITCH_SHARE_LOW:{x.season}:{rshare}')
    if vshare<float(h['minimumVelocityTelemetryShareEachSeason']):raise SystemExit(f'V63_VELOCITY_TELEMETRY_SHARE_LOW:{x.season}:{vshare}')
    if xshare<float(h['minimumHorizontalMovementTelemetryShareEachSeason']):raise SystemExit(f'V63_HORIZONTAL_MOVEMENT_TELEMETRY_SHARE_LOW:{x.season}:{xshare}')
    if zshare<float(h['minimumVerticalMovementTelemetryShareEachSeason']):raise SystemExit(f'V63_VERTICAL_MOVEMENT_TELEMETRY_SHARE_LOW:{x.season}:{zshare}')
    if sshare<float(h['minimumSpinTelemetryShareEachSeason']):raise SystemExit(f'V63_SPIN_TELEMETRY_SHARE_LOW:{x.season}:{sshare}')
    if cshare<float(h['minimumShapeCompleteShareOfRecognizedPitchesEachSeason']):raise SystemExit(f'V63_SHAPE_COMPLETE_SHARE_LOW:{x.season}:{cshare}')
    if not warm and fshare>float(h['maximumTargetGameFetchFailureShareEachSeason']):raise SystemExit(f'V63_TARGET_FETCH_FAILURE_SHARE_HIGH:{x.season}:{fshare}')
    if warm and fshare>0.01:raise SystemExit(f'V63_WARMUP_FETCH_FAILURE_SHARE_HIGH:{fshare}')
if __name__=='__main__':main()
