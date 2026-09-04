#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h8_interaction_contradiction_engine as r5h8
import nfl_r5h10_marginal_geometry_expansion as r5h10
import nfl_r5h11_local_multi_prototype_expansion as r5h11
import nfl_r5h12_prototype_specific_acceptance as r5h12

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H13_PROTOTYPE_CORE_PRUNING_ELITE_EXPANSION"
SEED = 940830

R5H8_ACC = 0.7911392405063291
R5H8_GAMES = 158
R5H8_COVERAGE = 0.07463391591875296
R5H12_ACC = 0.7964071856287425
R5H12_GAMES = 167
R5H12_COVERAGE = 0.07888521492678319
R5H11_ACC = 0.7894736842105263
R5H4_ACC = 0.7726161369193154

VALIDATION_SEASONS = 2
MIN_CORE_PROTO_POOL = 4
MAX_TARGET_CORE_PRUNE_RATE = 0.12
MIN_TARGET_CORE_RETAIN_RATE = 0.88
MIN_VALIDATION_FINAL_VOLUME_RATE = 0.90
MIN_VALIDATION_CORE_RETAIN_RATE = 0.88
MIN_PRUNING_ACCURACY_GAIN = 0.002

CORE_BASE_PRUNE = (0.00, 0.03, 0.06, 0.10)
CORE_RELIABILITY_GAMMA = (0.50, 1.00, 1.50)
CORE_MAX_PRUNE_QUANTILE = (0.12, 0.20)
CORE_SHRINK_TAU = 8.0


def set_bounded_h12_grid() -> None:
    # Same bounded H12 family used by the successful R5H12 run.
    r5h12.WIN_PROTOTYPES = (2, 3)
    r5h12.LOSS_PROTOTYPES = (1, 2)
    r5h12.DISTANCE_ALPHA = (0.0, 0.30)
    r5h12.BAND_LOW = (0.60, 0.70, 0.80)
    r5h12.AGREEMENT_FLOOR = (0.70, 0.80)
    r5h12.SYNERGY_FLOOR = (0.00,)
    r5h12.REDUNDANCY_CAP = (0.15, 0.25, 0.35)
    r5h12.BASE_QUANTILE = (0.35, 0.55, 0.75)
    r5h12.RELIABILITY_BETA = (0.75, 1.25)
    r5h12.SHRINK_TAU = (8.0,)
    r5h12.MIN_PROTO_RELIABILITY = (0.66, 0.70)


def calibrate_core_pruning(
    df: pd.DataFrame,
    score: np.ndarray,
    win_proto: np.ndarray,
    core_mask: np.ndarray,
    cfg: dict,
) -> tuple[np.ndarray, list[dict]]:
    prune = np.zeros(len(df), dtype=bool)
    rows: list[dict] = []
    correct = r5h6.correctness(df)
    core_metric = r5h6.metrics(df, core_mask)
    core_accuracy = float(core_metric["accuracy"]) if core_metric["games"] else 0.5

    for p in range(int(cfg["k_win"])):
        pool = core_mask & np.isfinite(score) & (win_proto == p)
        n = int(pool.sum())
        if n < MIN_CORE_PROTO_POOL:
            rows.append({
                "prototype_id": int(p),
                "core_pool": n,
                "enabled": False,
                "reason": "INSUFFICIENT_CORE_PROTO_POOL",
            })
            continue

        wins = int(correct[pool].sum())
        empirical = float(wins / n)
        smoothed = float((wins + CORE_SHRINK_TAU * core_accuracy) / (n + CORE_SHRINK_TAU))
        q = float(np.clip(
            float(cfg["core_base_prune"])
            + float(cfg["core_reliability_gamma"]) * (core_accuracy - smoothed),
            0.0,
            float(cfg["core_max_prune_quantile"]),
        ))
        vals = score[pool]
        threshold = float(np.quantile(vals, q))
        take = pool & (score < threshold) if q > 0 else np.zeros(len(df), dtype=bool)
        prune |= take
        pm = r5h6.metrics(df, take)
        rows.append({
            "prototype_id": int(p),
            "core_pool": n,
            "core_wins": wins,
            "core_empirical_accuracy": empirical,
            "smoothed_core_reliability": smoothed,
            "prune_quantile": q,
            "prune_threshold": threshold,
            "enabled": bool(q > 0),
            "pruned_games": pm["games"],
            "pruned_accuracy": pm["accuracy"],
        })
    return prune, rows


