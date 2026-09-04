#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h8_interaction_contradiction_engine as r5h8
import nfl_r5h10_marginal_geometry_expansion as r5h10
import nfl_r5h11_local_multi_prototype_expansion as r5h11

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H12_PROTOTYPE_SPECIFIC_ACCEPTANCE"
SEED = 940830

R5H8_ACC = 0.7911392405063291
R5H8_COVERAGE = 0.07463391591875296
R5H10_ACC = 0.7904191616766467
R5H10_COVERAGE = 0.07888521492678319
R5H11_ACC = 0.7894736842105263
R5H11_COVERAGE = 0.0807746811525744
R5H4_ACC = 0.7726161369193154

WIN_PROTOTYPES = (2, 3, 4)
LOSS_PROTOTYPES = (1, 2, 3)
DISTANCE_ALPHA = (0.0, 0.15, 0.30)
BAND_LOW = (0.60, 0.65, 0.70, 0.80)
AGREEMENT_FLOOR = (0.70, 0.80)
SYNERGY_FLOOR = (0.00, 0.05)
REDUNDANCY_CAP = (0.15, 0.25, 0.35)
BASE_QUANTILE = (0.35, 0.50, 0.65, 0.75)
RELIABILITY_BETA = (0.50, 1.00, 1.50)
SHRINK_TAU = (6.0, 12.0)
MIN_PROTO_RELIABILITY = (0.64, 0.68, 0.72)
VALIDATION_SEASONS = 2
MIN_FIT_CORE_WINS = 28
MIN_FIT_CORE_LOSSES = 8
MIN_PROTO_POOL = 4
MIN_VALIDATION_MARGINAL = 8
MIN_VALIDATION_PER_SEASON = 2
MAX_TARGET_ADD_RATE = 0.08
Q_MIN = 0.15
Q_MAX = 0.90


def anchored_refit_template(hist: pd.DataFrame, rules: list[str], initial_tpl: dict) -> dict | None:
    core = hist[hist.core_selected.astype(bool)].copy()
    if core.empty:
        return None
    correct = r5h6.correctness(core)
    wins = core[correct].copy()
    losses = core[~correct].copy()
    kw = int(initial_tpl["k_win"])
    kl = int(initial_tpl["k_loss"])
    if len(wins) < max(MIN_FIT_CORE_WINS, kw * 5):
        return None
    if len(losses) < max(MIN_FIT_CORE_LOSSES, kl * 3):
        return None

    med = initial_tpl["median"]
    scale = initial_tpl["scale"]
    Xw = (r5h10.geometry_matrix(wins, rules) - med) / scale
    Xl = (r5h10.geometry_matrix(losses, rules) - med) / scale

    kmw = KMeans(
        n_clusters=kw,
        init=np.asarray(initial_tpl["win_centers"], dtype=float),
        n_init=1,
        random_state=SEED,
    ).fit(Xw)
    kml = KMeans(
        n_clusters=kl,
        init=np.asarray(initial_tpl["loss_centers"], dtype=float),
        n_init=1,
        random_state=SEED + 11,
    ).fit(Xl)
    return {
        "median": med,
        "scale": scale,
        "win_centers": kmw.cluster_centers_,
        "loss_centers": kml.cluster_centers_,
        "win_counts": np.bincount(kmw.labels_, minlength=kw),
        "loss_counts": np.bincount(kml.labels_, minlength=kl),
        "dim_weight": initial_tpl["dim_weight"],
        "fit_core_wins": int(len(wins)),
        "fit_core_losses": int(len(losses)),
        "k_win": kw,
        "k_loss": kl,
    }


