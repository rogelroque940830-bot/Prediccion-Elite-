#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

import nfl_r5_leakage_safe as base
import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h3_rival_matchup_rule_engine as r5h3
import nfl_r5h6_confidence_stratified_residual_rule_engine as r5h6
import nfl_r5h8_interaction_contradiction_engine as r5h8
import nfl_r5h10_marginal_geometry_expansion as r5h10

REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H15_INDEPENDENT_SIGNAL_FAMILY_DISCOVERY"
SEED = 940830

PBP_EXTRA = [
    "game_id", "season_type", "posteam", "defteam", "epa", "success",
    "pass_attempt", "rush_attempt", "qb_dropback", "no_play", "qb_kneel", "qb_spike",
    "interception", "fumble_lost", "down", "first_down", "touchdown", "yardline_100",
    "score_differential", "qtr",
]

STATE_METRICS = [
    "off_turnover_rate", "def_takeaway_rate",
    "off_early_down_epa", "def_early_down_epa",
    "off_early_down_success", "def_early_down_success",
    "off_late_down_conversion", "def_late_down_conversion_allowed",
    "off_red_zone_epa", "def_red_zone_epa",
    "off_red_zone_success", "def_red_zone_success",
    "off_neutral_pass_rate", "def_neutral_pass_rate_faced",
]

THRESHOLD_QUANTILES = (0.70, 0.75, 0.80, 0.85, 0.90, 0.925, 0.95)
VALIDATION_SEASONS = 2
MIN_VALIDATION_SELECTIONS = 12
MIN_VALIDATION_PER_SEASON = 3
MIN_VALIDATION_ACCURACY = 0.70
MIN_VALIDATION_DELTA_VS_MATCHED = 0.00
MAX_TARGET_ADD_RATE = 0.10


def new_rule_blocks() -> dict[str, list[str]]:
    return {
        "TURNOVER_SECURITY_TAKEAWAY": [
            "home_off_turnover_rate", "home_def_takeaway_rate",
            "away_off_turnover_rate", "away_def_takeaway_rate",
        ],
        "EARLY_DOWN_EFFICIENCY": [
            "home_off_early_down_epa", "home_def_early_down_epa",
            "away_off_early_down_epa", "away_def_early_down_epa",
            "home_off_early_down_success", "home_def_early_down_success",
            "away_off_early_down_success", "away_def_early_down_success",
        ],
        "LATE_DOWN_CONVERSION": [
            "home_off_late_down_conversion", "home_def_late_down_conversion_allowed",
            "away_off_late_down_conversion", "away_def_late_down_conversion_allowed",
        ],
        "RED_ZONE_FINISHING": [
            "home_off_red_zone_epa", "home_def_red_zone_epa",
            "away_off_red_zone_epa", "away_def_red_zone_epa",
            "home_off_red_zone_success", "home_def_red_zone_success",
            "away_off_red_zone_success", "away_def_red_zone_success",
        ],
        "NEUTRAL_PASS_TENDENCY": [
            "home_off_neutral_pass_rate", "home_def_neutral_pass_rate_faced",
            "away_off_neutral_pass_rate", "away_def_neutral_pass_rate_faced",
        ],
        "REST_SCHEDULE": [
            "home_rest_days", "away_rest_days", "rest_days_diff",
            "home_short_rest", "away_short_rest", "home_long_rest", "away_long_rest",
        ],
    }


def _numeric(x: pd.DataFrame, col: str, default=np.nan) -> pd.Series:
    if col not in x:
        return pd.Series(default, index=x.index, dtype=float)
    return pd.to_numeric(x[col], errors="coerce")


