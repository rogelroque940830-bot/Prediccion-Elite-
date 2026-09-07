import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='ARCHIVED_PRIMARY_SAVANT_WOBA_WEIGHT_ASSET_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-WOBA-Asset/1.0)';
const ROOT='research/mlb-r1b-v16-baseline-historical';
const SEASONS=[
  {label:'2022',year:2022,file:'c4-features-2022.jsonl'},
  {label:'2023',year:2023,file:'c4-features-2023.jsonl'},
  {label:'2024',year:2024,file:'c4-features-2024.jsonl'},
  {label:'2025',year:2025,file:'c4-features-2025.jsonl'},
  {label:'2026_YTD',year:2026,file:'c4-features-2026_YTD.jsonl'},
];
const TOKENS=['woba_value','woba_denom','estimated_woba_using_speedangle','est_woba','x_woba','woba_scale','league_woba','expected_statistics','statcast_search','run_value','single','double','triple','home_run','walk','hit_by_pitch'];
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchText(url,accept='text/html,application/javascript,text/javascript,text/plain,*/*;q=0.5'){
  let last=null;
  for(let a=1;a<=4;a++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120000)});
      const text=await r.text();
      if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,160)}`);
      return{ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
    }catch(e){last=e;if(a<4)await sleep(1200*a);}
  }
  return{ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}
function loadJsonl(p){return fs.readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}
function uniqueTargets(rows){const byGame=new Map();for(const r of rows){const gamePk=Number(r.gamePk),officialDate=String(r.officialDate??''),generatedAt=String(r.generatedAt??'');if(!Number.isInteger(gamePk)||!/^\d{4}-\d{2}-\d{2}$/.test(officialDate)||!generatedAt)continue;if(!byGame.has(gamePk))byGame.set(gamePk,{gamePk,officialDate,generatedAt});}return[...byGame.values()];}
function targetDateMap(rows){const m=new Map();for(const t of uniqueTargets(rows)){let x=m.get(t.officialDate);if(!x)m.set(t.officialDate,x={officialDate:t.officialDate,earliestFrozenCutoff:t.generatedAt,gameCount:0});x.gameCount++;if(t.generatedAt<x.earliestFrozenCutoff)x.earliestFrozenCutoff=t.generatedAt;}return m;}
function expectedCdxUrl(year){const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);u.searchParams.set('url',`${PRIMARY}/leaderboard/expected_statistics*`);u.searchParams.set('output','json');u.searchParams.set('from',String(year));u.searchParams.set('to',String(year));u.searchParams.append('filter','statuscode:200');u.searchParams.set('fl','timestamp,original,digest,length');u.searchParams.set('limit','20000');return u.toString();}
function exactCdxUrl(assetUrl,year){const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);u.searchParams.set('url',assetUrl);u.searchParams.set('output','json');u.searchParams.set('from',String(year));u.searchParams.set('to',String(year));u.searchParams.append('filter','statuscode:200');u.searchParams.set('fl','timestamp,original,mimetype,digest,length');u.searchParams.set('limit','1000');return u.toString();}
function parseCdx(text){const j=JSON.parse(text);if(!Array.isArray(j)||j.length<1)return[];const[h,...rows]=j,ix=k=>h.indexOf(k);return rows.map(r=>({timestamp:String(r[ix('timestamp')]??''),original:String(r[ix('original')]??''),mimetype:String(r[ix('mimetype')]??''),digest:String(r[ix('digest')]??''),length:String(r[ix('length')]??'')}));}
function dateOfTimestamp(ts){return /^\d{14}$/.test(ts)?`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`:null;}
function isoOfTimestamp(ts){return /^\d{14}$/.test(ts)?`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}.000Z`:null;}
function classifyExpectedUrl(original,year){try{const u=new URL(original);if(u.hostname!==PRIMARY||u.pathname!=='/leaderboard/expected_statistics')return false;return (u.searchParams.get('type')??'').toLowerCase()==='pitcher'&&Number(u.searchParams.get('year'))===year&&(u.searchParams.get('min')??'').toLowerCase()==='q'&&(u.searchParams.get('team')??'')===''&&(u.searchParams.get('position')??'')==='';}catch{return false;}}
function selectFirstPregameAnchor(rows,dateMap,year){return rows.map(r=>classifyExpectedUrl(r.original,year)?{...r,captureDate:dateOfTimestamp(r.timestamp),captureIso:isoOfTimestamp(r.timestamp)}:null).filter(Boolean).filter(c=>{const d=dateMap.get(c.captureDate);return d&&c.captureIso<d.earliestFrozenCutoff;}).sort((a,b)=>a.timestamp.localeCompare(b.timestamp))[0]??null;}
function replayUrl(r){return `https://${ARCHIVE}/web/${r.timestamp}id_/${r.original}`;}
function normalizeAssetUrl(raw){try{let v=raw.trim();if(v.startsWith('//'))v=`https:${v}`;else if(v.startsWith('/'))v=`https://${PRIMARY}${v}`;const u=new URL(v);if(u.hostname!==PRIMARY)return null;if(!/\.js(?:$|\?)/i.test(u.pathname+u.search))return null;u.hash='';return u.toString();}catch{return null;}}
function extractScriptAssets(html){const out=new Set();for(const m of html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)){const u=normalizeAssetUrl(m[1]);if(u)out.add(u);}return[...out].slice(0,20);}
function nearestHistoricalCapture(rows,anchorTs){const valid=rows.filter(r=>/^\d{14}$/.test(r.timestamp));const prior=valid.filter(r=>r.timestamp<=anchorTs).sort((a,b)=>b.timestamp.localeCompare(a.timestamp));if(prior.length)return{row:prior[0],selection:'LATEST_AT_OR_BEFORE_PAGE_ANCHOR'};const later=valid.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));return later.length?{row:later[0],selection:'NO_PRIOR_CAPTURE_EARLIEST_LATER_SAME_YEAR'}:{row:null,selection:'NO_CAPTURE'};}
function countToken(text,token){const esc=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return (text.match(new RegExp(esc,'gi'))||[]).length;}
function snippets(text,needle,limit=8){const out=[],lo=text.toLowerCase(),n=needle.toLowerCase();let p=0;while(out.length<limit){const i=lo.indexOf(n,p);if(i<0)break;out.push(text.slice(Math.max(0,i-320),Math.min(text.length,i+760)).replace(/\s+/g,' '));p=i+n.length;}return out;}
function numericCandidateSnippets(text){const out=[],seen=new Set();const patterns=[/woba_(?:value|denom|scale)[^;\n]{0,260}/ig,/league_woba[^;\n]{0,260}/ig,/(?:single|double|triple|home_run|hit_by_pitch|walk)[^;\n]{0,220}(?:0\.\d{2,5})/ig,/(?:0\.\d{2,5})[^;\n]{0,220}(?:single|double|triple|home_run|hit_by_pitch|walk)/ig];for(const re of patterns){for(const m of text.matchAll(re)){const s=text.slice(Math.max(0,m.index-220),Math.min(text.length,m.index+900)).replace(/\s+/g,' ');const k=sha256(s);if(!seen.has(k)){seen.add(k);out.push(s);}if(out.length>=60)return out;}}return out;}
function strictWeightCandidate(snippet){const labels=['single','double','triple','home_run','walk','hit_by_pitch'].filter(x=>snippet.toLowerCase().includes(x)).length;const nums=[...snippet.matchAll(/\b(?:0|1|2)\.\d{2,5}\b/g)].map(m=>m[0]);return labels>=2&&new Set(nums).size>=2;}

