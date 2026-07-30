import "./staging-entry";
import { app } from "./index";
import { getMlbLedgerStore } from "./mlb-ledger";
import { startMlbShadowCollectionWorker } from "./mlb-shadow-collection-worker";

const shadowCollection = startMlbShadowCollectionWorker(getMlbLedgerStore());

app.get("/api/mlb/ledger/v1/shadow-collection/status", (_req, res) => {
  res.json({ success: true, data: shadowCollection.service.status() });
});

app.get("/api/mlb/ledger/v1/shadow-collection/latest", (_req, res) => {
  const latest = shadowCollection.service.readLatest();
  if (!latest) {
    res.status(404).json({
      success: false,
      error: "No S5B shadow collection has completed yet",
    });
    return;
  }
  res.json({ success: true, data: latest });
});
