import { timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";

export const ADMIN_WRITE_ROUTES = [
  "/api/picks/sync",
  "/api/clv/reset",
  "/api/clv/refresh",
] as const;

const OBSERVED_ROUTES = new Set<string>([
  ...ADMIN_WRITE_ROUTES,
  "/api/staging/admin-auth-probe",
]);

type AdminAuthState = "not_configured" | "missing" | "invalid" | "valid";

interface AdminAuthObservation {
  mode: "observe";
  blocking: false;
  route: string;
  tokenConfigured: boolean;
  credentialPresented: boolean;
  state: AdminAuthState;
}

function extractCredential(req: Request): string | null {
  const explicitHeader = req.get("x-admin-token")?.trim();
  if (explicitHeader) return explicitHeader;

  const authorization = req.get("authorization")?.trim() ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || null;
}

function credentialsMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function classifyCredential(
  provided: string | null,
  expected = process.env.ADMIN_API_TOKEN?.trim() ?? "",
): AdminAuthState {
  if (!expected) return "not_configured";
  if (!provided) return "missing";
  return credentialsMatch(provided, expected) ? "valid" : "invalid";
}

function observeRequest(req: Request): AdminAuthObservation {
  const expected = process.env.ADMIN_API_TOKEN?.trim() ?? "";
  const provided = extractCredential(req);

  return {
    mode: "observe",
    blocking: false,
    route: req.path,
    tokenConfigured: Boolean(expected),
    credentialPresented: Boolean(provided),
    state: classifyCredential(provided, expected),
  };
}

export function registerStagingAdminAuthObservation(app: Express): void {
  app.use((req, res, next) => {
    if (req.method !== "POST" || !OBSERVED_ROUTES.has(req.path)) {
      return next();
    }

    const observation = observeRequest(req);
    res.locals.adminAuthObservation = observation;
    res.setHeader("X-Admin-Auth-Mode", observation.mode);
    res.setHeader("X-Admin-Auth-State", observation.state);
    res.setHeader("X-Admin-Auth-Configured", String(observation.tokenConfigured));
    res.setHeader("X-Admin-Auth-Blocking", "false");

    console.log(
      `[admin-auth-observe] ${req.method} ${req.path} state=${observation.state} ` +
        `configured=${observation.tokenConfigured} presented=${observation.credentialPresented} forwarded=true`,
    );

    return next();
  });

  app.get("/api/staging/admin-auth-status", (_req, res) => {
    return res.json({
      success: true,
      mode: "observe",
      blocking: false,
      tokenConfigured: Boolean(process.env.ADMIN_API_TOKEN?.trim()),
      protectedRoutes: ADMIN_WRITE_ROUTES,
      acceptedCredentials: [
        "Authorization: Bearer <token>",
        "X-Admin-Token: <token>",
      ],
      note: "Observation only: write requests are logged and always forwarded.",
    });
  });

  app.get("/api/staging/admin-auth-self-test", (_req, res) => {
    const expected = process.env.ADMIN_API_TOKEN?.trim() ?? "";
    const tokenConfigured = Boolean(expected);
    const invalidCandidate = expected ? `${expected}__invalid` : "__invalid";

    return res.json({
      success: true,
      mode: "observe",
      blocking: false,
      tokenConfigured,
      states: {
        missing: classifyCredential(null, expected),
        invalid: classifyCredential(invalidCandidate, expected),
        valid: classifyCredential(expected || null, expected),
      },
      tokenExposed: false,
      mutatedData: false,
      note: "In-memory classification only. No protected route was executed.",
    });
  });

  app.post("/api/staging/admin-auth-probe", (_req, res) => {
    return res.json({
      success: true,
      observation: res.locals.adminAuthObservation ?? null,
      mutatedData: false,
    });
  });
}
