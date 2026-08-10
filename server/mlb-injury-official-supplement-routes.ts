import type { Express, NextFunction, Request, Response } from "express";
import { fetchOfficialMlbInjurySnapshot, type MlbOfficialInjurySnapshot } from "./mlb-injury-shadow";
import {
  MLB_REJECTED_IDENTITY_RECONCILIATION_MODE,
  MLB_REJECTED_IDENTITY_RECONCILIATION_REASON,
  buildMlbInjuryIdentityDiagnostic,
  isOfficialMlbInjuredRosterEntry,
  reconcileMlbOfficialOnlyInjuries,
  type MlbInjuryIdentityDiagnostic,
} from "./mlb-injury-official-supplement";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";
import { requireSecret, todayISO } from "./route-runtime";

export const MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA = "courtedge-mlb-official-injury-supplement.v1" as const;
export const MLB_INJURY_IDENTITY_DIAGNOSTIC_QUERY = "aggregate-v1" as const;
export const MLB_REJECTED_IDENTITY_RECONCILIATION_SCHEMA = "courtedge-mlb-rejected-identity-reconciliation.v1" as const;

const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";
const BDL_BASE = "https://api.balldontlie.io";
const RECONCILIATION_TTL_MS = 5 * 60 * 1000;
const BDL_MLB_TEAM_TO_ID: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120, WAS: 120,
};

type FetchOfficialSnapshot = (
  teamId: number,
  asOfDate: string,
) => Promise<MlbOfficialInjurySnapshot>;

type BuildIdentityDiagnostic = (input: {
  asOfDate: string;
  season: string;
  bdlKey: string;
}) => Promise<MlbInjuryIdentityDiagnostic>;

export interface MlbRejectedIdentityTarget {
  teamId: number;
  expectedRejectedCount: number;
  existingDetectedNames: string[];
}

export interface MlbRejectedIdentityTeamReconciliation {
  expectedRejectedCount: number;
  observedMissingCount: number;
  exactWrongCurrentTeamCount: number;
  officialIlReconciledCount: number;
  unresolvedRejectedCount: number;
  countParity: boolean;
  sourceHealthy: boolean;
  eligible: boolean;
}

export interface MlbRejectedIdentityReconciliationReport {
  schemaVersion: typeof MLB_REJECTED_IDENTITY_RECONCILIATION_SCHEMA;
  asOfDate: string;
  privacy: {
    aggregateOnly: true;
    playerNamesReturned: false;
    playerIdsReturned: false;
    credentialReturned: false;
  };
  byTeam: Record<number, MlbRejectedIdentityTeamReconciliation>;
}

type BuildRejectedIdentityReconciliation = (input: {
  asOfDate: string;
  season: string;
  bdlKey: string;
  targets: MlbRejectedIdentityTarget[];
}) => Promise<MlbRejectedIdentityReconciliationReport>;

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeIdentityName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function injuryDisplayName(injury: any): string {
  const player = injury?.player ?? {};
  return clean(player.full_name || `${player.first_name || ""} ${player.last_name || ""}`.trim());
}

function isActiveBdlInjuryRecord(injury: any): boolean {
  const text = [
    injury?.status,
    injury?.type,
    injury?.detail,
    injury?.description,
    injury?.short_comment,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  if (/\b(reinstated|activated|available|healthy|returned|cleared|probable)\b/.test(text)) return false;
  return /\b(out|injured list|day[- ]to[- ]day|dtd|doubtful|questionable|suspended|bereavement|paternity|restricted list)\b/.test(text)
    || /\b(10|15|60)[- ]day il\b/.test(text)
    || /\bil\b/.test(text);
}

function dedupeBdlTeamRecords(records: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const injury of records) {
    const player = injury?.player ?? {};
    const key = String(
      player.id || player.player_id || player.full_name || `${player.first_name || ""}-${player.last_name || ""}`,
    ).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(injury);
  }
  return result;
}

