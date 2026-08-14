// Operational-only source marker to force Railway to rebuild the p0 integration backend.
// Created after /health, /api/mlb/p1/v1/slate and /api/mlb/all all returned HTTP 502.
// This file is intentionally unimported and changes no application behavior.
export const P0_BACKEND_REDEPLOY_MARKER_20260808 = "2026-08-08T20:52Z" as const;
