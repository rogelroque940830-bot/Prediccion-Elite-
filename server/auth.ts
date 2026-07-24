import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const MemoryStore = createMemoryStore(session);

type AttemptBucket = { count: number; resetAt: number };
const loginAttempts = new Map<string, AttemptBucket>();

declare module "express-session" {
  interface SessionData {
    courtEdgeAuthenticated?: boolean;
    courtEdgeUser?: string;
    csrfToken?: string;
  }
}

function requiredEnv(name: string, nonProductionFallback?: string): string {
  const value = (process.env[name] || "").trim();
  if (value) return value;
  if (process.env.NODE_ENV !== "production" && nonProductionFallback) return nonProductionFallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || "unknown").trim();
}

function timingSafeEqualBuffer(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length < 16 || expected.length < 32) return false;

  const actual = crypto.scryptSync(password, salt, expected.length);
  return timingSafeEqualBuffer(actual, expected);
}

function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = clientIp(req);
  const current = loginAttempts.get(key);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + LOGIN_WINDOW_MS }
    : current;

  if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ success: false, error: "Too many login attempts" });
    return;
  }

  (res.locals as Record<string, unknown>).loginAttemptBucket = bucket;
  next();
}

function recordFailedLogin(req: Request, res: Response): void {
  const bucket = (res.locals as Record<string, unknown>).loginAttemptBucket as AttemptBucket | undefined;
  if (!bucket) return;
  bucket.count += 1;
  loginAttempts.set(clientIp(req), bucket);
}

function clearLoginAttempts(req: Request): void {
  loginAttempts.delete(clientIp(req));
}

export function createSessionMiddleware() {
  const production = process.env.NODE_ENV === "production";
  const secret = requiredEnv(
    "COURTEDGE_SESSION_SECRET",
    "development-only-courtedge-session-secret-change-me",
  );

  return session({
    name: "courtedge.sid",
    secret,
    store: new MemoryStore({ checkPeriod: SESSION_TTL_MS }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: production,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: production ? "none" : "lax",
      maxAge: SESSION_TTL_MS,
      path: "/",
      ...(production ? { partitioned: true } : {}),
    } as session.CookieOptions,
  });
}

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/session", (req, res) => {
    res.json({
      success: true,
      authenticated: Boolean(req.session.courtEdgeAuthenticated),
      user: req.session.courtEdgeUser || null,
      csrfToken: req.session.courtEdgeAuthenticated ? req.session.csrfToken || null : null,
    });
  });

  app.post("/api/auth/login", loginRateLimit, (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const expectedUser = requiredEnv("COURTEDGE_ADMIN_USERNAME", "admin");
    const expectedHash = requiredEnv(
      "COURTEDGE_ADMIN_PASSWORD_SCRYPT",
      "scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000",
    );

    const validUser = username.length > 0 && username === expectedUser;
    const validPassword = password.length >= 8 && verifyPassword(password, expectedHash);

    if (!validUser || !validPassword) {
      recordFailedLogin(req, res);
      res.status(401).json({ success: false, error: "Invalid credentials" });
      return;
    }

    req.session.regenerate((error) => {
      if (error) {
        res.status(500).json({ success: false, error: "Unable to start session" });
        return;
      }

      req.session.courtEdgeAuthenticated = true;
      req.session.courtEdgeUser = expectedUser;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");

      req.session.save((saveError) => {
        if (saveError) {
          res.status(500).json({ success: false, error: "Unable to save session" });
          return;
        }

        clearLoginAttempts(req);
        res.json({
          success: true,
          authenticated: true,
          user: expectedUser,
          csrfToken: req.session.csrfToken,
        });
      });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        res.status(500).json({ success: false, error: "Unable to end session" });
        return;
      }
      res.clearCookie("courtedge.sid", { path: "/" });
      res.json({ success: true, authenticated: false });
    });
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of loginAttempts.entries()) {
    if (now >= bucket.resetAt) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS);
cleanupTimer.unref();
