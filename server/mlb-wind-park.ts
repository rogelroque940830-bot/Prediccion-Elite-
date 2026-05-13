// Wind-Park Refined System (MLB)
// Combina viento + dirección + dimensiones del estadio para ajuste preciso de runs/HRs
// Las casas usan park factor genérico — nosotros vamos al detalle wind+park específico

export interface WindParkAdjustment {
  venueName: string;
  windSpeed: number;
  windDirection: string;        // "Out To RF", "In From LF", etc.
  temperature: number;
  condition: string;
  // Ajustes calculados
  runsAdjustment: number;        // ± runs/juego total esperado
  hrFactor: number;              // multiplicador del HR rate (1.0 = neutral)
  signal: string;
}

// Estadios extremos que amplifican o atenúan el viento
const PARK_WIND_AMPLIFIER: Record<string, number> = {
  // Wrigley es el más afectado por viento del país
  "Wrigley Field": 1.8,
  // Yankee Stadium amplifica RF (porch corto)
  "Yankee Stadium": 1.3,
  // Coors ya es parque alto-scoring; viento secundario
  "Coors Field": 0.7,
  // Estadios cerrados o en domos (sin efecto)
  "loanDepot park": 0,         // Marlins (techo retractable)
  "Tropicana Field": 0,         // domado fijo
  "Daikin Park": 0.3,           // techo retractable
  "Globe Life Field": 0.2,      // techo retractable
  "Chase Field": 0.3,           // techo retractable
  "T-Mobile Park": 0.4,         // techo retractable
  "Rogers Centre": 0.3,         // techo retractable
  "American Family Field": 0.4, // techo retractable
  // Default park = 1.0 (efecto normal del viento)
};

// Parsing de wind direction
function parseWindDirection(windStr: string): { isBlowingOut: boolean; isBlowingIn: boolean; toField: string | null } {
  const lower = (windStr || "").toLowerCase();
  // "Out To RF/CF/LF" = blowing out (favorece HRs)
  if (lower.includes("out to")) {
    let toField: string | null = null;
    if (lower.includes("rf")) toField = "RF";
    else if (lower.includes("cf")) toField = "CF";
    else if (lower.includes("lf")) toField = "LF";
    return { isBlowingOut: true, isBlowingIn: false, toField };
  }
  // "In From RF/CF/LF" = blowing in (suprime HRs)
  if (lower.includes("in from")) {
    let toField: string | null = null;
    if (lower.includes("rf")) toField = "RF";
    else if (lower.includes("cf")) toField = "CF";
    else if (lower.includes("lf")) toField = "LF";
    return { isBlowingOut: false, isBlowingIn: true, toField };
  }
  // "L to R" o "R to L" — viento cruzado, efecto neutral
  return { isBlowingOut: false, isBlowingIn: false, toField: null };
}

function parseSpeed(windStr: string): number {
  const m = (windStr || "").match(/(\d+)\s*mph/i);
  return m ? parseInt(m[1]) : 0;
}

export function analyzeWindPark(
  venueName: string,
  weather: { wind?: string; temp?: string; condition?: string } | null | undefined,
): WindParkAdjustment | null {
  if (!weather || !weather.wind) return null;

  const speed = parseSpeed(weather.wind);
  const dir = parseWindDirection(weather.wind);
  const temp = parseInt(weather.temp ?? "70") || 70;
  const condition = weather.condition ?? "?";
  const amplifier = PARK_WIND_AMPLIFIER[venueName] ?? 1.0;

  let runsAdjustment = 0;
  let hrFactor = 1.0;
  const reasons: string[] = [];

  // 1. Viento — efecto principal
  if (speed >= 5 && (dir.isBlowingOut || dir.isBlowingIn)) {
    // Cada mph soplando hacia outfield agrega ~0.04 runs/juego (en parque promedio)
    // En Wrigley con viento fuerte saliendo: hasta +2 runs/juego
    const baseEffect = (speed - 5) * 0.04;  // a partir de 5 mph
    const directional = dir.isBlowingOut ? 1 : -1;
    runsAdjustment += baseEffect * directional * amplifier;

    // HR factor
    if (dir.isBlowingOut) {
      hrFactor = 1.0 + ((speed - 5) * 0.025) * amplifier;
      reasons.push(`Viento ${speed}mph saliendo${dir.toField ? ` hacia ${dir.toField}` : ""}: +${(baseEffect * amplifier).toFixed(2)} runs, HR ×${hrFactor.toFixed(2)}`);
    } else {
      hrFactor = 1.0 - ((speed - 5) * 0.025) * amplifier;
      reasons.push(`Viento ${speed}mph entrando${dir.toField ? ` desde ${dir.toField}` : ""}: ${(baseEffect * directional * amplifier).toFixed(2)} runs, HR ×${hrFactor.toFixed(2)}`);
    }
  }

  // 2. Temperatura — bola viaja más en calor
  if (temp >= 80) {
    const tempEffect = ((temp - 80) / 10) * 0.15;
    runsAdjustment += tempEffect;
    if (tempEffect > 0.1) reasons.push(`Calor ${temp}°F: +${tempEffect.toFixed(2)} runs`);
  } else if (temp <= 50) {
    const tempEffect = ((50 - temp) / 10) * 0.20;
    runsAdjustment -= tempEffect;
    if (tempEffect > 0.1) reasons.push(`Frío ${temp}°F: -${tempEffect.toFixed(2)} runs`);
  }

  // 3. Condition — lluvia/clouds reducen ofensiva levemente
  const lowerCondition = condition.toLowerCase();
  if (lowerCondition.includes("rain") || lowerCondition.includes("drizzle")) {
    runsAdjustment -= 0.3;
    reasons.push("Lluvia: -0.3 runs");
  }

  let signal = "";
  if (Math.abs(runsAdjustment) < 0.2) {
    signal = `Condiciones neutrales en ${venueName} — ${weather.wind}, ${temp}°F`;
  } else {
    const sign = runsAdjustment > 0 ? "+" : "";
    signal = `${runsAdjustment > 0 ? "🌬️" : "❄️"} ${venueName}: ${sign}${runsAdjustment.toFixed(2)} runs total · ${reasons.join(" · ")}`;
  }

  return {
    venueName,
    windSpeed: speed,
    windDirection: weather.wind,
    temperature: temp,
    condition,
    runsAdjustment: Math.round(runsAdjustment * 100) / 100,
    hrFactor: Math.round(hrFactor * 100) / 100,
    signal,
  };
}
