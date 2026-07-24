import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson, setCsrfToken } from "./queryClient";

interface SessionEnvelope {
  success: boolean;
  authenticated: boolean;
  user?: string | null;
  csrfToken?: string | null;
  error?: string;
}

interface AuthContextValue {
  loading: boolean;
  authenticated: boolean;
  user: string | null;
  requestLogin: () => void;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const applySession = useCallback((session: SessionEnvelope) => {
    const active = Boolean(session.success && session.authenticated);
    setAuthenticated(active);
    setUser(active ? session.user || null : null);
    setCsrfToken(active ? session.csrfToken || null : null);
    return active;
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const session = await fetchJson<SessionEnvelope>("/api/auth/session");
      return applySession(session);
    } catch {
      applySession({ success: false, authenticated: false });
      return false;
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    const openLogin = () => setLoginOpen(true);
    window.addEventListener("courtedge:auth-required", openLogin);
    return () => window.removeEventListener("courtedge:auth-required", openLogin);
  }, []);

  const requestLogin = useCallback(() => {
    setLoginError(null);
    setLoginOpen(true);
  }, []);

  const login = useCallback(async () => {
    setSubmitting(true);
    setLoginError(null);
    try {
      const session = await fetchJson<SessionEnvelope>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!applySession(session)) {
        throw new Error(session.error || "No se pudo iniciar la sesión");
      }
      setPassword("");
      setLoginOpen(false);
      window.dispatchEvent(new CustomEvent("courtedge:auth-ready"));
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Credenciales inválidas");
    } finally {
      setSubmitting(false);
    }
  }, [applySession, password, username]);

  const logout = useCallback(async () => {
    try {
      await fetchJson<SessionEnvelope>("/api/auth/logout", { method: "POST" });
    } finally {
      applySession({ success: true, authenticated: false });
    }
  }, [applySession]);

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    authenticated,
    user,
    requestLogin,
    refreshSession,
    logout,
  }), [authenticated, loading, logout, refreshSession, requestLogin, user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Acceso seguro a Court Edge</DialogTitle>
            <DialogDescription>
              Las consultas continúan disponibles. Inicia sesión para guardar, actualizar o eliminar picks y para refrescar CLV.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void login();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="courtedge-username">Usuario</Label>
              <Input
                id="courtedge-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="courtedge-password">Contraseña</Label>
              <Input
                id="courtedge-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
            </div>
            {loginError && (
              <p className="text-sm text-destructive" role="alert">{loginError}</p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={submitting || !username.trim() || password.length < 8}>
                {submitting ? "Verificando…" : "Entrar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