def calibrate_prototypes(
    df: pd.DataFrame,
    score: np.ndarray,
    win_proto: np.ndarray,
    base_mask: np.ndarray,
    core_accuracy: float,
    cfg: dict,
) -> tuple[np.ndarray, list[dict]]:
    selected = np.zeros(len(df), dtype=bool)
    rows: list[dict] = []
    correct = r5h6.correctness(df)
    for p in range(int(cfg["k_win"])):
        pool = base_mask & np.isfinite(score) & (win_proto == p)
        n = int(pool.sum())
        if n < MIN_PROTO_POOL:
            rows.append({
                "prototype_id": int(p), "candidate_pool": n, "enabled": False,
                "reason": "INSUFFICIENT_PROTO_POOL",
            })
            continue
        wins = int(correct[pool].sum())
        empirical = float(wins / n)
        tau = float(cfg["shrink_tau"])
        smoothed = float((wins + tau * core_accuracy) / (n + tau))
        q = float(np.clip(
            float(cfg["base_quantile"]) + float(cfg["reliability_beta"]) * (core_accuracy - smoothed),
            Q_MIN,
            Q_MAX,
        ))
        vals = score[pool]
        thr = float(np.quantile(vals, q))
        enabled = bool(smoothed >= float(cfg["min_proto_reliability"]))
        take = pool & (score >= thr) if enabled else np.zeros(len(df), dtype=bool)
        selected |= take
        tm = r5h6.metrics(df, take)
        rows.append({
            "prototype_id": int(p),
            "candidate_pool": n,
            "candidate_wins": wins,
            "candidate_empirical_accuracy": empirical,
            "smoothed_reliability": smoothed,
            "acceptance_quantile": q,
            "acceptance_threshold": thr,
            "enabled": enabled,
            "selected_games": tm["games"],
            "selected_accuracy": tm["accuracy"],
        })
    return selected, rows


def matched_control(df: pd.DataFrame, selected: np.ndarray, base_cfg: pd.DataFrame) -> tuple[np.ndarray, float]:
    out = np.zeros(len(df), dtype=bool)
    pos = pd.Series(np.arange(len(df)), index=df.index)
    for y, g in df.groupby("season"):
        row = base_cfg[base_cfg.test_season == int(y)]
        if row.empty:
            continue
        r = row.iloc[0]
        edges = r5h8.decode_edges(r.bin_edges)
        floor = float(r.confidence_floor)
        local_sel = selected[pos.loc[g.index].to_numpy(dtype=int)]
        m = r5h6.matched_confidence_within_bins(g, local_sel, edges, floor)
        out[pos.loc[g.index].to_numpy(dtype=int)] = m
    mm = r5h6.metrics(df, out)
    return out, float(mm["accuracy"]) if mm["games"] else float("nan")


