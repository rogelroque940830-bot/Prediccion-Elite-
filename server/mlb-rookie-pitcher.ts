// Rookie/Unknown Pitcher Penalty System (MLB)
// Detecta pitchers con poca experiencia MLB y aplica una penalización
// porque los bateadores no tienen scouting + el rookie pitchea con adrenalina
// Las casas no procesan esto bien — aquí está nuestro edge.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export type PitcherExperienceTier =
  | "DEBUT"           // Primer start MLB
  | "VERY_GREEN"      // 1-2 starts
  | "GREEN"           // 3-4 starts
  | "DEVELOPING"      // 5-9 starts
  | "EXPERIENCED"     // 10+ starts (modelo normal)
  | "BULLPEN_GAME"    // Pitcher sin starts (relevista convertido en abridor)
  | "UNKNOWN";

export interface RookieAnalysis {
  pitcherId: number;
  pitcherName: string;
  careerStarts: number;
  careerIP: number;
  careerERA: number | null;
  mlbDebutDate: string | null;
  daysSinceDebut: number | null;
  tier: PitcherExperienceTier;
  // Penalty del modelo
  rivalRunsPenalty: number;        // runs que el rival anotará MENOS por falta de scouting
  confidenceReduction: number;     // pp a reducir de la confianza del modelo
  signal: string;
  // Reduce el "techo" del favorito
  shouldPassPick: boolean;         // True = recomendamos PASS, no apostar
}

const cache: Record<number, { ts: number; data: RookieAnalysis }> = {};

