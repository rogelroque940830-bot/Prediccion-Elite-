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

// Outcome-blind MLB lower-tier prospective custody. This worker never prices,
// settles, stakes, or promotes a recommendation. Its only job is to preserve
// the first canonical T-5 pregame PP_HORIZON / Full Modular evidence snapshot.
const mlbLowerTierProspective = startMlbUnifiedEliteProspectiveCaptureWorker();
registerMlbUnifiedEliteProspectiveStatusRoute(app, mlbLowerTierProspective.service);
