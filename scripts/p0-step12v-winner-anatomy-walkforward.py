#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import Counter, defaultdict

SCHEMA = "courtedge-p0-step12v-winner-anatomy-walkforward.v1"
FEATURE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
MIN_TRAIN_ROWS = 400
MIN_TRAIN_DATES = 30
MIN_CLASS_ROWS = 60
TOP_K_FEATURES = 10
RELIABILITY_PRIOR = 120.0
EPS = 1e-12


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(float(v))


def sigmoid(x):
    if x >= 0:
        z = math.exp(-min(x, 40.0))
        return 1.0 / (1.0 + z)
    z = math.exp(max(x, -40.0))
    return z / (1.0 + z)


def target_specs():
    specs = []

    def add(**kw):
        specs.append(kw)

    add(id="ML", family="MONEYLINE", period="FULL_GAME", kind="SIDE", horizon="FULL_GAME",
        positiveLabel="HOME", negativeLabel="AWAY", currentAnalyticalPath=True, providerStatus="SUPPORTED")
    add(id="F5_ML", family="MONEYLINE", period="FIRST_5", kind="SIDE", horizon="FIRST_5",
        positiveLabel="HOME", negativeLabel="AWAY", currentAnalyticalPath=True, providerStatus="SUPPORTED")
    add(id="F3_ML", family="MONEYLINE", period="FIRST_3", kind="SIDE", horizon="FIRST_3",
        positiveLabel="HOME", negativeLabel="AWAY", currentAnalyticalPath=False, providerStatus="SUPPORTED_RESEARCH_PATH_MISSING")

    for period, horizon, current in (
        ("FULL_GAME", "FULL_GAME", True),
        ("FIRST_5", "FIRST_5", False),
        ("FIRST_3", "FIRST_3", False),
    ):
        for threshold in (-1.5, 1.5):
            home_line = -threshold
            away_line = threshold
            lid = f"{'RUN_LINE' if period == 'FULL_GAME' else period + '_RUN_LINE'}:HOME:{home_line:+.1f}"
            add(id=lid, family="RUN_LINE", period=period, kind="RUN_LINE", horizon=horizon,
                marginThreshold=threshold,
                positiveLabel=f"HOME {home_line:+.1f}", negativeLabel=f"AWAY {away_line:+.1f}",
                currentAnalyticalPath=current,
                providerStatus="SUPPORTED" if period != "FIRST_3" else "SUPPORTED_RESEARCH_PATH_MISSING")

    total_grids = {
        "FIRST_3": (1.5, 2.5, 3.5, 4.5),
        "FIRST_5": (2.5, 3.5, 4.5, 5.5, 6.5),
        "FULL_GAME": (6.5, 7.5, 8.5, 9.5, 10.5),
    }
    for horizon, lines in total_grids.items():
        for line in lines:
            market = "TOTAL" if horizon == "FULL_GAME" else f"{horizon}_TOTAL"
            add(id=f"{market}:{line:.1f}", family="TOTAL", period=horizon, kind="TOTAL", horizon=horizon, line=line,
                positiveLabel=f"OVER {line:.1f}", negativeLabel=f"UNDER {line:.1f}",
                currentAnalyticalPath=horizon in ("FULL_GAME", "FIRST_5"), providerStatus="SUPPORTED")

    add(id="NRFI_YRFI", family="TOTAL", period="FIRST_1", kind="NRFI", horizon="FIRST_INNING",
        positiveLabel="NRFI", negativeLabel="YRFI", currentAnalyticalPath=False, providerStatus="SUPPORTED_RESEARCH_PATH_MISSING")

    team_total_grids = {
        "FIRST_3": (0.5, 1.5, 2.5, 3.5),
        "FIRST_5": (0.5, 1.5, 2.5, 3.5, 4.5),
        "FULL_GAME": (1.5, 2.5, 3.5, 4.5, 5.5, 6.5),
    }
    for horizon, lines in team_total_grids.items():
        for team in ("HOME", "AWAY"):
            for line in lines:
                add(
                    id=f"{horizon}_TEAM_TOTAL:{team}:{line:.1f}",
                    family="TEAM_TOTAL",
                    period=horizon,
                    kind="TEAM_TOTAL",
                    horizon=horizon,
                    team=team,
                    line=line,
                    positiveLabel=f"{team} OVER {line:.1f}",
                    negativeLabel=f"{team} UNDER {line:.1f}",
                    currentAnalyticalPath=False,
                    providerStatus="SUPPORTED_RESEARCH_PATH_MISSING" if horizon == "FULL_GAME" else "CANONICAL_GAP_RESEARCH_ONLY",
                )
    return specs


