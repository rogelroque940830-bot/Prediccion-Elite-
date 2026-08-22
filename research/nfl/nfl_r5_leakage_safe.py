#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, math
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (
    log_loss,
    brier_score_loss,
    accuracy_score,
    mean_absolute_error,
)

PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{y}.parquet"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

FORBIDDEN = ("moneyline", "spread", "total_line", "odds", "price", "vig", "book", "over_under")
SCHED = [
    "game_id", "season", "game_type", "week", "gameday",
    "away_team", "home_team", "away_score", "home_score",
]
PBP = [
    "game_id", "season_type", "posteam", "defteam", "epa", "success",
    "pass_attempt", "rush_attempt", "qb_dropback", "sack", "yards_gained",
    "drive", "no_play", "qb_kneel", "qb_spike", "passer_player_id", "cpoe",
]
EPA = [
    "off_epa", "def_epa", "off_success", "def_success",
    "pass_epa", "def_pass_epa", "rush_epa", "def_rush_epa",
    "pass_success", "def_pass_success", "rush_success", "def_rush_success",
    "sack_rate", "def_sack_rate",
    "explosive_pass", "def_explosive_pass",
    "explosive_rush", "def_explosive_rush",
]
C_GRID = (0.05, 0.10, 0.30, 0.70, 1.50, 3.00)
RIDGE_GRID = (1.0, 4.0, 8.0, 16.0, 32.0)


def dl(url, p):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists() and p.stat().st_size:
        return p
    with requests.get(url, stream=True, timeout=180, headers={"User-Agent": "CourtEdge-NFL-R5"}) as r:
        r.raise_for_status()
        t = Path(str(p) + ".part")
        with t.open("wb") as f:
            for c in r.iter_content(1 << 20):
                if c:
                    f.write(c)
        t.replace(p)
    return p


def schedule(cache, seasons):
    x = pd.read_csv(dl(GAMES_URL, cache / "games.csv"), low_memory=False)
    miss = [c for c in SCHED if c not in x]
    if miss:
        raise RuntimeError(f"missing schedule columns {miss}")
    x = x[SCHED].copy()
    x = x[
        x.season.isin(seasons)
        & x.game_type.eq("REG")
        & x.home_score.notna()
        & x.away_score.notna()
    ]
    x["season"] = x.season.astype(int)
    x["week"] = pd.to_numeric(x.week, errors="coerce")
    x = x[x.week.notna()]
    x["week"] = x.week.astype(int)
    x["gameday"] = pd.to_datetime(x.gameday, errors="coerce")
    x = x[x.gameday.notna()]
    x["margin"] = x.home_score - x.away_score
    x["game_total"] = x.home_score + x.away_score
    x["home_win"] = np.where(x.margin > 0, 1, np.where(x.margin < 0, 0, np.nan))
    return x.sort_values(["gameday", "game_id"]).reset_index(drop=True)


