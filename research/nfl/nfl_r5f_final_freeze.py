#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


CANDIDATE = "R5B2_HICONF_SWITCH"
REFERENCE = "B4_PROXY_OA"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def bool_col(df: pd.DataFrame, col: str) -> pd.Series:
    if col not in df:
        raise RuntimeError(f"missing required column {col}")
    s = df[col]
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().map({"true": True, "false": False}).fillna(False)


def stage_summary(name: str, path: Path) -> dict:
    df = pd.read_csv(path)
    if df.empty:
        raise RuntimeError(f"{name} bootstrap is empty: {path}")
    better = bool_col(df, "better95")
    worse = bool_col(df, "worse95")
    rows = []
    for i, r in df.iterrows():
        rows.append(
            {
                "comparison": str(r["comparison"]),
                "meanLogLossDelta": float(r["mean_logloss_delta"]),
                "ci95Low": float(r["ci95_low"]),
                "ci95High": float(r["ci95_high"]),
                "better95": bool(better.iloc[i]),
                "worse95": bool(worse.iloc[i]),
            }
        )
    return {
        "stage": name,
        "anyBetter95": bool(better.any()),
        "anyWorse95": bool(worse.any()),
        "comparisons": rows,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r5b-cert-dir", default="nfl-r5b-cert-output")
    ap.add_argument("--r5c-dir", default="nfl-r5c-output")
    ap.add_argument("--r5c2-dir", default="nfl-r5c2-output")
    ap.add_argument("--r5d-dir", default="nfl-r5d-output")
    ap.add_argument("--r5e-dir", default="nfl-r5e-output")
    ap.add_argument("--out-dir", default="nfl-r5f-output")
    a = ap.parse_args()

    bdir = Path(a.r5b_cert_dir)
    cdir = Path(a.r5c_dir)
    c2dir = Path(a.r5c2_dir)
    ddir = Path(a.r5d_dir)
    edir = Path(a.r5e_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    cert = load_json(bdir / "nfl_r5b_cert_verdict.json")
    if cert.get("candidate") != CANDIDATE:
        raise RuntimeError(f"unexpected certified candidate: {cert.get('candidate')}")
    if cert.get("reference") != REFERENCE:
        raise RuntimeError(f"unexpected certified reference: {cert.get('reference')}")
    if cert.get("coreCertificationConditionsPass") is not True:
        raise RuntimeError("R5B2 core certification did not pass")
    if cert.get("modelChangedDuringCertification") is not False:
        raise RuntimeError("R5B certification changed the model")

    c_manifest = load_json(cdir / "nfl_r5c_manifest.json")
    c_audit = load_json(cdir / "nfl_r5c_audit.json")
    c2_manifest = load_json(c2dir / "nfl_r5c2_manifest.json")
    c2_audit = load_json(c2dir / "nfl_r5c2_audit.json")
    d_manifest = load_json(ddir / "nfl_r5d_manifest.json")
    d_audit = load_json(ddir / "nfl_r5d_audit.json")
    e_manifest = load_json(edir / "nfl_r5e_manifest.json")
    e_audit = load_json(edir / "nfl_r5e_audit.json")

    # R5F is a freeze/handoff stage, not another adaptive model search.
    # It may summarize completed experiments, but it never adds a block
    # automatically from retrospective outcomes.
    for label, manifest in [
        ("R5C", c_manifest),
        ("R5C2", c2_manifest),
        ("R5D", d_manifest),
        ("R5E", e_manifest),
    ]:
        if manifest.get("researchOnly") is not True:
            raise RuntimeError(f"{label} researchOnly boundary failed")
        if manifest.get("marketDataUsedAsFeatures") is not False:
            raise RuntimeError(f"{label} market feature boundary failed")

    if c_audit.get("marketLeakageCheck") != "PASS":
        raise RuntimeError("R5C market leakage audit failed")
    if c2_audit.get("marketLeakageCheck") != "PASS":
        raise RuntimeError("R5C2 market leakage audit failed")
    if d_audit.get("marketLeakageCheck") != "PASS":
        raise RuntimeError("R5D market leakage audit failed")
    if e_audit.get("marketLeakageCheck") != "PASS":
        raise RuntimeError("R5E market leakage audit failed")

    c = stage_summary("R5C_PERSONNEL_AVAILABILITY", cdir / "nfl_r5c_bootstrap.csv")
    c2 = stage_summary("R5C2_PERSONNEL_SHOCKS", c2dir / "nfl_r5c2_bootstrap.csv")
    d = stage_summary("R5D_WEATHER_VENUE", ddir / "nfl_r5d_bootstrap.csv")
    e = stage_summary("R5E_NEXTGEN_STATS", edir / "nfl_r5e_bootstrap.csv")
    evidence = [c, c2, d, e]

    if d_manifest.get("observedWeatherPromotionEligible") is not False:
        raise RuntimeError("observed weather must remain ineligible for promotion")
    if d_manifest.get("weatherPromotionRequiresArchivedOrProspectivePregameForecast") is not True:
        raise RuntimeError("weather forecast custody requirement missing")
    if d_audit.get("postHocWeatherPromotion") != "FORBIDDEN":
        raise RuntimeError("post-hoc weather promotion must be forbidden")
    if e_manifest.get("targetWeekNGSUsedAsFeature") is not False:
        raise RuntimeError("target-week NGS leakage guard failed")
    if e_manifest.get("weekZeroSeasonSummaryUsed") is not False:
        raise RuntimeError("week-zero NGS summary must be forbidden")
    if e_audit.get("postHocFeatureBlockSelection") != "NONE":
        raise RuntimeError("R5E post-hoc feature-block selection detected")

    verdict = {
        "schemaVersion": "courtedge-nfl-r5f-final-freeze.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "modelChangedDuringR5F": False,
        "historicalSearchEnded": True,
        "freezeRole": "RETROSPECTIVE_FREEZE_AND_PROSPECTIVE_HANDOFF",
        "frozenHistoricalCandidate": CANDIDATE,
        "frozenReference": REFERENCE,
        "candidateSource": "R5B2_FINAL_CERTIFICATION",
        "r5bCoreCertificationPass": True,
        "retrospectiveBlocksAddedByR5F": [],
        "retrospectiveBlockPolicy": "NO_AUTOMATIC_POST_HOC_PROMOTION; each new block requires an independent predeclared certification before model incorporation",
        "evidenceSummary": evidence,
        "nonPromotedBlocks": {
            "R5C_PERSONNEL_AVAILABILITY": "NO_INDEPENDENT_PROMOTION; primary comparisons do not show 95% log-loss improvement over frozen R5B2 reference",
            "R5C2_PERSONNEL_SHOCKS": "NO_INDEPENDENT_PROMOTION; no 95% improvement and defensive-shock variant is significantly worse",
            "R5D_WEATHER_VENUE": "NO_INDEPENDENT_PROMOTION; venue variants do not show 95% improvement; observed weather is diagnostic-only and historically ineligible",
            "R5E_NEXTGEN_STATS": "NO_INDEPENDENT_PROMOTION; no NGS block shows 95% improvement; receiving/all contain significant worsening and immutable publication custody is not claimed",
        },
        "prospective2026": {
            "season": 2026,
            "mode": "SHADOW_ONLY",
            "frozenCandidate": CANDIDATE,
            "frozenReference": REFERENCE,
            "pregameCutoffPolicy": "UTC midnight at start of target gameday; target-gameday depth/injury updates excluded",
            "targetGameOutcomeUsedBeforePrediction": False,
            "marketInputsAllowed": False,
            "modelRefitDuringShadow": False,
            "featureSearchDuringShadow": False,
            "thresholdTuningDuringShadow": False,
            "interimReview": "AFTER_8_COMPLETED_REGULAR_SEASON_WEEKS; diagnostics only; no model changes",
            "primaryReview": "AFTER_2026_REGULAR_SEASON_COMPLETE",
            "primaryMetrics": ["log_loss", "brier"],
            "secondaryMetrics": ["accuracy", "margin_mae", "total_mae"],
            "productionPromotionAutomatic": False,
            "productionPromotionRequiresSeparatePR": True,
        },
        "decision": "FREEZE_R5B2_HICONF_SWITCH_FOR_2026_PROSPECTIVE_SHADOW",
    }

    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "postHocModelMutation": "PASS_NONE",
        "r5bCertification": "PASS",
        "personnelPromotion": "NOT_PROMOTED",
        "weatherPromotion": "NOT_PROMOTED",
        "ngsPromotion": "NOT_PROMOTED",
        "prospectiveHandoff": "READY_FOR_2026_SHADOW",
    }

    with (out / "nfl_r5f_final_freeze.json").open("w", encoding="utf-8") as f:
        json.dump(verdict, f, indent=2, sort_keys=True)
        f.write("\n")
    with (out / "nfl_r5f_audit.json").open("w", encoding="utf-8") as f:
        json.dump(audit, f, indent=2, sort_keys=True)
        f.write("\n")

    rows = []
    for s in evidence:
        for r in s["comparisons"]:
            rows.append({"stage": s["stage"], **r})
    pd.DataFrame(rows).to_csv(out / "nfl_r5f_evidence_matrix.csv", index=False)

    print("NFL_R5F_FINAL_FREEZE")
    print(json.dumps(verdict, indent=2, sort_keys=True))
    print("NFL_R5F_COMPLETE")


if __name__ == "__main__":
    main()