def label_for(row, spec):
    o = row["outcomes"][spec["horizon"]]
    if spec["kind"] == "SIDE":
        if o["homeRuns"] == o["awayRuns"]:
            return None
        return 1 if o["homeRuns"] > o["awayRuns"] else 0
    if spec["kind"] == "RUN_LINE":
        margin = o["homeRuns"] - o["awayRuns"]
        return 1 if margin > spec["marginThreshold"] else 0
    if spec["kind"] == "TOTAL":
        return 1 if o["totalRuns"] > spec["line"] else 0
    if spec["kind"] == "TEAM_TOTAL":
        runs = o["homeRuns"] if spec["team"] == "HOME" else o["awayRuns"]
        return 1 if runs > spec["line"] else 0
    if spec["kind"] == "NRFI":
        return 1 if o["totalRuns"] == 0 else 0
    raise ValueError(spec["kind"])


class OnlineStats:
    def __init__(self, feature_names):
        self.feature_names = feature_names
        self.n = [0, 0]
        self.dates = set()
        self.fs = {
            name: {"sum": [0.0, 0.0], "sumsq": [0.0, 0.0], "count": [0, 0]}
            for name in feature_names
        }

    @property
    def total(self):
        return self.n[0] + self.n[1]

    def ready(self):
        return self.total >= MIN_TRAIN_ROWS and len(self.dates) >= MIN_TRAIN_DATES and min(self.n) >= MIN_CLASS_ROWS

    def update(self, row, y):
        self.n[y] += 1
        self.dates.add(row["officialDate"])
        for name, v in row["features"].items():
            if name not in self.fs or not finite(v):
                continue
            x = float(v)
            s = self.fs[name]
            s["sum"][y] += x
            s["sumsq"][y] += x * x
            s["count"][y] += 1

    def model(self):
        if not self.ready():
            return None
        candidates = []
        for name, s in self.fs.items():
            c0, c1 = s["count"]
            if c0 < max(30, int(0.55 * self.n[0])) or c1 < max(30, int(0.55 * self.n[1])):
                continue
            m0, m1 = s["sum"][0] / c0, s["sum"][1] / c1
            v0 = max(0.0, s["sumsq"][0] / c0 - m0 * m0)
            v1 = max(0.0, s["sumsq"][1] / c1 - m1 * m1)
            pooled = (v0 * c0 + v1 * c1) / max(c0 + c1, 1)
            if pooled <= EPS:
                continue
            sd = math.sqrt(pooled)
            effect = (m1 - m0) / sd
            reliability = min(1.0, min(c0, c1) / RELIABILITY_PRIOR)
            shrunk_effect = effect * reliability
            coverage = min(c0 / self.n[0], c1 / self.n[1])
            candidates.append({
                "feature": name,
                "mu0": m0,
                "mu1": m1,
                "sd": sd,
                "effect": effect,
                "shrunkEffect": shrunk_effect,
                "coverage": coverage,
                "rankScore": abs(shrunk_effect) * coverage,
            })
        candidates.sort(key=lambda x: (-x["rankScore"], x["feature"]))
        selected = candidates[:TOP_K_FEATURES]
        if len(selected) < 3:
            return None
        return {
            "n0": self.n[0],
            "n1": self.n[1],
            "trainingRows": self.total,
            "trainingDates": len(self.dates),
            "logPriorOdds": math.log((self.n[1] + 1.0) / (self.n[0] + 1.0)),
            "features": selected,
        }


def predict(row, spec, model):
    contributions = []
    score = model["logPriorOdds"]
    used = 0
    for f in model["features"]:
        v = row["features"].get(f["feature"])
        if not finite(v):
            continue
        x = float(v)
        midpoint = 0.5 * (f["mu0"] + f["mu1"])
        z = (x - midpoint) / f["sd"]
        contribution = f["shrunkEffect"] * z
        contributions.append({
            "feature": f["feature"],
            "value": x,
            "contribution": contribution,
            "trainingEffect": f["effect"],
        })
        score += contribution
        used += 1
    if used < 3:
        return None
    evidence = (score - model["logPriorOdds"]) / math.sqrt(used)
    normalized_score = model["logPriorOdds"] + evidence
    p1 = sigmoid(normalized_score)
    pred = 1 if p1 >= 0.5 else 0
    confidence = p1 if pred == 1 else 1.0 - p1
    for c in contributions:
        c["alignedWithPrediction"] = c["contribution"] if pred == 1 else -c["contribution"]
    explanations = [
        c for c in sorted(contributions, key=lambda x: (-x["alignedWithPrediction"], x["feature"]))
        if c["alignedWithPrediction"] > 0
    ][:5]
    return {
        "prediction": pred,
        "predictedLabel": spec["positiveLabel"] if pred == 1 else spec["negativeLabel"],
        "pPositiveEstimate": p1,
        "confidence": confidence,
        "score": normalized_score,
        "featuresUsed": used,
        "explanations": explanations,
        "trainingRows": model["trainingRows"],
        "trainingDates": model["trainingDates"],
    }