def pbp_games(cache, seasons):
    import pyarrow.parquet as pq

    team_out, qb_out, prov = [], [], []
    for y in seasons:
        p = dl(PBP_URL.format(y=y), cache / f"play_by_play_{y}.parquet")
        names = set(pq.ParquetFile(p).schema.names)
        cols = [c for c in PBP if c in names]
        x = pd.read_parquet(p, columns=cols)

        if "season_type" in x:
            x = x[x.season_type.eq("REG")]

        for c in ["no_play", "qb_kneel", "qb_spike"]:
            if c in x:
                x = x[pd.to_numeric(x[c], errors="coerce").fillna(0).eq(0)]

        for c in [
            "epa", "success", "pass_attempt", "rush_attempt", "qb_dropback",
            "sack", "yards_gained", "cpoe",
        ]:
            if c not in x:
                x[c] = np.nan
            x[c] = pd.to_numeric(x[c], errors="coerce")

        if "passer_player_id" not in x:
            x["passer_player_id"] = np.nan

        x = x[x.game_id.notna() & x.posteam.notna() & x.defteam.notna()]
        x = x[(x.pass_attempt.eq(1) | x.rush_attempt.eq(1)) & x.epa.notna()].copy()
        x["pass"] = x.qb_dropback.eq(1) | x.pass_attempt.eq(1)
        x["rush"] = x.rush_attempt.eq(1)
        x["xp"] = (x["pass"] & x.yards_gained.ge(20)).astype(float)
        x["xr"] = (x["rush"] & x.yards_gained.ge(10)).astype(float)

        base = (
            x.groupby(["game_id", "posteam"])
            .agg(
                off_epa=("epa", "mean"),
                off_success=("success", "mean"),
                plays=("epa", "size"),
                drives=("drive", "nunique"),
            )
            .reset_index()
            .rename(columns={"posteam": "team"})
        )

        def sub(mask, prefix):
            return (
                x[mask]
                .groupby(["game_id", "posteam"])
                .agg(
                    **{
                        f"{prefix}_epa": ("epa", "mean"),
                        f"{prefix}_success": ("success", "mean"),
                    }
                )
                .reset_index()
                .rename(columns={"posteam": "team"})
            )

        pa = sub(x["pass"], "pass")
        ru = sub(x["rush"], "rush")
        sa = (
            x[x["pass"]]
            .groupby(["game_id", "posteam"])
            .agg(sack_rate=("sack", "mean"), explosive_pass=("xp", "mean"))
            .reset_index()
            .rename(columns={"posteam": "team"})
        )
        er = (
            x[x["rush"]]
            .groupby(["game_id", "posteam"])
            .agg(explosive_rush=("xr", "mean"))
            .reset_index()
            .rename(columns={"posteam": "team"})
        )

        team = (
            base.merge(pa, on=["game_id", "team"], how="left")
            .merge(ru, on=["game_id", "team"], how="left")
            .merge(sa, on=["game_id", "team"], how="left")
            .merge(er, on=["game_id", "team"], how="left")
        )
        team_out.append(team)

        q = x[
            x.qb_dropback.eq(1)
            & x.passer_player_id.notna()
            & x.epa.notna()
        ].copy()
        if not q.empty:
            qb = (
                q.groupby(["game_id", "posteam", "passer_player_id"])
                .agg(
                    qb_epa=("epa", "mean"),
                    qb_cpoe=("cpoe", "mean"),
                    qb_sack_rate=("sack", "mean"),
                    qb_dropbacks=("epa", "size"),
                )
                .reset_index()
                .rename(columns={"posteam": "team", "passer_player_id": "qb_id"})
            )
            qb_out.append(qb)

        prov.append({"season": y, "url": PBP_URL.format(y=y), "bytes": p.stat().st_size})
        print("AGG", y, len(team))

    team_df = pd.concat(team_out, ignore_index=True)
    qb_df = (
        pd.concat(qb_out, ignore_index=True)
        if qb_out
        else pd.DataFrame(columns=["game_id", "team", "qb_id", "qb_epa", "qb_cpoe", "qb_sack_rate", "qb_dropbacks"])
    )
    return team_df, qb_df, prov


def val(state, key):
    v = state["v"].get(key, np.nan)
    return float(v) if v is not None else np.nan


def upd(state, key, new, alpha=0.22):
    if new is None or not np.isfinite(new):
        return
    old = state["v"].get(key, np.nan)
    state["v"][key] = float(new) if not np.isfinite(old) else float((1 - alpha) * old + alpha * new)


def qb_value(qb_state, qb_id, key):
    if qb_id is None or qb_id not in qb_state:
        return np.nan
    v = qb_state[qb_id]["v"].get(key, np.nan)
    return float(v) if v is not None else np.nan


def primary_qb(qb_lookup, game_id, team):
    rows = qb_lookup.get((str(game_id), str(team)))
    if rows is None or rows.empty:
        return None
    r = rows.sort_values("qb_dropbacks", ascending=False).iloc[0]
    return str(r.qb_id), r


