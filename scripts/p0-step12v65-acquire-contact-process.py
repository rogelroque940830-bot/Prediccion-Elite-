#!/usr/bin/env python3
import argparse,json,math,os,re,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

SCHEMA='courtedge-p0-step12v65-contact-process-pbp.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v65-contact-process-matchup-winner-contract.v1'
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


def normalized_description(v):
    s=str(v or '').strip().lower()
    return re.sub(r'_+','_',re.sub(r'[^a-z0-9]+','_',s)).strip('_')


def empty_process():
    return {'pitchEvents':0,'swings':0,'whiffs':0,'battedBallEvents':0,'launchSpeedN':0,'launchSpeedSum':0.0,'hardHitN':0}


def target_rows(season,table):
    t=load(table)
    if t.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V65_BASE_SCHEMA_INVALID:{season}')
    rows=[];seen=set()
    for r in t.get('rows',[]):
        if r.get('t5PregameValid') is not True:continue
        pk=int(r['gamePk'])
        if pk in seen:raise SystemExit(f'V65_DUPLICATE_TARGET_GAME:{season}:{pk}')
        seen.add(pk);rows.append({'gamePk':pk,'officialDate':str(r['officialDate'])})
    return rows


def warmup_rows():
    p=fetch_json(SCHEDULE,'CourtEdge-Step12V65-WarmupSchedule/1.0')
    out=[];seen=set()
    for d in p.get('dates',[]):
        for g in d.get('games',[]):
            if str(g.get('gameType') or '')!='R':continue
            if str(((g.get('status') or {}).get('abstractGameState')) or '')!='Final':continue
            pk=int(g.get('gamePk') or 0);od=str(g.get('officialDate') or d.get('date') or '')
            if pk<=0 or not od or pk in seen:continue
            seen.add(pk);out.append({'gamePk':pk,'officialDate':od})
    out.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    if len(out)<2000:raise SystemExit(f'V65_WARMUP_SCHEDULE_TOO_SMALL:{len(out)}')
    return out


