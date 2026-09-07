import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_ARCHIVED_STATCAST_QUALITY_PRODUCTION_PAYLOAD_CROSS_SEASON_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Statcast-Production-Payload/1.0)';
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Representative immutable primary-publisher replays already discovered by the
// custody probes. Population/qualification semantics are evaluated separately;
// this probe asks whether the exact production-consumed Expected Statistics
// payload exists directly in archived Savant rows across schema generations.
const CAPTURES=[
  {season:2022,timestamp:'20220503231003',population:'ALL_PITCHERS_MIN_Q',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q'},
  {season:2023,timestamp:'20230409153220',population:'TEAM_109_MIN_1',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=109&min=1'},
  {season:2023,timestamp:'20240322195229',population:'ALL_PITCHERS_PA_400',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2023&position=&team=&filterType=pa&min=400&sort=14&sortDir=asc'},
  {season:2024,timestamp:'20240411173946',population:'ALL_PITCHERS_MIN_Q',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=q'},
  {season:2024,timestamp:'20240828094047',population:'ALL_PITCHERS_MIN_25',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2024&position=&team=&filterType=bip&min=25'},
  {season:2025,timestamp:'20250423063612',population:'ALL_PITCHERS_MIN_Q',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2025&position=&team=&min=q&sort=8&sortDir=asc'},
  {season:2025,timestamp:'20251010174927',population:'ALL_PITCHERS_PA_450',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?position=&team=&filterType=pa&min=450&type=pitcher&year=2025'},
  {season:2026,timestamp:'20260411195639',population:'ALL_PITCHERS_MIN_Q',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?sortDir=asc&type=pitcher&year=2026&position=&team=&min=q&sort=14'},
  {season:2026,timestamp:'20260809231312',population:'ALL_PITCHERS_MIN_Q',original:'https://baseballsavant.mlb.com/leaderboard/expected_statistics?team=&filterType=bip&min=q&sort=15&sortDir=asc&type=pitcher&year=2026&position='}
];

async function fetchText(url){let last=null;for(let a=1;a<=4;a++){try{const r=await fetch(url,{headers:{'User-Agent':UA,Accept:'text/html,*/*;q=0.7'},signal:AbortSignal.timeout(120000)});const text=await r.text();if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);return{ok:true,status:r.status,text,error:null};}catch(e){last=e;if(a<4)await sleep(1200*a);}}return{ok:false,status:null,text:'',error:String(last)};}
function replayUrl(c){return `https://${ARCHIVE}/web/${c.timestamp}id_/${c.original}`;}
function decode(s){return s.replace(/&quot;/gi,'"').replace(/&#34;/gi,'"').replace(/&#39;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');}
function rawProp(t,key){const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);return t.match(re)?.[1]??null;}
function strProp(t,key){const r=rawProp(t,key);if(r==null||r==='null')return null;return r.replace(/^["']|["']$/g,'');}
function numProp(t,key){const r=strProp(t,key);if(r==null)return null;const n=Number(r);return Number.isFinite(n)?n:null;}
function near(a,b,tol=1e-12){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol;}

function extractDisplayRows(html){
  const d=decode(html),out=[];
  for(const m of d.matchAll(/\{[^{}]{80,30000}\}/g)){
    const t=m[0];
    if(!/(?:["']?entity_id["']?\s*:)/i.test(t)) continue;
    if(!/(?:["']?xera["']?\s*:)/i.test(t)) continue;
    if(!/(?:["']?era_minus_xera_diff["']?\s*:)/i.test(t)) continue;
    if(!/(?:["']?est_woba["']?\s*:)/i.test(t)) continue;
    const playerId=numProp(t,'entity_id');
    if(playerId==null) continue;
    out.push({
      playerId,
      entityName:strProp(t,'entity_name'),
      isQualified:strProp(t,'is_qualified'),
      pa:numProp(t,'pa'),
      era:numProp(t,'era'),
      xera:numProp(t,'xera'),
      eraMinusXeraDiff:numProp(t,'era_minus_xera_diff'),
      woba:numProp(t,'woba'),
      estWoba:numProp(t,'est_woba'),
      legacyProductionDiff:numProp(t,'est_woba_minus_woba_diff'),
      successorDiff:numProp(t,'woba_minus_est_woba_diff'),
    });
  }
  const byId=new Map();for(const r of out)if(!byId.has(r.playerId))byId.set(r.playerId,r);
  return [...byId.values()];
}

function evaluateRows(rows){
  let completeCore=0,legacyDiff=0,successorDiff=0,overlap=0,overlapEqual=0,legacyArithmetic=0,successorArithmetic=0,xeraRoundedEraIdentity=0;
  let maxOverlapError=0,maxLegacyArithmeticError=0,maxSuccessorArithmeticError=0,maxXeraRoundedEraIdentityError=0;
  const samples=[];
  for(const r of rows){
    const core=[r.pa,r.era,r.xera,r.eraMinusXeraDiff,r.woba,r.estWoba].every(Number.isFinite);if(core)completeCore++;
    if(Number.isFinite(r.legacyProductionDiff)){legacyDiff++;const err=Math.abs((r.woba-r.estWoba)-r.legacyProductionDiff);maxLegacyArithmeticError=Math.max(maxLegacyArithmeticError,err);if(err<1e-12)legacyArithmetic++;}
    if(Number.isFinite(r.successorDiff)){successorDiff++;const err=Math.abs((r.woba-r.estWoba)-r.successorDiff);maxSuccessorArithmeticError=Math.max(maxSuccessorArithmeticError,err);if(err<1e-12)successorArithmetic++;}
    if(Number.isFinite(r.legacyProductionDiff)&&Number.isFinite(r.successorDiff)){overlap++;const err=Math.abs(r.legacyProductionDiff-r.successorDiff);maxOverlapError=Math.max(maxOverlapError,err);if(err<1e-12)overlapEqual++;}
    if(Number.isFinite(r.era)&&Number.isFinite(r.xera)&&Number.isFinite(r.eraMinusXeraDiff)){
      // The direct diff may preserve more precision than displayed xERA. Only
      // test whether the direct diff is display-compatible, never reconstruct it.
      const implied=r.era-r.eraMinusXeraDiff;const err=Math.abs(implied-r.xera);maxXeraRoundedEraIdentityError=Math.max(maxXeraRoundedEraIdentityError,err);if(Math.round(implied*100)/100===r.xera)xeraRoundedEraIdentity++;
    }
    if(samples.length<5)samples.push({...r,arithmeticWobaMinusEst:Number.isFinite(r.woba)&&Number.isFinite(r.estWoba)?r.woba-r.estWoba:null,impliedHighPrecisionXeraFromDirectDiff:Number.isFinite(r.era)&&Number.isFinite(r.eraMinusXeraDiff)?r.era-r.eraMinusXeraDiff:null});
  }
  const n=rows.length,rate=x=>n?x/n:0;
  return {rows:n,completeCoreCount:completeCore,completeCoreRate:rate(completeCore),legacyProductionDiffCount:legacyDiff,legacyProductionDiffRate:rate(legacyDiff),successorDiffCount:successorDiff,successorDiffRate:rate(successorDiff),overlapCount:overlap,overlapExactEqualCount:overlapEqual,overlapExactEqualRate:overlap?overlapEqual/overlap:0,maxOverlapAbsoluteError:maxOverlapError,legacyDiffExactArithmeticCount:legacyArithmetic,legacyDiffExactArithmeticRate:legacyDiff?legacyArithmetic/legacyDiff:0,maxLegacyDiffArithmeticAbsoluteError:maxLegacyArithmeticError,successorDiffExactArithmeticCount:successorArithmetic,successorDiffExactArithmeticRate:successorDiff?successorArithmetic/successorDiff:0,maxSuccessorDiffArithmeticAbsoluteError:maxSuccessorArithmeticError,xeraDisplayCompatibleWithEraMinusDirectDiffCount:xeraRoundedEraIdentity,xeraDisplayCompatibleWithEraMinusDirectDiffRate:rate(xeraRoundedEraIdentity),maxXeraDisplayCompatibilityAbsoluteError:maxXeraRoundedEraIdentityError,samples};
}

async function main(){
  const states=[];
  for(const c of CAPTURES){const f=await fetchText(replayUrl(c));if(!f.ok)throw new Error(`REPLAY:${c.timestamp}:${f.error}`);const rows=extractDisplayRows(f.text);states.push({...c,replayUrl:replayUrl(c),bodyBytes:Buffer.byteLength(f.text),bodySha256:sha256(f.text),checks:evaluateRows(rows)});}
  const totalRows=states.reduce((n,s)=>n+s.checks.rows,0);
  const seasonsWithRows=new Set(states.filter(s=>s.checks.rows>0).map(s=>s.season)).size;
  const overlapStates=states.filter(s=>s.checks.overlapCount>0);
  const overlapRows=overlapStates.reduce((n,s)=>n+s.checks.overlapCount,0),overlapEqual=overlapStates.reduce((n,s)=>n+s.checks.overlapExactEqualCount,0);
  const legacyRows=states.reduce((n,s)=>n+s.checks.legacyProductionDiffCount,0),legacyArithmetic=states.reduce((n,s)=>n+s.checks.legacyDiffExactArithmeticCount,0);
  const successorRows=states.reduce((n,s)=>n+s.checks.successorDiffCount,0),successorArithmetic=states.reduce((n,s)=>n+s.checks.successorDiffExactArithmeticCount,0);
  const allCore=states.filter(s=>s.checks.rows>0).every(s=>s.checks.completeCoreRate===1);
  const allXeraDisplayCompatible=states.filter(s=>s.checks.rows>0).every(s=>s.checks.xeraDisplayCompatibleWithEraMinusDirectDiffRate===1);
  const out={schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-production-payload-cross-season-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',productionSemanticsAuthority:{contract:'research/mlb-r1b-statcast-quality-production-semantics-contract.json',expectedPitcherFields:['player_id','pa','era','xera','era_minus_xera_diff','woba','est_woba','est_woba_minus_woba_diff'],runsDeltaConsumes:['era_minus_xera_diff','est_woba_minus_woba_diff','ev95percent'],note:'This probe covers Expected Statistics fields only. ev95percent/barrels remain governed by the independently frozen raw-BBE bridge.'},sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherRowsOnly:true},scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,noProductionSemanticSubstitutionAuthorized:true,successorAliasObservedButNotYetAuthorizedAsLegacyFieldSubstitute:true,populationAndMinQGateSeparate:true,noPromotionFromRepresentativeSnapshots:true},states,summary:{statesParsed:states.length,totalDirectDisplayRows:totalRows,seasonsWithDirectDisplayRows:seasonsWithRows,allParsedStatesExposeCompleteDirectCoreProductionPayload:allCore,allParsedStatesDirectEraMinusXeraDiffIsDisplayCompatibleWithXera:allXeraDisplayCompatible,legacyProductionDiffRows:legacyRows,legacyProductionDiffExactArithmeticRows:legacyArithmetic,legacyProductionDiffExactArithmeticRate:legacyRows?legacyArithmetic/legacyRows:0,successorDiffRows:successorRows,successorDiffExactArithmeticRows:successorArithmetic,successorDiffExactArithmeticRate:successorRows?successorArithmetic/successorRows:0,legacySuccessorOverlapRows:overlapRows,legacySuccessorExactEqualityRows:overlapEqual,legacySuccessorExactEqualityRate:overlapRows?overlapEqual/overlapRows:0,directExpectedStatsProductionPayloadObservedAcross2022To2026:seasonsWithRows===5&&allCore,exactLegacyDiffFieldAvailableAcrossEveryTestedState:states.every(s=>s.checks.rows>0&&s.checks.legacyProductionDiffRate===1),successorAliasSemanticContinuityObserved:overlapRows>0&&overlapEqual===overlapRows&&successorRows>0&&successorArithmetic===successorRows,successorAliasAuthorizedForHistoricalProductionParity:false,completeDailyPregameHistoricalCustodyProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},scientificConclusion:{directProductionConsumedEraMinusXeraDiffObservedAcrossTestedSeasons:seasonsWithRows===5&&allCore,directDisplayedXeraAndEstWobaObservedAcrossTestedSeasons:seasonsWithRows===5&&allCore,exactLegacyEstWobaMinusWobaDiffPersistsAcrossAllTestedStates:states.every(s=>s.checks.rows>0&&s.checks.legacyProductionDiffRate===1),successorWobaMinusEstWobaDiffContinuityObserved:overlapRows>0&&overlapEqual===overlapRows&&successorRows>0&&successorArithmetic===successorRows,conversionFormulaNeededForTestedDirectProductionRows:false,successorAliasAuthorizedForHistoricalProductionParity:false,completeDailyPregameHistoricalCustodyProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false,nextGate:'IF THE DIRECT PRODUCTION PAYLOAD IS CONFIRMED ACROSS 2022-2026, STOP TREATING xwOBA->xERA FORMULA RECOVERY AS THE ONLY PATH. NEXT, PROVE THE 2025+ SUCCESSOR DIFF FIELD IS AN AUTHORITATIVE SEMANTIC CONTINUATION OF THE LEGACY PRODUCTION CSV FIELD (OR RECOVER THE LEGACY FIELD DIRECTLY), THEN PROVE TARGET-DATE/min=q COVERAGE BEFORE FULL-UNIVERSE REPLAY.'},scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}};
  const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-production-payload-cross-season-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary:out.summary,scientificConclusion:out.scientificConclusion,states:states.map(s=>({season:s.season,timestamp:s.timestamp,population:s.population,checks:{...s.checks,samples:s.checks.samples.slice(0,2)}}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
