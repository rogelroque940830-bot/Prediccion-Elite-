#!/usr/bin/env python3
import argparse, hashlib, json, math, os, random
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

def target_outcome(r,target):
    t=r['targets']
    if target.endswith(':RESULT:HOME'):
        return 'WIN' if t[target[:-5]]=='HOME' else ('PUSH' if t[target[:-5]]=='TIE' else 'LOSS')
    if target.endswith(':RESULT:AWAY'):
        return 'WIN' if t[target[:-5]]=='AWAY' else ('PUSH' if t[target[:-5]]=='TIE' else 'LOSS')
    return t[target]

def selected(rows,rule):
    return [r for r in rows if all(atom_ok(r,a) for a in rule['atoms'])]

def jaccard(a,b):
    a=set(a);b=set(b)
    if not a and not b:return 1.0
    return len(a&b)/len(a|b) if a|b else 0.0

def zscore(h,n,p):
    if n<=0 or p<=0 or p>=1:return 0.0
    return (h-n*p)/math.sqrt(n*p*(1-p))

def leave_group_lifts(sel,target,group_key,baseline_rows):
    groups=sorted({r[group_key] for r in sel})
    vals=[]
    for g in groups:
        s=[r for r in sel if r[group_key]!=g]
        b=[r for r in baseline_rows if r[group_key]!=g]
        so=[target_outcome(r,target) for r in s];bo=[target_outcome(r,target) for r in b]
        sd=[o for o in so if o!='PUSH'];bd=[o for o in bo if o!='PUSH']
        if not sd or not bd:continue
        sr=sum(o=='WIN' for o in sd)/len(sd);br=sum(o=='WIN' for o in bd)/len(bd)
        vals.append(sr-br)
    return min(vals) if vals else None

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--discovery',required=True);ap.add_argument('--out',required=True);a=ap.parse_args()
    m=load(a.matrix);d=load(a.discovery)
    rows=m['rows'];hold=[r for r in rows if r['officialDate']>d['split']['discoveryEndDate']]
    family=d['family']
    if not hold or not family:raise SystemExit('STEP12P_INPUTS_EMPTY')
    # Month key is diagnostic only and derived from date, never used for rule selection.
    for r in hold:r['month']=r['officialDate'][:7]
    by_target=defaultdict(list)
    for r in hold:
        for t in d['searchContract']['targets']:
            o=target_outcome(r,t)
            if o!='PUSH':by_target[t].append((r,o))
    audits=[];sel_ids=[]
    for rule in family:
        s=selected(hold,rule);ids=[r['gamePk'] for r in s];sel_ids.append(ids)
        outs=[target_outcome(r,rule['target']) for r in s];dec=[o for o in outs if o!='PUSH'];h=sum(o=='WIN' for o in dec)
        base=[o for _,o in by_target[rule['target']]];p=sum(o=='WIN' for o in base)/len(base) if base else 0.5
        audits.append({'ruleKey':rule['ruleKey'],'target':rule['target'],'atoms':rule['atoms'],'selectedRows':len(s),'decisiveRows':len(dec),'hits':h,'losses':len(dec)-h,'pushes':len(outs)-len(dec),'hitRate':h/len(dec) if dec else None,'baseline':p,'lift':h/len(dec)-p if dec else None,'zObserved':zscore(h,len(dec),p),'uniqueDates':len({r['officialDate'] for r in s}),'minLeaveOneDateLift':leave_group_lifts(s,rule['target'],'officialDate',hold),'minLeaveOneMonthLift':leave_group_lifts(s,rule['target'],'month',hold)})
    # Overlap graph: same-game selection overlap, independent of outcome labels/market line.
    edges=[]
    parent=list(range(len(family)))
    def find(x):
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    def union(x,y):
        x,y=find(x),find(y)
        if x!=y:parent[y]=x
    for i in range(len(family)):
        for j in range(i+1,len(family)):
            jac=jaccard(sel_ids[i],sel_ids[j])
            if jac>=JACCARD_CLUSTER_THRESHOLD:
                union(i,j);edges.append({'a':family[i]['ruleKey'],'b':family[j]['ruleKey'],'jaccard':jac})
    clusters=defaultdict(list)
    for i,r in enumerate(family):clusters[find(i)].append(r['ruleKey'])
    # Date-clustered randomization. Within each date and target, shuffle WIN/LOSS labels among decisive rows.
    rng=random.Random(SEED);exceed=[0]*len(family);max_exceed=[0]*len(family)
    # Precompute decisive selected indices by rule and target/date pools.
    row_index={id(r):i for i,r in enumerate(hold)}
    rule_indices=[]
    for rule in family:
        rule_indices.append([row_index[id(r)] for r in selected(hold,rule) if target_outcome(r,rule['target'])!='PUSH'])
    target_date=defaultdict(lambda:defaultdict(list))
    for t in d['searchContract']['targets']:
        for idx,r in enumerate(hold):
            o=target_outcome(r,t)
            if o!='PUSH':target_date[t][r['officialDate']].append((idx,1 if o=='WIN' else 0))
    for _ in range(PERMUTATIONS):
        perm_by_target={}
        for t,dates in target_date.items():
            labels={}
            for date,pairs in dates.items():
                vals=[v for _,v in pairs];rng.shuffle(vals)
                for (idx,_),v in zip(pairs,vals):labels[idx]=v
            perm_by_target[t]=labels
        zs=[]
        for k,rule in enumerate(family):
            idxs=rule_indices[k];h=sum(perm_by_target[rule['target']][idx] for idx in idxs);p=audits[k]['baseline'];z=zscore(h,len(idxs),p);zs.append(z)
            if z>=audits[k]['zObserved']-1e-12:exceed[k]+=1
        mx=max(zs) if zs else 0
        for k in range(len(family)):
            if mx>=audits[k]['zObserved']-1e-12:max_exceed[k]+=1
    for k,aud in enumerate(audits):
        aud['pRandomization']=(exceed[k]+1)/(PERMUTATIONS+1)
        aud['pWestfallYoungMaxT']=(max_exceed[k]+1)/(PERMUTATIONS+1)
        aud['familywise05']=aud['pWestfallYoungMaxT']<=0.05
        aud['stablePositiveLift']=aud['lift'] is not None and aud['lift']>0 and (aud['minLeaveOneDateLift'] is None or aud['minLeaveOneDateLift']>0) and (aud['minLeaveOneMonthLift'] is None or aud['minLeaveOneMonthLift']>0)
    survivors=[a for a in audits if a['familywise05'] and a['stablePositiveLift']]
    report={'schemaVersion':SCHEMA,'evidenceStatus':'MULTIMARKET_FAMILYWISE_AUDIT_RESEARCH_ONLY_NO_CERTIFICATION','permutations':PERMUTATIONS,'seed':SEED,'jaccardClusterThreshold':JACCARD_CLUSTER_THRESHOLD,'familySize':len(family),'clusterCount':len(clusters),'clusters':list(clusters.values()),'highOverlapEdges':edges,'rules':audits,'survivors':survivors,'policy':{'thresholdRetuning':False,'holdoutSelection':False,'historicalPricesUsed':False,'betEliteProduced':False,'livePickFiltersChanged':False}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'familySize':len(family),'clusters':len(clusters),'survivors':len(survivors)},indent=2))
if __name__=='__main__':main()
