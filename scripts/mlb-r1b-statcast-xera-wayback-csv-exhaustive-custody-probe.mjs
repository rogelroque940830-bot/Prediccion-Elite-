import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS='WAYBACK_PRIMARY_STATCAST_CSV_EXHAUSTIVE_CUSTODY_PROBE_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY='baseballsavant.mlb.com';
const ARCHIVE='web.archive.org';
const YEAR=2022;
const UA='Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Wayback-CSV-Custody/1.0)';
const ANCHORS=['2022-05-03','2022-05-23','2022-10-23'];

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const sha256=(s)=>crypto.createHash('sha256').update(s).digest('hex');

async function fetchText(url,accept='application/json,text/csv,text/plain,*/*;q=0.5'){
  let last=null;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':UA,Accept:accept},signal:AbortSignal.timeout(90_000)});
      const text=await r.text();
      if(!r.ok) throw new Error(`HTTP_${r.status}:${text.slice(0,180)}`);
      return {ok:true,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),text,error:null};
    }catch(e){last=e;if(attempt<4) await sleep(1400*attempt);}
  }
  return {ok:false,status:null,finalUrl:null,contentType:null,text:'',error:String(last)};
}

function cdxUrl(){
  const u=new URL(`https://${ARCHIVE}/cdx/search/cdx`);
  u.searchParams.set('url',`${PRIMARY}/statcast_search/csv*`);
  u.searchParams.set('output','json');
  u.searchParams.set('from',String(YEAR));
  u.searchParams.set('to',String(YEAR));
  u.searchParams.append('filter','statuscode:200');
  u.searchParams.set('fl','timestamp,original,mimetype,statuscode,digest,length');
  u.searchParams.set('limit','50000');
  return u.toString();
}

function parseCdx(text){
  const j=JSON.parse(text);
  if(!Array.isArray(j)||!j.length)return [];
  const [h,...rows]=j;const ix=(x)=>h.indexOf(x);
  return rows.map(r=>({timestamp:r[ix('timestamp')]??'',original:r[ix('original')]??'',mimetype:r[ix('mimetype')]??'',statuscode:r[ix('statuscode')]??'',digest:r[ix('digest')]??'',length:r[ix('length')]??''}));
}
function capDate(ts){return /^\d{14}$/.test(ts)?`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`:null;}
function dayDistance(a,b){return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000);}
function replayUrl(r){return `https://${ARCHIVE}/web/${r.timestamp}id_/${r.original}`;}
function query(r){
  try{
    const u=new URL(r.original);
    const p=Object.fromEntries(u.searchParams.entries());
    return {pathname:u.pathname,playerType:u.searchParams.get('player_type'),groupBy:u.searchParams.get('group_by'),type:u.searchParams.get('type'),hfSea:u.searchParams.get('hfSea'),gameDateGt:u.searchParams.get('game_date_gt'),gameDateLt:u.searchParams.get('game_date_lt'),chkStatsXwoba:u.searchParams.get('chk_stats_xwoba'),chkStatsPa:u.searchParams.get('chk_stats_pa'),minPitches:u.searchParams.get('min_pitches'),minResults:u.searchParams.get('min_results'),minPas:u.searchParams.get('min_pas'),params:p};
  }catch{return null;}
}
function is2022(q){return q && (String(q.hfSea??'').includes('2022')||Object.values(q.params??{}).some(v=>String(v).includes('2022')));}
function splitCsvLine(line){
  const out=[];let cur='',quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){out.push(cur);cur='';}else cur+=c;
  }
  out.push(cur);return out;
}
function summarizeCsv(text){
  if(/^\s*</.test(text)) return {html:true,csvish:false,headers:[],rowCount:0,minGameDate:null,maxGameDate:null,uniqueGameDates:0,uniquePitchers:0,nonEmptyEstimatedWobaRows:0,terminalEventRows:0};
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
  if(!lines.length) return {html:false,csvish:false,headers:[],rowCount:0,minGameDate:null,maxGameDate:null,uniqueGameDates:0,uniquePitchers:0,nonEmptyEstimatedWobaRows:0,terminalEventRows:0};
  const headers=splitCsvLine(lines[0]).map(x=>x.trim());
  const idx=(name)=>headers.indexOf(name);
  const gameIx=idx('game_date'),pitcherIx=idx('pitcher'),estIx=idx('estimated_woba_using_speedangle'),eventsIx=idx('events');
  const dates=new Set(),pitchers=new Set();let nonEmptyEst=0,terminal=0;
  for(const line of lines.slice(1)){
    const cells=splitCsvLine(line);
    if(gameIx>=0&&cells[gameIx])dates.add(cells[gameIx]);
    if(pitcherIx>=0&&cells[pitcherIx])pitchers.add(cells[pitcherIx]);
    if(estIx>=0&&cells[estIx]&&cells[estIx].trim()!=='')nonEmptyEst++;
    if(eventsIx>=0&&cells[eventsIx]&&cells[eventsIx].trim()!=='')terminal++;
  }
  const ds=[...dates].sort();
  return {html:false,csvish:headers.length>5,headers,rowCount:Math.max(0,lines.length-1),minGameDate:ds[0]??null,maxGameDate:ds.at(-1)??null,uniqueGameDates:dates.size,uniquePitchers:pitchers.size,nonEmptyEstimatedWobaRows:nonEmptyEst,terminalEventRows:terminal};
}
function priority(r){
  const q=query(r),d=capDate(r.timestamp);let s=0;
  if(q?.playerType==='pitcher')s+=20;
  if(q?.groupBy==='name')s+=8;
  if(q?.chkStatsXwoba==='on')s+=20;
  if(q?.chkStatsPa==='on')s+=8;
  if(q?.gameDateGt||q?.gameDateLt)s+=8;
  if(is2022(q))s+=10;
  if(d)s+=Math.max(0,15-Math.min(...ANCHORS.map(a=>dayDistance(a,d))));
  return s;
}

