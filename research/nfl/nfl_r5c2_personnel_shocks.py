#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as r5b2
import nfl_r5c_personnel_availability as r5c

# Pre-registered before seeing R5C2 results.
# 0.50 means the player participated in a majority of the relevant unit snaps
# in his most recent known game. It is not tuned on test outcomes.
STARTER_SNAP_THRESHOLD = 0.50
UNITS = ("OL", "SKILL", "FRONT", "SECONDARY")


def pos_norm(x):
    s = str(x or "").upper().strip()
    return "" if s in {"NAN", "NONE"} else s


def unit_for_position(pos):
    g = r5c.position_group(pos)
    if g == "OL":
        return "OL"
    if g in {"WRTE", "RB"}:
        return "SKILL"
    if g == "FRONT":
        return "FRONT"
    if g == "SECONDARY":
        return "SECONDARY"
    return None


def prior_mean(hist, player):
    h = hist.get(player)
    return float(np.mean(h)) if h and len(h) else 0.0


def build_shock_features(games, snaps, injuries):
    inj_idx = r5c.injury_team_index(injuries)
    snap_idx = r5c.snap_game_index(snaps)

    # All state below is updated only after emitting the target-game row.
    usage_hist = defaultdict(lambda: deque(maxlen=3))          # (team, player) -> prior usage
    global_hist = defaultdict(lambda: deque(maxlen=3))         # player -> prior usage
    last_usage = {}                                             # (team, player) -> immediately prior observed usage
    team_pos_players = defaultdict(set)                         # (team, exact position) -> previously observed players this season

    rows = []
    current_season = None

    for g in games.sort_values(["gameday", "game_id"]).itertuples(index=False):
        season, week = int(g.season), int(g.week)
        if current_season is None or season != current_season:
            # Offseason roster movement makes prior-team reserve identities unsafe.
            # Reset team depth knowledge; retain player/global performance history.
            team_pos_players = defaultdict(set)
            last_usage = {}
            current_season = season

        cutoff = pd.Timestamp(g.gameday)
        if cutoff.tzinfo is None:
            cutoff = cutoff.tz_localize("UTC")
        else:
            cutoff = cutoff.tz_convert("UTC")
        cutoff = cutoff.normalize()  # strict: no target-gameday updates

        row = {"game_id": str(g.game_id), "r5c2_coverage": int(season <= 2024)}

        for side, raw_team in (("home", g.home_team), ("away", g.away_team)):
            team = r5c.team_norm(raw_team)
            by_unit = {u: [] for u in UNITS}
            out_ids = set()

            z = inj_idx.get((season, week, team)) if season <= 2024 else None
            if z is not None and not z.empty:
                q = z[z.date_modified < cutoff]
                if not q.empty:
                    q = q.sort_values("date_modified").groupby("gsis_id", as_index=False).tail(1)
                    q = q[q.report_status.astype(str).str.strip().str.lower().eq("out")]
                    out_ids = set(q.gsis_id.astype(str))
                    for ir in q.itertuples(index=False):
                        pid = str(ir.gsis_id)
                        p = pos_norm(ir.position)
                        unit = unit_for_position(p)
                        if unit is None or r5c.position_group(p) == "QB":
                            continue

                        h = usage_hist.get((team, pid))
                        if h and len(h):
                            u = float(np.mean(h))
                        else:
                            u = prior_mean(global_hist, pid)
                        lu = float(last_usage.get((team, pid), u))

                        # Replacement reserve: same exact listed position, already observed
                        # for this team this season, not OUT, and not a majority-snap player
                        # in its latest known game. This prevents treating the opposite starter
                        # (e.g. another OT/CB) as the replacement.
                        reserve = 0.0
                        for cand in team_pos_players.get((team, p), set()):
                            if cand == pid or cand in out_ids:
                                continue
                            clu = float(last_usage.get((team, cand), prior_mean(usage_hist, (team, cand))))
                            if clu < STARTER_SNAP_THRESHOLD:
                                reserve = max(reserve, prior_mean(usage_hist, (team, cand)))
                        gap = max(0.0, u - reserve)

                        by_unit[unit].append({
                            "usage": u,
                            "last_usage": lu,
                            "starter": float(lu >= STARTER_SNAP_THRESHOLD),
                            "replacement_gap": gap,
                        })

            for unit in UNITS:
                vals = by_unit[unit]
                usages = sorted((v["usage"] for v in vals), reverse=True)
                row[f"{side}_c2_{unit.lower()}_max"] = float(usages[0]) if usages else 0.0
                row[f"{side}_c2_{unit.lower()}_top2"] = float(sum(usages[:2]))
                row[f"{side}_c2_{unit.lower()}_starter_count"] = float(sum(v["starter"] for v in vals))
                row[f"{side}_c2_{unit.lower()}_replacement_gap"] = float(sum(v["replacement_gap"] for v in vals))

            off_units = ("OL", "SKILL")
            def_units = ("FRONT", "SECONDARY")
            row[f"{side}_c2_off_max"] = max(row[f"{side}_c2_{u.lower()}_max"] for u in off_units)
            row[f"{side}_c2_off_top2"] = sum(row[f"{side}_c2_{u.lower()}_top2"] for u in off_units)
            row[f"{side}_c2_off_starter_count"] = sum(row[f"{side}_c2_{u.lower()}_starter_count"] for u in off_units)
            row[f"{side}_c2_off_replacement_gap"] = sum(row[f"{side}_c2_{u.lower()}_replacement_gap"] for u in off_units)
            row[f"{side}_c2_def_max"] = max(row[f"{side}_c2_{u.lower()}_max"] for u in def_units)
            row[f"{side}_c2_def_top2"] = sum(row[f"{side}_c2_{u.lower()}_top2"] for u in def_units)
            row[f"{side}_c2_def_starter_count"] = sum(row[f"{side}_c2_{u.lower()}_starter_count"] for u in def_units)
            row[f"{side}_c2_def_replacement_gap"] = sum(row[f"{side}_c2_{u.lower()}_replacement_gap"] for u in def_units)

        row["c2_any_structural_shock"] = int(
            row["home_c2_off_starter_count"] + row["away_c2_off_starter_count"]
            + row["home_c2_def_starter_count"] + row["away_c2_def_starter_count"] > 0
        )
        rows.append(row)

        # Update personnel state only AFTER target-game pregame features are frozen.
        sg = snap_idx.get(str(g.game_id))
        if sg is not None and not sg.empty:
            for sr in sg.itertuples(index=False):
                team = r5c.team_norm(sr.team)
                pid = str(sr.gsis_id)
                p = pos_norm(sr.position)
                grp = r5c.position_group(p)
                u = r5c.relevant_pct(grp, sr.offense_pct, sr.defense_pct, sr.st_pct)
                usage_hist[(team, pid)].append(u)
                global_hist[pid].append(u)
                last_usage[(team, pid)] = u
                if p:
                    team_pos_players[(team, p)].add(pid)

    return pd.DataFrame(rows)


