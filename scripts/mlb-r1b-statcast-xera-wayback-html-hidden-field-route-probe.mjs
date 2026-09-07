import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_WAYBACK_HTML_HIDDEN_FIELD_ROUTE_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-HTML-Hidden-Field-Route/1.0)';
const ANCHORS=[
  {timestamp:'20220503231003',archiveDate:'2022-05-03',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q'},
  {timestamp:'20220523220701',archiveDate:'2022-05-23',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q&sort=15&sortDir=asc'},
];

const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchText(url,accept='text/html,text/javascript,application/javascript;q=0.9,*/*;q=0.5'){
  let last=null;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120000)});
      const text=await r.text();
      if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,160)}`);
      return {ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
    }catch(e){last=e;if(attempt<4)await sleep(1800*attempt);}
  }
  return {ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}
function replayUrl(a){return `https://${ARCHIVE}/web/${a.timestamp}id_/${a.original}`;}
function decode(s){return s.replace(/&quot;/g,'"').replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function rawProp(t,key){const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);return t.match(re)?.[1]??null;}
function numericLiteral(raw){if(raw==null)return null;const s=String(raw).replace(/^['"]|['"]$/g,'');const n=Number(s);return Number.isFinite(n)?{raw:s,value:n,decimalDigits:(s.split('.')[1]??'').length}:null;}
function playerIdOf(t){for(const k of ['player_id','entity_id','id']){const n=numericLiteral(rawProp(t,k));if(n&&Number.isInteger(n.value)&&n.value>100000)return n.value;}return null;}
function objectCandidates(html){
  const d=decode(html),out=[];
  for(const m of d.matchAll(/\{[^{}]{40,20000}\}/g)){
    const t=m[0];
    if(!/\bx_era\b/i.test(t)||!/\bx_woba_diff\b/i.test(t)||!/\bx_woba\b/i.test(t))continue;
    const playerId=playerIdOf(t);if(playerId==null)continue;
    out.push({playerId,text:t});
  }
  return out;
}
function keysOf(t){const out=[];for(const m of t.matchAll(/(?:^|[,\{])\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/g))out.push(m[1]);return [...new Set(out)];}
function interesting(k){return /woba|era|plate|\bpa\b|single|double|triple|home|hr|walk|bb|hbp|hit|out|denom|numer|weight|run|xba|xslg|xobp|entity|player/i.test(k);}
function propMap(t,keys){const o={};for(const k of keys){const raw=rawProp(t,k);if(raw!=null)o[k]={raw,number:numericLiteral(raw)};}return o;}
function extractScripts(html,baseOriginal){
  const out=[];for(const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)){
    try{out.push(new URL(decode(m[1]),baseOriginal).toString());}catch{}
  }return [...new Set(out)];
}
function extractLinks(html,baseOriginal){
  const out=[];for(const m of html.matchAll(/<(?:a|form)\b[^>]*(?:href|action)=["']([^"']+)["'][^>]*>/gi)){
    const v=decode(m[1]);if(!/csv|download|export|expected_statistics|services/i.test(v))continue;
    try{out.push(new URL(v,baseOriginal).toString());}catch{}
  }return [...new Set(out)];
}
function contexts(text,needle,max=20){
  const lower=text.toLowerCase(),n=needle.toLowerCase(),out=[];let pos=0;
  while(out.length<max&&(pos=lower.indexOf(n,pos))>=0){out.push(text.slice(Math.max(0,pos-220),Math.min(text.length,pos+n.length+280)).replace(/\s+/g,' '));pos+=n.length;}
  return out;
}
function routeStrings(text){
  const re=/(?:https?:\/\/baseballsavant\.mlb\.com)?\/[A-Za-z0-9_?=&.%/+,:;|-]{1,400}/g;
  const hits=[];for(const m of text.matchAll(re)){const v=m[0];if(/csv|download|export|expected_statistics|leaderboard\/services|statcast_search/i.test(v))hits.push(v);}
  return [...new Set(hits)].slice(0,100);
}
async function main(){
  const anchorEvidence=[];const allScripts=new Set();
  for(const a of ANCHORS){
    const f=await fetchText(replayUrl(a));if(!f.ok)throw new Error(`ANCHOR_REPLAY_FAILED:${a.timestamp}:${f.error}`);
    const candidates=objectCandidates(f.text);if(!candidates.length)throw new Error(`NO_EXPECTED_STATS_OBJECTS:${a.timestamp}`);
    const keyFreq=new Map();
    for(const c of candidates)for(const k of keysOf(c.text))keyFreq.set(k,(keyFreq.get(k)??0)+1);
    const allKeys=[...keyFreq.entries()].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0]));
    const interestingKeys=allKeys.filter(([k])=>interesting(k)).map(([key,count])=>({key,count}));
    const representative=candidates.slice(0,12).map(c=>({playerId:c.playerId,props:propMap(c.text,interestingKeys.map(x=>x.key))}));
    const scripts=extractScripts(f.text,a.original);scripts.forEach(s=>allScripts.add(s));
    anchorEvidence.push({
      ...a,replayUrl:replayUrl(a),bodySha256:sha256(f.text),bodyBytes:Buffer.byteLength(f.text),
      candidateObjectCount:candidates.length,allKeyCount:allKeys.length,interestingKeys,representative,
      scriptUrls:scripts,scriptCount:scripts.length,
      exportLinks:extractLinks(f.text,a.original),
      routeStrings:routeStrings(f.text),
      contexts:{
        downloadCsv:contexts(f.text,'Download CSV'),
        csv:contexts(f.text,'csv',12),
        xWobaDiff:contexts(f.text,'x_woba_diff',4),
        statcastSearch:contexts(f.text,'statcast_search',6),
        leaderboardServices:contexts(f.text,'leaderboard/services',6),
      },
    });
  }

  const scriptEvidence=[];
  for(const original of [...allScripts].filter(u=>{try{return new URL(u).hostname===PRIMARY;}catch{return false;}}).slice(0,40)){
    const near=`https://${ARCHIVE}/web/20220515id_/${original}`;
    const f=await fetchText(near,'text/javascript,application/javascript,text/plain;q=0.9,*/*;q=0.5');
    scriptEvidence.push({original,replayRequest:near,replayOk:f.ok,status:f.status,finalUrl:f.finalUrl,contentType:f.contentType,error:f.error,bodySha256:f.ok?sha256(f.text):null,bodyBytes:f.ok?Buffer.byteLength(f.text):0,routeStrings:f.ok?routeStrings(f.text):[],contexts:f.ok?{download:contexts(f.text,'download',8),csv:contexts(f.text,'csv',8),expectedStatistics:contexts(f.text,'expected_statistics',8),services:contexts(f.text,'services',8)}:{}});
  }

  const discoveredRoutes=[...new Set([...anchorEvidence.flatMap(a=>a.routeStrings),...anchorEvidence.flatMap(a=>a.exportLinks),...scriptEvidence.flatMap(s=>s.routeStrings??[])])];
  const wobaPrecision=[];
  for(const a of anchorEvidence)for(const r of a.representative)for(const [k,v] of Object.entries(r.props))if(/woba/i.test(k)&&v?.number)wobaPrecision.push({archiveDate:a.archiveDate,playerId:r.playerId,key:k,...v.number});
  const highPrecisionActualLike=wobaPrecision.filter(x=>/(^|_)woba$/i.test(x.key)&&!/^x/i.test(x.key)&&x.decimalDigits>3);
  const alternateWobaFields=[...new Set(anchorEvidence.flatMap(a=>a.interestingKeys.map(x=>x.key)).filter(k=>/woba/i.test(k)))];

  const evidence={
    schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-html-hidden-field-route-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',
    sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,onlyReplayedPrimaryPublisherPayloadCanServeAsTruthAnchor:true},
    researchQuestion:'Do exact archived primary Savant Expected Statistics HTML states contain hidden high-precision actual-wOBA inputs/fields or primary export/service route evidence that can resolve historical-vintage custody without fitting?',
    scientificPolicy:{primaryPublisherOnly:true,noThirdPartyDataAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,xeraExcludedFromRouteSelection:true,xwobaExcludedFromRouteSelection:true},
    anchors:anchorEvidence,scriptEvidence,
    summary:{anchorCount:anchorEvidence.length,totalCandidateObjects:anchorEvidence.reduce((s,a)=>s+a.candidateObjectCount,0),alternateWobaFields,highPrecisionActualLikeSampleCount:highPrecisionActualLike.length,highPrecisionActualLikeSamples:highPrecisionActualLike.slice(0,30),discoveredPrimaryRouteCount:discoveredRoutes.length,discoveredPrimaryRoutes:discoveredRoutes.slice(0,150),exactHistoricalActualWobaRecoveredAtSufficientPrecision:false,exactHiddenXwobaRecovered:false,exactSavantProductionConversionProven:false,familyPromotionAuthorized:false},
    scientificConclusion:{nextGate:highPrecisionActualLike.length>0?'VALIDATE THE DISCOVERED SAME-VINTAGE HIGH-PRECISION ACTUAL-WOBA FIELD AGAINST DISPLAYED ARCHIVE STATES AND x_woba_diff WITHOUT FITTING.':discoveredRoutes.length>0?'FOLLOW ONLY DISCOVERED PRIMARY SAVANT ROUTES THROUGH SAME-VINTAGE ARCHIVAL CUSTODY; DO NOT GUESS PARAMETERS OR SUBSTITUTE CURRENT-VINTAGE VALUES.':'NO HIDDEN HIGH-PRECISION ACTUAL-wOBA OR PRIMARY EXPORT ROUTE PROVEN; CONTINUE PRIMARY-PUBLISHER ASSET/HTML DISCOVERY ONLY.',completeHistoricalTargetDateCustodyProven:false,familyPromotionAuthorized:false},
    scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false},
  };
  const arg=process.argv.find(v=>v.startsWith('--out='));const out=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-html-hidden-field-route-probe/evidence.json';fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,`${JSON.stringify(evidence,null,2)}\n`);console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.stack??e.message:String(e));process.exit(1);});
