import fs from "node:fs/promises";

const path = "server/mlb-ere.ts";
let source = await fs.readFile(path, "utf8");

if (source.includes('from "./mlb-ere-pitcher-splits.js"')) {
  console.log("MLB ERE pitcher-integrity patch already applied; no-op.");
  process.exit(0);
}

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceAllExact(before, after, label, expectedMin = 1) {
  const count = source.split(before).length - 1;
  if (count < expectedMin) throw new Error(`Patch anchor count too small for ${label}: ${count}`);
  source = source.split(before).join(after);
  console.log(`${label}: replaced ${count}`);
}

replaceOnce(
  'import { getRotowireLineupForGame, type RotowireGame } from "./mlb-rotowire-lineups.js";',
  'import { getRotowireLineupForGame, type RotowireGame } from "./mlb-rotowire-lineups.js";\nimport {\n  collapseMlbPitcherInningSplits,\n  eraFromOuts,\n  inningsDecimalFromOuts,\n  mlbIpToOuts,\n  perNineFromOuts,\n  whipFromOuts,\n} from "./mlb-ere-pitcher-splits.js";',
  "helper import",
);

replaceOnce(
  '    pitcherSeasonEra?: number;     // ERA season usada para el prior\n',
  '    pitcherSeasonEra?: number;     // ERA season usada para el prior\n    pitcherEvidenceCoverage?: number; // 0-1 de peso ERE pitcher con evidencia real\n    pitcherEvidenceStatus?: "VERIFIED" | "INCOMPLETE";\n',
  "data-source evidence fields",
);

replaceAllExact(
  'Record<string, { era: number; ip: number; er: number; k: number; bb: number; h: number; hr: number }>',
  'Record<string, { era: number; ip: number; outs: number; er: number; k: number; bb: number; h: number; hr: number }>',
  "inning result types",
  2,
);

replaceOnce(
`      pitcherData.f5InningsByInning && pitcherData.f5InningsByInning["i02"] && pitcherData.f5InningsByInning["i03"]
        ? (() => {
            const i2 = pitcherData.f5InningsByInning!["i02"];
            const i3 = pitcherData.f5InningsByInning!["i03"];
            const totalIp = i2.ip + i3.ip;
            // THRESHOLD: mínimo 6 IP combinados (≈2 starts completos)
            if (totalIp < 6) return null;
            return Math.round(((i2.er + i3.er) / totalIp) * 9 * 100) / 100;
          })()
        : null,`,
`      pitcherData.f5InningsByInning && pitcherData.f5InningsByInning["i02"] && pitcherData.f5InningsByInning["i03"]
        ? (() => {
            const i2 = pitcherData.f5InningsByInning!["i02"];
            const i3 = pitcherData.f5InningsByInning!["i03"];
            const totalOuts = i2.outs + i3.outs;
            // THRESHOLD: mínimo 6 IP combinados = 18 outs (≈2 starts completos)
            if (totalOuts < 18) return null;
            return eraFromOuts(i2.er + i3.er, totalOuts);
          })()
        : null,`,
  "inning 2-3 outs arithmetic",
);

replaceOnce(
`  const pitcherPrior = pitcherData.seasonIp >= 10 ? computePitcherPrior(pitcherData) : 50;
  const offenseScore = weightedAvg(offVars);
  const pitcherSuppressionScore = weightedAvg(pitVars, pitcherPrior);`,
`  const pitcherPrior = pitcherData.seasonIp >= 10 ? computePitcherPrior(pitcherData) : 50;
  const offenseScore = weightedAvg(offVars);
  const pitcherSuppressionScore = weightedAvg(pitVars, pitcherPrior);
  // DATA-INTEGRITY GATE: performance unknown is never equivalent to good/bad.
  // ERE pitcher weights are fractions summing to 1.0; require >=70% real usable
  // pitcher evidence and a minimally established starter sample before surfacing
  // any early-market suggestion. This is a coverage gate, not a performance filter.
  const pitcherEvidenceCoverage = Object.values(pitVars).reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  const pitcherEvidenceIncomplete = !opposingPitcherId || pitcherData.gs < MIN_GS_FIRST_INN || pitcherEvidenceCoverage < 0.70;`,
  "pitcher evidence gate",
);

