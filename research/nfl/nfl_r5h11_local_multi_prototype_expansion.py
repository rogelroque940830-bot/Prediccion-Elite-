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

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H11_LOCAL_MULTI_PROTOTYPE_EXPANSION"
SEED = 940830

R5H8_ACC = 0.7911392405063291
R5H8_COVERAGE = 0.07463391591875296
R5H10_ACC = 0.7904191616766467
R5H10_COVERAGE = 0.07888521492678319
R5H4_ACC = 0.7726161369193154

WIN_PROTOTYPES = (2, 3, 4)
LOSS_PROTOTYPES = (1, 2, 3)
DISTANCE_ALPHA = (0.0, 0.15, 0.30)
BAND_LOW = (0.65, 0.70, 0.80, 0.90)
GEOMETRY_QUANTILE = (0.55, 0.65, 0.75, 0.85)
AGREEMENT_FLOOR = (0.70, 0.80, 0.90)
SYNERGY_FLOOR = (0.00, 0.05)
REDUNDANCY_CAP = (0.15, 0.25, 0.35)
VALIDATION_SEASONS = 2
MIN_FIT_CORE_WINS = 28
MIN_FIT_CORE_LOSSES = 8
MIN_VALIDATION_MARGINAL = 10
MIN_VALIDATION_PER_SEASON = 3
MAX_TARGET_ADD_RATE = 0.05
STATE_FEATURES = list(r5h10.STATE_FEATURES)


def weighted_distances(X: np.ndarray, centers: np.ndarray, weight: np.ndarray) -> np.ndarray:
    if len(X) == 0:
        return np.empty((0, len(centers)), dtype=float)
    den = max(float(weight.sum()), 1e-12)
    diff = X[:, None, :] - centers[None, :, :]
    return np.sqrt(np.nansum((diff ** 2) * weight[None, None, :], axis=2) / den)


def fit_template(hist: pd.DataFrame, rules: list[str], k_win: int, k_loss: int):
    core = hist[hist.core_selected.astype(bool)].copy()
    if core.empty:
        return None
    correct = r5h6.correctness(core)
    wins = core[correct].copy()
    losses = core[~correct].copy()
    if len(wins) < max(MIN_FIT_CORE_WINS, int(k_win) * 5):
        return None
    if len(losses) < max(MIN_FIT_CORE_LOSSES, int(k_loss) * 3):
        return None

    pool = hist[(hist.interaction_score > 0) & np.isfinite(hist.threshold_ratio)].copy()
    if len(pool) < 50:
        pool = hist.copy()
    Xpool = r5h10.geometry_matrix(pool, rules)
    med, scale = r5h10.robust_center_scale(Xpool)
    Xw = (r5h10.geometry_matrix(wins, rules) - med) / scale
    Xl = (r5h10.geometry_matrix(losses, rules) - med) / scale

    kw = min(int(k_win), len(Xw))
    kl = min(int(k_loss), len(Xl))
    kmw = KMeans(n_clusters=kw, random_state=SEED, n_init=20).fit(Xw)
    kml = KMeans(n_clusters=kl, random_state=SEED + 11, n_init=20).fit(Xl)
    dim_weight = np.asarray([1.0] * len(STATE_FEATURES) + [0.5] * len(rules), dtype=float)
    return {
        "median": med,
        "scale": scale,
        "win_centers": kmw.cluster_centers_,
        "loss_centers": kml.cluster_centers_,
        "win_counts": np.bincount(kmw.labels_, minlength=kw),
        "loss_counts": np.bincount(kml.labels_, minlength=kl),
        "dim_weight": dim_weight,
        "fit_core_wins": int(len(wins)),
        "fit_core_losses": int(len(losses)),
        "k_win": kw,
        "k_loss": kl,
    }


