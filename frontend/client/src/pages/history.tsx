import { useState, useMemo } from "react";
import { useAppContext, type Pick as PickType } from "@/lib/context";
import { NBA_TEAMS } from "@/lib/model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AlertCircle, History, Plus, Pencil, Trash2, TrendingUp, Target, DollarSign } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function HistoryPage() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [newPickOpen, setNewPickOpen] = useState(false);
  const [editPickId, setEditPickId] = useState<number | null>(null);

  // New pick form state
  const [formDate, setFormDate] = useState(new Date().toISOString().split("T")[0]);
  const [formTeam, setFormTeam] = useState("");
  const [formOpponent, setFormOpponent] = useState("");
  const [formMarket, setFormMarket] = useState("ML");
  const [formPick, setFormPick] = useState("");
  const [formOdds, setFormOdds] = useState("-150");
  const [formProb, setFormProb] = useState("60");
  const [formStake, setFormStake] = useState("25");
  const [formResult, setFormResult] = useState("P");

  // Edit result form
  const [editResult, setEditResult] = useState("");

  const resetForm = () => {
    setFormDate(new Date().toISOString().split("T")[0]);
    setFormTeam("");
    setFormOpponent("");
    setFormMarket("ML");
    setFormPick("");
    setFormOdds("-150");
    setFormProb("60");
    setFormStake("25");
    setFormResult("P");
  };

  const filteredPicks = useMemo(() => {
    let picks = [...state.picks].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    if (filter === "W") picks = picks.filter((p) => p.result === "W");
    else if (filter === "L") picks = picks.filter((p) => p.result === "L");
    else if (filter === "P") picks = picks.filter((p) => p.result === "P");
    return picks;
  }, [state.picks, filter]);

  const stats = useMemo(() => {
    const resolved = state.picks.filter((p) => p.result === "W" || p.result === "L");
    const wins = resolved.filter((p) => p.result === "W").length;
    const totalProfit = state.picks.reduce((s, p) => s + p.profit, 0);
    const totalStaked = resolved.reduce((s, p) => s + p.stake, 0);
    const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    return { winRate, totalProfit, roi, total: state.picks.length };
  }, [state.picks]);

  const handleAddPick = () => {
    if (!formTeam || !formOpponent || !formPick) {
      toast({ title: "Completa todos los campos requeridos", variant: "destructive" });
      return;
    }
    dispatch({
      type: "ADD_PICK",
      payload: {
        date: formDate,
        team: formTeam,
        opponent: formOpponent,
        market: formMarket,
        pick: formPick,
        odds: parseInt(formOdds),
        modelProb: parseFloat(formProb),
        stake: parseFloat(formStake),
        result: formResult,
      },
    });
    toast({ title: "Pick agregado exitosamente" });
    setNewPickOpen(false);
    resetForm();
  };

  const handleUpdateResult = (id: number) => {
    if (!editResult) return;
    dispatch({ type: "UPDATE_PICK", payload: { id, result: editResult } });
    toast({ title: "Resultado actualizado" });
    setEditPickId(null);
    setEditResult("");
  };

  const handleDelete = (id: number) => {
    dispatch({ type: "DELETE_PICK", payload: id });
    toast({ title: "Pick eliminado" });
  };

  const resultBadge = (result: string) => {
    if (result === "W") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Victoria</Badge>;
    if (result === "L") return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Derrota</Badge>;
    return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">Pendiente</Badge>;
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <History className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-display font-bold" data-testid="text-history-title">Historial NBA</h1>
        </div>
        <Dialog open={newPickOpen} onOpenChange={setNewPickOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-pick" onClick={resetForm}>
              <Plus className="h-4 w-4 mr-2" />
              Nuevo Pick
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Nuevo Pick</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <Label className="text-xs text-muted-foreground">Fecha</Label>
                <Input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} data-testid="input-form-date" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Equipo</Label>
                <Select value={formTeam} onValueChange={setFormTeam}>
                  <SelectTrigger data-testid="select-form-team">
                    <SelectValue placeholder="Seleccionar equipo" />
                  </SelectTrigger>
                  <SelectContent>
                    {NBA_TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Oponente</Label>
                <Select value={formOpponent} onValueChange={setFormOpponent}>
                  <SelectTrigger data-testid="select-form-opponent">
                    <SelectValue placeholder="Seleccionar oponente" />
                  </SelectTrigger>
                  <SelectContent>
                    {NBA_TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Mercado</Label>
                <Select value={formMarket} onValueChange={setFormMarket}>
                  <SelectTrigger data-testid="select-form-market">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ML">ML</SelectItem>
                    <SelectItem value="Spread">Spread</SelectItem>
                    <SelectItem value="Total">Total</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Pick</Label>
                <Input value={formPick} onChange={(e) => setFormPick(e.target.value)} placeholder="Celtics ML" data-testid="input-form-pick" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Cuota Americana</Label>
                  <Input type="number" value={formOdds} onChange={(e) => setFormOdds(e.target.value)} data-testid="input-form-odds" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Prob. Modelo (%)</Label>
                  <Input type="number" min="1" max="99" value={formProb} onChange={(e) => setFormProb(e.target.value)} data-testid="input-form-prob" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Stake ($)</Label>
                <Input type="number" min="1" value={formStake} onChange={(e) => setFormStake(e.target.value)} data-testid="input-form-stake" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Resultado</Label>
                <Select value={formResult} onValueChange={setFormResult}>
                  <SelectTrigger data-testid="select-form-result">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="P">Pendiente</SelectItem>
                    <SelectItem value="W">Victoria</SelectItem>
                    <SelectItem value="L">Derrota</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancelar</Button>
              </DialogClose>
              <Button onClick={handleAddPick} data-testid="button-submit-pick">Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-blue-500/20 bg-blue-500/[0.04]">
        <CardContent className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
          <p>Este historial contiene picks guardados por el usuario. Los resultados se confirman manualmente y los pendientes no entran en el ROI.</p>
        </CardContent>
      </Card>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Target className="h-3 w-3" />
              <span>Win Rate</span>
            </div>
            <p className="text-lg font-bold font-display text-green-400" data-testid="text-hist-winrate">{stats.winRate.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp className="h-3 w-3" />
              <span>Total</span>
            </div>
            <p className="text-lg font-bold font-display" data-testid="text-hist-total">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DollarSign className="h-3 w-3" />
              <span>Profit</span>
            </div>
            <p className={`text-lg font-bold font-display ${stats.totalProfit >= 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-hist-profit">
              {stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp className="h-3 w-3" />
              <span>ROI</span>
            </div>
            <p className={`text-lg font-bold font-display ${stats.roi >= 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-hist-roi">
              {stats.roi >= 0 ? "+" : ""}{stats.roi.toFixed(1)}%
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        {[
          { value: "all", label: "Todos" },
          { value: "W", label: "Victoria" },
          { value: "L", label: "Derrota" },
          { value: "P", label: "Pendiente" },
        ].map((f) => (
          <Button
            key={f.value}
            variant={filter === f.value ? "default" : "secondary"}
            size="sm"
            onClick={() => setFilter(f.value)}
            data-testid={`button-filter-${f.value}`}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="px-0 py-2">
          {filteredPicks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-history">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-2 font-medium">Fecha</th>
                    <th className="text-left px-4 py-2 font-medium">Equipo</th>
                    <th className="text-left px-4 py-2 font-medium hidden sm:table-cell">Oponente</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Mercado</th>
                    <th className="text-left px-4 py-2 font-medium">Pick</th>
                    <th className="text-right px-4 py-2 font-medium">Cuota</th>
                    <th className="text-right px-4 py-2 font-medium hidden lg:table-cell">Prob.</th>
                    <th className="text-right px-4 py-2 font-medium hidden lg:table-cell">Edge</th>
                    <th className="text-right px-4 py-2 font-medium">Stake</th>
                    <th className="text-center px-4 py-2 font-medium">Resultado</th>
                    <th className="text-right px-4 py-2 font-medium">Profit</th>
                    <th className="text-center px-4 py-2 font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPicks.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-b border-border/50 hover:bg-card/50 ${
                        p.result === "W" ? "border-l-2 border-l-green-500/50" :
                        p.result === "L" ? "border-l-2 border-l-red-500/50" :
                        "border-l-2 border-l-amber-500/50"
                      }`}
                      data-testid={`row-history-${p.id}`}
                    >
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{p.date}</td>
                      <td className="px-4 py-2.5 font-medium text-xs">{p.team.split(" ").pop()}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs hidden sm:table-cell">{p.opponent.split(" ").pop()}</td>
                      <td className="px-4 py-2.5 text-xs hidden md:table-cell">{p.market}</td>
                      <td className="px-4 py-2.5 text-xs">{p.pick}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">{p.odds > 0 ? "+" : ""}{p.odds}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs hidden lg:table-cell">{p.modelProb.toFixed(1)}%</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs hidden lg:table-cell">
                        <span className={p.edge > 0 ? "text-green-400" : "text-red-400"}>
                          {p.edge > 0 ? "+" : ""}{p.edge.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">${p.stake.toFixed(0)}</td>
                      <td className="px-4 py-2.5 text-center">{resultBadge(p.result)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono text-xs ${
                        p.profit > 0 ? "text-green-400" : p.profit < 0 ? "text-red-400" : "text-muted-foreground"
                      }`}>
                        {p.profit > 0 ? "+" : ""}{p.profit === 0 ? "—" : `$${p.profit.toFixed(2)}`}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="flex justify-center gap-1">
                          {/* Edit Result */}
                          <Dialog open={editPickId === p.id} onOpenChange={(open) => {
                            if (open) { setEditPickId(p.id); setEditResult(p.result); }
                            else setEditPickId(null);
                          }}>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" data-testid={`button-edit-${p.id}`}>
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-xs">
                              <DialogHeader>
                                <DialogTitle>Editar Resultado</DialogTitle>
                              </DialogHeader>
                              <div className="py-2">
                                <Label className="text-xs text-muted-foreground">Resultado</Label>
                                <Select value={editResult} onValueChange={setEditResult}>
                                  <SelectTrigger data-testid="select-edit-result">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="P">Pendiente</SelectItem>
                                    <SelectItem value="W">Victoria</SelectItem>
                                    <SelectItem value="L">Derrota</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <DialogFooter>
                                <DialogClose asChild>
                                  <Button variant="secondary" size="sm">Cancelar</Button>
                                </DialogClose>
                                <Button size="sm" onClick={() => handleUpdateResult(p.id)} data-testid={`button-save-edit-${p.id}`}>
                                  Guardar
                                </Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>

                          {/* Delete */}
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300" data-testid={`button-delete-${p.id}`}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Eliminar Pick</AlertDialogTitle>
                                <AlertDialogDescription>
                                  ¿Estás seguro de que quieres eliminar este pick? Esta acción no se puede deshacer.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDelete(p.id)} data-testid={`button-confirm-delete-${p.id}`}>
                                  Eliminar
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-muted-foreground text-sm">
              {state.picks.length === 0 ? (
                <>No hay picks todavía. Usa el botón &quot;Nuevo Pick&quot; para comenzar.</>
              ) : (
                <>No hay picks con este filtro.</>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
