import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATUS = 'LEGACY_SAVANT_ARCHIVE_SURFACE_DISCOVERY_ONLY_NOT_PARITY_CERTIFICATION';
const PRIMARY = 'baseballsavant.mlb.com';
const ARCHIVE = 'web.archive.org';
const YEAR = 2022;
const UA = 'Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Legacy-Savant-Discovery/1.0)';
const ANCHOR_DATES = ['2022-05-03', '2022-05-23', '2022-10-23'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, accept='application/json,text/csv,text/plain,text/html;q=0.8,*/*;q=0.5') {
  let last = null;
  for (let attempt=1; attempt<=4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(90_000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP_${r.status}:${text.slice(0,160)}`);
      return { ok:true, status:r.status, finalUrl:r.url, contentType:r.headers.get('content-type'), text, error:null };
    } catch (e) {
      last = e;
      if (attempt<4) await sleep(1200*attempt);
    }
  }
  return { ok:false, status:null, finalUrl:null, contentType:null, text:'', error:String(last) };
}

function cdxUrl(pattern, limit=5000) {
  const u = new URL(`https://${ARCHIVE}/cdx/search/cdx`);
  u.searchParams.set('url', pattern);
  u.searchParams.set('output','json');
  u.searchParams.set('from', String(YEAR));
  u.searchParams.set('to', String(YEAR));
  u.searchParams.append('filter','statuscode:200');
  u.searchParams.set('collapse','digest');
  u.searchParams.set('fl','timestamp,original,mimetype,statuscode,digest,length');
  u.searchParams.set('limit',String(limit));
  return u.toString();
}

function parseCdx(text) {
  const j = JSON.parse(text);
  if (!Array.isArray(j) || !j.length) return [];
  const [h,...rows] = j;
  const ix = (x)=>h.indexOf(x);
  return rows.map((r)=>({ timestamp:r[ix('timestamp')]??'', original:r[ix('original')]??'', mimetype:r[ix('mimetype')]??'', statuscode:r[ix('statuscode')]??'', digest:r[ix('digest')]??'', length:r[ix('length')]??'' }));
}

function replayUrl(row) { return `https://${ARCHIVE}/web/${row.timestamp}id_/${row.original}`; }
function capDate(ts) { return /^\d{14}$/.test(ts) ? `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}` : null; }
function dayDistance(a,b) { return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000); }

function info(original) {
  try {
    const u = new URL(original);
    const params = Object.fromEntries(u.searchParams.entries());
    return {
      pathname:u.pathname,
      type:u.searchParams.get('type'),
      playerType:u.searchParams.get('player_type'),
      groupBy:u.searchParams.get('group_by'),
      csv:u.searchParams.get('csv'),
      hfSea:u.searchParams.get('hfSea'),
      year:u.searchParams.get('year'),
      gameDateGt:u.searchParams.get('game_date_gt'),
      gameDateLt:u.searchParams.get('game_date_lt'),
      chkStatsXwoba:u.searchParams.get('chk_stats_xwoba'),
      chkStatsPa:u.searchParams.get('chk_stats_pa'),
      min:u.searchParams.get('min'),
      filterType:u.searchParams.get('filterType'),
      params,
    };
  } catch { return null; }
}

function has2022(q) {
  if (!q) return false;
  return q.year==='2022' || String(q.hfSea??'').includes('2022') || Object.values(q.params).some((v)=>String(v).includes('2022'));
}

function score(row) {
  const q = info(row.original);
  if (!q) return -999;
  let s=0;
  if (q.pathname.includes('/statcast_search/csv')) s+=20;
  if (String(q.csv).toLowerCase()==='true') s+=18;
  if (q.playerType==='pitcher') s+=12;
  if (q.groupBy==='name') s+=12;
  if (q.chkStatsXwoba==='on') s+=12;
  if (q.chkStatsPa==='on') s+=4;
  if (has2022(q)) s+=10;
  if (q.gameDateLt) s+=8;
  if (q.type==='details') s+=3;
  if (q.pathname.includes('expected_statistics')) s+=8;
  const d=capDate(row.timestamp);
  if (d) s += Math.max(0, 10-Math.min(...ANCHOR_DATES.map((a)=>dayDistance(a,d))));
  return s;
}

function csvHeaders(text) {
  const line=text.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0]??'';
  return line.split(',').map((x)=>x.replace(/^"|"$/g,'').trim());
}
function classifyPayload(text) {
  const html=/^\s*</.test(text);
  const headers=html?[]:csvHeaders(text);
  const lower=headers.map((x)=>x.toLowerCase());
  return {
    html,
    csvish:!html && headers.length>5,
    headers,
    hasPlayerId:lower.includes('player_id')||lower.includes('entity_id'),
    hasPa:lower.includes('pa'),
    hasXwoba:lower.includes('xwoba')||lower.includes('est_woba'),
    hasXera:lower.includes('xera'),
    hasEstimatedWobaEvent:lower.includes('estimated_woba_using_speedangle'),
  };
}

