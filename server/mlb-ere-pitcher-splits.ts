export interface MlbCollapsedPitcherInningStat {
  code: string;
  outs: number;
  /** MLB baseball notation as a number: 8.1 means 8 1/3 innings, not 8.1 decimal innings. */
  inningsPitched: number;
  earnedRuns: number;
  runs: number;
  hits: number;
  baseOnBalls: number;
  strikeOuts: number;
  homeRuns: number;
  gamesPlayed: number;
  sourceTeamIds: number[];
  sourceRowCount: number;
  provenance: "TEAM_ROWS" | "AGGREGATE_FALLBACK";
}

const MLB_IP_RE = /^(\d+)(?:\.([012]))?$/;

/**
 * MLB encodes partial innings in baseball notation: `8.1` = 8 innings + 1 out,
 * `8.2` = 8 innings + 2 outs. Never parse these strings with parseFloat for
 * rate calculations.
 */
export function mlbIpToOuts(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value).trim();
  const match = MLB_IP_RE.exec(text);
  if (!match) return 0;
  const fullInnings = Number(match[1]);
  const partialOuts = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(fullInnings) || fullInnings < 0) return 0;
  return fullInnings * 3 + partialOuts;
}

export function outsToMlbIpNumber(outs: number): number {
  if (!Number.isFinite(outs) || outs <= 0) return 0;
  const safeOuts = Math.max(0, Math.trunc(outs));
  return Math.floor(safeOuts / 3) + (safeOuts % 3) / 10;
}

export function inningsDecimalFromOuts(outs: number): number {
  return outs > 0 ? outs / 3 : 0;
}

export function eraFromOuts(earnedRuns: number, outs: number): number | null {
  if (!Number.isFinite(earnedRuns) || outs <= 0) return null;
  return Math.round(((earnedRuns * 27) / outs) * 100) / 100;
}

export function perNineFromOuts(value: number, outs: number): number | null {
  if (!Number.isFinite(value) || outs <= 0) return null;
  return Math.round(((value * 27) / outs) * 100) / 100;
}

export function whipFromOuts(hits: number, walks: number, outs: number): number | null {
  if (!Number.isFinite(hits) || !Number.isFinite(walks) || outs <= 0) return null;
  return Math.round((((hits + walks) * 3) / outs) * 100) / 100;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function teamIdOf(row: any): number | null {
  const id = Number(row?.team?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function chooseSourceRows(rows: any[]): { rows: any[]; provenance: MlbCollapsedPitcherInningStat["provenance"] } {
  const teamRows = rows.filter((row) => teamIdOf(row) !== null);
  const teamOuts = teamRows.reduce((sum, row) => sum + mlbIpToOuts(row?.stat?.inningsPitched), 0);

  // Multi-team seasons are the important case: StatsAPI can append a no-team
  // aggregate row whose IP is 0.0 while its other counters are cumulative. If
  // any team-scoped row has recorded outs, those team rows are the authoritative
  // additive custody and the no-team row must not overwrite or be added to them.
  if (teamRows.length > 0 && teamOuts > 0) {
    return { rows: teamRows, provenance: "TEAM_ROWS" };
  }

  const aggregateRows = rows.filter((row) => teamIdOf(row) === null);
  if (aggregateRows.length === 0) {
    return { rows: teamRows, provenance: "TEAM_ROWS" };
  }

  // Aggregate rows are not additive with one another. Pick the single row with
  // the greatest real-out coverage, then games played as deterministic tie-break.
  const best = aggregateRows.slice().sort((a, b) => {
    const outsDiff = mlbIpToOuts(b?.stat?.inningsPitched) - mlbIpToOuts(a?.stat?.inningsPitched);
    if (outsDiff !== 0) return outsDiff;
    return num(b?.stat?.gamesPlayed) - num(a?.stat?.gamesPlayed);
  })[0];
  return { rows: best ? [best] : [], provenance: "AGGREGATE_FALLBACK" };
}

/**
 * Collapse StatsAPI statSplits into exactly one authoritative row per inning.
 * This is intentionally team-switch safe: Mets + Cubs rows are added, while a
 * trailing no-team aggregate row is excluded instead of winning by array order.
 */
export function collapseMlbPitcherInningSplits(rows: any[]): Record<string, MlbCollapsedPitcherInningStat> {
  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    const code = String(row?.split?.code ?? "");
    if (!/^i\d{2}$/.test(code)) continue;
    const bucket = grouped.get(code) ?? [];
    bucket.push(row);
    grouped.set(code, bucket);
  }

  const out: Record<string, MlbCollapsedPitcherInningStat> = {};
  for (const [code, bucket] of grouped) {
    const selected = chooseSourceRows(bucket);
    if (selected.rows.length === 0) continue;

    let outs = 0;
    let earnedRuns = 0;
    let runs = 0;
    let hits = 0;
    let baseOnBalls = 0;
    let strikeOuts = 0;
    let homeRuns = 0;
    let gamesPlayed = 0;
    const sourceTeamIds = new Set<number>();

    for (const row of selected.rows) {
      const stat = row?.stat ?? {};
      outs += mlbIpToOuts(stat.inningsPitched);
      earnedRuns += num(stat.earnedRuns);
      runs += num(stat.runs);
      hits += num(stat.hits);
      baseOnBalls += num(stat.baseOnBalls);
      strikeOuts += num(stat.strikeOuts);
      homeRuns += num(stat.homeRuns);
      gamesPlayed += num(stat.gamesPlayed);
      const teamId = teamIdOf(row);
      if (teamId !== null) sourceTeamIds.add(teamId);
    }

    out[code] = {
      code,
      outs,
      inningsPitched: outsToMlbIpNumber(outs),
      earnedRuns,
      runs,
      hits,
      baseOnBalls,
      strikeOuts,
      homeRuns,
      gamesPlayed,
      sourceTeamIds: [...sourceTeamIds].sort((a, b) => a - b),
      sourceRowCount: selected.rows.length,
      provenance: selected.provenance,
    };
  }

  return out;
}