async function main(){
  const states=[];let totalArchivedAssets=0,totalAssetsWithComponentTokens=0,totalStrictCandidates=0;
  for(const s of SEASONS){
    const dateMap=targetDateMap(loadJsonl(path.join(ROOT,s.file)));
    const cdx=await fetchText(expectedCdxUrl(s.year),'application/json,*/*;q=0.5');if(!cdx.ok)throw new Error(`EXPECTED_CDX:${s.year}:${cdx.error}`);
    const rows=parseCdx(cdx.text);if(rows.length>=20000)throw new Error(`EXPECTED_CDX_LIMIT:${s.year}`);
    const anchor=selectFirstPregameAnchor(rows,dateMap,s.year);if(!anchor)throw new Error(`NO_PREGAME_EXPECTED_ANCHOR:${s.year}`);
    const page=await fetchText(replayUrl(anchor));if(!page.ok)throw new Error(`EXPECTED_REPLAY:${anchor.timestamp}:${page.error}`);
    const assets=extractScriptAssets(page.text);
    const assetEvidence=[];
    for(const assetUrl of assets){
      const af=await fetchText(exactCdxUrl(assetUrl,s.year),'application/json,*/*;q=0.5');
      let selected=null,selection='CDX_FAILED',body={ok:false,status:null,finalUrl:null,contentType:null,text:'',error:af.error};
      if(af.ok){const pick=nearestHistoricalCapture(parseCdx(af.text),anchor.timestamp);selected=pick.row;selection=pick.selection;if(selected)body=await fetchText(replayUrl(selected),'application/javascript,text/javascript,text/plain,*/*;q=0.5');}
      const counts=body.ok?Object.fromEntries(TOKENS.map(t=>[t,countToken(body.text,t)])):Object.fromEntries(TOKENS.map(t=>[t,0]));
      const nonZero=Object.fromEntries(Object.entries(counts).filter(([,v])=>v>0));
      const componentTokenObserved=(counts.woba_value??0)>0||(counts.woba_denom??0)>0||(counts.estimated_woba_using_speedangle??0)>0||(counts.woba_scale??0)>0||(counts.league_woba??0)>0;
      const candidates=body.ok?numericCandidateSnippets(body.text):[];
      const strict=candidates.filter(strictWeightCandidate);
      if(body.ok)totalArchivedAssets++;
      if(componentTokenObserved)totalAssetsWithComponentTokens++;
      totalStrictCandidates+=strict.length;
      assetEvidence.push({assetUrl,selection,selectedCapture:selected?{timestamp:selected.timestamp,original:selected.original,mimetype:selected.mimetype,digest:selected.digest,length:selected.length}:null,replayUrl:selected?replayUrl(selected):null,replayOk:body.ok,replayStatus:body.status,replayContentType:body.contentType,replayError:body.error,bodyBytes:body.ok?Buffer.byteLength(body.text):0,bodySha256:body.ok?sha256(body.text):null,nonZeroTokenCounts:nonZero,tokenSnippets:body.ok?Object.fromEntries(TOKENS.filter(t=>(counts[t]??0)>0).map(t=>[t,snippets(body.text,t)])): {},numericCandidateSnippets:candidates.slice(0,30),strictWeightCandidateSnippets:strict.slice(0,20)});
    }
    const inlineCandidates=numericCandidateSnippets(page.text),inlineStrict=inlineCandidates.filter(strictWeightCandidate);
    totalStrictCandidates+=inlineStrict.length;
    states.push({season:s.label,year:s.year,targetDate:anchor.captureDate,archiveTimestamp:anchor.timestamp,archiveCaptureIso:anchor.captureIso,archiveOriginal:anchor.original,archiveDigest:anchor.digest,archiveReplayUrl:replayUrl(anchor),archivePageBodySha256:sha256(page.text),scriptAssetCount:assets.length,scriptAssets:assetEvidence,inlinePageNonZeroTokenCounts:Object.fromEntries(TOKENS.map(t=>[t,countToken(page.text,t)]).filter(([,v])=>v>0)),inlinePageNumericCandidateSnippets:inlineCandidates.slice(0,30),inlinePageStrictWeightCandidateSnippets:inlineStrict.slice(0,20)});
  }
  const explicitCandidateObserved=totalStrictCandidates>0;
  const out={schemaVersion:'courtedge-mlb-r1b-statcast-archived-woba-weight-asset-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,archivedPrimaryPublisherPageAndAssetsOnly:true},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,noInferenceOfWeightsFromOutcomeFit:true,assetCaptureMustBeSameSeason:true,preferAssetCaptureAtOrBeforePageAnchor:true,noPromotionFromAssetTokenSearch:true},states,summary:{seasonsRequested:SEASONS.length,seasonsTested:states.length,totalArchivedAssets,totalAssetsWithComponentTokens,totalStrictNumericalWeightCandidateSnippets:totalStrictCandidates,explicitNumericalWobaWeightCandidateObserved:explicitCandidateObserved,exactHistoricalWobaWeightAuthorityProven:false,exactHistoricalTargetDateWobaReconstructionProven:false,exactEraMinusXeraDiffReconstructionProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},scientificConclusion:{archivedPrimaryPublisherAssetsRecovered:totalArchivedAssets>0,componentSemanticTokensObserved:totalAssetsWithComponentTokens>0,explicitNumericalWobaWeightCandidateObserved:explicitCandidateObserved,interpretation:explicitCandidateObserved?'One or more archived primary-publisher page/asset snippets contain numerical candidates near wOBA/event semantics. They are discovery evidence only and require direct manual semantic verification before any use; do not fit or infer coefficients from outcomes.':'The tested archived primary-publisher page/asset surfaces did not expose a strict numerical historical wOBA-weight candidate under the preregistered token/pattern search. This closes the tested browser-asset surface only; it does not prove the server-side historical weights are unrecoverable.',familyPromotionAuthorized:false,nextGate:explicitCandidateObserved?'MANUALLY VERIFY EACH STRICT PRIMARY-PUBLISHER CANDIDATE AGAINST ITS ARCHIVED ASSET CONTEXT, THEN TEST ONLY PUBLISHED CONSTANTS ON HELD-OUT ARCHIVED EXPECTED-STATISTICS ANCHORS.':'MOVE TO PRIMARY-PUBLISHER SERVER/DATA-CUSTODY ROUTES FOR HISTORICAL wOBA VALUE/WEIGHT SEMANTICS; DO NOT DERIVE WEIGHTS BY REGRESSION OR OUTCOME FITTING.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-archived-woba-weight-asset-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,states:states.map(s=>({season:s.season,targetDate:s.targetDate,archiveTimestamp:s.archiveTimestamp,scriptAssetCount:s.scriptAssetCount,archivedAssets:s.scriptAssets.filter(a=>a.replayOk).length,assetsWithComponentTokens:s.scriptAssets.filter(a=>Object.keys(a.nonZeroTokenCounts).some(k=>['woba_value','woba_denom','estimated_woba_using_speedangle','woba_scale','league_woba'].includes(k))).length,strictCandidates:s.scriptAssets.reduce((n,a)=>n+a.strictWeightCandidateSnippets.length,0)+s.inlinePageStrictWeightCandidateSnippets.length}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
