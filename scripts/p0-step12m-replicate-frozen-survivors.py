#!/usr/bin/env python3
import argparse,json,math,os

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def atom_ok(row,a):
    v=row.get(a['feature'])
    if v is None:return False
    try:v=float(v)
    except:return False
    if not math.isfinite(v):return False
    return v>=a['threshold'] if a['operator']=='GTE' else v<=a['threshold']
def outcome(row,h):
    return row['fullResult'] if h=='FULL_GAME' else row['f5Result']
def metrics(rows,rule):
    sel=[r for r in rows if all(atom_ok(r,a) for a in rule['atoms'])]
    dec=[r for r in sel if outcome(r,rule['horizon'])!='PUSH']
    hits=sum(1 for r in dec if outcome(r,rule['horizon'])==rule['side'])
    all_dec=[r for r in rows if outcome(r,rule['horizon'])!='PUSH']
    base_hits=sum(1 for r in all_dec if outcome(r,rule['horizon'])==rule['side'])
    base=base_hits/len(all_dec) if all_dec else None
    rate=hits/len(dec) if dec else None
    return {'selectedRows':len(sel),'decisiveRows':len(dec),'hits':hits,'losses':len(dec)-hits,'pushes':len(sel)-len(dec),'decisiveHitRate':rate,'sideBaselineHitRate':base,'liftVsBaseline':None if rate is None or base is None else rate-base,'selectedUniqueDates':len({r['officialDate'] for r in sel}),'decisiveUniqueDates':len({r['officialDate'] for r in dec}),'retentionPct':100*len(sel)/len(rows) if rows else 0}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--feature-table',required=True);ap.add_argument('--manifest',required=True);ap.add_argument('--season',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();table=load(a.feature_table);man=load(a.manifest)
    if table.get('schemaVersion')!='courtedge-p0-step12i-clean-t5-feature-table.v1':raise SystemExit('STEP12M_FEATURE_SCHEMA_INVALID')
    if man.get('schemaVersion')!='courtedge-p0-step12m-frozen-survivors.v1':raise SystemExit('STEP12M_MANIFEST_SCHEMA_INVALID')
    if man['policy'].get('thresholdRetuningAllowed') or man['policy'].get('candidateSearchAllowed'):raise SystemExit('STEP12M_RETUNING_FORBIDDEN')
    rows=table['rows']; results=[]
    for rule in man['rules']:
        m=metrics(rows,rule)
        results.append({'hypothesisId':rule['hypothesisId'],'structuralFamily':rule['structuralFamily'],'horizon':rule['horizon'],'side':rule['side'],'atoms':rule['atoms'],'metrics':m,'classification':'REPLICATION_POSITIVE_DIRECTION' if (m['liftVsBaseline'] or 0)>0 else 'REPLICATION_NONPOSITIVE_DIRECTION'})
    report={'schemaVersion':'courtedge-p0-step12m-frozen-replication.v1','season':a.season,'evidenceStatus':'REPLICATION_DIAGNOSTIC_ONLY_NO_BET_ELITE','rulesFrozenBeforeSeasonEvaluation':True,'familyCountInterpretation':3,'ruleCount':len(results),'results':results,'policy':{'thresholdRetuningPerformed':False,'candidateSearchPerformed':False,'historicalPricesUsed':False,'historicalEvClaimProduced':False,'betEliteProduced':False,'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,'automaticBetPlacement':False}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'season':a.season,'results':[{r['hypothesisId']:r['metrics']} for r in results]},indent=2))
if __name__=='__main__':main()
