#!/usr/bin/env python3
from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss

import nfl_r5_leakage_safe as base
import nfl_r5b_hybrid as hy
import nfl_r5h_contextual_rule_weighting as r5h


REFERENCE = "R5B2_HICONF_SWITCH"
MODEL = "R5H2_CONTEXTUAL_OVERRIDE_GATE"
SEED = 940830


def reference_oos(x: pd.DataFrame, start: int, end: int) -> pd.DataFrame:
    cols = list(hy.feature_sets()[REFERENCE])
    rows = []
    for y in range(start, end + 1):
        tr, te = x[x.season < y], x[x.season == y]
        if tr.empty or te.empty:
            continue
        c = base.tune_logit(tr, cols)
        m = base.pipe("logit", c)
        m.fit(tr[cols], tr.home_win.astype(int))
        p = r5h.clip_p(m.predict_proba(te[cols])[:, 1])
        rows.append(pd.DataFrame({
            "game_id": te.game_id.to_numpy(), "season": y, "week": te.week.to_numpy(), "ref_p": p,
        }))
    return pd.concat(rows, ignore_index=True)


def gate_candidates(val: pd.DataFrame, cand_p: np.ndarray, selected: list[str]):
    z = r5h.add_context(val, selected)
    ref = r5h.clip_p(val.ref_p.to_numpy())
    cand = r5h.clip_p(cand_p)
    y = val.y.to_numpy(dtype=int)
    cand_pick = cand >= .5
    ref_pick = ref >= .5
    disagree = cand_pick != ref_pick
    cand_conf = np.abs(cand - .5) * 2.0
    agreement = z.ctx_raw_agreement.to_numpy(dtype=float)
    strength = np.abs(r5h.logit(cand)) - np.abs(r5h.logit(ref))

    ref_acc = float(accuracy_score(y, ref_pick))
    base_row = {
        "enabled": False, "conf_thr": 1.1, "agreement_thr": 1.1, "strength_thr": 99.0,
        "validation_accuracy": ref_acc, "validation_log_loss": float(log_loss(y, ref)),
        "validation_brier": float(brier_score_loss(y, ref)), "validation_overrides": 0,
        "validation_net_corrections": 0,
    }
    best = ((ref_acc, -base_row["validation_log_loss"], 0, 0), base_row)
    if not disagree.any():
        return best[1]

    dc = cand_conf[disagree]
    ds = strength[disagree]
    conf_grid = sorted(set([0.0] + [float(np.quantile(dc, q)) for q in (0.20, 0.40, 0.60, 0.75, 0.85, 0.92)]))
    agree_grid = (0.50, 0.60, 0.70, 0.80, 0.90, 1.00)
    strength_grid = sorted(set([-99.0] + [float(np.quantile(ds, q)) for q in (0.20, 0.40, 0.60, 0.80)] + [0.0]))

    ref_correct = ref_pick == y
    cand_correct = cand_pick == y
    for ct in conf_grid:
        for at in agree_grid:
            for st in strength_grid:
                gate = disagree & (cand_conf >= ct) & (agreement >= at) & (strength >= st)
                n = int(gate.sum())
                if n < 8:
                    continue
                hp = np.where(gate, cand, ref)
                pick = hp >= .5
                acc = float(accuracy_score(y, pick))
                ll = float(log_loss(y, hp))
                br = float(brier_score_loss(y, hp))
                net = int((cand_correct[gate] & ~ref_correct[gate]).sum() - (ref_correct[gate] & ~cand_correct[gate]).sum())
                row = {
                    "enabled": True, "conf_thr": float(ct), "agreement_thr": float(at), "strength_thr": float(st),
                    "validation_accuracy": acc, "validation_log_loss": ll, "validation_brier": br,
                    "validation_overrides": n, "validation_net_corrections": net,
                }
                # Primary goal is games won. On ties prefer fewer overrides and better log loss.
                key = (acc, -ll, -n, net)
                if key > best[0]:
                    best = (key, row)
    # Do not activate an override gate unless prior validation wins strictly more games than the reference.
    if best[1]["validation_accuracy"] <= ref_acc + 1e-12:
        return base_row
    return best[1]


