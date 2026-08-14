import type { Express } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import { activeMlbLedgerRecords } from "./mlb-active-records";
import {
  buildOperationalIncidentCenter,
  type OperationalIncidentCenterReport,
} from "./operational-incident-center";
import type { OperationalIncidentCenterProvider } from "./operational-sla-alerts";
import { getUserPickFileStore } from "./picks-v2-multiuser";
import { resolveRequestUserId, resolveSystemOwnerUserId } from "./user-data-context";
import { startWnbaShadowWorker } from "./wnba-s6c-shadow-service";

const ACTIVE_INCIDENT_ROUTE = ["/api/ops/v1", "incident-center"].join("/");

function safeOwner(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Invalid active incident owner id");
  return parsed;
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(1_000, Math.floor(parsed));
}

export function createActiveOperationalIncidentCenterProvider(
  defaultOwnerUserId: number,
): OperationalIncidentCenterProvider {
  const ledgerStore = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  const pickStore = getUserPickFileStore();
  const wnbaService = startWnbaShadowWorker().service;
  const defaultOwner = safeOwner(defaultOwnerUserId);

  return (ownerUserId: number): OperationalIncidentCenterReport => {
    const owner = safeOwner(ownerUserId);
    const owned = ownedRecordsForUser(
      ledgerStore,
      ownershipStore,
      owner,
      { limit: 10_000 },
    );
    return buildOperationalIncidentCenter({
      mlbRecords: activeMlbLedgerRecords(owned),
      wnbaRecords: wnbaService.readRecords(),
      wnbaSettlements: wnbaService.readSettlements(),
      wnbaStatus: wnbaService.status(),
      manualPicks: pickStore.listForUser(owner, defaultOwner),
      ledgerStatus: ledgerStore.status(),
      includeResolved: false,
    });
  };
}

export function registerActiveOperationalIncidentCenterRoutes(app: Express): void {
  const defaultOwner = resolveSystemOwnerUserId();
  const provider = createActiveOperationalIncidentCenterProvider(defaultOwner);

  app.get(ACTIVE_INCIDENT_ROUTE, async (req, res) => {
    const userId = resolveRequestUserId(req);
    const report = await provider(userId);
    const limit = boundedLimit(req.query.limit);
    res.json({
      success: true,
      data: {
        ...report,
        incidents: report.incidents.slice(0, limit),
      },
      userId,
    });
  });
}
