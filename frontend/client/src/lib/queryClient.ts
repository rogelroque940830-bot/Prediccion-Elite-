import { QueryClient, QueryFunction } from "@tanstack/react-query";

// El dominio del backend se configura por ambiente. No debe quedar una URL
// productiva incrustada en el bundle del frontend. Una cadena vacía permite
// despliegues same-origin mediante reverse proxy.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
export const API_BASE = configuredApiBase.replace(/\/+$/, "");

if (import.meta.env.DEV && !configuredApiBase) {
  console.warn(
    "VITE_API_BASE_URL no está definida; las solicitudes usarán el mismo origen.",
  );
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(apiUrl(path), init);
  await throwIfResNotOk(res);
  return (await res.json()) as T;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(apiUrl(queryKey.join("/")));

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
