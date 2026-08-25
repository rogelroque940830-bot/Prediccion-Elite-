export const CROSS_SPORT_CALIBRATION_SCHEMA = "courtedge-cross-sport-calibration.v1" as const;

export type CalibrationSport = "MLB" | "NBA" | "WNBA" | "NHL" | "NFL";
export type BinaryOutcome = 0 | 1;
export type CalibrationTemporalCustody =
  | {
      mode: "PROSPECTIVE_TIMESTAMPED";
      capturedAt: string;
      pregameCutoffAt: string;
      replayProtocolDigest: null;
      trainingThroughSeason: null;
    }
  | {
      mode: "LEAKAGE_SAFE_OOS_REPLAY";
      capturedAt: null;
      pregameCutoffAt: null;
      replayProtocolDigest: string;
      trainingThroughSeason: number;
    };

export type CalibrationObservation = {
  schemaVersion: typeof CROSS_SPORT_CALIBRATION_SCHEMA;
  sport: CalibrationSport;
  candidateId: string;
  gameId: string;
  eventDate: string;
  season: number;
  signalFamily: string;
  rawSignal: number;
  outcome: BinaryOutcome;
  temporalCustody: CalibrationTemporalCustody;
  candidatePolicyDigest: string;
  sourceArtifactDigest: string;
  sportEliteGatePassed: true;
  safety: {
    pregameOnly: true;
    sameGameOutcomeUsedAtDecisionTime: false;
    targetSeasonRankingOrCapUsed: false;
    historicalAccuracyUsedAsGameProbability: false;
  };
};

export type PlattCalibrator = {
  schemaVersion: "courtedge-platt-calibrator.v1";
  signalFamily: string;
  intercept: number;
  slope: number;
  trainingObservations: number;
  trainingSeasons: number[];
};

export type CalibrationMetrics = { observations: number; brier: number | null; logLoss: number | null; ece10: number | null };

function finiteProbability(value: number): boolean { return Number.isFinite(value) && value > 0 && value < 1; }

export function validateCalibrationObservation(row: CalibrationObservation): string[] {
  const errors: string[] = [];
  if (!row.candidateId.trim()) errors.push("candidateId missing");
  if (!row.gameId.trim()) errors.push("gameId missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.eventDate)) errors.push("eventDate invalid");
  if (!Number.isInteger(row.season)) errors.push("season invalid");
  if (!row.signalFamily.trim()) errors.push("signalFamily missing");
  if (!finiteProbability(row.rawSignal)) errors.push("rawSignal must be in (0,1)");
  if (row.outcome !== 0 && row.outcome !== 1) errors.push("outcome must be binary");
  if (row.temporalCustody.mode === "PROSPECTIVE_TIMESTAMPED") {
    const captured = Date.parse(row.temporalCustody.capturedAt);
    const cutoff = Date.parse(row.temporalCustody.pregameCutoffAt);
    if (!Number.isFinite(captured) || !Number.isFinite(cutoff) || captured > cutoff) errors.push("pregame temporal custody invalid");
  } else {
    if (!row.temporalCustody.replayProtocolDigest.trim()) errors.push("replayProtocolDigest missing");
    if (!Number.isInteger(row.temporalCustody.trainingThroughSeason)
      || row.temporalCustody.trainingThroughSeason >= row.season) errors.push("OOS replay training boundary invalid");
  }
  if (!row.candidatePolicyDigest.trim()) errors.push("candidatePolicyDigest missing");
  if (!row.sourceArtifactDigest.trim()) errors.push("sourceArtifactDigest missing");
  if (!row.safety.pregameOnly) errors.push("pregameOnly must be true");
  if (row.safety.sameGameOutcomeUsedAtDecisionTime) errors.push("same-game outcome leakage");
  if (row.safety.targetSeasonRankingOrCapUsed) errors.push("target-season ranking/cap forbidden");
  if (row.safety.historicalAccuracyUsedAsGameProbability) errors.push("historical hit rate cannot be game probability");
  return errors;
}

function clampProbability(p: number): number { return Math.min(1 - 1e-12, Math.max(1e-12, p)); }
function logit(p: number): number { const q = clampProbability(p); return Math.log(q / (1 - q)); }
function sigmoid(z: number): number { if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); } const e = Math.exp(z); return e / (1 + e); }

