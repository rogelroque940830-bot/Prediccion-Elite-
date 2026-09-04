import { QueryClient, QueryFunction } from "@tanstack/react-query";

// El dominio del backend se configura por ambiente. No debe quedar una URL
// productiva incrustada en el bundle del frontend. Una cadena vacía permite
// despliegues same-origin mediante reverse proxy.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
export const API_BASE = configuredApiBase.replace(/\/+$/, "");

let csrfToken: string | null = null;

if (import.meta.env.DEV && !configuredApiBase) {
  console.warn(
    "VITE_API_BASE_URL no está definida; las solicitudes usarán el mismo origen.",
  );
}

export function setCsrfToken(value: string | null): void {
  csrfToken = value?.trim() || null;
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function requestInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers || {});
  const method = (init.method || "GET").toUpperCase();
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);

  if (write && csrfToken && !headers.has("X-CourtEdge-CSRF")) {
    headers.set("X-CourtEdge-CSRF", csrfToken);
  }

  return {
    ...init,
    headers,
    credentials: "include",
  };
}

async function responseMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return res.statusText || "Request failed";
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const message = await responseMessage(res);
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new CustomEvent("courtedge:auth-required", {
        detail: { status: res.status, message },
      }));
    }
    throw new ApiError(res.status, message);
  }
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(apiUrl(path), requestInit(init));
  await throwIfResNotOk(res);
  return (await res.json()) as T;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers = new Headers();
  if (data !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(apiUrl(url), requestInit({
    method,
    headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  }));

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(apiUrl(queryKey.join("/")), requestInit());

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Scientific MLB snapshots are created synchronously from the predictor UI. Expose
// the existing React Query cache through a narrow runtime bridge so the snapshot
// builder can attach the exact /api/mlb/early-markets response that was already
// rendered, without re-fetching or recalculating ERE/F5 at save time.
if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { __COURTEDGE_QUERY_CLIENT__?: QueryClient })
    .__COURTEDGE_QUERY_CLIENT__ = queryClient;
}
