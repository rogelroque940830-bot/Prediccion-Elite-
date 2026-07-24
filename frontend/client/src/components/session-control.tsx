import { LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export function SessionControl() {
  const { loading, authenticated, user, requestLogin, logout } = useAuth();

  if (loading) {
    return <Badge variant="outline" className="text-[10px]">Verificando sesión…</Badge>;
  }

  if (!authenticated) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        onClick={requestLogin}
      >
        <LockKeyhole className="mr-1.5 h-3.5 w-3.5" />
        Habilitar guardado
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 text-[10px]">
        <ShieldCheck className="mr-1 h-3 w-3" />
        Sesión segura{user ? ` · ${user}` : ""}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Cerrar sesión"
        onClick={() => void logout()}
      >
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
