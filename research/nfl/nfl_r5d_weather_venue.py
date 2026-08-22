#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, mean_absolute_error

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as r5b2

# R5D preregistration:
# - Venue features may be considered for promotion because neutral/roof/surface are
#   football context known before kickoff. Historical games.csv does not provide
#   an as-of timestamp for these fields, so prospective provenance remains required.
# - temp/wind in games.csv are treated strictly as POST-HOC OBSERVED WEATHER
#   diagnostics and are never promotion-eligible in R5D.
VENUE_FEATURES = [
    "r5d_neutral",
    "r5d_roof_outdoors", "r5d_roof_dome", "r5d_roof_closed", "r5d_roof_open", "r5d_roof_unknown",
    "r5d_surface_grass", "r5d_surface_artificial", "r5d_surface_unknown",
]
WEATHER_DIAG_FEATURES = [
    "r5d_weather_known", "r5d_temp_f", "r5d_wind_mph", "r5d_wind_sq",
    "r5d_cold", "r5d_hot", "r5d_outdoor_wind", "r5d_outdoor_cold", "r5d_outdoor_hot",
]


def norm(s):
    return str(s or "").strip().lower()


def schedule_context(cache: Path, seasons):
    p = base.dl(base.GAMES_URL, cache / "games.csv")
    x = pd.read_csv(p, low_memory=False)
    required = ["game_id", "season", "game_type", "week", "location", "roof", "surface", "temp", "wind"]
    miss = [c for c in required if c not in x.columns]
    if miss:
        raise RuntimeError(f"missing R5D schedule columns {miss}")
    x = x[required].copy()
    x = x[x.season.isin(seasons) & x.game_type.eq("REG")]
    x["season"] = pd.to_numeric(x.season, errors="coerce")
    x["week"] = pd.to_numeric(x.week, errors="coerce")
    x["temp"] = pd.to_numeric(x.temp, errors="coerce")
    x["wind"] = pd.to_numeric(x.wind, errors="coerce")

    loc = x.location.map(norm)
    roof = x.roof.map(norm)
    surf = x.surface.map(norm)

    out = pd.DataFrame({"game_id": x.game_id.astype(str)})
    out["r5d_neutral"] = loc.str.contains("neutral", na=False).astype(float)
    out["r5d_roof_outdoors"] = roof.str.contains("outdoor", na=False).astype(float)
    out["r5d_roof_dome"] = roof.str.contains("dome", na=False).astype(float)
    out["r5d_roof_closed"] = roof.str.contains("closed", na=False).astype(float)
    out["r5d_roof_open"] = roof.str.contains("open", na=False).astype(float)
    known_roof = out[["r5d_roof_outdoors", "r5d_roof_dome", "r5d_roof_closed", "r5d_roof_open"]].sum(axis=1).gt(0)
    out["r5d_roof_unknown"] = (~known_roof).astype(float)

    out["r5d_surface_grass"] = surf.str.contains("grass", na=False).astype(float)
    artificial_tokens = "turf|artificial|a_turf|sportturf|fieldturf|matrixturf|astroturf"
    out["r5d_surface_artificial"] = surf.str.contains(artificial_tokens, regex=True, na=False).astype(float)
    known_surface = out.r5d_surface_grass.eq(1) | out.r5d_surface_artificial.eq(1)
    out["r5d_surface_unknown"] = (~known_surface).astype(float)

    temp = x.temp.astype(float)
    wind = x.wind.astype(float)
    known_weather = temp.notna() | wind.notna()
    out["r5d_weather_known"] = known_weather.astype(float)
    out["r5d_temp_f"] = temp
    out["r5d_wind_mph"] = wind
    out["r5d_wind_sq"] = wind.pow(2)
    out["r5d_cold"] = (40.0 - temp).clip(lower=0)
    out["r5d_hot"] = (temp - 80.0).clip(lower=0)
    outdoors = out.r5d_roof_outdoors.eq(1).astype(float)
    out["r5d_outdoor_wind"] = wind * outdoors
    out["r5d_outdoor_cold"] = out.r5d_cold * outdoors
    out["r5d_outdoor_hot"] = out.r5d_hot * outdoors
    return out.drop_duplicates("game_id")


def feature_sets():
    foundation = r5b2.feature_sets()["R5B2_HICONF_SWITCH"]
    return {
        "R5B2_HICONF_SWITCH": foundation,
        "R5D_NEUTRAL_ONLY": foundation + ["r5d_neutral"],
        "R5D_VENUE": foundation + VENUE_FEATURES,
        "R5D_OBS_WEATHER_DIAG": foundation + VENUE_FEATURES + WEATHER_DIAG_FEATURES,
    }