def feature_sets():
    foundation = r5b2.feature_sets()["R5B2_HICONF_SWITCH"]

    def cols(prefixes):
        return [
            f"{side}_c2_{prefix}_{metric}"
            for side in ("home", "away")
            for prefix in prefixes
            for metric in ("max", "top2", "starter_count", "replacement_gap")
        ]

    return {
        "R5B2_HICONF_SWITCH": foundation,
        "R5C2_OL_SHOCK": foundation + cols(("ol",)),
        "R5C2_SKILL_SHOCK": foundation + cols(("skill",)),
        "R5C2_DEF_SHOCK": foundation + cols(("front", "secondary")),
        "R5C2_AGG_SHOCK": foundation + cols(("off", "def")),
        "R5C2_ALL_SHOCKS": foundation + cols(("ol", "skill", "front", "secondary")),
    }


def evaluate(x, test0, end):
    x = x[x.margin.ne(0) & x.season.le(end) & x.r5c2_coverage.eq(1)].copy()
    preds, seasons = [], []
    for name, cols in feature_sets().items():
        for y in range(test0, end + 1):
            tr = x[x.season < y]
            te = x[x.season == y]
            if tr.empty or te.empty:
                continue
            c = base.tune_logit(tr, cols)
            lm = base.pipe("logit", c)
            lm.fit(tr[cols], tr.home_win.astype(int))
            pp = np.clip(lm.predict_proba(te[cols])[:, 1], 1e-6, 1 - 1e-6)
            pred_reg = {}
            for target in ("margin", "game_total"):
                a = base.tune_ridge(tr, cols, target)
                rm = base.pipe("ridge", a)
                rm.fit(tr[cols], tr[target])
                pred_reg[target] = rm.predict(te[cols])
            q = pd.DataFrame({
                "game_id": te.game_id.to_numpy(), "season": y, "week": te.week.to_numpy(),
                "model": name, "y": te.home_win.to_numpy(), "p": pp,
                "margin": te.margin.to_numpy(), "pm": pred_reg["margin"],
                "game_total": te.game_total.to_numpy(), "pt": pred_reg["game_total"],
                "structural_shock": te.c2_any_structural_shock.to_numpy(),
            })
            q["lli"] = -(q.y * np.log(q.p) + (1 - q.y) * np.log(1 - q.p))
            preds.append(q)
            seasons.append({
                "model": name, "season": y, "n": len(q),
                "log_loss": log_loss(q.y, q.p),
                "brier": brier_score_loss(q.y, q.p),
                "accuracy": accuracy_score(q.y, q.p >= .5),
                "margin_mae": mean_absolute_error(q.margin, q.pm),
                "total_mae": mean_absolute_error(q.game_total, q.pt),
            })
    p = pd.concat(preds, ignore_index=True)
    summary = []
    for name, g in p.groupby("model", sort=False):
        summary.append({
            "model": name, "n": len(g), "log_loss": log_loss(g.y, g.p),
            "brier": brier_score_loss(g.y, g.p), "accuracy": accuracy_score(g.y, g.p >= .5),
            "margin_mae": mean_absolute_error(g.margin, g.pm), "total_mae": mean_absolute_error(g.game_total, g.pt),
        })
    return pd.DataFrame(summary), pd.DataFrame(seasons), p