replaceOnce(
`  // ── 6. Categoría + sugerencias de mercado ───────────────────────────────
  const dataUnverified = teamMetrics.dataStatus !== "VERIFIED";
  const classified = dataUnverified
    ? { category: "NEUTRAL" as EreResult["category"], marketSuggestions: [] as string[] }
    : classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);
  const { category, marketSuggestions } = classified;
  const warnings = collectWarnings(offVars, pitVars, teamMetrics, pitcherData);
  if (teamMetrics.dataStatus === "DATA_INCOMPLETE") {
    warnings.unshift("DATA_INCOMPLETE: no se validaron linescores suficientes; mercados early bloqueados");
  } else if (teamMetrics.dataStatus === "PARTIAL") {
    warnings.unshift(`Cobertura early parcial (${teamMetrics.gamesAnalyzed} juegos); usar solo como contexto`);
  }`,
`  // ── 6. Categoría + sugerencias de mercado ───────────────────────────────
  const effectiveDataStatus: EreResult["dataStatus"] = pitcherEvidenceIncomplete
    ? "DATA_INCOMPLETE"
    : teamMetrics.dataStatus;
  const dataUnverified = effectiveDataStatus !== "VERIFIED";
  const classified = dataUnverified
    ? { category: "NEUTRAL" as EreResult["category"], marketSuggestions: [] as string[] }
    : classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);
  const { category, marketSuggestions } = classified;
  const warnings = collectWarnings(offVars, pitVars, teamMetrics, pitcherData);
  if (pitcherEvidenceIncomplete) {
    warnings.unshift(`PITCHER_EVIDENCE_INCOMPLETE: cobertura ${Math.round(pitcherEvidenceCoverage * 100)}%; mercados early bloqueados`);
  } else if (teamMetrics.dataStatus === "DATA_INCOMPLETE") {
    warnings.unshift("DATA_INCOMPLETE: no se validaron linescores suficientes; mercados early bloqueados");
  } else if (teamMetrics.dataStatus === "PARTIAL") {
    warnings.unshift(`Cobertura early parcial (${teamMetrics.gamesAnalyzed} juegos); usar solo como contexto`);
  }`,
  "classification fail-closed gate",
);

replaceOnce(
`    dataStatus: teamMetrics.dataStatus,
    asOfDate: teamMetrics.asOfDate,
    windowStart: teamMetrics.windowStart,
    sourceErrors: teamMetrics.sourceErrors,`,
`    dataStatus: effectiveDataStatus,
    asOfDate: teamMetrics.asOfDate,
    windowStart: teamMetrics.windowStart,
    sourceErrors: pitcherEvidenceIncomplete
      ? [...teamMetrics.sourceErrors, "pitcher:PITCHER_EVIDENCE_INCOMPLETE"]
      : teamMetrics.sourceErrors,`,
  "effective response status",
);

replaceOnce(
`      pitcherSeasonEra: pitcherData.seasonEra ?? undefined,
    },`,
`      pitcherSeasonEra: pitcherData.seasonEra ?? undefined,
      pitcherEvidenceCoverage: Math.round(pitcherEvidenceCoverage * 1000) / 1000,
      pitcherEvidenceStatus: pitcherEvidenceIncomplete ? "INCOMPLETE" : "VERIFIED",
    },`,
  "evidence response metadata",
);

