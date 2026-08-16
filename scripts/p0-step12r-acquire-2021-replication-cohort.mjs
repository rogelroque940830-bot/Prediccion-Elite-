import fs from 'node:fs/promises';
import path from 'node:path';

const nativeFetch = globalThis.fetch.bind(globalThis);

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function isoInstant(v){const t=String(v??'').trim();if(!t)return null;const ms=Date.parse(t);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
function isoDate(v){const t=String(v??'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(t)?t:null;}
function obsolete(g){const coded=String(g?.status?.codedGameState??'').trim().toUpperCase();const detailed=String(g?.status?.detailedState??'').trim();return coded==='D'||/^(Postponed|Canceled|Cancelled|Suspended)$/i.test(detailed);}
function candidate(g,d){return{gamePk:Number(g?.gamePk),officialDate:String(g?.officialDate??d?.date??'').slice(0,10),scheduledStart:isoInstant(g?.gameDate),homeTeamId:Number(g?.teams?.home?.team?.id),awayTeamId:Number(g?.teams?.away?.team?.id),codedGameState:String(g?.status?.codedGameState??'').trim(),detailedState:String(g?.status?.detailedState??'').trim(),resumeDate:isoInstant(g?.resumeDate),resumeGameDate:isoDate(g?.resumeGameDate),resumedFrom:isoInstant(g?.resumedFrom),resumedFromDate:isoDate(g?.resumedFromDate)};}
function exactSuspendedPair(rows){
  if(rows.length!==2)return false;
  const originals=rows.filter(x=>x.resumeDate!=null&&x.resumedFrom==null);
  const resumed=rows.filter(x=>x.resumedFrom!=null&&x.resumeDate==null);
  if(originals.length!==1||resumed.length!==1)return false;
  const o=originals[0],c=resumed[0];
  return o.homeTeamId===c.homeTeamId&&o.awayTeamId===c.awayTeamId
    &&o.officialDate===c.officialDate
    &&o.resumeDate===c.scheduledStart
    &&c.resumedFrom===o.scheduledStart
    &&o.resumeGameDate!=null&&c.resumedFromDate!=null
    &&c.resumedFromDate===o.officialDate
    &&o.codedGameState.toUpperCase()==='F'&&c.codedGameState.toUpperCase()==='F';
}

function normalize2021Schedule(payload){
  const groups=new Map();
  for(const d of Array.isArray(payload?.dates)?payload.dates:[]){
    for(const g of Array.isArray(d?.games)?d.games:[]){
      const pk=positive(g?.gamePk);if(!pk)continue;
      const xs=groups.get(pk)??[];xs.push({raw:g,c:candidate(g,d)});groups.set(pk,xs);
    }
  }
  const normalized=new Set();
  for(const [pk,xs] of groups){
    if(xs.length<3)continue;
    const nonObsolete=xs.filter(x=>!obsolete(x.raw));
    const obsoleteRows=xs.filter(x=>obsolete(x.raw));
    if(obsoleteRows.length>0&&exactSuspendedPair(nonObsolete.map(x=>x.c)))normalized.add(pk);
  }
  if(!normalized.size)return{payload,normalizedGamePks:[],removedRows:0};
  let removed=0;
  const dates=(Array.isArray(payload?.dates)?payload.dates:[]).map(d=>({...d,games:(Array.isArray(d?.games)?d.games:[]).filter(g=>{
    const pk=positive(g?.gamePk);
    if(pk&&normalized.has(pk)&&obsolete(g)){removed+=1;return false;}
    return true;
  })}));
  return{payload:{...payload,dates},normalizedGamePks:[...normalized].sort((a,b)=>a-b),removedRows:removed};
}

function selfTest(){
  const team={home:{team:{id:144}},away:{team:{id:135}}};
  const p={dates:[
    {date:'2021-07-19',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-19T23:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'D',detailedState:'Postponed'}}]},
    {date:'2021-07-21',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-21T21:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumeDate:'2021-09-25T00:10:00Z',resumeGameDate:'2021-09-24'}]},
    {date:'2021-09-24',games:[{gamePk:633224,gameType:'R',gameDate:'2021-09-25T00:10:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumedFrom:'2021-07-21T21:20:00Z',resumedFromDate:'2021-07-21'}]}
  ]};
  const ok=normalize2021Schedule(p);
  if(JSON.stringify(ok.normalizedGamePks)!=='[633224]'||ok.removedRows!==1||ok.payload.dates.flatMap(d=>d.games).length!==2)throw new Error('STEP12R_ACQUIRE_NORMALIZER_SELF_TEST_FAILED');
  const bad=structuredClone(p);bad.dates[2].games[0].resumedFrom='2021-07-21T22:20:00Z';
  const no=normalize2021Schedule(bad);
  if(no.normalizedGamePks.length!==0||no.removedRows!==0||no.payload.dates.flatMap(d=>d.games).length!==3)throw new Error('STEP12R_ACQUIRE_NORMALIZER_FAIL_CLOSED_TEST_FAILED');
  console.log('STEP12R_2021_ACQUIRE_NORMALIZER_SELF_TEST_OK');
}

if(process.argv.includes('--self-test')){selfTest();process.exit(0);}

const start=arg('--start'),end=arg('--end'),outRoot=arg('--out');
if(start!=='2021-03-01'||end!=='2021-10-04')throw new Error('STEP12R_2021_REPLICATION_RANGE_MUST_REMAIN_FROZEN');
if(!outRoot)throw new Error('STEP12R_2021_REPLICATION_OUT_REQUIRED');

const normalization={normalizedGamePks:new Set(),removedRowsAcrossScheduleResponses:0,scheduleResponses:0};
globalThis.fetch=async(input,init)=>{
  const response=await nativeFetch(input,init);const url=String(input);
  if(!response.ok||!url.includes('/v1/schedule?'))return response;
  const body=await response.json();const n=normalize2021Schedule(body);
  normalization.scheduleResponses+=1;
  normalization.removedRowsAcrossScheduleResponses+=n.removedRows;
  for(const pk of n.normalizedGamePks)normalization.normalizedGamePks.add(pk);
  return new Response(JSON.stringify(n.payload),{status:response.status,statusText:response.statusText,headers:response.headers});
};

await import('./p0-step12m-acquire-clean-replication-cohort.mjs');

const normalizedGamePks=[...normalization.normalizedGamePks].sort((a,b)=>a-b);
if(!normalizedGamePks.includes(633224))throw new Error('STEP12R_2021_EXPECTED_SCHEDULE_CONFLICT_NOT_NORMALIZED');
const report={
  schemaVersion:'courtedge-p0-step12r-2021-schedule-normalization.v1',
  scope:'RESEARCH_ONLY_EXTERNAL_INVALIDATOR_REPLICATION_2021',
  policy:'REMOVE_ONLY_EXPLICITLY_OBSOLETE_ROWS_WHEN_REMAINING_ROWS_FORM_EXACT_SUSPENDED_ORIGINAL_RESUMED_PAIR',
  normalizedGamePks,
  removedRowsAcrossScheduleResponses:normalization.removedRowsAcrossScheduleResponses,
  scheduleResponses:normalization.scheduleResponses,
  ambiguousFallbackAllowed:false,
  sportsSignalChanged:false,
  thresholdChanged:false
};
await fs.writeFile(path.join(outRoot,'schedule-normalization.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({ok:true,step12r2021ScheduleNormalization:report},null,2));