def confidence_band(c):
    if c < 0.55:
        return "50-55"
    if c < 0.60:
        return "55-60"
    if c < 0.65:
        return "60-65"
    if c < 0.70:
        return "65-70"
    if c < 0.75:
        return "70-75"
    return "75+"


class Metric:
    def __init__(self):
        self.n = 0
        self.correct = 0
        self.pos = 0
        self.brier = 0.0
        self.by_season = defaultdict(lambda: [0, 0])
        self.bands = defaultdict(lambda: [0, 0])
        self.driver_correct = defaultdict(lambda: [0, 0.0])
        self.driver_wrong = defaultdict(lambda: [0, 0.0])

    def add(self, season, y, pred):
        self.n += 1
        self.pos += y
        ok = pred["prediction"] == y
        self.correct += int(ok)
        self.brier += (pred["pPositiveEstimate"] - y) ** 2
        self.by_season[season][0] += int(ok)
        self.by_season[season][1] += 1
        b = confidence_band(pred["confidence"])
        self.bands[b][0] += int(ok)
        self.bands[b][1] += 1
        aligned_sign = 1 if y == 1 else -1
        for ex in pred["explanations"]:
            actual_aligned = ex["contribution"] * aligned_sign
            bucket = self.driver_correct if ok else self.driver_wrong
            bucket[ex["feature"]][0] += 1
            bucket[ex["feature"]][1] += actual_aligned

    def report(self):
        majority = max(self.pos, self.n - self.pos) / self.n if self.n else None
        accuracy = self.correct / self.n if self.n else None

        def top_drivers(source):
            rows = []
            for k, (count, total) in source.items():
                rows.append({
                    "feature": k,
                    "appearances": count,
                    "meanActualAlignedContribution": total / count if count else 0.0,
                })
            return sorted(rows, key=lambda x: (-x["appearances"], -x["meanActualAlignedContribution"], x["feature"]))[:12]

        return {
            "scoreablePredictions": self.n,
            "correct": self.correct,
            "accuracy": accuracy,
            "actualPositiveRate": self.pos / self.n if self.n else None,
            "majorityClassBaseline": majority,
            "liftVsMajorityBaseline": accuracy - majority if self.n else None,
            "meanBrier": self.brier / self.n if self.n else None,
            "bySeason": {
                k: {"correct": v[0], "n": v[1], "accuracy": v[0] / v[1] if v[1] else None}
                for k, v in sorted(self.by_season.items())
            },
            "byConfidenceBand": {
                k: {"correct": self.bands[k][0], "n": self.bands[k][1], "accuracy": self.bands[k][0] / self.bands[k][1] if self.bands[k][1] else None}
                for k in ("50-55", "55-60", "60-65", "65-70", "70-75", "75+")
                if self.bands[k][1]
            },
            "correctPredictionDrivers": top_drivers(self.driver_correct),
            "wrongPredictionDrivers": top_drivers(self.driver_wrong),
        }


