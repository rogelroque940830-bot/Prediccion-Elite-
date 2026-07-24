import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Calendar } from "lucide-react";

// Returns YYYY-MM-DD in Florida timezone (America/New_York)
export function todayFL(offsetDays = 0): string {
  const now = new Date();
  if (offsetDays) now.setUTCDate(now.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Human-friendly label: "Hoy", "Ayer", "Mañana" or date
export function dateLabelFL(iso: string): string {
  const today = todayFL();
  const yest = todayFL(-1);
  const tom = todayFL(1);
  if (iso === today) return "Hoy";
  if (iso === yest) return "Ayer";
  if (iso === tom) return "Mañana";
  try {
    const d = new Date(iso + "T12:00:00-04:00");
    return d.toLocaleDateString("es-US", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

interface DatePickerFLProps {
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
  label?: string;
}

export function DatePickerFL({ value, onChange, label = "Fecha del partido" }: DatePickerFLProps) {
  const today = todayFL();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Calendar className="h-3.5 w-3.5" />
        <span className="font-medium">{label} (hora Florida)</span>
        <span className="ml-auto font-bold text-primary">{dateLabelFL(value)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 h-9 px-2 text-xs"
          onClick={() => onChange(todayFL(-1))}
        >
          ← Ayer
        </Button>
        <Input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 flex-1 text-sm"
          data-testid="input-date"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 h-9 px-2 text-xs"
          onClick={() => onChange(todayFL(1))}
        >
          Mañana →
        </Button>
        {value !== today && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 h-9 px-2 text-xs text-primary"
            onClick={() => onChange(today)}
          >
            Hoy
          </Button>
        )}
      </div>
    </div>
  );
}