def apply_gate(test: pd.DataFrame, cand_p: np.ndarray, selected: list[str], gate: dict):
    ref = r5h.clip_p(test.ref_p.to_numpy())
    cand = r5h.clip_p(cand_p)
    if not gate["enabled"]:
        return ref, np.zeros(len(test), dtype=bool)
    z = r5h.add_context(test, selected)
    disagree = (cand >= .5) != (ref >= .5)
    cand_conf = np.abs(cand - .5) * 2.0
    agreement = z.ctx_raw_agreement.to_numpy(dtype=float)
    strength = np.abs(r5h.logit(cand)) - np.abs(r5h.logit(ref))
    mask = disagree & (cand_conf >= gate["conf_thr"]) & (agreement >= gate["agreement_thr"]) & (strength >= gate["strength_thr"])
    return np.where(mask, cand, ref), mask


def eval_subset(fit, val, subset):
    best = None
    for mode in r5h.MODES:
        for c in r5h.META_C_GRID:
            met, p = r5h.eval_config(fit, val, list(subset), mode, c)
            gate = gate_candidates(val, p, list(subset))
            row = {"selectedRules": list(subset), "mode": mode, "C": float(c), **gate,
                   "candidate_validation_accuracy": met["accuracy"], "candidate_validation_log_loss": met["log_loss"]}
            key = (gate["validation_accuracy"], -gate["validation_log_loss"],
                   -gate["validation_overrides"], -len(subset), 1 if mode == "CONVICTION" else 0)
            if best is None or key > best[0]:
                best = (key, row)
    return best


def choose(fit0: pd.DataFrame) -> dict:
    years = sorted(int(v) for v in fit0.season.unique())
    if len(years) < 4:
        raise RuntimeError("R5H2 insufficient meta history")
    val_years = years[-2:]
    fit = fit0[~fit0.season.isin(val_years)].copy()
    val = fit0[fit0.season.isin(val_years)].copy()
    rules = list(r5h.rule_blocks())
    best = None
    for pair in itertools.combinations(rules, 2):
        q = eval_subset(fit, val, pair)
        if best is None or q[0] > best[0]:
            best = q
    selected = list(best[1]["selectedRules"])
    while len(selected) < len(rules):
        add_best = None
        for rr in rules:
            if rr in selected:
                continue
            q = eval_subset(fit, val, selected + [rr])
            if add_best is None or q[0] > add_best[0]:
                add_best = q
        if add_best is None or add_best[1]["validation_accuracy"] <= best[1]["validation_accuracy"] + 1e-12:
            break
        best = add_best
        selected = list(best[1]["selectedRules"])
    out = dict(best[1])
    out["inner_fit_seasons"] = sorted(int(v) for v in fit.season.unique())
    out["inner_validation_seasons"] = val_years
    return out


