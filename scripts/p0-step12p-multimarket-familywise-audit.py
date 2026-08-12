#!/usr/bin/env python3
import argparse, json, math, os, random
from collections import defaultdict

SCHEMA='courtedge-p0-step12p-multimarket-familywise-audit.v1'
PERMUTATIONS=20000
SEED=120016
JACCARD_CLUSTER_THRESHOLD=0.70


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def atom_ok(r,a):
    v=r.get(a['feature'])
    if v is None or not math.isfinite(float(v)):return False
    return float(v)>=a['threshold'] if a['operator']=='GTE' else float(v)<=a['threshold']

def target_outcome_from_targets(t,target):
    if target.endswith(':RESULT:HOME'):
        key=target[:-5]
        return 'WIN' if t[key]=='HOME' else ('PUSH' if t[key]=='TIE' else 'LOSS')
    if target.endswith(':RESULT:AWAY'):
        key=target[:-5]
        return 'WIN' if t[key]=='AWAY' else ('PUSH' if t[key]=='TIE' else 'LOSS')
    return t[target]

def target_outcome(r,target):
    return target_outcome_from_targets(r['targets'],target)

def selected_indices(rows,rule):
    return [i for i,r in enumerate(rows) if all(atom_ok(r,a) for a in rule['atoms'])]

def jaccard(a,b):
    a=set(a);b=set(b)
    if not a and not b:return 1.0
    return len(a&b)/len(a|b) if a|b else 0.0

def zscore(h,n,p):
    if n<=0 or p<=0 or p>=1:return 0.0
    return (h-n*p)/math.sqrt(n*p*(1-p))

def metrics_from_indices(rows,idxs,target,target_vectors=None):
    outs=[]
    for idx in idxs:
        t=(target_vectors[idx] if target_vectors is not None else rows[idx]['targets'])
        outs.append(target_outcome_from_targets(t,target))
    dec=[o for o in outs if o!='PUSH']
    hits=sum(o=='WIN' for o in dec)
    return {'selectedRows':len(idxs),'decisiveRows':len(dec),'hits':hits,'losses':len(dec)-hits,'pushes':len(outs)-len(dec),'hitRate':hits/len(dec) if dec else None}

def baseline(rows,target):
    outs=[target_outcome(r,target) for r in rows]
    dec=[o for o in outs if o!='PUSH']
    return sum(o=='WIN' for o in dec)/len(dec) if dec else None

