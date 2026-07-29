import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import session from "express-session";
import {
  AuthDatabase,
  getAuthDatabase,
  SqliteSessionStore,
  toPublicAuthUser,
  verifyPassword,
  type CourtEdgeRole,
} from "./auth-persistence";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

type AttemptBucket = { count: number; resetAt: number };
const loginAttempts = new Map<string, AttemptBucket>();

declare module "express-session" {
  interface SessionData {
    courtEdgeAuthenticated?: boolean;
    courtEdgeUserId?: number;
    courtEdgeUser?: string;
    courtEdgeRole?: CourtEdgeRole;
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

function headerText(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value || "").trim();
}

function timingSafeEqualText(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function isAuthenticated(req: Request): boolean {
  return Boolean(
    req.session.courtEdgeAuthenticated &&
    Number.isInteger(req.session.courtEdgeUserId) &&
    req.session.courtEdgeUser &&
    req.session.courtEdgeRole,
  );
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }
  if (req.session.courtEdgeRole !== "admin") {
    res.status(403).json({ success: false, error: "Administrator role required" });
    return;
  }
  next();
}

function requireSessionCsrf(req: Request, res: Response, next: NextFunction): void {
  const expected = req.session.csrfToken || "";
  const actual = headerText(req, "x-courtedge-csrf");
  if (!expected || !actual || !timingSafeEqualText(actual, expected)) {
    res.status(403).json({ success: false, error: "Invalid CSRF token" });
    return;
  }
  next();
}

function cookieOptions(production: boolean): session.CookieOptions {
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
    ...(production ? { partitioned: true } : {}),
  } as session.CookieOptions;
}

export function initializeAuthPersistence(database = getAuthDatabase()): AuthDatabase {
  const username = requiredEnv("COURTEDGE_ADMIN_USERNAME", "admin");
  const passwordHash = requiredEnv(
    "COURTEDGE_ADMIN_PASSWORD_SCRYPT",
    "scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000",
  );
  database.ensureBootstrapAdmin(username, passwordHash);
  return database;
}

export function createSessionMiddleware(database = getAuthDatabase()) {
  const production = process.env.NODE_ENV === "production";
  const secret = requiredEnv(
    "COURTEDGE_SESSION_SECRET",
    "development-only-courtedge-session-secret-change-me",
  );

  return session({
    name: "courtedge.sid",
    secret,
    store: new SqliteSessionStore(database, SESSION_TTL_MS),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: production,
    cookie: cookieOptions(production),
  });
}

export function registerAuthRoutes(app: Express, database = getAuthDatabase()): void {
  app.get("/api/auth/session", (req, res) => {
    const authenticated = isAuthenticated(req);
    res.json({
      success: true,
      authenticated,
      user: authenticated ? req.session.courtEdgeUser : null,
      userId: authenticated ? req.session.courtEdgeUserId : null,
      role: authenticated ? req.session.courtEdgeRole : null,
      identity: authenticated
        ? {
            id: req.session.courtEdgeUserId,
            username: req.session.courtEdgeUser,
            role: req.session.courtEdgeRole,
          }
        : null,
      csrfToken: authenticated ? req.session.csrfToken || null : null,
    });
  });

  app.post("/api/auth/login", loginRateLimit, (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = username ? database.findUserByUsername(username) : undefined;
    const valid = Boolean(
      user &&
      user.status === "active" &&
      password.length >= 8 &&
      verifyPassword(password, user.passwordHash),
    );

    if (!valid || !user) {
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
      req.session.courtEdgeUserId = user.id;
      req.session.courtEdgeUser = user.username;
      req.session.courtEdgeRole = user.role;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");

      req.session.save((saveError) => {
        if (saveError) {
          res.status(500).json({ success: false, error: "Unable to save session" });
          return;
        }

        database.recordSuccessfulLogin(user.id);
        clearLoginAttempts(req);
        res.json({
          success: true,
          authenticated: true,
          user: user.username,
          userId: user.id,
          role: user.role,
          identity: { id: user.id, username: user.username, role: user.role },
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
      const production = process.env.NODE_ENV === "production";
      res.clearCookie("courtedge.sid", {
        path: "/",
        secure: production,
        sameSite: production ? "none" : "lax",
      });
      res.json({ success: true, authenticated: false });
    });
  });

  app.get("/api/auth/users", requireAdmin, (_req, res) => {
    res.json({ success: true, data: database.listUsers() });
  });

  app.post("/api/auth/users", requireAdmin, requireSessionCsrf, (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = typeof req.body?.role === "string" ? req.body.role : "viewer";

    try {
      const user = database.createUser({
        username,
        password,
        role: role as CourtEdgeRole,
      });
      res.status(201).json({ success: true, data: user });
    } catch (error: any) {
      const message = error?.message || "Unable to create user";
      const conflict = /UNIQUE constraint failed/i.test(message);
      res.status(conflict ? 409 : 400).json({ success: false, error: message });
    }
  });

  app.get("/api/auth/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: "Invalid user id" });
      return;
    }
    const user = database.findUserById(id);
    if (!user) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }
    res.json({ success: true, data: toPublicAuthUser(user) });
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of loginAttempts.entries()) {
    if (now >= bucket.resetAt) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS);
cleanupTimer.unref();
