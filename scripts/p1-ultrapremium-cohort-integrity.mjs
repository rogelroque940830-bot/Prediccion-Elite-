import crypto from "node:crypto";
import fs from "node:fs";

const [ledgerPath, outputPath] = process.argv.slice(2);
if (!ledgerPath || !outputPath) throw new Error("USAGE: node scripts/p1-ultrapremium-cohort-integrity.mjs <ledger.jsonl> <output.json>");

const ULTRA_DEFINED_AT = Date.parse("2026-07-11T03:11:19Z");
const BINARY = new Set(["WIN", "LOSS"]);
const SETTLED = new Set(["WIN", "LOSS", "PUSH", "VOID", "HALF_WIN", "HALF_LOSS"]);

function finite(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ms(v) { if (typeof v !== "string") return null; const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
function round(v, d = 4) { if (!Number.isFinite(v)) return null; const f = 10 ** d; return Math.round(v * f) / f; }
function avg(a) { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; }
function med(a) { const x = a.filter(Number.isFinite).sort((a,b)=>a-b); if (!x.length) return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; }
function americanProb(o) { if (!Number.isFinite(o) || o===0) return null; return o>0 ? 100/(o+100) : Math.abs(o)/(Math.abs(o)+100); }
function winProfit(o) { if (!Number.isFinite(o) || o===0) return null; return o>0 ? o/100 : 100/Math.abs(o); }
function flat(result, odds) {
  const wp=winProfit(odds);
  if (result==="WIN") return wp==null?null:{e:1,p:wp};
  if (result==="LOSS") return {e:1,p:-1};
  if (result==="PUSH") return {e:1,p:0};
  if (result==="VOID") return {e:0,p:0};
  if (result==="HALF_WIN") return wp==null?null:{e:1,p:wp/2};
  if (result==="HALF_LOSS") return {e:1,p:-0.5};
  return null;
}
function wilson(w,t){ if(!t)return null; const z=1.959963984540054,p=w/t,d=1+z*z/t,c=(p+z*z/(2*t))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*t))/t)/d; return {lowPct:round(Math.max(0,c-m)*100,2),highPct:round(Math.min(1,c+m)*100,2)}; }
function strings(v,out=[]){ if(typeof v==="string")out.push(v); else if(Array.isArray(v))v.forEach(x=>strings(x,out)); else if(v&&typeof v==="object")Object.values(v).forEach(x=>strings(x,out)); return out; }
function countBy(rows,fn){ const o={}; for(const r of rows){const k=String(fn(r)??"UNKNOWN");o[k]=(o[k]||0)+1;} return Object.fromEntries(Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))); }
function month(r){return typeof r.gameDate==="string"&&/^\d{4}-\d{2}/.test(r.gameDate)?r.gameDate.slice(0,7):"UNKNOWN";}
function day(r){return typeof r.gameDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(r.gameDate)?r.gameDate:"UNKNOWN";}
function band(o){if(!Number.isFinite(o))return"UNKNOWN";if(o<=-200)return"<=-200";if(o<=-150)return"-199_TO_-150";if(o<=-110)return"-149_TO_-110";if(o<=110)return"-109_TO_+110";if(o<=150)return"+111_TO_+150";if(o<=200)return"+151_TO_+200";return">+200";}
function provenance(r){return [r.modelName||"?",r.modelVersion||"?",r.gitCommit||"?",r.environment||"?"].join("|");}
function decisionKey(r){return `${r.gameKey}|${r.market}|${r.selection}|${r.line ?? "NA"}`;}

function leaf(rows){
  const binary=rows.filter(r=>BINARY.has(r.result));
  const settled=rows.filter(r=>SETTLED.has(r.result));
  const wins=binary.filter(r=>r.result==="WIN").length;
  let e=0,p=0;
  for(const r of settled){const x=flat(r.result,r.odds);if(x){e+=x.e;p+=x.p;}}
  return {records:rows.length,settled:settled.length,wins,losses:binary.filter(r=>r.result==="LOSS").length,hitRatePct:binary.length?round(wins/binary.length*100,2):null,profitUnits:round(p,4),roiPct:e?round(p/e*100,2):null};
}

