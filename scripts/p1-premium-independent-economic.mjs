import crypto from "node:crypto";
import fs from "node:fs";

const [ledgerPath, outputPath] = process.argv.slice(2);
if (!ledgerPath || !outputPath) throw new Error("USAGE: node scripts/p1-premium-independent-economic.mjs <ledger.jsonl> <output.json>");

const PREMIUM_DEFINED_AT = Date.parse("2026-07-08T05:03:11Z");
const ULTRA_DEFINED_AT = Date.parse("2026-07-11T03:11:19Z");
const STABLE_STACK_AT = Date.parse("2026-07-11T03:50:43Z");
const BINARY = new Set(["WIN", "LOSS"]);
const SETTLED = new Set(["WIN", "LOSS", "PUSH", "VOID", "HALF_WIN", "HALF_LOSS"]);
const BOOTSTRAP_REPS = 5000;
const SEED = 0x5e1ec7ed;

function finite(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function parseMs(v) { if (typeof v !== "string") return null; const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
function round(v, d=6) { if (!Number.isFinite(v)) return null; const f=10**d; return Math.round(v*f)/f; }
function avg(v) { const x=v.filter(Number.isFinite); return x.length?x.reduce((a,b)=>a+b,0)/x.length:null; }
function median(v) { const x=v.filter(Number.isFinite).sort((a,b)=>a-b); if(!x.length)return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; }
function amerProb(o) { if(!Number.isFinite(o)||o===0)return null; return o>0?100/(o+100):Math.abs(o)/(Math.abs(o)+100); }
function winProfit(o) { if(!Number.isFinite(o)||o===0)return null; return o>0?o/100:100/Math.abs(o); }
function flat(r,o){const w=winProfit(o);if(r==="WIN")return w==null?null:{e:1,p:w};if(r==="LOSS")return{e:1,p:-1};if(r==="PUSH")return{e:1,p:0};if(r==="VOID")return{e:0,p:0};if(r==="HALF_WIN")return w==null?null:{e:1,p:w/2};if(r==="HALF_LOSS")return{e:1,p:-.5};return null;}
function month(r){return typeof r.gameDate==="string"?r.gameDate.slice(0,7):"UNKNOWN";}
function dateKey(r){return /^\d{4}-\d{2}-\d{2}$/.test(r.gameDate??"")?r.gameDate:"UNKNOWN";}
function priceBand(o){if(!Number.isFinite(o))return"UNKNOWN";if(o<=-200)return"<=-200";if(o<=-150)return"-199_TO_-150";if(o<=-110)return"-149_TO_-110";if(o<=110)return"-109_TO_+110";if(o<=150)return"+111_TO_+150";if(o<=200)return"+151_TO_+200";return">+200";}
function countBy(rows, fn){const out={};for(const r of rows){const k=String(fn(r)??"UNKNOWN");out[k]=(out[k]||0)+1;}return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));}
function wilson(w,n){if(!n)return null;const z=1.959963984540054,p=w/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return{lowPct:round(Math.max(0,c-m)*100,2),highPct:round(Math.min(1,c+m)*100,2)};}
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function pct(sorted,p){if(!sorted.length)return null;const idx=(sorted.length-1)*p,lo=Math.floor(idx),hi=Math.ceil(idx);if(lo===hi)return sorted[lo];const w=idx-lo;return sorted[lo]*(1-w)+sorted[hi]*w;}
function selectedSurface(p){
  const raw=p?.payload?.analysis?.rawOutput??{};
  return {
    decision:{confidenceLabel:p?.decision?.confidenceLabel??p?.payload?.decision?.confidenceLabel??null,rationale:p?.payload?.decision?.rationale??p?.decision?.rationale??null},
    selectedLane:raw?.selectedLane??null,
    finalRecommendation:raw?.markets?.finalRecommendation??raw?.finalRecommendation??null,
  };
}
function selectedText(surface){return JSON.stringify(surface).toUpperCase();}
function selectedHas(surface,token){const t=selectedText(surface);return new RegExp(`(^|[^A-Z])${token}([^A-Z]|$)`).test(t);}
function gameKey(p){const pk=finite(p?.game?.gamePk);if(pk!=null)return`PK:${pk}`;const s=`${p?.game?.gameDate??"?"}|${p?.game?.homeTeam??"?"}|${p?.game?.awayTeam??"?"}`;return`FALLBACK:${crypto.createHash("sha256").update(s).digest("hex").slice(0,16)}`;}
function terminalPerGame(rows){const m=new Map();for(const r of rows){const old=m.get(r.gameKey);if(!old||(r.recordedMs??-Infinity)>(old.recordedMs??-Infinity))m.set(r.gameKey,r);}return [...m.values()];}
function score(r){if(!BINARY.has(r.result)||!Number.isFinite(r.modelProb))return null;const y=r.result==="WIN"?1:0,p=Math.min(.999999,Math.max(.000001,r.modelProb));return{brier:(p-y)**2,logLoss:-(y*Math.log(p)+(1-y)*Math.log(1-p))};}
function leaf(rows){const b=rows.filter(r=>BINARY.has(r.result)),s=rows.filter(r=>SETTLED.has(r.result));const w=b.filter(r=>r.result==="WIN").length;let e=0,p=0;for(const r of s){const x=flat(r.result,r.odds);if(x){e+=x.e;p+=x.p;}}return{records:rows.length,settled:s.length,wins:w,losses:b.filter(r=>r.result==="LOSS").length,hitRatePct:b.length?round(w/b.length*100,2):null,profitUnits:round(p,4),roiPct:e?round(p/e*100,2):null};}
function metrics(rows){
  const settled=rows.filter(r=>SETTLED.has(r.result)),binary=rows.filter(r=>BINARY.has(r.result));
  const wins=binary.filter(r=>r.result==="WIN").length;
  let exposure=0,profit=0,cum=0,peak=0,dd=0,ls=0,maxLs=0;
  for(const r of [...settled].sort((a,b)=>(a.recordedMs??0)-(b.recordedMs??0))){const x=flat(r.result,r.odds);if(!x)continue;exposure+=x.e;profit+=x.p;cum+=x.p;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);if(x.p<0){ls++;maxLs=Math.max(maxLs,ls);}else if(x.p>0)ls=0;}
  const scored=binary.map(score).filter(Boolean),clv=settled.map(r=>r.clv).filter(Number.isFinite);
  return{
    records:rows.length,uniqueGames:new Set(rows.map(r=>r.gameKey)).size,uniqueDates:new Set(rows.map(dateKey)).size,settled:settled.length,pending:rows.filter(r=>!SETTLED.has(r.result)).length,
    wins,losses:binary.filter(r=>r.result==="LOSS").length,hitRatePct:binary.length?round(wins/binary.length*100,3):null,winRateWilson95:wilson(wins,binary.length),
    exposureUnits:round(exposure,4),profitUnits:round(profit,4),roiPct:exposure?round(profit/exposure*100,3):null,maxDrawdownUnits:round(dd,4),longestLosingStreak:maxLs,
    meanEntryImpliedPct:settled.length?round(avg(settled.map(r=>amerProb(r.odds)))*100,3):null,medianOddsAmerican:median(settled.map(r=>r.odds)),meanModelProbabilityPct:binary.length?round(avg(binary.map(r=>r.modelProb))*100,3):null,
    brier:scored.length?round(avg(scored.map(x=>x.brier)),6):null,logLoss:scored.length?round(avg(scored.map(x=>x.logLoss)),6):null,
    clvCoveragePct:settled.length?round(clv.length/settled.length*100,2):null,meanClvPp:clv.length?round(avg(clv),4):null,positiveClvPct:clv.length?round(clv.filter(v=>v>0).length/clv.length*100,2):null,
    stages:countBy(rows,r=>r.stage),modelVersions:countBy(rows,r=>r.modelVersion),months:Object.fromEntries([...new Set(rows.map(month))].sort().map(k=>[k,leaf(rows.filter(r=>month(r)===k))])),priceBands:Object.fromEntries([...new Set(rows.map(r=>priceBand(r.odds)))].sort().map(k=>[k,leaf(rows.filter(r=>priceBand(r.odds)===k))])),
  };
}
function roi(rows){let e=0,p=0;for(const r of rows){if(!SETTLED.has(r.result))continue;const x=flat(r.result,r.odds);if(x){e+=x.e;p+=x.p;}}return e?p/e:null;}
function hit(rows){const b=rows.filter(r=>BINARY.has(r.result));return b.length?b.filter(r=>r.result==="WIN").length/b.length:null;}
function meanClv(rows){return avg(rows.filter(r=>SETTLED.has(r.result)).map(r=>r.clv));}
function proper(rows,key){const a=rows.filter(r=>BINARY.has(r.result)).map(score).filter(Boolean);return a.length?avg(a.map(x=>x[key])):null;}
function clusterBootstrap(a,b){
  const all=[...a,...b],dates=[...new Set(all.map(dateKey).filter(x=>x!=="UNKNOWN"))].sort();
  if(dates.length<2)return null;
  const byA=new Map(dates.map(d=>[d,a.filter(r=>dateKey(r)===d)])),byB=new Map(dates.map(d=>[d,b.filter(r=>dateKey(r)===d)]));
  const random=rng(SEED),roiA=[],roiB=[],roiDiff=[],hitDiff=[],clvDiff=[],brierDiff=[],logLossDiff=[];
  for(let rep=0;rep<BOOTSTRAP_REPS;rep++){
    const aa=[],bb=[];for(let i=0;i<dates.length;i++){const d=dates[Math.floor(random()*dates.length)];aa.push(...(byA.get(d)||[]));bb.push(...(byB.get(d)||[]));}
    const ra=roi(aa),rb=roi(bb),ha=hit(aa),hb=hit(bb),ca=meanClv(aa),cb=meanClv(bb),ba=proper(aa,"brier"),bc=proper(bb,"brier"),la=proper(aa,"logLoss"),lb=proper(bb,"logLoss");
    if(ra!=null)roiA.push(ra);if(rb!=null)roiB.push(rb);if(ra!=null&&rb!=null)roiDiff.push(ra-rb);if(ha!=null&&hb!=null)hitDiff.push(ha-hb);if(ca!=null&&cb!=null)clvDiff.push(ca-cb);if(ba!=null&&bc!=null)brierDiff.push(bc-ba);if(la!=null&&lb!=null)logLossDiff.push(lb-la);
  }
  const ci=x=>{const s=[...x].sort((a,b)=>a-b);return s.length?{low:round(pct(s,.025)*100,3),median:round(pct(s,.5)*100,3),high:round(pct(s,.975)*100,3),replicates:s.length}:null};
  const ciRaw=x=>{const s=[...x].sort((a,b)=>a-b);return s.length?{low:round(pct(s,.025),6),median:round(pct(s,.5),6),high:round(pct(s,.975),6),replicates:s.length}:null};
  return{dateClusters:dates.length,bootstrapReplicates:BOOTSTRAP_REPS,premiumRoiPct95:ci(roiA),controlRoiPct95:ci(roiB),premiumMinusControlRoiPp95:ci(roiDiff),premiumMinusControlHitRatePp95:ci(hitDiff),premiumMinusControlClvPp95:ciRaw(clvDiff),controlMinusPremiumBrier95:ciRaw(brierDiff),controlMinusPremiumLogLoss95:ciRaw(logLossDiff)};
}