export function applyPlatt(calibrator: PlattCalibrator, rawSignal: number): number {
  if (!finiteProbability(rawSignal)) throw new Error("rawSignal must be in (0,1)");
  return sigmoid(calibrator.intercept + calibrator.slope * logit(rawSignal));
}

/** Deterministic 1D Platt scaling, fixed before target-fold outcomes are inspected. */
export function fitPlattCalibrator(rows: CalibrationObservation[], signalFamily: string): PlattCalibrator {
  const selected = rows.filter((row) => row.signalFamily === signalFamily);
  if (selected.length < 20) throw new Error("at least 20 labeled observations are required to fit Platt scaling");
  const invalid = selected.flatMap(validateCalibrationObservation);
  if (invalid.length) throw new Error(`invalid calibration evidence: ${invalid[0]}`);
  const seasons = [...new Set(selected.map((row) => row.season))].sort((a, b) => a - b);
  let intercept = 0, slope = 1;
  const lambda = 1e-3;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let g0 = 0, g1 = lambda * slope, h00 = 0, h01 = 0, h11 = lambda;
    for (const row of selected) {
      const x = logit(row.rawSignal), p = sigmoid(intercept + slope * x), error = p - row.outcome;
      const w = Math.max(1e-9, p * (1 - p));
      g0 += error; g1 += error * x; h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const d0 = (h11 * g0 - h01 * g1) / det, d1 = (-h01 * g0 + h00 * g1) / det;
    intercept -= Math.max(-2, Math.min(2, d0)); slope -= Math.max(-2, Math.min(2, d1));
    if (Math.max(Math.abs(d0), Math.abs(d1)) < 1e-9) break;
  }
  if (!Number.isFinite(intercept) || !Number.isFinite(slope)) throw new Error("Platt fit failed");
  return { schemaVersion: "courtedge-platt-calibrator.v1", signalFamily, intercept, slope, trainingObservations: selected.length, trainingSeasons: seasons };
}

export function calibrationMetrics(probabilities: number[], outcomes: BinaryOutcome[]): CalibrationMetrics {
  if (probabilities.length !== outcomes.length) throw new Error("probability/outcome length mismatch");
  if (!probabilities.length) return { observations: 0, brier: null, logLoss: null, ece10: null };
  const pairs = probabilities.map((p, i) => ({ p: clampProbability(p), y: outcomes[i] }));
  const brier = pairs.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / pairs.length;
  const logLoss = pairs.reduce((s, r) => s - (r.y * Math.log(r.p) + (1 - r.y) * Math.log(1 - r.p)), 0) / pairs.length;
  let ece = 0;
  for (let bin = 0; bin < 10; bin += 1) {
    const lo = bin / 10, hi = (bin + 1) / 10;
    const bucket = pairs.filter((r) => r.p >= lo && (bin === 9 ? r.p <= hi : r.p < hi));
    if (!bucket.length) continue;
    const mp = bucket.reduce((s, r) => s + r.p, 0) / bucket.length;
    const oy = bucket.reduce((s, r) => s + r.y, 0) / bucket.length;
    ece += (bucket.length / pairs.length) * Math.abs(mp - oy);
  }
  return { observations: pairs.length, brier, logLoss, ece10: ece };
}

export type WalkForwardFold = { targetSeason: number; trainingSeasons: number[]; trainingObservations: number; testObservations: number; raw: CalibrationMetrics; calibrated: CalibrationMetrics };

export function walkForwardPlatt(rows: CalibrationObservation[], signalFamily: string): WalkForwardFold[] {
  const selected = rows.filter((row) => row.signalFamily === signalFamily);
  const seasons = [...new Set(selected.map((row) => row.season))].sort((a, b) => a - b);
  const folds: WalkForwardFold[] = [];
  for (let index = 1; index < seasons.length; index += 1) {
    const targetSeason = seasons[index], train = selected.filter((row) => row.season < targetSeason), test = selected.filter((row) => row.season === targetSeason);
    if (train.length < 20 || !test.length) continue;
    const calibrator = fitPlattCalibrator(train, signalFamily), outcomes = test.map((row) => row.outcome);
    folds.push({ targetSeason, trainingSeasons: calibrator.trainingSeasons, trainingObservations: train.length, testObservations: test.length,
      raw: calibrationMetrics(test.map((row) => row.rawSignal), outcomes),
      calibrated: calibrationMetrics(test.map((row) => applyPlatt(calibrator, row.rawSignal)), outcomes) });
  }
  return folds;
}
