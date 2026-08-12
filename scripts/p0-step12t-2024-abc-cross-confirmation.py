#!/usr/bin/env python3
import argparse, json, math, os

SCHEMA='courtedge-p0-step12t-2024-external-confirmation.v1'
MANIFEST_SCHEMA='courtedge-p0-step12t-abc-cross-signals-frozen.v1'
MATRIX_SCHEMA='courtedge-p0-step12n-multimarket-target-matrix.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def atom_ok(r,a):
    v=r.get(a['feature'])
    if v is None:return False
    try:v=float(v); t=float(a['threshold'])
    except Exception:return False
    if not math.isfinite(v):return False
    op=a['operator']
    return {'GTE':v>=t,'LTE':v<=t,'GT':v>t,'LT':v<t}[op]

def selected(rows,rule):
    return [r for r in rows if all(atom_ok(r,a) for a in rule['atoms'])]

def outcome(r,target):
    parts=target.split(':')
    if parts[1]=='RESULT':
        val=r['targets'][f'{parts[0]}:RESULT']
        if val=='TIE':return None
        return 1 if val==parts[2] else 0
    val=r['targets'][target]
    return 1 if val=='WIN' else 0

def metric(rows,rule):
    ss=selected(rows,rule); vals=[(r,outcome(r,rule['target'])) for r in ss]
    dec=[(r,y) for r,y in vals if y is not None]
    w=sum(y for _,y in dec); n=len(dec)
    return {'selectedRows':len(ss),'decisiveRows':n,'wins':w,'losses':n-w,'pushes':len(ss)-n,
            'decisiveDates':len({r['officialDate'] for r,_ in dec}),
            'hitRate':w/n if n else None}

