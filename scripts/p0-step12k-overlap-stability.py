#!/usr/bin/env python3
import argparse, json, math, os, random
from collections import defaultdict, deque

SCHEMA='courtedge-p0-step12k-overlap-stability.v1'
PERMUTATIONS=20000
SEED=12012026
JACCARD_CLUSTER_THRESHOLD=0.60


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def atom_ok(row,a):
    v=row.get(a['feature'])
    if v is None:return False
    try:v=float(v)
    except:return False
    if not math.isfinite(v):return False
    return v>=a['threshold'] if a['operator']=='GTE' else v<=a['threshold']

def outcome(row,h):return row['fullResult'] if h=='FULL_GAME' else row['f5Result']

def selected(rows,rule):return [r for r in rows if all(atom_ok(r,a) for a in rule['atoms'])]

def metrics(rows,rule,outcome_override=None):
    h=rule['horizon']; side=rule['side']; sel=selected(rows,rule)
    def out(r):
        if outcome_override is None:return outcome(r,h)
        return outcome_override[(h,r['gamePk'])]
    decisive=[r for r in sel if out(r)!='PUSH']; hits=sum(1 for r in decisive if out(r)==side)
    all_dec=[r for r in rows if out(r)!='PUSH']; base_hits=sum(1 for r in all_dec if out(r)==side)
    rate=hits/len(decisive) if decisive else None; base=base_hits/len(all_dec) if all_dec else None
    return {'selectedRows':len(sel),'decisiveRows':len(decisive),'hits':hits,'losses':len(decisive)-hits,
            'pushes':len(sel)-len(decisive),'decisiveHitRate':rate,'sideBaselineHitRate':base,
            'liftVsBaseline':rate-base if rate is not None and base is not None else None,
            'decisiveUniqueDates':len({r['officialDate'] for r in decisive})}

def jaccard(a,b):
    u=a|b
    return len(a&b)/len(u) if u else 1.0

def connected_components(keys,edges):
    adj={k:set() for k in keys}
    for a,b in edges:adj[a].add(b);adj[b].add(a)
    seen=set(); comps=[]
    for k in keys:
        if k in seen:continue
        q=deque([k]); seen.add(k); c=[]
        while q:
            x=q.popleft();c.append(x)
            for y in adj[x]:
                if y not in seen:seen.add(y);q.append(y)
        comps.append(sorted(c))
    return comps

def leave_one_group(rows,rule,group_fn):
    groups=sorted({group_fn(r) for r in rows})
    vals=[]
    for g in groups:
        sub=[r for r in rows if group_fn(r)!=g]
        m=metrics(sub,rule)
        vals.append({'excluded':g,'decisiveRows':m['decisiveRows'],'hitRate':m['decisiveHitRate'],'lift':m['liftVsBaseline']})
    lifts=[x['lift'] for x in vals if x['lift'] is not None]
    return {'nGroups':len(groups),'minLift':min(lifts) if lifts else None,'maxLift':max(lifts) if lifts else None,
            'allPositive':bool(lifts) and min(lifts)>0,'details':vals}