def leave_group_lifts(rows,idxs,target,group_key):
    selected_groups=sorted({rows[i][group_key] for i in idxs})
    vals=[]
    for g in selected_groups:
        sidx=[i for i in idxs if rows[i][group_key]!=g]
        brow=[r for r in rows if r[group_key]!=g]
        sm=metrics_from_indices(rows,sidx,target)
        bp=baseline(brow,target)
        if sm['decisiveRows'] and bp is not None:
            vals.append(sm['hitRate']-bp)
    return min(vals) if vals else None

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--discovery',required=True);ap.add_argument('--out',required=True);a=ap.parse_args()
    m=load(a.matrix);d=load(a.discovery)
    rows=[dict(r) for r in m['rows'] if r['officialDate']>d['split']['discoveryEndDate']]
    family=d['family']
    if not rows or not family:raise SystemExit('STEP12P_INPUTS_EMPTY')
    for r in rows:r['month']=r['officialDate'][:7]

    targets=d['searchContract']['targets']
    baselines={t:baseline(rows,t) for t in targets}
    rule_indices=[];audits=[];selection_game_pks=[]
    for rule in family:
        idxs=selected_indices(rows,rule);rule_indices.append(idxs);selection_game_pks.append([rows[i]['gamePk'] for i in idxs])
        mtr=metrics_from_indices(rows,idxs,rule['target']);p=baselines[rule['target']]
        hit=mtr['hitRate'];lift=(hit-p) if hit is not None and p is not None else None
        audits.append({
            'ruleKey':rule['ruleKey'],'target':rule['target'],'atoms':rule['atoms'],'atomCount':len(rule['atoms']),
            **mtr,'baseline':p,'lift':lift,'zObserved':zscore(mtr['hits'],mtr['decisiveRows'],p) if p is not None else 0.0,
            'uniqueDates':len({rows[i]['officialDate'] for i in idxs}),
            'minLeaveOneDateLift':leave_group_lifts(rows,idxs,rule['target'],'officialDate'),
            'minLeaveOneMonthLift':leave_group_lifts(rows,idxs,rule['target'],'month'),
        })

    # Cluster by same-game condition overlap, regardless of market label. This identifies
    # repeated A+B+C game states that manifest in multiple correlated markets/horizons.
    parent=list(range(len(family)));edges=[]
    def find(x):
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    def union(x,y):
        x,y=find(x),find(y)
        if x!=y:parent[y]=x
    for i in range(len(family)):
        for j in range(i+1,len(family)):
            jac=jaccard(selection_game_pks[i],selection_game_pks[j])
            if jac>=JACCARD_CLUSTER_THRESHOLD:
                union(i,j);edges.append({'a':family[i]['ruleKey'],'b':family[j]['ruleKey'],'jaccard':jac})
    clusters=defaultdict(list)
    for i,r in enumerate(family):clusters[find(i)].append(r['ruleKey'])

    # Joint date-block randomization: shuffle the ENTIRE outcome vector among games on the
    # same date. This preserves cross-market/horizon dependence (F3/F5/FG totals, winner,
    # NRFI/YRFI) and lets ties/pushes move naturally under the null.
    date_indices=defaultdict(list)
    for i,r in enumerate(rows):date_indices[r['officialDate']].append(i)
    rng=random.Random(SEED);raw_exceed=[0]*len(family);max_exceed=[0]*len(family)
    original_vectors=[r['targets'] for r in rows]
    for _ in range(PERMUTATIONS):
        perm_vectors=[None]*len(rows)
        for _,idxs in date_indices.items():
            donors=list(idxs);rng.shuffle(donors)
            for dest,src in zip(idxs,donors):perm_vectors[dest]=original_vectors[src]
        zs=[]
        for k,rule in enumerate(family):
            pm=metrics_from_indices(rows,rule_indices[k],rule['target'],perm_vectors)
            p=baselines[rule['target']]
            z=zscore(pm['hits'],pm['decisiveRows'],p) if p is not None else 0.0
            zs.append(z)
            if z>=audits[k]['zObserved']-1e-12:raw_exceed[k]+=1
        mx=max(zs) if zs else 0.0
        for k,aud in enumerate(audits):
            if mx>=aud['zObserved']-1e-12:max_exceed[k]+=1

    for k,aud in enumerate(audits):
        aud['pRandomization']=(raw_exceed[k]+1)/(PERMUTATIONS+1)
        aud['pWestfallYoungMaxT']=(max_exceed[k]+1)/(PERMUTATIONS+1)
        aud['familywise05']=aud['pWestfallYoungMaxT']<=0.05
        aud['stablePositiveLift']=bool(aud['lift'] is not None and aud['lift']>0 and (aud['minLeaveOneDateLift'] is None or aud['minLeaveOneDateLift']>0) and (aud['minLeaveOneMonthLift'] is None or aud['minLeaveOneMonthLift']>0))
        aud['survivesStep12P']=aud['familywise05'] and aud['stablePositiveLift']
    survivors=[x for x in audits if x['survivesStep12P']]

    # Summarize each latent A+B+C state across every market in which it survived.
    by_key={a['ruleKey']:a for a in audits};cluster_summaries=[]
    for keys in clusters.values():
        surv=[by_key[k] for k in keys if by_key[k]['survivesStep12P']]
        cluster_summaries.append({'ruleKeys':keys,'survivorCount':len(surv),'survivorTargets':[x['target'] for x in surv],'bestAdjustedP':min((x['pWestfallYoungMaxT'] for x in surv),default=None),'maxHitRate':max((x['hitRate'] for x in surv if x['hitRate'] is not None),default=None),'maxLift':max((x['lift'] for x in surv if x['lift'] is not None),default=None)})

    report={
        'schemaVersion':SCHEMA,'evidenceStatus':'MULTIMARKET_FAMILYWISE_AUDIT_RESEARCH_ONLY_NO_CERTIFICATION',
        'randomizationContract':{'permutations':PERMUTATIONS,'seed':SEED,'unit':'WHOLE_GAME_OUTCOME_VECTOR_WITHIN_OFFICIAL_DATE','crossMarketDependencePreserved':True,'tiesAndPushesReassignedWithOutcomeVector':True,'westfallYoungMaxTAcrossFullFrozenFamily':True},
        'permutations':PERMUTATIONS,'seed':SEED,'jaccardClusterThreshold':JACCARD_CLUSTER_THRESHOLD,
        'familySize':len(family),'clusterCount':len(clusters),'clusters':list(clusters.values()),'clusterSummaries':cluster_summaries,'highOverlapEdges':edges,'rules':audits,'survivors':survivors,
        'policy':{'thresholdRetuning':False,'holdoutSelection':False,'historicalPricesUsed':False,'betEliteProduced':False,'livePickFiltersChanged':False}
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'familySize':len(family),'clusters':len(clusters),'survivors':len(survivors)},indent=2))
if __name__=='__main__':main()
