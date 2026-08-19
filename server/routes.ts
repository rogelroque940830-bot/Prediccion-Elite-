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
import { registerMlbP1FrozenOperatingEnvelopeRoutes } from "./mlb-p1-operating-envelope-frozen-routes";
import { registerMlbPremiumNoUltraProspectiveRoutes } from "./mlb-premium-no-ultra-prospective-routes";
import { registerMlbStatcastMatchupIdentityMiddleware } from "./mlb-statcast-matchup-identity-routes";
import { registerMlbOfficialInjurySupplementMiddleware } from "./mlb-injury-official-supplement-routes";
import { registerMlbCoreRoutes } from "./mlb-core-routes";
import { registerMlbF5OddsProtectionRoutes } from "./mlb-f5-odds-routes";
import { registerMlbP1M6a2MarketUniverseOddsRoutes } from "./mlb-market-universe-odds-routes";
import { registerMlbUnifiedPricedV16Routes } from "./mlb-unified-priced-v16-routes";
import { registerMlbUnifiedV16UiRoutes } from "./mlb-unified-v16-ui-routes";
import { createMlbUnifiedEliteLowerTierLiveProvider } from "./mlb-unified-elite-lower-tier-live-provider";
import { registerMlbTeamTotalShadowRoutes } from "./mlb-team-total-shadow-routes";
import { registerMlbBatterProspectiveCustodyRoutes } from "./mlb-batter-prospective-custody-routes";
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
  registerMlbP1FrozenOperatingEnvelopeRoutes(app);
  registerMlbPremiumNoUltraProspectiveRoutes(app);
  registerMlbStatcastMatchupIdentityMiddleware(app);
  // Decorates only safe PARTIAL injury responses with evidence-only MLB official supplements.
  // Exact rejected identities may close coverage only when payload/BDL counts match, the legacy
  // lookup reproduces WRONG_CURRENT_TEAM, and one verified MLB team-IL identity matches exactly.
  // Raw rejectedCount and Phase B remain unchanged; transaction-only/ambiguous evidence stays blocked.
  // Railway research reuses the existing GET /api/mlb/all surface through an explicit query
  // and appends aggregate-only identity diagnostics; it does not register a new route.
  // It must remain before the core GET /api/mlb/all handler.
  registerMlbOfficialInjurySupplementMiddleware(app);
  registerMlbCoreRoutes(app);
  registerMlbF5OddsProtectionRoutes(app);
  registerMlbP1M6a2MarketUniverseOddsRoutes(app);
  // Explicit shadow-only Team Total price capture. This route is never invoked by the normal V16
  // button, is capped per request, and cannot mutate production lookup authorization or Elite rows.
  registerMlbTeamTotalShadowRoutes(app);
  // Explicit future-only batter identity custody. This route captures only authoritative FINAL
  // pregame lineups/pitcher identities and never requests odds, scores a model, or mutates V16.
  registerMlbBatterProspectiveCustodyRoutes(app);
  // Browser-facing explicit preflight: verifies the official slate and server custody without
  // crossing the paid odds boundary or accepting forged certified sporting inputs from the UI.
  // Lower-tier PP_HORIZON / Full Modular evidence is injected server-side and remains shadow-only.
  registerMlbUnifiedV16UiRoutes(app, {
    unifiedEliteLowerTierShadowProvider: createMlbUnifiedEliteLowerTierLiveProvider(),
  });
  // Explicit command route for the full V16 priced runner. It is auth-protected by the global
  // private-read/write middleware registered before domain routes and never polls or self-triggers.
  registerMlbUnifiedPricedV16Routes(app);
  // S6B registers the resilient versions first; legacy duplicates remain only
  // for source compatibility and are not reached once S6B sends a response.
  registerWnbaS6bRoutes(app);
  registerWnbaNhlDataRoutes(app);
  registerLegacyPicksCompatibilityRoutes(app);
  registerMarketSupportRoutes(app);
  registerActiveOperationalIncidentCenterRoutes(app);
}
