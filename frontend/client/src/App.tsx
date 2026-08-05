import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { SessionControl } from "@/components/session-control";
import { AuthProvider } from "@/lib/auth-context";
import { AppProvider } from "@/lib/context";
import { MLB_P1_M3C_FRONTEND_RELEASE } from "@/lib/mlb-scientific-capture";
import Dashboard from "@/pages/dashboard";
import Predictor from "@/pages/predictor";
import CalculatorPage from "@/pages/calculator";
import HistoryPage from "@/pages/history";
import MLBPredictor from "@/pages/mlb-predictor";
import MLBHistoryFocused from "@/pages/mlb-history-focused";
import MLBHistoryAudit from "@/pages/mlb-history";
import MlbHumanReviewConsole from "@/pages/mlb-human-review-console";
import OperationsIncidentCenter from "@/pages/operations-incident-center";
import OperationsReprocessing from "@/pages/operations-reprocessing";
import OperationsEvidenceRepair from "@/pages/operations-evidence-repair";
import WNBAPredictor from "@/pages/wnba-predictor";
import WNBAHistory from "@/pages/wnba-history";
import NHLPredictor from "@/pages/nhl-predictor";
import NHLHistory from "@/pages/nhl-history";
import PicksPage from "@/pages/picks";
import NotFound from "@/pages/not-found";

const FRONTEND_RELEASE = MLB_P1_M3C_FRONTEND_RELEASE;
const PREVIOUS_OPERATIONAL_RELEASES = "p1-m2c3-mlb-smart-default-2026-08-05 p1-m2c2-mlb-priority-first-2026-08-05 p1-m2c1-mlb-visual-consolidation-2026-08-05 p1-m2c-mlb-pregame-readiness-ui-2026-08-05 o2-automatic-alerts-sla-2026-08-04 o3-controlled-reprocessing-2026-08-04 o31-mlb-evidence-repair-2026-08-04 p1-m1-mlb-daily-slate-2026-08-04";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/predictor" component={Predictor} />
      <Route path="/calculator" component={CalculatorPage} />
      <Route path="/mlb" component={MLBPredictor} />
      <Route path="/history" component={HistoryPage} />
      <Route path="/mlb-history" component={MLBHistoryFocused} />
      <Route path="/mlb-history-audit" component={MLBHistoryAudit} />
      <Route path="/mlb-human-review" component={MlbHumanReviewConsole} />
      <Route path="/operations/evidence-repair" component={OperationsEvidenceRepair} />
      <Route path="/operations/reprocessing" component={OperationsReprocessing} />
      <Route path="/operations" component={OperationsIncidentCenter} />
      <Route path="/wnba" component={WNBAPredictor} />
      <Route path="/wnba-history" component={WNBAHistory} />
      <Route path="/nhl" component={NHLPredictor} />
      <Route path="/nhl-history" component={NHLHistory} />
      <Route path="/picks" component={PicksPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppLayout() {
  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div
        className="flex h-screen w-full"
        data-frontend-release={FRONTEND_RELEASE}
        data-previous-operational-releases={PREVIOUS_OPERATIONAL_RELEASES}
      >
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-3 h-12 px-3 border-b border-border shrink-0">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <SessionControl />
          </header>
          <main className="flex-1 overflow-y-auto overscroll-contain">
            <AppRouter />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AppProvider>
            <Router hook={useHashLocation}>
              <AppLayout />
            </Router>
          </AppProvider>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
