import crypto from "crypto";
import fs from "fs";
import path from "path";
import session from "express-session";
import Database from "better-sqlite3";

export type CourtEdgeRole = "admin" | "analyst" | "viewer";
export type CourtEdgeUserStatus = "active" | "disabled";

export interface AuthUser {
  id: number;
  username: string;
  passwordHash: string;
  role: CourtEdgeRole;
  status: CourtEdgeUserStatus;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface PublicAuthUser {
  id: number;
  username: string;
  role: CourtEdgeRole;
  status: CourtEdgeUserStatus;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

interface StoredSession {
  sid: string;
  payload: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const ROLE_VALUES = new Set<CourtEdgeRole>(["admin", "analyst", "viewer"]);

function defaultAuthDbPath(): string {
  return process.env.COURTEDGE_AUTH_DB_PATH?.trim() || path.join(process.cwd(), "data", "courtedge-auth.sqlite");
}

function ensureParentDirectory(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function normalizeUsername(username: string): string {
  return username.trim();
}

function validateUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error("Username must be 3-64 characters using letters, numbers, dot, underscore or hyphen");
  }
  return normalized;
}

function validateRole(role: string): CourtEdgeRole {
  if (!ROLE_VALUES.has(role as CourtEdgeRole)) throw new Error("Invalid user role");
  return role as CourtEdgeRole;
}

function parseUser(row: any): AuthUser | undefined {
  if (!row) return undefined;
  return {
    id: Number(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: validateRole(String(row.role)),
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
  };
}

export function toPublicAuthUser(user: AuthUser): PublicAuthUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export function isEncodedScryptHash(encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const digest = Buffer.from(parts[2], "hex");
    return salt.length >= 16 && digest.length >= 32;
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error("Password must contain at least 12 characters");
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (!password || !isEncodedScryptHash(encoded)) return false;
  const [, saltHex, digestHex] = encoded.split("$");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(digestHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export class AuthDatabase {
  private readonly sqlite: Database.Database;

  constructor(filename = defaultAuthDbPath()) {
    ensureParentDirectory(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        sid TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
        ON auth_sessions(expires_at);
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  findUserById(id: number): AuthUser | undefined {
    return parseUser(this.sqlite.prepare("SELECT * FROM auth_users WHERE id = ?").get(id));
  }

  findUserByUsername(username: string): AuthUser | undefined {
    return parseUser(
      this.sqlite.prepare("SELECT * FROM auth_users WHERE username = ? COLLATE NOCASE").get(normalizeUsername(username)),
    );
  }

  listUsers(): PublicAuthUser[] {
    const rows = this.sqlite.prepare("SELECT * FROM auth_users ORDER BY id ASC").all();
    return rows.map((row) => toPublicAuthUser(parseUser(row)!));
  }

  createUser(input: { username: string; password: string; role: CourtEdgeRole }): PublicAuthUser {
    return this.createUserWithHash({
      username: input.username,
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
  }

  createUserWithHash(input: {
    username: string;
    passwordHash: string;
    role: CourtEdgeRole;
    status?: CourtEdgeUserStatus;
  }): PublicAuthUser {
    const username = validateUsername(input.username);
    const role = validateRole(input.role);
    if (!isEncodedScryptHash(input.passwordHash)) throw new Error("Invalid scrypt password hash");
    const status = input.status === "disabled" ? "disabled" : "active";
    const now = Date.now();

    const result = this.sqlite.prepare(`
      INSERT INTO auth_users (username, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, input.passwordHash, role, status, now, now);

    return toPublicAuthUser(this.findUserById(Number(result.lastInsertRowid))!);
  }

  ensureBootstrapAdmin(username: string, passwordHash: string): PublicAuthUser {
    const normalized = validateUsername(username);
    if (!isEncodedScryptHash(passwordHash)) throw new Error("Bootstrap admin password must be a valid scrypt hash");
    const existing = this.findUserByUsername(normalized);
    if (existing) {
      if (existing.role !== "admin" || existing.status !== "active") {
        const now = Date.now();
        this.sqlite.prepare(`
          UPDATE auth_users SET role = 'admin', status = 'active', updated_at = ? WHERE id = ?
        `).run(now, existing.id);
      }
      return toPublicAuthUser(this.findUserById(existing.id)!);
    }

    return this.createUserWithHash({
      username: normalized,
      passwordHash,
      role: "admin",
      status: "active",
    });
  }

  recordSuccessfulLogin(userId: number): void {
    const now = Date.now();
    this.sqlite.prepare(`
      UPDATE auth_users SET last_login_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, userId);
  }

  getSession(sid: string, now = Date.now()): StoredSession | undefined {
    const row = this.sqlite.prepare("SELECT * FROM auth_sessions WHERE sid = ?").get(sid) as any;
    if (!row) return undefined;
    if (Number(row.expires_at) <= now) {
      this.deleteSession(sid);
      return undefined;
    }
    return {
      sid: String(row.sid),
      payload: String(row.payload),
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertSession(sid: string, payload: string, expiresAt: number): void {
    const now = Date.now();
    this.sqlite.prepare(`
      INSERT INTO auth_sessions (sid, payload, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(sid, payload, expiresAt, now, now);
  }

  touchSession(sid: string, payload: string, expiresAt: number): void {
    const now = Date.now();
    this.sqlite.prepare(`
      UPDATE auth_sessions SET payload = ?, expires_at = ?, updated_at = ? WHERE sid = ?
    `).run(payload, expiresAt, now, sid);
  }

  deleteSession(sid: string): void {
    this.sqlite.prepare("DELETE FROM auth_sessions WHERE sid = ?").run(sid);
  }

  clearSessions(): void {
    this.sqlite.prepare("DELETE FROM auth_sessions").run();
  }

  countSessions(now = Date.now()): number {
    this.purgeExpiredSessions(now);
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get() as any;
    return Number(row?.count || 0);
  }

  listSessionPayloads(now = Date.now()): string[] {
    this.purgeExpiredSessions(now);
    const rows = this.sqlite.prepare("SELECT payload FROM auth_sessions ORDER BY created_at ASC").all() as any[];
    return rows.map((row) => String(row.payload));
  }

  purgeExpiredSessions(now = Date.now()): number {
    return Number(this.sqlite.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now).changes || 0);
  }
}

function sessionExpiry(sess: session.SessionData, ttlMs: number): number {
  const explicit = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
  return Number.isFinite(explicit) ? explicit : Date.now() + ttlMs;
}

export class SqliteSessionStore extends session.Store {
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly database: AuthDatabase,
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    super();
    this.cleanupTimer = setInterval(() => database.purgeExpiredSessions(), Math.min(ttlMs, 15 * 60 * 1000));
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    clearInterval(this.cleanupTimer);
  }

  get(sid: string, callback: (err: any, session?: session.SessionData | null) => void): void {
    try {
      const stored = this.database.getSession(sid);
      callback(null, stored ? JSON.parse(stored.payload) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: any) => void): void {
    try {
      this.database.upsertSession(sid, JSON.stringify(sess), sessionExpiry(sess, this.ttlMs));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    try {
      this.database.deleteSession(sid);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid: string, sess: session.SessionData, callback?: (err?: any) => void): void {
    try {
      this.database.touchSession(sid, JSON.stringify(sess), sessionExpiry(sess, this.ttlMs));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  clear(callback?: (err?: any) => void): void {
    try {
      this.database.clearSessions();
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  length(callback: (err: any, length?: number) => void): void {
    try {
      callback(null, this.database.countSessions());
    } catch (error) {
      callback(error);
    }
  }

  all(callback: (err: any, obj?: session.SessionData[] | { [sid: string]: session.SessionData } | null) => void): void {
    try {
      callback(null, this.database.listSessionPayloads().map((payload) => JSON.parse(payload)));
    } catch (error) {
      callback(error);
    }
  }
}

let singletonDatabase: AuthDatabase | undefined;

export function getAuthDatabase(): AuthDatabase {
  if (!singletonDatabase) singletonDatabase = new AuthDatabase();
  return singletonDatabase;
}

export function closeAuthDatabase(): void {
  singletonDatabase?.close();
  singletonDatabase = undefined;
}
