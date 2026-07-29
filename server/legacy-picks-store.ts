import fs from "node:fs";
import path from "node:path";

export interface SavedPick {
  id: string;
  ts: number;
  sport: "mlb" | "nba" | "nhl" | "wnba";
  homeTeam: string;
  awayTeam: string;
  pickType: string;
  pickSide: string;
  confidence: number;
  edge?: number;
  odds?: string;
  line?: string;
  notes?: string;
}

const PICKS_FILE = path.join(process.cwd(), "data", "picks.json");

export function loadPicks(): SavedPick[] {
  try {
    if (!fs.existsSync(PICKS_FILE)) return [];
    const raw = fs.readFileSync(PICKS_FILE, "utf-8");
    return JSON.parse(raw) as SavedPick[];
  } catch (error) {
    console.error("loadPicks error:", error);
    return [];
  }
}

export function savePicks(picks: SavedPick[]): void {
  try {
    const dir = path.dirname(PICKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2), "utf-8");
  } catch (error) {
    console.error("savePicks error:", error);
  }
}