def dataset(games, team_games, qb_games, alpha=0.22, oa_k=0.20, qb_alpha=0.18):
    team_lk = {(str(r.game_id), str(r.team)): r._asdict() for r in team_games.itertuples(index=False)}
    qb_lk = {
        (str(gid), str(team)): z.copy()
        for (gid, team), z in qb_games.groupby(["game_id", "team"], sort=False)
    }

    st, qb_state, rows = {}, {}, []
    current_season = None

    for g in games.itertuples(index=False):
        if current_season is not None and g.season != current_season:
            for s in st.values():
                for k in EPA:
                    if np.isfinite(val(s, k)):
                        s["v"][k] *= 0.70
                for k in ["points_for", "points_against"]:
                    if np.isfinite(val(s, k)):
                        s["v"][k] = 0.70 * val(s, k) + 0.30 * 22.5
                for k in ["oa_off", "oa_def", "oa_pass_off", "oa_pass_def"]:
                    s[k] *= 0.75
                s["season_n"] = 0
                s["last_qb"] = None
            for qs in qb_state.values():
                for k in list(qs["v"]):
                    if np.isfinite(qs["v"][k]):
                        qs["v"][k] *= 0.80
        current_season = g.season

        h, a = str(g.home_team), str(g.away_team)

        def team_state(team):
            return st.setdefault(
                team,
                {
                    "v": {},
                    "n": 0,
                    "season_n": 0,
                    "oa_off": 0.0,
                    "oa_def": 0.0,
                    "oa_pass_off": 0.0,
                    "oa_pass_def": 0.0,
                    "last_qb": None,
                },
            )

        hs, as_ = team_state(h), team_state(a)
        hq, aq = hs["last_qb"], as_["last_qb"]

        r = {
            "game_id": g.game_id,
            "season": g.season,
            "week": g.week,
            "home_win": g.home_win,
            "margin": g.margin,
            "game_total": g.game_total,
            "home_score": g.home_score,
            "away_score": g.away_score,
            "home_prior_games": hs["n"],
            "away_prior_games": as_["n"],
            "home_season_games": hs["season_n"],
            "away_season_games": as_["season_n"],
            "home_uncertainty": 1 / math.sqrt(hs["season_n"] + 4.0),
            "away_uncertainty": 1 / math.sqrt(as_["season_n"] + 4.0),
            "home_oa_off": hs["oa_off"],
            "home_oa_def": hs["oa_def"],
            "away_oa_off": as_["oa_off"],
            "away_oa_def": as_["oa_def"],
            "home_oa_pass_off": hs["oa_pass_off"],
            "home_oa_pass_def": hs["oa_pass_def"],
            "away_oa_pass_off": as_["oa_pass_off"],
            "away_oa_pass_def": as_["oa_pass_def"],
            "home_qb_proxy_known": int(hq is not None),
            "away_qb_proxy_known": int(aq is not None),
            "home_qb_epa": qb_value(qb_state, hq, "qb_epa"),
            "away_qb_epa": qb_value(qb_state, aq, "qb_epa"),
            "home_qb_cpoe": qb_value(qb_state, hq, "qb_cpoe"),
            "away_qb_cpoe": qb_value(qb_state, aq, "qb_cpoe"),
            "home_qb_sack_rate": qb_value(qb_state, hq, "qb_sack_rate"),
            "away_qb_sack_rate": qb_value(qb_state, aq, "qb_sack_rate"),
            "home_qb_uncertainty": (
                1 / math.sqrt(max(qb_state[hq]["dropbacks"], 1))
                if hq is not None and hq in qb_state else 1.0
            ),
            "away_qb_uncertainty": (
                1 / math.sqrt(max(qb_state[aq]["dropbacks"], 1))
                if aq is not None and aq in qb_state else 1.0
            ),
        }

        keys = ["points_for", "points_against"] + EPA + ["plays", "drives"]
        for k in keys:
            r["home_" + k] = val(hs, k)
            r["away_" + k] = val(as_, k)

        rows.append(r)

        hm = team_lk.get((str(g.game_id), h), {})
        am = team_lk.get((str(g.game_id), a), {})

        h_off_obs = float(hm.get("off_epa", np.nan))
        a_off_obs = float(am.get("off_epa", np.nan))
        h_pass_obs = float(hm.get("pass_epa", np.nan))
        a_pass_obs = float(am.get("pass_epa", np.nan))

        if np.isfinite(h_off_obs):
            e = h_off_obs - (hs["oa_off"] + as_["oa_def"])
            hs["oa_off"] += oa_k * 0.5 * e
            as_["oa_def"] += oa_k * 0.5 * e
        if np.isfinite(a_off_obs):
            e = a_off_obs - (as_["oa_off"] + hs["oa_def"])
            as_["oa_off"] += oa_k * 0.5 * e
            hs["oa_def"] += oa_k * 0.5 * e
        if np.isfinite(h_pass_obs):
            e = h_pass_obs - (hs["oa_pass_off"] + as_["oa_pass_def"])
            hs["oa_pass_off"] += oa_k * 0.5 * e
            as_["oa_pass_def"] += oa_k * 0.5 * e
        if np.isfinite(a_pass_obs):
            e = a_pass_obs - (as_["oa_pass_off"] + hs["oa_pass_def"])
            as_["oa_pass_off"] += oa_k * 0.5 * e
            hs["oa_pass_def"] += oa_k * 0.5 * e

        def updates(me, own, opp, pf, pa_):
            d = {
                "points_for": pf,
                "points_against": pa_,
                "off_epa": own.get("off_epa", np.nan),
                "def_epa": opp.get("off_epa", np.nan),
                "off_success": own.get("off_success", np.nan),
                "def_success": opp.get("off_success", np.nan),
                "pass_epa": own.get("pass_epa", np.nan),
                "def_pass_epa": opp.get("pass_epa", np.nan),
                "rush_epa": own.get("rush_epa", np.nan),
                "def_rush_epa": opp.get("rush_epa", np.nan),
                "pass_success": own.get("pass_success", np.nan),
                "def_pass_success": opp.get("pass_success", np.nan),
                "rush_success": own.get("rush_success", np.nan),
                "def_rush_success": opp.get("rush_success", np.nan),
                "sack_rate": own.get("sack_rate", np.nan),
                "def_sack_rate": opp.get("sack_rate", np.nan),
                "explosive_pass": own.get("explosive_pass", np.nan),
                "def_explosive_pass": opp.get("explosive_pass", np.nan),
                "explosive_rush": own.get("explosive_rush", np.nan),
                "def_explosive_rush": opp.get("explosive_rush", np.nan),
                "plays": own.get("plays", np.nan),
                "drives": own.get("drives", np.nan),
            }
            for k, v in d.items():
                upd(me, k, float(v) if v is not None else np.nan, alpha)

        updates(hs, hm, am, g.home_score, g.away_score)
        updates(as_, am, hm, g.away_score, g.home_score)

        for team, state in [(h, hs), (a, as_)]:
            pq = primary_qb(qb_lk, g.game_id, team)
            if pq is None:
                continue
            qid, qr = pq
            qs = qb_state.setdefault(qid, {"v": {}, "dropbacks": 0})
            for k in ["qb_epa", "qb_cpoe", "qb_sack_rate"]:
                v = getattr(qr, k)
                if v is not None and np.isfinite(v):
                    old = qs["v"].get(k, np.nan)
                    qs["v"][k] = float(v) if not np.isfinite(old) else float((1 - qb_alpha) * old + qb_alpha * float(v))
            qs["dropbacks"] += int(qr.qb_dropbacks)
            state["last_qb"] = qid

        hs["n"] += 1
        as_["n"] += 1
        hs["season_n"] += 1
        as_["season_n"] += 1

    x = pd.DataFrame(rows)
    return x[(x.home_prior_games >= 2) & (x.away_prior_games >= 2)].reset_index(drop=True)