async function fetchActiveBdlInjuriesByTeam(fetchImpl: typeof fetch, bdlKey: string): Promise<Record<number, any[]>> {
  const byTeam: Record<number, any[]> = {};
  let cursor: number | null = null;
  let pages = 0;
  while (pages < 10) {
    const url = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await fetchImpl(url, { headers: { Authorization: bdlKey, Accept: "application/json" } });
    if (!response.ok) throw new Error(`BALLDONTLIE injuries HTTP ${response.status}`);
    const payload: any = await response.json();
    const data: any[] = Array.isArray(payload?.data) ? payload.data : [];
    for (const injury of data) {
      if (!isActiveBdlInjuryRecord(injury)) continue;
      const teamId = BDL_MLB_TEAM_TO_ID[clean(injury?.player?.team?.abbreviation).toUpperCase()];
      if (!teamId) continue;
      (byTeam[teamId] ??= []).push(injury);
    }
    pages += 1;
    cursor = payload?.meta?.next_cursor ?? null;
    if (!cursor) break;
  }
  for (const teamId of Object.keys(byTeam).map(Number)) {
    byTeam[teamId] = dedupeBdlTeamRecords(byTeam[teamId]);
  }
  return byTeam;
}

async function reproducesExactWrongCurrentTeam(input: {
  name: string;
  teamId: number;
  season: string;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await input.fetchImpl(buildMlbPeopleSearchUrl(MLB_STATS_BASE, input.name, input.season));
    if (!response.ok) return false;
    const payload: any = await response.json();
    const people: any[] = Array.isArray(payload?.people) ? payload.people : [];
    const target = normalizeIdentityName(input.name);
    const exact = people.filter((person) => normalizeIdentityName(person?.fullName) === target);
    if (!exact.length) return false;
    if (exact.some((person) => Number(person?.currentTeam?.id) === input.teamId)) return false;
    return exact.some((person) => {
      const currentTeamId = Number(person?.currentTeam?.id);
      return Number.isInteger(currentTeamId) && currentTeamId > 0 && currentTeamId !== input.teamId;
    });
  } catch {
    return false;
  }
}

function uniqueExactOfficialIlMatch(snapshot: MlbOfficialInjurySnapshot, name: string): boolean {
  const target = normalizeIdentityName(name);
  const matches = Object.values(snapshot?.rosterByPlayerId ?? {})
    .filter((entry) => normalizeIdentityName(entry?.name) === target)
    .filter((entry) => positiveInt(entry?.playerId) != null);
  const uniqueById = new Map<number, (typeof matches)[number]>();
  for (const entry of matches) uniqueById.set(Number(entry.playerId), entry);
  if (uniqueById.size !== 1) return false;
  return isOfficialMlbInjuredRosterEntry(Array.from(uniqueById.values())[0]);
}

