#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CERT = ROOT / "research" / "mlb-unified-sporting-authority-r1b1-source-custody-semantic-parity.json"
PARENT_R1B = ROOT / "research" / "mlb-unified-sporting-authority-r1b-materialization-certification.json"
EXPECTED = (
    "V16_BASELINE",
    "FROZEN_ROUTE_EVIDENCE",
    "STATCAST_QUALITY",
    "DISCIPLINE_SPEED",
    "SOS",
    "ADVANCED_CONTEXT",
    "BULLPEN_FULL_GAME",
    "HAND_SPLIT_SLG_MATCHUP",
    "PITCHMIX_MATCHUP",
)
ALLOWED = {"PARITY_CERTIFIED", "PARTIAL_PARITY", "BLOCKED"}

def fail(msg):
    raise SystemExit("R1B1_VALIDATION_FAILED:" + msg)

data = json.loads(CERT.read_text(encoding="utf-8"))
if data.get("status") != "R1B1_AUDIT_COMPLETE_FAIL_CLOSED":
    fail("status")
rows = data.get("requiredFamilies")
if not isinstance(rows, list) or len(rows) != 9:
    fail("required_family_count")
names = tuple(row.get("family") for row in rows)
if names != EXPECTED:
    fail("required_family_order_or_drift")
if len(set(names)) != 9:
    fail("duplicate_family")
for row in rows:
    cls = row.get("classification")
    if cls not in ALLOWED:
        fail("invalid_classification:" + str(row.get("family")))
    if cls != "PARITY_CERTIFIED" and row.get("exactSemanticParity") is not False:
        fail("noncertified_family_claims_exact_parity:" + row["family"])
    if cls != "PARITY_CERTIFIED" and not row.get("requiredUnblock"):
        fail("missing_unblock_requirement:" + row["family"])
counts = {
    "PARITY_CERTIFIED": sum(r["classification"] == "PARITY_CERTIFIED" for r in rows),
    "PARTIAL_PARITY": sum(r["classification"] == "PARTIAL_PARITY" for r in rows),
    "BLOCKED": sum(r["classification"] == "BLOCKED" for r in rows),
}
summary = data.get("summary", {})
if summary.get("requiredFamilyCount") != 9:
    fail("summary_required_count")
if summary.get("parityCertified") != counts["PARITY_CERTIFIED"]:
    fail("summary_parity_count")
if summary.get("partialParity") != counts["PARTIAL_PARITY"]:
    fail("summary_partial_count")
if summary.get("blocked") != counts["BLOCKED"]:
    fail("summary_blocked_count")
all_certified = counts["PARITY_CERTIFIED"] == 9
if summary.get("allRequiredFamiliesParityCertified") is not all_certified:
    fail("all_certified_flag")
if summary.get("r1bHistoricalRowsetAuthorized") is not all_certified:
    fail("rowset_authorization_must_track_full_parity")
if summary.get("r1b2Authorized") is not all_certified:
    fail("r1b2_authorization_must_track_full_parity")
closure = data.get("closureDecision", {})
if closure.get("r1b1Closed") is not True:
    fail("closure_flag")
policy = data.get("policy", {})
for field in ("outcomesRead", "marketPricesRead", "modelRefit", "newWeightsCreated", "thresholdSearch", "productionChanged", "v16Changed", "v68Changed", "v80Changed", "frozenRoutesChanged", "automaticBetPlacement"):
    if policy.get(field) is not False:
        fail("policy:" + field)
if policy.get("realFinancialExposure") != 0:
    fail("real_financial_exposure")

parent = json.loads(PARENT_R1B.read_text(encoding="utf-8"))
link = parent.get("r1b1Certification", {})
if link.get("artifact") != "research/mlb-unified-sporting-authority-r1b1-source-custody-semantic-parity.json":
    fail("parent_artifact_link")
if link.get("status") != data.get("status"):
    fail("parent_status_drift")
if link.get("parityCertified") != counts["PARITY_CERTIFIED"]:
    fail("parent_parity_count_drift")
if link.get("partialParity") != counts["PARTIAL_PARITY"]:
    fail("parent_partial_count_drift")
if link.get("blocked") != counts["BLOCKED"]:
    fail("parent_blocked_count_drift")
if link.get("r1bHistoricalRowsetAuthorized") is not all_certified:
    fail("parent_rowset_authorization_drift")
if link.get("r1b2Authorized") is not all_certified:
    fail("parent_r1b2_authorization_drift")
if all_certified is False and parent.get("nextStep") != "REMEDIATE_R1B1_BLOCKED_AND_PARTIAL_FAMILIES_BEFORE_R1B2":
    fail("parent_next_step")

print(json.dumps({"status": "R1B1_CERTIFICATION_VALID", "counts": counts, "rowsetAuthorized": all_certified, "parentConsistent": True}, sort_keys=True))
