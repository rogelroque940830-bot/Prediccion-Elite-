import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Trash2, Printer, RefreshCw, Filter } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  savePick, listPicks, deletePick, type SavedPick, type NewPick,
} from "@/lib/picks-api";

const SPORT_LABEL: Record<string, string> = {
  mlb: "MLB", nba: "NBA", nhl: "NHL", wnba: "WNBA",
};
const SPORT_COLOR: Record<string, string> = {
  mlb: "bg-red-500/15 text-red-300 border-red-500/30",
  nba: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  nhl: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  wnba: "bg-purple-500/15 text-purple-300 border-purple-500/30",
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("es-US", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function confColor(c: number): string {
  if (c >= 70) return "text-green-400";
  if (c >= 60) return "text-yellow-400";
  return "text-red-400";
}

export default function PicksPage() {
  const { toast } = useToast();
  const [picks, setPicks] = useState<SavedPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterSport, setFilterSport] = useState<string>("all");
  const [filterDays, setFilterDays] = useState<string>("30");
  const [filterMinConf, setFilterMinConf] = useState<string>("0");
  const [openForm, setOpenForm] = useState(false);

  // Form state
  const [fSport, setFSport] = useState<"mlb" | "nba" | "nhl" | "wnba">("mlb");
  const [fHome, setFHome] = useState("");
  const [fAway, setFAway] = useState("");
  const [fType, setFType] = useState("ML");
  const [fSide, setFSide] = useState("Home");
  const [fConf, setFConf] = useState("70");
  const [fEdge, setFEdge] = useState("");
  const [fOdds, setFOdds] = useState("");
  const [fLine, setFLine] = useState("");
  const [fNotes, setFNotes] = useState("");

  const fetchPicks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPicks({
        sport: filterSport === "all" ? undefined : (filterSport as any),
        days: parseInt(filterDays, 10),
        minConfidence: parseFloat(filterMinConf),
      });
      setPicks(data);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [filterSport, filterDays, filterMinConf, toast]);

  useEffect(() => { fetchPicks(); }, [fetchPicks]);

  const resetForm = () => {
    setFSport("mlb"); setFHome(""); setFAway(""); setFType("ML"); setFSide("Home");
    setFConf("70"); setFEdge(""); setFOdds(""); setFLine(""); setFNotes("");
  };

  const handleSave = async () => {
    if (!fHome.trim() || !fAway.trim()) {
      toast({ title: "Faltan equipos", description: "Local y visitante son obligatorios", variant: "destructive" });
      return;
    }
    const conf = parseFloat(fConf);
    if (isNaN(conf) || conf < 0 || conf > 100) {
      toast({ title: "Confianza inválida", description: "Debe ser número entre 0 y 100", variant: "destructive" });
      return;
    }
    const body: NewPick = {
      sport: fSport,
      homeTeam: fHome.trim(),
      awayTeam: fAway.trim(),
      pickType: fType,
      pickSide: fSide,
      confidence: conf,
      edge: fEdge ? parseFloat(fEdge) : undefined,
      odds: fOdds || undefined,
      line: fLine || undefined,
      notes: fNotes || undefined,
    };
    try {
      await savePick(body);
      toast({ title: "Pick guardado", description: `${fHome} vs ${fAway} — ${conf}%` });
      resetForm();
      setOpenForm(false);
      fetchPicks();
    } catch (e: any) {
      toast({ title: "Error guardando", description: e.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("¿Borrar este pick?")) return;
    try {
      await deletePick(id);
      setPicks(picks.filter((p) => p.id !== id));
      toast({ title: "Pick borrado" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="container mx-auto p-4 max-w-5xl">
      {/* Print styles — solo aplican al imprimir */}
      <style>{`
        @media print {
          body { background: white !important; color: black !important; }
          .no-print { display: none !important; }
          .print-card { break-inside: avoid; border: 1px solid #ccc; margin-bottom: 8px; background: white !important; color: black !important; }
          .print-title { font-size: 18px; font-weight: bold; }
        }
      `}</style>

      <div className="flex items-center justify-between mb-4 no-print">
        <h1 className="text-2xl font-bold">📋 Historial de Picks</h1>
        <div className="flex gap-2">
          <Button onClick={handlePrint} variant="outline" size="sm" data-testid="btn-print">
            <Printer className="w-4 h-4 mr-1" /> Imprimir / PDF
          </Button>
          <Button onClick={fetchPicks} variant="outline" size="sm" data-testid="btn-refresh" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Dialog open={openForm} onOpenChange={setOpenForm}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="btn-new-pick">
                <Plus className="w-4 h-4 mr-1" /> Nuevo Pick
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Guardar Pick</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Deporte</Label>
                  <Select value={fSport} onValueChange={(v) => setFSport(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mlb">MLB</SelectItem>
                      <SelectItem value="nba">NBA</SelectItem>
                      <SelectItem value="nhl">NHL</SelectItem>
                      <SelectItem value="wnba">WNBA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Local</Label>
                    <Input value={fHome} onChange={(e) => setFHome(e.target.value)} placeholder="Yankees" data-testid="input-home" />
                  </div>
                  <div>
                    <Label>Visitante</Label>
                    <Input value={fAway} onChange={(e) => setFAway(e.target.value)} placeholder="Red Sox" data-testid="input-away" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Tipo</Label>
                    <Select value={fType} onValueChange={setFType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ML">Moneyline</SelectItem>
                        <SelectItem value="Spread">Spread</SelectItem>
                        <SelectItem value="O/U">Over/Under</SelectItem>
                        <SelectItem value="Prop">Player Prop</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Lado</Label>
                    <Input value={fSide} onChange={(e) => setFSide(e.target.value)} placeholder="Home / Over" data-testid="input-side" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label>Confianza %</Label>
                    <Input type="text" inputMode="decimal" value={fConf} onChange={(e) => setFConf(e.target.value)} data-testid="input-conf" />
                  </div>
                  <div>
                    <Label>Edge %</Label>
                    <Input type="text" inputMode="decimal" value={fEdge} onChange={(e) => setFEdge(e.target.value)} placeholder="opc" data-testid="input-edge" />
                  </div>
                  <div>
                    <Label>Odds</Label>
                    <Input type="text" value={fOdds} onChange={(e) => setFOdds(e.target.value)} placeholder="-110" data-testid="input-odds" />
                  </div>
                </div>
                <div>
                  <Label>Línea</Label>
                  <Input type="text" value={fLine} onChange={(e) => setFLine(e.target.value)} placeholder="-5.5 / O 8.5" data-testid="input-line" />
                </div>
                <div>
                  <Label>Notas</Label>
                  <Textarea value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Razón del pick, lesiones, etc." data-testid="input-notes" rows={3} />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} data-testid="btn-save-pick">Guardar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filtros */}
      <Card className="mb-4 no-print">
        <CardContent className="pt-4 grid grid-cols-3 gap-2">
          <div>
            <Label className="text-xs flex items-center gap-1"><Filter className="w-3 h-3" /> Deporte</Label>
            <Select value={filterSport} onValueChange={setFilterSport}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="mlb">MLB</SelectItem>
                <SelectItem value="nba">NBA</SelectItem>
                <SelectItem value="nhl">NHL</SelectItem>
                <SelectItem value="wnba">WNBA</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Últimos días</Label>
            <Select value={filterDays} onValueChange={setFilterDays}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 día</SelectItem>
                <SelectItem value="7">7 días</SelectItem>
                <SelectItem value="30">30 días</SelectItem>
                <SelectItem value="90">90 días</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Conf. mínima %</Label>
            <Input type="text" inputMode="decimal" value={filterMinConf} onChange={(e) => setFilterMinConf(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="text-sm text-muted-foreground mb-2 no-print">
        {picks.length} pick{picks.length !== 1 ? "s" : ""} encontrados (ordenados por confianza)
      </div>

      {/* Lista */}
      <div className="space-y-2">
        {picks.length === 0 && !loading && (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">
            No hay picks. Guarda el primero con el botón "Nuevo Pick".
          </CardContent></Card>
        )}
        {picks.map((p) => (
          <Card key={p.id} className="print-card">
            <CardContent className="pt-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge className={SPORT_COLOR[p.sport]} variant="outline">
                      {SPORT_LABEL[p.sport]}
                    </Badge>
                    <span className={`font-bold text-lg ${confColor(p.confidence)}`}>
                      {p.confidence.toFixed(1)}%
                    </span>
                    {p.edge != null && (
                      <span className="text-xs text-emerald-400">Edge +{p.edge.toFixed(1)}%</span>
                    )}
                    {p.confidence >= 70 && (
                      <Badge variant="default" className="bg-green-600">BET ✓</Badge>
                    )}
                  </div>
                  <div className="print-title font-semibold">
                    {p.awayTeam} @ {p.homeTeam}
                  </div>
                  <div className="text-sm mt-1">
                    <span className="text-blue-300">{p.pickType}:</span> {p.pickSide}
                    {p.line && <span className="ml-2 text-muted-foreground">{p.line}</span>}
                    {p.odds && <span className="ml-2 text-amber-300">{p.odds}</span>}
                  </div>
                  {p.notes && (
                    <div className="text-xs text-muted-foreground mt-2 italic">{p.notes}</div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">{fmtDate(p.ts)}</div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(p.id)}
                  className="no-print"
                  data-testid={`btn-del-${p.id}`}
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
