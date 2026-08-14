import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { requireWriteAuth } from "./security";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(requireWriteAuth);
  app.post("/api/wnba/predictor-shadow/v1/evaluations", (_req, res) => res.status(201).json({ success: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start S6E security test server");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("S6E evaluation emission rejects anonymous writes", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/wnba/predictor-shadow/v1/evaluations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, "Authentication required for write operations");
  });
});

test("S6E evaluation emission accepts the configured service token", async () => {
  const previous = process.env.COURTEDGE_WRITE_TOKEN;
  process.env.COURTEDGE_WRITE_TOKEN = "s6e-service-token";
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wnba/predictor-shadow/v1/evaluations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s6e-service-token",
        },
        body: "{}",
      });
      assert.equal(response.status, 201);
    });
  } finally {
    if (previous == null) delete process.env.COURTEDGE_WRITE_TOKEN;
    else process.env.COURTEDGE_WRITE_TOKEN = previous;
  }
});
