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

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H10_MARGINAL_GEOMETRY_EXPANSION"
R5H8_ACC = 0.7911392405063291
R5H8_COVERAGE = 0.07463391591875296
R5H4_ACC = 0.7726161369193154

BAND_LOW = (0.70, 0.80, 0.90)
GEOMETRY_QUANTILE = (0.50, 0.65, 0.75, 0.85)
AGREEMENT_FLOOR = (0.70, 0.80, 0.90)
SYNERGY_FLOOR = (0.00, 0.05, 0.10)
REDUNDANCY_CAP = (0.15, 0.25, 0.35)
MIN_CORE_WINS = 30
MIN_CORE_LOSSES = 8
MIN_HIST_MARGINAL = 15
MAX_TARGET_ADD_RATE = 0.05
STATE_FEATURES = [
    "agreement",
    "signed_consensus",
    "synergy",
    "contradiction_pair_risk",
    "diversity",
    "redundancy_exposure",
]


def build_r5h8_base(meta: pd.DataFrame, rules: list[str], test_start: int, end_season: int):
    rows = []
    cfg_rows = []
    for y in range(test_start, end_season + 1):
        mt = meta[meta.season < y].copy()
        te = meta[meta.season == y].copy()
        if mt.empty or te.empty:
            continue
        cfg, rel, pair, _ = r5h8.select_config(mt, rules)
        score, agreement, shares, state = r5h8.score_games(te, rel, pair, cfg)
        edges = r5h8.decode_edges(cfg["bin_edges"])
        floor = float(cfg["confidence_floor"])
        rule_thr = r5h8.decode_thresholds(cfg["rule_thresholds"])
        selected, bins = r5h6.apply_rule_thresholds(te, score, edges, floor, rule_thr)

        conf = r5h6.conf_score(te)
        threshold = np.asarray([float(rule_thr.get(int(b), float("inf"))) for b in bins], dtype=float)
        ratio = np.full(len(te), np.nan, dtype=float)
        finite = np.isfinite(threshold) & (threshold > 0)
        ratio[finite] = score[finite] / threshold[finite]

        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["interaction_score"] = score
        q["agreement"] = agreement
        q["confidence_score"] = conf
        q["confidence_stratum"] = bins
        q["confidence_floor"] = floor
        q["threshold_value"] = threshold
        q["threshold_ratio"] = ratio
        q["core_selected"] = selected.astype(int)
        for name, vals in state.items():
            q[name] = vals
        q["interaction_state"] = r5h8.state_label(
            agreement,
            state["synergy"],
            state["redundancy_exposure"],
            state["contradiction_pair_risk"],
        )
        for rr in rules:
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy(dtype=float)
            q[f"rule_weight_share__{rr}"] = shares[rr]
        rows.append(q)
        cfg_rows.append({
            "test_season": int(y),
            "bin_edges": cfg["bin_edges"],
            "rule_thresholds": cfg["rule_thresholds"],
            "confidence_floor": floor,
        })
    return pd.concat(rows, ignore_index=True), pd.DataFrame(cfg_rows)


def geometry_matrix(df: pd.DataFrame, rules: list[str]) -> np.ndarray:
    parts = [df[c].to_numpy(dtype=float)[:, None] for c in STATE_FEATURES]
    rs = np.where(df.ref_p.to_numpy(dtype=float) >= 0.5, 1.0, -1.0)
    signed = []
    for rr in rules:
        p = np.clip(df[f"rule_p__{rr}"].to_numpy(dtype=float), 1e-6, 1 - 1e-6)
        z = np.log(p / (1.0 - p))
        support = np.sign(z) * rs
        share = df[f"rule_weight_share__{rr}"].to_numpy(dtype=float)
        signed.append((share * support)[:, None])
    return np.hstack(parts + signed)


def robust_center_scale(X: np.ndarray):
    med = np.nanmedian(X, axis=0)
    mad = np.nanmedian(np.abs(X - med), axis=0) * 1.4826
    std = np.nanstd(X, axis=0)
    scale = np.where(mad > 1e-6, mad, np.where(std > 1e-6, std, 1.0))
    return med, scale