function parseIP(ip: string | undefined): number {
  if (!ip) return 0;
  const parts = String(ip).split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

function classifyExperience(careerStarts: number, careerIP: number, gamesPlayed: number): PitcherExperienceTier {
  // Bullpen game: jugó muchos juegos pero pocas IP (= relevista) Y va a abrir hoy
  if (careerStarts === 0 && gamesPlayed >= 5) return "BULLPEN_GAME";
  if (careerStarts === 0 && gamesPlayed === 0) return "DEBUT";
  if (careerStarts <= 2) return "VERY_GREEN";
  if (careerStarts <= 4) return "GREEN";
  if (careerStarts <= 9) return "DEVELOPING";
  return "EXPERIENCED";
}

function calcPenalty(tier: PitcherExperienceTier, careerERA: number | null): {
  rivalRunsPenalty: number;
  confidenceReduction: number;
  shouldPassPick: boolean;
} {
  switch (tier) {
    case "DEBUT":
      return { rivalRunsPenalty: -2.0, confidenceReduction: 15, shouldPassPick: true };
    case "VERY_GREEN":
      return { rivalRunsPenalty: -1.5, confidenceReduction: 12, shouldPassPick: true };
    case "GREEN":
      return { rivalRunsPenalty: -1.0, confidenceReduction: 8, shouldPassPick: true };
    case "DEVELOPING":
      return { rivalRunsPenalty: -0.5, confidenceReduction: 4, shouldPassPick: false };
    case "BULLPEN_GAME":
      return { rivalRunsPenalty: -1.2, confidenceReduction: 10, shouldPassPick: true };
    case "EXPERIENCED":
    default:
      return { rivalRunsPenalty: 0, confidenceReduction: 0, shouldPassPick: false };
  }
}

function tierLabel(tier: PitcherExperienceTier): string {
  switch (tier) {
    case "DEBUT": return "Debut MLB";
    case "VERY_GREEN": return "Muy verde (1-2 starts)";
    case "GREEN": return "Verde (3-4 starts)";
    case "DEVELOPING": return "En desarrollo (5-9 starts)";
    case "BULLPEN_GAME": return "Bullpen game (sin SP titular)";
    case "EXPERIENCED": return "Experimentado (10+ starts)";
    default: return "Desconocido";
  }
}

export async function analyzePitcherExperience(pitcherId: number, pitcherName: string): Promise<RookieAnalysis | null> {
  const cached = cache[pitcherId];
  if (cached && Date.now() - cached.ts < 24 * 3600 * 1000) return cached.data;

  try {
    // 1. Career stats
    const careerJson: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=career&group=pitching`)).json();
    const careerSplit = careerJson.stats?.[0]?.splits?.[0];
    const careerStat = careerSplit?.stat ?? {};
    const careerStarts = parseInt(careerStat.gamesStarted ?? "0") || 0;
    const careerIP = parseIP(careerStat.inningsPitched);
    const gamesPlayed = parseInt(careerStat.gamesPlayed ?? "0") || 0;
    const careerERA = careerStat.era ? parseFloat(careerStat.era) : null;

    // 2. Debut date
    const personJson: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}`)).json();
    const debutDate = personJson.people?.[0]?.mlbDebutDate ?? null;
    let daysSinceDebut: number | null = null;
    if (debutDate) {
      daysSinceDebut = Math.floor((Date.now() - new Date(debutDate).getTime()) / (1000 * 60 * 60 * 24));
    }

    // 3. Clasificar
    const tier = classifyExperience(careerStarts, careerIP, gamesPlayed);
    const penalty = calcPenalty(tier, careerERA);

    // 4. Construir signal
    let signal = "";
    if (tier === "EXPERIENCED") {
      signal = `${pitcherName} es pitcher experimentado (${careerStarts} starts, ${careerIP.toFixed(0)} IP). Sin penalización.`;
    } else if (tier === "DEBUT") {
      signal = `🚨 ${pitcherName} hace su DEBUT MLB hoy. Bateadores rivales no tienen scouting. PASS recomendado.`;
    } else if (tier === "BULLPEN_GAME") {
      signal = `🔧 ${pitcherName} es relevista — esto es BULLPEN GAME (sin SP titular). Lineup verá relevistas frescos. PASS recomendado.`;
    } else if (tier === "VERY_GREEN") {
      signal = `⚠️ ${pitcherName}: solo ${careerStarts} starts MLB. Bateadores no lo conocen. ${penalty.shouldPassPick ? "PASS" : "Reduce confianza"}.`;
    } else if (tier === "GREEN") {
      signal = `⚠️ ${pitcherName}: solo ${careerStarts} starts MLB (rookie). Reduce confianza del favorito.`;
    } else if (tier === "DEVELOPING") {
      signal = `${pitcherName}: ${careerStarts} starts MLB (en desarrollo). Penalización ligera.`;
    } else {
      signal = `${pitcherName}: experiencia desconocida.`;
    }

    const result: RookieAnalysis = {
      pitcherId,
      pitcherName,
      careerStarts,
      careerIP: Math.round(careerIP * 10) / 10,
      careerERA,
      mlbDebutDate: debutDate,
      daysSinceDebut,
      tier,
      ...penalty,
      signal,
    };

    cache[pitcherId] = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error("Failed to analyze pitcher experience:", e);
    return null;
  }
}

// Helper: para un partido, analizar ambos pitchers
export async function analyzeBothPitchersExperience(
  homePitcherId: number | undefined,
  homePitcherName: string,
  awayPitcherId: number | undefined,
  awayPitcherName: string,
): Promise<{ home: RookieAnalysis | null; away: RookieAnalysis | null; rookieAlert: boolean; alertText: string }> {
  const [home, away] = await Promise.all([
    homePitcherId ? analyzePitcherExperience(homePitcherId, homePitcherName) : Promise.resolve(null),
    awayPitcherId ? analyzePitcherExperience(awayPitcherId, awayPitcherName) : Promise.resolve(null),
  ]);

  const rookieAlert = !!(home?.shouldPassPick || away?.shouldPassPick);
  let alertText = "";
  if (home?.shouldPassPick && away?.shouldPassPick) {
    alertText = `🚨 AMBOS pitchers son rookies/inexpertos. Partido impredecible — PASS recomendado.`;
  } else if (home?.shouldPassPick) {
    alertText = `🚨 Pitcher LOCAL es ${tierLabel(home.tier)}. Si tu modelo favorece al VISITANTE alto (>70%), considera PASS.`;
  } else if (away?.shouldPassPick) {
    alertText = `🚨 Pitcher VISITANTE es ${tierLabel(away.tier)}. Si tu modelo favorece al LOCAL alto (>70%), considera PASS.`;
  }

  return { home, away, rookieAlert, alertText };
}
