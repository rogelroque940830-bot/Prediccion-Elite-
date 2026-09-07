import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_ARCHIVED_EXPECTED_STATS_SCHEMA_DRIFT_DIAGNOSTIC_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Schema-Drift/1.0)';
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const CAPTURES=[
  {season:2022,timestamp:'20220503231003',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q'},
  {season:2023,timestamp:'20230409153220',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=109&min=1'},
  {season:2023,timestamp:'20240322195229',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=&filterType=pa&min=400&sort=14&sortDir=asc'},
  {season:2024,timestamp:'20240411173946',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=q'},
  {season:2024,timestamp:'20240828094047',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=25'},
  {season:2025,timestamp:'20250423063612',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2025&position=&team=&min=q&sort=8&sortDir=asc'},
  {season:2025,timestamp:'20251010174927',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?position=&team=&filterType=pa&min=450&type=pitcher&year=2025'},
  {season:2026,timestamp:'20260411195639',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?sortDir=asc&type=pitcher&year=2026&position=&team=&min=q&sort=14'},
  {season:2026,timestamp:'20260809231312',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?team=&filterType=bip&min=q&sort=15&sortDir=asc&type=pitcher&year=2026&position='}
];

async function fetchText(url,accept='text/html,text/javascript,application/javascript,application/json;q=0.9,*/*;q=0.5'){
  let last=null;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120000)});
      const text=await r.text();
      if(!r.ok) throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      return {ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
    }catch(e){last=e;if(attempt<4)await sleep(1500*attempt);}
  }
  return {ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}
function replayUrl(c){return `https://${ARCHIVE}/web/${c.timestamp}id_/${c.original}`;}
function decodeEntities(s){return s.replace(/&quot;/gi,'"').replace(/&#34;/gi,'"').replace(/&#39;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');}
function countToken(text,token){const re=new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');return [...text.matchAll(re)].length;}
function contexts(text,token,max=5,radius=360){const lower=text.toLowerCase(),needle=token.toLowerCase(),out=[];let pos=0;while(out.length<max&&(pos=lower.indexOf(needle,pos))>=0){out.push(text.slice(Math.max(0,pos-radius),Math.min(text.length,pos+needle.length+radius)).replace(/\s+/g,' '));pos+=needle.length;}return out;}
function scriptBlocks(html){const out=[];for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){const attrs=m[1]??'',body=m[2]??'';const type=(attrs.match(/\btype=["']([^"']+)["']/i)?.[1]??null);const id=(attrs.match(/\bid=["']([^"']+)["']/i)?.[1]??null);if(/woba|xera|x_era|expected_statistics|leaderboard|statcast/i.test(body))out.push({type,id,bytes:Buffer.byteLength(body),sha256:sha256(body),tokenCounts:tokenCounts(body),contexts:{xEra:contexts(body,'x_era',3),xera:contexts(body,'xera',3),xWobaDiff:contexts(body,'x_woba_diff',3),expectedStatistics:contexts(body,'expected_statistics',3)}});}return out.slice(0,30);}
function scriptUrls(html,base){const out=[];for(const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)){try{out.push(new URL(decodeEntities(m[1]),base).toString());}catch{}}return [...new Set(out)];}
function routeStrings(text){const hits=[];for(const m of text.matchAll(/(?:https?:\/\/baseballsavant\.mlb\.com)?\/[A-Za-z0-9_?=&.%/+,:;|\-]{1,500}/g)){const v=m[0];if(/expected_statistics|leaderboard|services|csv|download|export|statcast_search|api/i.test(v))hits.push(v);}return [...new Set(hits)].slice(0,150);}
function tokenCounts(text){const tokens=['x_era','xera','x_woba_diff','x_woba','era_minus_xera_diff','est_woba_minus_woba_diff','woba','era','player_id','entity_id','expected_statistics','leaderboard/services','statcast_search','download csv','application/json','__NEXT_DATA__'];const out={};for(const t of tokens)out[t]=countToken(text,t);return out;}
function keyInventory(text){const keys=new Map();for(const m of text.matchAll(/["']?([A-Za-z_][A-Za-z0-9_]{1,80})["']?\s*[:=]/g)){const k=m[1];if(/woba|era|player|entity|plate|\bpa\b|expected|statcast|leaderboard/i.test(k))keys.set(k,(keys.get(k)??0)+1);}return [...keys.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,100).map(([key,count])=>({key,count}));}
function structuralClass(text){
  const d=decodeEntities(text);
  const tc=tokenCounts(d);
  const legacyObjects=[...d.matchAll(/\{[^{}]{40,20000}\}/g)].filter(m=>/\bx_era\b/i.test(m[0])&&/\bx_woba_diff\b/i.test(m[0])&&/(?:\bplayer_id\b|\bentity_id\b)/i.test(m[0])).length;
  const escapedLegacy=countToken(text,'\\"x_era\\"')+countToken(text,"\\'x_era\\'");
  const camelSignals=countToken(text,'xEra')+countToken(text,'xWobaDiff')+countToken(text,'eraMinusXeraDiff');
  let classification='NO_EXPECTED_STATS_VALUE_TOKENS_IN_HTML';
  if(legacyObjects>0) classification='LEGACY_EMBEDDED_OBJECT_SCHEMA';
  else if(tc.x_era>0||tc.x_woba_diff>0) classification='EXPECTED_STATS_TOKENS_PRESENT_BUT_NOT_LEGACY_OBJECT_SHAPE';
  else if(escapedLegacy>0) classification='ESCAPED_JSON_EXPECTED_STATS_SCHEMA';
  else if(camelSignals>0) classification='CAMELCASE_EXPECTED_STATS_SCHEMA';
  else if(tc['expected_statistics']>0||tc['leaderboard/services']>0||tc['statcast_search']>0) classification='PAGE_SHELL_OR_ROUTE_REFERENCES_WITHOUT_EMBEDDED_VALUES';
  return {classification,legacyEmbeddedObjectCount:legacyObjects,escapedLegacyKeyCount:escapedLegacy,camelCaseSignalCount:camelSignals};
}
async function main(){
  const states=[];const allScriptUrls=new Set();
  for(const c of CAPTURES){
    const f=await fetchText(replayUrl(c));
    const decoded=decodeEntities(f.text);
    const urls=f.ok?scriptUrls(f.text,c.original):[];urls.forEach(x=>allScriptUrls.add(x));
    states.push({...c,replayUrl:replayUrl(c),replayOk:f.ok,status:f.status,finalUrl:f.finalUrl,contentType:f.contentType,error:f.error,bodyBytes:Buffer.byteLength(f.text),bodySha256:f.ok?sha256(f.text):null,tokenCounts:tokenCounts(decoded),structure:structuralClass(f.text),keyInventory:keyInventory(decoded),scriptUrls:urls,inlineRelevantScripts:f.ok?scriptBlocks(f.text):[],routeStrings:f.ok?routeStrings(decoded):[],contexts:f.ok?{xEra:contexts(decoded,'x_era'),xera:contexts(decoded,'xera'),xWobaDiff:contexts(decoded,'x_woba_diff'),xWoba:contexts(decoded,'x_woba'),eraMinus:contexts(decoded,'era_minus_xera_diff'),expectedStatistics:contexts(decoded,'expected_statistics'),leaderboardServices:contexts(decoded,'leaderboard/services'),statcastSearch:contexts(decoded,'statcast_search')}:{}});
  }

  // Fetch a bounded set of primary Savant JS assets near representative archive dates.
  const assetEvidence=[];
  const representative=[...allScriptUrls].filter(u=>{try{return new URL(u).hostname===PRIMARY;}catch{return false;}}).slice(0,30);
  for(const original of representative){
    // Use a mid-period timestamp only for route/schema discovery, not value custody.
    const near=`https://${ARCHIVE}/web/20250501id_/${original}`;
    const f=await fetchText(near,'text/javascript,application/javascript,text/plain;q=0.9,*/*;q=0.5');
    assetEvidence.push({original,replayRequest:near,replayOk:f.ok,status:f.status,finalUrl:f.finalUrl,contentType:f.contentType,error:f.error,bodyBytes:Buffer.byteLength(f.text),bodySha256:f.ok?sha256(f.text):null,tokenCounts:f.ok?tokenCounts(f.text):{},keyInventory:f.ok?keyInventory(f.text):[],routeStrings:f.ok?routeStrings(f.text):[],contexts:f.ok?{xEra:contexts(f.text,'x_era',3),xera:contexts(f.text,'xera',3),xWobaDiff:contexts(f.text,'x_woba_diff',3),expectedStatistics:contexts(f.text,'expected_statistics',3),services:contexts(f.text,'services',3),fetch:contexts(f.text,'fetch(',3)}:{}});
  }

  const bySeason={};for(const season of [2022,2023,2024,2025,2026]){const ss=states.filter(s=>s.season===season);bySeason[season]={states:ss.length,legacyEmbeddedObjectStates:ss.filter(s=>s.structure.classification==='LEGACY_EMBEDDED_OBJECT_SCHEMA').length,tokenPresentNonLegacyStates:ss.filter(s=>s.structure.classification==='EXPECTED_STATS_TOKENS_PRESENT_BUT_NOT_LEGACY_OBJECT_SHAPE').length,escapedJsonStates:ss.filter(s=>s.structure.classification==='ESCAPED_JSON_EXPECTED_STATS_SCHEMA').length,camelCaseStates:ss.filter(s=>s.structure.classification==='CAMELCASE_EXPECTED_STATS_SCHEMA').length,shellOnlyStates:ss.filter(s=>s.structure.classification==='PAGE_SHELL_OR_ROUTE_REFERENCES_WITHOUT_EMBEDDED_VALUES').length,noValueTokenStates:ss.filter(s=>s.structure.classification==='NO_EXPECTED_STATS_VALUE_TOKENS_IN_HTML').length};}
  const post2022=states.filter(s=>s.season>=2023);
  const routeCandidates=[...new Set([...states.flatMap(s=>s.routeStrings),...assetEvidence.flatMap(a=>a.routeStrings??[])])];
  const evidence={schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-schema-drift-diagnostic-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherPayloadOnlyCanServeAsTruthAnchor:true},researchQuestion:'Why do archived 2023-2026 Expected Statistics pages replay successfully but the 2022 legacy embedded-object extractor returns zero rows?',scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,diagnosticOnly:true,noPromotionFromTokenOrRouteDiscovery:true},states,assetEvidence,summary:{statesAttempted:states.length,statesReplayOk:states.filter(s=>s.replayOk).length,bySeason,post2022LegacyEmbeddedObjectStates:post2022.filter(s=>s.structure.classification==='LEGACY_EMBEDDED_OBJECT_SCHEMA').length,post2022StatesWithAnyExpectedStatsValueToken:post2022.filter(s=>s.tokenCounts.x_era>0||s.tokenCounts.x_woba_diff>0||s.tokenCounts.x_woba>0||s.tokenCounts.xera>0).length,post2022ShellOrRouteOnlyStates:post2022.filter(s=>s.structure.classification==='PAGE_SHELL_OR_ROUTE_REFERENCES_WITHOUT_EMBEDDED_VALUES').length,discoveredPrimaryRouteCount:routeCandidates.length,discoveredPrimaryRoutes:routeCandidates.slice(0,200),schemaDriftResolved:false,exactTargetDateXeraCustodyForFullUniverseProven:false,familyPromotionAuthorized:false},scientificConclusion:{nextGate:'CLASSIFY THE 2023-2026 PAGE/ASSET DATA-LOADING SCHEMA FROM PRIMARY ARCHIVED CONTENT; IF VALUES MOVED TO A PRIMARY SERVICE/EXPORT ROUTE, FOLLOW ONLY THAT DISCOVERED ROUTE AT THE SAME ARCHIVE VINTAGE. DO NOT GUESS PARAMETERS, FIT VALUES, OR TREAT ROUTE DISCOVERY AS CUSTODY.',familyPromotionAuthorized:false},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(v=>v.startsWith('--out='));const out=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-schema-drift-diagnostic-probe/evidence.json';fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({summary:evidence.summary,scientificConclusion:evidence.scientificConclusion,states:states.map(s=>({season:s.season,timestamp:s.timestamp,bodyBytes:s.bodyBytes,structure:s.structure,tokenCounts:s.tokenCounts,keyInventory:s.keyInventory.slice(0,20),routeStrings:s.routeStrings.slice(0,20)})),assetEvidence:assetEvidence.map(a=>({original:a.original,replayOk:a.replayOk,bodyBytes:a.bodyBytes,tokenCounts:a.tokenCounts,keyInventory:(a.keyInventory??[]).slice(0,20),routeStrings:(a.routeStrings??[]).slice(0,20)}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