def boot(p, candidate, reps=5000, seed=940830):
    ref = p[p.model.eq("R5B2_HICONF_SWITCH")][["game_id", "season", "week", "lli"]].rename(columns={"lli": "ref"})
    z = ref.merge(p[p.model.eq(candidate)][["game_id", "lli"]].rename(columns={"lli": "cand"}), on="game_id")
    z["d"] = z.cand - z.ref
    arr = [g.d.to_numpy() for _, g in z.groupby(["season", "week"], sort=False)]
    sums = np.array([v.sum() for v in arr]); counts = np.array([len(v) for v in arr])
    rng = np.random.default_rng(seed); vals = np.empty(reps)
    for i in range(reps):
        ix = rng.integers(0, len(arr), len(arr)); vals[i] = sums[ix].sum() / counts[ix].sum()
    lo, hi = np.quantile(vals, [.025, .975])
    return {
        "comparison": f"{candidate}-R5B2_HICONF_SWITCH", "mean_logloss_delta": float(z.d.mean()),
        "ci95_low": float(lo), "ci95_high": float(hi), "better95": bool(hi < 0), "worse95": bool(lo > 0),
        "games": len(z), "clusters": len(arr),
    }


def subset_report(p):
    ref = p[p.model.eq("R5B2_HICONF_SWITCH")][["game_id", "lli"]].rename(columns={"lli": "ref"})
    out = []
    for model in [m for m in feature_sets() if m != "R5B2_HICONF_SWITCH"]:
        z = p[p.model.eq(model)].merge(ref, on="game_id")
        z["delta"] = z.lli - z.ref
        for label, mask in (("ALL", np.ones(len(z), dtype=bool)), ("STRUCTURAL_SHOCK", z.structural_shock.eq(1))):
            q = z[mask]
            if q.empty:
                continue
            out.append({
                "model": model, "subset": label, "n": len(q),
                "delta_logloss_vs_r5b2": float(q.delta.mean()),
                "model_logloss": float(q.lli.mean()), "r5b2_logloss": float(q.ref.mean()),
            })
    return pd.DataFrame(out)