def summarize_best(records):
    if not records:
        return {"games": 0}
    correct = sum(int(r["correct"]) for r in records)
    by_family = Counter(r["family"] for r in records)
    by_period = Counter(r["period"] for r in records)
    bands = defaultdict(lambda: [0, 0])
    for r in records:
        b = confidence_band(r["confidence"])
        bands[b][0] += int(r["correct"])
        bands[b][1] += 1
    return {
        "games": len(records),
        "correct": correct,
        "accuracy": correct / len(records),
        "meanConfidence": sum(r["confidence"] for r in records) / len(records),
        "byFamily": dict(sorted(by_family.items())),
        "byPeriod": dict(sorted(by_period.items())),
        "byConfidenceBand": {
            k: {"correct": v[0], "n": v[1], "accuracy": v[0] / v[1]}
            for k, v in sorted(bands.items())
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season-table", action="append", required=True, help="LABEL=path")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = []
    source_counts = {}
    feature_names = set()
    for item in args.season_table:
        if "=" not in item:
            raise SystemExit("STEP12V_SEASON_TABLE_FORMAT_INVALID")
        label, path = item.split("=", 1)
        table = load(path)
        if table.get("schemaVersion") != FEATURE_SCHEMA:
            raise SystemExit(f"STEP12V_FEATURE_SCHEMA_INVALID:{label}")
        source_counts[label] = table["counts"]
        for r in table["rows"]:
            x = dict(r)
            x["seasonLabel"] = label
            rows.append(x)
            feature_names.update(k for k, v in r["features"].items() if finite(v))

    rows.sort(key=lambda r: (r["officialDate"], int(r["gamePk"])))
    feature_names = sorted(feature_names)
    specs = target_specs()
    stats = {s["id"]: OnlineStats(feature_names) for s in specs}
    metrics = {s["id"]: Metric() for s in specs}

    by_date = defaultdict(list)
    for r in rows:
        by_date[r["officialDate"]].append(r)

    winner_predictions = []
    best_current = []
    best_all = []
    scoreable_dates = set()

    for date in sorted(by_date):
        date_predictions = defaultdict(list)
        # Predict first. Current-date outcomes are not allowed into training state.
        for row in sorted(by_date[date], key=lambda r: int(r["gamePk"])):
            if not row.get("t5PregameValid"):
                continue
            for spec in specs:
                y = label_for(row, spec)
                if y is None:
                    continue
                model = stats[spec["id"]].model()
                if model is None:
                    continue
                pred = predict(row, spec, model)
                if pred is None:
                    continue
                pred["actual"] = y
                pred["correct"] = pred["prediction"] == y
                pred["targetId"] = spec["id"]
                pred["family"] = spec["family"]
                pred["period"] = spec["period"]
                pred["currentAnalyticalPath"] = spec["currentAnalyticalPath"]
                pred["gamePk"] = row["gamePk"]
                pred["officialDate"] = row["officialDate"]
                pred["seasonLabel"] = row["seasonLabel"]
                metrics[spec["id"]].add(row["seasonLabel"], y, pred)
                date_predictions[row["gamePk"]].append(pred)
                scoreable_dates.add(date)

                if spec["id"] == "ML":
                    winner_predictions.append({
                        "gamePk": row["gamePk"],
                        "officialDate": date,
                        "seasonLabel": row["seasonLabel"],
                        "homeTeamId": row["homeTeamId"],
                        "awayTeamId": row["awayTeamId"],
                        "actualWinner": spec["positiveLabel"] if y == 1 else spec["negativeLabel"],
                        "predictedWinner": pred["predictedLabel"],
                        "correct": pred["correct"],
                        "confidence": pred["confidence"],
                        "pHomeEstimate": pred["pPositiveEstimate"],
                        "topPregameDrivers": pred["explanations"],
                        "trainingRows": pred["trainingRows"],
                        "trainingDates": pred["trainingDates"],
                    })

        # Route before the date is added to training. Outcome is used only to score.
        for row in by_date[date]:
            ps = date_predictions.get(row["gamePk"], [])
            if not ps:
                continue
            all_best = max(ps, key=lambda p: (p["confidence"], p["targetId"]))
            current_ps = [p for p in ps if p["currentAnalyticalPath"]]
            if current_ps:
                current_best = max(current_ps, key=lambda p: (p["confidence"], p["targetId"]))
                best_current.append({
                    "gamePk": row["gamePk"],
                    "officialDate": date,
                    "seasonLabel": row["seasonLabel"],
                    "targetId": current_best["targetId"],
                    "predictedLabel": current_best["predictedLabel"],
                    "family": current_best["family"],
                    "period": current_best["period"],
                    "confidence": current_best["confidence"],
                    "correct": current_best["correct"],
                    "topPregameDrivers": current_best["explanations"],
                })
            best_all.append({
                "gamePk": row["gamePk"],
                "officialDate": date,
                "seasonLabel": row["seasonLabel"],
                "targetId": all_best["targetId"],
                "predictedLabel": all_best["predictedLabel"],
                "family": all_best["family"],
                "period": all_best["period"],
                "confidence": all_best["confidence"],
                "correct": all_best["correct"],
                "topPregameDrivers": all_best["explanations"],
            })

        # Only after all predictions/routing are fixed may this date train tomorrow.
        for row in sorted(by_date[date], key=lambda r: int(r["gamePk"])):
            if not row.get("t5PregameValid"):
                continue
            for spec in specs:
                y = label_for(row, spec)
                if y is not None:
                    stats[spec["id"]].update(row, y)

    target_reports = []
    for spec in specs:
        target_reports.append({
            "target": {k: v for k, v in spec.items() if k != "kind"},
            "metrics": metrics[spec["id"]].report(),
        })

    target_reports.sort(
        key=lambda x: (
            -(x["metrics"]["accuracy"] if x["metrics"]["accuracy"] is not None else -1),
            -x["metrics"]["scoreablePredictions"],
            x["target"]["id"],
        )
    )

    ml_report = next(x for x in target_reports if x["target"]["id"] == "ML")
    report = {
        "schemaVersion": SCHEMA,
        "evidenceStatus": "DATE_BY_DATE_WALK_FORWARD_SPORTING_LEARNING_RESEARCH_ONLY_NO_PRICE_NO_LIVE_PROMOTION",
        "method": {
            "unitOfPrediction": "GAME_MARKET_BEFORE_OFFICIAL_DATE_OUTCOMES_ENTER_TRAINING",
            "sameDateTrainingLeakageAllowed": False,
            "futureSeasonStatsAllowed": False,
            "finalSeasonStatsUsedForEarlierGame": False,
            "onlineTrainingStateCarriesOnlyPriorDates": True,
            "modelFamily": "SHRUNK_DIAGONAL_DISCRIMINANT_WITH_TRAINING_ONLY_DYNAMIC_FEATURE_SELECTION",
            "topKFeaturesPerTarget": TOP_K_FEATURES,
            "minimumTrainingRows": MIN_TRAIN_ROWS,
            "minimumTrainingDates": MIN_TRAIN_DATES,
            "minimumRowsPerClass": MIN_CLASS_ROWS,
            "probabilityEstimateCalibrationStatus": "UNFORMALLY_CALIBRATED_SCORE_TRANSFORM_REQUIRES_PROSPECTIVE_PRICE_AWARE_CALIBRATION",
        },
        "source": {
            "seasonTables": source_counts,
            "rows": len(rows),
            "dates": len(by_date),
            "numericFeatureCount": len(feature_names),
            "featureNames": feature_names,
        },
        "marketUniverse": {
            "targetCount": len(specs),
            "currentAnalyticalPathTargets": sum(1 for s in specs if s["currentAnalyticalPath"]),
            "researchOnlyTargets": sum(1 for s in specs if not s["currentAnalyticalPath"]),
            "coveredFamilies": sorted(set(s["family"] for s in specs)),
            "coveredPeriods": sorted(set(s["period"] for s in specs)),
            "playerPropsIncluded": False,
            "playerPropReason": "CURRENT_GAME_LEVEL_T5_TABLE_HAS_NO_HISTORICAL_PLAYER_SPECIFIC_PREGAME_FEATURE_LINE_CONTRACT; PLAYER_PROPS_REQUIRE_A_DEDICATED_STEP12V_B_TABLE.",
            "first7Included": False,
            "first7Reason": "CURRENT_OFFICIAL_HISTORICAL_OUTCOME_DATASET_USED_BY_STEP12_DOES_NOT_MATERIALIZE_FIRST_7.",
        },
        "winnerAnatomy": {
            "fullGameWinnerTarget": ml_report,
            "winnerPredictionCount": len(winner_predictions),
            "winnerPredictions": winner_predictions,
        },
        "marketLearning": {
            "targets": target_reports,
            "scoreableDates": len(scoreable_dates),
            "bestCurrentAnalyticalPathSignal": summarize_best(best_current),
            "bestAllResearchSignal": summarize_best(best_all),
            "bestCurrentAnalyticalPathByGame": best_current,
            "bestAllResearchByGame": best_all,
        },
        "policy": {
            "historicalPricesUsed": False,
            "evOrRoiClaimAllowed": False,
            "marketSelectionUsesOutcomeAfterPrediction": False,
            "liveFilterChanged": False,
            "betEliteProduced": False,
            "stakeCalculated": False,
            "automaticBetPlacement": False,
            "prospectiveStep11cStillRequiredForOperationalPromotion": True,
        },
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")

    top_targets = [
        {
            "id": x["target"]["id"],
            "accuracy": x["metrics"]["accuracy"],
            "n": x["metrics"]["scoreablePredictions"],
            "liftVsMajority": x["metrics"]["liftVsMajorityBaseline"],
        }
        for x in target_reports[:12]
    ]
    print(json.dumps({
        "ok": True,
        "rows": len(rows),
        "dates": len(by_date),
        "targetCount": len(specs),
        "winnerML": ml_report["metrics"],
        "bestCurrent": report["marketLearning"]["bestCurrentAnalyticalPathSignal"],
        "topTargets": top_targets,
    }, indent=2))


if __name__ == "__main__":
    main()
