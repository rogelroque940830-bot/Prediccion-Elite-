import type { Express, NextFunction, Request, Response } from "express";
import { fetchOfficialMlbInjurySnapshot, type MlbOfficialInjurySnapshot } from "./mlb-injury-shadow";
import {
  buildMlbInjuryIdentityDiagnostic,
  reconcileMlbOfficialOnlyInjuries,
} from "./mlb-injury-official-supplement";
import { requireSecret, todayISO } from "./route-runtime";

export const MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA = "courtedge-mlb-official-injury-supplement.v1" as const;

type FetchOfficialSnapshot = (
  teamId: number,
  asOfDate: string,
) => Promise<MlbOfficialInjurySnapshot>;

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

function gamesFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.games)) return payload.games;
  if (Array.isArray(payload?.data?.games)) return payload.data.games;
  return [];
}

function sideEligibleForOfficialSupplement(meta: any): boolean {
  const sourceErrors = Array.isArray(meta?.sourceErrors) ? meta.sourceErrors : [];
  return clean(meta?.source).toUpperCase() === "BALLDONTLIE"
    && clean(meta?.validationSource).toUpperCase() === "MLB_STATS"
    && clean(meta?.status).toUpperCase() === "PARTIAL"
    && clean(meta?.officialValidationStatus).toUpperCase() === "VERIFIED"
    && meta?.stale !== true
    && sourceErrors.length === 0
    && nonNegativeInt(meta?.rejectedCount) === 0
    && nonNegativeInt(meta?.shadowSummary?.officialOnly) > 0
    && clean(meta?.phaseB?.coverage).toUpperCase() === "PARTIAL";
}

function existingIds(injuries: any[]): number[] {
  return injuries
    .map((player) => positiveInt(player?.playerId))
    .filter((value): value is number => value != null);
}

async function supplementSide(input: {
  game: any;
  side: "home" | "away";
  asOfDate: string;
  fetchOfficialSnapshot: FetchOfficialSnapshot;
}): Promise<void> {
  const metaKey = `${input.side}InjuryData`;
  const injuriesKey = `${input.side}Injuries`;
  const teamKey = `${input.side}Team`;
  const meta = input.game?.[metaKey];
  if (!sideEligibleForOfficialSupplement(meta)) return;

  const teamId = positiveInt(input.game?.[teamKey]?.id);
  if (!teamId) return;
  const injuries = Array.isArray(input.game?.[injuriesKey]) ? input.game[injuriesKey] : [];
  const expectedOfficialOnly = nonNegativeInt(meta?.shadowSummary?.officialOnly);

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
    rejectedCount: 0,
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
    shadowSummary: {
      ...(meta?.shadowSummary ?? {}),
      officialSupplemented: reconciliation.supplementedCount,
      unresolvedOfficialOnly: 0,
    },
    // Intentionally preserve Phase B unchanged. Official-only rows are evidence-only and
    // never become auto-apply candidates unless they also arrive through the detector path.
    phaseB: meta?.phaseB,
    autoApplyAllowed: meta?.autoApplyAllowed === true,
    note: `${reconciliation.supplementedCount} ausencia(s) omitida(s) por BALLDONTLIE fueron reconciliadas con roster MLB oficial como evidencia; Phase B no las autoaplica.`,
  };
}

export async function supplementMlbAllOfficialInjuryEvidence(
  payload: any,
  asOfDate: string,
  fetchOfficialSnapshot: FetchOfficialSnapshot = (teamId, date) => fetchOfficialMlbInjurySnapshot(teamId, date),
): Promise<any> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return payload;
  const games = gamesFromPayload(payload);
  if (!games.length) return payload;

  await Promise.all(games.flatMap((game) => (["home", "away"] as const).map((side) =>
    supplementSide({ game, side, asOfDate, fetchOfficialSnapshot })
  )));
  return payload;
}

export function registerMlbOfficialInjurySupplementMiddleware(
  app: Express,
  fetchOfficialSnapshot: FetchOfficialSnapshot = (teamId, date) => fetchOfficialMlbInjurySnapshot(teamId, date),
): void {
  // Aggregate-only research surface. It executes inside Railway so the provider credential
  // never leaves the service. The response deliberately contains no player names or IDs.
  app.get("/api/mlb/research/injury-identity-diagnostic", async (req: Request, res: Response) => {
    const date = clean(req.query.date) || todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "INVALID_DATE" });
    }
    try {
      const diagnostic = await buildMlbInjuryIdentityDiagnostic({
        asOfDate: date,
        season: date.slice(0, 4),
        bdlKey: requireSecret("BDL_API_KEY"),
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json(diagnostic);
    } catch (error) {
      console.error("MLB injury identity diagnostic failed:", error);
      return res.status(503).json({ error: "DIAGNOSTIC_UNAVAILABLE" });
    }
  });

  app.use("/api/mlb/all", (req: Request, res: Response, next: NextFunction) => {
    const date = clean(req.query.date) || todayISO();
    const originalJson = res.json.bind(res);
    let intercepted = false;

    res.json = ((body: any) => {
      if (intercepted) return originalJson(body);
      intercepted = true;
      void supplementMlbAllOfficialInjuryEvidence(body, date, fetchOfficialSnapshot)
        .then((decorated) => originalJson(decorated))
        .catch((error) => {
          console.error("MLB official injury supplement middleware failed closed:", error);
          originalJson(body);
        });
      return res;
    }) as Response["json"];

    next();
  });
}
