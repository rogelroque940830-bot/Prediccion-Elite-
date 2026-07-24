// Cliente del historial manual de picks. Usa el API v2 del backend vigente.
import { fetchJson } from "./queryClient";

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
  odds?: string;
  line?: string;
  notes?: string;
}

export type NewPick = Omit<SavedPick, "id" | "ts">;

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
