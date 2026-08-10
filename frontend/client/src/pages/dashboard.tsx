import { useMemo } from "react";
import { useAppContext } from "@/lib/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";
import { TrendingUp, Target, Percent, DollarSign } from "lucide-react";
import { CLVTracker } from "@/components/clv-tracker";

export default function Dashboard() {
  const { state } = useAppContext();
  const { picks, mlbPicks, nhlPicks, wnbaPicks, bankrollInitial } = state;

  // Merge all sports into one unified list with sport tag
  const allPicks = useMemo(() => [
    ...picks.map(p => ({ ...p, sport: "NBA" as const })),
    ...mlbPicks.map(p => ({ ...p, sport: "MLB" as const })),
    ...nhlPicks.map(p => ({ ...p, sport: "NHL" as const })),
    ...wnbaPicks.map(p => ({ ...p, sport: "WNBA" as const })),
  ], [picks, mlbPicks, nhlPicks, wnbaPicks]);

  const stats = useMemo(() => {
    const resolved = allPicks.filter((p) => p.result === "W" || p.result === "L");
    const wins = resolved.filter((p) => p.result === "W").length;
    const losses = resolved.filter((p) => p.result === "L").length;
    const pending = allPicks.filter((p) => p.result === "P").length;
    const totalProfit = allPicks.reduce((sum, p) => sum + p.profit, 0);
    const totalStaked = allPicks.reduce((sum, p) => sum + p.stake, 0);
    const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    const bankroll = bankrollInitial + totalProfit;

    // Per-sport breakdown
    const bySport: Record<string, { w: number; l: number; profit: number }> = {};
    for (const p of allPicks) {
      if (!bySport[p.sport]) bySport[p.sport] = { w: 0, l: 0, profit: 0 };
      if (p.result === "W") bySport[p.sport].w++;
      if (p.result === "L") bySport[p.sport].l++;
      bySport[p.sport].profit += p.profit;
    }

    return { wins, losses, pending, totalProfit, totalStaked, winRate, roi, bankroll, totalPicks: allPicks.length, bySport };
  }, [allPicks, bankrollInitial]);

  // Bankroll evolution (all sports combined)
  const bankrollData = useMemo(() => {
    const sorted = [...allPicks].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    let cumulative = bankrollInitial;
    return [
      { name: "Inicio", value: bankrollInitial },
      ...sorted.map((p) => {
        cumulative += p.profit;
        return { name: p.date.slice(5), value: Math.round(cumulative * 100) / 100 };
      }),
    ];
  }, [allPicks, bankrollInitial]);

  // Win/Loss/Pending donut
  const donutData = useMemo(() => [
    { name: "Victoria", value: stats.wins, color: "hsl(142, 76%, 47%)" },
    { name: "Derrota", value: stats.losses, color: "hsl(0, 72%, 51%)" },
    { name: "Pendiente", value: stats.pending, color: "hsl(38, 92%, 50%)" },
  ].filter((d) => d.value > 0), [stats]);

  // Sport breakdown for donut
  const sportDonutData = useMemo(() => {
    const colors: Record<string, string> = { NBA: "hsl(217, 91%, 60%)", MLB: "hsl(142, 76%, 47%)", NHL: "hsl(38, 92%, 50%)", WNBA: "hsl(280, 70%, 60%)" };
    return Object.entries(stats.bySport)
      .map(([sport, d]) => ({ name: sport, value: d.w + d.l, color: colors[sport] || "hsl(215, 20%, 55%)" }))
      .filter(d => d.value > 0);
  }, [stats]);

  // Monthly ROI
  const monthlyData = useMemo(() => {
    const months: Record<string, { profit: number; staked: number }> = {};
    allPicks.forEach((p) => {
      const m = p.date.slice(0, 7);
      if (!months[m]) months[m] = { profit: 0, staked: 0 };
      months[m].profit += p.profit;
      months[m].staked += p.stake;
    });
    return Object.entries(months)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month: month.slice(5),
        roi: data.staked > 0 ? Math.round((data.profit / data.staked) * 100 * 100) / 100 : 0,
      }));
  }, [allPicks]);

  // Recent picks (last 15, all sports)
  const recentPicks = useMemo(() => {
    return [...allPicks].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 15);
  }, [allPicks]);

  const resultBadge = (result: string) => {
    if (result === "W") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Victoria</Badge>;
    if (result === "L") return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Derrota</Badge>;
    return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">Pendiente</Badge>;
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-display font-bold" data-testid="text-dashboard-title">Dashboard</h1>

      {/* CLV Tracker — lo más arriba porque es la métrica más importante */}
      <CLVTracker />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <Card data-testid="kpi-winrate">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Target className="h-3.5 w-3.5" />
              <span>Win Rate</span>
            </div>
            <p className="text-2xl font-display font-bold text-green-400">{stats.winRate.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-picks">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp className="h-3.5 w-3.5" />
              <span>Total Picks</span>
            </div>
            <p className="text-2xl font-display font-bold">{stats.totalPicks}</p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-roi">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Percent className="h-3.5 w-3.5" />
              <span>ROI</span>
            </div>
            <p className={`text-2xl font-display font-bold ${stats.roi >= 0 ? "text-green-400" : "text-red-400"}`}>
              {stats.roi >= 0 ? "+" : ""}{stats.roi.toFixed(1)}%
            </p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-bankroll">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DollarSign className="h-3.5 w-3.5" />
              <span>Bankroll</span>
            </div>
            <p className={`text-2xl font-display font-bold ${stats.bankroll >= bankrollInitial ? "text-green-400" : "text-red-400"}`}>
              ${stats.bankroll.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Sport Breakdown */}
      {Object.keys(stats.bySport).length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          {["NBA", "MLB", "NHL", "WNBA"].map(sport => {
            const d = stats.bySport[sport];
            if (!d) return null;
            const total = d.w + d.l;
            const wr = total > 0 ? (d.w / total * 100).toFixed(1) : "0.0";
            const colors: Record<string, string> = { NBA: "text-blue-400", MLB: "text-green-400", NHL: "text-amber-400", WNBA: "text-purple-400" };
            return (
              <Card key={sport}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-xs font-bold ${colors[sport]}`}>{sport}</span>
                    <span className="text-xs text-muted-foreground">{d.w}V-{d.l}D</span>
                  </div>
                  <p className={`text-lg font-display font-bold ${parseFloat(wr) >= 55 ? "text-green-400" : parseFloat(wr) >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                    {wr}%
                  </p>
                  <p className={`text-xs font-mono ${d.profit >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {d.profit >= 0 ? "+" : ""}${d.profit.toFixed(2)}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Bankroll evolution */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">Evolución del Bankroll</CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-4">
            {bankrollData.length > 1 ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={bankrollData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(217 33% 17%)" />
                  <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 55%)", fontSize: 11 }} />
                  <YAxis tick={{ fill: "hsl(215 20% 55%)", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(222 40% 9%)",
                      border: "1px solid hsl(217 33% 17%)",
                      borderRadius: 8,
                      color: "hsl(210 40% 93%)",
                      fontSize: 12,
                    }}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, "Bankroll"]}
                  />
                  <Line
                    type="monotone" dataKey="value" stroke="hsl(217, 91%, 60%)"
                    strokeWidth={2} dot={{ r: 3, fill: "hsl(217, 91%, 60%)" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
                Agrega picks para ver la evolución del bankroll
              </div>
            )}
          </CardContent>
        </Card>

        {/* Donut */}
        <Card>
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">Distribución de Resultados</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {donutData.length > 0 ? (
              <div className="flex flex-col items-center">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={donutData} dataKey="value" innerRadius={50} outerRadius={75}
                      paddingAngle={3} strokeWidth={0}
                    >
                      {donutData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "hsl(222 40% 9%)",
                        border: "1px solid hsl(217 33% 17%)",
                        borderRadius: 8,
                        color: "hsl(210 40% 93%)",
                        fontSize: 12,
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex gap-4 text-xs mt-2">
                  {donutData.map((d) => (
                    <div key={d.name} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
                      <span className="text-muted-foreground">{d.name} ({d.value})</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                Sin datos todavía
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Monthly ROI */}
      {monthlyData.length > 0 && (
        <Card>
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">ROI Mensual</CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(217 33% 17%)" />
                <XAxis dataKey="month" tick={{ fill: "hsl(215 20% 55%)", fontSize: 11 }} />
                <YAxis tick={{ fill: "hsl(215 20% 55%)", fontSize: 11 }} unit="%" />
                <Tooltip
                  contentStyle={{
                    background: "hsl(222 40% 9%)",
                    border: "1px solid hsl(217 33% 17%)",
                    borderRadius: 8,
                    color: "hsl(210 40% 93%)",
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [`${value.toFixed(1)}%`, "ROI"]}
                />
                <Bar dataKey="roi" radius={[4, 4, 0, 0]}>
                  {monthlyData.map((entry, i) => (
                    <Cell key={i} fill={entry.roi >= 0 ? "hsl(142 76% 47%)" : "hsl(0 72% 51%)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Recent picks table */}
      <Card>
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">Picks Recientes</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {recentPicks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-recent-picks">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-2 font-medium">Fecha</th>
                    <th className="text-center px-4 py-2 font-medium">Liga</th>
                    <th className="text-left px-4 py-2 font-medium">Equipo</th>
                    <th className="text-left px-4 py-2 font-medium hidden sm:table-cell">Oponente</th>
                    <th className="text-left px-4 py-2 font-medium">Pick</th>
                    <th className="text-right px-4 py-2 font-medium">Cuota</th>
                    <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Edge</th>
                    <th className="text-center px-4 py-2 font-medium">Resultado</th>
                    <th className="text-right px-4 py-2 font-medium">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPicks.map((p) => (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-card/50" data-testid={`row-pick-${p.id}`}>
                      <td className="px-4 py-2.5 text-muted-foreground">{p.date.slice(5)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <Badge className={`text-[10px] px-1.5 py-0 ${
                          (p as any).sport === "NBA" ? "bg-blue-500/20 text-blue-400 border-blue-500/30" :
                          (p as any).sport === "MLB" ? "bg-green-500/20 text-green-400 border-green-500/30" :
                          (p as any).sport === "NHL" ? "bg-amber-500/20 text-amber-400 border-amber-500/30" :
                          "bg-purple-500/20 text-purple-400 border-purple-500/30"
                        }`}>{(p as any).sport}</Badge>
                      </td>
                      <td className="px-4 py-2.5 font-medium">{p.team.split(" ").pop()}</td>
                      <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{p.opponent.split(" ").pop()}</td>
                      <td className="px-4 py-2.5">{p.pick}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">{p.odds > 0 ? "+" : ""}{p.odds}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs hidden md:table-cell">
                        <span className={p.edge > 0 ? "text-green-400" : "text-red-400"}>
                          {p.edge > 0 ? "+" : ""}{p.edge.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">{resultBadge(p.result)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono text-xs ${p.profit > 0 ? "text-green-400" : p.profit < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {p.profit > 0 ? "+" : ""}{p.profit === 0 ? "—" : `$${p.profit.toFixed(2)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-muted-foreground text-sm">
              Sin picks todavía. Ve a Historial para agregar tu primer pick.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