def bootstrap(z: pd.DataFrame, reps=10000):
    q = z.copy()
    q["h"] = ((q.p >= .5).astype(int) == q.y.astype(int)).astype(float)
    q["r"] = ((q.ref_p >= .5).astype(int) == q.y.astype(int)).astype(float)
    q["d"] = q.h - q.r
    groups = [g.d.to_numpy() for _, g in q.groupby(["season", "week"], sort=False)]
    sums = np.array([g.sum() for g in groups]); ns = np.array([len(g) for g in groups])
    rng = np.random.default_rng(SEED); vals = np.empty(reps)
    for i in range(reps):
        ix = rng.integers(0, len(groups), len(groups))
        vals[i] = sums[ix].sum() / ns[ix].sum()
    lo, hi = np.quantile(vals, [.025, .975])
    return {"mean_accuracy_delta": float(q.d.mean()), "ci95_low": float(lo), "ci95_high": float(hi),
            "better95": bool(lo > 0), "worse95": bool(hi < 0), "games": int(len(q)), "clusters": int(len(groups))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="nfl-r5b-hybrid-output")
    ap.add_argument("--out-dir", default="nfl-r5h2-output")
    ap.add_argument("--expert-oos-start", type=int, default=2013)
    ap.add_argument("--test-start", type=int, default=2018)
    ap.add_argument("--end-season", type=int, default=2025)
    a = ap.parse_args()
    src, out = Path(a.input_dir), Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    x = pd.read_parquet(src / "nfl_r5b_hybrid_dataset.parquet")
    x = x[x.margin.ne(0)].copy()
    experts, tuning = r5h.expert_oos(x, a.expert_oos_start, a.end_season)
    ro = reference_oos(x, a.expert_oos_start, a.end_season)
    experts = experts.merge(ro, on=["game_id", "season", "week"], validate="one_to_one")

    rows, configs = [], []
    for y in range(a.test_start, a.end_season + 1):
        mt, te = experts[experts.season < y].copy(), experts[experts.season == y].copy()
        cfg = choose(mt)
        p_cand, contrib, shares = r5h.fit_predict_outer(mt, te, {
            "selectedRules": cfg["selectedRules"], "mode": cfg["mode"], "C": cfg["C"]
        })
        hp, override = apply_gate(te, p_cand, cfg["selectedRules"], cfg)
        z = r5h.add_context(te, cfg["selectedRules"])
        q = te[["game_id", "season", "week", "y", "ref_p"]].copy()
        q["candidate_p"] = p_cand
        q["p"] = hp
        q["override"] = override.astype(int)
        q["agreement"] = z.ctx_raw_agreement.to_numpy()
        q["selected_rules"] = "+".join(cfg["selectedRules"])
        q["mode"] = cfg["mode"]
        for rr in r5h.rule_blocks():
            q[f"rule_p__{rr}"] = te[f"p__{rr}"].to_numpy()
            q[f"rule_weight_share__{rr}"] = shares[rr] if rr in shares else 0.0
        rows.append(q)
        configs.append({
            "test_season": y, "mode": cfg["mode"], "C": cfg["C"], "selected_rules": "+".join(cfg["selectedRules"]),
            "n_rules": len(cfg["selectedRules"]), "gate_enabled": cfg["enabled"],
            "conf_thr": cfg["conf_thr"], "agreement_thr": cfg["agreement_thr"], "strength_thr": cfg["strength_thr"],
            "validation_accuracy": cfg["validation_accuracy"], "validation_overrides": cfg["validation_overrides"],
            "validation_net_corrections": cfg["validation_net_corrections"],
            "inner_validation_seasons": "+".join(map(str, cfg["inner_validation_seasons"])),
        })

    p = pd.concat(rows, ignore_index=True)
    rm = {"accuracy": float(accuracy_score(p.y, p.ref_p >= .5)), "log_loss": float(log_loss(p.y, p.ref_p)), "brier": float(brier_score_loss(p.y, p.ref_p))}
    hm = {"accuracy": float(accuracy_score(p.y, p.p >= .5)), "log_loss": float(log_loss(p.y, p.p)), "brier": float(brier_score_loss(p.y, p.p))}
    bm = bootstrap(p)
    over = p[p.override.eq(1)].copy()
    if len(over):
        oc = ((over.p >= .5).astype(int) == over.y.astype(int))
        orc = ((over.ref_p >= .5).astype(int) == over.y.astype(int))
        override_stats = {"games": int(len(over)), "rate": float(len(over)/len(p)), "hybrid_accuracy": float(oc.mean()),
                          "reference_accuracy_same_games": float(orc.mean()), "net_correct": int(oc.sum()-orc.sum())}
    else:
        override_stats = {"games": 0, "rate": 0.0, "hybrid_accuracy": None, "reference_accuracy_same_games": None, "net_correct": 0}

    by = []
    for y,g in p.groupby("season"):
        hc=((g.p>=.5).astype(int)==g.y.astype(int)); rc=((g.ref_p>=.5).astype(int)==g.y.astype(int))
        by.append({"season":int(y),"games":len(g),"hybrid_accuracy":float(hc.mean()),"reference_accuracy":float(rc.mean()),
                   "accuracy_delta":float(hc.mean()-rc.mean()),"overrides":int(g.override.sum()),"net_correct":int(hc.sum()-rc.sum())})

    summary=pd.DataFrame([{"model":REFERENCE,"games":len(p),**rm},{"model":MODEL,"games":len(p),**hm}])
    verdict={
        "stage":"NFL-R5H2_CONTEXTUAL_OVERRIDE_GATE","researchOnly":True,"marketDataUsed":False,"productionChanged":False,
        "reference":REFERENCE,"candidate":MODEL,"primaryObjective":"OUT_OF_SAMPLE_GAME_WIN_ACCURACY",
        "referenceAccuracy":rm["accuracy"],"candidateAccuracy":hm["accuracy"],"accuracyDelta":hm["accuracy"]-rm["accuracy"],
        "accuracyBootstrap":bm,"overrideStats":override_stats,"historicalAccuracyImproved":bool(hm["accuracy"]>rm["accuracy"]),
        "historicalAccuracyImprovementSupported95":bool(bm["better95"]),"automaticProductionPromotion":False,
        "ruleWeightsGameSpecific":True,"defaultAction":"KEEP_CERTIFIED_REFERENCE_UNLESS_PRIOR_VALIDATED_CONTEXTUAL_GATE_FIRES",
    }
    audit={"marketBoundary":"PASS_MARKET_FREE","targetSeasonUsedForGateSelection":"NO","targetSeasonUsedForMetaFit":"NO",
           "gameSpecificRuleWeighting":"PASS","defaultReferenceFallback":"PASS","productionCodeTouched":False}
    manifest={"schemaVersion":"courtedge-nfl-r5h2-contextual-override.v1","researchOnly":True,"marketDataUsedAsFeatures":False,
              "sourceFeatureModel":REFERENCE,"frozenFeatureCount":32,"ruleBlocks":r5h.rule_blocks(),
              "mechanism":"game-specific contextual rule committee may override certified reference only when a gate learned on the latest two prior OOS seasons strictly increased validation game-win accuracy",
              "automaticProductionPromotion":False}

    summary.to_csv(out/"nfl_r5h2_model_summary.csv",index=False)
    pd.DataFrame(by).to_csv(out/"nfl_r5h2_by_season.csv",index=False)
    pd.DataFrame(configs).to_csv(out/"nfl_r5h2_config_by_season.csv",index=False)
    p.to_parquet(out/"nfl_r5h2_predictions.parquet",index=False)
    (out/"nfl_r5h2_verdict.json").write_text(json.dumps(verdict,indent=2,sort_keys=True)+"\n")
    (out/"nfl_r5h2_audit.json").write_text(json.dumps(audit,indent=2,sort_keys=True)+"\n")
    (out/"nfl_r5h2_manifest.json").write_text(json.dumps(manifest,indent=2,sort_keys=True)+"\n")
    print("NFL_R5H2_SUMMARY"); print(summary.to_string(index=False))
    print("NFL_R5H2_OVERRIDE_STATS"); print(json.dumps(override_stats,indent=2,sort_keys=True))
    print("NFL_R5H2_CONFIG"); print(pd.DataFrame(configs).to_string(index=False))
    print("NFL_R5H2_VERDICT"); print(json.dumps(verdict,indent=2,sort_keys=True))
    print("NFL_R5H2_COMPLETE")

if __name__ == "__main__":
    main()
