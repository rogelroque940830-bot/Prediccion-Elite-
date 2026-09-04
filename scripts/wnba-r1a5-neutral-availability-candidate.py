#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

CONTRACT=Path('research/wnba/WNBA_R1A5_NEUTRAL_AVAILABILITY_CANDIDATE_FREEZE.json')
D3_SCRIPT=Path('scripts/wnba-r1a4d3-travel-enriched-prefix.py')
D3_ROWS=Path('wnba-r1a4d3-travel-enriched-prefix-rowset.jsonl')
OUT_ROWS=Path('wnba-r1a5-neutral-availability-candidate-rowset.jsonl')
OUT_EVIDENCE=Path('wnba-r1a5-neutral-availability-evidence.json')
PARENT_CANDIDATE='SPORTS_ONLY_FALLBACK_ASOF_V1'
NEW_CANDIDATE='SPORTS_ONLY_FALLBACK_TRAVEL_NEUTRAL_AVAILABILITY_V1'


def restore_parent(row:dict[str,Any])->dict[str,Any]:
    x=copy.deepcopy(row)
    x.pop('availabilityPolicy',None)
    x['candidate']=PARENT_CANDIDATE
    for side in ('home','away'):
        x[side]['injuryAdj']=None
        x[side]['injuryStatus']='UNKNOWN_NOT_ZERO'
        x[side]['manualAdjustment']=None
        x[side]['manualStatus']='NO_HISTORICAL_LOG'
    return x


def main()->None:
    contract=json.loads(CONTRACT.read_text())
    expected_sha=contract['empirical_gate']['r1a4d3_sha256_must_reproduce']
    expected_rows=int(contract['empirical_gate']['rows'])

    proc=subprocess.run([sys.executable,str(D3_SCRIPT)],capture_output=True,text=True,env=os.environ.copy())
    if proc.returncode!=0:
        OUT_EVIDENCE.write_text(json.dumps({'name':'WNBA_R1A5_OPERATIONAL_FAILURE','decision':'CANDIDATE_NOT_FROZEN','parent_constructor_failed':True,'stderr':proc.stderr[-4000:],'r1b_outcome_opening_authorized':False},indent=2)+'\n')
        raise SystemExit(proc.returncode)

    parent_bytes=D3_ROWS.read_bytes(); parent_sha=hashlib.sha256(parent_bytes).hexdigest()
    parent_lines=[ln for ln in parent_bytes.splitlines() if ln.strip()]
    if parent_sha!=expected_sha or len(parent_lines)!=expected_rows:
        OUT_EVIDENCE.write_text(json.dumps({'name':'WNBA_R1A5_PARENT_DRIFT','decision':'CANDIDATE_NOT_FROZEN','parent_sha256':parent_sha,'expected_sha256':expected_sha,'parent_rows':len(parent_lines),'expected_rows':expected_rows,'r1b_outcome_opening_authorized':False},indent=2)+'\n')
        raise SystemExit(2)

    parent_rows=[json.loads(ln) for ln in parent_lines]
    candidate_rows=[]; nonavailability_mutations=0; duplicates=0; seen=set(); travel_ready=0; outcomes=0; markets=0; special=0
    special_ids={'401341447','401353913','401455978','401430112','401558893','401507376','401620458','401677672','401781604','401736430'}
    for p in parent_rows:
        gid=str(p['gameId'])
        if gid in seen: duplicates+=1
        seen.add(gid)
        if gid in special_ids: special+=1
        x=copy.deepcopy(p)
        x['candidate']=NEW_CANDIDATE
        x['availabilityPolicy']='NEUTRAL_FEATURE_OMISSION_V1'
        for side in ('home','away'):
            x[side]['injuryAdj']=0.0
            x[side]['injuryStatus']='OMITTED_BY_PREREGISTERED_CANDIDATE'
            x[side]['manualAdjustment']=0.0
            x[side]['manualStatus']='OMITTED_BY_PREREGISTERED_CANDIDATE'
        if restore_parent(x)!=p: nonavailability_mutations+=1
        if x['home'].get('travelStatus')=='DEPLOYED_COORDINATE_EXACT' and x['away'].get('travelStatus')=='DEPLOYED_COORDINATE_EXACT': travel_ready+=1
        if bool(x.get('targetOutcomeAttached')): outcomes+=1
        if bool(x.get('marketAttached')): markets+=1
        candidate_rows.append(x)

    canonical=''.join(json.dumps(r,sort_keys=True,separators=(',',':'))+'\n' for r in candidate_rows).encode()
    OUT_ROWS.write_bytes(canonical); out_sha=hashlib.sha256(canonical).hexdigest()
    gates={
      'parent_sha256_matches':parent_sha==expected_sha,'parent_rows':len(parent_rows),'candidate_rows':len(candidate_rows),'non_availability_mutation_count':nonavailability_mutations,
      'travel_ready_rows':travel_ready,'target_outcome_fields':outcomes,'market_attached_rows':markets,'special_event_rows':special,'duplicate_game_ids':duplicates,
      'all_injury_values_explicit_neutral_omission':sum(1 for r in candidate_rows for s in ('home','away') if r[s].get('injuryAdj')==0.0 and r[s].get('injuryStatus')=='OMITTED_BY_PREREGISTERED_CANDIDATE'),
      'all_manual_values_explicit_neutral_omission':sum(1 for r in candidate_rows for s in ('home','away') if r[s].get('manualAdjustment')==0.0 and r[s].get('manualStatus')=='OMITTED_BY_PREREGISTERED_CANDIDATE')
    }
    passed=all([parent_sha==expected_sha,len(parent_rows)==expected_rows,len(candidate_rows)==expected_rows,nonavailability_mutations==0,travel_ready==expected_rows,outcomes==0,markets==0,special==0,duplicates==0,gates['all_injury_values_explicit_neutral_omission']==2*expected_rows,gates['all_manual_values_explicit_neutral_omission']==2*expected_rows])
    ev={
      'name':'WNBA_R1A5_NEUTRAL_AVAILABILITY_CANDIDATE_EVIDENCE_V1','decision':'FROZEN_NEUTRAL_AVAILABILITY_RESEARCH_CANDIDATE' if passed else 'CANDIDATE_NOT_FROZEN',
      'candidate':NEW_CANDIDATE,'parent_candidate':PARENT_CANDIDATE,'target_outcomes_opened':False,'market_data_consumed':False,'r1b_outcome_opening_authorized':False,
      'parent_rowset':{'sha256':parent_sha,'expected_sha256':expected_sha,'rows':len(parent_rows),'match':parent_sha==expected_sha},
      'gates':gates,'candidate_rowset':{'rows':len(candidate_rows),'bytes':len(canonical),'sha256':out_sha},
      'scientific_interpretation':{'zero_is_historical_truth_claim':False,'injury_feature_status':'OMITTED_BY_CANDIDATE_DEFINITION','manual_feature_status':'OMITTED_BY_CANDIDATE_DEFINITION','exact_product_replay':False,'ratings_changed_from_parent':False},
      'closure':{'r1a5':'PASS' if passed else 'FAIL','candidate_frozen':passed,'target_outcomes_may_be_evaluated':False,'r1b_remains_closed':True,'next_gate':'R1A6_OUTCOME_BLIND_MODEL_REPLAY_AND_PROBABILITY_ROWSET_FREEZE' if passed else 'R1A5_REPAIR'}
    }
    OUT_EVIDENCE.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n'); print(json.dumps(ev,indent=2,sort_keys=True))
    if not passed: raise SystemExit(2)

if __name__=='__main__': main()