def apply_prune_with_cap(
    te: pd.DataFrame,
    score: np.ndarray,
    win_proto: np.ndarray,
    core_mask: np.ndarray,
    calibration: list[dict],
) -> np.ndarray:
    prune = np.zeros(len(te), dtype=bool)
    thr_map: dict[int, float] = {}
    for row in calibration:
        if not bool(row.get("enabled", False)):
            continue
        p = int(row["prototype_id"])
        thr = float(row["prune_threshold"])
        thr_map[p] = thr
        prune |= core_mask & (win_proto == p) & np.isfinite(score) & (score < thr)

    core_n = int(core_mask.sum())
    if core_n <= 0:
        return prune
    cap = int(np.floor(MAX_TARGET_CORE_PRUNE_RATE * core_n))
    cap = min(cap, max(0, core_n - int(np.ceil(MIN_TARGET_CORE_RETAIN_RATE * core_n))))
    if cap <= 0:
        return np.zeros(len(te), dtype=bool)

    ix = np.flatnonzero(prune)
    if len(ix) > cap:
        severity = np.asarray([
            thr_map.get(int(win_proto[i]), -np.inf) - score[i]
            for i in ix
        ], dtype=float)
        keep = ix[np.argsort(-severity, kind="stable")[:cap]]
        prune[:] = False
        prune[keep] = True
    return prune


def matched_control(df: pd.DataFrame, selected: np.ndarray, base_cfg: pd.DataFrame) -> tuple[np.ndarray, float]:
    return r5h12.matched_control(df, selected, base_cfg)


