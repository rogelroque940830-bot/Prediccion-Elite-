import assert from "node:assert/strict";
import {
  FROZEN_V39_FEATURES,
  scoreFrozenV39ExpectedOuts,
  type FrozenV39FeatureName,
} from "../server/mlb-full-modular-mechanistic-feature-builder";
import {
  MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION,
  assessFullModularLiveOperationalParity,
  type FullModularLiveOperationalInput,
} from "../server/mlb-full-modular-live-operational-bridge";

function v39Features(seed: number): Record<FrozenV39FeatureName, number> {
  const values = [15.4 + seed,21.7 + seed,84.0 + seed,0.22,0.077,0.103,15.8 + seed,87.4 + seed,15.3 + seed,4.2 + seed,0.78,9 + seed];
  return Object.fromEntries(FROZEN_V39_FEATURES.map((name, i) => [name, values[i]])) as Record<FrozenV39FeatureName, number>;
}

function pitcherLine(officialDate: string, gamePk: number, pitcherId: number, bf: number, k: number, bb: number, er: number, hr: number) {
  return { officialDate, gamePk, pitcherId, battersFaced: bf, strikeOuts: k, baseOnBalls: bb, earnedRuns: er, homeRuns: hr };
}

function pitchQualityRow(officialDate: string, gamePk: number, homeVelocity: number, awayVelocity: number) {
  return {
    officialDate, gamePk,
    pitcherPitchTypeTotals: [
      { pitcherId:101,pitchType:"FF",pitches:90,strikes:58,swings:45,whiffs:12,velocityN:90,velocitySum:homeVelocity*90,spinN:90,spinSum:2250*90,battedBallN:25,hardHitN:8 },
      { pitcherId:202,pitchType:"FF",pitches:88,strikes:54,swings:44,whiffs:9,velocityN:88,velocitySum:awayVelocity*88,spinN:88,spinSum:2180*88,battedBallN:26,hardHitN:10 },
      { pitcherId:303,pitchType:"FF",pitches:92,strikes:60,swings:46,whiffs:11,velocityN:92,velocitySum:94*92,spinN:92,spinSum:2210*92,battedBallN:24,hardHitN:9 },
    ],
  };
}

function fixture(): FullModularLiveOperationalInput {
  const priorDates=["2026-08-11","2026-08-12","2026-08-13","2026-08-14","2026-08-15","2026-08-16","2026-08-17"];
  const homeOrder=[1001,1002,1003,1004,1005,1006,1007,1008,1009];
  const awayOrder=[2001,2002,2003,2004,2005,2006,2007,2008,2009];
  const homeTeamHistory=priorDates.map((officialDate,i)=>({officialDate,gamePk:4100+i,runsFor:4+(i%3),runsAgainst:2+(i%2)}));
  const awayTeamHistory=priorDates.map((officialDate,i)=>({officialDate,gamePk:4200+i,runsFor:3+(i%2),runsAgainst:4+(i%3)}));
  const homePriorLineups=priorDates.map((officialDate,i)=>({officialDate,gamePk:4100+i,battingOrder:[...homeOrder]}));
  const awayPriorLineups=priorDates.map((officialDate,i)=>({officialDate,gamePk:4200+i,battingOrder:[...awayOrder]}));
  const homeStarterHistory=priorDates.slice(0,4).map((officialDate,i)=>pitcherLine(officialDate,5100+i,101,24+i,7+i,2,2+(i%2),1));
  const awayStarterHistory=priorDates.slice(0,4).map((officialDate,i)=>pitcherLine(officialDate,5200+i,202,23+i,5+i,3,3+(i%2),1+(i%2)));
  const leagueStarterHistory=[...homeStarterHistory,...awayStarterHistory,...priorDates.slice(0,4).map((officialDate,i)=>pitcherLine(officialDate,5300+i,303,25,6,2,2,1))];
  return {
    observedAtUtc:"2026-08-18T22:50:00Z",
    scheduledFirstPitchUtc:"2026-08-18T23:00:00Z",
    full13:{officialDate:"2026-08-18",gamePk:999001,homeTeamId:1,awayTeamId:2,homeTeamHistory,awayTeamHistory,leagueStarterHistory,homeStarterHistory,awayStarterHistory,homeStarterId:101,awayStarterId:202,homePriorLineups,awayPriorLineups,homeBattingOrder:homeOrder,awayBattingOrder:awayOrder},
    v39:{home:{asOfDate:"2026-08-17",features:v39Features(0.2)},away:{asOfDate:"2026-08-17",features:v39Features(-0.2)}},
    pitchQualityHistory:priorDates.slice(-4).map((date,i)=>pitchQualityRow(date,6100+i,95+i*.1,93+i*.1)),
    bullpen:{homeHistory:[{officialDate:"2026-08-15",bullpenPitches:34,relievers:{"701":15,"702":11,"703":8}},{officialDate:"2026-08-16",bullpenPitches:29,relievers:{"701":10,"704":19}},{officialDate:"2026-08-17",bullpenPitches:41,relievers:{"701":16,"702":14,"705":11}}],awayHistory:[{officialDate:"2026-08-15",bullpenPitches:38,relievers:{"801":14,"802":13,"803":11}},{officialDate:"2026-08-16",bullpenPitches:43,relievers:{"801":18,"804":25}},{officialDate:"2026-08-17",bullpenPitches:36,relievers:{"801":12,"802":10,"805":14}}]},
  };
}