function queryShape(q) {
  if (!q) return 'INVALID';
  return [q.pathname,`type=${q.type}`,`player_type=${q.playerType}`,`group_by=${q.groupBy}`,`csv=${q.csv}`,`hfSea=${q.hfSea}`,`year=${q.year}`,`game_date_lt=${q.gameDateLt}`,`xwoba=${q.chkStatsXwoba}`].join('|');
}

function keywordSnippets(html) {
  const terms=['csv=true','download csv','expected_statistics','statcast_search','leaderboard/services','xera','est_woba'];
  const lower=html.toLowerCase();
  const out=[];
  for (const term of terms) {
    let start=0;
    while (out.length<80) {
      const i=lower.indexOf(term,start);
      if (i<0) break;
      out.push({term, snippet:html.slice(Math.max(0,i-180),Math.min(html.length,i+320)).replace(/\s+/g,' ')});
      start=i+term.length;
    }
  }
  return out;
}

function extractedLinks(html) {
  const out=new Set();
  const attr=/(?:src|href|action|data-[a-z0-9_-]+)\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(attr)) {
    const v=m[1];
    if (/csv|expected_statistics|statcast_search|leaderboard|\.js(?:\?|$)/i.test(v)) out.add(v);
  }
  return [...out].slice(0,150);
}