def choose_prune_config(
    val: pd.DataFrame,
    score: np.ndarray,
    win_proto: np.ndarray,
    marginal: np.ndarray,
    base_cfg: pd.DataFrame,
    k_win: int,
) -> tuple[dict, pd.DataFrame]:
    core = val.core_selected.to_numpy(dtype=bool)
    baseline = core | marginal
    bm = r5h6.metrics(val, baseline)
    core_m = r5h6.metrics(val, core)
    _, base_matched_acc = matched_control(val, baseline, base_cfg)

    no_prune = {
        "core_base_prune": 0.0,
        "core_reliability_gamma": 0.0,
        "core_max_prune_quantile": 0.0,
        "k_win": int(k_win),
        "validation_baseline_games": bm["games"],
        "validation_baseline_accuracy": bm["accuracy"],
        "validation_baseline_matched_accuracy": base_matched_acc,
        "validation_pruned_games": 0,
        "validation_pruned_accuracy": np.nan,
        "validation_final_games": bm["games"],
        "validation_final_accuracy": bm["accuracy"],
        "validation_final_matched_accuracy": base_matched_acc,
        "validation_delta_vs_matched_conf": float(bm["accuracy"] - base_matched_acc) if np.isfinite(base_matched_acc) else np.nan,
        "validation_core_retain_rate": 1.0,
        "validation_final_volume_rate": 1.0,
        "validation_min_season_accuracy": np.nan,
        "pruning_enabled": False,
        "pruning_improves_accuracy": False,
    }

    rows: list[dict] = []
    best = None
    for base_q in CORE_BASE_PRUNE:
        for gamma in CORE_RELIABILITY_GAMMA:
            for max_q in CORE_MAX_PRUNE_QUANTILE:
                cfg = {
                    "core_base_prune": float(base_q),
                    "core_reliability_gamma": float(gamma),
                    "core_max_prune_quantile": float(max_q),
                    "k_win": int(k_win),
                }
                prune, calibration = calibrate_core_pruning(val, score, win_proto, core, cfg)
                pruned_n = int(prune.sum())
                if pruned_n <= 0:
                    continue
                kept_core = core & ~prune
                final = kept_core | marginal
                fm = r5h6.metrics(val, final)
                pm = r5h6.metrics(val, prune)
                retained = float(kept_core.sum() / max(int(core.sum()), 1))
                volume_rate = float(final.sum() / max(int(baseline.sum()), 1))

                annual_acc: list[float] = []
                annual_retain: list[float] = []
                valid = True
                for _, g in val.groupby("season"):
                    loc = val.index.get_indexer(g.index)
                    gb = baseline[loc]
                    gf = final[loc]
                    gc = core[loc]
                    gk = kept_core[loc]
                    if int(gf.sum()) <= 0:
                        valid = False
                        break
                    annual_acc.append(float(r5h6.metrics(g, gf)["accuracy"]))
                    if int(gc.sum()) >= 5:
                        annual_retain.append(float(gk.sum() / int(gc.sum())))
                    if int(gf.sum()) < int(np.floor(0.85 * max(int(gb.sum()), 1))):
                        valid = False
                        break
                if not valid:
                    continue

                _, matched_acc = matched_control(val, final, base_cfg)
                delta = float(fm["accuracy"] - matched_acc) if np.isfinite(matched_acc) else -1.0
                min_season = float(min(annual_acc)) if annual_acc else 0.0
                min_core_retain = float(min(annual_retain)) if annual_retain else retained
                accuracy_gain = float(fm["accuracy"] - bm["accuracy"])
                preserve = bool(
                    volume_rate >= MIN_VALIDATION_FINAL_VOLUME_RATE
                    and retained >= MIN_VALIDATION_CORE_RETAIN_RATE
                    and min_core_retain >= 0.80
                )
                improves = bool(accuracy_gain >= MIN_PRUNING_ACCURACY_GAIN)
                matched_gate = bool(delta >= 0.0)
                row = {
                    **cfg,
                    "validation_baseline_games": bm["games"],
                    "validation_baseline_accuracy": bm["accuracy"],
                    "validation_baseline_matched_accuracy": base_matched_acc,
                    "validation_pruned_games": pm["games"],
                    "validation_pruned_accuracy": pm["accuracy"],
                    "validation_final_games": fm["games"],
                    "validation_final_accuracy": fm["accuracy"],
                    "validation_final_matched_accuracy": matched_acc,
                    "validation_delta_vs_matched_conf": delta,
                    "validation_accuracy_gain_vs_unpruned": accuracy_gain,
                    "validation_core_retain_rate": retained,
                    "validation_min_core_retain_rate": min_core_retain,
                    "validation_final_volume_rate": volume_rate,
                    "validation_min_season_accuracy": min_season,
                    "pruning_enabled": True,
                    "pruning_improves_accuracy": improves,
                    "preserve_gate": preserve,
                    "matched_delta_gate": matched_gate,
                    "enabled_prune_prototypes": int(sum(bool(r.get("enabled", False)) for r in calibration)),
                }
                rows.append(row)
                key = (
                    int(preserve), int(improves), int(matched_gate),
                    min_season,
                    fm["accuracy"],
                    delta,
                    volume_rate,
                    -pm["accuracy"] if np.isfinite(pm["accuracy"]) else -1.0,
                    -pruned_n,
                )
                if best is None or key > best[0]:
                    best = (key, row)

    if best is None:
        return no_prune, pd.DataFrame(rows)
    chosen = dict(best[1])
    if not (chosen.get("preserve_gate") and chosen.get("pruning_improves_accuracy") and chosen.get("matched_delta_gate")):
        return no_prune, pd.DataFrame(rows)
    return chosen, pd.DataFrame(rows)


