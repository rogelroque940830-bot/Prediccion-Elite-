#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

PACK_SCHEMA='courtedge-p0-step12v62-pitch-quality-pbp.v1'
AUDIT_SCHEMA='courtedge-p0-step12h-t5-starter-identity-audit.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--cohort-root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int,default=4);a=ap.parse_args()
    if a.workers<1 or a.workers>6:raise SystemExit('V68_GAP_QUALITY_WORKERS_INVALID')
    c=load(a.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v62-pitch-quality-winner-contract.v1' or int(c.get('contractRevision',0))!=2:raise SystemExit('V68_GAP_QUALITY_V62_CONTRACT_INVALID')
    audit=load(os.path.join(a.cohort_root,'t5-starter-identity-audit.json'))
    if audit.get('schemaVersion')!=AUDIT_SCHEMA:raise SystemExit('V68_GAP_QUALITY_AUDIT_SCHEMA_INVALID')
    rows=[];seen=set()
    for r in audit.get('rows',[]):
        if not (r.get('identityOk') and r.get('sourceHistorical') and r.get('pregame') and r.get('lineupComplete')):continue
        gp=int(r['gamePk'])
        if gp in seen:raise SystemExit(f'V68_GAP_QUALITY_DUPLICATE:{gp}')
        seen.add(gp);rows.append({'gamePk':gp,'officialDate':str(r['officialDate'])})
    rows.sort(key=lambda x:(x['officialDate'],x['gamePk']))
    v62a=module('scripts/p0-step12v62-acquire-pitch-quality.py','v62acq')
    recognized=set(c['recognizedPitchTypes']);games=[]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        fut={ex.submit(v62a.acquire,r,c,recognized):r['gamePk'] for r in rows}
        for f in as_completed(fut):games.append(f.result())
    games.sort(key=lambda z:(z.get('officialDate','9999'),z['gamePk']))
    good=[g for g in games if g.get('ok') is True];fail=[g for g in games if g.get('ok') is not True]
    allp=sum(g['allPitchEvents'] for g in good);recp=sum(g['recognizedPitchEvents'] for g in good);veln=sum(g['velocityTelemetryPitchEvents'] for g in good);spinn=sum(g['spinTelemetryPitchEvents'] for g in good);terminal=sum(g['terminalPaWithRecognizedPitchType'] for g in good);pt=Counter();excl=Counter()
    for g in good:pt.update(g['pitchTypeCounts']);excl.update(g['excludedReasons'])
    share=recp/allp if allp else 1.0;vshare=veln/recp if recp else 1.0;sshare=spinn/recp if recp else 1.0;fshare=len(fail)/len(rows) if rows else 0.0
    out={'schemaVersion':PACK_SCHEMA,'season':'2026_V68_GAP','warmupOnly':False,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'failures':fail,'allPitchEvents':allp,'recognizedPitchEvents':recp,'recognizedPitchTypeShare':share,'velocityTelemetryPitchEvents':veln,'velocityTelemetryShare':vshare,'spinTelemetryPitchEvents':spinn,'spinTelemetryShare':sshare,'terminalPaWithRecognizedPitchType':terminal,'pitchTypeCounts':dict(pt),'excludedReasons':dict(excl),'games':good,'policy':{'sameDateOutcomeMayTrainSameDate':False,'futureGameDataAllowed':False,'containsFinalHistoricalPbpOnly':True,'targetRowsComeOnlyFromCanonicalStep12V3Equivalent':True,'canonicalDefinition':'IDENTITY_OK_AND_SOURCE_HISTORICAL_AND_PREGAME_AND_LINEUP_COMPLETE','frozenV62ParserAndWhiffSemanticsReused':True,'researchOnly':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(out,f,sort_keys=True,separators=(',',':'));f.write('\n')
    print(json.dumps({'schemaVersion':PACK_SCHEMA,'gamesExpected':len(rows),'gamesFetched':len(good),'failureShare':fshare,'recognizedPitchTypeShare':share,'velocityTelemetryShare':vshare,'spinTelemetryShare':sshare},indent=2))
    h=c['historicalPitchTelemetryCustody']
    if fshare>float(h['maximumTargetGameFetchFailureShareEachSeason']):raise SystemExit(f'V68_GAP_QUALITY_FETCH_FAILURE_SHARE_HIGH:{fshare}')
    if rows and share<float(h['minimumRecognizedPitchTypeShareEachSeason']):raise SystemExit(f'V68_GAP_QUALITY_PITCH_SHARE_LOW:{share}')
    if rows and vshare<float(h['minimumVelocityTelemetryShareEachSeason']):raise SystemExit(f'V68_GAP_QUALITY_VELOCITY_SHARE_LOW:{vshare}')
    if rows and sshare<float(h['minimumSpinTelemetryShareEachSeason']):raise SystemExit(f'V68_GAP_QUALITY_SPIN_SHARE_LOW:{sshare}')

if __name__=='__main__':main()
