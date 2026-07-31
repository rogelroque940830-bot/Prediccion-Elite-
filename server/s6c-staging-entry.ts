import "./s6a-staging-entry";
import { app } from "./index";
import { startWnbaShadowWorker } from "./wnba-s6c-shadow-service";
import { registerWnbaShadowRoutes } from "./wnba-s6c-shadow-routes";

const s6cShadow = startWnbaShadowWorker();
registerWnbaShadowRoutes(app, s6cShadow.service);
