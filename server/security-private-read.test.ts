import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { requirePrivateReadAuth } from "./security";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(requirePrivateReadAuth);
  app.get("/api/picks/v2", (_req, res) => res.json({ success: true }));
  app.get("/api/clv/report", (_req, res) => res.json({ success: true }));
  app.get("/api/mlb/ledger/v1/history", (_req, res) => res.json({ success: true }));
  app.get("/api/mlb/ledger/v1/status", (_req, res) => res.json({ success: true }));
  app.get("/api/sharp/mlb/example", (_req, res) => res.json({ success: true }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start test server");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("anonymous users cannot read user-owned picks, CLV or ledger history", async () => {
  await withServer(async (baseUrl) => {
    for (const pathname of [
      "/api/picks/v2",
      "/api/clv/report",
      "/api/mlb/ledger/v1/history",
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 401, pathname);
      const body = await response.json();
      assert.equal(body.error, "Authentication required for private data");
    }
  });
});

test("operational ledger status and shared sharp reads remain public", async () => {
  await withServer(async (baseUrl) => {
    const status = await fetch(`${baseUrl}/api/mlb/ledger/v1/status`);
    const sharp = await fetch(`${baseUrl}/api/sharp/mlb/example`);

    assert.equal(status.status, 200);
    assert.equal(sharp.status, 200);
  });
});

test("service token can read private endpoints without a browser session", async () => {
  const previous = process.env.COURTEDGE_WRITE_TOKEN;
  process.env.COURTEDGE_WRITE_TOKEN = "service-token-for-private-read-test";

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/mlb/ledger/v1/history`, {
        headers: { authorization: "Bearer service-token-for-private-read-test" },
      });
      assert.equal(response.status, 200);
    });
  } finally {
    if (previous == null) delete process.env.COURTEDGE_WRITE_TOKEN;
    else process.env.COURTEDGE_WRITE_TOKEN = previous;
  }
});