def aggregate_extra_pbp(cache: Path, seasons: list[int]) -> tuple[pd.DataFrame, list[dict]]:
    rows: list[pd.DataFrame] = []
    provenance: list[dict] = []
    for y in seasons:
        p = base.dl(base.PBP_URL.format(y=y), cache / f"play_by_play_{y}.parquet")
        names = set(pq.ParquetFile(p).schema.names)
        cols = [c for c in PBP_EXTRA if c in names]
        x = pd.read_parquet(p, columns=cols)
        if "season_type" in x:
            x = x[x.season_type.eq("REG")]
        for c in ("no_play", "qb_kneel", "qb_spike"):
            if c in x:
                x = x[_numeric(x, c, 0).fillna(0).eq(0)]

        if "posteam" not in x or "defteam" not in x:
            raise RuntimeError(f"R5H15 {y}: posteam/defteam unavailable")
        x = x[x.game_id.notna() & x.posteam.notna() & x.defteam.notna()].copy()

        pa = _numeric(x, "pass_attempt", 0).fillna(0).eq(1)
        ra = _numeric(x, "rush_attempt", 0).fillna(0).eq(1)
        x = x[pa | ra].copy()
        if x.empty:
            continue

        epa = _numeric(x, "epa")
        success = _numeric(x, "success")
        interception = _numeric(x, "interception", 0).fillna(0)
        fumble_lost = _numeric(x, "fumble_lost", 0).fillna(0)
        down = _numeric(x, "down")
        first_down = _numeric(x, "first_down", 0).fillna(0)
        touchdown = _numeric(x, "touchdown", 0).fillna(0)
        yardline = _numeric(x, "yardline_100")
        score_diff = _numeric(x, "score_differential")
        qtr = _numeric(x, "qtr")
        pass_play = (_numeric(x, "qb_dropback", 0).fillna(0).eq(1) | _numeric(x, "pass_attempt", 0).fillna(0).eq(1)).astype(float)

        x["turnover"] = np.maximum(interception.to_numpy(dtype=float), fumble_lost.to_numpy(dtype=float))
        x["early"] = down.le(2).astype(float)
        x["late"] = down.ge(3).astype(float)
        x["conversion"] = np.maximum(first_down.to_numpy(dtype=float), touchdown.to_numpy(dtype=float))
        x["red_zone"] = yardline.le(20).astype(float)
        x["neutral"] = (down.le(2) & qtr.le(3) & score_diff.abs().le(8)).astype(float)
        x["pass_play"] = pass_play
        x["epa_num"] = epa
        x["success_num"] = success

        def grouped(team_col: str, defensive: bool) -> pd.DataFrame:
            out = []
            for (gid, team), g in x.groupby(["game_id", team_col], sort=False):
                early = g.early.eq(1) & g.epa_num.notna()
                late = g.late.eq(1)
                rz = g.red_zone.eq(1) & g.epa_num.notna()
                neutral = g.neutral.eq(1)
                rec = {"game_id": gid, "team": team}
                if defensive:
                    rec["def_takeaway_rate"] = float(g.turnover.mean()) if len(g) else np.nan
                    rec["def_early_down_epa"] = float(g.loc[early, "epa_num"].mean()) if early.any() else np.nan
                    rec["def_early_down_success"] = float(g.loc[early, "success_num"].mean()) if early.any() else np.nan
                    rec["def_late_down_conversion_allowed"] = float(g.loc[late, "conversion"].mean()) if late.any() else np.nan
                    rec["def_red_zone_epa"] = float(g.loc[rz, "epa_num"].mean()) if rz.any() else np.nan
                    rec["def_red_zone_success"] = float(g.loc[rz, "success_num"].mean()) if rz.any() else np.nan
                    rec["def_neutral_pass_rate_faced"] = float(g.loc[neutral, "pass_play"].mean()) if neutral.any() else np.nan
                else:
                    rec["off_turnover_rate"] = float(g.turnover.mean()) if len(g) else np.nan
                    rec["off_early_down_epa"] = float(g.loc[early, "epa_num"].mean()) if early.any() else np.nan
                    rec["off_early_down_success"] = float(g.loc[early, "success_num"].mean()) if early.any() else np.nan
                    rec["off_late_down_conversion"] = float(g.loc[late, "conversion"].mean()) if late.any() else np.nan
                    rec["off_red_zone_epa"] = float(g.loc[rz, "epa_num"].mean()) if rz.any() else np.nan
                    rec["off_red_zone_success"] = float(g.loc[rz, "success_num"].mean()) if rz.any() else np.nan
                    rec["off_neutral_pass_rate"] = float(g.loc[neutral, "pass_play"].mean()) if neutral.any() else np.nan
                out.append(rec)
            return pd.DataFrame(out)

        off = grouped("posteam", False)
        deff = grouped("defteam", True)
        tm = off.merge(deff, on=["game_id", "team"], how="outer", validate="one_to_one")
        rows.append(tm)
        provenance.append({
            "season": int(y),
            "url": base.PBP_URL.format(y=y),
            "bytes": int(p.stat().st_size),
            "loaded_columns": cols,
        })
        print("R5H15_AGG", y, len(tm))

    if not rows:
        raise RuntimeError("R5H15 could not aggregate supplementary PBP")
    return pd.concat(rows, ignore_index=True), provenance


