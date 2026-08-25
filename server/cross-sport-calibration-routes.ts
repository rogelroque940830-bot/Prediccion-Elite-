import type { Express } from "express";
import { getCrossSportCalibrationReadiness } from "./cross-sport-calibration-readiness";

export function registerCrossSportCalibrationRoutes(app: Express): void {
  app.get("/api/multisport/calibration/v1/status", (_req, res) => {
    const status = getCrossSportCalibrationReadiness();
    return res.status(status.state === "CERTIFIED" ? 200 : 503).json({
      success: status.state === "CERTIFIED",
      data: status,
      code: status.state === "CERTIFIED"
        ? "CROSS_SPORT_CALIBRATION_CERTIFIED"
        : status.state === "READY_FOR_FIT"
          ? "CROSS_SPORT_CALIBRATION_READY_FOR_FIT"
          : "CROSS_SPORT_CALIBRATION_BLOCKED",
    });
  });
}