async function main() {
  const patterns=[
    `${PRIMARY}/statcast_search*`,
    `${PRIMARY}/statcast_search/csv*`,
    `${PRIMARY}/expected_statistics*`,
    `${PRIMARY}/leaderboard/expected_statistics*`,
  ];

  const patternEvidence=[];
  const all=[];
  for (const pattern of patterns) {
    const f=await fetchText(cdxUrl(pattern),'application/json,*/*;q=0.5');
    if (!f.ok) { patternEvidence.push({pattern,ok:false,error:f.error,rowCount:0}); continue; }
    const rows=parseCdx(f.text);
    all.push(...rows);
    patternEvidence.push({pattern,ok:true,error:null,rowCount:rows.length,uniqueOriginals:new Set(rows.map((r)=>r.original)).size});
  }

  const uniq=new Map();
  for (const r of all) uniq.set(`${r.timestamp}\n${r.original}`,r);
  const rows=[...uniq.values()];
  const statcast=rows.filter((r)=>info(r.original)?.pathname.includes('/statcast_search'));
  const expected=rows.filter((r)=>info(r.original)?.pathname.includes('expected_statistics'));

  const shapeCounts=new Map();
  for (const r of statcast) {
    const shape=queryShape(info(r.original));
    shapeCounts.set(shape,(shapeCounts.get(shape)??0)+1);
  }
  const topShapes=[...shapeCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([shape,count])=>({shape,count}));

  const candidateRows=statcast.filter((r)=>{
    const q=info(r.original);
    if (!q) return false;
    return has2022(q) && (
      q.pathname.includes('/csv') || String(q.csv).toLowerCase()==='true' || q.groupBy==='name' || q.chkStatsXwoba==='on' || q.gameDateLt || q.type==='details'
    );
  }).sort((a,b)=>score(b)-score(a) || a.timestamp.localeCompare(b.timestamp));

  const replayRows=[];
  const seenOriginal=new Set();
  for (const r of candidateRows) {
    if (seenOriginal.has(r.original)) continue;
    seenOriginal.add(r.original);
    replayRows.push(r);
    if (replayRows.length>=30) break;
  }

  const replayEvidence=[];
  let csvXwoba=0, csvPaXwoba=0, csvEventEstimatedWoba=0;
  for (const r of replayRows) {
    const f=await fetchText(replayUrl(r),'text/csv,text/plain;q=0.9,text/html;q=0.7,*/*;q=0.3');
    const payload=f.ok?classifyPayload(f.text):{html:false,csvish:false,headers:[],hasPlayerId:false,hasPa:false,hasXwoba:false,hasXera:false,hasEstimatedWobaEvent:false};
    if (payload.csvish && payload.hasXwoba) csvXwoba++;
    if (payload.csvish && payload.hasPa && payload.hasXwoba) csvPaXwoba++;
    if (payload.csvish && payload.hasEstimatedWobaEvent) csvEventEstimatedWoba++;
    replayEvidence.push({ timestamp:r.timestamp,captureDate:capDate(r.timestamp),original:r.original,query:info(r.original),priorityScore:score(r),cdxMimetype:r.mimetype,cdxDigest:r.digest,replayUrl:replayUrl(r),replayOk:f.ok,replayStatus:f.status,replayFinalUrl:f.finalUrl,replayContentType:f.contentType,replayError:f.error,bodySha256:f.ok?sha256(f.text):null,bodyBytes:f.ok?Buffer.byteLength(f.text):0,payload });
  }

  const anchorPages=[];
  for (const timestamp of ['20220503231003','20220523220701','20221023221946']) {
    const matches=expected.filter((r)=>{
      if (r.timestamp!==timestamp) return false;
      const q=info(r.original);
      return q?.year==='2022' && q?.type==='pitcher' && q?.min==='q' && (q?.team??'')==='' && (q?.position??'')==='';
    });
    if (!matches.length) { anchorPages.push({timestamp,found:false}); continue; }
    const r=matches[0];
    const f=await fetchText(replayUrl(r),'text/html,*/*;q=0.5');
    anchorPages.push({ timestamp,found:true,original:r.original,replayUrl:replayUrl(r),replayOk:f.ok,replayStatus:f.status,bodySha256:f.ok?sha256(f.text):null,links:f.ok?extractedLinks(f.text):[],keywordSnippets:f.ok?keywordSnippets(f.text):[] });
  }

  const liveUrls=[
    `https://${PRIMARY}/expected_statistics?type=pitcher&year=2022&position=&team=&min=q&csv=true`,
    `https://${PRIMARY}/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&filterType=pa&min=q&csv=true`,
  ];
  const liveEndpointEvidence=[];
  for (const url of liveUrls) {
    const f=await fetchText(url,'text/csv,text/plain;q=0.9,text/html;q=0.5,*/*;q=0.2');
    const payload=f.ok?classifyPayload(f.text):null;
    liveEndpointEvidence.push({url,ok:f.ok,status:f.status,finalUrl:f.finalUrl,contentType:f.contentType,error:f.error,bodySha256:f.ok?sha256(f.text):null,bodyBytes:f.ok?Buffer.byteLength(f.text):0,payload});
  }

  const exactCsvTrueCount=statcast.filter((r)=>String(info(r.original)?.csv).toLowerCase()==='true').length;
  const groupedNameCount=statcast.filter((r)=>info(r.original)?.groupBy==='name').length;
  const xwobaFlagCount=statcast.filter((r)=>info(r.original)?.chkStatsXwoba==='on').length;
  const dateBoundedCount=statcast.filter((r)=>Boolean(info(r.original)?.gameDateLt||info(r.original)?.gameDateGt)).length;
  const pathCsvCount=statcast.filter((r)=>info(r.original)?.pathname.includes('/statcast_search/csv')).length;

  const evidence={
    schemaVersion:'courtedge-mlb-r1b-statcast-xera-legacy-savant-archive-surface-discovery.v1',
    status:STATUS,
    generatedAt:new Date().toISOString(),
    family:'STATCAST_QUALITY',
    sourceAuthority:{canonicalPublisherHost:PRIMARY,archiveTransportHost:ARCHIVE,archiveTransportIsPublisher:false,replayedPrimaryPublisherContentOnly:true},
    scientificPolicy:{primaryPublisherUrlsOnly:true,noThirdPartyDataAuthority:true,noInterpolationBetweenSnapshots:true,noEmpiricalFitAuthorized:true,approximationForbidden:true,xeraNotUsedToRankCandidates:true,currentLiveEndpointBehaviorIsNotHistoricalCustody:true},
    patternEvidence,
    inventory:{uniqueRows:rows.length,statcastSearchRows:statcast.length,expectedStatisticsRows:expected.length,statcastPathCsvRows:pathCsvCount,statcastCsvTrueRows:exactCsvTrueCount,statcastGroupedNameRows:groupedNameCount,statcastXwobaFlagRows:xwobaFlagCount,statcastDateBoundedRows:dateBoundedCount,candidateRows:candidateRows.length,replaySampleRows:replayRows.length,replayedCsvWithXwobaCount:csvXwoba,replayedCsvWithPaAndXwobaCount:csvPaXwoba,replayedEventCsvWithEstimatedWobaCount:csvEventEstimatedWoba},
    topStatcastQueryShapes:topShapes,
    replayEvidence,
    anchorPageSurfaceEvidence:anchorPages,
    liveEndpointEvidence,
    scientificConclusion:{
      archivedLegacyPrimaryCsvXwobaObserved:csvXwoba>0,
      archivedLegacyPrimaryCsvPaAndXwobaObserved:csvPaXwoba>0,
      archivedLegacyPrimaryEventEstimatedWobaObserved:csvEventEstimatedWoba>0,
      currentExpectedStatsCsvRouteObserved:liveEndpointEvidence.some((x)=>x.payload?.csvish&&x.payload?.hasXwoba),
      completeHistoricalTargetDateCustodyProven:false,
      exactTargetDateXeraCustodyForFullUniverseProven:false,
      exactSavantProductionConversionProven:false,
      familyPromotionAuthorized:false,
      nextGate: csvPaXwoba>0 || csvEventEstimatedWoba>0
        ? 'VALIDATE REPLAYED LEGACY PRIMARY SAVANT PAYLOADS AGAINST SAME-VINTAGE EXPECTED-STAT HTML ANCHORS BY PLAYER/PA/xwOBA WITHOUT INTERPOLATION; THEN QUANTIFY COVERAGE.'
        : 'NO ARCHIVED LEGACY PRIMARY SAVANT xwOBA PAYLOAD WAS PROVEN IN THE TESTED REPLAY SAMPLE; USE ARCHIVED EXPECTED-STAT HTML/ASSET ROUTE EVIDENCE TO IDENTIFY ANY HISTORICAL SERVICE ENDPOINT, OTHERWISE RECORD HISTORICAL INPUT-VINTAGE CUSTODY AS UNPROVEN.',
    },
    scientificBoundary:{researchOnly:true,productionChanged:false,weightsChanged:false,routingChanged:false,stakingChanged:false,betEliteChanged:false,marketPricesRead:false,targetOutcomeReadForModeling:false,automaticBetPlacementAllowed:false,realFinancialExposure:0,r1b2Authorized:false},
  };

  const outArg=process.argv.find((x)=>x.startsWith('--out='));
  const outPath=outArg?.slice(6)||'artifacts/mlb-r1b-statcast-xera-legacy-savant-archive-surface-discovery/evidence.json';
  fs.mkdirSync(path.dirname(outPath),{recursive:true});
  fs.writeFileSync(outPath,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
}

main().catch((e)=>{console.error(e?.stack??String(e));process.exit(1);});
