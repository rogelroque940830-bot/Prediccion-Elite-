from pathlib import Path

p = Path("server/routes.ts")
s = p.read_text(encoding="utf-8")

old = '''              nhlGoalieIdMap[abbr] = leaders.map((l: any) => ({
                playerId: l.playerId,
                name: ((l.firstName?.default || "") + " " + (l.lastName?.default || "")).trim(),
                svPct: l.savePctg ? Math.round(l.savePctg * 1000) / 1000 : 0.900,
                gaa: l.gaa ? Math.round(l.gaa * 100) / 100 : 3.00,
                record: l.record || "0-0",
                gp: l.gamesPlayed || 0,
              }));'''
new = '''              nhlGoalieIdMap[abbr] = leaders.flatMap((l: any) => {
                const goalieName = ((l.firstName?.default || "") + " " + (l.lastName?.default || "")).trim();
                const rawSvPct = Number(l.savePctg);
                const rawGaa = Number(l.gaa ?? l.goalsAgainstAverage);
                if (!goalieName || !Number.isFinite(rawSvPct) || rawSvPct <= 0 || rawSvPct > 1 || !Number.isFinite(rawGaa) || rawGaa < 0) {
                  return [];
                }
                return [{
                  playerId: l.playerId,
                  name: goalieName,
                  svPct: Math.round(rawSvPct * 1000) / 1000,
                  gaa: Math.round(rawGaa * 100) / 100,
                  record: typeof l.record === "string" ? l.record : "",
                  gp: l.gamesPlayed || 0,
                }];
              });'''
if s.count(old) != 1:
    raise RuntimeError(f"candidate block expected once, found {s.count(old)}")
s = s.replace(old, new, 1)

repls = {
'''svPct: Number.isFinite(Number(dg.homeGoalieSavePercentage)) ? Math.round(Number(dg.homeGoalieSavePercentage) * 1000) / 1000 : undefined,''':
'''svPct: dg.homeGoalieSavePercentage !== "" && dg.homeGoalieSavePercentage != null && Number.isFinite(Number(dg.homeGoalieSavePercentage)) && Number(dg.homeGoalieSavePercentage) > 0 && Number(dg.homeGoalieSavePercentage) <= 1 ? Math.round(Number(dg.homeGoalieSavePercentage) * 1000) / 1000 : undefined,''',
'''gaa: Number.isFinite(Number(dg.homeGoalieGoalsAgainstAvg)) ? Math.round(Number(dg.homeGoalieGoalsAgainstAvg) * 100) / 100 : undefined,''':
'''gaa: dg.homeGoalieGoalsAgainstAvg !== "" && dg.homeGoalieGoalsAgainstAvg != null && Number.isFinite(Number(dg.homeGoalieGoalsAgainstAvg)) && Number(dg.homeGoalieGoalsAgainstAvg) >= 0 ? Math.round(Number(dg.homeGoalieGoalsAgainstAvg) * 100) / 100 : undefined,''',
'''svPct: Number.isFinite(Number(dg.awayGoalieSavePercentage)) ? Math.round(Number(dg.awayGoalieSavePercentage) * 1000) / 1000 : undefined,''':
'''svPct: dg.awayGoalieSavePercentage !== "" && dg.awayGoalieSavePercentage != null && Number.isFinite(Number(dg.awayGoalieSavePercentage)) && Number(dg.awayGoalieSavePercentage) > 0 && Number(dg.awayGoalieSavePercentage) <= 1 ? Math.round(Number(dg.awayGoalieSavePercentage) * 1000) / 1000 : undefined,''',
'''gaa: Number.isFinite(Number(dg.awayGoalieGoalsAgainstAvg)) ? Math.round(Number(dg.awayGoalieGoalsAgainstAvg) * 100) / 100 : undefined,''':
'''gaa: dg.awayGoalieGoalsAgainstAvg !== "" && dg.awayGoalieGoalsAgainstAvg != null && Number.isFinite(Number(dg.awayGoalieGoalsAgainstAvg)) && Number(dg.awayGoalieGoalsAgainstAvg) >= 0 ? Math.round(Number(dg.awayGoalieGoalsAgainstAvg) * 100) / 100 : undefined,''',
}
for a, b in repls.items():
    if s.count(a) != 1:
        raise RuntimeError(f"DailyFaceoff replacement expected once: {a[:40]} count={s.count(a)}")
    s = s.replace(a, b, 1)

p.write_text(s, encoding="utf-8")
print("NHL goalie candidate priors removed")