export async function buildMlbRejectedIdentityReconciliationReport(input: {
  asOfDate: string;
  season: string;
  bdlKey: string;
  targets: MlbRejectedIdentityTarget[];
  fetchOfficialSnapshot?: FetchOfficialSnapshot;
  fetchImpl?: typeof fetch;
}): Promise<MlbRejectedIdentityReconciliationReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) throw new Error("Invalid asOfDate");
  if (!/^\d{4}$/.test(input.season)) throw new Error("Invalid season");
  if (!input.bdlKey) throw new Error("Missing BDL credential");
  const fetchImpl = input.fetchImpl ?? fetch;
  const fetchSnapshot = input.fetchOfficialSnapshot
    ?? ((teamId: number, date: string) => fetchOfficialMlbInjurySnapshot(teamId, date));
  const activeByTeam = await fetchActiveBdlInjuriesByTeam(fetchImpl, input.bdlKey);
  const byTeam: Record<number, MlbRejectedIdentityTeamReconciliation> = {};

  for (const target of input.targets) {
    const expectedRejectedCount = nonNegativeInt(target.expectedRejectedCount);
    const existingNames = new Set(target.existingDetectedNames.map(normalizeIdentityName).filter(Boolean));
    const missingRecords = (activeByTeam[target.teamId] ?? [])
      .filter((injury) => !existingNames.has(normalizeIdentityName(injuryDisplayName(injury))));
    const observedMissingCount = missingRecords.length;
    const countParity = observedMissingCount === expectedRejectedCount;

    let snapshot: MlbOfficialInjurySnapshot | null = null;
    let sourceHealthy = false;
    if (countParity && expectedRejectedCount > 0) {
      try {
        snapshot = await fetchSnapshot(target.teamId, input.asOfDate);
        sourceHealthy = snapshot?.status === "VERIFIED" && (snapshot?.errors?.length ?? 0) === 0;
      } catch {
        sourceHealthy = false;
      }
    }

    let exactWrongCurrentTeamCount = 0;
    let officialIlReconciledCount = 0;
    if (countParity && sourceHealthy && snapshot) {
      for (const injury of missingRecords) {
        const name = injuryDisplayName(injury);
        const wrongCurrentTeam = await reproducesExactWrongCurrentTeam({
          name,
          teamId: target.teamId,
          season: input.season,
          fetchImpl,
        });
        if (!wrongCurrentTeam) continue;
        exactWrongCurrentTeamCount += 1;
        if (uniqueExactOfficialIlMatch(snapshot, name)) officialIlReconciledCount += 1;
      }
    }

    const unresolvedRejectedCount = countParity
      ? Math.max(0, expectedRejectedCount - officialIlReconciledCount)
      : expectedRejectedCount;
    byTeam[target.teamId] = {
      expectedRejectedCount,
      observedMissingCount,
      exactWrongCurrentTeamCount,
      officialIlReconciledCount,
      unresolvedRejectedCount,
      countParity,
      sourceHealthy,
      eligible: expectedRejectedCount > 0
        && countParity
        && sourceHealthy
        && exactWrongCurrentTeamCount === expectedRejectedCount
        && officialIlReconciledCount === expectedRejectedCount
        && unresolvedRejectedCount === 0,
    };
  }

  return {
    schemaVersion: MLB_REJECTED_IDENTITY_RECONCILIATION_SCHEMA,
    asOfDate: input.asOfDate,
    privacy: {
      aggregateOnly: true,
      playerNamesReturned: false,
      playerIdsReturned: false,
      credentialReturned: false,
    },
    byTeam,
  };
}

function gamesFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.games)) return payload.games;
  if (Array.isArray(payload?.data?.games)) return payload.data.games;
  return [];
}

function baseSideEligibleForOfficialSupplement(meta: any): boolean {
  const sourceErrors = Array.isArray(meta?.sourceErrors) ? meta.sourceErrors : [];
  return clean(meta?.source).toUpperCase() === "BALLDONTLIE"
    && clean(meta?.validationSource).toUpperCase() === "MLB_STATS"
    && clean(meta?.status).toUpperCase() === "PARTIAL"
    && clean(meta?.officialValidationStatus).toUpperCase() === "VERIFIED"
    && meta?.stale !== true
    && sourceErrors.length === 0
    && nonNegativeInt(meta?.shadowSummary?.officialOnly) > 0
    && clean(meta?.phaseB?.coverage).toUpperCase() === "PARTIAL";
}

function sideEligibleForOfficialSupplement(
  meta: any,
  rejectedReconciliation?: MlbRejectedIdentityTeamReconciliation,
): boolean {
  if (!baseSideEligibleForOfficialSupplement(meta)) return false;
  const rejectedCount = nonNegativeInt(meta?.rejectedCount);
  if (rejectedCount === 0) return true;
  return rejectedReconciliation?.eligible === true
    && rejectedReconciliation.expectedRejectedCount === rejectedCount
    && rejectedReconciliation.observedMissingCount === rejectedCount
    && rejectedReconciliation.exactWrongCurrentTeamCount === rejectedCount
    && rejectedReconciliation.officialIlReconciledCount === rejectedCount
    && rejectedReconciliation.unresolvedRejectedCount === 0;
}

