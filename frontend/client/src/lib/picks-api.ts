// Cliente canónico de picks. Todas las escrituras usan /api/picks/v2.
import { fetchJson } from "./queryClient";
import type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";

export interface SavedPick {
  id: string;
  ts: number;
  sport: "mlb" | "nba" | "nhl" | "wnba";
  homeTeam: string;
  awayTeam: string;
  pickType: string;
  pickSide: string;
  confidence: number;
  edge?: number;
  odds?: string | number;
  line?: string;
  notes?: string;
  source?: "app" | "manual" | "migration";
  clientId?: number;
  date?: string;
  team?: string;
  opponent?: string;
  market?: string;
  pick?: string;
  modelProb?: number;
  impliedProb?: number;
  stake?: number;
  result?: string;
  profit?: number;
  closingOdds?: number;
  closingImpliedProb?: number;
  clvPercent?: number;
  scientificSnapshot?: MlbScientificSnapshot;
}

export type NewPick = Omit<SavedPick, "id" | "ts"> & {
  id?: string;
  ts?: number;
};

export type PickPatch = Partial<Omit<SavedPick, "id" | "ts">>;

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function unwrap<T>(response: ApiEnvelope<T>, fallback: string): T {
  if (!response.success || response.data === undefined) {
    throw new Error(response.error || fallback);
  }
  return response.data;
}

export async function savePick(pick: NewPick): Promise<SavedPick> {
  const response = await fetchJson<ApiEnvelope<SavedPick>>("/api/picks/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pick),
  });
  return unwrap(response, "Error guardando pick");
}

export async function updatePick(id: string, patch: PickPatch): Promise<SavedPick> {
  const response = await fetchJson<ApiEnvelope<SavedPick>>(
    `/api/picks/v2/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return unwrap(response, "Error actualizando pick");
}

export async function listPicks(opts: {
  sport?: "mlb" | "nba" | "nhl" | "wnba";
  days?: number;
  minConfidence?: number;
} = {}): Promise<SavedPick[]> {
  const qs = new URLSearchParams();
  if (opts.sport) qs.set("sport", opts.sport);
  if (opts.days != null) qs.set("days", String(opts.days));
  if (opts.minConfidence != null) qs.set("minConfidence", String(opts.minConfidence));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  const response = await fetchJson<ApiEnvelope<SavedPick[]>>(`/api/picks/v2${suffix}`);
  return unwrap(response, "Error listando picks");
}

export async function deletePick(id: string): Promise<void> {
  const response = await fetchJson<ApiEnvelope<unknown>>(
    `/api/picks/v2/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.success) throw new Error(response.error || "Error borrando pick");
}

export async function refreshClv(): Promise<{ updated: number; totalProcessed: number }> {
  const response = await fetchJson<{
    success: boolean;
    updated?: number;
    totalProcessed?: number;
    error?: string;
  }>("/api/clv/refresh", { method: "POST" });

  if (!response.success) throw new Error(response.error || "Error actualizando CLV");
  return {
    updated: response.updated || 0,
    totalProcessed: response.totalProcessed || 0,
  };
}
