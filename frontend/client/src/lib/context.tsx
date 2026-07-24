import { createContext, useContext, useReducer, useEffect, useRef, type ReactNode } from "react";
import { americanToProb, americanToDecimal } from "./model";
import { API_BASE } from "./queryClient";

export interface Pick {
  id: number;
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
  result: string; // "W" | "L" | "P"
  profit: number;
  // CLV — Closing Line Value
  closingOdds?: number;        // Cuota al cierre
  closingImpliedProb?: number; // Prob implícita al cierre
  clvPercent?: number;         // % de CLV (positivo = ganaste valor)
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
  | { type: "ADD_PICK"; payload: Omit<Pick, "id" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_PICK"; payload: number }
  | { type: "ADD_MLB_PICK"; payload: Omit<Pick, "id" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_MLB_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_MLB_PICK"; payload: number }
  | { type: "ADD_WNBA_PICK"; payload: Omit<Pick, "id" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_WNBA_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_WNBA_PICK"; payload: number }
  | { type: "ADD_NHL_PICK"; payload: Omit<Pick, "id" | "impliedProb" | "edge" | "profit"> }
  | { type: "UPDATE_NHL_PICK"; payload: { id: number; result: string } }
  | { type: "DELETE_NHL_PICK"; payload: number }
  | { type: "UPDATE_PICK_CLV"; payload: { id: number; sport: string; closingOdds: number; closingImpliedProb: number; clvPercent: number } }
  | { type: "SET_BANKROLL"; payload: number }
  | { type: "LOAD_STATE"; payload: AppState };

function calcProfit(result: string, stake: number, odds: number): number {
  if (result === "W") {
    const decimal = americanToDecimal(odds);
    return stake * (decimal - 1);
  }
  if (result === "L") return -stake;
  return 0;
}

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LOAD_STATE":
      return action.payload;
    case "ADD_PICK": {
      const { payload } = action;
      const impliedProb = americanToProb(payload.odds);
      const edge = (payload.modelProb / 100 - impliedProb) * 100;
      const profit = calcProfit(payload.result, payload.stake, payload.odds);
      const newPick: Pick = {
        ...payload,
        id: state.nextId,
        impliedProb: impliedProb * 100,
        edge,
        profit,
      };
      return {
        ...state,
        picks: [...state.picks, newPick],
        nextId: state.nextId + 1,
      };
    }
    case "UPDATE_PICK": {
      const { id, result } = action.payload;
      return {
        ...state,
        picks: state.picks.map((p) => {
          if (p.id !== id) return p;
          const profit = calcProfit(result, p.stake, p.odds);
          return { ...p, result, profit };
        }),
      };
    }
    case "DELETE_PICK":
      return {
        ...state,
        picks: state.picks.filter((p) => p.id !== action.payload),
      };
    case "ADD_MLB_PICK": {
      const { payload } = action;
      const impliedProb = americanToProb(payload.odds);
      const edge = (payload.modelProb / 100 - impliedProb) * 100;
      const profit = calcProfit(payload.result, payload.stake, payload.odds);
      const newPick: Pick = {
        ...payload,
        id: state.nextId,
        impliedProb: impliedProb * 100,
        edge,
        profit,
      };
      return {
        ...state,
        mlbPicks: [...state.mlbPicks, newPick],
        nextId: state.nextId + 1,
      };
    }
    case "UPDATE_MLB_PICK": {
      const { id, result } = action.payload;
      return {
        ...state,
        mlbPicks: state.mlbPicks.map((p) => {
          if (p.id !== id) return p;
          const profit = calcProfit(result, p.stake, p.odds);
          return { ...p, result, profit };
        }),
      };
    }
    case "DELETE_MLB_PICK":
      return {
        ...state,
        mlbPicks: state.mlbPicks.filter((p) => p.id !== action.payload),
      };
    case "ADD_WNBA_PICK": {
      const { payload } = action;
      const impliedProb = americanToProb(payload.odds);
      const edge = (payload.modelProb / 100 - impliedProb) * 100;
      const profit = calcProfit(payload.result, payload.stake, payload.odds);
      const newPick: Pick = { ...payload, id: state.nextId, impliedProb: impliedProb * 100, edge, profit };
      return { ...state, wnbaPicks: [...state.wnbaPicks, newPick], nextId: state.nextId + 1 };
    }
    case "UPDATE_WNBA_PICK": {
      const { id, result } = action.payload;
      return { ...state, wnbaPicks: state.wnbaPicks.map((p) => p.id !== id ? p : { ...p, result, profit: calcProfit(result, p.stake, p.odds) }) };
    }
    case "DELETE_WNBA_PICK":
      return { ...state, wnbaPicks: state.wnbaPicks.filter((p) => p.id !== action.payload) };
    case "ADD_NHL_PICK": {
      const { payload } = action;
      const impliedProb = americanToProb(payload.odds);
      const edge = (payload.modelProb / 100 - impliedProb) * 100;
      const profit = calcProfit(payload.result, payload.stake, payload.odds);
      const newPick: Pick = { ...payload, id: state.nextId, impliedProb: impliedProb * 100, edge, profit };
      return { ...state, nhlPicks: [...state.nhlPicks, newPick], nextId: state.nextId + 1 };
    }
    case "UPDATE_NHL_PICK": {
      const { id, result } = action.payload;
      return { ...state, nhlPicks: state.nhlPicks.map((p) => p.id !== id ? p : { ...p, result, profit: calcProfit(result, p.stake, p.odds) }) };
    }
    case "DELETE_NHL_PICK":
      return { ...state, nhlPicks: state.nhlPicks.filter((p) => p.id !== action.payload) };
    case "UPDATE_PICK_CLV": {
      const { id, sport, closingOdds, closingImpliedProb, clvPercent } = action.payload;
      const updateIn = (arr: Pick[]) => arr.map(p => p.id === id ? { ...p, closingOdds, closingImpliedProb, clvPercent } : p);
      if (sport === "MLB") return { ...state, mlbPicks: updateIn(state.mlbPicks) };
      if (sport === "NHL") return { ...state, nhlPicks: updateIn(state.nhlPicks) };
      if (sport === "WNBA") return { ...state, wnbaPicks: updateIn(state.wnbaPicks) };
      return { ...state, picks: updateIn(state.picks) };
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

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const loadedRef = useRef(false);

  // Load picks from server on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/picks`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && (data.picks?.length || data.mlbPicks?.length || data.wnbaPicks?.length || data.nhlPicks?.length)) {
          dispatch({
            type: "LOAD_STATE",
            payload: {
              picks: data.picks || [],
              mlbPicks: data.mlbPicks || [],
              wnbaPicks: data.wnbaPicks || [],
              nhlPicks: data.nhlPicks || [],
              bankrollInitial: data.bankroll ?? 1000,
              nextId: data.nextId ?? 1,
            },
          });
        }
        loadedRef.current = true;
      })
      .catch(() => { loadedRef.current = true; });
  }, []);

  // Sync entire state to server on every change (debounced 500ms)
  // Skip the initial sync that happens before server data is loaded
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = setTimeout(() => {
      fetch(`${API_BASE}/api/picks/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          picks: state.picks,
          mlbPicks: state.mlbPicks,
          wnbaPicks: state.wnbaPicks,
          nhlPicks: state.nhlPicks,
          bankroll: state.bankrollInitial,
          nextId: state.nextId,
        }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useAppContext must be used within AppProvider");
  return context;
}