def learn_geometry_template(hist: pd.DataFrame, rules: list[str]):
    core = hist[hist.core_selected.astype(bool)].copy()
    if core.empty:
        return None
    correct = r5h6.correctness(core)
    nw = int(correct.sum())
    nl = int((~correct).sum())
    if nw < MIN_CORE_WINS or nl < MIN_CORE_LOSSES:
        return None

    pool = hist[(hist.interaction_score > 0) & np.isfinite(hist.threshold_ratio)].copy()
    if len(pool) < 50:
        pool = hist.copy()
    Xp = geometry_matrix(pool, rules)
    med, scale = robust_center_scale(Xp)

    Xc = (geometry_matrix(core, rules) - med) / scale
    win_centroid = np.nanmean(Xc[correct], axis=0)
    loss_centroid = np.nanmean(Xc[~correct], axis=0)
    dim_weight = np.asarray([1.0] * len(STATE_FEATURES) + [0.5] * len(rules), dtype=float)
    return {
        "median": med,
        "scale": scale,
        "win_centroid": win_centroid,
        "loss_centroid": loss_centroid,
        "dim_weight": dim_weight,
        "core_wins": nw,
        "core_losses": nl,
    }


def geometry_scores(df: pd.DataFrame, rules: list[str], tpl):
    if tpl is None or df.empty:
        return np.full(len(df), np.nan), np.full(len(df), np.nan), np.full(len(df), np.nan)
    X = (geometry_matrix(df, rules) - tpl["median"]) / tpl["scale"]
    w = tpl["dim_weight"]
    den = max(float(w.sum()), 1e-12)
    dwin = np.sqrt(np.nansum(((X - tpl["win_centroid"]) ** 2) * w, axis=1) / den)
    dloss = np.sqrt(np.nansum(((X - tpl["loss_centroid"]) ** 2) * w, axis=1) / den)
    margin = dloss - dwin
    score = margin - 0.25 * dwin
    return score, dwin, dloss


def marginal_base_mask(df: pd.DataFrame, band_low: float, agreement_floor: float, synergy_floor: float, redundancy_cap: float):
    ratio = df.threshold_ratio.to_numpy(dtype=float)
    return (
        (~df.core_selected.astype(bool).to_numpy())
        & np.isfinite(ratio)
        & (ratio >= float(band_low))
        & (ratio < 1.0)
        & (df.interaction_score.to_numpy(dtype=float) > 0)
        & (df.interaction_state.to_numpy(dtype=object) == "POSITIVE_INTERACTION")
        & (df.agreement.to_numpy(dtype=float) >= float(agreement_floor))
        & (df.synergy.to_numpy(dtype=float) >= float(synergy_floor))
        & (df.redundancy_exposure.to_numpy(dtype=float) <= float(redundancy_cap))
        & (df.contradiction_pair_risk.to_numpy(dtype=float) <= 0.01)
    )