def fsets():
    b1 = [
        "home_points_for", "home_points_against",
        "away_points_for", "away_points_against",
        "home_uncertainty", "away_uncertainty",
    ]
    pair = lambda ks: [f"{s}_{k}" for s in ["home", "away"] for k in ks]
    core = pair(["off_epa", "def_epa", "off_success", "def_success"])
    pas = pair(["pass_epa", "def_pass_epa", "pass_success", "def_pass_success"])
    oa_core = [
        "home_oa_off", "home_oa_def", "away_oa_off", "away_oa_def",
    ]
    oa_pass = [
        "home_oa_pass_off", "home_oa_pass_def",
        "away_oa_pass_off", "away_oa_pass_def",
    ]
    qb = [
        "home_qb_proxy_known", "away_qb_proxy_known",
        "home_qb_epa", "away_qb_epa",
        "home_qb_cpoe", "away_qb_cpoe",
        "home_qb_sack_rate", "away_qb_sack_rate",
        "home_qb_uncertainty", "away_qb_uncertainty",
    ]
    pace = pair(["plays", "drives"])
    return {
        "B0": [],
        "B1": b1,
        "B2_CORE": b1 + core,
        "B2_PASS": b1 + pas,
        "B3_OA_CORE": b1 + core + oa_core,
        "B3_OA_PASS": b1 + pas + oa_pass,
        "B4_QB_ONLY": b1 + qb,
        "B4_QB_CORE": b1 + core + qb,
        "B4_QB_OA": b1 + core + oa_core + qb,
        "B5_QB_OA_PACE": b1 + core + oa_core + qb + pace,
    }


