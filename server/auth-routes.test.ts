import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createSessionMiddleware, registerAuthRoutes } from "./auth";
import { AuthDatabase, hashPassword } from "./auth-persistence";
import { requirePrivateReadAuth, requireWriteAuth } from "./security";

interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startAuthApp(database: AuthDatabase): Promise<RunningApp> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createSessionMiddleware(database));
  app.use(express.json());
  app.use(requirePrivateReadAuth);
  app.use(requireWriteAuth);
  registerAuthRoutes(app, database);
  app.get("/api/picks/v2", (_req, res) => res.json({ success: true, data: ["private"] }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function requestJson(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const body = await response.json();
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body,
    cookie: setCookie ? setCookie.split(";", 1)[0] : null,
  };
}

async function login(baseUrl: string, username: string, password: string) {
  const response = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.cookie);
  assert.equal(response.body.authenticated, true);
  return {
    cookie: response.cookie!,
    csrfToken: String(response.body.csrfToken),
    body: response.body,
  };
}

function withTestEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.COURTEDGE_SESSION_SECRET;
  process.env.NODE_ENV = "test";
  process.env.COURTEDGE_SESSION_SECRET = "test-session-secret-with-sufficient-entropy";

  return callback().finally(() => {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret == null) delete process.env.COURTEDGE_SESSION_SECRET;
    else process.env.COURTEDGE_SESSION_SECRET = previousSecret;
  });
}

test("persistent login survives server and database restart", async () => {
  await withTestEnvironment(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-auth-routes-"));
    const filename = path.join(directory, "auth.sqlite");
    const password = "admin-password-123";

    const firstDatabase = new AuthDatabase(filename);
    firstDatabase.ensureBootstrapAdmin("rogel-admin", hashPassword(password));
    const firstApp = await startAuthApp(firstDatabase);
    const authenticated = await login(firstApp.baseUrl, "rogel-admin", password);
    await firstApp.close();
    firstDatabase.close();

    const secondDatabase = new AuthDatabase(filename);
    const secondApp = await startAuthApp(secondDatabase);
    const session = await requestJson(secondApp.baseUrl, "/api/auth/session", {
      headers: { cookie: authenticated.cookie },
    });

    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user, "rogel-admin");
    assert.equal(session.body.role, "admin");
    assert.equal(session.body.identity.username, "rogel-admin");

    await secondApp.close();
    secondDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

test("roles isolate administration and private reads require a session", async () => {
  await withTestEnvironment(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-auth-roles-"));
    const database = new AuthDatabase(path.join(directory, "auth.sqlite"));
    const adminPassword = "admin-password-123";
    database.ensureBootstrapAdmin("rogel-admin", hashPassword(adminPassword));
    const app = await startAuthApp(database);

    const anonymousRead = await requestJson(app.baseUrl, "/api/picks/v2");
    assert.equal(anonymousRead.status, 401);

    const admin = await login(app.baseUrl, "rogel-admin", adminPassword);
    const created = await requestJson(app.baseUrl, "/api/auth/users", {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-courtedge-csrf": admin.csrfToken,
      },
      body: JSON.stringify({
        username: "analyst.one",
        password: "analyst-password-123",
        role: "analyst",
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, "analyst");
    assert.equal("passwordHash" in created.body.data, false);

    const analyst = await login(app.baseUrl, "analyst.one", "analyst-password-123");
    assert.equal(analyst.body.role, "analyst");
    assert.notEqual(analyst.cookie, admin.cookie);
    assert.notEqual(analyst.csrfToken, admin.csrfToken);

    const analystPrivateRead = await requestJson(app.baseUrl, "/api/picks/v2", {
      headers: { cookie: analyst.cookie },
    });
    assert.equal(analystPrivateRead.status, 200);

    const analystUsersRead = await requestJson(app.baseUrl, "/api/auth/users", {
      headers: { cookie: analyst.cookie },
    });
    assert.equal(analystUsersRead.status, 403);

    const crossCsrf = await requestJson(app.baseUrl, "/api/auth/users", {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-courtedge-csrf": analyst.csrfToken,
      },
      body: JSON.stringify({ username: "viewer.one", password: "viewer-password-123", role: "viewer" }),
    });
    assert.equal(crossCsrf.status, 403);
    assert.equal(crossCsrf.body.error, "Invalid CSRF token");

    const adminUsersRead = await requestJson(app.baseUrl, "/api/auth/users", {
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminUsersRead.status, 200);
    assert.deepEqual(
      adminUsersRead.body.data.map((user: any) => user.role),
      ["admin", "analyst"],
    );

    await app.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

test("failed login is generic and does not create a session", async () => {
  await withTestEnvironment(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-auth-failed-"));
    const database = new AuthDatabase(path.join(directory, "auth.sqlite"));
    database.ensureBootstrapAdmin("rogel-admin", hashPassword("admin-password-123"));
    const app = await startAuthApp(database);

    const response = await requestJson(app.baseUrl, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "missing-user", password: "not-the-password" }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error, "Invalid credentials");
    assert.equal(response.cookie, null);
    assert.equal(database.countSessions(), 0);

    await app.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
