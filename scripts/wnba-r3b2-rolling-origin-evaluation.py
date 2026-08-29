#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import numpy as np
import pyarrow.parquet as pq
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

PROTOCOL_PATH = Path("research/wnba/WNBA_R3B2_ROLLING_ORIGIN_ABLATION_AND_SELECTIVE_ELITE_PROTOCOL.json")
ROWSET_PATH = Path(os.environ.get("WNBA_R3B2_FEATURE_ROWSET", "wnba-r3b1-prefix-feature-rowset.jsonl"))
OUT_EVIDENCE = Path("wnba-r3b2-evaluation-evidence.json")
OUT_PREDICTIONS = Path("wnba-r3b2-oos-predictions.jsonl")
OUT_FINAL = Path("wnba-r3b2-final-candidate-predictions.jsonl")
API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}"
Z95 = 1.959963984540054
EPS = 1e-15

BASE = "BASE_R2_FEATURE_LOGIT"
FAMILIES = [
    "FOUR_FACTORS",
    "QUALITY_ADJUSTED_FORM",
    "H2H_PREFIX",
    "FATIGUE_CORE",
    "SHOT_PROFILE_MATCHUP",
]
R3_CONTAINER = {
    "FOUR_FACTORS": "fourFactors",
    "QUALITY_ADJUSTED_FORM": "qualityForm",
    "H2H_PREFIX": "h2h",
    "FATIGUE_CORE": "fatigue",
    "SHOT_PROFILE_MATCHUP": "shotProfile",
}


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def github_headers(accept: str) -> dict[str, str]:
    h = {
        "Accept": accept,
        "User-Agent": "Prediccion-Elite-WNBA-R3B2/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=github_headers(accept)), timeout=timeout) as resp:
        return resp.read()


def norm_id(v: Any) -> str:
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def finite(v: Any) -> float:
    x = float(v)
    if not math.isfinite(x):
        raise ValueError(f"non-finite value: {v!r}")
    return x


def side_num(v: Any) -> float:
    if isinstance(v, bool):
        return float(int(v))
    return finite(v)


def load_feature_rows(protocol: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw = ROWSET_PATH.read_bytes()
    got_sha = sha256_bytes(raw)
    expected = protocol["frozen_feature_rowset"]
    if got_sha != expected["sha256"]:
        raise SystemExit(f"R3B1 rowset SHA mismatch: {got_sha}")
    rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    if len(rows) != int(expected["rows"]):
        raise SystemExit(f"R3B1 row count mismatch: {len(rows)}")
    ids = [str(r["gameId"]) for r in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate gameId in R3B1 feature rowset")
    counts = Counter(int(r["season"]) for r in rows)
    exp_counts = {int(k): int(v) for k, v in expected["season_rows"].items()}
    if dict(sorted(counts.items())) != dict(sorted(exp_counts.items())):
        raise SystemExit(f"season counts mismatch: {counts}")
    return rows, {
        "file": str(ROWSET_PATH),
        "bytes": len(raw),
        "sha256": got_sha,
        "rows": len(rows),
        "season_rows": dict(sorted(counts.items())),
    }


def download_and_verify_asset(asset_id: int, expected_sha: str, dst: Path) -> dict[str, Any]:
    meta = json.loads(get_bytes(API.format(asset_id=asset_id), "application/vnd.github+json").decode("utf-8"))
    payload = get_bytes(API.format(asset_id=asset_id), "application/octet-stream")
    got_sha = sha256_bytes(payload)
    if int(meta.get("id", -1)) != asset_id:
        raise SystemExit(f"asset id mismatch for {asset_id}")
    if got_sha != expected_sha:
        raise SystemExit(f"asset SHA mismatch {asset_id}: {got_sha}")
    dst.write_bytes(payload)
    return {
        "asset_id": asset_id,
        "name": meta.get("name"),
        "bytes": len(payload),
        "sha256": got_sha,
        "custody_verified": True,
    }


def load_labels(protocol: dict[str, Any], target_ids: set[str]) -> tuple[dict[str, int], dict[str, Any]]:
    pins = protocol["outcome_label_contract"]["frozen_asset_pins"]
    labels: dict[str, int] = {}
    evidence: dict[str, Any] = {
        "assets": {},
        "season": {},
        "score_fields_projected": ["game_id", "team_home_away", "team_score", "opponent_team_score"],
    }
    with tempfile.TemporaryDirectory(prefix="wnba-r3b2-outcomes-") as td:
        root = Path(td)
        for season_s, pin in sorted(pins.items(), key=lambda kv: int(kv[0])):
            season = int(season_s)
            path = root / f"team-box-{season}.parquet"
            asset_ev = download_and_verify_asset(int(pin["asset_id"]), str(pin["sha256"]), path)
            evidence["assets"][season_s] = asset_ev
            table = pq.read_table(path, columns=["game_id", "team_home_away", "team_score", "opponent_team_score"])
            grouped: dict[str, dict[str, tuple[float, float]]] = defaultdict(dict)
            for r in table.to_pylist():
                gid = norm_id(r.get("game_id"))
                if gid not in target_ids:
                    continue
                hoa = str(r.get("team_home_away") or "").strip().lower().replace("_", "").replace("-", "")
                if hoa not in {"home", "away"}:
                    continue
                score = finite(r.get("team_score"))
                opp = finite(r.get("opponent_team_score"))
                if hoa in grouped[gid]:
                    raise SystemExit(f"duplicate {hoa} score row for {gid}")
                grouped[gid][hoa] = (score, opp)

            n = 0
            home_wins = 0
            for gid, sides in grouped.items():
                if set(sides) != {"home", "away"}:
                    raise SystemExit(f"incomplete score sides for {gid}: {set(sides)}")
                hs, h_opp = sides["home"]
                aws, a_opp = sides["away"]
                if abs(h_opp - aws) > 1e-9 or abs(a_opp - hs) > 1e-9:
                    raise SystemExit(f"opponent score mirror mismatch for {gid}")
                if abs(hs - aws) <= 1e-12:
                    raise SystemExit(f"equal final score fail-closed for {gid}")
                y = 1 if hs > aws else 0
                if gid in labels:
                    raise SystemExit(f"duplicate outcome label across assets for {gid}")
                labels[gid] = y
                n += 1
                home_wins += y
            evidence["season"][season_s] = {
                "labels": n,
                "home_wins": home_wins,
                "home_win_rate": home_wins / n if n else None,
            }

    missing = sorted(target_ids - set(labels))
    extra = sorted(set(labels) - target_ids)
    if missing or extra:
        raise SystemExit(f"label membership mismatch missing={len(missing)} extra={len(extra)}")
    evidence["labels"] = len(labels)
    evidence["home_wins"] = sum(labels.values())
    evidence["home_win_rate"] = sum(labels.values()) / len(labels)
    evidence["membership_matches_feature_rowset_exactly"] = True
    evidence["market_or_line_fields_loaded"] = False
    return labels, evidence


def fields_for(protocol: dict[str, Any], family: str) -> list[str]:
    return list(protocol["feature_vectors"][family])


def feature_value(row: dict[str, Any], family: str, field: str) -> float:
    if family == "BASE_R2":
        return side_num(row["baseR2"]["home"][field]) - side_num(row["baseR2"]["away"][field])
    container = R3_CONTAINER[family]
    return side_num(row["r3"]["home"][container][field]) - side_num(row["r3"]["away"][container][field])


def spec_for(protocol: dict[str, Any], families: tuple[str, ...]) -> list[tuple[str, str]]:
    spec = [("BASE_R2", f) for f in fields_for(protocol, "BASE_R2")]
    for fam in families:
        spec.extend((fam, f) for f in fields_for(protocol, fam))
    return spec


def matrix(rows: list[dict[str, Any]], spec: list[tuple[str, str]]) -> np.ndarray:
    arr = np.empty((len(rows), len(spec)), dtype=float)
    for i, row in enumerate(rows):
        for j, (fam, field) in enumerate(spec):
            arr[i, j] = feature_value(row, fam, field)
    if not np.isfinite(arr).all():
        raise SystemExit("non-finite model matrix")
    return arr


def metrics(probs: np.ndarray, ys: np.ndarray) -> dict[str, Any]:
    p = np.asarray(probs, dtype=float)
    y = np.asarray(ys, dtype=float)
    if len(p) == 0:
        return {
            "n": 0,
            "brier": None,
            "log_loss": None,
            "ece10": None,
            "mean_predicted_minus_observed": None,
            "accuracy": None,
        }
    if not np.isfinite(p).all() or np.any((p <= 0.0) | (p >= 1.0)):
        raise SystemExit("probabilities must be finite and strictly inside (0,1)")
    brier = float(np.mean((p - y) ** 2))
    pc = np.clip(p, EPS, 1.0 - EPS)
    ll = float(-np.mean(y * np.log(pc) + (1.0 - y) * np.log(1.0 - pc)))
    ece = 0.0
    for b in range(10):
        lo, hi = b / 10.0, (b + 1) / 10.0
        mask = (p >= lo) & ((p < hi) if b < 9 else (p <= hi))
        if np.any(mask):
            ece += float(np.mean(mask)) * abs(float(np.mean(p[mask])) - float(np.mean(y[mask])))
    acc = float(np.mean((p >= 0.5) == (y >= 0.5)))
    return {
        "n": int(len(p)),
        "brier": brier,
        "log_loss": ll,
        "ece10": ece,
        "mean_predicted_minus_observed": float(np.mean(p) - np.mean(y)),
        "accuracy": acc,
        "mean_predicted": float(np.mean(p)),
        "observed_rate": float(np.mean(y)),
    }


def wilson(successes: int, n: int) -> list[float | None]:
    if n <= 0:
        return [None, None]
    p = successes / n
    z2 = Z95 * Z95
    den = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / den
    half = (Z95 * math.sqrt(p * (1.0 - p) / n + z2 / (4.0 * n * n))) / den
    return [max(0.0, center - half), min(1.0, center + half)]


def candidate_id(families: tuple[str, ...]) -> str:
    if not families:
        return BASE
    return "BASE_R2+" + "+".join(families)


def fit_candidate(
    protocol: dict[str, Any],
    rows: list[dict[str, Any]],
    labels: dict[str, int],
    families: tuple[str, ...],
    with_contributions: bool = False,
) -> dict[str, Any]:
    cid = candidate_id(families)
    spec = spec_for(protocol, families)
    all_preds: list[dict[str, Any]] = []
    fold_ev: dict[str, Any] = {}

    for fold in protocol["rolling_origin_folds"]:
        target = int(fold["target_season"])
        train_seasons = {int(x) for x in fold["train_seasons"]}
        train_rows = [r for r in rows if int(r["season"]) in train_seasons]
        test_rows = [r for r in rows if int(r["season"]) == target]
        Xtr = matrix(train_rows, spec)
        Xte = matrix(test_rows, spec)
        ytr = np.asarray([labels[str(r["gameId"])] for r in train_rows], dtype=int)
        yte = np.asarray([labels[str(r["gameId"])] for r in test_rows], dtype=int)

        scaler = StandardScaler()
        Ztr = scaler.fit_transform(Xtr)
        Zte = scaler.transform(Xte)
        model = LogisticRegression(
            penalty="l2",
            C=1.0,
            solver="liblinear",
            fit_intercept=True,
            class_weight=None,
            max_iter=10000,
            tol=1e-10,
            random_state=940830,
        )
        model.fit(Ztr, ytr)
        p = model.predict_proba(Zte)[:, 1]
        fold_ev[str(target)] = {
            "train_rows": len(train_rows),
            "target_rows": len(test_rows),
            "train_seasons": sorted(train_seasons),
            "metrics": metrics(p, yte),
        }

        family_indices: dict[str, list[int]] = defaultdict(list)
        if with_contributions:
            for j, (fam, _field) in enumerate(spec):
                if fam != "BASE_R2":
                    family_indices[fam].append(j)
            beta = model.coef_[0]

        for i, row in enumerate(test_rows):
            pred: dict[str, Any] = {
                "candidate": cid,
                "families": list(families),
                "gameId": str(row["gameId"]),
                "season": int(row["season"]),
                "targetDate": row["targetDate"],
                "homeTeamId": str(row["homeTeamId"]),
                "awayTeamId": str(row["awayTeamId"]),
                "homeWin": int(yte[i]),
                "pHome": float(p[i]),
            }
            if with_contributions:
                pred["familyLogitContribution"] = {
                    fam: float(np.dot(Zte[i, idxs], beta[idxs])) for fam, idxs in family_indices.items()
                }
            all_preds.append(pred)

    all_preds.sort(key=lambda x: (x["season"], x["targetDate"], x["gameId"]))
    p_all = np.asarray([x["pHome"] for x in all_preds], dtype=float)
    y_all = np.asarray([x["homeWin"] for x in all_preds], dtype=int)
    return {
        "candidate": cid,
        "families": list(families),
        "feature_count": len(spec),
        "folds": fold_ev,
        "pooled": metrics(p_all, y_all),
        "predictions": all_preds,
    }


def single_gate(base: dict[str, Any], cand: dict[str, Any]) -> dict[str, Any]:
    b0, c0 = base["pooled"], cand["pooled"]
    brier_imp = b0["brier"] - c0["brier"]
    ll_imp = b0["log_loss"] - c0["log_loss"]
    threshold = brier_imp >= 0.001 or ll_imp >= 0.002
    nondeg = (
        c0["brier"] - b0["brier"] <= 0.0015
        and c0["log_loss"] - b0["log_loss"] <= 0.003
        and c0["ece10"] - b0["ece10"] <= 0.01
    )
    improved_seasons = []
    for s in (2022, 2023, 2024, 2025):
        bm = base["folds"][str(s)]["metrics"]
        cm = cand["folds"][str(s)]["metrics"]
        if cm["brier"] < bm["brier"] - 1e-15 or cm["log_loss"] < bm["log_loss"] - 1e-15:
            improved_seasons.append(s)
    stable = len(improved_seasons) >= 2
    return {
        "qualifies": bool(threshold and nondeg and stable),
        "pooled_brier_improvement": brier_imp,
        "pooled_log_loss_improvement": ll_imp,
        "threshold_pass": threshold,
        "non_degradation_pass": nondeg,
        "proper_score_improved_target_seasons": improved_seasons,
        "seasonal_stability_pass": stable,
    }


def combination_gate(ref: dict[str, Any], cand: dict[str, Any]) -> dict[str, Any]:
    r0, c0 = ref["pooled"], cand["pooled"]
    brier_imp = r0["brier"] - c0["brier"]
    ll_imp = r0["log_loss"] - c0["log_loss"]
    threshold = brier_imp >= 0.001 or ll_imp >= 0.002
    nondeg = (
        c0["brier"] - r0["brier"] <= 0.0015
        and c0["log_loss"] - r0["log_loss"] <= 0.003
        and c0["ece10"] - r0["ece10"] <= 0.01
    )
    improved_seasons = []
    for s in (2022, 2023, 2024, 2025):
        rm = ref["folds"][str(s)]["metrics"]
        cm = cand["folds"][str(s)]["metrics"]
        if cm["brier"] < rm["brier"] - 1e-15 or cm["log_loss"] < rm["log_loss"] - 1e-15:
            improved_seasons.append(s)
    stable = len(improved_seasons) >= 2
    return {
        "advances": bool(threshold and nondeg and stable),
        "reference_candidate": ref["candidate"],
        "pooled_brier_improvement": brier_imp,
        "pooled_log_loss_improvement": ll_imp,
        "threshold_pass": threshold,
        "non_degradation_pass": nondeg,
        "proper_score_improved_target_seasons": improved_seasons,
        "seasonal_stability_pass": stable,
    }


def elite_screen(final_eval: dict[str, Any]) -> dict[str, Any]:
    families = list(final_eval["families"])
    if len(families) < 2:
        return {
            "enabled": False,
            "reason": "FINAL_CANDIDATE_HAS_FEWER_THAN_2_R3_FAMILIES",
            "development_feasibility_pass": False,
        }

    selected: list[dict[str, Any]] = []
    support_hist = Counter()
    for pred in final_eval["predictions"]:
        p_home = float(pred["pHome"])
        selected_home = p_home >= 0.5
        side_sign = 1.0 if selected_home else -1.0
        p_selected = p_home if selected_home else 1.0 - p_home
        contrib = pred.get("familyLogitContribution", {})
        supports = [fam for fam in families if side_sign * float(contrib.get(fam, 0.0)) > 0.0]
        abs_vals = [abs(float(contrib.get(fam, 0.0))) for fam in families]
        denom = sum(abs_vals)
        max_share = max(abs_vals) / denom if denom > 0.0 else 1.0
        aggregate_support = side_sign * sum(float(contrib.get(fam, 0.0)) for fam in families) > 0.0
        is_elite = (
            p_selected >= 0.75
            and len(supports) >= 2
            and aggregate_support
            and max_share <= 0.70
        )
        if is_elite:
            correct = int((pred["homeWin"] == 1) if selected_home else (pred["homeWin"] == 0))
            row = dict(pred)
            row.update({
                "selectedSide": "HOME" if selected_home else "AWAY",
                "pWinSelectedSide": p_selected,
                "selectedSideCorrect": correct,
                "r3SupportingFamilies": supports,
                "r3SupportingFamilyCount": len(supports),
                "aggregateR3ContributionSupportsSelectedSide": aggregate_support,
                "maxSingleFamilyShareOfAbsoluteR3Contribution": max_share,
                "elite": True,
            })
            selected.append(row)
            support_hist[len(supports)] += 1

    total_oos = len(final_eval["predictions"])
    n = len(selected)
    wins = sum(int(x["selectedSideCorrect"]) for x in selected)
    p = np.asarray([x["pWinSelectedSide"] for x in selected], dtype=float) if selected else np.asarray([], dtype=float)
    y = np.asarray([x["selectedSideCorrect"] for x in selected], dtype=int) if selected else np.asarray([], dtype=int)
    pooled = metrics(p, y)
    pooled["wilson_95_ci"] = wilson(wins, n)
    pooled["wins"] = wins
    pooled["coverage"] = n / total_oos if total_oos else 0.0

    per_season: dict[str, Any] = {}
    for s in (2022, 2023, 2024, 2025):
        ss = [x for x in selected if int(x["season"]) == s]
        sn = len(ss)
        sw = sum(int(x["selectedSideCorrect"]) for x in ss)
        sp = np.asarray([x["pWinSelectedSide"] for x in ss], dtype=float) if ss else np.asarray([], dtype=float)
        sy = np.asarray([x["selectedSideCorrect"] for x in ss], dtype=int) if ss else np.asarray([], dtype=int)
        sm = metrics(sp, sy)
        sm["wins"] = sw
        sm["wilson_95_ci"] = wilson(sw, sn)
        per_season[str(s)] = sm

    coverage_gate = n >= 100 and all(per_season[str(s)]["n"] >= 15 for s in (2022, 2023, 2024, 2025))
    performance_gate = (
        n > 0
        and pooled["accuracy"] >= 0.80
        and all(
            per_season[str(s)]["accuracy"] is not None and per_season[str(s)]["accuracy"] >= 0.70
            for s in (2022, 2023, 2024, 2025)
        )
    )
    return {
        "enabled": True,
        "fixed_probability_threshold": 0.75,
        "minimum_independent_r3_support": 2,
        "maximum_single_family_share": 0.70,
        "pooled": pooled,
        "per_season": per_season,
        "support_count_histogram": dict(sorted(support_hist.items())),
        "coverage_gate_pass": coverage_gate,
        "performance_gate_pass": performance_gate,
        "development_feasibility_pass": bool(coverage_gate and performance_gate),
        "selected_predictions": selected,
    }


def public_eval(ev: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in ev.items() if k != "predictions"}


def main() -> None:
    protocol_raw = PROTOCOL_PATH.read_bytes()
    protocol = json.loads(protocol_raw)
    if protocol.get("status") != "FROZEN_BEFORE_R3B2_OUTCOME_OPENING":
        raise SystemExit("unexpected R3B2 protocol status")

    rows, row_ev = load_feature_rows(protocol)
    labels, outcome_ev = load_labels(protocol, {str(r["gameId"]) for r in rows})

    base = fit_candidate(protocol, rows, labels, ())
    singles: dict[str, dict[str, Any]] = {}
    single_gates: dict[str, Any] = {}
    all_prediction_rows: list[dict[str, Any]] = list(base["predictions"])

    for fam in FAMILIES:
        ev = fit_candidate(protocol, rows, labels, (fam,))
        singles[fam] = ev
        single_gates[fam] = single_gate(base, ev)
        all_prediction_rows.extend(ev["predictions"])

    eligible = [fam for fam in FAMILIES if single_gates[fam]["qualifies"]]
    best_single: dict[str, Any] | None = None
    combos: dict[str, dict[str, Any]] = {}
    combo_gates: dict[str, Any] = {}
    advancing: list[dict[str, Any]] = []

    if eligible:
        best_single = min(
            (singles[f] for f in eligible),
            key=lambda e: (e["pooled"]["log_loss"], e["pooled"]["brier"], e["candidate"]),
        )
        for size in (2, 3):
            for fam_tuple in itertools.combinations(eligible, size):
                ev = fit_candidate(protocol, rows, labels, tuple(fam_tuple))
                combos[ev["candidate"]] = ev
                gate = combination_gate(best_single, ev)
                combo_gates[ev["candidate"]] = gate
                all_prediction_rows.extend(ev["predictions"])
                if gate["advances"]:
                    advancing.append(ev)

    if advancing:
        final_pre = min(
            advancing,
            key=lambda e: (e["pooled"]["log_loss"], e["pooled"]["brier"], len(e["families"]), e["candidate"]),
        )
        final_families = tuple(final_pre["families"])
    elif best_single is not None:
        final_families = tuple(best_single["families"])
    else:
        final_families = ()

    final_eval = fit_candidate(protocol, rows, labels, final_families, with_contributions=True)
    elite = elite_screen(final_eval)
    selected_predictions = elite.pop("selected_predictions", []) if elite.get("enabled") else []

    all_prediction_rows.sort(key=lambda x: (x["candidate"], x["season"], x["targetDate"], x["gameId"]))
    OUT_PREDICTIONS.write_text("".join(canonical(x) + "\n" for x in all_prediction_rows), encoding="utf-8")

    selected_ids = {str(x["gameId"]): x for x in selected_predictions}
    final_lines = []
    for x in final_eval["predictions"]:
        row = dict(x)
        elite_row = selected_ids.get(str(x["gameId"]))
        if elite_row:
            row.update({k: v for k, v in elite_row.items() if k not in row})
            row["elite"] = True
        else:
            row["elite"] = False
        final_lines.append(row)
    OUT_FINAL.write_text("".join(canonical(x) + "\n" for x in final_lines), encoding="utf-8")

    single_public = {
        fam: {"evaluation": public_eval(singles[fam]), "gate": single_gates[fam]} for fam in FAMILIES
    }
    combo_public = {
        cid: {"evaluation": public_eval(ev), "gate": combo_gates[cid]} for cid, ev in sorted(combos.items())
    }

    if elite.get("development_feasibility_pass"):
        decision = "R3_DEVELOPMENT_FEASIBILITY_PASS_NOT_CERTIFICATION"
    elif len(final_families) < 2:
        decision = "R3_NO_MULTIDIMENSIONAL_ELITE_CANDIDATE"
    else:
        decision = "R3_DEVELOPMENT_FEASIBILITY_FAIL"

    evidence = {
        "name": "WNBA_R3B2_FROZEN_PROTOCOL_OOS_EVALUATION_EVIDENCE_V1",
        "status": "COMPLETED_FROZEN_PROTOCOL_EVALUATION",
        "protocol": {
            "file": str(PROTOCOL_PATH),
            "bytes": len(protocol_raw),
            "sha256": sha256_bytes(protocol_raw),
            "outcome_values_read_before_protocol_freeze": False,
        },
        "feature_rowset": row_ev,
        "outcome_custody": outcome_ev,
        "anti_leakage": {
            "feature_rowset_pre_frozen_outcome_blind": True,
            "same_game_outcome_used_as_feature": False,
            "same_date_outcome_used_as_feature": False,
            "future_outcome_used_as_feature": False,
            "market_fields_used": False,
            "target_season_threshold_search": False,
            "post_result_row_dropping": False,
            "manual_candidate_switching": False,
            "hyperparameter_search": False,
        },
        "base": public_eval(base),
        "single_family_ablations": single_public,
        "eligible_single_families": eligible,
        "best_qualifying_single": best_single["candidate"] if best_single else None,
        "bounded_combinations": combo_public,
        "advancing_combinations": sorted(x["candidate"] for x in advancing),
        "final_candidate": public_eval(final_eval),
        "elite_feasibility": elite,
        "scientific_decision": decision,
        "cross_sport_certified": False,
        "production_mutation": False,
        "global_ranker_mutation": False,
        "next_action": (
            "FREEZE_R3_DEVELOPMENT_CANDIDATE_AND_REQUIRE_INDEPENDENT_PROSPECTIVE_COHORT"
            if elite.get("development_feasibility_pass")
            else "RECORD_FROZEN_R3B2_FAILURE_OR_LIMITATION; ANY SCIENCE CHANGE REQUIRES_NEW_VERSION"
        ),
        "artifacts": {},
    }

    OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for path, key in (
        (OUT_PREDICTIONS, "all_oos_predictions"),
        (OUT_FINAL, "final_candidate_predictions"),
    ):
        raw = path.read_bytes()
        evidence["artifacts"][key] = {
            "file": path.name,
            "bytes": len(raw),
            "sha256": sha256_bytes(raw),
            "rows": sum(1 for _ in path.open("r", encoding="utf-8")),
        }
    OUT_EVIDENCE.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "decision": decision,
        "eligible_single_families": eligible,
        "best_qualifying_single": best_single["candidate"] if best_single else None,
        "advancing_combinations": sorted(x["candidate"] for x in advancing),
        "final_candidate": final_eval["candidate"],
        "final_pooled": final_eval["pooled"],
        "elite_feasibility": elite,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
