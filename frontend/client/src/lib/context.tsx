import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { americanToProb, americanToDecimal } from "./model";
import { deletePick, listPicks, savePick, updatePick, type SavedPick } from "./picks-api";
import { useAuth } from "./auth-context";
import { useToast } from "@/hooks/use-toast";

export interface Pick {
  id: number;
  serverId?: string;
  date: string;
  sport: "NBA" | "MLB" | "WNBA" | "NHL";
  team: string;
  opponent: string;
  market: string;
  pick: string;
  odds: number;
  modelProb: number;
  impliedProb: number;
  edge: number;
  stake: number;
  result: string;
  profit: number;
  closingOdds?: number;
  closingImpliedProb?: number;
  clvPercent?: number;
}

export interface AppState {
  picks: Pick[];
  mlbPicks: Pick[];
  wnbaPicks: Pick[];
  nhlPicks: Pick[];
  bankrollInitial: number;
  nextId: number;
}

export type Action =
  | { type: "ADD_PICK"; payload: Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_PICK"; payload: number }
  | { type: "ADD_MLB_PICK"; payload: Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_MLB_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_MLB_PICK"; payload: number }
  | { type: "ADD_WNBA_PICK"; payload: Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_WNBA_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_WNBA_PICK"; payload: number }
  | { type: "ADD_NHL_PICK"; payload: Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_NHL_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_NHL_PICK"; payload: number }
  | { type: "UPDATE_PICK_CLV"; payload: { id: number; sport: string; closingOdds: number; closingImpliedProb: number; clvPercent: number } }
  | { type: "SET_BANKROLL"; payload: number }
  | { type: "LOAD_STATE"; payload: AppState };

type SportCode = "nba" | "mlb" | "wnba" | "nhl";
type SportLabel = Pick["sport"];

const SPORT_CODE: Record<SportLabel, SportCode> = {
  NBA: "nba",
  MLB: "mlb",
  WNBA: "wnba",
  NHL: "nhl",
};

function calcProfit(result: string, stake: number, odds: number): number {
  if (result === "W") return stake * (americanToDecimal(odds) - 1);
  if (result === "L") return -stake;
  return 0;
}

function canonicalId(sport: SportLabel, id: number): string {
  return `ui-${SPORT_CODE[sport]}-${id}`;
}

function createPick(
  state: AppState,
  payload: Omit<Pick, "id" | "serverId" | "impliedProb" | "edge" | "profit">,
  sport: SportLabel,
): Pick {
  const impliedProb = americanToProb(payload.odds) * 100;
  return {
    ...payload,
    sport,
    id: state.nextId,
    serverId: canonicalId(sport, state.nextId),
    impliedProb,
    edge: payload.modelProb - impliedProb,
    profit: calcProfit(payload.result, payload.stake, payload.odds),
  };
}

function updateResult(items: Pick[], id: number, result: string): Pick[] {
  return items.map((pick) => pick.id === id
    ? { ...pick, result, profit: calcProfit(result, pick.stake, pick.odds) }
    : pick);
}

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LOAD_STATE":
      return action.payload;
    case "ADD_PICK": {
      const pick = createPick(state, action.payload, "NBA");
      return { ...state, picks: [...state.picks, pick], nextId: state.nextId + 1 };
    }
    case "UPDATE_PICK":
      return { ...state, picks: updateResult(state.picks, action.payload.id, action.payload.result) };
    case "DELETE_PICK":
      return { ...state, picks: state.picks.filter((pick) => pick.id !== action.payload) };
    case "ADD_MLB_PICK": {
      const pick = createPick(state, action.payload, "MLB");
      return { ...state, mlbPicks: [...state.mlbPicks, pick], nextId: state.nextId + 1 };
    }
    case "UPDATE_MLB_PICK":
      return { ...state, mlbPicks: updateResult(state.mlbPicks, action.payload.id, action.payload.result) };
    case "DELETE_MLB_PICK":
      return { ...state, mlbPicks: state.mlbPicks.filter((pick) => pick.id !== action.payload) };
    case "ADD_WNBA_PICK": {
      const pick = createPick(state, action.payload, "WNBA");
      return { ...state, wnbaPicks: [...state.wnbaPicks, pick], nextId: state.nextId + 1 };
    }
    case "UPDATE_WNBA_PICK":
      return { ...state, wnbaPicks: updateResult(state.wnbaPicks, action.payload.id, action.payload.result) };
    case "DELETE_WNBA_PICK":
      return { ...state, wnbaPicks: state.wnbaPicks.filter((pick) => pick.id !== action.payload) };
    case "ADD_NHL_PICK": {
      const pick = createPick(state, action.payload, "NHL");
      return { ...state, nhlPicks: [...state.nhlPicks, pick], nextId: state.nextId + 1 };
    }
    case "UPDATE_NHL_PICK":
      return { ...state, nhlPicks: updateResult(state.nhlPicks, action.payload.id, action.payload.result) };
    case "DELETE_NHL_PICK":
      return { ...state, nhlPicks: state.nhlPicks.filter((pick) => pick.id !== action.payload) };
    case "UPDATE_PICK_CLV": {
      const update = (items: Pick[]) => items.map((pick) => pick.id === action.payload.id
        ? {
          ...pick,
          closingOdds: action.payload.closingOdds,
          closingImpliedProb: action.payload.closingImpliedProb,
          clvPercent: action.payload.clvPercent,
        }
        : pick);
      if (action.payload.sport === "MLB") return { ...state, mlbPicks: update(state.mlbPicks) };
      if (action.payload.sport === "NHL") return { ...state, nhlPicks: update(state.nhlPicks) };
      if (action.payload.sport === "WNBA") return { ...state, wnbaPicks: update(state.wnbaPicks) };
      return { ...state, picks: update(state.picks) };
    }
    case "SET_BANKROLL":
      return { ...state, bankrollInitial: action.payload };
    default:
      return state;
  }
}

const initialState: AppState = {
  picks: [],
  mlbPicks: [],
  wnbaPicks: [],
  nhlPicks: [],
  bankrollInitial: 1000,
  nextId: 1,
};

function numericOdds(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(String(value || "-110").replace(/^\+/, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : -110;
}

function recordToPick(record: SavedPick, fallbackId: number): Pick {
  const sport = record.sport.toUpperCase() as SportLabel;
  const odds = numericOdds(record.odds);
  const modelProb = record.modelProb ?? record.confidence;
  const impliedProb = record.impliedProb ?? americanToProb(odds) * 100;
  const idMatch = record.id.match(/-(\d+)$/);
  const id = record.clientId ?? (idMatch ? Number(idMatch[1]) : fallbackId);
  const selectedHome = /home|local/i.test(record.pickSide)
    || record.pickSide.toLowerCase().includes(record.homeTeam.toLowerCase());
  const team = record.team || (selectedHome ? record.homeTeam : record.awayTeam);
  const opponent = record.opponent || (selectedHome ? record.awayTeam : record.homeTeam);
  const result = record.result || "";
  const stake = record.stake ?? 0;

  return {
    id,
    serverId: record.id,
    date: record.date || new Date(record.ts).toISOString().slice(0, 10),
    sport,
    team,
    opponent,
    market: record.market || record.pickType,
    pick: record.pick || record.pickSide,
    odds,
    modelProb,
    impliedProb,
    edge: record.edge ?? modelProb - impliedProb,
    stake,
    result,
    profit: record.profit ?? calcProfit(result, stake, odds),
    closingOdds: record.closingOdds,
    closingImpliedProb: record.closingImpliedProb,
    clvPercent: record.clvPercent,
  };
}

function recordsToState(records: SavedPick[], bankrollInitial: number): AppState {
  const usedIds = new Set<number>();
  let fallbackId = 1;
  const mapped = records.map((record) => {
    while (usedIds.has(fallbackId)) fallbackId += 1;
    let pick = recordToPick(record, fallbackId);
    while (usedIds.has(pick.id)) pick = { ...pick, id: ++fallbackId };
    usedIds.add(pick.id);
    fallbackId = Math.max(fallbackId, pick.id + 1);
    return pick;
  });

  return {
    picks: mapped.filter((pick) => pick.sport === "NBA"),
    mlbPicks: mapped.filter((pick) => pick.sport === "MLB"),
    wnbaPicks: mapped.filter((pick) => pick.sport === "WNBA"),
    nhlPicks: mapped.filter((pick) => pick.sport === "NHL"),
    bankrollInitial,
    nextId: Math.max(1, ...mapped.map((pick) => pick.id + 1)),
  };
}

function pickToRecord(pick: Pick): Parameters<typeof savePick>[0] {
  return {
    id: pick.serverId || canonicalId(pick.sport, pick.id),
    ts: Number.isFinite(Date.parse(pick.date)) ? Date.parse(pick.date) : Date.now(),
    sport: SPORT_CODE[pick.sport],
    homeTeam: pick.team,
    awayTeam: pick.opponent,
    pickType: pick.market,
    pickSide: pick.pick,
    confidence: pick.modelProb,
    edge: pick.edge,
    odds: pick.odds,
    notes: "Court Edge application history; venue orientation was not supplied by the legacy UI.",
    source: "app",
    clientId: pick.id,
    date: pick.date,
    team: pick.team,
    opponent: pick.opponent,
    market: pick.market,
    pick: pick.pick,
    modelProb: pick.modelProb,
    impliedProb: pick.impliedProb,
    stake: pick.stake,
    result: pick.result,
    profit: pick.profit,
    closingOdds: pick.closingOdds,
    closingImpliedProb: pick.closingImpliedProb,
    clvPercent: pick.clvPercent,
  };
}

function listForSport(state: AppState, sport: SportLabel): Pick[] {
  if (sport === "MLB") return state.mlbPicks;
  if (sport === "WNBA") return state.wnbaPicks;
  if (sport === "NHL") return state.nhlPicks;
  return state.picks;
}

function isServerMutation(action: Action): boolean {
  return !["LOAD_STATE", "SET_BANKROLL"].includes(action.type);
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  reloadFromServer: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const pendingActionRef = useRef<Action | null>(null);
  const { authenticated, requestLogin } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reloadFromServer = useCallback(async () => {
    const storedBankroll = Number(localStorage.getItem("courtedge.bankrollInitial"));
    const bankroll = Number.isFinite(storedBankroll) && storedBankroll > 0
      ? storedBankroll
      : stateRef.current.bankrollInitial;
    const records = await listPicks({ days: 3650 });
    const next = recordsToState(records, bankroll);
    stateRef.current = next;
    baseDispatch({ type: "LOAD_STATE", payload: next });
  }, []);

  useEffect(() => {
    void reloadFromServer().catch((error) => {
      console.error("Unable to load picks v2", error);
    });
  }, [reloadFromServer]);

  const persistAction = useCallback(async (action: Action, before: AppState, after: AppState) => {
    switch (action.type) {
      case "LOAD_STATE":
        return;
      case "SET_BANKROLL":
        localStorage.setItem("courtedge.bankrollInitial", String(action.payload));
        return;
      case "ADD_PICK":
      case "ADD_MLB_PICK":
      case "ADD_WNBA_PICK":
      case "ADD_NHL_PICK": {
        const sport: SportLabel = action.type === "ADD_MLB_PICK" ? "MLB"
          : action.type === "ADD_WNBA_PICK" ? "WNBA"
            : action.type === "ADD_NHL_PICK" ? "NHL" : "NBA";
        const created = listForSport(after, sport).find((pick) => pick.id === before.nextId);
        if (created) await savePick(pickToRecord(created));
        return;
      }
      case "UPDATE_PICK":
      case "UPDATE_MLB_PICK":
      case "UPDATE_WNBA_PICK":
      case "UPDATE_NHL_PICK": {
        const sport: SportLabel = action.type === "UPDATE_MLB_PICK" ? "MLB"
          : action.type === "UPDATE_WNBA_PICK" ? "WNBA"
            : action.type === "UPDATE_NHL_PICK" ? "NHL" : "NBA";
        const updated = listForSport(after, sport).find((pick) => pick.id === action.payload.id);
        if (updated) {
          await updatePick(updated.serverId || canonicalId(sport, updated.id), {
            result: updated.result,
            profit: updated.profit,
          });
        }
        return;
      }
      case "DELETE_PICK":
      case "DELETE_MLB_PICK":
      case "DELETE_WNBA_PICK":
      case "DELETE_NHL_PICK": {
        const sport: SportLabel = action.type === "DELETE_MLB_PICK" ? "MLB"
          : action.type === "DELETE_WNBA_PICK" ? "WNBA"
            : action.type === "DELETE_NHL_PICK" ? "NHL" : "NBA";
        const deleted = listForSport(before, sport).find((pick) => pick.id === action.payload);
        if (deleted) await deletePick(deleted.serverId || canonicalId(sport, deleted.id));
        return;
      }
      case "UPDATE_PICK_CLV": {
        const sport = action.payload.sport.toUpperCase() as SportLabel;
        const updated = listForSport(after, sport).find((pick) => pick.id === action.payload.id);
        if (updated) {
          await updatePick(updated.serverId || canonicalId(sport, updated.id), {
            closingOdds: updated.closingOdds,
            closingImpliedProb: updated.closingImpliedProb,
            clvPercent: updated.clvPercent,
          });
        }
      }
    }
  }, []);

  const executeAction = useCallback((action: Action) => {
    const before = stateRef.current;
    const after = appReducer(before, action);
    stateRef.current = after;
    baseDispatch(action);

    void persistAction(action, before, after).catch(async (error) => {
      toast({
        title: "No se guardó el cambio",
        description: error instanceof Error ? error.message : "Error de persistencia",
        variant: "destructive",
      });
      try {
        await reloadFromServer();
      } catch {
        // Keep the current UI available; a later refresh can retry the canonical load.
      }
    });
  }, [persistAction, reloadFromServer, toast]);

  const dispatch = useCallback<React.Dispatch<Action>>((action) => {
    if (isServerMutation(action) && !authenticated) {
      pendingActionRef.current = action;
      requestLogin();
      toast({
        title: "Inicia sesión para guardar",
        description: "El cambio se aplicará después de autenticar la sesión.",
      });
      return;
    }
    executeAction(action);
  }, [authenticated, executeAction, requestLogin, toast]);

  useEffect(() => {
    if (!authenticated || !pendingActionRef.current) return;
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    executeAction(pending);
  }, [authenticated, executeAction]);

  const value = useMemo(() => ({ state, dispatch, reloadFromServer }), [dispatch, reloadFromServer, state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useAppContext must be used within AppProvider");
  return context;
}
