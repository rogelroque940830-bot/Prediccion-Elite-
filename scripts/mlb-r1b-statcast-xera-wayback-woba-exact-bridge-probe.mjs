import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='PRIMARY_SAVANT_WAYBACK_TO_RAW_STATCAST_EXACT_WOBA_BRIDGE_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Exact-wOBA-Bridge/1.0)';
const SEASON=2022;
const ANCHORS=[
  {timestamp:'20220503231003',archiveDate:'2022-05-03'},
  {timestamp:'20220523220701',archiveDate:'2022-05-23'},
];
const RAW_START='2022-04-07';
const RAW_END='2022-05-24';

const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchText(url,accept='application/json,text/csv,text/plain,text/html;q=0.7,*/*;q=0.5'){
  let last=null;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(120_000)});
      const text=await r.text();
      if(!r.ok)throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      if(accept.includes('text/csv')&&/^\s*</.test(text))throw new Error(`HTML_RESPONSE:${text.slice(0,140)}`);
      return {ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
    }catch(e){last=e;if(attempt<4)await sleep(1800*attempt);}
  }
  return {ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}

function queryUrl(base,params){const u=new URL(base);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u.toString();}
function addDays(iso,n){const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function dateRangeChunks(start,end,days=3){const out=[];let s=start;while(s<=end){const eCandidate=addDays(s,days-1);const e=eCandidate>end?end:eCandidate;out.push({inclusiveStart:s,inclusiveEnd:e,gt:addDays(s,-1),lt:addDays(e,1)});s=addDays(e,1);}return out;}

function splitCsvLine(line){const out=[];let cur='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
function parseCsv(text){const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);if(!lines.length)return{headers:[],rows:[]};const headers=splitCsvLine(lines[0]).map(x=>x.trim());const rows=lines.slice(1).map(line=>{const cells=splitCsvLine(line);const r={};headers.forEach((h,i)=>r[h]=cells[i]??'');return r;});return{headers,rows};}
function num(v){if(v==null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function round3(v){return Number(v.toFixed(3));}

function cdxUrl(){const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);u.searchParams.set('url',`${PRIMARY}/leaderboard/expected_statistics*`);u.searchParams.set('output','json');u.searchParams.set('from','2022');u.searchParams.set('to','2022');u.searchParams.append('filter','statuscode:200');u.searchParams.set('collapse','digest');u.searchParams.set('fl','timestamp,original,mimetype,statuscode,digest,length');u.searchParams.set('limit','5000');return u.toString();}
function parseCdx(text){const j=JSON.parse(text);if(!Array.isArray(j)||!j.length)return[];const[h,...rows]=j,ix=x=>h.indexOf(x);return rows.map(r=>({timestamp:r[ix('timestamp')]??'',original:r[ix('original')]??'',mimetype:r[ix('mimetype')]??'',statuscode:r[ix('statuscode')]??'',digest:r[ix('digest')]??'',length:r[ix('length')]??''}));}
function strictAnchorRow(r){try{const u=new URL(r.original);return Number(u.searchParams.get('year'))===2022&&String(u.searchParams.get('type')??'').toLowerCase()==='pitcher'&&String(u.searchParams.get('min')??'').toLowerCase()==='q'&&String(u.searchParams.get('team')??'')===''&&String(u.searchParams.get('position')??'')==='';}catch{return false;}}
function replayUrl(r){return `https://${ARCHIVE}/web/${r.timestamp}id_/${r.original}`;}
function decode(s){return s.replace(/&quot;/g,'"').replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function rawProp(t,key){const esc=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`(?:^|[,\\{])\\s*["']?${esc}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|true|false|null)`,`i`);return t.match(re)?.[1]??null;}
function numProp(t,key){const r=rawProp(t,key);if(r==null)return null;const n=Number(r.replace(/^['"]|['"]$/g,''));return Number.isFinite(n)?n:null;}
function extractAnchorRows(html){const d=decode(html),out=[];for(const m of d.matchAll(/\{[^{}]{40,12000}\}/g)){const t=m[0];if(!/\bx_era\b/.test(t)||!/\bx_woba_diff\b/.test(t)||!/\bx_woba\b/.test(t))continue;const playerId=numProp(t,'player_id')??numProp(t,'entity_id');if(playerId==null)continue;const row={playerId,pa:numProp(t,'pa')??numProp(t,'plate_appearances'),woba:numProp(t,'woba'),xWoba:numProp(t,'x_woba'),xWobaDiff:numProp(t,'x_woba_diff'),xEra:numProp(t,'x_era'),displayXera:numProp(t,'xera'),era:numProp(t,'era'),xEraDiff:numProp(t,'x_era_diff')};if(row.pa==null||row.woba==null||row.xWoba==null||row.xWobaDiff==null||row.xEra==null)continue;out.push(row);}return out;}

function rawPitchUrl(gt,lt){return queryUrl(`https://${PRIMARY}/statcast_search/csv`,{
  all:'true',type:'details',hfGT:'R|',hfSea:`${SEASON}|`,player_type:'pitcher',game_date_gt:gt,game_date_lt:lt,min_pitches:'0',min_results:'0',min_pas:'0',sort_col:'pitches',sort_order:'desc'
});}

function paIdentity(row){const gamePk=String(row.game_pk??'').trim(),atBat=String(row.at_bat_number??'').trim(),pitcher=String(row.pitcher??'').trim();if(!gamePk||!atBat||!pitcher)return null;return `${gamePk}:${atBat}:${pitcher}`;}
function isTerminal(row){return String(row.events??'').trim()!=='';}

function buildRawState(rows,cutoff){
  const unique=new Map();let rowsBeforeCutoff=0,terminalRows=0,duplicateTerminalRows=0,missingPaIdentity=0;
  for(const row of rows){const gameDate=String(row.game_date??'').trim();if(!gameDate||gameDate>=cutoff)continue;rowsBeforeCutoff++;if(!isTerminal(row))continue;terminalRows++;const id=paIdentity(row);if(!id){missingPaIdentity++;continue;}const prior=unique.get(id);if(prior){duplicateTerminalRows++;const p1=num(prior.pitch_number)??-1,p2=num(row.pitch_number)??-1;if(p2>p1)unique.set(id,row);}else unique.set(id,row);}
  const byPitcher=new Map();
  for(const row of unique.values()){
    const pitcher=num(row.pitcher);if(pitcher==null)continue;
    const s=byPitcher.get(pitcher)??{pa:0,wobaNumerator:0,wobaDenominator:0,wobaValueRows:0,wobaDenomRows:0,events:new Map()};
    s.pa++;
    const wv=num(row.woba_value),wd=num(row.woba_denom);
    if(wv!=null){s.wobaNumerator+=wv;s.wobaValueRows++;}
    if(wd!=null){s.wobaDenominator+=wd;s.wobaDenomRows++;}
    const ev=String(row.events??'').trim();s.events.set(ev,(s.events.get(ev)??0)+1);
    byPitcher.set(pitcher,s);
  }
  return {byPitcher,diagnostics:{rowsBeforeCutoff,terminalRows,uniqueTerminalPas:unique.size,duplicateTerminalRows,missingPaIdentity}};
}

function compareAnchorToState(anchorRows,state){
  let commonPlayers=0,exactPa=0,exactDisplayedWoba=0,exactPaAndWoba=0,hiddenRecovered=0,hiddenDisplayMatch=0;
  let maxDisplayedWobaError=0,maxHiddenDisplayError=0;
  const rows=[];
  for(const a of anchorRows){const raw=state.byPitcher.get(a.playerId);if(!raw)continue;commonPlayers++;const exactWoba=raw.wobaDenominator>0?raw.wobaNumerator/raw.wobaDenominator:null;const paMatch=raw.pa===a.pa;const wobaMatch=exactWoba!=null&&round3(exactWoba)===a.woba;if(paMatch)exactPa++;if(wobaMatch)exactDisplayedWoba++;if(paMatch&&wobaMatch)exactPaAndWoba++;
    let hiddenXwoba=null,hiddenRoundMatch=false;if(exactWoba!=null){hiddenXwoba=exactWoba-a.xWobaDiff;hiddenRecovered++;hiddenRoundMatch=round3(hiddenXwoba)===a.xWoba;if(hiddenRoundMatch)hiddenDisplayMatch++;maxHiddenDisplayError=Math.max(maxHiddenDisplayError,Math.abs(hiddenXwoba-a.xWoba));maxDisplayedWobaError=Math.max(maxDisplayedWobaError,Math.abs(exactWoba-a.woba));}
    if(rows.length<30||!paMatch||!wobaMatch||!hiddenRoundMatch)rows.push({playerId:a.playerId,archive:{pa:a.pa,woba:a.woba,xWoba:a.xWoba,xWobaDiff:a.xWobaDiff,xEra:a.xEra},raw:{pa:raw.pa,wobaNumerator:raw.wobaNumerator,wobaDenominator:raw.wobaDenominator,exactWoba,wobaValueRows:raw.wobaValueRows,wobaDenomRows:raw.wobaDenomRows},checks:{paMatch,displayedWobaMatch:wobaMatch,hiddenXwoba,hiddenXwobaRoundsToArchivedXwoba:hiddenRoundMatch}});
  }
  return {archiveRows:anchorRows.length,commonPlayers,exactPa,exactDisplayedWoba,exactPaAndWoba,hiddenRecovered,hiddenDisplayMatch,exactPaRate:anchorRows.length?exactPa/anchorRows.length:0,exactDisplayedWobaRate:anchorRows.length?exactDisplayedWoba/anchorRows.length:0,exactJointRate:anchorRows.length?exactPaAndWoba/anchorRows.length:0,hiddenDisplayMatchRate:hiddenRecovered?hiddenDisplayMatch/hiddenRecovered:0,maxDisplayedWobaAbsoluteError:maxDisplayedWobaError,maxHiddenVsDisplayedXwobaAbsoluteError:maxHiddenDisplayError,mismatchAndSampleRows:rows.slice(0,80)};
}

async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}

async function main(){
  const cdxFetch=await fetchText(cdxUrl(),'application/json,*/*;q=0.5');if(!cdxFetch.ok)throw new Error(`CDX_FETCH_FAILED:${cdxFetch.error}`);const cdx=parseCdx(cdxFetch.text);
  const anchorPayloads=[];
  for(const spec of ANCHORS){const matches=cdx.filter(r=>r.timestamp===spec.timestamp&&strictAnchorRow(r));if(matches.length!==1)throw new Error(`ANCHOR_NOT_UNIQUE:${spec.timestamp}:${matches.length}`);const cdxRow=matches[0];const f=await fetchText(replayUrl(cdxRow),'text/html,*/*;q=0.5');if(!f.ok)throw new Error(`ANCHOR_REPLAY_FAILED:${spec.timestamp}:${f.error}`);const rows=extractAnchorRows(f.text);if(!rows.length)throw new Error(`ANCHOR_ROWS_EMPTY:${spec.timestamp}`);anchorPayloads.push({...spec,cdxRow,replaySha256:sha256(f.text),rows});}

  const chunks=dateRangeChunks(RAW_START,RAW_END,3);
  const fetched=await mapLimit(chunks,4,async(c)=>{const url=rawPitchUrl(c.gt,c.lt);const f=await fetchText(url,'text/csv,text/plain;q=0.9,*/*;q=0.5');if(!f.ok)throw new Error(`RAW_FETCH_FAILED:${c.inclusiveStart}:${c.inclusiveEnd}:${f.error}`);const parsed=parseCsv(f.text);for(const required of ['game_date','game_pk','at_bat_number','pitch_number','pitcher','events','woba_value','woba_denom'])if(!parsed.headers.includes(required))throw new Error(`RAW_SCHEMA_MISSING:${required}:${c.inclusiveStart}`);return {...c,url,sha256:sha256(f.text),headers:parsed.headers,rows:parsed.rows};});
  const allRaw=[];for(const c of fetched)allRaw.push(...c.rows);
  const chunkDiagnostics=fetched.map(c=>({inclusiveStart:c.inclusiveStart,inclusiveEnd:c.inclusiveEnd,gt:c.gt,lt:c.lt,url:c.url,rows:c.rows.length,hitCsvSafetyCap:c.rows.length>=25000,sha256:c.sha256}));
  const everyChunkBelowCsvSafetyCap=chunkDiagnostics.every(c=>!c.hitCsvSafetyCap);

  const anchorEvidence=[];
  let uniquelyAlignedAnchorCount=0,totalHiddenRecoveredOnChosenState=0,totalHiddenDisplayMatchOnChosenState=0;
  for(const a of anchorPayloads){
    const candidateCutoffs=[addDays(a.archiveDate,-1),a.archiveDate,addDays(a.archiveDate,1)];
    const candidateEvidence=[];
    for(const cutoff of candidateCutoffs){const state=buildRawState(allRaw,cutoff);candidateEvidence.push({cutoff,semantics:`raw Statcast rows with game_date < ${cutoff}`,stateDiagnostics:state.diagnostics,comparison:compareAnchorToState(a.rows,state)});}
    const maxJoint=Math.max(...candidateEvidence.map(x=>x.comparison.exactPaAndWoba));
    const best=candidateEvidence.filter(x=>x.comparison.exactPaAndWoba===maxJoint);
    const bestPa=Math.max(...best.map(x=>x.comparison.exactPa));
    const finalists=best.filter(x=>x.comparison.exactPa===bestPa);
    const chosen=finalists.length===1?finalists[0]:null;
    const uniqueNonXeraAlignment=chosen!=null;
    if(uniqueNonXeraAlignment){uniquelyAlignedAnchorCount++;totalHiddenRecoveredOnChosenState+=chosen.comparison.hiddenRecovered;totalHiddenDisplayMatchOnChosenState+=chosen.comparison.hiddenDisplayMatch;}
    anchorEvidence.push({timestamp:a.timestamp,archiveDate:a.archiveDate,original:a.cdxRow.original,cdxDigest:a.cdxRow.digest,replayUrl:replayUrl(a.cdxRow),replaySha256:a.replaySha256,archiveRows:a.rows.length,candidateCutoffs,cutoffSelectionUsesXera:false,cutoffSelectionPolicy:'MAXIMIZE_EXACT_PA_AND_DISPLAYED_ACTUAL_WOBA_THEN_EXACT_PA_ONLY; NEVER USE xERA OR x_woba FOR CUTOFF SELECTION',candidateEvidence,uniqueNonXeraAlignment,chosenCutoff:chosen?.cutoff??null,chosenComparison:chosen?.comparison??null});
  }

  const exactHiddenRecoveredForAllChosenRows=totalHiddenRecoveredOnChosenState>0&&totalHiddenRecoveredOnChosenState===totalHiddenDisplayMatchOnChosenState;
  const out={
    schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-woba-exact-bridge-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',
    sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherExpectedStats:true,dateBoundedRawStatcastPrimaryPublisher:true},
    scientificPolicy:{primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,xeraExcludedFromCutoffSelection:true,xwobaExcludedFromCutoffSelection:true,cutoffChosenOnlyFromPaAndActualWoba:true},
    rawFetch:{season:SEASON,start:RAW_START,end:RAW_END,chunkDays:3,chunkCount:chunks.length,everyChunkBelowCsvSafetyCap,totalDownloadedRows:allRaw.length,requiredRawFields:['game_date','game_pk','at_bat_number','pitch_number','pitcher','events','woba_value','woba_denom'],chunks:chunkDiagnostics},
    anchors:anchorEvidence,
    summary:{anchorsRequested:ANCHORS.length,anchorsParsed:anchorPayloads.length,uniquelyAlignedAnchorCount,everyAnchorUniquelyAligned:uniquelyAlignedAnchorCount===ANCHORS.length,totalHiddenXwobaRecoveredOnChosenStates:totalHiddenRecoveredOnChosenState,totalHiddenXwobaDisplayMatchesOnChosenStates:totalHiddenDisplayMatchOnChosenState,hiddenXwobaDisplayConsistencyRate:totalHiddenRecoveredOnChosenState?totalHiddenDisplayMatchOnChosenState/totalHiddenRecoveredOnChosenState:0,exactHiddenXwobaRecoveredForAllChosenRows:exactHiddenRecoveredForAllChosenRows,exactSavantProductionConversionProven:false,completeHistoricalTargetDateCustodyProven:false,targetDateEraSemanticsProven:false,qualifierAsOfSemanticsAcross2022To2026Proven:false,ev95percentEdgeCasesResolved:false,fullUniverseParityReplayProven:false,familyPromotionAuthorized:false},
    scientificConclusion:{rawActualWobaExactBridgeObserved:anchorEvidence.some(a=>a.chosenComparison?.exactDisplayedWoba>0),sameVintageHiddenXwobaRecoverableFromPrimaryRawWobaMinusPrimaryXwobaDiff:exactHiddenRecoveredForAllChosenRows,everyTestedAnchorUniquelyAlignedWithoutXera:uniquelyAlignedAnchorCount===ANCHORS.length,exactSavantProductionConversionProven:false,familyPromotionAuthorized:false,nextGate:exactHiddenRecoveredForAllChosenRows?'WITH PRIMARY SAME-VINTAGE HIDDEN xwOBA RECOVERED AT TESTED ANCHORS, IDENTIFY AND VALIDATE THE PUBLISHER-SUPPORTED xwOBA→xERA TRANSFORMATION / ERA-SCALE PARAMETERS AGAINST HIGH-PRECISION x_era; THEN COMPLETE ERA, QUALIFIER, EV95PERCENT AND FULL-UNIVERSE GATES BEFORE PROMOTION.':'EXACT RAW wOBA / HIDDEN xwOBA BRIDGE IS NOT CONSISTENT FOR ALL TESTED ALIGNED ROWS; RESOLVE RAW PA OR wOBA SEMANTICS WITHOUT USING xERA, INTERPOLATION OR EMPIRICAL FITTING.'},
    scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}
  };
  const arg=process.argv.find(x=>x.startsWith('--out='));const p=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-woba-exact-bridge-probe/evidence.json';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({rawFetch:{chunkCount:out.rawFetch.chunkCount,everyChunkBelowCsvSafetyCap,totalDownloadedRows:out.rawFetch.totalDownloadedRows},summary:out.summary,scientificConclusion:out.scientificConclusion,anchors:out.anchors.map(a=>({timestamp:a.timestamp,archiveRows:a.archiveRows,uniqueNonXeraAlignment:a.uniqueNonXeraAlignment,chosenCutoff:a.chosenCutoff,chosenComparison:a.chosenComparison,candidates:a.candidateEvidence.map(c=>({cutoff:c.cutoff,comparison:c.comparison}))}))},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
