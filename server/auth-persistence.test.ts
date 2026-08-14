import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type session from "express-session";
import {
  AuthDatabase,
  hashPassword,
  SqliteSessionStore,
  verifyPassword,
} from "./auth-persistence";

function tempDatabasePath(): { directory: string; filename: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-auth-"));
  return { directory, filename: path.join(directory, "auth.sqlite") };
}

function setSession(store: SqliteSessionStore, sid: string, value: session.SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, value, (error) => (error ? reject(error) : resolve()));
  });
}

function getSession(store: SqliteSessionStore, sid: string): Promise<session.SessionData | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, value) => (error ? reject(error) : resolve(value || null)));
  });
}

test("password hashes use salted scrypt and verify without plaintext storage", () => {
  const encoded = hashPassword("a-strong-test-password");
  assert.match(encoded, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword("a-strong-test-password", encoded), true);
  assert.equal(verifyPassword("wrong-password", encoded), false);
  assert.throws(() => hashPassword("short"), /at least 12 characters/);
});

test("bootstrap admin is persistent and idempotent", () => {
  const { directory, filename } = tempDatabasePath();
  const hash = hashPassword("bootstrap-password-123");
  const first = new AuthDatabase(filename);

  const admin = first.ensureBootstrapAdmin("rogel-admin", hash);
  const repeated = first.ensureBootstrapAdmin("rogel-admin", hashPassword("different-password-456"));

  assert.equal(admin.id, repeated.id);
  assert.equal(repeated.role, "admin");
  assert.equal(repeated.status, "active");
  assert.equal(first.listUsers().length, 1);
  assert.equal(verifyPassword("bootstrap-password-123", first.findUserById(admin.id)!.passwordHash), true);
  first.close();

  const reopened = new AuthDatabase(filename);
  assert.equal(reopened.findUserByUsername("ROGEL-ADMIN")?.id, admin.id);
  assert.equal(reopened.listUsers()[0].username, "rogel-admin");
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("users persist with roles and password hashes never appear in public records", () => {
  const { directory, filename } = tempDatabasePath();
  const database = new AuthDatabase(filename);
  const analyst = database.createUser({
    username: "analyst.one",
    password: "test-analyst-password-123",
    role: "analyst",
  });

  assert.equal(analyst.role, "analyst");
  assert.equal("passwordHash" in analyst, false);
  assert.equal(database.findUserByUsername("ANALYST.ONE")?.id, analyst.id);
  assert.throws(
    () => database.createUser({ username: "analyst.one", password: "test-another-password-123", role: "viewer" }),
    /UNIQUE constraint failed/i,
  );

  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("sessions survive store and database restart", async () => {
  const { directory, filename } = tempDatabasePath();
  const firstDatabase = new AuthDatabase(filename);
  const firstStore = new SqliteSessionStore(firstDatabase, 60_000);
  const expires = new Date(Date.now() + 60_000);

  await setSession(firstStore, "session-a", {
    cookie: { originalMaxAge: 60_000, expires, secure: false, httpOnly: true, path: "/", sameSite: "lax" } as any,
    courtEdgeAuthenticated: true,
    courtEdgeUserId: 7,
    courtEdgeUser: "persistent-user",
    courtEdgeRole: "analyst",
    csrfToken: "csrf-a",
  });

  firstStore.stopCleanup();
  firstDatabase.close();

  const secondDatabase = new AuthDatabase(filename);
  const secondStore = new SqliteSessionStore(secondDatabase, 60_000);
  const restored = await getSession(secondStore, "session-a");

  assert.equal(restored?.courtEdgeAuthenticated, true);
  assert.equal(restored?.courtEdgeUserId, 7);
  assert.equal(restored?.courtEdgeUser, "persistent-user");
  assert.equal(restored?.courtEdgeRole, "analyst");
  assert.equal(restored?.csrfToken, "csrf-a");

  secondStore.stopCleanup();
  secondDatabase.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("expired sessions are deleted and cannot be restored", async () => {
  const { directory, filename } = tempDatabasePath();
  const database = new AuthDatabase(filename);
  const store = new SqliteSessionStore(database, 60_000);

  await setSession(store, "expired-session", {
    cookie: { originalMaxAge: 0, expires: new Date(Date.now() - 1_000), secure: false, httpOnly: true, path: "/" } as any,
    courtEdgeAuthenticated: true,
    courtEdgeUserId: 9,
    courtEdgeUser: "expired-user",
    courtEdgeRole: "viewer",
    csrfToken: "expired-csrf",
  });

  assert.equal(await getSession(store, "expired-session"), null);
  assert.equal(database.countSessions(), 0);

  store.stopCleanup();
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
