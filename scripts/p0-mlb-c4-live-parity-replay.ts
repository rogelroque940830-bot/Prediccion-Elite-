import fs from "node:fs/promises";
import path from "node:path";
import { MLB_C4_FEATURE_NAMES, produceMlbC4LiveFeatures } from "../server/mlb-c4-live-feature-producer";

const H = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"] as const;
const arg = (n:string) => { const i=process.argv.indexOf(n); return i<0?null:process.argv[i+1]??null; };
const load = async (f:string) => JSON.parse(await fs.readFile(f,"utf8"));
const finite = (v:any):v is number => typeof v==="number" && Number.isFinite(v);
function push<K,V>(m:Map<K,V[]>,k:K,v:V){ const a=m.get(k)??[]; a.push(v); m.set(k,a); }
function pitch(x:any){ return {battersFaced:x?.battersFaced==null?null:Number(x.battersFaced),earnedRuns:Number(x?.earnedRuns??0),strikeOuts:Number(x?.strikeOuts??0),baseOnBalls:Number(x?.baseOnBalls??0),homeRuns:Number(x?.homeRuns??0)}; }
function apps(t:number,o:number[],m:Map<string,number>){ return Object.fromEntries(o.map(p=>[String(p),m.get(`${t}:${p}`)??0])); }

function checkSchemas(d:any,s:any,l:any,a:any,c:any){
  if(d?.schemaVersion!=="courtedge-p1-m6a3b1-historical-dataset.v1") throw new Error("C4_DATASET_SCHEMA_DRIFT");
  if(s?.schemaVersion!=="courtedge-p1-m6a3b2b1-starting-pitcher-history.v1") throw new Error("C4_STARTER_SCHEMA_DRIFT");
  if(l?.schemaVersion!=="courtedge-p0-step12m-cohort-pregame-lineups.v1") throw new Error("C4_LINEUP_SCHEMA_DRIFT");
  if(a?.schemaVersion!=="courtedge-p0-step12h-t5-starter-identity-audit.v1") throw new Error("C4_AUDIT_SCHEMA_DRIFT");
  if(c?.schemaVersion!=="courtedge-p0-step12v-game-anatomy-feature-table.v1") throw new Error("C4_REFERENCE_SCHEMA_DRIFT");
}

function replay(d:any,s:any,l:any,a:any){
  const obs=new Map<string,any>(); for(const r of d.observations??[]) if((H as readonly string[]).includes(r.horizon)) obs.set(`${Number(r.gamePk)}:${r.horizon}`,r);
  const full=[...obs.values()].filter(r=>r.horizon==="FULL_GAME").sort((x,y)=>String(x.officialDate).localeCompare(String(y.officialDate))||Number(x.gamePk)-Number(y.gamePk));
  const byDate=new Map<string,any[]>(); for(const r of full) push(byDate,String(r.officialDate),r);
  const starters=new Map<number,any>((s.games??[]).map((g:any)=>[Number(g.gamePk),g]));
  const lineups=new Map<number,any>((l.snapshots??[]).map((x:any)=>[Number(x.gamePk),x]));
  const audits=new Map<number,any>((a.rows??[]).map((x:any)=>[Number(x.gamePk),x]));
  const th=new Map<number,any[]>(), ph=new Map<number,any[]>(), pa=new Map<string,number>(), tg=new Map<number,number>(); const league:any[]=[]; const out:any[]=[];
  for(const date of [...byDate.keys()].sort()){
    const games=[...(byDate.get(date)??[])].sort((x,y)=>Number(x.gamePk)-Number(y.gamePk));
    for(const r of games){
      const g=Number(r.gamePk); if(!H.every(h=>obs.has(`${g}:${h}`))) continue;
      const ht=Number(r.homeTeamId), at=Number(r.awayTeamId), au=audits.get(g), li=lineups.get(g);
      const av=Boolean(au?.identityOk&&au?.sourceHistorical&&au?.pregame), pk=Boolean(av&&au?.probableBothKnown), lc=Boolean(li?.complete);
      const ho=lc?(li.homeBattingOrder??[]).map(Number):[], ao=lc?(li.awayBattingOrder??[]).map(Number):[];
      const hp=pk?Number(au.homeProbablePitcherId):null, ap=pk?Number(au.awayProbablePitcherId):null;
      const f=produceMlbC4LiveFeatures({auditValid:av,probableBothKnown:pk,lineupComplete:lc,homeTeamHistory:th.get(ht)??[],awayTeamHistory:th.get(at)??[],homeStarterHistory:hp==null?[]:ph.get(hp)??[],awayStarterHistory:ap==null?[]:ph.get(ap)??[],leaguePitcherHistory:league,homeTeamPriorGames:tg.get(ht)??0,awayTeamPriorGames:tg.get(at)??0,homeBattingOrder:ho,awayBattingOrder:ao,homePlayerPriorApps:apps(ht,ho,pa),awayPlayerPriorApps:apps(at,ao,pa)});
      out.push({gamePk:g,officialDate:date,features:f.values});
    }
    for(const r of games){
      const g=Number(r.gamePk), ht=Number(r.homeTeamId), at=Number(r.awayTeamId), hr=Number(r.homeRuns), ar=Number(r.awayRuns), hw=hr>ar?1:0;
      push(th,ht,{rs:hr,ra:ar,win:hw}); push(th,at,{rs:ar,ra:hr,win:1-hw});
      const sg=starters.get(g); if(sg) for(const k of ["homeStarter","awayStarter"]){ const raw=sg[k], line=pitch(raw); push(ph,Number(raw.pitcherId),line); league.push(line); }
      const li=lineups.get(g), au=audits.get(g), av=Boolean(au?.identityOk&&au?.sourceHistorical&&au?.pregame);
      if(av&&li?.complete) for(const [t,k] of [[ht,"homeBattingOrder"],[at,"awayBattingOrder"]] as const) for(const x of li[k]??[]){ const key=`${t}:${Number(x)}`; pa.set(key,(pa.get(key)??0)+1); }
      tg.set(ht,(tg.get(ht)??0)+1); tg.set(at,(tg.get(at)??0)+1);
    }
  }
  return out;
}