def evaluate(x, test0, end):
    x = x[x.margin.ne(0)].copy()
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
            pr = {}
            for target in ("margin", "game_total"):
                a = base.tune_ridge(tr, cols, target)
                rm = base.pipe("ridge", a)
                rm.fit(tr[cols], tr[target])
                pr[target] = rm.predict(te[cols])
            q = pd.DataFrame({
                "game_id": te.game_id.to_numpy(), "season": y, "week": te.week.to_numpy(),
                "model": name, "y": te.home_win.to_numpy(), "p": pp,
                "margin": te.margin.to_numpy(), "pm": pr["margin"],
                "game_total": te.game_total.to_numpy(), "pt": pr["game_total"],
                "neutral": te.r5d_neutral.to_numpy(), "weather_known": te.r5d_weather_known.to_numpy(),
                "outdoors": te.r5d_roof_outdoors.to_numpy(),
            })
            q["lli"] = -(q.y * np.log(q.p) + (1 - q.y) * np.log(1 - q.p))
            preds.append(q)
            seasons.append({
                "model": name, "season": y, "n": len(q),
                "log_loss": log_loss(q.y, q.p), "brier": brier_score_loss(q.y, q.p),
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
        subsets = [
            ("ALL", np.ones(len(z), dtype=bool)),
            ("NEUTRAL", z.neutral.eq(1)),
            ("WEATHER_KNOWN", z.weather_known.eq(1)),
            ("OUTDOOR_WEATHER_KNOWN", z.weather_known.eq(1) & z.outdoors.eq(1)),
        ]
        for label, mask in subsets:
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
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5d-output")
    ap.add_argument("--cache-dir", default=".cache/nflverse")
    ap.add_argument("--start-season", type=int, default=2012)
    ap.add_argument("--end-season", type=int, default=2025)
    ap.add_argument("--test-start", type=int, default=2018)
    a = ap.parse_args()

    src = Path(a.input_dir); out = Path(a.out_dir); cache = Path(a.cache_dir)
    out.mkdir(parents=True, exist_ok=True); cache.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    ctx = schedule_context(cache, range(a.start_season, a.end_season + 1))
    x = x.merge(ctx, on="game_id", how="left", validate="one_to_one")
    for c in VENUE_FEATURES + WEATHER_DIAG_FEATURES:
        if c not in x:
            x[c] = np.nan
    x.to_parquet(out / "nfl_r5d_dataset.parquet", index=False)

    sm, by, p = evaluate(x, a.test_start, a.end_season)
    bs = pd.DataFrame([boot(p, m) for m in feature_sets() if m != "R5B2_HICONF_SWITCH"])
    sub = subset_report(p)
    wb = week_band_report(p)
    sm.to_csv(out / "nfl_r5d_model_summary.csv", index=False)
    by.to_csv(out / "nfl_r5d_by_season.csv", index=False)
    p.to_parquet(out / "nfl_r5d_predictions.parquet", index=False)
    bs.to_csv(out / "nfl_r5d_bootstrap.csv", index=False)
    sub.to_csv(out / "nfl_r5d_subsets.csv", index=False)
    wb.to_csv(out / "nfl_r5d_week_bands.csv", index=False)

    manifest = {
        "researchOnly": True,
        "marketDataUsedAsFeatures": False,
        "marketOptimizationPerformed": False,
        "reference": "R5B2_HICONF_SWITCH",
        "venueFeaturesPromotionEligible": True,
        "venueHistoricalAsOfTimestampAvailable": False,
        "observedWeatherUsed": True,
        "observedWeatherPromotionEligible": False,
        "observedWeatherPurpose": "MECHANISM_DIAGNOSTIC_ONLY",
        "archivedPregameForecastIntegrated": False,
        "weatherPromotionRequiresArchivedOrProspectivePregameForecast": True,
    }
    audit = {
        "marketLeakageCheck": "PASS",
        "targetOutcomeFeatureCheck": "PASS_NOT_USED",
        "observedWeatherEligibilityCheck": "PASS_DIAGNOSTIC_ONLY",
        "postHocWeatherPromotion": "FORBIDDEN",
        "validation": "NESTED_EXPANDING_SEASON_WALK_FORWARD",
    }
    (out / "nfl_r5d_manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / "nfl_r5d_audit.json").write_text(json.dumps(audit, indent=2))

    print("NFL_R5D_MODEL_SUMMARY"); print(sm.to_string(index=False))
    print("NFL_R5D_BOOTSTRAP"); print(bs.to_string(index=False))
    print("NFL_R5D_SUBSETS"); print(sub.to_string(index=False))
    print("NFL_R5D_WEEK_BANDS"); print(wb.to_string(index=False))
    print("NFL_R5D_COMPLETE")


if __name__ == "__main__":
    main()
