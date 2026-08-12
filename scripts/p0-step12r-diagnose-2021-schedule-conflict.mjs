const gamePk=633224;
const url='https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameTypes=R&startDate=2021-03-01&endDate=2021-10-04';
const r=await fetch(url,{headers:{'User-Agent':'CourtEdge-Step12R-Diagnostic/1.0',Accept:'application/json'}});
if(!r.ok) throw new Error(`HTTP_${r.status}`);
const p=await r.json();
const rows=[];
for(const d of Array.isArray(p?.dates)?p.dates:[]){
  for(const g of Array.isArray(d?.games)?d.games:[]){
    if(Number(g?.gamePk)!==gamePk) continue;
    rows.push({
      dateEntry:d?.date??null,
      gamePk:Number(g?.gamePk),
      gameType:g?.gameType??null,
      gameDate:g?.gameDate??null,
      officialDate:g?.officialDate??null,
      homeTeamId:g?.teams?.home?.team?.id??null,
      awayTeamId:g?.teams?.away?.team?.id??null,
      codedGameState:g?.status?.codedGameState??null,
      detailedState:g?.status?.detailedState??null,
      resumeDate:g?.resumeDate??null,
      resumeGameDate:g?.resumeGameDate??null,
      resumedFrom:g?.resumedFrom??null,
      resumedFromDate:g?.resumedFromDate??null
    });
  }
}
console.log(JSON.stringify({gamePk,count:rows.length,rows},null,2));
if(rows.length<2) throw new Error('STEP12R_EXPECTED_CONFLICT_NOT_REPRODUCED');
