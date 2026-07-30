import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

const WINDOW_MS = positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const READ_LIMIT = positiveInt(process.env.RATE_LIMIT_READ_MAX, 180);
const WRITE_LIMIT = positiveInt(process.env.RATE_LIMIT_WRITE_MAX, 30);

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clientIp(req: Request): string {
  // Express resolves the trusted Railway proxy chain after app.set("trust proxy", 1).
  // Do not read x-forwarded-for directly because an untrusted client can spoof it.
  return (req.ip || req.socket.remoteAddress || "unknown").trim();
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function timingSafeEqualText(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function configuredOrigins(): Set<string> {
  return new Set(
    (process.env.COURTEDGE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function headerText(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value || "").trim();
}

function hasAuthenticatedSession(req: Request): boolean {
  const sessionData = (req as Request & { session?: Record<string, unknown> }).session;
  return Boolean(
    sessionData?.courtEdgeAuthenticated &&
    Number.isInteger(sessionData.courtEdgeUserId) &&
    typeof sessionData.courtEdgeUser === "string" &&
    typeof sessionData.courtEdgeRole === "string",
  );
}

function hasValidServiceToken(req: Request): boolean {
  const expected = (process.env.COURTEDGE_WRITE_TOKEN || "").trim();
  if (!expected) return false;

  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const header = headerText(req, "x-courtedge-write-key");
  const actual = (bearer || header || "").trim();
  return Boolean(actual && timingSafeEqualText(actual, expected));
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function restrictedCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin?.replace(/\/$/, "");
  const allowedOrigins = configuredOrigins();
  const allowed = !origin || allowedOrigins.has(origin) || isLocalDevelopmentOrigin(origin);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-CourtEdge-Write-Key, X-CourtEdge-CSRF",
  );
  res.setHeader("Access-Control-Max-Age", "600");

  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(allowed ? 204 : 403);
    return;
  }

  if (!allowed) {
    res.status(403).json({ success: false, error: "Origin not allowed" });
    return;
  }

  next();
}

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }

  const now = Date.now();
  const write = isWriteMethod(req.method);
  const limit = write ? WRITE_LIMIT : READ_LIMIT;
  const key = `${clientIp(req)}:${write ? "write" : "read"}`;
  const current = buckets.get(key);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + WINDOW_MS }
    : current;

  bucket.count += 1;
  buckets.set(key, bucket);

  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > limit) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ success: false, error: "Too many requests" });
    return;
  }

  next();
}

// User-owned and detailed operational evidence is private. Sharp/market reads remain
// public because they are shared market observations consumed before authentication.
const PRIVATE_READ_PATHS = [
  /^\/api\/picks(?:\/|$)/,
  /^\/api\/clv(?:\/|$)/,
  /^\/api\/mlb\/ledger(?:\/|$)/,
  /^\/api\/multisport\/readiness(?:\/|$)/,
  /^\/api\/ops(?:\/|$)/,
];

function isPublicLedgerRead(req: Request): boolean {
  return req.method.toUpperCase() === "GET" && req.path === "/api/mlb/ledger/v1/status";
}

function isPrivateRead(req: Request): boolean {
  if (!["GET", "HEAD"].includes(req.method.toUpperCase())) return false;
  if (isPublicLedgerRead(req)) return false;
  return PRIVATE_READ_PATHS.some((pattern) => pattern.test(req.path));
}

export function requirePrivateReadAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isPrivateRead(req) || hasAuthenticatedSession(req) || hasValidServiceToken(req)) {
    next();
    return;
  }

  res.status(401).json({
    success: false,
    error: "Authentication required for private data",
  });
}

const PROTECTED_WRITE_PATHS = [
  /^\/api\/picks(?:\/|$)/,
  /^\/api\/clv(?:\/|$)/,
  /^\/api\/sharp(?:\/|$)/,
  /^\/api\/mlb\/ledger(?:\/|$)/,
  /^\/api\/auth\/users(?:\/|$)/,
  /^\/api\/ops(?:\/|$)/,
];

function isProtectedWrite(req: Request): boolean {
  return isWriteMethod(req.method) && PROTECTED_WRITE_PATHS.some((pattern) => pattern.test(req.path));
}

function hasValidSessionWrite(req: Request): "valid" | "invalid-csrf" | "none" {
  const sessionData = (req as Request & { session?: Record<string, unknown> }).session;
  if (!sessionData?.courtEdgeAuthenticated) return "none";

  const expected = typeof sessionData.csrfToken === "string" ? sessionData.csrfToken : "";
  const actual = headerText(req, "x-courtedge-csrf");
  if (!expected || !actual || !timingSafeEqualText(actual, expected)) return "invalid-csrf";
  return "valid";
}

export function requireWriteAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isProtectedWrite(req)) {
    next();
    return;
  }

  // The legacy full-state sync can overwrite the canonical picks store.
  if (req.path === "/api/picks/sync" && process.env.ALLOW_LEGACY_PICKS_SYNC !== "true") {
    res.status(410).json({
      success: false,
      error: "Legacy picks sync is disabled. Use /api/picks/v2.",
    });
    return;
  }

  const sessionState = hasValidSessionWrite(req);
  if (sessionState === "valid" || hasValidServiceToken(req)) {
    next();
    return;
  }

  if (sessionState === "invalid-csrf") {
    res.status(403).json({ success: false, error: "Invalid CSRF token" });
    return;
  }

  res.status(401).json({
    success: false,
    error: "Authentication required for write operations",
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, WINDOW_MS);
cleanupTimer.unref();
