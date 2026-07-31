import "./s6c-staging-entry";
import { app } from "./index";
import { startWnbaPredictorShadowWorker } from "./wnba-s6d-predictor-shadow-service";
import { registerWnbaPredictorShadowRoutes } from "./wnba-s6d-predictor-shadow-routes";

const s6dShadow = startWnbaPredictorShadowWorker();
registerWnbaPredictorShadowRoutes(app, s6dShadow.service);
