#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h18_prospective_deployability_audit as h18

MODEL = "R5H22_CALIBRATION_ROWSET_EXPORT"
SCHEMA = "courtedge-nfl-r5h22-calibration-rowset.v1"
FAMILY = "LATE_DOWN_CONVERSION"
CORE_ROUTE = "R5H8_CORE"
LATE_ROUTE = "R5H21_LATE_DOWN"

EXPECTED = {
    "combined": {"games": 211, "wins": 171, "losses": 40},
    CORE_ROUTE: {"games": 158, "wins": 125, "losses": 33},
    LATE_ROUTE: {"games": 53, "wins": 46, "losses": 7},
}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def metric_row(frame: pd.DataFrame) -> dict:
    games = int(len(frame))
    wins = int(frame.selected_win.sum()) if games else 0
    losses = games - wins
    return {
        "games": games,
        "wins": wins,
        "losses": losses,
        "accuracy": float(wins / games) if games else None,
    }


def assert_metric(label: str, got: dict, expected: dict) -> None:
    for key in ("games", "wins", "losses"):
        if int(got[key]) != int(expected[key]):
            raise RuntimeError(f"R5H22 {label} custody drifted: expected {expected}, got {got}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h15-dir", default="nfl-r5h15-output")
    ap.add_argument("--out-dir", default="nfl-r5h22-output")
    a = ap.parse_args()

    h15dir = Path(a.h15_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    predictions_path = h15dir / "nfl_r5h15_predictions.parquet"
    config_path = h15dir / "nfl_r5h15_config_by_season.csv"
    if not predictions_path.exists() or not config_path.exists():
        raise RuntimeError("R5H22 missing frozen H15 custody inputs")

    df = pd.read_parquet(predictions_path).reset_index(drop=True)
    cfg = pd.read_csv(config_path)

    support_col = f"support_score__{FAMILY}"
    prob_col = f"p__{FAMILY}"
    required = [
        "game_id", "season", "week", "y", "ref_p", "core_selected",
        support_col, prob_col,
    ]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise RuntimeError(f"R5H22 missing required H15 columns: {missing}")

    if df.game_id.astype(str).duplicated().any():
        raise RuntimeError("R5H22 H15 source contains duplicate game_id rows")
    if not set(pd.to_numeric(df.y, errors="coerce").dropna().astype(int).unique()).issubset({0, 1}):
        raise RuntimeError("R5H22 y must remain a binary completed-game outcome")

    core = df.core_selected.astype(bool).to_numpy()
    late = h18.threshold_only_mask(df, cfg)
    if np.any(core & late):
        raise RuntimeError("R5H22 route overlap detected; late-down must remain non-core")
    selected = core | late

    # Selection is frozen before the calibration target is read. y is used only below as
    # the supervised calibration/evaluation target and never to create either route.
    correct = r5h6.correctness(df).astype(int)
    ref_p = df.ref_p.to_numpy(dtype=float)
    ref_conf = np.maximum(ref_p, 1.0 - ref_p)

    ix = np.flatnonzero(selected)
    rows = df.loc[ix, ["game_id", "season", "week", "y", "ref_p", "core_selected", prob_col, support_col]].copy()
    rows["route"] = np.where(core[ix], CORE_ROUTE, LATE_ROUTE)
    rows["selected_side"] = np.where(ref_p[ix] >= 0.5, "HOME", "AWAY")
    rows["reference_confidence"] = ref_conf[ix]
    rows["selected_win"] = correct[ix]

    # Preserve R5H8 strength diagnostics when present without making them part of the
    # calibration contract yet. The next stage must freeze its scoring hypothesis before
    # inspecting calibration results.
    for source_col, target_col in (
        ("interaction_score", "r5h8_interaction_score"),
        ("threshold_ratio", "r5h8_threshold_ratio"),
        ("confidence_score", "r5h8_reference_confidence_score"),
    ):
        if source_col in df.columns:
            rows[target_col] = df.loc[ix, source_col].to_numpy()

    rows = rows.sort_values(["season", "week", "game_id"], kind="stable").reset_index(drop=True)

    combined_metrics = metric_row(rows)
    core_metrics = metric_row(rows[rows.route.eq(CORE_ROUTE)])
    late_metrics = metric_row(rows[rows.route.eq(LATE_ROUTE)])
    assert_metric("combined", combined_metrics, EXPECTED["combined"])
    assert_metric(CORE_ROUTE, core_metrics, EXPECTED[CORE_ROUTE])
    assert_metric(LATE_ROUTE, late_metrics, EXPECTED[LATE_ROUTE])

    if rows.game_id.duplicated().any():
        raise RuntimeError("R5H22 combined calibration rowset contains duplicate games")
    if int(rows.route.isna().sum()) != 0:
        raise RuntimeError("R5H22 calibration rowset contains an unlabeled route")
    if set(rows.route.unique()) != {CORE_ROUTE, LATE_ROUTE}:
        raise RuntimeError(f"R5H22 unexpected route labels: {sorted(rows.route.unique())}")

    by_season = []
    for (season, route), g in rows.groupby(["season", "route"], sort=True):
        by_season.append({"season": int(season), "route": str(route), **metric_row(g)})
    by_season_df = pd.DataFrame(by_season)

    rowset_path = out / "nfl_r5h22_calibration_rowset.csv"
    by_season_path = out / "nfl_r5h22_calibration_by_season.csv"
    rows.to_csv(rowset_path, index=False)
    by_season_df.to_csv(by_season_path, index=False)

    manifest = {
        "schemaVersion": SCHEMA,
        "stage": MODEL,
        "sport": "NFL",
        "researchOnly": True,
        "source": "frozen R5H15 predictions/config; R5H18 threshold-only deployment semantics",
        "routes": [CORE_ROUTE, LATE_ROUTE],
        "selectionPolicy": {
            CORE_ROUTE: "FROZEN_R5H8_CORE_SELECTED",
            LATE_ROUTE: "R5H18_THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
        },
        "calibrationTarget": "selected_win",
        "targetDefinition": "1 iff the frozen R5B2 reference direction equals completed-game y",
        "rowCount": int(len(rows)),
        "uniqueGameCount": int(rows.game_id.nunique()),
        "sourceCustody": {
            "h15PredictionsSha256": file_sha256(predictions_path),
            "h15ConfigSha256": file_sha256(config_path),
        },
        "outputCustody": {
            "rowsetSha256": file_sha256(rowset_path),
            "bySeasonSha256": file_sha256(by_season_path),
        },
        "safety": {
            "marketDataUsedToSelectRows": False,
            "sameGameOutcomeUsedToSelectRows": False,
            "targetOutcomeUsedOnlyAsCalibrationLabel": True,
            "futureSeasonDataUsedToSelectRows": False,
            "crossSportPoolingPerformed": False,
            "calibrationModelFitPerformed": False,
            "globalEliteRankingPerformed": False,
            "productionCodeTouched": False,
            "automaticBetPlacement": False,
        },
    }
    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "combined": combined_metrics,
        "routes": {
            CORE_ROUTE: core_metrics,
            LATE_ROUTE: late_metrics,
        },
        "seasons": sorted(int(v) for v in rows.season.unique()),
        "rowsetSha256": manifest["outputCustody"]["rowsetSha256"],
        "allCustodyAssertionsPass": True,
        "crossSportCalibrationStillBlocked": True,
        "globalEliteRankerStillBlocked": True,
        "nextAction": "FREEZE_ROUTE_SPECIFIC_WALK_FORWARD_CALIBRATION_CONTRACT_BEFORE_FITTING",
    }
    audit = {
        "combinedCustody": "PASS_211_GAMES_171_40",
        "r5h8CoreCustody": "PASS_158_GAMES_125_33",
        "r5h21LateDownCustody": "PASS_53_GAMES_46_7",
        "routeOverlap": "PASS_ZERO",
        "uniqueGameIds": "PASS_211",
        "outcomeSelectionBoundary": "PASS_Y_NOT_USED_TO_CREATE_SELECTION_MASK",
        "marketBoundary": "PASS_MARKET_FREE_SELECTION",
        "calibrationFit": "NOT_RUN_BY_R5H22_ROWSET_EXPORT",
        "crossSportPooling": "NOT_ALLOWED",
        "productionCodeTouched": False,
    }

    (out / "nfl_r5h22_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h22_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h22_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H22_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H22_BY_SEASON")
    print(by_season_df.to_string(index=False))
    print("NFL_R5H22_COMPLETE")


if __name__ == "__main__":
    main()
