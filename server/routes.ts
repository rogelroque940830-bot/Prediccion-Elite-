import type { Express } from "express";
import type { Server } from "http";
import { registerNbaManualRoutes } from "./nba-manual-routes";
import { registerIndependentNbaRoutes } from "./nba-independent-routes";
import { registerNhlManualRoutes } from "./nhl-manual-routes";
import { registerIndependentWnbaRoutes } from "./wnba-independent-routes";
import { registerMlbEarlyRoutes } from "./mlb-early-routes";
import { registerLegacyPicksV2Routes } from "./legacy-picks-v2-routes";
import { registerNbaDataRoutes } from "./nba-data-routes";
import { registerMlbP1DailySlateRoutes } from "./mlb-p1-daily-slate-routes";
import { registerMlbP1PregameReadinessRoutes } from "./mlb-p1-pregame-readiness-routes";
import { registerMlbP1ScientificCaptureRoutes } from "./mlb-p1-scientific-capture-routes";
import { registerMlbP1EconomicReviewRoutes } from "./mlb-p1-economic-review-routes";
import { registerMlbP1OperatingEnvelopeRoutes } from "./mlb-p1-operating-envelope-routes";
import { registerMlbStatcastMatchupIdentityMiddleware } from "./mlb-statcast-matchup-identity-routes";
import { registerMlbCoreRoutes } from "./mlb-core-routes";
import { registerMlbF5OddsProtectionRoutes } from "./mlb-f5-odds-routes";
import { registerMlbP1M6a2MarketUniverseOddsRoutes } from "./mlb-market-universe-odds-routes";
import { registerWnbaS6bRoutes } from "./wnba-s6b-routes";
import { registerWnbaNhlDataRoutes } from "./wnba-nhl-data-routes";
import { registerLegacyPicksCompatibilityRoutes } from "./legacy-picks-routes";
import { registerMarketSupportRoutes } from "./market-support-routes";
import { registerActiveOperationalIncidentCenterRoutes } from "./operational-incident-center-active";

/**
 * Backend route composition root. Domain behavior lives in dedicated modules;
 * this function only preserves registration order and compatibility.
 */
export function registerRoutes(_httpServer: Server, app: Express): void {
  registerIndependentNbaRoutes(app);
  registerNbaManualRoutes(app);
  registerNhlManualRoutes(app);
  registerIndependentWnbaRoutes(app);
  registerMlbEarlyRoutes(app);
  registerLegacyPicksV2Routes(app);
  registerNbaDataRoutes(app);
  registerMlbP1DailySlateRoutes(app);
  registerMlbP1PregameReadinessRoutes(app);
  registerMlbP1ScientificCaptureRoutes(app);
  registerMlbP1EconomicReviewRoutes(app);
  registerMlbP1OperatingEnvelopeRoutes(app);
  registerMlbStatcastMatchupIdentityMiddleware(app);
  registerMlbCoreRoutes(app);
  registerMlbF5OddsProtectionRoutes(app);
  registerMlbP1M6a2MarketUniverseOddsRoutes(app);
  // S6B registers the resilient versions first; legacy duplicates remain only
  // for source compatibility and are not reached once S6B sends a response.
  registerWnbaS6bRoutes(app);
  registerWnbaNhlDataRoutes(app);
  registerLegacyPicksCompatibilityRoutes(app);
  registerMarketSupportRoutes(app);
  registerActiveOperationalIncidentCenterRoutes(app);
}