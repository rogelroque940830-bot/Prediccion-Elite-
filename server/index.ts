import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import {
  apiRateLimit,
  requireWriteAuth,
  restrictedCors,
  securityHeaders,
} from "./security";

const app = express();
// Railway terminates TLS and forwards one trusted proxy hop.
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// P0 security middleware. Production must configure COURTEDGE_ALLOWED_ORIGINS
// and COURTEDGE_WRITE_TOKEN before this branch can be promoted.
app.use(securityHeaders);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(requireWriteAuth);

app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: process.env.FORM_BODY_LIMIT || "256kb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

// Health check endpoints for Railway.
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "CourtEdge Backend", version: "1.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? "Internal Server Error" : (err.message || "Request failed");

    console.error("Request error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`CourtEdge Backend serving on port ${port}`);
    },
  );
})();