async function main(){
  const f=await fetchText(cdxUrl(),'application/json,*/*;q=0.5');
  if(!f.ok)throw new Error(`CDX_FETCH_FAILED:${f.error}`);
  const rows=parseCdx(f.text);
  const y2022=rows.filter(r=>is2022(query(r)));
  const uniqueDigests=new Set(rows.map(r=>r.digest));
  const uniqueOriginals=new Set(rows.map(r=>r.original));
  const captureDates=new Set(rows.map(r=>capDate(r.timestamp)).filter(Boolean));

  const perAnchor=ANCHORS.map(anchor=>{
    const near=y2022.map(r=>({r,distance:dayDistance(anchor,capDate(r.timestamp))})).sort((a,b)=>a.distance-b.distance||b.r.timestamp.localeCompare(a.r.timestamp));
    const within1=near.filter(x=>x.distance<=1),within3=near.filter(x=>x.distance<=3),within7=near.filter(x=>x.distance<=7),within14=near.filter(x=>x.distance<=14);
    return {anchor,within1:within1.length,within3:within3.length,within7:within7.length,within14:within14.length,nearest:near.slice(0,12).map(x=>({timestamp:x.r.timestamp,captureDate:capDate(x.r.timestamp),distanceDays:x.distance,original:x.r.original,digest:x.r.digest,query:query(x.r)}))};
  });

  const selected=[];const seen=new Set();
  const sorted=[...y2022].sort((a,b)=>priority(b)-priority(a)||a.timestamp.localeCompare(b.timestamp));
  for(const r of sorted){
    const k=`${r.timestamp}\n${r.original}`;
    if(seen.has(k))continue;seen.add(k);selected.push(r);if(selected.length>=40)break;
  }
  for(const anchor of ANCHORS){
    const near=[...y2022].sort((a,b)=>dayDistance(anchor,capDate(a.timestamp))-dayDistance(anchor,capDate(b.timestamp))||b.timestamp.localeCompare(a.timestamp));
    for(const r of near.slice(0,8)){
      const k=`${r.timestamp}\n${r.original}`;if(!seen.has(k)){seen.add(k);selected.push(r);}
    }
  }
  const replayEvidence=[];
  for(const r of selected.slice(0,60)){
    const rf=await fetchText(replayUrl(r),'text/csv,text/plain;q=0.9,*/*;q=0.4');
    const summary=rf.ok?summarizeCsv(rf.text):null;
    replayEvidence.push({timestamp:r.timestamp,captureDate:capDate(r.timestamp),original:r.original,digest:r.digest,mimetype:r.mimetype,length:r.length,query:query(r),priority:priority(r),replayUrl:replayUrl(r),replayOk:rf.ok,replayStatus:rf.status,replayFinalUrl:rf.finalUrl,replayContentType:rf.contentType,replayError:rf.error,bodySha256:rf.ok?sha256(rf.text):null,bodyBytes:rf.ok?Buffer.byteLength(rf.text):0,csvSummary:summary});
  }

  const usable=replayEvidence.filter(x=>x.replayOk&&x.csvSummary?.csvish&&x.csvSummary?.headers?.includes('estimated_woba_using_speedangle'));
  const pitcherAggregateLike=replayEvidence.filter(x=>x.replayOk&&x.query?.playerType==='pitcher'&&x.query?.groupBy==='name'&&x.csvSummary?.csvish);
  const anchorCoverage=ANCHORS.map(anchor=>{
    const cov=usable.filter(x=>x.csvSummary.minGameDate&&x.csvSummary.maxGameDate&&x.csvSummary.minGameDate<=anchor&&x.csvSummary.maxGameDate<=anchor);
    return {anchor,usableArchivedRawCsvCountAtOrBeforeAnchor:cov.length,coveredGameDateRanges:cov.map(x=>({captureDate:x.captureDate,minGameDate:x.csvSummary.minGameDate,maxGameDate:x.csvSummary.maxGameDate,uniqueGameDates:x.csvSummary.uniqueGameDates,rowCount:x.csvSummary.rowCount,original:x.original}))};
  });

  const evidence={
    schemaVersion:'courtedge-mlb-r1b-statcast-xera-wayback-csv-exhaustive-custody-probe.v1',status:STATUS,generatedAt:new Date().toISOString(),family:'STATCAST_QUALITY',
    sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherPayloadOnly:true},
    scientificPolicy:{cdxCollapseDigest:false,primaryPublisherOnly:true,noThirdPartyAuthority:true,noInterpolation:true,noEmpiricalFit:true,approximationForbidden:true,xeraNotUsedForCaptureSelection:true},
    inventory:{cdxRows:rows.length,rowsReferencing2022:y2022.length,uniqueDigests:uniqueDigests.size,uniqueOriginals:uniqueOriginals.size,uniqueCaptureDates:captureDates.size,pitcherPlayerTypeRows:y2022.filter(r=>query(r)?.playerType==='pitcher').length,batterPlayerTypeRows:y2022.filter(r=>query(r)?.playerType==='batter').length,groupByNameRows:y2022.filter(r=>query(r)?.groupBy==='name').length,xwobaFlagRows:y2022.filter(r=>query(r)?.chkStatsXwoba==='on').length,dateBoundedRows:y2022.filter(r=>query(r)?.gameDateGt||query(r)?.gameDateLt).length,replaySampleRows:replayEvidence.length,usableArchivedRawEventCsvRows:usable.length,pitcherAggregateLikeReplayRows:pitcherAggregateLike.length},
    perAnchorCdxCoverage:perAnchor,replayEvidence,anchorRawCoverage:anchorCoverage,
    scientificConclusion:{archivedPrimaryRawEventCsvCustodyObserved:usable.length>0,archivedPrimaryPitcherAggregateCsvCustodyObserved:pitcherAggregateLike.length>0,completeRawEventCoverageToAnyAnchorProven:false,completeHistoricalTargetDateXwobaCustodyProven:false,exactTargetDateXeraCustodyForFullUniverseProven:false,exactSavantProductionConversionProven:false,familyPromotionAuthorized:false,nextGate:usable.length>0?'BUILD A COVERAGE MAP OF ARCHIVED SAME-VINTAGE RAW STATCAST EVENT PAYLOADS AND TEST WHETHER THEIR UNION CAN RECONSTRUCT A SAME-VINTAGE EXPECTED-STAT HTML ANCHOR EXACTLY BY PLAYER/PA/xwOBA; NO INTERPOLATION OR CURRENT-VINTAGE BACKFILL.':'NO USABLE ARCHIVED RAW EVENT CSV WAS OBSERVED; HISTORICAL INPUT-VINTAGE CUSTODY REMAINS UNPROVEN.'},
    scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false}
  };
  const arg=process.argv.find(x=>x.startsWith('--out='));const out=arg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-wayback-csv-exhaustive-custody-probe/evidence.json';fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({inventory:evidence.inventory,perAnchor:evidence.perAnchorCdxCoverage,anchorRawCoverage:evidence.anchorRawCoverage,scientificConclusion:evidence.scientificConclusion},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
