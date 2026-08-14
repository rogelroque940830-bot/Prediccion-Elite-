import "./s5b-staging-entry";
import { app } from "./index";
import { startMultisportReadinessWorker } from "./multisport-readiness-service";
import { registerMultisportReadinessRoutes } from "./multisport-readiness-routes";

const s6aReadiness = startMultisportReadinessWorker();
registerMultisportReadinessRoutes(app, s6aReadiness.service);