replaceOnce(
`    // Map per-inning stats indexed by inning code (i01-i05)
    const inningMap: Record<string, any> = {};
    for (const s of splits) {
      const code = s.split?.code; // e.g. "i01"
      if (code) inningMap[code] = s.stat;
    }`,
`    // StatsAPI may return multiple rows per inning when a pitcher changed teams,
    // plus a trailing no-team aggregate row. Collapse by real team custody rather
    // than array order so a 0-IP aggregate can never overwrite valid MLB innings.
    const inningMap = collapseMlbPitcherInningSplits(splits);`,
  "season split collapse",
);

replaceOnce(
`    const i01 = inningMap["i01"];
    if (i01) {
      const er = parseInt(i01.earnedRuns) || 0;
      const ip = parseFloat(i01.inningsPitched || "0");
      if (ip > 0) data.firstInnEra = Math.round((er / ip) * 9 * 100) / 100;
      const gs = parseInt(i01.gamesStarted) || 0;
      data.gs = Math.max(data.gs, gs);
      const r1 = parseInt(i01.runs) || 0;
      const gp = parseInt(i01.gamesPlayed) || 0;
      if (gp > 0) data.yrfiAllowed = Math.min(1, r1 / gp);
      const h = parseInt(i01.hits) || 0;
      const bb = parseInt(i01.baseOnBalls) || 0;
      if (ip > 0) data.whip13 = Math.round(((h + bb) / ip) * 100) / 100;
    }`,
`    const i01 = inningMap["i01"];
    if (i01 && i01.outs > 0) {
      const er = i01.earnedRuns;
      data.firstInnEra = eraFromOuts(er, i01.outs);
      const gp = Math.trunc(i01.gamesPlayed);
      data.gs = Math.max(data.gs, gp);
      if (gp > 0) data.yrfiAllowed = Math.min(1, i01.runs / gp);
      data.whip13 = whipFromOuts(i01.hits, i01.baseOnBalls, i01.outs);
    }`,
  "first inning consolidated stats",
);

replaceOnce(
`    // Helper: aggregate stats for a group of innings
    const aggregate = (codes: string[]) => {
      let ip = 0, er = 0, k = 0, bb = 0, h = 0, hr = 0, r = 0;
      for (const c of codes) {
        const s = inningMap[c];
        if (!s) continue;
        ip += parseFloat(s.inningsPitched || "0");
        er += parseInt(s.earnedRuns) || 0;
        k += parseInt(s.strikeOuts) || 0;
        bb += parseInt(s.baseOnBalls) || 0;
        h += parseInt(s.hits) || 0;
        hr += parseInt(s.homeRuns) || 0;
        r += parseInt(s.runs) || 0;
      }
      if (ip === 0) return null;
      return {
        ip,
        era: Math.round((er / ip) * 9 * 100) / 100,
        k9: Math.round((k / ip) * 9 * 100) / 100,
        bb9: Math.round((bb / ip) * 9 * 100) / 100,
        whip: Math.round(((h + bb) / ip) * 100) / 100,
        hr9: Math.round((hr / ip) * 9 * 100) / 100,
        er, k, bb, h, hr, r,
      };
    };`,
`    // Helper: aggregate authoritative per-inning rows using OUTS, never decimal
    // parseFloat on MLB notation such as 8.1 (= 8 1/3 innings).
    const aggregate = (codes: string[]) => {
      let outs = 0, er = 0, k = 0, bb = 0, h = 0, hr = 0, r = 0;
      for (const c of codes) {
        const s = inningMap[c];
        if (!s) continue;
        outs += s.outs;
        er += s.earnedRuns;
        k += s.strikeOuts;
        bb += s.baseOnBalls;
        h += s.hits;
        hr += s.homeRuns;
        r += s.runs;
      }
      if (outs === 0) return null;
      return {
        outs,
        ip: inningsDecimalFromOuts(outs),
        era: eraFromOuts(er, outs)!,
        k9: perNineFromOuts(k, outs)!,
        bb9: perNineFromOuts(bb, outs)!,
        whip: whipFromOuts(h, bb, outs)!,
        hr9: perNineFromOuts(hr, outs)!,
        er, k, bb, h, hr, r,
      };
    };`,
  "aggregate outs arithmetic",
);