def acquire(row,c):
    gp=int(row['gamePk']);od=str(row['officialDate'])
    lo,hi=map(float,c['historicalContactProcessCustody']['physicalLaunchSpeedBoundsMph'])
    whiff_desc=set(c['eventDefinitions']['whiffDescriptionsNormalized'])
    foul_desc=set(c['eventDefinitions']['foulDescriptionsNormalized'])
    try:
        p=fetch_json(PBP.format(gamePk=gp),'CourtEdge-Step12V65-ContactProcess/2.0')
        plays=((p.get('liveData') or {}).get('plays') or {}).get('allPlays')
        if not isinstance(plays,list):return {'gamePk':gp,'officialDate':od,'ok':False,'error':'ALL_PLAYS_MISSING'}
        batters=defaultdict(empty_process);pitchers=defaultdict(empty_process)
        allp=swings=whiffs=batted=lsn=hard=0;excluded=Counter();desc_counts=Counter()
        for play in plays:
            m=play.get('matchup') or {}
            pid=int(((m.get('pitcher') or {}).get('id')) or 0)
            bid=int(((m.get('batter') or {}).get('id')) or 0)
            for ev in play.get('playEvents') or []:
                if not bool(ev.get('isPitch')):continue
                allp+=1
                details=ev.get('details') or {}
                desc=normalized_description(details.get('description'))
                if desc:desc_counts[desc]+=1
                hit_data=ev.get('hitData')
                is_batted=isinstance(hit_data,dict) and bool(hit_data)
                is_whiff=desc in whiff_desc
                is_foul=desc in foul_desc
                is_swing=is_whiff or is_foul or is_batted
                if pid<=0:excluded['PITCHER_ID_MISSING']+=1
                if bid<=0:excluded['BATTER_ID_MISSING']+=1
                if pid>0:pitchers[pid]['pitchEvents']+=1
                if bid>0:batters[bid]['pitchEvents']+=1
                if is_swing:
                    swings+=1
                    if pid>0:pitchers[pid]['swings']+=1
                    if bid>0:batters[bid]['swings']+=1
                if is_whiff:
                    whiffs+=1
                    if pid>0:pitchers[pid]['whiffs']+=1
                    if bid>0:batters[bid]['whiffs']+=1
                if is_batted:
                    batted+=1
                    if pid>0:pitchers[pid]['battedBallEvents']+=1
                    if bid>0:batters[bid]['battedBallEvents']+=1
                    ls=bounded(hit_data.get('launchSpeed'),lo,hi)
                    if ls is None:
                        excluded['HITDATA_LAUNCH_SPEED_MISSING_OR_INVALID']+=1
                    else:
                        lsn+=1
                        if ls>=95.0:hard+=1
                        if pid>0:
                            z=pitchers[pid];z['launchSpeedN']+=1;z['launchSpeedSum']+=ls;z['hardHitN']+=int(ls>=95.0)
                        if bid>0:
                            z=batters[bid];z['launchSpeedN']+=1;z['launchSpeedSum']+=ls;z['hardHitN']+=int(ls>=95.0)
        br=[{'batterId':k,**v} for k,v in sorted(batters.items())]
        pr=[{'pitcherId':k,**v} for k,v in sorted(pitchers.items())]
        return {'gamePk':gp,'officialDate':od,'ok':True,'pitchEvents':allp,'swings':swings,'whiffs':whiffs,'battedBallEvents':batted,'launchSpeedN':lsn,'hardHitN':hard,'normalizedPitchDescriptionCounts':dict(desc_counts),'excludedReasons':dict(excluded),'batterProcessTotals':br,'pitcherProcessTotals':pr}
    except Exception as e:return {'gamePk':gp,'officialDate':od,'ok':False,'error':str(e)[:400]}


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--season',required=True);ap.add_argument('--table');ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=6);x=ap.parse_args();c=load(x.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=2:raise SystemExit('V65_CONTRACT_INVALID')
    if c.get('scientificStatus')!='FROZEN_CONTACT_PROCESS_SOURCE_SEMANTICS_CORRECTED_BEFORE_V65_OUTCOME_SCORER':raise SystemExit('V65_CONTRACT_STATUS_INVALID')
    if x.workers<1 or x.workers>6:raise SystemExit('V65_WORKERS_INVALID')
    warm=x.season==str(c['dataBoundary']['warmupSeason']);rows=warmup_rows() if warm else target_rows(x.season,x.table)
    if not warm:
        exp=int(c['dataBoundary']['expectedRowsBySeason'][x.season])
        if len(rows)!=exp:raise SystemExit(f'V65_TARGET_ROW_COUNT_DRIFT:{x.season}:{len(rows)}:{exp}')
    games=[]
    with ThreadPoolExecutor(max_workers=x.workers) as ex:
        fut={ex.submit(acquire,r,c):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda z:(z.get('officialDate','9999'),z['gamePk']))
    good=[g for g in games if g.get('ok') is True];fail=[g for g in games if g.get('ok') is not True]
    pitch=sum(g['pitchEvents'] for g in good);sw=sum(g['swings'] for g in good);wh=sum(g['whiffs'] for g in good);bb=sum(g['battedBallEvents'] for g in good);ln=sum(g['launchSpeedN'] for g in good);hh=sum(g['hardHitN'] for g in good);excl=Counter();descs=Counter()
    for g in good:excl.update(g['excludedReasons']);descs.update(g['normalizedPitchDescriptionCounts'])
    launch_share=ln/bb if bb else 0.;fshare=len(fail)/len(rows) if rows else 1.
    out={'schemaVersion':SCHEMA,'season':x.season,'contractRevision':2,'warmupOnly':warm,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'failures':fail,'pitchEvents':pitch,'swings':sw,'whiffs':wh,'battedBallEvents':bb,'launchSpeedN':ln,'launchSpeedTelemetryShareOfHitDataBattedBallEvents':launch_share,'hardHitN':hh,'normalizedPitchDescriptionCounts':dict(descs),'excludedReasons':dict(excl),'games':good,'policy':{'sameDateOutcomeMayTrainSameDate':False,'futureGameDataAllowed':False,'containsFinalHistoricalPbpOnly':True,'targetRowsComeOnlyFromCanonicalStep12V3':not warm,'warmupRowsComeOnlyFrom2021RegularSeasonFinalSchedule':warm,'containsWinnerTarget':False,'containsPlateAppearanceOutcomeFeatures':False,'containsSportsbookPrice':False}}
    os.makedirs(os.path.dirname(x.out) or '.',exist_ok=True)
    with open(x.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':SCHEMA,'season':x.season,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'pitchEvents':pitch,'swings':sw,'whiffs':wh,'battedBallEvents':bb,'launchSpeedN':ln,'launchSpeedTelemetryShareOfHitDataBattedBallEvents':launch_share,'hardHitN':hh,'topNormalizedDescriptions':descs.most_common(12)},indent=2))
    h=c['historicalContactProcessCustody']
    if launch_share<float(h['minimumLaunchSpeedTelemetryShareOfHitDataBattedBallEventsEachSeason']):raise SystemExit(f'V65_LAUNCH_SPEED_TELEMETRY_SHARE_LOW:{x.season}:{launch_share}')
    if sw<=0 or wh<=0 or bb<=0 or ln<=0:raise SystemExit(f'V65_CONTACT_PROCESS_TELEMETRY_EMPTY:{x.season}:{sw}:{wh}:{bb}:{ln}')
    if not warm and fshare>float(h['maximumTargetGameFetchFailureShareEachSeason']):raise SystemExit(f'V65_TARGET_FETCH_FAILURE_SHARE_HIGH:{x.season}:{fshare}')
    if warm and fshare>0.01:raise SystemExit(f'V65_WARMUP_FETCH_FAILURE_SHARE_HIGH:{fshare}')

if __name__=='__main__':main()
