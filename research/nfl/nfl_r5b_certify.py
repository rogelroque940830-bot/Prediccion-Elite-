#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy

REF = "B4_PROXY_OA"
CAND = "R5B2_HICONF_SWITCH"


def paired(preds: pd.DataFrame) -> pd.DataFrame:
    a = preds[preds.model.eq(REF)][
        ["game_id", "season", "week", "y", "p", "lli", "margin", "pm", "game_total", "pt",
         "any_hi_switch", "any_out_switch", "any_ts_switch"]
    ].rename(columns={"p":"p_ref","lli":"lli_ref","pm":"pm_ref","pt":"pt_ref"})
    b = preds[preds.model.eq(CAND)][["game_id", "p", "lli", "pm", "pt"]].rename(
        columns={"p":"p_cand","lli":"lli_cand","pm":"pm_cand","pt":"pt_cand"}
    )
    z = a.merge(b, on="game_id", how="inner", validate="one_to_one")
    z["delta_ll"] = z.lli_cand - z.lli_ref
    z["delta_brier"] = (z.y-z.p_cand)**2 - (z.y-z.p_ref)**2
    z["delta_margin_abs"] = (z.margin-z.pm_cand).abs() - (z.margin-z.pm_ref).abs()
    z["delta_total_abs"] = (z.game_total-z.pt_cand).abs() - (z.game_total-z.pt_ref).abs()
    return z


def metrics(z: pd.DataFrame, label: str) -> dict:
    return {
        "segment": label,
        "n": int(len(z)),
        "switch_games": int(z.any_hi_switch.sum()),
        "proxy_logloss": float(z.lli_ref.mean()),
        "candidate_logloss": float(z.lli_cand.mean()),
        "delta_logloss": float(z.delta_ll.mean()),
        "proxy_brier": float(((z.y-z.p_ref)**2).mean()),
        "candidate_brier": float(((z.y-z.p_cand)**2).mean()),
        "delta_brier": float(z.delta_brier.mean()),
        "proxy_accuracy": float(accuracy_score(z.y, z.p_ref >= .5)),
        "candidate_accuracy": float(accuracy_score(z.y, z.p_cand >= .5)),
        "delta_accuracy": float(accuracy_score(z.y, z.p_cand >= .5)-accuracy_score(z.y, z.p_ref >= .5)),
        "delta_margin_mae": float(z.delta_margin_abs.mean()),
        "delta_total_mae": float(z.delta_total_abs.mean()),
    }


def clustered_boot(z: pd.DataFrame, label: str, reps=10000, seed=940830) -> dict:
    if z.empty:
        return {"subset":label,"n":0,"clusters":0,"mean_logloss_delta":np.nan,"ci95_low":np.nan,"ci95_high":np.nan,"better95":False,"worse95":False}
    groups = list(z.groupby(["season","week"], sort=False))
    sums = np.array([g.delta_ll.sum() for _,g in groups], dtype=float)
    counts = np.array([len(g) for _,g in groups], dtype=float)
    rng = np.random.default_rng(seed)
    vals = np.empty(reps, dtype=float)
    for i in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        vals[i] = sums[ix].sum() / counts[ix].sum()
    lo, hi = np.quantile(vals, [.025,.975])
    return {
        "subset":label,"n":int(len(z)),"clusters":int(len(groups)),"mean_logloss_delta":float(z.delta_ll.mean()),
        "ci95_low":float(lo),"ci95_high":float(hi),"better95":bool(hi < 0),"worse95":bool(lo > 0),"bootstrap_reps":int(reps)
    }


