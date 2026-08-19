import "./s6c-staging-entry";
import { app } from "./index";
import { startWnbaEvaluationEmissionWorker } from "./wnba-s6e-evaluation-emission-service";
import { registerWnbaEvaluationEmissionRoutes } from "./wnba-s6e-evaluation-emission-routes";
import { startWnbaPredictorShadowWorker } from "./wnba-s6d-predictor-shadow-service";
import { registerWnbaPredictorShadowRoutes } from "./wnba-s6d-predictor-shadow-routes";
import {
  registerMlbUnifiedEliteProspectiveStatusRoute,
  startMlbUnifiedEliteProspectiveCaptureWorker,
} from "./mlb-unified-elite-prospective-capture-service-v1";

const s6eEmission = startWnbaEvaluationEmissionWorker();
registerWnbaEvaluationEmissionRoutes(app, s6eEmission.service);

const s6dShadow = startWnbaPredictorShadowWorker({
  modernPicksPath: s6eEmission.service.getProjectionPath(),
});
registerWnbaPredictorShadowRoutes(app, s6dShadow.service);

// Outcome-blind MLB lower-tier prospective custody. Railway application filesystems
// are not an acceptable scientific custody boundary unless a durable volume (or an
// explicitly managed custody path) is configured. Fail closed instead of counting
// evidence that could disappear on a redeploy.
const railwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const durableMlbProspectiveCustody = Boolean(
  process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim()
  || process.env.MLB_UNIFIED_ELITE_CUSTODY_DB_PATH?.trim(),
);
if (railwayRuntime && !durableMlbProspectiveCustody) {
  process.env.MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_ENABLED = "false";
  console.error(
    "[mlb-lower-tier-prospective] capture disabled fail-closed: persistent Railway custody is not configured",
  );
}

// The worker never prices, settles, stakes, or promotes a recommendation. Its only
// job is to preserve the first canonical T-5 pregame PP_HORIZON / Full Modular evidence.
const mlbLowerTierProspective = startMlbUnifiedEliteProspectiveCaptureWorker();
registerMlbUnifiedEliteProspectiveStatusRoute(app, mlbLowerTierProspective.service);
