import type { NextFunction, Request, Response } from "express";
import { getAuthDatabase, type AuthDatabase, type CourtEdgeRole } from "./auth-persistence";

export interface CourtEdgeRequestIdentity {
  id: number;
  username: string;
  role: CourtEdgeRole;
}

function positiveUserId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getRequestIdentity(req: Request): CourtEdgeRequestIdentity | null {
  const sessionData = (req as Request & { session?: Record<string, unknown> }).session;
  const id = positiveUserId(sessionData?.courtEdgeUserId);
  const username = typeof sessionData?.courtEdgeUser === "string" ? sessionData.courtEdgeUser.trim() : "";
  const role = sessionData?.courtEdgeRole;
  if (!id || !username || (role !== "admin" && role !== "analyst" && role !== "viewer")) return null;
  return { id, username, role };
}

export function resolveSystemOwnerUserId(database: AuthDatabase = getAuthDatabase()): number {
  const configured = positiveUserId(process.env.COURTEDGE_SYSTEM_OWNER_USER_ID);
  if (configured) {
    const user = database.findUserById(configured);
    if (!user || user.status !== "active") {
      throw new Error("COURTEDGE_SYSTEM_OWNER_USER_ID does not identify an active user");
    }
    return user.id;
  }

  const bootstrapUsername = (process.env.COURTEDGE_ADMIN_USERNAME || "admin").trim();
  const bootstrap = database.findUserByUsername(bootstrapUsername);
  if (!bootstrap || bootstrap.status !== "active" || bootstrap.role !== "admin") {
    throw new Error("Bootstrap administrator is unavailable for system-owned data");
  }
  return bootstrap.id;
}

export function resolveRequestUserId(req: Request, database: AuthDatabase = getAuthDatabase()): number {
  return getRequestIdentity(req)?.id ?? resolveSystemOwnerUserId(database);
}

export function requestCanWriteOwnData(req: Request): boolean {
  const identity = getRequestIdentity(req);
  return identity == null || identity.role === "admin" || identity.role === "analyst";
}

export function requestCanRunGlobalWorkers(req: Request): boolean {
  const identity = getRequestIdentity(req);
  return identity == null || identity.role === "admin";
}

export function requireOwnDataWriteRole(req: Request, res: Response, next: NextFunction): void {
  if (requestCanWriteOwnData(req)) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: "Viewer role is read-only" });
}

export function requireGlobalWorkerRole(req: Request, res: Response, next: NextFunction): void {
  if (requestCanRunGlobalWorkers(req)) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: "Administrator role required" });
}