const raw=fs.readFileSync(ledgerPath,"utf8");
const records=raw.split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line)}catch{throw new Error(`BAD_JSON:${i+1}`)}});
const rows=[];
for(const rec of records){
  const p=rec?.prediction;if(!p||p.market?.type!=="F5_ML")continue;
  const recordedMs=parseMs(p.recordedAt),commenceMs=parseMs(p.game?.commenceTime);
  if(recordedMs==null||commenceMs==null||recordedMs>=commenceMs||p.source!=="app")continue;
  const surface=selectedSurface(p),premium=selectedHas(surface,"PREMIUM"),ultra=selectedHas(surface,"ULTRA");
  const s=rec?.settlement??null;
  rows.push({gameKey:gameKey(p),gameDate:p.game?.gameDate??"UNKNOWN",selection:p.market?.selection??null,odds:finite(p.market?.oddsAmerican),recordedMs,modelProb:finite(p.probabilities?.model),stage:p.analysisStage??p.payload?.analysis?.stage??null,modelVersion:p.model?.version??null,gitCommit:p.model?.gitCommit??null,premium,ultra,result:s?.result??null,clv:finite(s?.clvPp),settlementSource:s?.source??null});
}

const terminalPremiumEra=terminalPerGame(rows.filter(r=>r.recordedMs>=PREMIUM_DEFINED_AT));
const terminalStableStack=terminalPerGame(rows.filter(r=>r.recordedMs>=STABLE_STACK_AT));
const premiumStable=terminalStableStack.filter(r=>r.premium),controlStable=terminalStableStack.filter(r=>!r.premium);
const ultraStable=terminalStableStack.filter(r=>r.ultra),premiumUltraStable=terminalStableStack.filter(r=>r.premium&&r.ultra),premiumOnlyStable=terminalStableStack.filter(r=>r.premium&&!r.ultra),neitherStable=terminalStableStack.filter(r=>!r.premium&&!r.ultra);
const inference=clusterBootstrap(premiumStable,controlStable);
const pm=metrics(premiumStable),cm=metrics(controlStable);
const criteria={minimumPremiumGames50:pm.uniqueGames>=50,minimumPremiumDates20:pm.uniqueDates>=20,premiumRoiLower95Positive:(inference?.premiumRoiPct95?.low??-Infinity)>0,premiumMinusControlRoiLower95Positive:(inference?.premiumMinusControlRoiPp95?.low??-Infinity)>0,meanClvPositive:(pm.meanClvPp??-Infinity)>0,properScoringNotWorse:(pm.logLoss??Infinity)<=(cm.logLoss??-Infinity)&&(pm.brier??Infinity)<=(cm.brier??-Infinity)};
const supported=Object.values(criteria).every(Boolean);
const result={
  schemaVersion:"p1-premium-independent-economic.v1",generatedAt:new Date().toISOString(),source:{rawExportSha256:crypto.createHash("sha256").update(raw).digest("hex"),rawUploaded:false,ledgerRecords:records.length},
  preregistration:{primaryCohort:"one latest pregame app F5_ML decision per game after F9 stable-stack timestamp 2026-07-11T03:50:43Z",primaryExposure:"selected recommendation PREMIUM vs selected recommendation non-PREMIUM",selectedLabelSurface:["decision.confidenceLabel","decision.rationale","analysis.rawOutput.selectedLane","analysis.rawOutput.markets.finalRecommendation"],excludedFromLabelDetection:["alternativePicks","altLines","non-selected payload strings"],bootstrap:"5000 deterministic game-date cluster bootstrap replicates",economicSupportCriteria:criteria},
  coverage:{allEligibleF5Captures:rows.length,terminalGamesSincePremiumDefinition:terminalPremiumEra.length,terminalGamesStableStack:terminalStableStack.length,selectedPremiumStable:premiumStable.length,selectedControlStable:controlStable.length,selectedUltraStable:ultraStable.length},
  primary:{premium:pm,control:cm,inference,criteria,researchDecision:supported?"PREMIUM_ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY":"PREMIUM_ECONOMIC_EDGE_NOT_CERTIFIED"},
  descriptiveSubgroups:{premiumAndUltra:metrics(premiumUltraStable),premiumWithoutUltra:metrics(premiumOnlyStable),ultraAny:metrics(ultraStable),neitherPremiumNorUltra:metrics(neitherStable)},
  temporalSensitivity:{premiumEraAllTerminal:{premium:metrics(terminalPremiumEra.filter(r=>r.premium)),control:metrics(terminalPremiumEra.filter(r=>!r.premium))},stableStackStart:"2026-07-11T03:50:43Z",ultraDefinition:"2026-07-11T03:11:19Z"},
  guards:{terminalGameUnit:true,noDuplicateCapturesInPrimary:true,noOutcomeUsedForLabelMembership:true,alternativePicksExcluded:true,priceBandsDescriptiveOnly:true,ultraSubgroupsDescriptiveOnly:true,noAutomaticThresholdChange:true,noAutomaticModelChange:true,noAutomaticPromotion:true,noBettingAutomation:true},
  safety:{readOnly:true,rawOwnerLedgerPersistedInArtifact:false,predictionsCreated:0,settlementsCreated:0,betsPlaced:0,realFinancialExposure:0},
};
fs.writeFileSync(outputPath,JSON.stringify(result,null,2));
console.log(JSON.stringify({coverage:result.coverage,primary:result.primary,descriptiveSubgroups:result.descriptiveSubgroups},null,2));