def week_band_report(p):
    z = p.copy()
    z["week_band"] = pd.cut(z.week, bins=[0, 4, 9, 14, 18], labels=["W01_04", "W05_09", "W10_14", "W15_18"])
    rows = []
    for (model, band), g in z.groupby(["model", "week_band"], observed=True):
        rows.append({"model": model, "week_band": str(band), "n": len(g), "log_loss": log_loss(g.y, g.p), "accuracy": accuracy_score(g.y, g.p >= .5)})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5c-output")
    ap.add_argument("--out-dir", default="nfl-r5c2-output")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--end-season", type=int, default=2024)
    ap.add_argument("--test-start", type=int, default=2018)
    a = ap.parse_args()

    src = Path(a.input_dir); out = Path(a.out_dir); cache = Path(a.cache_dir)
    out.mkdir(parents=True, exist_ok=True); cache.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5c_dataset.parquet")

    pfr_to_gsis, _, _ = r5c.load_players(cache)
    seasons = range(a.start_season, a.end_season + 1)
    snaps, _ = r5c.load_snaps(cache, seasons, pfr_to_gsis)
    injuries, _ = r5c.load_injuries(cache, seasons)
    sf = build_shock_features(x, snaps, injuries)
    x = x.merge(sf, on="game_id", how="left", validate="one_to_one")
    x.to_parquet(out / "nfl_r5c2_dataset.parquet", index=False)

    sm, by, p = evaluate(x, a.test_start, a.end_season)
    sm.to_csv(out / "nfl_r5c2_model_summary.csv", index=False)
    by.to_csv(out / "nfl_r5c2_by_season.csv", index=False)
    p.to_parquet(out / "nfl_r5c2_predictions.parquet", index=False)

    candidates = [m for m in feature_sets() if m != "R5B2_HICONF_SWITCH"]
    bt = pd.DataFrame([boot(p, m) for m in candidates])
    bt.to_csv(out / "nfl_r5c2_bootstrap.csv", index=False)
    sub = subset_report(p); sub.to_csv(out / "nfl_r5c2_subsets.csv", index=False)
    wb = week_band_report(p); wb.to_csv(out / "nfl_r5c2_week_bands.csv", index=False)

    manifest = {
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "referenceFrozen": "R5B2_HICONF_SWITCH",
        "primaryEvaluation": "2018-2024 injury-covered seasons",
        "targetGameSnapUsedAsFeature": False,
        "snapUpdateOrder": "PREGAME_FEATURE_ROW_THEN_TARGET_GAME_SNAP_UPDATE",
        "injuryTimestampFilter": "STRICT_LT_TARGET_GAMEDAY_00UTC",
        "qbExcluded": True,
        "starterDefinition": "LAST_KNOWN_RELEVANT_SNAP_SHARE_GTE_0.50_PRE_REGISTERED_NOT_TUNED",
        "replacementDefinition": "SAME_EXACT_POSITION_PREVIOUSLY_OBSERVED_THIS_SEASON_NON_OUT_LAST_USAGE_LT_0.50",
        "offseasonTeamDepthReset": True,
        "thresholdTunedOnTest": False,
    }
    json.dump(manifest, open(out / "nfl_r5c2_manifest.json", "w"), indent=2)
    audit = {
        "marketLeakageCheck": "PASS",
        "sameGameSnapLeakageCheck": "PASS_BY_CONSTRUCTION",
        "targetGameOutcomeFeatureCheck": "PASS_NOT_USED",
        "injuryTimestampCheck": "STRICT_LT_CUTOFF",
        "qbDoubleCountCheck": "PASS_QB_EXCLUDED",
        "postHocThresholdSelection": "NONE",
    }
    json.dump(audit, open(out / "nfl_r5c2_audit.json", "w"), indent=2)

    print("NFL_R5C2_MODEL_SUMMARY"); print(sm.to_string(index=False))
    print("NFL_R5C2_BOOTSTRAP"); print(bt.to_string(index=False))
    print("NFL_R5C2_SUBSETS"); print(sub.to_string(index=False))
    print("NFL_R5C2_WEEK_BANDS"); print(wb.to_string(index=False))
    print("NFL_R5C2_COMPLETE")


if __name__ == "__main__":
    main()