def choose_expansion(hist: pd.DataFrame) -> dict | None:
    core_mask = hist.core_selected.to_numpy(dtype=bool)
    core_metrics = r5h6.metrics(hist, core_mask)
    if core_metrics["games"] <= 0:
        return None
    best = None
    for band in BAND_LOW:
        for af in AGREEMENT_FLOOR:
            for sf in SYNERGY_FLOOR:
                for rc in REDUNDANCY_CAP:
                    base = marginal_base_mask(hist, band, af, sf, rc)
                    vals = hist.geometry_score.to_numpy(dtype=float)[base]
                    vals = vals[np.isfinite(vals)]
                    if len(vals) < MIN_HIST_MARGINAL:
                        continue
                    for gq in GEOMETRY_QUANTILE:
                        thr = float(np.quantile(vals, float(gq)))
                        marginal = base & np.isfinite(hist.geometry_score.to_numpy(dtype=float)) & (hist.geometry_score.to_numpy(dtype=float) >= thr)
                        mm = r5h6.metrics(hist, marginal)
                        if mm["games"] < MIN_HIST_MARGINAL:
                            continue
                        combined = core_mask | marginal
                        cm = r5h6.metrics(hist, combined)
                        preserve = int(
                            mm["accuracy"] >= core_metrics["accuracy"] - 0.01
                            and cm["accuracy"] >= core_metrics["accuracy"] - 0.005
                        )
                        season_acc = []
                        for _, g in hist.groupby("season"):
                            mask = g.game_id.isin(hist.loc[combined, "game_id"]).to_numpy(dtype=bool)
                            m = r5h6.metrics(g, mask)
                            if m["games"]:
                                season_acc.append(m["accuracy"])
                        worst = min(season_acc) if season_acc else 0.0
                        stable = int(worst >= 0.68)
                        row = {
                            "band_low": float(band),
                            "agreement_floor": float(af),
                            "synergy_floor": float(sf),
                            "redundancy_cap": float(rc),
                            "geometry_quantile": float(gq),
                            "geometry_threshold": thr,
                            "history_core_games": core_metrics["games"],
                            "history_core_accuracy": core_metrics["accuracy"],
                            "history_marginal_games": mm["games"],
                            "history_marginal_accuracy": mm["accuracy"],
                            "history_marginal_wilson95_lower": mm["wilson95_lower"],
                            "history_combined_games": cm["games"],
                            "history_combined_accuracy": cm["accuracy"],
                            "history_worst_season_accuracy": float(worst),
                            "preserve_gate": bool(preserve),
                            "stability_gate": bool(stable),
                        }
                        key = (
                            preserve,
                            stable,
                            mm["accuracy"],
                            cm["accuracy"],
                            mm["wilson95_lower"],
                            mm["games"],
                            band,
                            gq,
                        )
                        if best is None or key > best[0]:
                            best = (key, row)
    if best is None or not best[1]["preserve_gate"]:
        return None
    return best[1]