def main() -> None:
    set_bounded_h12_grid()

    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h13-output")
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
    base["nearest_win_prototype"] = -1
    base["nearest_loss_prototype"] = -1
    base["marginal_selected"] = 0
    base["core_pruned"] = 0
    base["core_retained"] = base.core_selected.astype(int)
    base["selected"] = base.core_selected.astype(int)

    cfg_rows: list[dict] = []
    h12_search_rows: list[pd.DataFrame] = []
    prune_search_rows: list[pd.DataFrame] = []
    expansion_cal_rows: list[dict] = []
    prune_cal_rows: list[dict] = []
    proto_rows: list[dict] = []

    for y in range(a.test_start, a.end_season + 1):
        iy = base.season.to_numpy(dtype=int) == y
        hist = base[base.season < y].copy()
        te = base[iy].copy()
        if te.empty:
            continue
        years = sorted(int(v) for v in hist.season.unique())
        if len(years) < VALIDATION_SEASONS + 1:
            cfg_rows.append({"test_season": int(y), "ready": False, "reason": "INSUFFICIENT_PRIOR_SEASONS"})
            continue

        val_years = years[-VALIDATION_SEASONS:]
        fit = hist[~hist.season.isin(val_years)].copy()
        val = hist[hist.season.isin(val_years)].copy()
        chosen, search = r5h12.choose_config(fit, val, rules, base_cfg)
        if search is not None and not search.empty:
            search["test_season"] = int(y)
            h12_search_rows.append(search)
        if chosen is None:
            cfg_rows.append({
                "test_season": int(y), "ready": False,
                "reason": "NO_VALIDATED_H12_EXPANSION_CONFIGURATION",
                "validation_seasons": json.dumps(val_years),
            })
            continue

        initial_tpl = chosen.pop("fit_template")
        vscore, _, _, vwp, _ = r5h11.score_local_geometry(
            val, rules, initial_tpl, float(chosen["distance_alpha"])
        )
        vbm = r5h11.base_mask(val, chosen)
        vcore = val.core_selected.to_numpy(dtype=bool)
        vcore_m = r5h6.metrics(val, vcore)
        vmarg, _ = r5h12.calibrate_prototypes(
            val, vscore, vwp, vbm, vcore_m["accuracy"], chosen
        )
        prune_cfg, prune_search = choose_prune_config(
            val, vscore, vwp, vmarg, base_cfg, int(chosen["k_win"])
        )
        if prune_search is not None and not prune_search.empty:
            prune_search["test_season"] = int(y)
            prune_search_rows.append(prune_search)

        tpl = r5h12.anchored_refit_template(hist, rules, initial_tpl)
        if tpl is None:
            cfg_rows.append({"test_season": int(y), "ready": False, "reason": "ANCHORED_REFIT_FAILED"})
            continue
        proto_rows.extend(r5h11.prototype_rows(tpl, rules, y))

        hs, _, _, hwp, _ = r5h11.score_local_geometry(
            hist, rules, tpl, float(chosen["distance_alpha"])
        )
        hbm = r5h11.base_mask(hist, chosen)
        hcore = hist.core_selected.to_numpy(dtype=bool)
        hcore_m = r5h6.metrics(hist, hcore)
        _, expansion_cal = r5h12.calibrate_prototypes(
            hist, hs, hwp, hbm, hcore_m["accuracy"], chosen
        )
        for row in expansion_cal:
            expansion_cal_rows.append({"test_season": int(y), **row})

        prune_cfg_for_refit = {
            "core_base_prune": float(prune_cfg["core_base_prune"]),
            "core_reliability_gamma": float(prune_cfg["core_reliability_gamma"]),
            "core_max_prune_quantile": float(prune_cfg["core_max_prune_quantile"]),
            "k_win": int(chosen["k_win"]),
        }
        _, prune_cal = calibrate_core_pruning(
            hist, hs, hwp, hcore, prune_cfg_for_refit
        )
        for row in prune_cal:
            prune_cal_rows.append({"test_season": int(y), **row})

        ts, _, _, twp, tlp = r5h11.score_local_geometry(
            te, rules, tpl, float(chosen["distance_alpha"])
        )
        tbm = r5h11.base_mask(te, chosen)
        add = r5h12.apply_target_with_cap(te, ts, twp, tbm, expansion_cal)
        tcore = te.core_selected.to_numpy(dtype=bool)
        prune = apply_prune_with_cap(te, ts, twp, tcore, prune_cal)
        retained_core = tcore & ~prune
        selected = retained_core | add

        target_ix = base.index[iy]
        base.loc[target_ix, "local_geometry_score"] = ts
        base.loc[target_ix, "nearest_win_prototype"] = twp
        base.loc[target_ix, "nearest_loss_prototype"] = tlp
        base.loc[target_ix, "marginal_selected"] = add.astype(int)
        base.loc[target_ix, "core_pruned"] = prune.astype(int)
        base.loc[target_ix, "core_retained"] = retained_core.astype(int)
        base.loc[target_ix, "selected"] = selected.astype(int)

        cfg_rows.append({
            "test_season": int(y),
            "ready": True,
            "validation_seasons": json.dumps(val_years),
            "target_core_games": int(tcore.sum()),
            "target_core_pruned": int(prune.sum()),
            "target_core_retained": int(retained_core.sum()),
            "target_marginal_added": int(add.sum()),
            "target_final_games": int(selected.sum()),
            "pruning_enabled": bool(prune_cfg.get("pruning_enabled", False)),
            **{k: v for k, v in chosen.items() if k != "fit_template"},
            **{f"prune_{k}": v for k, v in prune_cfg.items() if k != "k_win"},
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
    kept = base.core_retained.to_numpy(dtype=bool)
    pruned = base.core_pruned.to_numpy(dtype=bool)
    marg = base.marginal_selected.to_numpy(dtype=bool)
    matched = base.confidence_control_matched.to_numpy(dtype=bool)

    sm = r5h6.metrics(base, sel)
    corem = r5h6.metrics(base, core)
    keptm = r5h6.metrics(base, kept)
    pm = r5h6.metrics(base, pruned)
    mm = r5h6.metrics(base, marg)
    cm = r5h6.metrics(base, matched)
    boot = r5h6.bootstrap_difference(base, "selected", "confidence_control_matched")

    by_rows: list[dict] = []
    for y, g in base.groupby("season"):
        final_m = r5h6.metrics(g, g.selected.to_numpy(dtype=bool))
        core_m = r5h6.metrics(g, g.core_selected.to_numpy(dtype=bool))
        kept_m = r5h6.metrics(g, g.core_retained.to_numpy(dtype=bool))
        prune_m = r5h6.metrics(g, g.core_pruned.to_numpy(dtype=bool))
        marg_m = r5h6.metrics(g, g.marginal_selected.to_numpy(dtype=bool))
        conf_m = r5h6.metrics(g, g.confidence_control_matched.to_numpy(dtype=bool))
        by_rows.append({
            "season": int(y),
            "selected_games": final_m["games"],
            "selected_accuracy": final_m["accuracy"],
            "core_games": core_m["games"],
            "core_accuracy": core_m["accuracy"],
            "retained_core_games": kept_m["games"],
            "retained_core_accuracy": kept_m["accuracy"],
            "pruned_core_games": prune_m["games"],
            "pruned_core_accuracy": prune_m["accuracy"],
            "marginal_games": marg_m["games"],
            "marginal_accuracy": marg_m["accuracy"],
            "matched_conf_games": conf_m["games"],
            "matched_conf_accuracy": conf_m["accuracy"],
            "delta_vs_matched_conf": float(final_m["accuracy"] - conf_m["accuracy"]) if conf_m["games"] else np.nan,
        })
    bydf = pd.DataFrame(by_rows)

    positive = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative = int((bydf.delta_vs_matched_conf >= 0).sum())
    worst = float(bydf.selected_accuracy.min())
    median = float(bydf.selected_accuracy.median())
    volume_vs_h12 = float(sm["games"] / R5H12_GAMES)

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(base)),
        "selectedGames": sm["games"],
        "selectedWins": sm["wins"],
        "selectedLosses": sm["losses"],
        "selectedAccuracy": sm["accuracy"],
        "selectedCoverage": float(sm["games"] / len(base)),
        "selectedWilson95Lower": sm["wilson95_lower"],
        "r5h8CoreGames": corem["games"],
        "r5h8CoreAccuracyReproduced": corem["accuracy"],
        "retainedCoreGames": keptm["games"],
        "retainedCoreAccuracy": keptm["accuracy"],
        "corePrunedGames": pm["games"],
        "corePrunedWins": pm["wins"],
        "corePrunedLosses": pm["losses"],
        "corePrunedAccuracy": pm["accuracy"],
        "marginalAddedGames": mm["games"],
        "marginalAddedWins": mm["wins"],
        "marginalAddedLosses": mm["losses"],
        "marginalAddedAccuracy": mm["accuracy"],
        "netGameChangeVsR5H8Core": int(sm["games"] - corem["games"]),
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
        "r5h12HistoricalAccuracy": R5H12_ACC,
        "r5h12HistoricalCoverage": R5H12_COVERAGE,
        "r5h11HistoricalAccuracy": R5H11_ACC,
        "r5h4HistoricalEliteAccuracy": R5H4_ACC,
        "beatsR5H12Accuracy": bool(sm["accuracy"] > R5H12_ACC),
        "retainsAtLeast90PctR5H12Volume": bool(volume_vs_h12 >= 0.90),
        "volumeRatioVsR5H12": volume_vs_h12,
        "beatsR5H8Accuracy": bool(sm["accuracy"] > R5H8_ACC),
        "prototypeSpecificCorePruningPriorOnly": True,
        "prototypeSpecificExpansionPriorOnly": True,
        "configurationChosenOnPriorValidationSeasonsOnly": True,
        "targetSeasonUsedForGeometryTemplate": False,
        "targetSeasonUsedForExpansionConfiguration": False,
        "targetSeasonUsedForPrototypeCalibration": False,
        "targetSeasonUsedForCorePruningCalibration": False,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleWeightsGameSpecific": True,
        "automaticProductionPromotion": False,
    }

    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForGeometryTemplate": "NO",
        "targetSeasonUsedForExpansionConfiguration": "NO",
        "targetSeasonUsedForPrototypeCalibration": "NO",
        "targetSeasonUsedForCorePruningCalibration": "NO",
        "targetSeasonUsedForR5H8CoreConfiguration": "NO",
        "configurationValidation": "LATEST_TWO_PRIOR_SEASONS_ONLY",
        "prototypeExpansion": "R5H12_PER_WIN_PROTOTYPE_PRIOR_ONLY_ACCEPTANCE",
        "corePruning": "PER_WIN_PROTOTYPE_PRIOR_ONLY_RELIABILITY_ADJUSTED_LOW_GEOMETRY_TAIL",
        "corePruneTargetCap": MAX_TARGET_CORE_PRUNE_RATE,
        "minimumTargetCoreRetainRate": MIN_TARGET_CORE_RETAIN_RATE,
        "productionCodeTouched": False,
    }

    manifest = {
        "schemaVersion": "courtedge-nfl-r5h13-core-prune-expansion.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "design": (
            "retain R5B2 winner direction and exact R5H8 core construction; use prior-only local winner/loss geometry to calibrate both sides of the Elite gate; "
            "add below-threshold games through R5H12 prototype-specific acceptance while pruning only the weakest low-geometry tail of historically unreliable core prototypes; "
            "choose pruning hyperparameters only on the latest two prior validation seasons; cap target core removals and preserve at least 88% of target core; never use target outcomes"
        ),
        "automaticProductionPromotion": False,
    }

    base.to_parquet(out / "nfl_r5h13_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h13_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h13_config_by_season.csv", index=False)
    pd.DataFrame(expansion_cal_rows).to_csv(out / "nfl_r5h13_expansion_calibration_by_season.csv", index=False)
    pd.DataFrame(prune_cal_rows).to_csv(out / "nfl_r5h13_core_prune_calibration_by_season.csv", index=False)
    pd.DataFrame(proto_rows).to_csv(out / "nfl_r5h13_prototypes_by_season.csv", index=False)
    if h12_search_rows:
        pd.concat(h12_search_rows, ignore_index=True).to_csv(out / "nfl_r5h13_h12_inner_search.csv", index=False)
    else:
        pd.DataFrame().to_csv(out / "nfl_r5h13_h12_inner_search.csv", index=False)
    if prune_search_rows:
        pd.concat(prune_search_rows, ignore_index=True).to_csv(out / "nfl_r5h13_prune_inner_search.csv", index=False)
    else:
        pd.DataFrame().to_csv(out / "nfl_r5h13_prune_inner_search.csv", index=False)
    base_cfg.to_csv(out / "nfl_r5h13_r5h8_core_config_by_season.csv", index=False)
    (out / "nfl_r5h13_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h13_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h13_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H13_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H13_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H13_CONFIG")
    print(pd.DataFrame(cfg_rows).to_string(index=False))
    print("NFL_R5H13_COMPLETE")


if __name__ == "__main__":
    main()
