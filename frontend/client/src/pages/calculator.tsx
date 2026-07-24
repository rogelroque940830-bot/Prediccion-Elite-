import { useState, useMemo } from "react";
import { americanToProb, kellyStake, getEdge, getSignal, expectedValue } from "@/lib/model";
import { useAppContext } from "@/lib/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calculator } from "lucide-react";

export default function CalculatorPage() {
  const { state } = useAppContext();
  const [odds, setOdds] = useState("-150");
  const [modelProb, setModelProb] = useState("65");
  const [bankroll, setBankroll] = useState(
    String(Math.round((state.bankrollInitial + state.picks.reduce((s, p) => s + p.profit, 0)) * 100) / 100)
  );

  const result = useMemo(() => {
    const o = parseInt(odds);
    const mp = parseFloat(modelProb) / 100;
    const br = parseFloat(bankroll);
    if (isNaN(o) || o === 0 || isNaN(mp) || mp <= 0 || mp >= 1 || isNaN(br) || br <= 0) return null;

    const impliedProb = americanToProb(o);
    const edge = getEdge(mp, impliedProb);
    const signal = getSignal(edge);
    const stake = kellyStake(mp, o, br);
    const ev = expectedValue(mp, o, stake > 0 ? stake : 10);
    const units = br > 0 ? (stake / br) * 100 : 0;

    return {
      impliedProb: impliedProb * 100,
      edge,
      signal,
      stake,
      ev,
      units,
      modelProbPercent: mp * 100,
    };
  }, [odds, modelProb, bankroll]);

  const signalColor = (s: string) => {
    if (s === "BET") return "bg-green-500/20 text-green-400 border-green-500/30";
    if (s === "LEAN") return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    return "bg-red-500/20 text-red-400 border-red-500/30";
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[800px] mx-auto">
      <div className="flex items-center gap-3">
        <Calculator className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-display font-bold" data-testid="text-calculator-title">Calculadora</h1>
      </div>

      {/* Inputs */}
      <Card>
        <CardHeader className="pb-3 px-4 pt-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">Parámetros</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Cuota Americana</Label>
              <Input
                type="number" value={odds} onChange={(e) => setOdds(e.target.value)}
                placeholder="-150" data-testid="input-calc-odds"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Probabilidad del Modelo (%)</Label>
              <Input
                type="number" min="1" max="99" step="0.1" value={modelProb}
                onChange={(e) => setModelProb(e.target.value)}
                placeholder="65" data-testid="input-calc-prob"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Bankroll ($)</Label>
              <Input
                type="number" min="1" value={bankroll} onChange={(e) => setBankroll(e.target.value)}
                placeholder="1000" data-testid="input-calc-bankroll"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results (live) */}
      {result ? (
        <Card className="border-primary/30" data-testid="card-calc-result">
          <CardHeader className="pb-3 px-4 pt-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Resultado</CardTitle>
              <Badge className={`${signalColor(result.signal)} text-sm px-3 py-1`} data-testid="badge-calc-signal">
                {result.signal}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Prob. Implícita</p>
                <p className="text-xl font-bold font-mono" data-testid="text-calc-implied">
                  {result.impliedProb.toFixed(1)}%
                </p>
              </div>
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Edge</p>
                <p className={`text-xl font-bold font-mono ${result.edge > 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-calc-edge">
                  {result.edge > 0 ? "+" : ""}{result.edge.toFixed(2)}%
                </p>
              </div>
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">EV</p>
                <p className={`text-xl font-bold font-mono ${result.ev > 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-calc-ev">
                  {result.ev > 0 ? "+" : ""}${result.ev.toFixed(2)}
                </p>
              </div>
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Quarter Kelly ($)</p>
                <p className="text-xl font-bold font-mono text-blue-400" data-testid="text-calc-stake">
                  ${result.stake.toFixed(2)}
                </p>
              </div>
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Unidades (%)</p>
                <p className="text-xl font-bold font-mono text-blue-400" data-testid="text-calc-units">
                  {result.units.toFixed(2)}%
                </p>
              </div>
              <div className="bg-background/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Prob. Modelo</p>
                <p className="text-xl font-bold font-mono" data-testid="text-calc-model">
                  {result.modelProbPercent.toFixed(1)}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            Ingresa valores válidos para ver el cálculo
          </CardContent>
        </Card>
      )}
    </div>
  );
}
