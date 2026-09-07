import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_DATE_BOUNDED_WOBA_DIFF_ANCHOR_PARITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-DateBounded-WOBA-Diff/1.0)';
const ROOT='research/mlb-r1b-v16-baseline-historical';
const SEASONS=[
  {label:'2022',year:2022,file:'c4-features-2022.jsonl'},
  {label:'2023',year:2023,file:'c4-features-2023.jsonl'},
  {label:'2024',year:2024,file:'c4-features-2024.jsonl'},
  {label:'2025',year:2025,file:'c4-features-2025.jsonl'},
  {label:'2026_YTD',year:2026,file:'c4-features-2026_YTD.jsonl'},
];
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchText(url,accept='text/csv,text/plain;q=0.9,*/*;q=0.7'){
  let last=null;
  for(let a=1;a<=4;a++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120000)});
      const text=await r.text();
      if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      return{ok:true,status:r.status,text,error:null};
    }catch(e){last=e;if(a<4)await sleep(1400*a);}
  }
  return{ok:false,status:null,text:'',error:String(last)};
}

function loadJsonl(p){
  const text=fs.readFileSync(p,'utf8');
  return{text,rows:text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))};
}
function uniqueTargets(rows){
  const byGame=new Map();
  for(const r of rows){
    const gamePk=Number(r.gamePk),officialDate=String(r.officialDate??''),generatedAt=String(r.generatedAt??'');
    if(!Number.isInteger(gamePk)||!/^\d{4}-\d{2}-\d{2}$/.test(officialDate)||!generatedAt)continue;
    if(!byGame.has(gamePk))byGame.set(gamePk,{gamePk,officialDate,generatedAt});
  }
  return[...byGame.values()];
}
function targetDateMap(rows){
  const m=new Map();
  for(const t of uniqueTargets(rows)){
    let x=m.get(t.officialDate);
    if(!x)m.set(t.officialDate,x={officialDate:t.officialDate,earliestFrozenCutoff:t.generatedAt,latestFrozenCutoff:t.generatedAt,gameCount:0});
    x.gameCount++;
    if(t.generatedAt<x.earliestFrozenCutoff)x.earliestFrozenCutoff=t.generatedAt;
    if(t.generatedAt>x.latestFrozenCutoff)x.latestFrozenCutoff=t.generatedAt;
  }
  return m;
}
function parseCdx(text){
  const j=JSON.parse(text);if(!Array.isArray(j)||j.length<1)return[];
  const[h,...rows]=j,ix=k=>h.indexOf(k);
  return rows.map(r=>({timestamp:String(r[ix('timestamp')]??''),original:String(r[ix('original')]??''),digest:String(r[ix('digest')]??''),length:String(r[ix('length')]??'')}));
}
function cdxUrl(year){
  const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);
  u.searchParams.set('url',`${PRIMARY}/leaderboard/expected_statistics*`);
  u.searchParams.set('output','json');u.searchParams.set('from',String(year));u.searchParams.set('to',String(year));
  u.searchParams.append('filter','statuscode:200');u.searchParams.set('fl','timestamp,original,digest,length');u.searchParams.set('limit','20000');
  return u.toString();
}
function dateOfTimestamp(ts){return /^\d{14}$/.test(ts)?`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`:null;}
function isoOfTimestamp(ts){return /^\d{14}$/.test(ts)?`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}.000Z`:null;}
function classifyUrl(original,year){
  try{
    const u=new URL(original);if(u.hostname!==PRIMARY||u.pathname!=='/leaderboard/expected_statistics')return null;
    const type=(u.searchParams.get('type')??'').toLowerCase(),y=Number(u.searchParams.get('year')),min=(u.searchParams.get('min')??'').toLowerCase();
    const team=u.searchParams.get('team')??'',position=u.searchParams.get('position')??'',filterType=(u.searchParams.get('filterType')??'').toLowerCase();
    if(type!=='pitcher'||y!==year||min!=='q'||team!==''||position!=='')return null;
    return{filterType,productionLikeDefaultFilter:filterType==='',bipOrDefaultFilter:filterType===''||filterType==='bip'};
  }catch{return null;}
}
function selectAnchors(captures,dateMap){
  const eligible=captures.filter(c=>{
    const d=dateMap.get(c.captureDate);return d&&c.captureIso&&c.captureIso<d.earliestFrozenCutoff;
  }).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  const byDate=[];const seen=new Set();
  for(const c of eligible){if(seen.has(c.captureDate))continue;seen.add(c.captureDate);byDate.push(c);}
  if(byDate.length<=2)return byDate;
  return[byDate[0],byDate.at(-1)];
}
function replayUrl(c){return `https://${ARCHIVE}/web/${c.timestamp}id_/${c.original}`;}
function decode(s){return s.replace(/&quot;/gi,'"').replace(/&#34;/gi,'"').replace(/&#39;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');}
function rawProp(t,key){
  const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);
  return t.match(re)?.[1]??null;
}
function strProp(t,key){const r=rawProp(t,key);if(r==null||r==='null')return null;return r.replace(/^["']|["']$/g,'');}
function numProp(t,key){const r=strProp(t,key);if(r==null)return null;const n=Number(r);return Number.isFinite(n)?n:null;}
function archiveRows(html){
  const d=decode(html),out=[];
  for(const m of d.matchAll(/\{[^{}]{80,30000}\}/g)){
    const t=m[0];if(!/(?:entity_id|player_id)/i.test(t)||!/(?:est_woba|x_woba)/i.test(t))continue;
    const playerId=numProp(t,'entity_id')??numProp(t,'player_id');if(playerId==null)continue;
    const legacy=numProp(t,'est_woba_minus_woba_diff')??numProp(t,'x_woba_diff');
    const successor=numProp(t,'woba_minus_est_woba_diff');
    const effective=Number.isFinite(legacy)?legacy:successor;
    out.push({playerId,pa:numProp(t,'pa')??numProp(t,'plate_appearances'),woba:numProp(t,'woba'),estWoba:numProp(t,'est_woba')??numProp(t,'x_woba'),legacyDiff:legacy,successorDiff:successor,effectiveDiff:effective,eraMinusXeraDiff:numProp(t,'era_minus_xera_diff')});
  }
  const byId=new Map();for(const r of out)if(!byId.has(r.playerId))byId.set(r.playerId,r);return[...byId.values()];
}
function splitCsvLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
function parseCsv(text){const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);if(!lines.length)return{headers:[],rows:[]};const headers=splitCsvLine(lines[0]).map(x=>x.trim());const rows=lines.slice(1).map(line=>{const cells=splitCsvLine(line),r={};headers.forEach((h,i)=>r[h]=cells[i]??'');return r;});return{headers,rows};}
function num(v){if(v==null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function first(row,keys){for(const k of keys)if(row[k]!=null&&row[k]!=='')return row[k];return undefined;}
function aggregateUrl(year,cutoff){
  const u=new URL(`https://${PRIMARY}/statcast_search/csv`);
  const params={all:'true',hfGT:'R|',hfSea:`${year}|`,player_type:'pitcher',group_by:'name',min_pitches:'0',min_results:'0',min_pas:'0',sort_col:'xwoba',sort_order:'desc',game_date_gt:'',game_date_lt:cutoff,chk_stats_pa:'on',chk_stats_woba:'on',chk_stats_xwoba:'on'};
  for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u.toString();
}
function aggregateRows(parsed){
  const byId=new Map();
  for(const r of parsed.rows){const id=num(first(r,['player_id','pitcher','playerid']));if(id!=null&&!byId.has(id))byId.set(id,{playerId:id,pa:num(first(r,['pa','plate_appearances'])),woba:num(first(r,['woba'])),xwoba:num(first(r,['xwoba','est_woba','estimated_woba']))});}
  return byId;
}
function prevDate(s){const d=new Date(`${s}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
function near(a,b,tol=1e-12){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol;}
function compareCandidate(arch,agg){
  let common=0,paComparable=0,paExact=0,diffComparable=0,diffExact=0,diffRounded3Exact=0,displayPairExact=0;let maxDiffError=0;const mismatches=[];
  for(const a of arch){const g=agg.get(a.playerId);if(!g)continue;common++;
    if(Number.isFinite(a.pa)&&Number.isFinite(g.pa)){paComparable++;if(a.pa===g.pa)paExact++;}
    if(Number.isFinite(a.woba)&&Number.isFinite(a.estWoba)&&Number.isFinite(g.woba)&&Number.isFinite(g.xwoba)&&near(a.woba,g.woba)&&near(a.estWoba,g.xwoba))displayPairExact++;
    if(Number.isFinite(a.effectiveDiff)&&Number.isFinite(g.woba)&&Number.isFinite(g.xwoba)){
      diffComparable++;const derived=g.woba-g.xwoba,err=Math.abs(derived-a.effectiveDiff);maxDiffError=Math.max(maxDiffError,err);if(near(derived,a.effectiveDiff))diffExact++;if(near(Math.round(derived*1000)/1000,Math.round(a.effectiveDiff*1000)/1000))diffRounded3Exact++;
      if(err>1e-12&&mismatches.length<12)mismatches.push({playerId:a.playerId,archivePa:a.pa,aggregatePa:g.pa,archiveEffectiveDiff:a.effectiveDiff,aggregateWoba:g.woba,aggregateXwoba:g.xwoba,aggregateDerivedDiff:derived,absError:err});
    }
  }
  return{commonRows:common,paComparable,paExact,paExactRate:paComparable?paExact/paComparable:0,diffComparable,diffExact,diffExactRate:diffComparable?diffExact/diffComparable:0,diffRounded3Exact,diffRounded3ExactRate:diffComparable?diffRounded3Exact/diffComparable:0,displayWobaXwobaPairExact:displayPairExact,displayWobaXwobaPairExactRate:common?displayPairExact/common:0,maxDirectDiffAbsoluteError:maxDiffError,mismatchExamples:mismatches};
}
function chooseByPa(candidates){return [...candidates].sort((a,b)=>b.check.paExact-a.check.paExact||b.check.paComparable-a.check.paComparable||b.check.commonRows-a.check.commonRows||a.cutoff.localeCompare(b.cutoff))[0];}

async function main(){
  const states=[];const sourceManifests=[];
  for(const s of SEASONS){
    const loaded=loadJsonl(path.join(ROOT,s.file)),dateMap=targetDateMap(loaded.rows);const cf=await fetchText(cdxUrl(s.year),'application/json,*/*;q=0.5');if(!cf.ok)throw new Error(`CDX:${s.year}:${cf.error}`);
    const all=parseCdx(cf.text);if(all.length>=20000)throw new Error(`CDX_LIMIT_HIT:${s.year}`);
    const captures=all.map(r=>{const k=classifyUrl(r.original,s.year);return k?{...r,...k,captureDate:dateOfTimestamp(r.timestamp),captureIso:isoOfTimestamp(r.timestamp)}:null;}).filter(Boolean);
    const anchors=selectAnchors(captures,dateMap);sourceManifests.push({season:s.label,targetFile:s.file,targetFileSha256:sha256(loaded.text),cdxRows:all.length,eligiblePregameAnchorDates:new Set(captures.filter(c=>{const d=dateMap.get(c.captureDate);return d&&c.captureIso&&c.captureIso<d.earliestFrozenCutoff;}).map(c=>c.captureDate)).size,selectedAnchors:anchors.map(a=>a.timestamp)});
    for(const a of anchors){
      const frozen=dateMap.get(a.captureDate),rf=await fetchText(replayUrl(a),'text/html,*/*;q=0.5');if(!rf.ok)throw new Error(`REPLAY:${a.timestamp}:${rf.error}`);const arch=archiveRows(rf.text);
      const cutoffs=[a.captureDate,prevDate(a.captureDate)],candidates=[];
      for(const cutoff of cutoffs){const url=aggregateUrl(s.year,cutoff),af=await fetchText(url);if(!af.ok)throw new Error(`AGG:${s.year}:${cutoff}:${af.error}`);const parsed=parseCsv(af.text),agg=aggregateRows(parsed);candidates.push({cutoff,url,sha256:sha256(af.text),headers:parsed.headers,rowCount:parsed.rows.length,check:compareCandidate(arch,agg)});}
      const chosen=chooseByPa(candidates);
      states.push({season:s.label,year:s.year,targetDate:a.captureDate,earliestFrozenCutoff:frozen.earliestFrozenCutoff,archiveTimestamp:a.timestamp,archiveCaptureIso:a.captureIso,archiveOriginal:a.original,archiveDigest:a.digest,archiveReplayUrl:replayUrl(a),archiveBodySha256:sha256(rf.text),archiveRows:arch.length,archiveRowsWithEffectiveDiff:arch.filter(r=>Number.isFinite(r.effectiveDiff)).length,archiveRowsWithEraMinusXeraDiff:arch.filter(r=>Number.isFinite(r.eraMinusXeraDiff)).length,alignmentPolicy:{candidateCutoffs:cutoffs,selectionMetric:'MAX_EXACT_PA_THEN_COMPARABLE_PA_THEN_COMMON_ROWS',productionDiffExcludedFromAlignmentSelection:true,xeraExcludedFromAlignmentSelection:true},candidates,chosenCutoff:chosen.cutoff,chosenCheck:chosen.check});
    }
  }
  const chosen=states.map(s=>s.chosenCheck),totalDiff=chosen.reduce((n,x)=>n+x.diffComparable,0),exactDiff=chosen.reduce((n,x)=>n+x.diffExact,0),round3=chosen.reduce((n,x)=>n+x.diffRounded3Exact,0),totalPa=chosen.reduce((n,x)=>n+x.paComparable,0),exactPa=chosen.reduce((n,x)=>n+x.paExact,0);
  const exactEvery=states.length>0&&chosen.every(x=>x.diffComparable>0&&x.diffExact===x.diffComparable);
  const out={schemaVersion:'courtedge-mlb-r1b-statcast-date-bounded-woba-diff-anchor-parity-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',productionAuthority:{contract:'research/mlb-r1b-statcast-quality-production-semantics-contract.json',runsDeltaExpectedStatsField:'est_woba_minus_woba_diff',testedSemanticIdentity:'ARCHIVED_PRIMARY_EFFECTIVE_DIFF_VS_DATE_BOUNDED_AGGREGATE_WOBA_MINUS_XWOBA'},sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherRowsUsedAsSemanticAnchors:true,dateBoundedAggregateHostIsPrimaryPublisher:true},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,alignmentUsesPaOnly:true,noPromotionFromAnchorSample:true,qualifierAsOfGateSeparate:true,eraMinusXeraDiffGateSeparate:true},sourceManifests,states,summary:{seasonsRequested:SEASONS.length,anchorsTested:states.length,seasonsWithAnchors:new Set(states.map(s=>s.season)).size,totalChosenPaComparable:totalPa,totalChosenPaExact:exactPa,chosenPaExactRate:totalPa?exactPa/totalPa:0,totalChosenDirectDiffComparable:totalDiff,totalChosenDirectDiffExact:exactDiff,chosenDirectDiffExactRate:totalDiff?exactDiff/totalDiff:0,totalChosenDirectDiffRounded3Exact:round3,chosenDirectDiffRounded3ExactRate:totalDiff?round3/totalDiff:0,dateBoundedAggregateExactlyReconstructsProductionConsumedWobaDiffOnEveryTestedAnchorRow:exactEvery,exactEraMinusXeraDiffReconstructionProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},scientificConclusion:{dateBoundedAggregateExactWobaDiffAnchorParityObserved:exactEvery,interpretation:exactEvery?'The primary date-bounded aggregate wOBA-xwOBA arithmetic exactly reproduces the archived primary production-consumed Expected Statistics diff on every comparable tested anchor row. This is anchor evidence only; daily/full-universe custody and the ERA-minus-xERA field remain separate gates.':'The primary date-bounded aggregate does not exactly reproduce the archived primary production-consumed Expected Statistics diff on every comparable tested anchor row. A display-rounded or current-vintage aggregate difference may not be substituted for the archived production diff.',familyPromotionAuthorized:false,nextGate:exactEvery?'EXPAND THIS EXACT DIFF BRIDGE TO ALL AVAILABLE PREGAME ANCHORS, THEN ATTACK PRIMARY DATE-BOUNDED ERA_MINUS_XERA_DIFF CUSTODY; KEEP min=q AND FULL-UNIVERSE PROMOTION GATES SEPARATE.':'DO NOT USE DATE-BOUNDED AGGREGATE WOBA-XWOBA AS THE PRODUCTION DIFF AUTHORITY. NEXT TEST WHETHER A PRIMARY RAW/COMPONENT ROUTE EXPOSES SUFFICIENT HIDDEN PRECISION TO RECONSTRUCT THE DIRECT DIFF EXACTLY; DO NOT INTERPOLATE OR FIT.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(x=>x.startsWith('--out=')),p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-date-bounded-woba-diff-anchor-parity-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,states:states.map(s=>({season:s.season,targetDate:s.targetDate,archiveTimestamp:s.archiveTimestamp,chosenCutoff:s.chosenCutoff,chosenCheck:s.chosenCheck}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
