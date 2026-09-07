import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_RAW_WOBA_COMPONENT_ANCHOR_PARITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Raw-WOBA-Components/1.0)';
const ROW_CAP=25000;
const ANCHORS=[
  {season:'2022',year:2022,targetDate:'2022-05-19',timestamp:'20220519000508'},
  {season:'2023',year:2023,targetDate:'2023-05-19',timestamp:'20230519130144'},
  {season:'2024',year:2024,targetDate:'2024-04-18',timestamp:'20240418153058'},
  {season:'2025',year:2025,targetDate:'2025-04-23',timestamp:'20250423063612'},
  {season:'2026_YTD',year:2026,targetDate:'2026-05-22',timestamp:'20260522124125'},
];

const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const near=(a,b,t=1e-12)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t;
const round=(x,d)=>Math.round((x+Number.EPSILON)*(10**d))/(10**d);

async function fetchText(url,accept='text/csv,text/plain;q=0.9,*/*;q=0.7'){
  let last=null;
  for(let a=1;a<=4;a++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120000)});
      const text=await r.text();
      if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      return{ok:true,status:r.status,text,error:null};
    }catch(e){last=e;if(a<4)await sleep(1500*a);}
  }
  return{ok:false,status:null,text:'',error:String(last)};
}

function splitCsvLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
function parseCsv(text){const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);if(!lines.length)return{headers:[],rows:[]};const headers=splitCsvLine(lines[0]).map(x=>x.trim());const rows=lines.slice(1).map(line=>{const cells=splitCsvLine(line),r={};headers.forEach((h,i)=>r[h]=cells[i]??'');return r;});return{headers,rows};}
function num(v){if(v==null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function prevDate(s){const d=new Date(`${s}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
function addDays(s,n){const d=new Date(`${s}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}

function cdxUrl(year){const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);u.searchParams.set('url',`${PRIMARY}/leaderboard/expected_statistics*`);u.searchParams.set('output','json');u.searchParams.set('from',String(year));u.searchParams.set('to',String(year));u.searchParams.append('filter','statuscode:200');u.searchParams.set('fl','timestamp,original,digest,length');u.searchParams.set('limit','20000');return u.toString();}
function parseCdx(text){const j=JSON.parse(text);if(!Array.isArray(j)||!j.length)return[];const[h,...rows]=j,ix=k=>h.indexOf(k);return rows.map(r=>({timestamp:String(r[ix('timestamp')]??''),original:String(r[ix('original')]??''),digest:String(r[ix('digest')]??''),length:String(r[ix('length')]??'')}));}
function isExpectedPitcherMinQ(original,year){try{const u=new URL(original);return u.hostname===PRIMARY&&u.pathname==='/leaderboard/expected_statistics'&&(u.searchParams.get('type')??'').toLowerCase()==='pitcher'&&Number(u.searchParams.get('year'))===year&&(u.searchParams.get('min')??'').toLowerCase()==='q'&&(u.searchParams.get('team')??'')===''&&(u.searchParams.get('position')??'')==='';}catch{return false;}}
function replayUrl(r){return `https://${ARCHIVE}/web/${r.timestamp}id_/${r.original}`;}
function decode(s){return s.replace(/&quot;/gi,'"').replace(/&#34;/gi,'"').replace(/&#39;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');}
function rawProp(t,key){const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);return t.match(re)?.[1]??null;}
function strProp(t,key){const r=rawProp(t,key);if(r==null||r==='null')return null;return r.replace(/^["']|["']$/g,'');}
function numProp(t,key){const r=strProp(t,key);if(r==null)return null;const n=Number(r);return Number.isFinite(n)?n:null;}
function archiveRows(html){const d=decode(html),out=[];for(const m of d.matchAll(/\{[^{}]{80,30000}\}/g)){const t=m[0];if(!/(?:entity_id|player_id)/i.test(t)||!/(?:est_woba|x_woba)/i.test(t))continue;const playerId=numProp(t,'entity_id')??numProp(t,'player_id');if(playerId==null)continue;const legacy=numProp(t,'est_woba_minus_woba_diff')??numProp(t,'x_woba_diff');const successor=numProp(t,'woba_minus_est_woba_diff');const effective=Number.isFinite(legacy)?legacy:successor;out.push({playerId,pa:numProp(t,'pa')??numProp(t,'plate_appearances'),woba:numProp(t,'woba'),estWoba:numProp(t,'est_woba')??numProp(t,'x_woba'),effectiveDiff:effective});}const byId=new Map();for(const r of out)if(!byId.has(r.playerId))byId.set(r.playerId,r);return[...byId.values()];}

function rawUrl(year,gt,lt){const u=new URL(`https://${PRIMARY}/statcast_search/csv`);const p={all:'true',type:'details',hfGT:'R|',hfSea:`${year}|`,player_type:'pitcher',game_date_gt:gt,game_date_lt:lt,min_pitches:'0',min_results:'0',min_pas:'0',sort_col:'pitches',sort_order:'desc'};for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);return u.toString();}
function windows(endInclusive){const out=[];let gt=`${endInclusive.slice(0,4)}-03-01`;while(gt<=endInclusive){const ltCandidate=addDays(gt,5);const lt=ltCandidate>endInclusive?endInclusive:ltCandidate;out.push([gt,lt]);if(lt===endInclusive)break;gt=lt;}return out;}
function rawPitchIdentity(r){const game=String(r.game_pk??'').trim(),ab=String(r.at_bat_number??'').trim(),pitch=String(r.pitch_number??'').trim(),pid=String(r.pitcher??'').trim();return game&&ab&&pitch&&pid?`${game}:${ab}:${pitch}:${pid}`:null;}
function paIdentity(r){const game=String(r.game_pk??'').trim(),ab=String(r.at_bat_number??'').trim(),pid=String(r.pitcher??'').trim();return game&&ab&&pid?`${game}:${ab}:${pid}`:null;}

function aggregateRaw(rows){
  const byPitcher=new Map();
  for(const r of rows){
    const pitcher=num(r.pitcher);if(pitcher==null)continue;
    let x=byPitcher.get(pitcher);if(!x){x={terminalPa:new Set(),denom:0,actualNumerator:0,expectedNumerator:0,rowsWithDenom:0,rowsWithExpectedBbe:0,rowsWithActualValue:0};byPitcher.set(pitcher,x);}
    const events=String(r.events??'').trim();if(events){const id=paIdentity(r);if(id)x.terminalPa.add(id);}
    const denom=num(r.woba_denom),actual=num(r.woba_value),est=num(r.estimated_woba_using_speedangle);
    if(denom!=null&&denom>0){
      x.denom+=denom;x.rowsWithDenom++;
      if(actual!=null){x.actualNumerator+=actual*denom;x.rowsWithActualValue++;}
      const expectedContribution=est!=null?est:actual;
      if(est!=null)x.rowsWithExpectedBbe++;
      if(expectedContribution!=null)x.expectedNumerator+=expectedContribution*denom;
    }
  }
  const out=new Map();
  for(const[p,x]of byPitcher){const actual=x.denom>0?x.actualNumerator/x.denom:null;const expected=x.denom>0?x.expectedNumerator/x.denom:null;out.set(p,{playerId:p,rawTerminalPa:x.terminalPa.size,wobaDenom:x.denom,rawActualWoba:actual,rawExpectedWoba:expected,rawDiff:Number.isFinite(actual)&&Number.isFinite(expected)?actual-expected:null,rowsWithDenom:x.rowsWithDenom,rowsWithExpectedBbe:x.rowsWithExpectedBbe,rowsWithActualValue:x.rowsWithActualValue});}
  return out;
}

function compare(arch,raw){
  let common=0,paComparable=0,paExact=0,diffComparablePaExact=0,diffRound3ExactPaExact=0,diffExactPaExact=0,displayActualRound3ExactPaExact=0,displayExpectedRound3ExactPaExact=0;let maxDiffErrorPaExact=0;const mismatches=[];
  for(const a of arch){const r=raw.get(a.playerId);if(!r)continue;common++;if(Number.isFinite(a.pa)){paComparable++;if(a.pa===r.rawTerminalPa)paExact++;}
    if(a.pa!==r.rawTerminalPa||!Number.isFinite(a.effectiveDiff)||!Number.isFinite(r.rawDiff))continue;
    diffComparablePaExact++;const rounded=round(r.rawDiff,3),err=Math.abs(rounded-a.effectiveDiff);maxDiffErrorPaExact=Math.max(maxDiffErrorPaExact,err);if(near(r.rawDiff,a.effectiveDiff))diffExactPaExact++;if(near(rounded,a.effectiveDiff))diffRound3ExactPaExact++;
    if(Number.isFinite(a.woba)&&Number.isFinite(r.rawActualWoba)&&near(round(r.rawActualWoba,3),a.woba))displayActualRound3ExactPaExact++;
    if(Number.isFinite(a.estWoba)&&Number.isFinite(r.rawExpectedWoba)&&near(round(r.rawExpectedWoba,3),a.estWoba))displayExpectedRound3ExactPaExact++;
    if(!near(rounded,a.effectiveDiff)&&mismatches.length<15)mismatches.push({playerId:a.playerId,archivePa:a.pa,rawTerminalPa:r.rawTerminalPa,archiveDiff:a.effectiveDiff,rawDiff:r.rawDiff,rawDiffRounded3:rounded,archiveWoba:a.woba,rawActualWoba:r.rawActualWoba,archiveEstWoba:a.estWoba,rawExpectedWoba:r.rawExpectedWoba,wobaDenom:r.wobaDenom,rowsWithExpectedBbe:r.rowsWithExpectedBbe,absErrorRounded3:err});
  }
  return{commonRows:common,paComparable,paExact,paExactRate:paComparable?paExact/paComparable:0,diffComparableOnPaExactRows:diffComparablePaExact,diffExactOnPaExactRows:diffExactPaExact,diffRounded3ExactOnPaExactRows:diffRound3ExactPaExact,diffRounded3ExactRateOnPaExactRows:diffComparablePaExact?diffRound3ExactPaExact/diffComparablePaExact:0,displayActualWobaRounded3ExactOnPaExactRows:displayActualRound3ExactPaExact,displayExpectedWobaRounded3ExactOnPaExactRows:displayExpectedRound3ExactPaExact,maxRounded3DiffAbsoluteErrorOnPaExactRows:maxDiffErrorPaExact,mismatchExamples:mismatches};
}

async function main(){
  const states=[];
  for(const a of ANCHORS){
    const cf=await fetchText(cdxUrl(a.year),'application/json,*/*;q=0.5');if(!cf.ok)throw new Error(`CDX:${a.year}:${cf.error}`);const cdx=parseCdx(cf.text);if(cdx.length>=20000)throw new Error(`CDX_LIMIT_HIT:${a.year}`);const match=cdx.find(r=>r.timestamp===a.timestamp&&isExpectedPitcherMinQ(r.original,a.year));if(!match)throw new Error(`ARCHIVE_ANCHOR_NOT_FOUND:${a.year}:${a.timestamp}`);
    const rf=await fetchText(replayUrl(match),'text/html,*/*;q=0.5');if(!rf.ok)throw new Error(`REPLAY:${a.timestamp}:${rf.error}`);const arch=archiveRows(rf.text);
    const cutoff=prevDate(a.targetDate),wins=windows(cutoff),unique=new Map(),chunks=[];let requiredHeadersObserved=false;
    for(const[gt,lt]of wins){const url=rawUrl(a.year,gt,lt),f=await fetchText(url);if(!f.ok)throw new Error(`RAW:${a.year}:${gt}:${lt}:${f.error}`);const parsed=parseCsv(f.text);const capHit=parsed.rows.length>=ROW_CAP;if(capHit)throw new Error(`RAW_ROW_CAP_HIT:${a.year}:${gt}:${lt}:${parsed.rows.length}`);const required=['pitcher','game_pk','at_bat_number','pitch_number','events','woba_value','woba_denom','estimated_woba_using_speedangle'];requiredHeadersObserved||=required.every(h=>parsed.headers.includes(h));for(const r of parsed.rows){const id=rawPitchIdentity(r);if(id&&!unique.has(id))unique.set(id,r);}chunks.push({gt,lt,url,rows:parsed.rows.length,sha256:sha256(f.text),hasRequiredHeaders:required.every(h=>parsed.headers.includes(h))});}
    const raw=aggregateRaw([...unique.values()]),check=compare(arch,raw);
    states.push({...a,cutoff,archiveOriginal:match.original,archiveDigest:match.digest,archiveReplayUrl:replayUrl(match),archiveBodySha256:sha256(rf.text),archiveRows:arch.length,archiveRowsWithDiff:arch.filter(r=>Number.isFinite(r.effectiveDiff)).length,rawChunks:chunks.length,rawUniquePitchRows:unique.size,requiredRawHeadersObserved,rawChunkEvidence:chunks,check});
  }
  const totals={paComparable:states.reduce((n,s)=>n+s.check.paComparable,0),paExact:states.reduce((n,s)=>n+s.check.paExact,0),diffComparable:states.reduce((n,s)=>n+s.check.diffComparableOnPaExactRows,0),diffRound3Exact:states.reduce((n,s)=>n+s.check.diffRounded3ExactOnPaExactRows,0),diffExact:states.reduce((n,s)=>n+s.check.diffExactOnPaExactRows,0)};
  const allHeaders=states.every(s=>s.requiredRawHeadersObserved);const exactRound3=totals.diffComparable>0&&totals.diffRound3Exact===totals.diffComparable;
  const out={schemaVersion:'courtedge-mlb-r1b-statcast-raw-woba-component-anchor-parity-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',productionAuthority:{contract:'research/mlb-r1b-statcast-quality-production-semantics-contract.json',productionDiffField:'est_woba_minus_woba_diff',observedSemanticIdentity:'woba_minus_est_woba'},sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,rawDateBoundedRowsFromPrimaryPublisher:true,archivedExpectedStatisticsRowsUsedAsPrimarySemanticAnchors:true},candidateDefinition:{actualWoba:'SUM(woba_value*woba_denom)/SUM(woba_denom) over raw primary rows with woba_denom>0',expectedWoba:'SUM((estimated_woba_using_speedangle if present else woba_value)*woba_denom)/SUM(woba_denom)',diff:'actualWoba-expectedWoba',comparison:'ROUND_TO_0_001(raw diff) vs archived direct production-consumed diff',parameterFittingUsed:false},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,preSpecifiedRawAlgebraOnly:true,comparisonRestrictedToRowsWithExactRawTerminalPaVsArchivePa:true,noPromotionFromAnchorSample:true,eraMinusXeraDiffGateSeparate:true,qualifierAsOfGateSeparate:true},states,summary:{anchorsTested:states.length,seasonsCovered:new Set(states.map(s=>s.season)).size,requiredRawComponentHeadersObservedEveryState:allHeaders,totalPaComparable:totals.paComparable,totalPaExact:totals.paExact,paExactRate:totals.paComparable?totals.paExact/totals.paComparable:0,totalDiffComparableOnExactPaRows:totals.diffComparable,totalRawDiffExactOnExactPaRows:totals.diffExact,totalRawDiffRounded3ExactOnExactPaRows:totals.diffRound3Exact,rawDiffRounded3ExactRateOnExactPaRows:totals.diffComparable?totals.diffRound3Exact/totals.diffComparable:0,rawComponentsExactlyReconstructArchivedProductionDiffOnEveryComparableExactPaRow:exactRound3,exactEraMinusXeraDiffReconstructionProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},scientificConclusion:{primaryRawComponentsExposeCandidateHiddenPrecision:allHeaders,rawComponentExactDiffAnchorParityObserved:exactRound3,interpretation:exactRound3?'The pre-specified raw primary per-PA component algebra reproduces the archived direct production-consumed wOBA diff exactly at the archived 0.001 precision on every tested row whose raw terminal PA matches the archived PA. This is anchor evidence only and does not establish min=q or full-universe custody.':'The pre-specified raw primary per-PA component algebra does not reproduce the archived direct production-consumed wOBA diff on every exact-PA anchor row. Do not promote this reconstruction or tune coefficients to fit the anchors.',familyPromotionAuthorized:false,nextGate:exactRound3?'EXPAND RAW COMPONENT DIFF PARITY TO ALL AVAILABLE PREGAME ANCHORS, THEN MATERIALIZE DATE-BOUNDED DIFF FOR THE FROZEN UNIVERSE AND ATTACK ERA_MINUS_XERA_DIFF; KEEP min=q SEPARATE.':'STOP THIS RAW ALGEBRA AS AUTHORITY. INVENTORY ADDITIONAL EXPLICIT PRIMARY RAW/PLAYER-SERVICE EXPECTED-STAT COMPONENTS OR IMMUTABLE AS-OF PAYLOADS; NO FITTING OR INTERPOLATION.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-raw-woba-component-anchor-parity-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,states:states.map(s=>({season:s.season,targetDate:s.targetDate,cutoff:s.cutoff,rawChunks:s.rawChunks,rawUniquePitchRows:s.rawUniquePitchRows,requiredRawHeadersObserved:s.requiredRawHeadersObserved,check:s.check}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