def _state_value(state: dict, key: str) -> float:
    v = state.get(key, np.nan)
    return float(v) if v is not None and np.isfinite(v) else np.nan


def _state_update(state: dict, key: str, value: float, alpha: float) -> None:
    if value is None or not np.isfinite(value):
        return
    old = state.get(key, np.nan)
    state[key] = float(value) if not np.isfinite(old) else float((1.0 - alpha) * old + alpha * value)


def build_pregame_supplement(games: pd.DataFrame, team_metrics: pd.DataFrame, alpha: float = 0.22) -> pd.DataFrame:
    lookup = {
        (str(r.game_id), str(r.team)): r._asdict()
        for r in team_metrics.itertuples(index=False)
    }
    states: dict[str, dict] = {}
    last_date: dict[str, pd.Timestamp] = {}
    rows = []
    current_season = None

    for g in games.sort_values(["gameday", "game_id"]).itertuples(index=False):
        if current_season is not None and int(g.season) != int(current_season):
            for s in states.values():
                for k in STATE_METRICS:
                    v = _state_value(s, k)
                    if np.isfinite(v):
                        s[k] = 0.75 * v
            last_date = {}
        current_season = int(g.season)

        h, a = str(g.home_team), str(g.away_team)
        hs = states.setdefault(h, {})
        as_ = states.setdefault(a, {})
        gd = pd.Timestamp(g.gameday)

        def rest(team: str) -> float:
            d = last_date.get(team)
            if d is None or pd.isna(d):
                return np.nan
            return float(np.clip((gd - d).days, 3, 21))

        hr, ar = rest(h), rest(a)
        r = {
            "game_id": str(g.game_id),
            "season": int(g.season),
            "week": int(g.week),
            "home_rest_days": hr,
            "away_rest_days": ar,
            "rest_days_diff": hr - ar if np.isfinite(hr) and np.isfinite(ar) else np.nan,
            "home_short_rest": float(np.isfinite(hr) and hr <= 6),
            "away_short_rest": float(np.isfinite(ar) and ar <= 6),
            "home_long_rest": float(np.isfinite(hr) and hr >= 10),
            "away_long_rest": float(np.isfinite(ar) and ar >= 10),
        }
        for k in STATE_METRICS:
            r[f"home_{k}"] = _state_value(hs, k)
            r[f"away_{k}"] = _state_value(as_, k)
        rows.append(r)

        hm = lookup.get((str(g.game_id), h), {})
        am = lookup.get((str(g.game_id), a), {})
        for k in STATE_METRICS:
            _state_update(hs, k, float(hm.get(k, np.nan)), alpha)
            _state_update(as_, k, float(am.get(k, np.nan)), alpha)
        last_date[h] = gd
        last_date[a] = gd

    return pd.DataFrame(rows)


def matched_residual_control(df: pd.DataFrame, selected: np.ndarray, base_cfg: pd.DataFrame) -> np.ndarray:
    out = np.zeros(len(df), dtype=bool)
    pos = pd.Series(np.arange(len(df)), index=df.index)
    for y, g in df.groupby("season"):
        cfg = base_cfg[base_cfg.test_season == int(y)]
        if cfg.empty:
            continue
        r = cfg.iloc[0]
        edges = r5h8.decode_edges(r.bin_edges)
        floor = float(r.confidence_floor)
        residual = ~g.core_selected.to_numpy(dtype=bool)
        if not residual.any():
            continue
        local_ix = pos.loc[g.index].to_numpy(dtype=int)
        local_sel = selected[local_ix]
        gr = g.loc[g.index[residual]].copy()
        selr = local_sel[residual]
        mr = r5h6.matched_confidence_within_bins(gr, selr, edges, floor)
        target = local_ix[residual]
        out[target] = mr
    return out