def choose_config(fit: pd.DataFrame, val: pd.DataFrame, rules: list[str], base_cfg: pd.DataFrame):
    core_val = val.core_selected.to_numpy(dtype=bool)
    core_m = r5h6.metrics(val, core_val)
    if core_m["games"] <= 0:
        return None, pd.DataFrame()

    best = None
    rows = []
    for kw in WIN_PROTOTYPES:
        for kl in LOSS_PROTOTYPES:
            tpl = r5h11.fit_template(fit, rules, kw, kl)
            if tpl is None:
                continue
            for alpha in DISTANCE_ALPHA:
                score, _, _, wpid, _ = r5h11.score_local_geometry(val, rules, tpl, alpha)
                for band in BAND_LOW:
                    for af in AGREEMENT_FLOOR:
                        for sf in SYNERGY_FLOOR:
                            for rc in REDUNDANCY_CAP:
                                base_cfg0 = {
                                    "k_win": int(kw), "k_loss": int(kl), "distance_alpha": float(alpha),
                                    "band_low": float(band), "agreement_floor": float(af),
                                    "synergy_floor": float(sf), "redundancy_cap": float(rc),
                                }
                                bm = r5h11.base_mask(val, base_cfg0)
                                if int(bm.sum()) < MIN_VALIDATION_MARGINAL:
                                    continue
                                for bq in BASE_QUANTILE:
                                    for beta in RELIABILITY_BETA:
                                        for tau in SHRINK_TAU:
                                            for min_rel in MIN_PROTO_RELIABILITY:
                                                cfg = {
                                                    **base_cfg0,
                                                    "base_quantile": float(bq),
                                                    "reliability_beta": float(beta),
                                                    "shrink_tau": float(tau),
                                                    "min_proto_reliability": float(min_rel),
                                                }
                                                marg, proto = calibrate_prototypes(
                                                    val, score, wpid, bm, core_m["accuracy"], cfg
                                                )
                                                mm = r5h6.metrics(val, marg)
                                                if mm["games"] < MIN_VALIDATION_MARGINAL:
                                                    continue
                                                combined = core_val | marg
                                                cm = r5h6.metrics(val, combined)

                                                annual_combined = []
                                                annual_marg = []
                                                valid = True
                                                for _, g in val.groupby("season"):
                                                    loc = val.index.get_indexer(g.index)
                                                    lm = marg[loc]
                                                    lc = combined[loc]
                                                    if int(lm.sum()) < MIN_VALIDATION_PER_SEASON:
                                                        valid = False
                                                        break
                                                    gm = r5h6.metrics(g, lm)
                                                    gc = r5h6.metrics(g, lc)
                                                    annual_marg.append(gm["accuracy"])
                                                    annual_combined.append(gc["accuracy"])
                                                if not valid:
                                                    continue

                                                _, matched_acc = matched_control(val, combined, base_cfg)
                                                md = float(cm["accuracy"] - matched_acc) if np.isfinite(matched_acc) else -1.0
                                                min_combined = float(min(annual_combined))
                                                min_marg = float(min(annual_marg))
                                                preserve = bool(
                                                    mm["accuracy"] >= max(0.75, core_m["accuracy"] - 0.02)
                                                    and cm["accuracy"] >= core_m["accuracy"] - 0.005
                                                )
                                                stable = bool(min_combined >= 0.70 and min_marg >= 0.60)
                                                delta_gate = bool(md >= 0.0)
                                                row = {
                                                    **cfg,
                                                    "validation_core_games": core_m["games"],
                                                    "validation_core_accuracy": core_m["accuracy"],
                                                    "validation_marginal_games": mm["games"],
                                                    "validation_marginal_accuracy": mm["accuracy"],
                                                    "validation_marginal_wilson95_lower": mm["wilson95_lower"],
                                                    "validation_combined_games": cm["games"],
                                                    "validation_combined_accuracy": cm["accuracy"],
                                                    "validation_matched_conf_accuracy": matched_acc,
                                                    "validation_delta_vs_matched_conf": md,
                                                    "validation_min_combined_season_accuracy": min_combined,
                                                    "validation_min_marginal_season_accuracy": min_marg,
                                                    "enabled_prototypes": int(sum(bool(r.get("enabled", False)) for r in proto)),
                                                    "preserve_gate": preserve,
                                                    "stability_gate": stable,
                                                    "matched_delta_gate": delta_gate,
                                                }
                                                rows.append(row)
                                                key = (
                                                    int(preserve), int(stable), int(delta_gate),
                                                    min_combined,
                                                    cm["accuracy"],
                                                    md,
                                                    mm["accuracy"],
                                                    mm["wilson95_lower"],
                                                    mm["games"],
                                                    -kw, -kl,
                                                )
                                                if best is None or key > best[0]:
                                                    best = (key, row, tpl)
    if best is None or not best[1]["preserve_gate"]:
        return None, pd.DataFrame(rows)
    return {**best[1], "fit_template": best[2]}, pd.DataFrame(rows)