function clone(): FullModularLiveOperationalInput { return JSON.parse(JSON.stringify(fixture())) as FullModularLiveOperationalInput; }
function assertNoPlay(input: FullModularLiveOperationalInput, reason: string): void { const result=assessFullModularLiveOperationalParity(input); assert.equal(result.status,"NO_PLAY"); if(result.status==="NO_PLAY") assert.equal(result.reason,reason); }

const base=fixture();
const ready=assessFullModularLiveOperationalParity(base);
assert.equal(ready.status,"READY");
if(ready.status!=="READY") throw new Error("READY_FIXTURE_FAILED");
assert.equal(ready.bridgeVersion,MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION);
assert.equal(ready.officialDate,"2026-08-18");
assert.equal(ready.gamePk,999001);
assert.equal(ready.decisionDeadlineUtc,"2026-08-18T22:55:00.000Z");
assert.equal(ready.diagnostics.sameDateHistoryAllowed,false);
assert.deepEqual(ready.diagnostics.outcomeFieldsUsed,[]);
assert.deepEqual(ready.diagnostics.sportsbookPriceFieldsUsed,[]);
assert.equal(Object.values(ready.featureVector).every(Number.isFinite),true);
const expectedHomeOuts=scoreFrozenV39ExpectedOuts(base.v39.home.features);
const expectedAwayOuts=scoreFrozenV39ExpectedOuts(base.v39.away.features);
assert.equal(ready.expectedStarterOuts.home,expectedHomeOuts);
assert.equal(ready.expectedStarterOuts.away,expectedAwayOuts);
assert.equal(ready.featureVector.home_expected_starter_outs,expectedHomeOuts);
assert.equal(ready.featureVector.away_expected_starter_outs,expectedAwayOuts);
assert.equal(ready.featureVector.home_f3_starter_share,Math.max(0,Math.min(1,expectedHomeOuts/9)));
assert.equal(ready.featureVector.away_f5_starter_share,Math.max(0,Math.min(1,expectedAwayOuts/15)));
assert.equal(ready.featureVector.home_fg_starter_share,Math.max(0,Math.min(1,expectedHomeOuts/27)));
assert.equal(ready.featureVector.home_fg_expected_bullpen_share,1-ready.featureVector.home_fg_starter_share);
assert.deepEqual(assessFullModularLiveOperationalParity(clone()),ready);

{const x=clone();delete x.v39.home.features.pitcher_prior_starts;assertNoPlay(x,"V39_REQUIRED_RAW_FEATURE_MISSING");}
{const x=clone();x.v39.home.asOfDate=x.full13.officialDate;assertNoPlay(x,"V39_SOURCE_NOT_PRIOR_DATE");}
{const x=clone();x.pitchQualityHistory.push(pitchQualityRow(x.full13.officialDate,6999,96,94));assertNoPlay(x,"V62_SOURCE_NOT_PRIOR_DATE");}
{const x=clone();x.bullpen.awayHistory.push({officialDate:"2026-08-19",bullpenPitches:1,relievers:{"899":1}});assertNoPlay(x,"V66_SOURCE_NOT_PRIOR_DATE");}
{const x=clone();x.observedAtUtc="2026-08-18T22:55:00.001Z";assertNoPlay(x,"DECISION_TIMESTAMP_MISSING_OR_LATE");}
{const x=clone();x.full13.homeStarterId=null;assertNoPlay(x,"PROBABLE_STARTER_UNAVAILABLE");}
{const x=clone();x.full13.homeBattingOrder=x.full13.homeBattingOrder?.slice(0,8)??null;assertNoPlay(x,"CONFIRMED_LINEUP_UNAVAILABLE");}
{const x=clone();x.full13.homeTeamHistory.push({officialDate:x.full13.officialDate,gamePk:777001,runsFor:5,runsAgainst:1});assertNoPlay(x,"FULL13_PRIOR_KNOWLEDGE_MISSING");}
{const x=clone() as FullModularLiveOperationalInput&{targetOutcome?:string};x.targetOutcome="HOME_WIN";assertNoPlay(x,"SOURCE_INTEGRITY_FAILED");}
{const x=clone() as FullModularLiveOperationalInput&{moneyline?:number};x.moneyline=-135;assertNoPlay(x,"SOURCE_INTEGRITY_FAILED");}
{const x=clone();x.pitchQualityHistory=[];assertNoPlay(x,"V62_REQUIRED_STARTER_QUALITY_MISSING");}
{const x=clone();x.bullpen.homeHistory=[];assertNoPlay(x,"V66_REQUIRED_BULLPEN_WORKLOAD_MISSING");}

console.log("MLB_FULL_MODULAR_LIVE_OPERATIONAL_PARITY_TESTS_PASSED");