def eval_no2020_training(x: pd.DataFrame, test_start=2018, end=2025) -> pd.DataFrame:
    """Refit REF and CAND with 2020 removed from both training and evaluation."""
    x = x[x.margin.ne(0)].copy()
    fs = hy.feature_sets()
    rows = []
    for model in [REF, CAND]:
        cols = fs[model]
        for y in range(test_start, end+1):
            if y == 2020:
                continue
            tr = x[(x.season < y) & x.season.ne(2020)].copy()
            te = x[x.season.eq(y)].copy()
            if tr.empty or te.empty:
                continue
            c = base.tune_logit(tr, cols)
            lm = base.pipe("logit", c)
            lm.fit(tr[cols], tr.home_win.astype(int))
            p = np.clip(lm.predict_proba(te[cols])[:,1], 1e-6, 1-1e-6)
            q = pd.DataFrame({"game_id":te.game_id.to_numpy(),"season":y,"week":te.week.to_numpy(),"model":model,"y":te.home_win.to_numpy(),"p":p})
            q["lli"] = -(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p))
            rows.append(q)
    p = pd.concat(rows, ignore_index=True)
    a = p[p.model.eq(REF)][["game_id","season","week","y","p","lli"]].rename(columns={"p":"p_ref","lli":"lli_ref"})
    b = p[p.model.eq(CAND)][["game_id","p","lli"]].rename(columns={"p":"p_cand","lli":"lli_cand"})
    z = a.merge(b,on="game_id",validate="one_to_one")
    z["delta_ll"] = z.lli_cand-z.lli_ref
    return z


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hybrid-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5b-cert-output")
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()
    src, out = Path(a.hybrid_dir), Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    preds = pd.read_parquet(src/"nfl_r5b_hybrid_predictions.parquet")
    z = paired(preds)

    season_rows = [metrics(g, str(int(s))) for s,g in z.groupby("season", sort=True)]
    by_season = pd.DataFrame(season_rows)
    by_season.to_csv(out/"nfl_r5b_cert_by_season.csv", index=False)

    bands = [("W01_04",1,4),("W05_09",5,9),("W10_14",10,14),("W15_18",15,18)]
    by_week = pd.DataFrame([metrics(z[z.week.between(lo,hi)], name) for name,lo,hi in bands])
    by_week.to_csv(out/"nfl_r5b_cert_week_bands.csv", index=False)

    sensitivity = []
    sensitivity.append(metrics(z, "ALL"))
    sensitivity.append(metrics(z[z.season.ne(2020)], "EVAL_EXCLUDE_2020"))
    sensitivity.append(metrics(z[z.season.ne(2025)], "EVAL_EXCLUDE_2025"))

    # Strong COVID sensitivity: rebuild candidate/reference with 2020 forbidden from later training.
    x = pd.read_parquet(src/"nfl_r5b_hybrid_dataset.parquet")
    no20 = eval_no2020_training(x, a.test_start, a.end_season)
    sensitivity.append({
        "segment":"REFIT_NO_2020_TRAIN_OR_TEST","n":int(len(no20)),"switch_games":np.nan,
        "proxy_logloss":float(no20.lli_ref.mean()),"candidate_logloss":float(no20.lli_cand.mean()),
        "delta_logloss":float(no20.delta_ll.mean()),
        "proxy_brier":float(((no20.y-no20.p_ref)**2).mean()),"candidate_brier":float(((no20.y-no20.p_cand)**2).mean()),
        "delta_brier":float(((no20.y-no20.p_cand)**2).mean()-((no20.y-no20.p_ref)**2).mean()),
        "proxy_accuracy":float(accuracy_score(no20.y,no20.p_ref>=.5)),"candidate_accuracy":float(accuracy_score(no20.y,no20.p_cand>=.5)),
        "delta_accuracy":float(accuracy_score(no20.y,no20.p_cand>=.5)-accuracy_score(no20.y,no20.p_ref>=.5)),
        "delta_margin_mae":np.nan,"delta_total_mae":np.nan,
    })
    sensitivity = pd.DataFrame(sensitivity)
    sensitivity.to_csv(out/"nfl_r5b_cert_sensitivity.csv", index=False)

    boots = [
        clustered_boot(z, "ALL"),
        clustered_boot(z[z.any_hi_switch.eq(1)], "HI_SWITCH"),
        clustered_boot(z[z.any_out_switch.eq(1)], "OUT_SWITCH"),
        clustered_boot(z[z.any_ts_switch.eq(1)], "TS_SWITCH"),
        clustered_boot(z[z.season.ne(2020)], "EXCLUDE_2020_EVAL"),
        clustered_boot(z[z.season.ne(2025)], "EXCLUDE_2025_EVAL"),
        clustered_boot(no20.rename(columns={"delta_ll":"delta_ll"}), "REFIT_NO_2020_TRAIN_OR_TEST"),
    ]
    boots = pd.DataFrame(boots)
    boots.to_csv(out/"nfl_r5b_cert_bootstrap.csv", index=False)

    verdict = {
        "researchOnly": True,
        "modelChangedDuringCertification": False,
        "candidate": CAND,
        "reference": REF,
        "overallBetter95": bool(boots.loc[boots.subset.eq("ALL"),"better95"].iloc[0]),
        "outSwitchDirectionBetter": bool(boots.loc[boots.subset.eq("OUT_SWITCH"),"mean_logloss_delta"].iloc[0] < 0),
        "tsSwitchDirectionBetter": bool(boots.loc[boots.subset.eq("TS_SWITCH"),"mean_logloss_delta"].iloc[0] < 0),
        "exclude2020EvalDirectionBetter": bool(sensitivity.loc[sensitivity.segment.eq("EVAL_EXCLUDE_2020"),"delta_logloss"].iloc[0] < 0),
        "exclude2025EvalDirectionBetter": bool(sensitivity.loc[sensitivity.segment.eq("EVAL_EXCLUDE_2025"),"delta_logloss"].iloc[0] < 0),
        "refitWithout2020DirectionBetter": bool(sensitivity.loc[sensitivity.segment.eq("REFIT_NO_2020_TRAIN_OR_TEST"),"delta_logloss"].iloc[0] < 0),
        "note": "Final freeze decision must consider season/week stability; no post-hoc feature/model changes are made here."
    }
    verdict["coreCertificationConditionsPass"] = bool(
        verdict["overallBetter95"] and verdict["outSwitchDirectionBetter"] and verdict["tsSwitchDirectionBetter"]
        and verdict["exclude2020EvalDirectionBetter"] and verdict["exclude2025EvalDirectionBetter"]
        and verdict["refitWithout2020DirectionBetter"]
    )
    (out/"nfl_r5b_cert_verdict.json").write_text(json.dumps(verdict, indent=2)+"\n")

    print("NFL_R5B_CERT_BY_SEASON"); print(by_season.to_string(index=False))
    print("NFL_R5B_CERT_WEEK_BANDS"); print(by_week.to_string(index=False))
    print("NFL_R5B_CERT_SENSITIVITY"); print(sensitivity.to_string(index=False))
    print("NFL_R5B_CERT_BOOTSTRAP"); print(boots.to_string(index=False))
    print("NFL_R5B_CERT_VERDICT"); print(json.dumps(verdict, indent=2))
    print("NFL_R5B_CERT_COMPLETE")

if __name__ == "__main__":
    main()