function summary(rows){
  const settled=rows.filter(r=>SETTLED.has(r.result));
  const binary=rows.filter(r=>BINARY.has(r.result));
  const wins=binary.filter(r=>r.result==="WIN").length;
  let e=0,p=0,cum=0,peak=0,dd=0,ls=0,maxLs=0;
  for(const r of [...settled].sort((a,b)=>(a.recordedMs??0)-(b.recordedMs??0))){const x=flat(r.result,r.odds);if(!x)continue;e+=x.e;p+=x.p;cum+=x.p;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);if(x.p<0){ls++;maxLs=Math.max(maxLs,ls);}else if(x.p>0)ls=0;}
  const clv=settled.map(r=>r.clv).filter(Number.isFinite);
  const lead=rows.map(r=>r.leadMinutes).filter(Number.isFinite);
  return {
    records:rows.length,
    uniqueGames:new Set(rows.map(r=>r.gameKey)).size,
    uniqueDecisionKeys:new Set(rows.map(decisionKey)).size,
    settled:settled.length,
    wins,
    losses:binary.filter(r=>r.result==="LOSS").length,
    hitRatePct:binary.length?round(wins/binary.length*100,3):null,
    wilson95:wilson(wins,binary.length),
    exposureUnits:round(e,4),
    profitUnits:round(p,4),
    roiPct:e?round(p/e*100,3):null,
    maxDrawdownUnits:round(dd,4),
    longestLosingStreak:maxLs,
    meanOddsImpliedPct:settled.length?round(avg(settled.map(r=>americanProb(r.odds)))*100,3):null,
    medianOddsAmerican:med(settled.map(r=>r.odds)),
    meanModelProbabilityPct:binary.length?round(avg(binary.map(r=>r.modelProb))*100,3):null,
    meanClvPp:clv.length?round(avg(clv),4):null,
    positiveClvPct:clv.length?round(clv.filter(v=>v>0).length/clv.length*100,2):null,
    leadTimeMinutes:lead.length?{min:round(Math.min(...lead),2),median:round(med(lead),2),max:round(Math.max(...lead),2)}:null,
    months:Object.fromEntries([...new Set(rows.map(month))].sort().map(k=>[k,leaf(rows.filter(r=>month(r)===k))])),
    priceBands:Object.fromEntries([...new Set(rows.map(r=>band(r.odds)))].sort().map(k=>[k,leaf(rows.filter(r=>band(r.odds)===k))])),
    stages:countBy(rows,r=>r.stage),
    modelProvenance:countBy(rows,provenance),
    settlementSources:countBy(rows,r=>r.settlementSource),
  };
}

function onePer(rows,keyFn,which="latest"){
  const m=new Map();
  for(const r of rows){const k=keyFn(r);const old=m.get(k);if(!old){m.set(k,r);continue;} const oldMs=old.recordedMs??-Infinity,newMs=r.recordedMs??-Infinity; if(which==="latest"?newMs>oldMs:newMs<oldMs)m.set(k,r);}
  return [...m.values()];
}

const raw=fs.readFileSync(ledgerPath,"utf8");
const records=raw.split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line)}catch{throw new Error(`BAD_JSON:${i+1}`)}});
const rows=[];
for(const rec of records){
  const p=rec?.prediction;if(!p)continue;
  const s=rec?.settlement??null;
  const ss=strings(p).map(x=>x.toUpperCase());
  const ultra=ss.some(x=>/(^|[^A-Z])ULTRA([^A-Z]|$)/.test(x));
  const premium=ss.some(x=>/(^|[^A-Z])PREMIUM([^A-Z]|$)/.test(x));
  const market=p.market?.type??null;
  if(market!=="F5_ML")continue;
  const recordedMs=ms(p.recordedAt),commenceMs=ms(p.game?.commenceTime);
  const gamePk=finite(p.game?.gamePk);
  const fallbackGameKey=`${p.game?.gameDate??"?"}|${p.game?.homeTeam??"?"}|${p.game?.awayTeam??"?"}`;
  rows.push({
    ultra,premium,
    gameKey:gamePk!=null?`PK:${gamePk}`:`FALLBACK:${crypto.createHash("sha256").update(fallbackGameKey).digest("hex").slice(0,16)}`,
    gameDate:p.game?.gameDate??null,
    market,
    selection:p.market?.selection??null,
    line:finite(p.market?.line),
    odds:finite(p.market?.oddsAmerican),
    modelProb:finite(p.probabilities?.model),
    recordedAt:p.recordedAt??null,recordedMs,
    commenceMs,
    leadMinutes:recordedMs!=null&&commenceMs!=null&&recordedMs<commenceMs?(commenceMs-recordedMs)/60000:null,
    pregame:recordedMs!=null&&commenceMs!=null&&recordedMs<commenceMs,
    source:p.source??null,
    stage:p.analysisStage??p.payload?.analysis?.stage??null,
    supersedesId:p.supersedesId??null,
    modelName:p.model?.name??null,
    modelVersion:p.model?.version??null,
    gitCommit:p.model?.gitCommit??null,
    environment:p.model?.environment??null,
    result:s?.result??null,
    settlementSource:s?.source??null,
    settlementRecordedAt:s?.recordedAt??null,
    clv:finite(s?.clvPp),
    closingOdds:finite(s?.closingOddsAmerican),
    labelSignature:[ultra?"ULTRA":null,premium?"PREMIUM":null,ss.some(x=>x.includes("IMPLOSION"))?"IMPLOSION":null,ss.some(x=>x.includes("STRONG_EARLY"))?"STRONG_EARLY":null].filter(Boolean).join("+")||"NONE",
  });
}