function existingIds(injuries: any[]): number[] {
  return injuries
    .map((player) => positiveInt(player?.playerId))
    .filter((value): value is number => value != null);
}

function existingDetectedNames(injuries: any[]): string[] {
  return injuries
    .filter((player) => clean(player?.source).toUpperCase() === "BDL")
    .map((player) => clean(player?.name))
    .filter(Boolean);
}

function rejectedIdentityTargetsFromPayload(payload: any): MlbRejectedIdentityTarget[] {
  const byTeam = new Map<number, MlbRejectedIdentityTarget>();
  const conflicted = new Set<number>();
  for (const game of gamesFromPayload(payload)) {
    for (const side of ["home", "away"] as const) {
      const meta = game?.[`${side}InjuryData`];
      const expectedRejectedCount = nonNegativeInt(meta?.rejectedCount);
      if (!baseSideEligibleForOfficialSupplement(meta) || expectedRejectedCount === 0) continue;
      const teamId = positiveInt(game?.[`${side}Team`]?.id);
      if (!teamId || conflicted.has(teamId)) continue;
      const injuries = Array.isArray(game?.[`${side}Injuries`]) ? game[`${side}Injuries`] : [];
      const names = existingDetectedNames(injuries).map(normalizeIdentityName).sort();
      const next: MlbRejectedIdentityTarget = {
        teamId,
        expectedRejectedCount,
        existingDetectedNames: names,
      };
      const previous = byTeam.get(teamId);
      if (!previous) {
        byTeam.set(teamId, next);
        continue;
      }
      const same = previous.expectedRejectedCount === next.expectedRejectedCount
        && JSON.stringify(previous.existingDetectedNames) === JSON.stringify(next.existingDetectedNames);
      if (!same) {
        byTeam.delete(teamId);
        conflicted.add(teamId);
      }
    }
  }
  return Array.from(byTeam.values()).sort((left, right) => left.teamId - right.teamId);
}