def score_local_geometry(df: pd.DataFrame, rules: list[str], tpl, alpha: float):
    if tpl is None or df.empty:
        n = len(df)
        return (
            np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan),
            np.full(n, -1, dtype=int), np.full(n, -1, dtype=int),
        )
    X = (r5h10.geometry_matrix(df, rules) - tpl["median"]) / tpl["scale"]
    dw = weighted_distances(X, tpl["win_centers"], tpl["dim_weight"])
    dl = weighted_distances(X, tpl["loss_centers"], tpl["dim_weight"])
    win_proto = np.argmin(dw, axis=1)
    loss_proto = np.argmin(dl, axis=1)
    dwin = dw[np.arange(len(df)), win_proto]
    dloss = dl[np.arange(len(df)), loss_proto]
    margin = dloss - dwin
    score = margin - float(alpha) * dwin
    return score, dwin, dloss, win_proto, loss_proto


def base_mask(df: pd.DataFrame, cfg: dict) -> np.ndarray:
    ratio = df.threshold_ratio.to_numpy(dtype=float)
    return (
        (~df.core_selected.astype(bool).to_numpy())
        & np.isfinite(ratio)
        & (ratio >= float(cfg["band_low"]))
        & (ratio < 1.0)
        & (df.interaction_score.to_numpy(dtype=float) > 0)
        & (df.interaction_state.to_numpy(dtype=object) == "POSITIVE_INTERACTION")
        & (df.agreement.to_numpy(dtype=float) >= float(cfg["agreement_floor"]))
        & (df.synergy.to_numpy(dtype=float) >= float(cfg["synergy_floor"]))
        & (df.redundancy_exposure.to_numpy(dtype=float) <= float(cfg["redundancy_cap"]))
        & (df.contradiction_pair_risk.to_numpy(dtype=float) <= 0.01)
    )


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
        return None, None

    best = None
    rows = []
    for kw in WIN_PROTOTYPES:
        for kl in LOSS_PROTOTYPES:
            tpl = fit_template(fit, rules, kw, kl)
            if tpl is None:
                continue
            for alpha in DISTANCE_ALPHA:
                score, dwin, dloss, wpid, lpid = score_local_geometry(val, rules, tpl, alpha)
                for band in BAND_LOW:
                    for af in AGREEMENT_FLOOR:
                        for sf in SYNERGY_FLOOR:
                            for rc in REDUNDANCY_CAP:
                                cfg0 = {
                                    "k_win": int(kw), "k_loss": int(kl), "distance_alpha": float(alpha),
                                    "band_low": float(band), "agreement_floor": float(af),
                                    "synergy_floor": float(sf), "redundancy_cap": float(rc),
                                }
                                bm = base_mask(val, cfg0)
                                vals = score[bm & np.isfinite(score)]
                                if len(vals) < MIN_VALIDATION_MARGINAL:
                                    continue
                                for gq in GEOMETRY_QUANTILE:
                                    thr = float(np.quantile(vals, float(gq)))
                                    marg = bm & np.isfinite(score) & (score >= thr)
                                    mm = r5h6.metrics(val, marg)
                                    if mm["games"] < MIN_VALIDATION_MARGINAL:
                                        continue
                                    combined = core_val | marg
                                    cm = r5h6.metrics(val, combined)

                                    valid = True
                                    annual_combined = []
                                    annual_marg = []
                                    for vy, g in val.groupby("season"):
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

                                    matched, matched_acc = matched_control(val, combined, base_cfg)
                                    md = float(cm["accuracy"] - matched_acc) if np.isfinite(matched_acc) else -1.0
                                    min_combined = float(min(annual_combined))
                                    min_marg = float(min(annual_marg))
                                    preserve = bool(
                                        mm["accuracy"] >= max(0.76, core_m["accuracy"] - 0.015)
                                        and cm["accuracy"] >= core_m["accuracy"] - 0.005
                                    )
                                    stable = bool(min_combined >= 0.70 and min_marg >= 0.60)
                                    row = {
                                        **cfg0,
                                        "geometry_quantile": float(gq),
                                        "validation_geometry_threshold": thr,
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
                                        "preserve_gate": preserve,
                                        "stability_gate": stable,
                                    }
                                    rows.append(row)
                                    key = (
                                        int(preserve), int(stable),
                                        min_combined,
                                        cm["accuracy"],
                                        mm["accuracy"],
                                        md,
                                        mm["wilson95_lower"],
                                        mm["games"],
                                        -kw, -kl,
                                    )
                                    if best is None or key > best[0]:
                                        best = (key, row)
    if best is None or not best[1]["preserve_gate"]:
        return None, pd.DataFrame(rows)
    return dict(best[1]), pd.DataFrame(rows)


