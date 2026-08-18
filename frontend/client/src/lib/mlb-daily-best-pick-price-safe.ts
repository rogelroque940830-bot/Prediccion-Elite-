import {
  parseMlbDailyBestPickPriceView,
  presentMlbDailyBestPickPrice,
  type MlbDailyBestPickPriceDisplay,
  type MlbDailyBestPickPriceView,
} from "./mlb-daily-best-pick-price";

function semanticPriceViewIsSafe(view: MlbDailyBestPickPriceView): boolean {
  if (view.decision === "ELITE_EVIDENCE_CANDIDATE") {
    return view.pick !== null
      && view.execution !== null
      && view.economics !== null
      && typeof view.economics.expectedValuePerUnit === "number"
      && Number.isFinite(view.economics.expectedValuePerUnit)
      && view.economics.expectedValuePerUnit > 0
      && view.blockers.length === 0;
  }
  if (view.decision === "NO_POSITIVE_EV") {
    return view.pick !== null
      && view.execution !== null
      && view.economics !== null
      && typeof view.economics.expectedValuePerUnit === "number"
      && Number.isFinite(view.economics.expectedValuePerUnit)
      && view.economics.expectedValuePerUnit <= 0;
  }
  if (view.decision === "POSITIVE_EV_ENVELOPE_BLOCKED") {
    return view.pick !== null
      && view.execution !== null
      && view.economics !== null
      && typeof view.economics.expectedValuePerUnit === "number"
      && Number.isFinite(view.economics.expectedValuePerUnit)
      && view.economics.expectedValuePerUnit > 0;
  }
  return true;
}

export function presentMlbDailyBestPickPriceFailClosed(value: unknown): MlbDailyBestPickPriceDisplay {
  const parsed = parseMlbDailyBestPickPriceView(value);
  if (!parsed || !semanticPriceViewIsSafe(parsed)) return presentMlbDailyBestPickPrice(null);
  return presentMlbDailyBestPickPrice(parsed);
}