def target_baseline(rows,target):
    vals=[outcome(r,target) for r in rows]; vals=[y for y in vals if y is not None]
    w=sum(vals); n=len(vals)
    return {'decisiveRows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None}

def binom_upper(k,n,p):
    if n<=0 or p is None:return None
    if p<=0:return 0.0 if k>0 else 1.0
    if p>=1:return 1.0
    logs=[]
    for i in range(k,n+1):
        logs.append(math.lgamma(n+1)-math.lgamma(i+1)-math.lgamma(n-i+1)+i*math.log(p)+(n-i)*math.log1p(-p))
    m=max(logs)
    return min(1.0, math.exp(m)*sum(math.exp(x-m) for x in logs))

def holm_adjust(items):
    ordered=sorted(items,key=lambda x:x[1]); out={}; running=0.0; m=len(ordered)
    for i,(rid,p) in enumerate(ordered):
        adj=min(1.0,(m-i)*p); running=max(running,adj); out[rid]=running
    return out

def leave_one_month_lift(rows,rule,parent):
    months=sorted({r['officialDate'][:7] for r in rows}); vals=[]
    for mo in months:
        sub=[r for r in rows if r['officialDate'][:7]!=mo]
        cm=metric(sub,rule); pm=metric(sub,parent)
        if cm['hitRate'] is not None and pm['hitRate'] is not None:vals.append(cm['hitRate']-pm['hitRate'])
    return min(vals) if vals else None

def route_metric(rows,rules_by_id,portfolio):
    routed=[]; conflicts=[]
    for r in rows:
        hits=[]
        for route in portfolio['routes']:
            rule=rules_by_id[route['ruleId']]
            if all(atom_ok(r,a) for a in rule['atoms']):hits.append(rule)
        if len(hits)>1:
            conflicts.append({'gamePk':r['gamePk'],'ruleIds':[x['id'] for x in hits]});continue
        if not hits:continue
        rule=hits[0]; routed.append((r,rule,outcome(r,rule['target'])))
    dec=[x for x in routed if x[2] is not None]; w=sum(x[2] for x in dec); n=len(dec)
    return {'selectedRows':len(routed),'decisiveRows':n,'wins':w,'losses':n-w,'pushes':len(routed)-n,
            'hitRate':w/n if n else None,'conflictCount':len(conflicts),'conflicts':conflicts[:10]}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--manifest',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args(); matrix=load(a.matrix); man=load(a.manifest)
    if matrix.get('schemaVersion')!=MATRIX_SCHEMA:raise SystemExit('STEP12T_MATRIX_SCHEMA_INVALID')
    if man.get('schemaVersion')!=MANIFEST_SCHEMA:raise SystemExit('STEP12T_MANIFEST_SCHEMA_INVALID')
    sel=man['selectionHistory']; pol=man['external2024Policy']
    if sel['externalJudge']!='2024_FULL_REGULAR_SEASON_CLEAN_T5_REBUILD':raise SystemExit('STEP12T_2024_JUDGE_NOT_FROZEN')
    if sel['legacy2024SportingOutcomesScoredForTheseCandidatesBeforeFreeze'] is not False:raise SystemExit('STEP12T_2024_NOT_VIRGIN')
    if sel['thresholdRetuningAllowedAfterFreeze'] is not False or sel['candidateSearchAllowedIn2024'] is not False:raise SystemExit('STEP12T_RETUNE_OR_SEARCH_FORBIDDEN')
    rows=matrix['rows']; parents={r['id']:r for r in man['parentRules']}; cands={r['id']:r for r in man['frozenCandidates']}
    if len(cands)!=pol['candidateCountForMultiplicity']:raise SystemExit('STEP12T_CANDIDATE_COUNT_MISMATCH')
    parent_metrics={rid:metric(rows,r) for rid,r in parents.items()}
    baselines={t:target_baseline(rows,t) for t in sorted({r['target'] for r in list(parents.values())+list(cands.values())})}
    results=[]; raw=[]
    for rid,r in cands.items():
        m=metric(rows,r); pm=parent_metrics[r['parent']]; base=baselines[r['target']]
        lift=(m['hitRate']-pm['hitRate']) if m['hitRate'] is not None and pm['hitRate'] is not None else None
        p=binom_upper(m['wins'],m['decisiveRows'],base['hitRate'])
        lom=leave_one_month_lift(rows,r,parents[r['parent']])
        rec={**m,'id':rid,'parent':r['parent'],'target':r['target'],'role':r['role'],
             'parentHitRate':pm['hitRate'],'liftVsParent':lift,'targetBaselineHitRate':base['hitRate'],
             'rawOneSidedBinomialPVsTargetBaseline':p,'minLeaveOneMonthOutLiftVsParent':lom,
             'countRatioVsParent':m['decisiveRows']/pm['decisiveRows'] if pm['decisiveRows'] else None}
        results.append(rec); raw.append((rid,p if p is not None else 1.0))
    adj=holm_adjust(raw)
    for rec in results:
        rec['holmAdjustedP']=adj[rec['id']]
        rec['formalSupportChecks']={
          'minimumRows':rec['decisiveRows']>=pol['minimumDecisiveRowsForFormalSupport'],
          'minimumDates':rec['decisiveDates']>=pol['minimumDecisiveDatesForFormalSupport'],
          'positiveVsParent':rec['liftVsParent'] is not None and rec['liftVsParent']>0,
          'positiveLeaveOneMonthOut':rec['minLeaveOneMonthOutLiftVsParent'] is not None and rec['minLeaveOneMonthOutLiftVsParent']>0,
          'familywiseSignificanceVsTargetBaseline':rec['holmAdjustedP']<=pol['holmAlpha']
        }
        rec['classification']='EXTERNAL_SUPPORTED_CANDIDATE' if all(rec['formalSupportChecks'].values()) else 'NOT_FORMALLY_SUPPORTED_2024'
    rules={**parents,**cands}; portfolios={}
    for p in man['portfolios']:
        pm=route_metric(rows,rules,p)
        if p.get('mutualExclusivityExpected') and pm['conflictCount']!=0:raise SystemExit('STEP12T_PORTFOLIO_CONFLICT:'+p['id'])
        portfolios[p['id']]={**pm,'role':p['role'],'mixedTargetsNoPriceClaim':True}
    report={'schemaVersion':SCHEMA,'evidenceStatus':'EXTERNAL_2024_CLEAN_T5_CONFIRMATION_RESEARCH_ONLY',
            'parents':parent_metrics,'targetBaselines':baselines,'candidates':results,'portfolios':portfolios,
            'policy':{'thresholdRetuningPerformed':False,'candidateSearchPerformedIn2024':False,'historicalPricesUsed':False,
                      'historicalEvOrRoiClaimProduced':False,'liveFilterChanged':False,'betEliteProduced':False,
                      'step11cProspectiveValidationStillRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'parents':parent_metrics,'candidates':[{k:r[k] for k in ('id','decisiveRows','wins','losses','hitRate','liftVsParent','classification')} for r in results],'portfolios':portfolios},indent=2))
if __name__=='__main__':main()