def apply_expansion(te: pd.DataFrame, cfg: dict | None):
    if cfg is None:
        return np.zeros(len(te), dtype=bool)
    base = marginal_base_mask(
        te,
        cfg["band_low"],
        cfg["agreement_floor"],
        cfg["synergy_floor"],
        cfg["redundancy_cap"],
    )
    add = base & np.isfinite(te.geometry_score.to_numpy(dtype=float)) & (
        te.geometry_score.to_numpy(dtype=float) >= float(cfg["geometry_threshold"])
    )
    cap = max(1, int(np.floor(MAX_TARGET_ADD_RATE * len(te))))
    ix = np.flatnonzero(add)
    if len(ix) > cap:
        vals = te.geometry_score.to_numpy(dtype=float)[ix]
        keep = ix[np.argsort(-vals, kind="stable")[:cap]]
        add[:] = False
        add[keep] = True
    return add


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h10-output")
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

    base, base_cfg = build_r5h8_base(meta, rules, a.test_start, a.end_season)
    base["geometry_score"] = np.nan
    base["geometry_distance_win"] = np.nan
    base["geometry_distance_loss"] = np.nan
    base["marginal_selected"] = 0
    base["selected"] = base.core_selected.astype(int)
    config_rows = []

    for y in range(a.test_start, a.end_season + 1):
        iy = base.season.to_numpy(dtype=int) == y
        hist = base[base.season < y].copy()
        te = base[iy].copy()
        if te.empty:
            continue
        tpl = learn_geometry_template(hist, rules)
        if tpl is None:
            config_rows.append({"test_season": int(y), "geometry_ready": False, "reason": "INSUFFICIENT_PRIOR_CORE_WIN_LOSS_SAMPLE"})
            continue

        hs, hdw, hdl = geometry_scores(hist, rules, tpl)
        hist["geometry_score"] = hs
        hist["geometry_distance_win"] = hdw
        hist["geometry_distance_loss"] = hdl
        ts, tdw, tdl = geometry_scores(te, rules, tpl)
        base.loc[iy, "geometry_score"] = ts
        base.loc[iy, "geometry_distance_win"] = tdw
        base.loc[iy, "geometry_distance_loss"] = tdl
        te["geometry_score"] = ts
        te["geometry_distance_win"] = tdw
        te["geometry_distance_loss"] = tdl

        cfg = choose_expansion(hist)
        add = apply_expansion(te, cfg)
        target_ix = base.index[iy]
        base.loc[target_ix, "marginal_selected"] = add.astype(int)
        base.loc[target_ix, "selected"] = (te.core_selected.to_numpy(dtype=bool) | add).astype(int)
        row = {
            "test_season": int(y),
            "geometry_ready": True,
            "template_core_wins": int(tpl["core_wins"]),
            "template_core_losses": int(tpl["core_losses"]),
            "target_marginal_added": int(add.sum()),
        }
        if cfg is None:
            row["reason"] = "NO_PRIOR_MARGINAL_CONFIGURATION_PRESERVED_CORE_ACCURACY"
        else:
            row.update(cfg)
        config_rows.append(row)

    # Matched-confidence control is rebuilt per target season with the same number of final selections.
    base["confidence_control_matched"] = 0
    for y, g in base.groupby("season"):
        cfgrow = base_cfg[base_cfg.test_season == int(y)].iloc[0]
        edges = r5h8.decode_edges(cfgrow.bin_edges)
        floor = float(cfgrow.confidence_floor)
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
        "marginalAddedGames": mm["games"],
        "marginalAddedWins": mm["wins"],
        "marginalAddedLosses": mm["losses"],
        "marginalAddedAccuracy": mm["accuracy"],
        "matchedConfidenceControlGames": cm["games"],
        "matchedConfidenceControlAccuracy": cm["accuracy"],
        "accuracyDeltaVsMatchedConfidence": float(sm["accuracy"] - cm["accuracy"]),
        "bootstrapDeltaVsMatchedConfidence": boot,
        "r5h8HistoricalAccuracy": R5H8_ACC,
        "r5h8HistoricalCoverage": R5H8_COVERAGE,
        "r5h4HistoricalEliteAccuracy": R5H4_ACC,
        "preservesR5H8AccuracyWithinHalfPoint": bool(sm["accuracy"] >= R5H8_ACC - 0.005),
        "expandsCoverageVsR5H8": bool(sm["games"] > corem["games"]),
        "geometryTemplateUsesPriorCoreWinnersAndLosersOnly": True,
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
        "geometryBasis": "PRIOR_ONLY_R5H8_CORE_WINNER_VS_LOSER_CENTROID_WITH_ROBUST_SCALING",
        "marginalBand": "ONLY_BELOW_R5H8_THRESHOLD_AND_POSITIVE_INTERACTION_STATE",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h10-marginal-geometry.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet",
        "reference": REFERENCE,
        "ruleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "design": (
            "reproduce R5H8 core; learn robust prior-only geometry centroid of winning versus losing R5H8 core selections; "
            "consider only just-below-threshold positive-interaction games; add only marginal games whose prior-trained geometry and validation preserve core accuracy"
        ),
        "maxTargetMarginalAddRate": MAX_TARGET_ADD_RATE,
        "automaticProductionPromotion": False,
    }

    base.to_parquet(out / "nfl_r5h10_predictions.parquet", index=False)
    bydf.to_csv(out / "nfl_r5h10_by_season.csv", index=False)
    pd.DataFrame(config_rows).to_csv(out / "nfl_r5h10_config_by_season.csv", index=False)
    base_cfg.to_csv(out / "nfl_r5h10_r5h8_core_config_by_season.csv", index=False)
    (out / "nfl_r5h10_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h10_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h10_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H10_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H10_BY_SEASON")
    print(bydf.to_string(index=False))
    print("NFL_R5H10_CONFIG")
    print(pd.DataFrame(config_rows).to_string(index=False))
    print("NFL_R5H10_COMPLETE")


if __name__ == "__main__":
    main()