replaceOnce(
`    const innByInn: Record<string, { era: number; ip: number; outs: number; er: number; k: number; bb: number; h: number; hr: number }> = {};
    for (let i = 1; i <= 9; i++) {
      const code = i < 10 ? `i0${i}` : `i${i}`;
      const s = inningMap[code];
      if (!s) continue;
      const ip = parseFloat(s.inningsPitched || "0");
      innByInn[code] = {
        era: ip > 0 ? Math.round(((parseInt(s.earnedRuns) || 0) / ip) * 9 * 100) / 100 : 0,
        ip,
        er: parseInt(s.earnedRuns) || 0,
        k: parseInt(s.strikeOuts) || 0,
        bb: parseInt(s.baseOnBalls) || 0,
        h: parseInt(s.hits) || 0,
        hr: parseInt(s.homeRuns) || 0,
      };
    }`,
`    const innByInn: Record<string, { era: number; ip: number; outs: number; er: number; k: number; bb: number; h: number; hr: number }> = {};
    for (let i = 1; i <= 9; i++) {
      const code = i < 10 ? `i0${i}` : `i${i}`;
      const s = inningMap[code];
      if (!s || s.outs <= 0) continue; // zero outs = N/D, never a synthetic 0.00 ERA
      const era = eraFromOuts(s.earnedRuns, s.outs);
      if (era === null) continue;
      innByInn[code] = {
        era,
        ip: s.inningsPitched,
        outs: s.outs,
        er: s.earnedRuns,
        k: s.strikeOuts,
        bb: s.baseOnBalls,
        h: s.hits,
        hr: s.homeRuns,
      };
    }`,
  "per-inning N/D semantics",
);

replaceOnce(
`      const recentSplits = jR.stats?.[0]?.splits ?? [];
      const recentMap: Record<string, any> = {};
      for (const s of recentSplits) {
        const c = s.split?.code;
        if (c) recentMap[c] = s.stat;
      }
      const aggregateRecent = (codes: string[]) => {
        let ip = 0, er = 0;
        for (const c of codes) {
          const s = recentMap[c];
          if (!s) continue;
          ip += parseFloat(s.inningsPitched || "0");
          er += parseInt(s.earnedRuns) || 0;
        }
        if (ip === 0) return null;
        return { ip, era: Math.round((er / ip) * 9 * 100) / 100 };
      };`,
`      const recentSplits = jR.stats?.[0]?.splits ?? [];
      const recentMap = collapseMlbPitcherInningSplits(recentSplits);
      const aggregateRecent = (codes: string[]) => {
        let outs = 0, er = 0;
        for (const c of codes) {
          const s = recentMap[c];
          if (!s) continue;
          outs += s.outs;
          er += s.earnedRuns;
        }
        if (outs === 0) return null;
        return { outs, ip: inningsDecimalFromOuts(outs), era: eraFromOuts(er, outs)! };
      };`,
  "recent split collapse",
);

replaceAllExact(
  'const ip = parseFloat(s.stat?.inningsPitched || "0");',
  'const ip = inningsDecimalFromOuts(mlbIpToOuts(s.stat?.inningsPitched));',
  "game-log IP parsing",
  2,
);

replaceOnce(
  '      const ip = parseFloat(s.inningsPitched || "0");\n',
  '      const ip = inningsDecimalFromOuts(mlbIpToOuts(s.inningsPitched));\n',
  "season IP parsing",
);

replaceOnce(
  '        totalIp += parseFloat(s.stat?.inningsPitched || "0");',
  '        totalIp += inningsDecimalFromOuts(mlbIpToOuts(s.stat?.inningsPitched));',
  "game-log total IP parsing",
);

await fs.writeFile(path, source);
console.log("Applied MLB ERE pitcher source-integrity patch.");
