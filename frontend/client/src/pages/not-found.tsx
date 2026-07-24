import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
      <h1 className="text-4xl font-display font-bold text-muted-foreground">404</h1>
      <p className="text-muted-foreground">Página no encontrada</p>
      <Button asChild variant="secondary">
        <Link href="/">Volver al Dashboard</Link>
      </Button>
    </div>
  );
}