def prototype_rows(tpl, rules: list[str], season: int) -> list[dict]:
    names = STATE_FEATURES + [f"rule_support_share__{r}" for r in rules]
    rows = []
    for kind, centers, counts in (
        ("WIN", tpl["win_centers"], tpl["win_counts"]),
        ("LOSS", tpl["loss_centers"], tpl["loss_counts"]),
    ):
        for i, c in enumerate(centers):
            order = np.argsort(-np.abs(c))[:5]
            rows.append({
                "test_season": int(season),
                "prototype_kind": kind,
                "prototype_id": int(i),
                "fit_members": int(counts[i]),
                "top_geometry_dimensions": json.dumps([names[j] for j in order]),
                "top_geometry_values": json.dumps([float(c[j]) for j in order]),
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h11-output")
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
    base["marginal_selected"] = 0
    base["selected"] = base.core_selected.astype(int)

    cfg_rows, search_rows, proto_rows = [], [], []
    for y in range(a.test_start, a.end_season + 1):
        iy = base.season.to_numpy(dtype=int) == y
        hist = base[base.season < y].copy()
        te = base[iy].copy()
        if te.empty:
            continue
        years = sorted(int(v) for v in hist.season.unique())
        if len(years) < VALIDATION_SEASONS + 1:
            cfg_rows.append({"test_season": int(y), "geometry_ready": False, "reason": "INSUFFICIENT_PRIOR_SEASONS"})
            continue
        val_years = years[-VALIDATION_SEASONS:]
        fit = hist[~hist.season.isin(val_years)].copy()
        val = hist[hist.season.isin(val_years)].copy()
        cfg, search = choose_config(fit, val, rules, base_cfg)
        if search is not None and not search.empty:
            search["test_season"] = int(y)
            search_rows.append(search)
        if cfg is None:
            cfg_rows.append({
                "test_season": int(y), "geometry_ready": False,
                "reason": "NO_VALIDATED_MULTI_PROTOTYPE_CONFIGURATION",
                "validation_seasons": json.dumps(val_years),
            })
            continue

        tpl = fit_template(hist, rules, int(cfg["k_win"]), int(cfg["k_loss"]))
        if tpl is None:
            cfg_rows.append({"test_season": int(y), "geometry_ready": False, "reason": "REFIT_TEMPLATE_FAILED"})
            continue
        proto_rows.extend(prototype_rows(tpl, rules, y))

        hs, _, _, _, _ = score_local_geometry(hist, rules, tpl, float(cfg["distance_alpha"]))
        hist["local_geometry_score"] = hs
        bm_hist = base_mask(hist, cfg)
        hvals = hs[bm_hist & np.isfinite(hs)]
        if len(hvals) < MIN_VALIDATION_MARGINAL:
            cfg_rows.append({"test_season": int(y), "geometry_ready": False, "reason": "INSUFFICIENT_REFIT_MARGINAL_POOL"})
            continue
        threshold = float(np.quantile(hvals, float(cfg["geometry_quantile"])))

        ts, tdw, tdl, twp, tlp = score_local_geometry(te, rules, tpl, float(cfg["distance_alpha"]))
        bm = base_mask(te, cfg)
        add = bm & np.isfinite(ts) & (ts >= threshold)
        cap = max(1, int(np.floor(MAX_TARGET_ADD_RATE * len(te))))
        ix = np.flatnonzero(add)
        if len(ix) > cap:
            keep = ix[np.argsort(-ts[ix], kind="stable")[:cap]]
            add[:] = False
            add[keep] = True

        target_ix = base.index[iy]
        base.loc[target_ix, "local_geometry_score"] = ts
        base.loc[target_ix, "local_distance_win"] = tdw
        base.loc[target_ix, "local_distance_loss"] = tdl
        base.loc[target_ix, "nearest_win_prototype"] = twp
        base.loc[target_ix, "nearest_loss_prototype"] = tlp
        base.loc[target_ix, "marginal_selected"] = add.astype(int)
        base.loc[target_ix, "selected"] = (te.core_selected.to_numpy(dtype=bool) | add).astype(int)

        cfg_rows.append({
            "test_season": int(y),
            "geometry_ready": True,
            "validation_seasons": json.dumps(val_years),
            "fit_core_wins": int(tpl["fit_core_wins"]),
            "fit_core_losses": int(tpl["fit_core_losses"]),
            "refit_geometry_threshold": threshold,
            "target_marginal_added": int(add.sum()),
            **cfg,
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
    positive_matched = int((bydf.delta_vs_matched_conf > 0).sum())
    nonnegative_matched = int((bydf.delta_vs_matched_conf >= 0).sum())
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
        "positiveOuterSeasonsVsMatchedConfidence": positive_matched,
        "nonnegativeOuterSeasonsVsMatchedConfidence": nonnegative_matched,
        "worstSeasonAccuracy": worst, "medianSeasonAccuracy": median,
        "r5h8HistoricalAccuracy": R5H8_ACC, "r5h8HistoricalCoverage": R5H8_COVERAGE,
        "r5h10HistoricalAccuracy": R5H10_ACC, "r5h10HistoricalCoverage": R5H10_COVERAGE,
        "r5h4HistoricalEliteAccuracy": R5H4_ACC,
        "preservesR5H8AccuracyWithinHalfPoint": bool(sm["accuracy"] >= R5H8_ACC - 0.005),
        "expandsCoverageVsR5H8": bool(sm["games"] > corem["games"]),
        "expandsCoverageVsR5H10": bool(sm["games"] > 167),
        "beatsR5H10Accuracy": bool(sm["accuracy"] > R5H10_ACC),
        "multiPrototypeGeometryPriorOnly": True,
        "configurationChosenOnPriorValidationSeasonsOnly": True,
        "targetSeasonUsedForGeometryTemplate": False,
        "targetSeasonUsedForExpansionConfiguration": False,
        "ruleScoreUsesReferenceConfidenceMagnitude": False,
        "ruleWeightsGameSpecific": True,
        "automaticProductionPromotion": False,
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "targetSeasonUsedForGeometryTemplate": "NO",
        "targetSeasonUsedForExpansionConfiguration": "NO",
        "targetSeasonUsedForR5H8CoreConfiguration": "NO",
        "geometryBasis": "PRIOR_ONLY_LOCAL_KMEANS_WINNER_AND_LOSER_PROTOTYPES_WITH_ROBUST_SCALING",
        "configurationValidation": "LATEST_TWO_PRIOR_SEASONS_ONLY",
        "prototypeRefit": "ALL_PRIOR_SEASONS_AFTER_CONFIGURATION_SELECTION",
        "marginalBand": "ONLY_BELOW_R5H8_THRESHOLD_AND_POSITIVE_INTERACTION_STATE",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h11-local-multi-prototype.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "design": (
            "reproduce R5H8 core exactly; cluster prior R5H8 core winners and losers into multiple local geometry prototypes; "
            "select prototype counts and marginal acceptance settings only on prior validation seasons; refit chosen prototypes on all prior history; "
            "recover only below-threshold positive-interaction games closer to a local winner prototype than loser geometry"
        ),
        "maxTargetMarginalAddRate": MAX_TARGET_ADD_RATE,
        "automaticProductionPromotion": False,
    }

    base.to_parquet(out / "nfl_r5h11_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h11_by_season.csv", index=False)
    pd.DataFrame(cfg_rows).to_csv(out / "nfl_r5h11_config_by_season.csv", index=False)
    if search_rows:
        pd.concat(search_rows, ignore_index=True).to_csv(out / "nfl_r5h11_inner_search.csv", index=False)
    else:
        pd.DataFrame().to_csv(out / "nfl_r5h11_inner_search.csv", index=False)
    pd.DataFrame(proto_rows).to_csv(out / "nfl_r5h11_prototypes_by_season.csv", index=False)
    base_cfg.to_csv(out / "nfl_r5h11_r5h8_core_config_by_season.csv", index=False)
    (out / "nfl_r5h11_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h11_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h11_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H11_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H11_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H11_CONFIG")
    print(pd.DataFrame(cfg_rows).to_string(index=False))
    print("NFL_R5H11_COMPLETE")


if __name__ == "__main__":
    main()
