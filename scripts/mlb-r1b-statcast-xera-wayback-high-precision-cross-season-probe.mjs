import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_ARCHIVED_HIGH_PRECISION_XERA_CROSS_SEASON_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Cross-Season/1.0)';
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Frozen discovery sample from the primary-custody probe. Archive capture time is
// evidence of an immutable replay state, NOT proof of daily target-date custody.
const CAPTURES=[
  {season:2022,timestamp:'20220503231003',digest:'QKXWMGT4BHBOQ4LP7MDTEB6IARUMA2AC',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q'},
  {season:2022,timestamp:'20230131033306',digest:'7JEZ36MOCQOPREFSVWGEDHJXQS7STILG',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q'},
  {season:2022,timestamp:'20260108052720',digest:'LUYLIR5GFZ5N2FLXQSQPS36E66RBF4FP',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q&sort=15&sortDir=desc'},
  {season:2023,timestamp:'20230409153220',digest:'47UPIXTFEWRLNDYAOQYNCU27774CVWLU',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=109&min=1'},
  {season:2023,timestamp:'20240322195229',digest:'YKK3WBKTPCV6FI6XI7I77KG6R4FYKTF3',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=&filterType=pa&min=400&sort=14&sortDir=asc'},
  {season:2023,timestamp:'20260419015249',digest:'XHQ4SNLTNBRJPZWQSVSPT3QXJIAAPUWB',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=141&filterType=bip&min=25'},
  {season:2024,timestamp:'20240411173946',digest:'X2VMQUVL6JETYVTGKX5QPQO3MKHJ3RMG',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=q'},
  {season:2024,timestamp:'20240828094047',digest:'EVGCFKZKXUNQVA6ILM7QMWK6LF7CEZMJ',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=25&partnerId=it-20240827-10879539-mlb-1-A&utm_id=it-20240827-10879539-mlb-1-A'},
  {season:2024,timestamp:'20260412162011',digest:'ZTTHSNI2SJCNAD5FA7MT64IGPCB2ZY4K',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=q&sort=8&sortDir=asc'},
  {season:2025,timestamp:'20250423063612',digest:'YOHV3VO3V3VXVHHJGATQQX76NT4NDTVY',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2025&position=&team=&min=q&sort=8&sortDir=asc'},
  {season:2025,timestamp:'20251010174927',digest:'67S6KULI743ONMCHX53RM23G7F6K6OAD',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?position=&team=&filterType=pa&min=450&type=pitcher&year=2025'},
  {season:2025,timestamp:'20260308143759',digest:'GSRWX5LVYQ5D2G2TC64KHCCJTTAFDM43',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2025&position=&team=&filterType=bip&min=q&sort=12&sortDir=desc'},
  {season:2026,timestamp:'20260411195639',digest:'VLWFXGO75GPBNQR5GJFIHJJVZ6CVLLJ7',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?sortDir=asc&type=pitcher&year=2026&position=&team=&min=q&sort=14'},
  {season:2026,timestamp:'20260516182141',digest:'GQWODA7B24HVWWJ4OY6DX534TFGEE2W3',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2026&position=&team=109&filterType=bip&min=q&sort=15&sortDir=asc'},
  {season:2026,timestamp:'20260809231312',digest:'YOH7WXOHR2WXPBOZXOOBQ6PRMTDTCHX4',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?team=&filterType=bip&min=q&sort=15&sortDir=asc&type=pitcher&year=2026&position='}
];

async function fetchText(url){
  let last=null;
  for(let a=1;a<=4;a++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:'text/html,*/*;q=0.7'},signal:AbortSignal.timeout(90_000)});
      const text=await r.text();
      if(!r.ok) throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      return {ok:true,status:r.status,text,error:null};
    }catch(e){last=e;if(a<4)await sleep(1200*a);}
  }
  return {ok:false,status:null,text:'',error:String(last)};
}
function replayUrl(c){return `https://${ARCHIVE}/web/${c.timestamp}id_/${c.original}`;}
function decode(s){return s.replace(/&quot;/g,'"').replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function rawProp(t,key){const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);return t.match(re)?.[1]??null;}
function numProp(t,key){const r=rawProp(t,key);if(r==null)return null;const n=Number(r.replace(/^["']|["']$/g,''));return Number.isFinite(n)?n:null;}
function extract(html){
  const d=decode(html),out=[];
  for(const m of d.matchAll(/\{[^{}]{40,12000}\}/g)){
    const t=m[0];
    if(!/\bx_era\b/.test(t)||!/\bx_woba_diff\b/.test(t)||!/\bx_woba\b/.test(t)) continue;
    const id=numProp(t,'player_id')??numProp(t,'entity_id');
    if(id==null) continue;
    const row={playerId:id,woba:numProp(t,'woba'),xWoba:numProp(t,'x_woba'),xWobaDiff:numProp(t,'x_woba_diff'),era:numProp(t,'era'),xEra:numProp(t,'x_era'),xEraDiff:numProp(t,'x_era_diff'),displayWobaDiff:numProp(t,'est_woba_minus_woba_diff'),displayXera:numProp(t,'xera'),displayEraDiff:numProp(t,'era_minus_xera_diff'),pa:numProp(t,'pa')??numProp(t,'plate_appearances')};
    if(Object.values(row).slice(1).some(v=>v==null)) continue;
    out.push(row);
  }
  return out;
}
const round=(x,d)=>Number(x.toFixed(d));
function queryMeta(original){
  const u=new URL(original);
  return {year:u.searchParams.get('year'),type:u.searchParams.get('type'),min:u.searchParams.get('min'),team:u.searchParams.get('team'),position:u.searchParams.get('position'),filterType:u.searchParams.get('filterType'),isQualifiedAllPitchers:String(u.searchParams.get('min')??'').toLowerCase()==='q'&&String(u.searchParams.get('team')??'')===''&&String(u.searchParams.get('position')??'')===''};
}
function stateChecks(rows){
  let xeraRound=0,identity=0,eraDiffRound=0,wobaDiffRound=0,xwobaRoundTrip=0;
  let maxIdentityError=0;
  for(const r of rows){
    if(round(r.xEra,2)===r.displayXera)xeraRound++;
    const e=Math.abs((r.era-r.xEraDiff)-r.xEra); maxIdentityError=Math.max(maxIdentityError,e); if(e<1e-12)identity++;
    if(round(r.xEraDiff,2)===r.displayEraDiff)eraDiffRound++;
    if(round(r.xWobaDiff,3)===r.displayWobaDiff)wobaDiffRound++;
    if(round(r.woba-r.xWobaDiff,3)===r.xWoba)xwobaRoundTrip++;
  }
  const n=rows.length,rate=x=>n?x/n:0;
  return {rows:n,xeraDisplayRoundCount:xeraRound,xeraDisplayRoundRate:rate(xeraRound),xeraExactEraMinusDiffIdentityCount:identity,xeraExactEraMinusDiffIdentityRate:rate(identity),maxXeraIdentityAbsoluteError:maxIdentityError,eraDiffDisplayRoundCount:eraDiffRound,eraDiffDisplayRoundRate:rate(eraDiffRound),wobaDiffDisplayRoundCount:wobaDiffRound,wobaDiffDisplayRoundRate:rate(wobaDiffRound),xwobaDisplayedRoundTripCount:xwobaRoundTrip,xwobaDisplayedRoundTripRate:rate(xwobaRoundTrip)};
}
async function main(){
  const states=[];
  for(const c of CAPTURES){
    const f=await fetchText(replayUrl(c));
    const rows=f.ok?extract(f.text):[];
    states.push({season:c.season,timestamp:c.timestamp,captureDate:`${c.timestamp.slice(0,4)}-${c.timestamp.slice(4,6)}-${c.timestamp.slice(6,8)}`,sameCalendarYearAsSeason:Number(c.timestamp.slice(0,4))===c.season,original:c.original,cdxDigest:c.digest,replayUrl:replayUrl(c),replayOk:f.ok,replayStatus:f.status,replayError:f.error,replayBytes:f.text.length,replaySha256:f.ok?sha256(f.text):null,query:queryMeta(c.original),checks:stateChecks(rows),rowSamples:rows.slice(0,3)});
  }
  const seasonCoverage=[];
  for(const season of [2022,2023,2024,2025,2026]){
    const ss=states.filter(s=>s.season===season),parsed=ss.filter(s=>s.checks.rows>0),sameYear=parsed.filter(s=>s.sameCalendarYearAsSeason),qualified=parsed.filter(s=>s.query.isQualifiedAllPitchers);
    const allRows=parsed.reduce((n,s)=>n+s.checks.rows,0);
    const exactIdentityRows=parsed.reduce((n,s)=>n+s.checks.xeraExactEraMinusDiffIdentityCount,0);
    seasonCoverage.push({season,statesAttempted:ss.length,statesParsed:parsed.length,sameCalendarYearStatesParsed:sameYear.length,qualifiedAllPitchersStatesParsed:qualified.length,totalParsedRows:allRows,exactXeraIdentityRows,allParsedRowsPreserveExactXeraIdentity:allRows>0&&exactIdentityRows===allRows,allParsedStatesDisplayRoundHighPrecisionXera:parsed.length>0&&parsed.every(s=>s.checks.xeraDisplayRoundRate===1)});
  }
  const parsed=states.filter(s=>s.checks.rows>0),totalRows=parsed.reduce((n,s)=>n+s.checks.rows,0),identityRows=parsed.reduce((n,s)=>n+s.checks.xeraExactEraMinusDiffIdentityCount,0);
  const seasonsWithParsed=new Set(parsed.map(s=>s.season)).size;
  const seasonsWithSameYearParsed=new Set(parsed.filter(s=>s.sameCalendarYearAsSeason).map(s=>s.season)).size;
  const seasonsWithQualifiedParsed=new Set(parsed.filter(s=>s.query.isQualifiedAllPitchers).map(s=>s.season)).size;
  const allIdentity=totalRows>0&&identityRows===totalRows;
  const allDisplay=parsed.length>0&&parsed.every(s=>s.checks.xeraDisplayRoundRate===1&&s.checks.eraDiffDisplayRoundRate===1&&s.checks.wobaDiffDisplayRoundRate===1&&s.checks.xwobaDisplayedRoundTripRate===1);
  const out={schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-high-precision-cross-season-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherRowsOnly:true,sourceManifestOrigin:'MLB R1B Statcast xERA Wayback Primary Custody Probe run 33923139587 / artifact 9955919671'},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,archiveCaptureExistenceDoesNotEqualCompleteDailyCustody:true,postSeasonOrLaterArchiveCaptureDoesNotEstablishPregameTargetDateCustody:true,noProductionPromotionFromSchemaPresence:true},states,seasonCoverage,summary:{statesAttempted:states.length,statesParsed:parsed.length,totalRowsParsed:totalRows,seasonsWithParsedHighPrecisionRows:seasonsWithParsed,seasonsWithSameCalendarYearParsedHighPrecisionRows:seasonsWithSameYearParsed,seasonsWithQualifiedAllPitchersParsedHighPrecisionRows:seasonsWithQualifiedParsed,allParsedRowsPreserveExactHighPrecisionXeraIdentity:allIdentity,allParsedStatesPreserveDisplaySemantics:allDisplay,directArchivedHighPrecisionXeraObserved:parsed.length>0,completeDailyPregameHistoricalCustodyProven:false,exactTargetDateXeraCustodyForFullUniverseProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},scientificConclusion:{directArchivedPrimaryHighPrecisionXeraObservedAcrossTestedSeasons:seasonsWithParsed===5,exactEraMinusXeraDiffIdentityObservedAcrossAllParsedRows:allIdentity,displaySemanticsObservedAcrossAllParsedStates:allDisplay,sameCalendarYearArchiveEvidenceExistsAcrossAllTestedSeasons:seasonsWithSameYearParsed===5,qualifiedAllPitchersArchiveEvidenceExistsAcrossAllTestedSeasons:seasonsWithQualifiedParsed===5,exactSavantProductionConversionNeededForTestedArchivedRows:false,completeDailyPregameHistoricalCustodyProven:false,exactTargetDateXeraCustodyForFullUniverseProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false,nextGate:'IF DIRECT HIGH-PRECISION xERA SURVIVES CROSS-SEASON TESTING, SEPARATE FIELD-SEMANTICS AUTHORITY FROM COVERAGE: PROVE SUFFICIENT PRE-GAME/TARGET-DATE PRIMARY ARCHIVE CUSTODY AND min=q AS-OF SEMANTICS BEFORE ANY FULL-UNIVERSE REPLAY OR PROMOTION.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-high-precision-cross-season-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,seasonCoverage:out.seasonCoverage,states:out.states.map(s=>({season:s.season,timestamp:s.timestamp,replayOk:s.replayOk,rows:s.checks.rows,sameCalendarYearAsSeason:s.sameCalendarYearAsSeason,qualifiedAllPitchers:s.query.isQualifiedAllPitchers,checks:s.checks}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