const prospectiveUltra=rows.filter(r=>r.ultra&&r.recordedMs>=ULTRA_DEFINED_AT&&r.pregame&&r.source==="app");
const july=prospectiveUltra.filter(r=>month(r)==="2026-07");
const august=prospectiveUltra.filter(r=>month(r)==="2026-08");

const gameGroups=new Map();
for(const r of prospectiveUltra){const a=gameGroups.get(r.gameKey)||[];a.push(r);gameGroups.set(r.gameKey,a);}
const duplicateProfile={
  uniqueGames:gameGroups.size,
  gamesWithMultipleUltraCaptures:[...gameGroups.values()].filter(a=>a.length>1).length,
  gamesWithMultipleUltraSelections:[...gameGroups.values()].filter(a=>new Set(a.map(r=>r.selection)).size>1).length,
  gamesWithMixedUltraResults:[...gameGroups.values()].filter(a=>new Set(a.map(r=>r.result).filter(Boolean)).size>1).length,
  capturesPerGame:countBy([...gameGroups.values()],a=>a.length),
};

const allProspectiveF5=rows.filter(r=>r.recordedMs>=ULTRA_DEFINED_AT&&r.pregame&&r.source==="app");
const terminalF5PerGame=onePer(allProspectiveF5,r=>r.gameKey,"latest");
const terminalUltra=terminalF5PerGame.filter(r=>r.ultra);
const earliestUltraPerGame=onePer(prospectiveUltra,r=>r.gameKey,"earliest");
const latestUltraPerGame=onePer(prospectiveUltra,r=>r.gameKey,"latest");
const latestUltraPerDecision=onePer(prospectiveUltra,decisionKey,"latest");
const latestFinalUltraPerGame=onePer(prospectiveUltra.filter(r=>r.stage==="FINAL"),r=>r.gameKey,"latest");

function provenanceCross(rows){
  const out={};
  for(const r of rows){const k=provenance(r);if(!out[k])out[k]={records:0,july:0,august:0,wins:0,losses:0};out[k].records++;if(month(r)==="2026-07")out[k].july++;if(month(r)==="2026-08")out[k].august++;if(r.result==="WIN")out[k].wins++;if(r.result==="LOSS")out[k].losses++;}
  return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1].records-a[1].records));
}

const daily=Object.fromEntries([...new Set(prospectiveUltra.map(day))].sort().map(d=>[d,leaf(prospectiveUltra.filter(r=>day(r)===d))]));
const result={
  schemaVersion:"p1-ultrapremium-cohort-integrity.v1",
  generatedAt:new Date().toISOString(),
  source:{rawExportSha256:crypto.createHash("sha256").update(raw).digest("hex"),rawUploaded:false,totalLedgerRecords:records.length},
  allF5Records:rows.length,
  prospectiveUltraRaw:summary(prospectiveUltra),
  monthContrast:{july:summary(july),august:summary(august)},
  independence:{
    duplicateProfile,
    earliestUltraPerGame:summary(earliestUltraPerGame),
    latestUltraPerGame:summary(latestUltraPerGame),
    latestUltraPerDecision:summary(latestUltraPerDecision),
    terminalF5PerGameThatIsUltra:summary(terminalUltra),
    latestFinalUltraPerGame:summary(latestFinalUltraPerGame),
  },
  provenance:{
    allProspectiveUltra:provenanceCross(prospectiveUltra),
    july:provenanceCross(july),
    august:provenanceCross(august),
    labelSignatures:countBy(prospectiveUltra,r=>r.labelSignature),
    stagesByMonth:{july:countBy(july,r=>r.stage),august:countBy(august,r=>r.stage)},
    settlementSourcesByMonth:{july:countBy(july,r=>r.settlementSource),august:countBy(august,r=>r.settlementSource)},
  },
  daily,
  integrityFlags:{
    rawNEqualsIndependentGameN:prospectiveUltra.length===gameGroups.size,
    julyAugustPerformanceStable:false,
    exactRuleInputsPresent:false,
    economicCertificationAllowed:false,
    reason:"This stage tests cohort independence/provenance only. A large temporal regime shift or duplicate/revision structure must be explained before any money gate is authorized.",
  },
  safety:{readOnly:true,rawOwnerLedgerPersistedInArtifact:false,predictionsCreated:0,settlementsCreated:0,betsPlaced:0,realFinancialExposure:0},
};

fs.writeFileSync(outputPath,JSON.stringify(result,null,2));
console.log(JSON.stringify({
  rawUltra:result.prospectiveUltraRaw,
  duplicateProfile,
  earliestUltraPerGame:result.independence.earliestUltraPerGame,
  latestUltraPerGame:result.independence.latestUltraPerGame,
  terminalUltra:result.independence.terminalF5PerGameThatIsUltra,
  modelProvenance:result.provenance.allProspectiveUltra,
},null,2));