async function main(){
  const root=arg("--root"), cp=arg("--contract"), outp=arg("--out"); if(!root||!cp||!outp) throw new Error("C4_PARITY_ARGS_REQUIRED");
  const c=await load(cp); if(c.schemaVersion!=="courtedge-p0-mlb-c4-live-parity-contract.v1") throw new Error("C4_CONTRACT_DRIFT");
  if(JSON.stringify(c.frozenC4.features)!==JSON.stringify(MLB_C4_FEATURE_NAMES)) throw new Error("C4_FEATURE_SET_DRIFT");
  const tol=Number(c.replay.numericAbsoluteTolerance); if(tol!==1e-12) throw new Error("C4_TOLERANCE_DRIFT");
  const stats:any=Object.fromEntries(MLB_C4_FEATURE_NAMES.map(f=>[f,{compared:0,missingnessMismatches:0,numericMismatches:0,maxAbsError:0}]));
  const seasons:any[]=[], first:any[]=[]; let canonN=0,replayN=0,rowMismatch=0;
  for(const season of c.replay.seasons as string[]){
    const r=path.join(root,season), d=await load(path.join(r,"cohort/dataset.json")), s=await load(path.join(r,"cohort/starting-pitcher-history.json")), l=await load(path.join(r,"cohort/pregame-lineup-history.json")), a=await load(path.join(r,"t5-audit/t5-starter-identity-audit.json")), ref=await load(path.join(r,"game-anatomy-feature-table.json")); checkSchemas(d,s,l,a,ref);
    const got=replay(d,s,l,a), cm=new Map<number,any>((ref.rows??[]).map((x:any)=>[Number(x.gamePk),x])), gm=new Map<number,any>(got.map((x:any)=>[x.gamePk,x])); canonN+=cm.size; replayN+=gm.size; let sr=0;
    for(const g of [...new Set([...cm.keys(),...gm.keys()])].sort((x,y)=>x-y)){
      const e=cm.get(g), z=gm.get(g); if(!e||!z){rowMismatch++;sr++;if(first.length<20)first.push({season,gamePk:g,kind:e?"REPLAY_ROW_MISSING":"UNEXPECTED_REPLAY_ROW"});continue;}
      for(const f of MLB_C4_FEATURE_NAMES){ const st=stats[f], ev=e.features?.[f], av=z.features?.[f], ep=finite(ev), ap=finite(av); st.compared++; if(ep!==ap){st.missingnessMismatches++;if(first.length<20)first.push({season,gamePk:g,feature:f,kind:"MISSINGNESS",expected:ep?ev:null,actual:ap?av:null});continue;} if(!ep)continue; const er=Math.abs(ev-av); st.maxAbsError=Math.max(st.maxAbsError,er); if(er>tol){st.numericMismatches++;if(first.length<20)first.push({season,gamePk:g,feature:f,kind:"NUMERIC",expected:ev,actual:av,absError:er});} }
    }
    seasons.push({season,canonicalRows:cm.size,replayRows:gm.size,rowIdentityMismatches:sr});
  }
  const byFeature:any={}; let passed=0; for(const f of MLB_C4_FEATURE_NAMES){byFeature[f]={...stats[f],passed:stats[f].missingnessMismatches===0&&stats[f].numericMismatches===0};if(byFeature[f].passed)passed++;}
  const allPassed=passed===4&&rowMismatch===0&&canonN===replayN;
  const report={schemaVersion:"courtedge-p0-mlb-c4-live-parity-report.v1",classification:"TECHNICAL_LIVE_PARITY_GATE_NOT_SCIENTIFIC_EVIDENCE",tolerance:tol,seasons,counts:{canonicalRows:canonN,replayRows:replayN,rowIdentityMismatches:rowMismatch,featuresPassing:passed,featuresRequired:4},byFeature,firstMismatches:first,allPassed,policy:{v16MayConsumeLiveC4:allPassed,scientificEvidenceCreated:false,liveRecommendationChanged:false,step11cPopulationChanged:false,betEliteProduced:false,realFinancialExposure:0}};
  await fs.mkdir(path.dirname(outp),{recursive:true}); await fs.writeFile(outp,`${JSON.stringify(report,null,2)}\n`); console.log(JSON.stringify(report,null,2)); if(!allPassed) throw new Error("C4_LIVE_PARITY_GATE_FAILED");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