def apply_target_with_cap(
    te: pd.DataFrame,
    score: np.ndarray,
    win_proto: np.ndarray,
    base_mask: np.ndarray,
    calibrations: list[dict],
) -> np.ndarray:
    add = np.zeros(len(te), dtype=bool)
    for row in calibrations:
        if not bool(row.get("enabled", False)):
            continue
        p = int(row["prototype_id"])
        thr = float(row["acceptance_threshold"])
        add |= base_mask & (win_proto == p) & np.isfinite(score) & (score >= thr)

    cap = max(1, int(np.floor(MAX_TARGET_ADD_RATE * len(te))))
    ix = np.flatnonzero(add)
    if len(ix) > cap:
        # Rank within prototype by excess above that prototype's threshold.
        thr_map = {int(r["prototype_id"]): float(r.get("acceptance_threshold", np.inf)) for r in calibrations}
        excess = np.asarray([
            score[i] - thr_map.get(int(win_proto[i]), np.inf) for i in ix
        ], dtype=float)
        keep = ix[np.argsort(-excess, kind="stable")[:cap]]
        add[:] = False
        add[keep] = True
    return add


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h12-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out = Path(a.input_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()

    blocks = r5h3.expanded_rule_blocks()
    rules = list(blocks)
    r5h.rule_blocks = r5h3.expanded_rule_blocks
    experts, _ = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ref = r5h4.reference_oos(x, a.expert_oos_start, a.end_season)
    meta = experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")

    base, base_cfg = r5h10.build_r5h8_base(meta, rules, a.test_start, a.end_season)
    base["local_geometry_score"] = np.nan
    base["local_distance_win"] = np.nan
    base["local_distance_loss"] = np.nan
    base["nearest_win_prototype"] = -1
    base["nearest_loss_prototype"] = -1
    base["prototype_threshold"] = np.nan
    base["prototype_reliability"] = np.nan
    base["marginal_selected"] = 0
    base["selected"] = base.core_selected.astype(int)

    cfg_rows, search_rows, calibration_rows, proto_rows = [], [], [], []

    for y in range(a.test_start, a.end_season + 1):
        iy = base.season.to_numpy(dtype=int) == y
        hist = base[base.season < y].copy()
        te = base[iy].copy()
        if te.empty:
            continue
        years = sorted(int(v) for v in hist.season.unique())
        if len(years) < VALIDATION_SEASONS + 1:
            cfg_rows.append({"test_season": int(y), "calibration_ready": False, "reason": "INSUFFICIENT_PRIOR_SEASONS"})
            continue

        val_years = years[-VALIDATION_SEASONS:]
        fit = hist[~hist.season.isin(val_years)].copy()
        val = hist[hist.season.isin(val_years)].copy()
        chosen, search = choose_config(fit, val, rules, base_cfg)
        if search is not None and not search.empty:
            search["test_season"] = int(y)
            search_rows.append(search)
        if chosen is None:
            cfg_rows.append({
                "test_season": int(y), "calibration_ready": False,
                "reason": "NO_VALIDATED_PROTOTYPE_SPECIFIC_CONFIGURATION",
                "validation_seasons": json.dumps(val_years),
            })
            continue

        initial_tpl = chosen.pop("fit_template")
        tpl = anchored_refit_template(hist, rules, initial_tpl)
        if tpl is None:
            cfg_rows.append({"test_season": int(y), "calibration_ready": False, "reason": "ANCHORED_REFIT_FAILED"})
            continue
        proto_rows.extend(r5h11.prototype_rows(tpl, rules, y))

        hs, hdw, hdl, hwp, hlp = r5h11.score_local_geometry(
            hist, rules, tpl, float(chosen["distance_alpha"])
        )
        hbm = r5h11.base_mask(hist, chosen)
        core_hist = r5h6.metrics(hist, hist.core_selected.to_numpy(dtype=bool))
        _, cal = calibrate_prototypes(hist, hs, hwp, hbm, core_hist["accuracy"], chosen)
        enabled = [r for r in cal if bool(r.get("enabled", False))]
        if not enabled:
            cfg_rows.append({"test_season": int(y), "calibration_ready": False, "reason": "NO_ENABLED_REFIT_PROTOTYPES"})
            continue

        for r in cal:
            calibration_rows.append({"test_season": int(y), **r})

        ts, tdw, tdl, twp, tlp = r5h11.score_local_geometry(
            te, rules, tpl, float(chosen["distance_alpha"])
        )
        tbm = r5h11.base_mask(te, chosen)
        add = apply_target_with_cap(te, ts, twp, tbm, cal)

        target_ix = base.index[iy]
        base.loc[target_ix, "local_geometry_score"] = ts
        base.loc[target_ix, "local_distance_win"] = tdw
        base.loc[target_ix, "local_distance_loss"] = tdl
        base.loc[target_ix, "nearest_win_prototype"] = twp
        base.loc[target_ix, "nearest_loss_prototype"] = tlp

        thr_map = {int(r["prototype_id"]): float(r.get("acceptance_threshold", np.nan)) for r in cal}
        rel_map = {int(r["prototype_id"]): float(r.get("smoothed_reliability", np.nan)) for r in cal}
        base.loc[target_ix, "prototype_threshold"] = [thr_map.get(int(p), np.nan) for p in twp]
        base.loc[target_ix, "prototype_reliability"] = [rel_map.get(int(p), np.nan) for p in twp]
        base.loc[target_ix, "marginal_selected"] = add.astype(int)
        base.loc[target_ix, "selected"] = (te.core_selected.to_numpy(dtype=bool) | add).astype(int)

        cfg_rows.append({
            "test_season": int(y),
            "calibration_ready": True,
            "validation_seasons": json.dumps(val_years),
            "fit_core_wins": int(tpl["fit_core_wins"]),
            "fit_core_losses": int(tpl["fit_core_losses"]),
            "target_marginal_added": int(add.sum()),
            "enabled_refit_prototypes": int(len(enabled)),
            **chosen,
        })

    base["confidence_control_matched"] = 0
    for y, g in base.groupby("season"):
        row = base_cfg[base_cfg.test_season == int(y)]
        if row.empty:
            continue
        r = row.iloc[0]
        edges = r5h8.decode_edges(r.bin_edges)
        floor = float(r.confidence_floor)
        candidate = g.selected.to_numpy(dtype=bool)
        matched = r5h6.matched_confidence_within_bins(g, candidate, edges, floor)
        base.loc[g.index, "confidence_control_matched"] = matched.astype(int)

    sel = base.selected.to_numpy(dtype=bool)
    core = base.core_selected.to_numpy(dtype=bool)
    marg = base.marginal_selected.to_numpy(dtype=bool)
    matched = base.confidence_control_matched.to_numpy(dtype=bool)
    sm = r5h6.metrics(base, sel)
    corem = r5h6.metrics(base, core)
    mm = r5h6.metrics(base, marg)
    cm = r5h6.metrics(base, matched)
    boot = r5h6.bootstrap_difference(base, "selected", "confidence_control_matched")

    by = []
    for y, g in base.groupby("season"):
        a1 = r5h6.metrics(g, g.selected.to_numpy(dtype=bool))
        c1 = r5h6.metrics(g, g.core_selected.to_numpy(dtype=bool))
        m1 = r5h6.metrics(g, g.marginal_selected.to_numpy(dtype=bool))
        b1 = r5h6.metrics(g, g.confidence_control_matched.to_numpy(dtype=bool))
        by.append({
            "season": int(y),
            "selected_games": a1["games"], "selected_accuracy": a1["accuracy"],
            "core_games": c1["games"], "core_accuracy": c1["accuracy"],
            "marginal_games": m1["games"], "marginal_accuracy": m1["accuracy"],
            "matched_conf_games": b1["games"], "matched_conf_accuracy": b1["accuracy"],
            "delta_vs_matched_conf": float(a1["accuracy"] - b1["accuracy"]) if b1["games"] else np.nan,
        })
    bydf = pd.DataFrame(by)
    positive = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative = int((bydf.delta_vs_matched_conf >= 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(base)),
        "selectedGames": sm["games"], "selectedWins": sm["wins"], "selectedLosses": sm["losses"],
        "selectedAccuracy": sm["accuracy"], "selectedCoverage": float(sm["games"] / len(base)),
        "selectedWilson95Lower": sm["wilson95_lower"],
        "r5h8CoreGames": corem["games"], "r5h8CoreAccuracyReproduced": corem["accuracy"],
        "marginalAddedGames": mm["games"], "marginalAddedWins": mm["wins"],
        "marginalAddedLosses": mm["losses"], "marginalAddedAccuracy": mm["accuracy"],
        "matchedConfidenceControlGames": cm["games"],
        "matchedConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsMatchedConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsMatchedConfidence": boot,
        "positiveOuterSeasonsVsMatchedConfidence": positive,
        "nonnegativeOuterSeasonsVsMatchedConfidence": nonnegative,
        "worstSeasonAccuracy": worst,
        "medianSeasonAccuracy": median,
        "r5h8HistoricalAccuracy": R5H8_ACC,
        "r5h8HistoricalCoverage": R5H8_COVERAGE,
        "r5h10HistoricalAccuracy": R5H10_ACC,
        "r5h10HistoricalCoverage": R5H10_COVERAGE,
        "r5h11HistoricalAccuracy": R5H11_ACC,
        "r5h11HistoricalCoverage": R5H11_COVERAGE,
        "r5h4HistoricalEliteAccuracy": R5H4_ACC,
        "preservesR5H8AccuracyWithinHalfPoint": bool(sm["accuracy"] >= R5H8_ACC - 0.005),
        "expandsCoverageVsR5H11": bool(sm["games"] > 171),
        "beatsR5H11Accuracy": bool(sm["accuracy"] > R5H11_ACC),
        "prototypeSpecificCalibrationPriorOnly": True,
        "configurationChosenOnPriorValidationSeasonsOnly": True,
        "anchoredPrototypeRefitUsesPriorSeasonsOnly": True,
        "targetSeasonUsedForGeometryTemplate": False,
        "targetSeasonUsedForExpansionConfiguration": False,
        "targetSeasonUsedForPrototypeCalibration": False,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleWeightsGameSpecific": True,
        "automaticProductionPromotion": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForGeometryTemplate": "NO",
        "targetSeasonUsedForExpansionConfiguration": "NO",
        "targetSeasonUsedForPrototypeCalibration": "NO",
        "targetSeasonUsedForR5H8CoreConfiguration": "NO",
        "configurationValidation": "LATEST_TWO_PRIOR_SEASONS_ONLY",
        "prototypeCalibration": "PER_WIN_PROTOTYPE_SMOOTHED_RELIABILITY_ADJUSTED_SCORE_QUANTILE",
        "prototypeRefit": "ANCHORED_KMEANS_ON_ALL_PRIOR_SEASONS_USING_PREVALIDATION_SCALE_AND_CENTERS",
        "marginalBand": "ONLY_BELOW_R5H8_THRESHOLD_AND_POSITIVE_INTERACTION_STATE",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h12-prototype-specific-acceptance.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "design": (
            "reproduce R5H8 core exactly; learn multiple prior-only local winner/loser prototypes; "
            "calibrate a separate acceptance quantile and threshold for each winner prototype from prior candidate reliability; "
            "lower acceptance barriers for historically reliable prototypes and raise or disable unreliable prototypes; "
            "choose global calibration hyperparameters only on the latest two prior validation seasons; never use target outcomes"
        ),
        "maxTargetMarginalAddRate": MAX_TARGET_ADD_RATE,
        "automaticProductionPromotion": False,
    }

    base.to_parquet(out / "nfl_r5h12_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h12_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h12_config_by_season.csv", index=False)
    pd.DataFrame(calibration_rows).to_csv(out / "nfl_r5h12_prototype_calibration_by_season.csv", index=False)
    pd.DataFrame(proto_rows).to_csv(out / "nfl_r5h12_prototypes_by_season.csv", index=False)
    if search_rows:
        pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h12_inner_search.csv", index=False)
    else:
        pd.DataFrame().to_csv(out / "nfl_r5h12_inner_search.csv", index=False)
    base_cfg.to_csv(out / "nfl_r5h12_r5h8_core_config_by_season.csv", index=False)
    (out / "nfl_r5h12_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h12_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h12_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H12_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H12_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H12_CONFIG")
    print(pd.DataFrame(cfg_rows).to_string(index=False))
    print("NFL_R5H12_CALIBRATION")
    print(pd.DataFrame(calibration_rows).to_string(index=False))
    print("NFL_R5H12_COMPLETE")


if __name__ == "__main__":
    main()
