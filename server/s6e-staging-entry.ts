import "./s6c-staging-entry";
import { app } from "./index";
import { startWnbaEvaluationEmissionWorker } from "./wnba-s6e-evaluation-emission-service";
import { registerWnbaEvaluationEmissionRoutes } from "./wnba-s6e-evaluation-emission-routes";
import { startWnbaPredictorShadowWorker } from "./wnba-s6d-predictor-shadow-service";
import { registerWnbaPredictorShadowRoutes } from "./wnba-s6d-predictor-shadow-routes";

const s6eEmission = startWnbaEvaluationEmissionWorker();
registerWnbaEvaluationEmissionRoutes(app, s6eEmission.service);

const s6dShadow = startWnbaPredictorShadowWorker({
  modernPicksPath: s6eEmission.service.getProjectionPath(),
});
registerWnbaPredictorShadowRoutes(app, s6dShadow.service);