def family_support_score(df: pd.DataFrame, family: str) -> np.ndarray:
    rp = np.clip(df.ref_p.to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    fp = np.clip(df[f"p__{family}"].to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    ref_side = np.where(rp >= 0.5, 1.0, -1.0)
    z = np.log(fp / (1.0 - fp))
    return ref_side * z


def choose_family_threshold(hist: pd.DataFrame, family: str, base_cfg: pd.DataFrame) -> tuple[dict | None, pd.DataFrame]:
    years = sorted(int(v) for v in hist.season.unique())
    if len(years) < VALIDATION_SEASONS:
        return None, pd.DataFrame()
    val_years = years[-VALIDATION_SEASONS:]
    val = hist[hist.season.isin(val_years)].copy()
    residual = ~val.core_selected.to_numpy(dtype=bool)
    score = family_support_score(val, family)
    eligible = residual & np.isfinite(score) & (score > 0)
    vals = score[eligible]
    if len(vals) < MIN_VALIDATION_SELECTIONS:
        return None, pd.DataFrame()

    best = None
    rows = []
    for q in THRESHOLD_QUANTILES:
        thr = float(np.quantile(vals, q))
        sel = eligible & (score >= thr)
        sm = r5h6.metrics(val, sel)
        if sm["games"] < MIN_VALIDATION_SELECTIONS:
            continue
        per_season = []
        valid = True
        for _, g in val.groupby("season"):
            loc = val.index.get_indexer(g.index)
            lm = sel[loc]
            gm = r5h6.metrics(g, lm)
            if gm["games"] < MIN_VALIDATION_PER_SEASON:
                valid = False
                break
            per_season.append(gm["accuracy"])
        if not valid:
            continue
        matched = matched_residual_control(val, sel, base_cfg)
        bm = r5h6.metrics(val, matched)
        delta = float(sm["accuracy"] - bm["accuracy"]) if bm["games"] else float("nan")
        gate = bool(
            sm["accuracy"] >= MIN_VALIDATION_ACCURACY
            and np.isfinite(delta)
            and delta >= MIN_VALIDATION_DELTA_VS_MATCHED
            and min(per_season) >= 0.60
        )
        row = {
            "family": family,
            "validation_seasons": json.dumps(val_years),
            "quantile": float(q),
            "threshold": thr,
            "selected_games": sm["games"],
            "selected_accuracy": sm["accuracy"],
            "selected_wilson95_lower": sm["wilson95_lower"],
            "matched_games": bm["games"],
            "matched_accuracy": bm["accuracy"],
            "delta_vs_matched": delta,
            "worst_validation_season_accuracy": float(min(per_season)),
            "gate": gate,
        }
        rows.append(row)
        key = (
            int(gate),
            delta if np.isfinite(delta) else -9.0,
            sm["accuracy"],
            sm["wilson95_lower"],
            sm["games"],
            float(q),
        )
        if best is None or key > best[0]:
            best = (key, row)

    if best is None or not bool(best[1]["gate"]):
        return None, pd.DataFrame(rows)
    return best[1], pd.DataFrame(rows)


def apply_family_threshold(te: pd.DataFrame, family: str, cfg: dict | None) -> tuple[np.ndarray, np.ndarray]:
    score = family_support_score(te, family)
    if cfg is None:
        return np.zeros(len(te), dtype=bool), score
    sel = (
        (~te.core_selected.to_numpy(dtype=bool))
        & np.isfinite(score)
        & (score > 0)
        & (score >= float(cfg["threshold"]))
    )
    cap = max(1, int(math.floor(MAX_TARGET_ADD_RATE * len(te))))
    ix = np.flatnonzero(sel)
    if len(ix) > cap:
        keep = ix[np.argsort(-score[ix], kind="stable")[:cap]]
        sel[:] = False
        sel[keep] = True
    return sel, score


def bootstrap_selected_vs_matched(df: pd.DataFrame, selected_col: str, matched_col: str, reps: int = 10000) -> dict:
    z = df.copy()
    sc = r5h6.correctness(z).astype(float)
    s = z[selected_col].to_numpy(dtype=bool)
    m = z[matched_col].to_numpy(dtype=bool)
    groups = []
    for _, g in z.groupby(["season", "week"], sort=False):
        ix = z.index.get_indexer(g.index)
        groups.append((float(sc[ix][s[ix]].sum()), int(s[ix].sum()), float(sc[ix][m[ix]].sum()), int(m[ix].sum())))
    if not groups:
        return {"mean_delta": None, "ci95_low": None, "ci95_high": None, "reps": 0}
    arr = np.asarray(groups, dtype=float)
    rng = np.random.default_rng(SEED)
    vals = []
    for _ in range(reps):
        ii = rng.integers(0, len(arr), len(arr))
        a = arr[ii].sum(axis=0)
        if a[1] <= 0 or a[3] <= 0:
            continue
        vals.append(a[0] / a[1] - a[2] / a[3])
    if not vals:
        return {"mean_delta": None, "ci95_low": None, "ci95_high": None, "reps": 0}
    vals = np.asarray(vals, dtype=float)
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {
        "mean_delta": float(vals.mean()),
        "ci95_low": float(lo),
        "ci95_high": float(hi),
        "better95": bool(lo > 0),
        "reps": int(len(vals)),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h15-output")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()

    src, out, cache = Path(a.input_dir), Path(a.out_dir), Path(a.cache_dir)
    out.mkdir(parents=True, exist_ok=True)

    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()
    seasons = list(range(a.start_season, a.end_season + 1))
    games = base.schedule(cache, seasons)
    tm, provenance = aggregate_extra_pbp(cache, seasons)
    supplement = build_pregame_supplement(games, tm)

    x2 = x.merge(
        supplement.drop(columns=["season", "week"]),
        on="game_id",
        how="left",
        validate="one_to_one",
    )
    blocks = new_rule_blocks()
    missing = {name: [c for c in cols if c not in x2.columns] for name, cols in blocks.items()}
    missing = {k: v for k, v in missing.items() if v}
    if missing:
        raise RuntimeError(f"R5H15 missing supplementary features: {missing}")

    original_blocks = r5h3.expanded_rule_blocks()
    original_rules = list(original_blocks)
    r5h.rule_blocks = r5h3.expanded_rule_blocks
    core_experts, _ = r5h.expert_oos(x2, a.expert_oos_start, a.end_season)
    ref = r5h4.reference_oos(x2, a.expert_oos_start, a.end_season)
    core_meta = core_experts.merge(ref, on=["game_id", "season", "week"], validate="one_to_one")
    core, core_cfg = r5h10.build_r5h8_base(core_meta, original_rules, a.test_start, a.end_season)

    r5h.rule_blocks = new_rule_blocks
    new_experts, tuning = r5h.expert_oos(x2, a.expert_oos_start, a.end_season)
    cols = ["game_id", "season", "week"] + [f"p__{f}" for f in blocks]
    meta = core.merge(new_experts[cols], on=["game_id", "season", "week"], validate="one_to_one")

    family_cfg_rows = []
    inner_rows = []
    for family in blocks:
        meta[f"selected__{family}"] = 0
        meta[f"matched__{family}"] = 0
        meta[f"support_score__{family}"] = np.nan

    for y in range(a.test_start, a.end_season + 1):
        iy = meta.season.to_numpy(dtype=int) == y
        te = meta[iy].copy()
        hist = meta[meta.season < y].copy()
        if te.empty or hist.empty:
            continue
        for family in blocks:
            cfg, search = choose_family_threshold(hist, family, core_cfg)
            if not search.empty:
                search = search.copy()
                search["test_season"] = int(y)
                inner_rows.append(search)
            sel, score = apply_family_threshold(te, family, cfg)
            matched = matched_residual_control(te, sel, core_cfg)
            target_ix = meta.index[iy]
            meta.loc[target_ix, f"selected__{family}"] = sel.astype(int)
            meta.loc[target_ix, f"matched__{family}"] = matched.astype(int)
            meta.loc[target_ix, f"support_score__{family}"] = score
            family_cfg_rows.append({
                "test_season": int(y),
                "family": family,
                "enabled": bool(cfg is not None),
                "target_selected": int(sel.sum()),
                **({} if cfg is None else cfg),
            })

    family_rows = []
    by_season_rows = []
    for family in blocks:
        scol = f"selected__{family}"
        mcol = f"matched__{family}"
        s = meta[scol].to_numpy(dtype=bool)
        m = meta[mcol].to_numpy(dtype=bool)
        sm = r5h6.metrics(meta, s)
        bm = r5h6.metrics(meta, m)
        combined = meta.core_selected.to_numpy(dtype=bool) | s
        cm = r5h6.metrics(meta, combined)
        active = 0
        positive = 0
        nonnegative = 0
        seasonal_acc = []
        for yy, g in meta.groupby("season"):
            loc = meta.index.get_indexer(g.index)
            gs = s[loc]
            gm = m[loc]
            a1 = r5h6.metrics(g, gs)
            b1 = r5h6.metrics(g, gm)
            cc = r5h6.metrics(g, g.core_selected.to_numpy(dtype=bool) | gs)
            if a1["games"]:
                active += 1
                seasonal_acc.append(a1["accuracy"])
                if b1["games"]:
                    d = float(a1["accuracy"] - b1["accuracy"])
                    positive += int(d > 0)
                    nonnegative += int(d >= 0)
                else:
                    d = np.nan
            else:
                d = np.nan
            by_season_rows.append({
                "family": family,
                "season": int(yy),
                "marginal_games": a1["games"],
                "marginal_accuracy": a1["accuracy"],
                "matched_games": b1["games"],
                "matched_accuracy": b1["accuracy"],
                "delta_vs_matched": d,
                "combined_games": cc["games"],
                "combined_accuracy": cc["accuracy"],
            })
        boot = bootstrap_selected_vs_matched(meta, scol, mcol)
        delta = float(sm["accuracy"] - bm["accuracy"]) if bm["games"] and sm["games"] else np.nan
        family_rows.append({
            "family": family,
            "marginal_games": sm["games"],
            "marginal_wins": sm["wins"],
            "marginal_losses": sm["losses"],
            "marginal_accuracy": sm["accuracy"],
            "marginal_wilson95_lower": sm["wilson95_lower"],
            "matched_games": bm["games"],
            "matched_accuracy": bm["accuracy"],
            "delta_vs_matched": delta,
            "combined_games": cm["games"],
            "combined_accuracy": cm["accuracy"],
            "combined_coverage": float(cm["games"] / len(meta)),
            "active_outer_seasons": int(active),
            "positive_outer_seasons_vs_matched": int(positive),
            "nonnegative_outer_seasons_vs_matched": int(nonnegative),
            "worst_active_season_accuracy": float(min(seasonal_acc)) if seasonal_acc else np.nan,
            "bootstrap_mean_delta": boot["mean_delta"],
            "bootstrap_ci95_low": boot["ci95_low"],
            "bootstrap_ci95_high": boot["ci95_high"],
            "better95": bool(boot.get("better95", False)),
        })

    family_summary = pd.DataFrame(family_rows).sort_values(
        ["delta_vs_matched", "marginal_accuracy", "marginal_games"],
        ascending=[False, False, False],
        na_position="last",
    )
    by_season = pd.DataFrame(by_season_rows)
    cfgdf = pd.DataFrame(family_cfg_rows)
    inner = pd.concat(inner_rows, ignore_index=True) if inner_rows else pd.DataFrame()

    corem = r5h6.metrics(meta, meta.core_selected.to_numpy(dtype=bool))
    candidates = family_summary[
        (family_summary.marginal_games >= 12)
        & (family_summary.active_outer_seasons >= 3)
        & (family_summary.delta_vs_matched > 0)
    ].copy()
    qualified = candidates.family.astype(str).tolist()

    summary = {
        "stage": MODEL,
        "researchOnly": True,
        "marketDataUsed": False,
        "productionChanged": False,
        "reference": REFERENCE,
        "allGames": int(len(meta)),
        "r5h8CoreGames": corem["games"],
        "r5h8CoreWins": corem["wins"],
        "r5h8CoreLosses": corem["losses"],
        "r5h8CoreAccuracy": corem["accuracy"],
        "newSignalFamilyCount": int(len(blocks)),
        "newSignalFamilies": list(blocks),
        "discoveryQualifiedFamilies": qualified,
        "discoveryQualifiedFamilyCount": int(len(qualified)),
        "qualificationRule": "at least 12 OOS marginal games, active in at least 3 outer seasons, pooled delta versus matched-confidence control > 0; discovery only",
        "sameGamePbpUsedAsFeature": False,
        "pregameStateUpdatedOnlyAfterEachCompletedGame": True,
        "targetSeasonUsedForExpertFit": False,
        "targetSeasonUsedForThresholdCalibration": False,
        "targetSeasonOutcomesUsedForSelection": False,
        "r5h8CoreProtected": True,
        "referenceConfidenceMagnitudeUsedInFamilySupportScore": False,
        "referenceDirectionUsedForFamilySupport": True,
        "automaticProductionPromotion": False,
        "nextAction": "INTEGRATE_ONLY_DISCOVERY_QUALIFIED_FAMILIES_IN_A_SEPARATE_PRIOR_ONLY_CERTIFICATION_STAGE" if qualified else "NO_NEW_FAMILY_PASSED_DISCOVERY_SCREEN_ADD_NEW_INFORMATION_SOURCES_BEFORE_MORE_REWEIGHTING",
    }
    audit = {
        "marketBoundary": "PASS_MARKET_FREE",
        "supplementalData": "NFLVERSE_PBP_AND_SCHEDULE_ONLY",
        "sameGameFeatureLeakage": "PASS_PREGAME_SNAPSHOT_BEFORE_POSTGAME_STATE_UPDATE",
        "targetSeasonUsedForSignalExpertFit": "NO",
        "targetSeasonUsedForFamilyThresholdCalibration": "NO",
        "targetSeasonUsedForFamilyValidationGate": "NO",
        "targetSeasonOutcomeUsedForTargetSelection": "NO",
        "protectedCore": "PASS_R5H8_CORE_NOT_REMOVED_OR_RETUNED_BY_R5H15",
        "productionCodeTouched": False,
    }
    manifest = {
        "schemaVersion": "courtedge-nfl-r5h15-independent-signal-family-discovery.v1",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "sourceDataset": "nfl_r5b_hybrid_dataset.parquet plus leakage-safe nflverse PBP/schedule supplement",
        "newRuleBlocks": blocks,
        "outerValidation": "expanding-season OOS 2018-2025",
        "familyThresholdSelection": "latest two prior OOS seasons only; residual games outside protected R5H8 core",
        "familyScore": "reference direction times new-family expert logit; reference confidence magnitude excluded",
        "maxTargetMarginalAddRatePerFamily": MAX_TARGET_ADD_RATE,
        "automaticProductionPromotion": False,
        "provenance": provenance,
    }

    supplement.to_parquet(out / "nfl_r5h15_supplemental_pregame_features.parquet", index=False)
    meta.to_parquet(out / "nfl_r5h15_predictions.parquet", index=False)
    family_summary.to_csv(out / "nfl_r5h15_family_summary.csv", index=False)
    by_season.to_csv(out / "nfl_r5h15_by_season.csv", index=False)
    cfgdf.to_csv(out / "nfl_r5h15_config_by_season.csv", index=False)
    inner.to_csv(out / "nfl_r5h15_inner_search.csv", index=False)
    tuning.to_csv(out / "nfl_r5h15_expert_tuning.csv", index=False)
    core_cfg.to_csv(out / "nfl_r5h15_r5h8_core_config_by_season.csv", index=False)
    (out / "nfl_r5h15_summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h15_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    (out / "nfl_r5h15_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("NFL_R5H15_SUMMARY")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print("NFL_R5H15_FAMILY_SUMMARY")
    print(family_summary.to_string(index=False))
    print("NFL_R5H15_BY_SEASON")
    print(by_season.to_string(index=False))
    print("NFL_R5H15_CONFIG")
    print(cfgdf.to_string(index=False))
    print("NFL_R5H15_COMPLETE")


if __name__ == "__main__":
    main()