def design(df, cols):
    if cols:
        return df[cols]
    return pd.DataFrame({"constant": np.ones(len(df))}, index=df.index)


def pipe(kind, value):
    model = (
        LogisticRegression(C=float(value), max_iter=3000)
        if kind == "logit"
        else Ridge(alpha=float(value))
    )
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", model),
        ]
    )


def inner_split(tr):
    years = sorted(tr.season.unique())
    if len(years) < 2:
        return tr, tr
    vy = years[-1]
    fit = tr[tr.season < vy]
    val = tr[tr.season == vy]
    if fit.empty or val.empty:
        return tr, tr
    return fit, val


def tune_logit(tr, cols):
    fit, val = inner_split(tr)
    best = None
    for c in C_GRID:
        m = pipe("logit", c)
        m.fit(design(fit, cols), fit.home_win.astype(int))
        p = np.clip(m.predict_proba(design(val, cols))[:, 1], 1e-6, 1 - 1e-6)
        score = log_loss(val.home_win.astype(int), p)
        cand = (score, c)
        if best is None or cand < best:
            best = cand
    return best[1]


def tune_ridge(tr, cols, target):
    fit, val = inner_split(tr)
    best = None
    for a in RIDGE_GRID:
        m = pipe("ridge", a)
        m.fit(design(fit, cols), fit[target])
        pred = m.predict(design(val, cols))
        score = mean_absolute_error(val[target], pred)
        cand = (score, a)
        if best is None or cand < best:
            best = cand
    return best[1]


def ece(y, p):
    z = 0.0
    edges = np.linspace(0, 1, 11)
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (p >= lo) & (p < (hi if hi < 1 else hi + 1e-9))
        if mask.any():
            z += mask.mean() * abs(y[mask].mean() - p[mask].mean())
    return float(z)