async function supplementSide(input: {
  game: any;
  side: "home" | "away";
  asOfDate: string;
  fetchOfficialSnapshot: FetchOfficialSnapshot;
  rejectedIdentityReport?: MlbRejectedIdentityReconciliationReport;
}): Promise<void> {
  const metaKey = `${input.side}InjuryData`;
  const injuriesKey = `${input.side}Injuries`;
  const teamKey = `${input.side}Team`;
  const meta = input.game?.[metaKey];
  const teamId = positiveInt(input.game?.[teamKey]?.id);
  if (!teamId) return;
  const rejectedReconciliation = input.rejectedIdentityReport?.byTeam?.[teamId];
  if (!sideEligibleForOfficialSupplement(meta, rejectedReconciliation)) return;

  const injuries = Array.isArray(input.game?.[injuriesKey]) ? input.game[injuriesKey] : [];
  const expectedOfficialOnly = nonNegativeInt(meta?.shadowSummary?.officialOnly);
  const rawRejectedCount = nonNegativeInt(meta?.rejectedCount);
  const reconciledRejectedCount = rawRejectedCount > 0
    ? nonNegativeInt(rejectedReconciliation?.officialIlReconciledCount)
    : 0;
  const unresolvedRejectedCount = rawRejectedCount > 0
    ? nonNegativeInt(rejectedReconciliation?.unresolvedRejectedCount)
    : 0;

  let officialSnapshot: MlbOfficialInjurySnapshot;
  try {
    officialSnapshot = await input.fetchOfficialSnapshot(teamId, input.asOfDate);
  } catch {
    return;
  }

  const reconciliation = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    anomalous: false,
    rejectedCount: unresolvedRejectedCount,
    officialSnapshot,
    existingPlayerIds: existingIds(injuries),
    asOfDate: input.asOfDate,
  });

  // Chain-of-custody guard: if response metadata and the current official snapshot disagree,
  // preserve PARTIAL rather than upgrading mismatched evidence.
  if (reconciliation.rawOfficialOnlyCount !== expectedOfficialOnly) return;
  if (!reconciliation.coverageReconciled || reconciliation.unresolvedOfficialOnlyCount !== 0) return;
  if (reconciliation.supplementedCount !== expectedOfficialOnly) return;

  input.game[injuriesKey] = [...injuries, ...reconciliation.supplements];
  input.game[metaKey] = {
    ...meta,
    status: "VERIFIED",
    count: injuries.length + reconciliation.supplements.length,
    officialSupplementedCount: reconciliation.supplementedCount,
    unresolvedOfficialOnlyCount: 0,
    coverageReconciled: true,
    coverageMode: "BDL_PLUS_MLB_OFFICIAL_SUPPLEMENT",
    supplementSchemaVersion: MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA,
    supplementEvidenceOnly: true,
    ...(rawRejectedCount > 0 ? {
      rejectedIdentityReconciledCount: reconciledRejectedCount,
      unresolvedRejectedIdentityCount: 0,
      rejectedIdentityReconciliationMode: MLB_REJECTED_IDENTITY_RECONCILIATION_MODE,
      rejectedIdentityReconciliationReason: MLB_REJECTED_IDENTITY_RECONCILIATION_REASON,
      rejectedIdentityReconciliationEvidenceOnly: true,
    } : {}),
    shadowSummary: {
      ...(meta?.shadowSummary ?? {}),
      officialSupplemented: reconciliation.supplementedCount,
      unresolvedOfficialOnly: 0,
    },
    // Intentionally preserve Phase B unchanged. Official-only and identity-reconciled rows are
    // evidence-only and never become auto-apply candidates through this middleware.
    phaseB: meta?.phaseB,
    autoApplyAllowed: meta?.autoApplyAllowed === true,
    note: rawRejectedCount > 0
      ? `${reconciledRejectedCount} identidad(es) BDL rechazadas por currentTeam fueron reconciliadas con IL MLB oficial; ${reconciliation.supplementedCount} ausencia(s) se conservan como evidencia-only y Phase B no las autoaplica.`
      : `${reconciliation.supplementedCount} ausencia(s) omitida(s) por BALLDONTLIE fueron reconciliadas con roster MLB oficial como evidencia; Phase B no las autoaplica.`,
  };
}

export async function supplementMlbAllOfficialInjuryEvidence(
  payload: any,
  asOfDate: string,
  fetchOfficialSnapshot: FetchOfficialSnapshot = (teamId, date) => fetchOfficialMlbInjurySnapshot(teamId, date),
  rejectedIdentityReport?: MlbRejectedIdentityReconciliationReport,
): Promise<any> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return payload;
  const games = gamesFromPayload(payload);
  if (!games.length) return payload;

  await Promise.all(games.flatMap((game) => (["home", "away"] as const).map((side) =>
    supplementSide({ game, side, asOfDate, fetchOfficialSnapshot, rejectedIdentityReport })
  )));
  return payload;
}

function attachDiagnostic(payload: any, diagnostic: MlbInjuryIdentityDiagnostic): any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...payload,
    researchInjuryIdentityDiagnostic: diagnostic,
  };
}

