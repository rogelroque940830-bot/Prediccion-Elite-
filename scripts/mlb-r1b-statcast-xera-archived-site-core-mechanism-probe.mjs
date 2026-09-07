import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='ARCHIVED_PRIMARY_SAVANT_SITE_CORE_XERA_MECHANISM_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Site-Core/1.0)';
const ANCHORS=[
  {timestamp:'20220503231003',assetPath:'/builds/site-core/5ba3e3e835ea0a8093b800d2f355e15ab8ee6b24_1650037898/scripts/site-core.js'},
  {timestamp:'20220523220701',assetPath:'/builds/site-core/1e6b171b5cbe1f9f0ff14c9c1e9708bb616a0212_1652302081/scripts/site-core.js'},
  {timestamp:'20221023221946',assetPath:'/builds/site-core/26c51c872029b4b0122e2dbb1245e89996fe1f69_1666032690/scripts/site-core.js'},
];
const TOKENS=['x_era','xera','x_woba','est_woba','x_woba_diff','league_average','expected_statistics','btnCSV','csv=true','woba_scale','league_woba','league_era','run_expectancy','run_value','Math.pow','**2','pow(','leaderboard/services','statcast_search','expectedStats'];
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchText(url,accept='application/json,text/javascript,application/javascript,text/plain,*/*;q=0.5'){
 let last=null;
 for(let attempt=1;attempt<=4;attempt++){
  try{
   const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120_000)});
   const text=await r.text();
   if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
   return{ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
  }catch(e){last=e;if(attempt<4)await sleep(1500*attempt);}
 }
 return{ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}