def run(x, test0, end):
    x = x[x.margin.ne(0)].copy()
    fs = fsets()

    bad = [c for vv in fs.values() for c in vv if any(t in c.lower() for t in FORBIDDEN)]
    if bad:
        raise RuntimeError("market feature leak " + str(bad))
    if any(any(t in c.lower() for t in FORBIDDEN) for c in x.columns):
        raise RuntimeError("market column in frame")

    preds, seasons, tuning = [], [], []
    for name, cols in fs.items():
        for y in range(test0, end + 1):
            tr = x[x.season < y]
            te = x[x.season == y]
            if tr.empty or te.empty:
                continue

            c = tune_logit(tr, cols)
            lm = pipe("logit", c)
            lm.fit(design(tr, cols), tr.home_win.astype(int))
            p = np.clip(lm.predict_proba(design(te, cols))[:, 1], 1e-6, 1 - 1e-6)

            pr = {}
            chosen_ridge = {}
            for target in ["margin", "game_total", "home_score", "away_score"]:
                a = tune_ridge(tr, cols, target)
                chosen_ridge[target] = a
                m = pipe("ridge", a)
                m.fit(design(tr, cols), tr[target])
                pr[target] = m.predict(design(te, cols))

            tuning.append(
                {
                    "model": name,
                    "test_season": y,
                    "logit_C": c,
                    **{f"ridge_{k}_alpha": v for k, v in chosen_ridge.items()},
                    "inner_validation_season": int(tr.season.max()),
                }
            )

            q = pd.DataFrame(
                {
                    "game_id": te.game_id.to_numpy(),
                    "season": y,
                    "week": te.week.to_numpy(),
                    "model": name,
                    "y": te.home_win.to_numpy(),
                    "p": p,
                    "margin": te.margin.to_numpy(),
                    "pm": pr["margin"],
                    "game_total": te.game_total.to_numpy(),
                    "pt": pr["game_total"],
                    "home_score": te.home_score.to_numpy(),
                    "ph": pr["home_score"],
                    "away_score": te.away_score.to_numpy(),
                    "pa": pr["away_score"],
                }
            )
            q["lli"] = -(q.y * np.log(q.p) + (1 - q.y) * np.log(1 - q.p))
            preds.append(q)
            seasons.append(
                {
                    "model": name,
                    "season": y,
                    "n": len(q),
                    "log_loss": log_loss(q.y, q.p),
                    "brier": brier_score_loss(q.y, q.p),
                    "accuracy": accuracy_score(q.y, q.p >= 0.5),
                    "ece10": ece(q.y.to_numpy(), q.p.to_numpy()),
                    "margin_mae": mean_absolute_error(q.margin, q.pm),
                    "total_mae": mean_absolute_error(q.game_total, q.pt),
                    "home_score_mae": mean_absolute_error(q.home_score, q.ph),
                    "away_score_mae": mean_absolute_error(q.away_score, q.pa),
                }
            )

    p = pd.concat(preds, ignore_index=True)
    summary = []
    for n, g in p.groupby("model", sort=False):
        summary.append(
            {
                "model": n,
                "n": len(g),
                "log_loss": log_loss(g.y, g.p),
                "brier": brier_score_loss(g.y, g.p),
                "accuracy": accuracy_score(g.y, g.p >= 0.5),
                "ece10": ece(g.y.to_numpy(), g.p.to_numpy()),
                "margin_mae": mean_absolute_error(g.margin, g.pm),
                "total_mae": mean_absolute_error(g.game_total, g.pt),
                "home_score_mae": mean_absolute_error(g.home_score, g.ph),
                "away_score_mae": mean_absolute_error(g.away_score, g.pa),
            }
        )
    return pd.DataFrame(summary), pd.DataFrame(seasons), p, pd.DataFrame(tuning)


