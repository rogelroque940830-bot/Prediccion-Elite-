import MLBPredictor from "@/pages/mlb-predictor";
import { MlbDailyOpportunityControl } from "@/components/mlb-daily-opportunity-control";

export default function MLBPredictorV16() {
  return (
    <>
      <MlbDailyOpportunityControl />
      <MLBPredictor />
    </>
  );
}