function cdxUrl(assetUrl){
 const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);u.searchParams.set('url',assetUrl);u.searchParams.set('output','json');u.searchParams.set('from','2022');u.searchParams.set('to','2022');u.searchParams.append('filter','statuscode:200');u.searchParams.set('fl','timestamp,original,mimetype,statuscode,digest,length');u.searchParams.set('limit','1000');return u.toString();
}
function parseCdx(text){const j=JSON.parse(text);if(!Array.isArray(j)||!j.length)return[];const[h,...rows]=j,ix=x=>h.indexOf(x);return rows.map(r=>({timestamp:r[ix('timestamp')]??'',original:r[ix('original')]??'',mimetype:r[ix('mimetype')]??'',statuscode:r[ix('statuscode')]??'',digest:r[ix('digest')]??'',length:r[ix('length')]??''}));}
function tsMs(ts){if(!/^\d{14}$/.test(ts))return NaN;return Date.parse(`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}Z`);}
function distanceSeconds(a,b){return Math.round(Math.abs(tsMs(a)-tsMs(b))/1000);}
function replayUrl(r){return `https://${ARCHIVE}/web/${r.timestamp}id_/${r.original}`;}
function snippets(text,token,limit=16){const out=[],lo=text.toLowerCase(),needle=token.toLowerCase();let pos=0;while(out.length<limit){const i=lo.indexOf(needle,pos);if(i<0)break;out.push(text.slice(Math.max(0,i-420),Math.min(text.length,i+920)).replace(/\s+/g,' '));pos=i+needle.length;}return out;}
function extractUrlish(text){
 const out=new Set();
 for(const m of text.matchAll(/["']((?:https?:\/\/|\/)[^"'\s]{4,260})["']/g)){
  const v=m[1];if(/expected|leaderboard|statcast|service|csv|woba|era|api/i.test(v))out.add(v);
 }
 return [...out].slice(0,250);
}
function expressionSnippets(text){
 const patterns=[/x_?era/ig,/x_?woba/ig,/est_woba/ig,/league_average/ig,/Math\.pow/ig,/\*\*\s*2/g,/woba[^;]{0,180}era/ig,/era[^;]{0,180}woba/ig];
 const out=[],seen=new Set();
 for(const re of patterns){for(const m of text.matchAll(re)){const s=text.slice(Math.max(0,m.index-500),Math.min(text.length,m.index+1200)).replace(/\s+/g,' ');const key=sha256(s);if(!seen.has(key)){seen.add(key);out.push(s);}if(out.length>=120)return out;}}
 return out;
}
function tokenCounts(text){return Object.fromEntries(TOKENS.map(t=>[t,(text.toLowerCase().match(new RegExp(t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length]));}
async function main(){
 const evidence=[];let archivedAssetCount=0,totalExpressionSnippets=0;let explicitFormulaCandidateObserved=false;let endpointCandidateObserved=false;
 for(const anchor of ANCHORS){
  const assetUrl=`https://${PRIMARY}${anchor.assetPath}`;
  const cf=await fetchText(cdxUrl(assetUrl),'application/json,*/*;q=0.5');
  if(!cf.ok)throw new Error(`CDX_FAILED:${anchor.timestamp}:${cf.error}`);
  const rows=parseCdx(cf.text).sort((a,b)=>distanceSeconds(a.timestamp,anchor.timestamp)-distanceSeconds(b.timestamp,anchor.timestamp));
  const selected=rows[0]??null;
  let replay={ok:false,status:null,finalUrl:null,contentType:null,text:'',error:'NO_CAPTURE'};
  if(selected)replay=await fetchText(replayUrl(selected),'application/javascript,text/javascript,text/plain,*/*;q=0.5');
  if(replay.ok)archivedAssetCount++;
  const counts=replay.ok?tokenCounts(replay.text):Object.fromEntries(TOKENS.map(t=>[t,0]));
  const tokenEvidence=replay.ok?Object.fromEntries(TOKENS.filter(t=>(counts[t]??0)>0).map(t=>[t,snippets(replay.text,t)])):{};
  const urls=replay.ok?extractUrlish(replay.text):[];
  const expr=replay.ok?expressionSnippets(replay.text):[];
  totalExpressionSnippets+=expr.length;
  const formulaish=expr.filter(s=>/(Math\.pow|\*\*\s*2|x_?woba.{0,240}x_?era|x_?era.{0,240}x_?woba|woba.{0,200}(scale|league|era)|era.{0,200}(woba|scale|league))/i.test(s));
  const endpointish=urls.filter(v=>/expected|leaderboard|statcast|service|csv|woba|era/i.test(v));
  if(formulaish.length)explicitFormulaCandidateObserved=true;
  if(endpointish.length)endpointCandidateObserved=true;
  evidence.push({anchorTimestamp:anchor.timestamp,assetPath:anchor.assetPath,assetUrl,cdxRows:rows.length,nearestCaptures:rows.slice(0,10).map(r=>({timestamp:r.timestamp,distanceSeconds:distanceSeconds(r.timestamp,anchor.timestamp),digest:r.digest,mimetype:r.mimetype,length:r.length,original:r.original})),selectedCapture:selected?{timestamp:selected.timestamp,distanceSeconds:distanceSeconds(selected.timestamp,anchor.timestamp),digest:selected.digest,mimetype:selected.mimetype,length:selected.length,original:selected.original}:null,replayUrl:selected?replayUrl(selected):null,replayOk:replay.ok,replayStatus:replay.status,replayFinalUrl:replay.finalUrl,replayContentType:replay.contentType,replayError:replay.error,bodyBytes:replay.ok?Buffer.byteLength(replay.text):0,bodySha256:replay.ok?sha256(replay.text):null,tokenCounts:counts,tokenEvidence,extractedUrlCandidates:urls,expressionSnippets:expr,formulaCandidateSnippets:formulaish.slice(0,40)});
 }
 const out={schemaVersion:'courtedge-mlb-r1b-statcast-xera-archived-site-core-mechanism-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,versionedPrimaryPublisherAssetsOnly:true},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,archivedAssetRequiredForHistoricalMechanismAuthority:true},anchors:evidence,summary:{anchorsRequested:ANCHORS.length,archivedAssetCount,totalExpressionSnippets,explicitFormulaCandidateObserved,endpointCandidateObserved,exactSavantProductionConversionProven:false,exactHistoricalTargetDateXeraCustodyProven:false,familyPromotionAuthorized:false},scientificConclusion:{archivedVersionedSiteCoreAssetsRecovered:archivedAssetCount===ANCHORS.length,explicitFormulaCandidateObserved,endpointCandidateObserved,exactSavantProductionConversionProven:false,familyPromotionAuthorized:false,nextGate:explicitFormulaCandidateObserved?'REVIEW ONLY THE EXPLICIT PRIMARY-PUBLISHER FORMULA CANDIDATE SNIPPETS AND PREREGISTER A HELD-OUT EXACT TEST AGAINST ARCHIVED HIGH-PRECISION x_era; DO NOT FIT PARAMETERS.':endpointCandidateObserved?'PROBE THE IDENTIFIED PRIMARY-PUBLISHER SERVICE/ENDPOINT CANDIDATES FOR HISTORICAL AS-OF CUSTODY USING ARCHIVED CAPTURES; DO NOT TREAT CURRENT ENDPOINT BEHAVIOR AS HISTORICAL AUTHORITY.':'ARCHIVED SITE-CORE DID NOT EXPOSE AN EXPLICIT xERA CONVERSION OR SERVICE CANDIDATE IN THE TESTED TOKEN SURFACES; CONTINUE WITH HIGH-PRECISION LEGACY FIELD SEMANTICS USING ONLY ARCHIVED PRIMARY ROWS.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
 const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-archived-site-core-mechanism-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,anchors:out.anchors.map(a=>({anchorTimestamp:a.anchorTimestamp,cdxRows:a.cdxRows,selectedCapture:a.selectedCapture,replayOk:a.replayOk,bodyBytes:a.bodyBytes,nonZeroTokenCounts:Object.fromEntries(Object.entries(a.tokenCounts).filter(([,v])=>v>0)),urlCandidates:a.extractedUrlCandidates,formulaCandidateCount:a.formulaCandidateSnippets.length}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