def boot(p, reps=500):
    rng = np.random.default_rng(940830)
    out = []
    comps = [
        ("B0", "B1"),
        ("B1", "B2_CORE"),
        ("B1", "B2_PASS"),
        ("B2_CORE", "B3_OA_CORE"),
        ("B2_PASS", "B3_OA_PASS"),
        ("B1", "B4_QB_ONLY"),
        ("B2_CORE", "B4_QB_CORE"),
        ("B3_OA_CORE", "B4_QB_OA"),
        ("B4_QB_OA", "B5_QB_OA_PACE"),
    ]
    models = set(p.model)

    for a, b in comps:
        if a not in models or b not in models:
            continue
        x = (
            p[p.model == a][["game_id", "season", "week", "lli"]]
            .rename(columns={"lli": "a"})
            .merge(
                p[p.model == b][["game_id", "lli"]].rename(columns={"lli": "b"}),
                on="game_id",
            )
        )
        x["d"] = x.b - x.a
        clusters = list(x.groupby(["season", "week"]).groups)
        vals = []
        for _ in range(reps):
            ss = [clusters[i] for i in rng.integers(0, len(clusters), len(clusters))]
            vals.append(
                np.mean(
                    np.concatenate(
                        [
                            x[(x.season == s) & (x.week == w)].d.to_numpy()
                            for s, w in ss
                        ]
                    )
                )
            )
        lo, hi = np.quantile(vals, [0.025, 0.975])
        out.append(
            {
                "comparison": b + "-" + a,
                "mean_logloss_delta": x.d.mean(),
                "ci95_low": lo,
                "ci95_high": hi,
                "improvement_supported_95": bool(hi < 0),
            }
        )
    return pd.DataFrame(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--end-season", type=int, default=2025)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--out-dir", default="nfl-r5-output")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    a = ap.parse_args()

    seasons = list(range(a.start_season, a.end_season + 1))
    cache = Path(a.cache_dir)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    games = schedule(cache, seasons)
    team_games, qb_games, prov = pbp_games(cache, seasons)
    x = dataset(games, team_games, qb_games)
    x.to_parquet(out / "nfl_r5_leakage_safe_dataset.parquet", index=False)

    summary, by_season, preds, tuning = run(x, a.test_start, a.end_season)
    deltas = boot(preds)

    summary.to_csv(out / "nfl_r5_model_summary.csv", index=False)
    by_season.to_csv(out / "nfl_r5_by_season.csv", index=False)
    preds.to_parquet(out / "nfl_r5_oos_predictions.parquet", index=False)
    deltas.to_csv(out / "nfl_r5_bootstrap_deltas.csv", index=False)
    tuning.to_csv(out / "nfl_r5_temporal_tuning.csv", index=False)

    manifest = {
        "schemaVersion": "courtedge-nfl-r5-leakage-safe.v2",
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "regularSeasonOnly": True,
        "seasons": [a.start_season, a.end_season],
        "testSeasons": [a.test_start, a.end_season],
        "featureSets": fsets(),
        "sameGameRule": "pregame row emitted before target-game score/PBP/QB state update",
        "nestedTemporalTuning": {
            "enabled": True,
            "outer": "expanding-season walk-forward",
            "inner": "last training season only",
            "logitCGrid": list(C_GRID),
            "ridgeAlphaGrid": list(RIDGE_GRID),
        },
        "opponentAdjustment": {
            "method": "online residual offense/defense ratings",
            "usesTargetGameBeforePrediction": False,
            "updateAfterPregameRow": True,
        },
        "B4_QB": {
            "status": "LEAKAGE_SAFE_PROXY_SCREEN",
            "targetActualStarterUsedAsFeature": False,
            "proxy": "previous observed primary QB for that team within the same season",
            "seasonBoundary": "team QB proxy reset to unknown",
            "qbState": "prior-game-only rolling EPA/CPOE/sack rate with career dropback uncertainty",
            "limitation": "does not know same-week announced starter changes; final production B4 still requires timestamped as-of starter/depth-chart source",
        },
        "deferredForTimestampProof": {
            "B6_personnel": "historical injury/inactive timestamps required",
            "B7_weather": "archived pregame forecast required; observed weather forbidden",
            "B8_NGS": "prior-publication timing audit required",
        },
        "rows": len(x),
        "tieHandling": "target ties excluded from binary signal screen; ties remain in prior-state updates and final score-distribution engine will model ties explicitly",
        "pbpProvenance": prov,
    }
    (out / "nfl_r5_manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / "nfl_r5_audit.json").write_text(
        json.dumps(
            {
                "marketLeakageCheck": "PASS",
                "sameGameFeatureLeakageCheck": "PASS_BY_CONSTRUCTION",
                "targetActualQBFeatureCheck": "PASS_NOT_USED",
                "validation": "NESTED_EXPANDING_SEASON_WALK_FORWARD",
            },
            indent=2,
        )
    )

    print("NFL_R5_MODEL_SUMMARY")
    print(summary.to_string(index=False))
    print("NFL_R5_BOOTSTRAP")
    print(deltas.to_string(index=False))
    print("NFL_R5_COMPLETE")


if __name__ == "__main__":
    main()