export function registerMlbOfficialInjurySupplementMiddleware(
  app: Express,
  fetchOfficialSnapshot: FetchOfficialSnapshot = (teamId, date) => fetchOfficialMlbInjurySnapshot(teamId, date),
  buildIdentityDiagnostic: BuildIdentityDiagnostic = (input) => buildMlbInjuryIdentityDiagnostic(input),
  getBdlKey: () => string = () => requireSecret("BDL_API_KEY"),
  buildRejectedIdentityReconciliation?: BuildRejectedIdentityReconciliation,
): void {
  const officialSnapshotCache = new Map<string, { expiresAt: number; promise: Promise<MlbOfficialInjurySnapshot> }>();
  let reconciliationCache: {
    key: string;
    expiresAt: number;
    promise: Promise<MlbRejectedIdentityReconciliationReport>;
  } | null = null;

  const cachedOfficialSnapshot: FetchOfficialSnapshot = (teamId, asOfDate) => {
    const key = `${teamId}:${asOfDate}`;
    const now = Date.now();
    const cached = officialSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;
    const promise = fetchOfficialSnapshot(teamId, asOfDate);
    officialSnapshotCache.set(key, { expiresAt: now + RECONCILIATION_TTL_MS, promise });
    void promise.catch(() => {
      if (officialSnapshotCache.get(key)?.promise === promise) officialSnapshotCache.delete(key);
    });
    return promise;
  };

  const reconciliationBuilder: BuildRejectedIdentityReconciliation = buildRejectedIdentityReconciliation
    ?? ((input) => buildMlbRejectedIdentityReconciliationReport({
      ...input,
      fetchOfficialSnapshot: cachedOfficialSnapshot,
    }));

  async function rejectedIdentityReportForPayload(
    payload: any,
    asOfDate: string,
  ): Promise<MlbRejectedIdentityReconciliationReport | undefined> {
    const targets = rejectedIdentityTargetsFromPayload(payload);
    if (!targets.length || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return undefined;
    const key = JSON.stringify({
      asOfDate,
      targets: targets.map((target) => ({
        teamId: target.teamId,
        expectedRejectedCount: target.expectedRejectedCount,
        existingDetectedNames: target.existingDetectedNames,
      })),
    });
    const now = Date.now();
    if (reconciliationCache && reconciliationCache.key === key && reconciliationCache.expiresAt > now) {
      return reconciliationCache.promise;
    }
    const promise = reconciliationBuilder({
      asOfDate,
      season: asOfDate.slice(0, 4),
      bdlKey: getBdlKey(),
      targets,
    });
    reconciliationCache = { key, expiresAt: now + RECONCILIATION_TTL_MS, promise };
    try {
      return await promise;
    } catch (error) {
      if (reconciliationCache?.promise === promise) reconciliationCache = null;
      throw error;
    }
  }

  app.use("/api/mlb/all", (req: Request, res: Response, next: NextFunction) => {
    const date = clean(req.query.date) || todayISO();
    const wantsIdentityDiagnostic = clean(req.query.researchInjuryIdentityDiagnostic) === MLB_INJURY_IDENTITY_DIAGNOSTIC_QUERY;
    const originalJson = res.json.bind(res);
    let intercepted = false;

    res.json = ((body: any) => {
      if (intercepted) return originalJson(body);
      intercepted = true;
      void (async () => {
        let rejectedIdentityReport: MlbRejectedIdentityReconciliationReport | undefined;
        try {
          rejectedIdentityReport = await rejectedIdentityReportForPayload(body, date);
        } catch (error) {
          console.error("MLB rejected injury identity reconciliation failed closed:", error);
        }

        const decorated = await supplementMlbAllOfficialInjuryEvidence(
          body,
          date,
          cachedOfficialSnapshot,
          rejectedIdentityReport,
        );
        if (!wantsIdentityDiagnostic || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return originalJson(decorated);
        }
        try {
          const diagnostic = await buildIdentityDiagnostic({
            asOfDate: date,
            season: date.slice(0, 4),
            bdlKey: getBdlKey(),
          });
          res.setHeader("Cache-Control", "no-store");
          return originalJson(attachDiagnostic(decorated, diagnostic));
        } catch (error) {
          console.error("MLB injury identity diagnostic failed closed:", error);
          return originalJson(decorated);
        }
      })().catch((error) => {
        console.error("MLB official injury supplement middleware failed closed:", error);
        originalJson(body);
      });
      return res;
    }) as Response["json"];

    next();
  });
}
