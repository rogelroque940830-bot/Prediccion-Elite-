export const BASEBALL_SAVANT_PITCH_ARSENAL_URL = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats" as const;

export type SavantPitchArsenalRole = "batter" | "pitcher";
export type SavantPitchArsenalCoverage = "QUALIFIED" | "INCLUSIVE";

export interface SavantPitchArsenalUrlInput {
  role: SavantPitchArsenalRole;
  year: number;
  coverage: SavantPitchArsenalCoverage;
}

export function buildSavantPitchArsenalUrl(input: SavantPitchArsenalUrlInput): string {
  if (!Number.isInteger(input.year) || input.year < 2008 || input.year > 2100) {
    throw new Error("SAVANT_PITCH_ARSENAL_YEAR_INVALID");
  }

  const params = new URLSearchParams({
    min: "1",
    minPitches: input.coverage === "INCLUSIVE" ? "1" : "q",
    pitchType: "",
    team: "",
    type: input.role,
    year: String(input.year),
    csv: "true",
  });

  return `${BASEBALL_SAVANT_PITCH_ARSENAL_URL}?${params.toString()}`;
}