def permuted_outcomes(rows,rng):
    result={}
    for h in ('FULL_GAME','FIRST_5'):
        by_date=defaultdict(list)
        for r in rows:by_date[r['officialDate']].append(r)
        for date,grp in by_date.items():
            labels=[outcome(r,h) for r in grp]
            rng.shuffle(labels)
            for r,label in zip(grp,labels):result[(h,r['gamePk'])]=label
    return result

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--rediscovery',required=True);ap.add_argument('--feature-table',required=True);ap.add_argument('--out',required=True)
    args=ap.parse_args(); rep=load(args.rediscovery); table=load(args.feature_table)
    if rep.get('schemaVersion')!='courtedge-p0-step12j-clean-rediscovery.v1':raise SystemExit('STEP12K_REDISCOVERY_SCHEMA_INVALID')
    if table.get('schemaVersion')!='courtedge-p0-step12i-clean-t5-feature-table.v1':raise SystemExit('STEP12K_FEATURE_SCHEMA_INVALID')
    family=rep['family']
    if len(family)!=20:raise SystemExit(f'STEP12K_FAMILY_SIZE_INVALID:{len(family)}')
    cutoff=rep['split']['discoveryEndDate']; rows=[r for r in table['rows'] if r['officialDate']>cutoff]
    if not rows:raise SystemExit('STEP12K_EMPTY_HOLDOUT')

    # Exact selection identities and overlap. Cross-horizon overlap is allowed and informative.
    ids={f"{r['horizon']}:{r['ruleKey']}":{x['gamePk'] for x in selected(rows,r)} for r in family}
    pairs=[]; edges=[]
    keys=sorted(ids)
    for i,a in enumerate(keys):
        for b in keys[i+1:]:
            jac=jaccard(ids[a],ids[b]); inter=len(ids[a]&ids[b]); union=len(ids[a]|ids[b])
            pairs.append({'a':a,'b':b,'intersection':inter,'union':union,'jaccard':jac})
            if jac>=JACCARD_CLUSTER_THRESHOLD:edges.append((a,b))
    comps=connected_components(keys,edges)

    # Stability diagnostics. These may demote confidence but cannot certify or promote.
    stability=[]
    for rule in family:
        k=f"{rule['horizon']}:{rule['ruleKey']}"; obs=metrics(rows,rule)
        month=leave_one_group(rows,rule,lambda r:r['officialDate'][:7])
        date=leave_one_group(rows,rule,lambda r:r['officialDate'])
        stability.append({'hypothesisId':k,'observed':obs,'leaveOneMonthOut':month,'leaveOneDateOut':date})

    # Date-stratified randomization test. Within each date/horizon we shuffle the observed labels,
    # preserving that date's exact HOME/AWAY/PUSH composition. The same permutation is scored
    # against all 20 frozen rules. Westfall-Young maxT gives family-wise adjusted p-values while
    # respecting dependence/overlap among rules. No baseline is treated as known or fixed.
    obs_lifts={f"{r['horizon']}:{r['ruleKey']}":metrics(rows,r)['liftVsBaseline'] for r in family}
    exceed_raw={k:0 for k in keys}; exceed_max={k:0 for k in keys}; rng=random.Random(SEED)
    for _ in range(PERMUTATIONS):
        po=permuted_outcomes(rows,rng); vals={}
        for r in family:
            k=f"{r['horizon']}:{r['ruleKey']}"; m=metrics(rows,r,po); vals[k]=m['liftVsBaseline'] if m['liftVsBaseline'] is not None else -1.0
            if vals[k]>=obs_lifts[k]-1e-15:exceed_raw[k]+=1
        max_t=max(vals.values())
        for k in keys:
            if max_t>=obs_lifts[k]-1e-15:exceed_max[k]+=1
    inference=[]
    for k in keys:
        raw=(exceed_raw[k]+1)/(PERMUTATIONS+1); adj=(exceed_max[k]+1)/(PERMUTATIONS+1)
        inference.append({'hypothesisId':k,'observedLift':obs_lifts[k],'randomizationPValue':raw,
                          'westfallYoungMaxTAdjustedPValue':adj,'familyWiseAlpha':0.05,
                          'familyWiseSupported':adj<=0.05})

    report={'schemaVersion':SCHEMA,'evidenceStatus':'DIAGNOSTIC_ONLY_NO_CERTIFICATION_NO_BET_ELITE',
      'source':{'rediscoveryFamilySize':len(family),'holdoutRows':len(rows),'discoveryEndDate':cutoff},
      'overlap':{'jaccardClusterThreshold':JACCARD_CLUSTER_THRESHOLD,'pairwise':pairs,'components':comps,
                 'componentCount':len(comps),'largestComponentSize':max(map(len,comps)) if comps else 0},
      'stability':stability,
      'multiplicity':{'method':'DATE_STRATIFIED_RANDOMIZATION_WITH_WESTFALL_YOUNG_MAXT','permutations':PERMUTATIONS,
                      'seed':SEED,'familySize':len(family),'results':inference},
      'policy':{'diagnosticOnly':True,'holdoutUsedForRetuning':False,'thresholdMutationAllowed':False,
                'candidateMutationAllowed':False,'automaticPromotionAllowed':False,'betEliteProduced':False,
                'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,'stakeCalculated':False,
                'automaticBetPlacement':False}}
    os.makedirs(os.path.dirname(args.out) or '.',exist_ok=True)
    with open(args.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'components':len(comps),'largestComponent':report['overlap']['largestComponentSize'],
                      'familyWiseSupported':sum(1 for x in inference if x['familyWiseSupported'])},indent=2))
if __name__=='__main__':main()
