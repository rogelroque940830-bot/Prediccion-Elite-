#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from collections import defaultdict

SCHEMA = "courtedge-mlb-projected-vs-confirmed-lineup-sensitivity.v1"
BASE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1"
CONTRACT_SCHEMA = "courtedge-mlb-projected-vs-confirmed-lineup-sensitivity-contract.v1"
V16_MANIFEST_SCHEMA = "courtedge-p0-step12v16-pure-settlement-model-manifest.v1"
SEASONS = ("2024", "2025", "2026_YTD")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def canonical_digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def sigmoid(value):
    value = max(-50.0, min(50.0, float(value)))
    return 1.0 / (1.0 + math.exp(-value))


def quantile(values, q):
    if not values:
        return None
    xs = sorted(float(v) for v in values)
    if len(xs) == 1:
        return xs[0]
    pos = (len(xs) - 1) * float(q)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return xs[lo]
    w = pos - lo
    return xs[lo] * (1.0 - w) + xs[hi] * w


def summarize(values, quantiles):
    xs = [float(v) for v in values if finite(v)]
    if not xs:
        return {"n": 0, "mean": None, "max": None, "quantiles": {str(q): None for q in quantiles}}
    return {
        "n": len(xs),
        "mean": sum(xs) / len(xs),
        "max": max(xs),
        "quantiles": {str(q): quantile(xs, q) for q in quantiles},
    }


def valid_lineup(snapshot):
    if not snapshot or not snapshot.get("complete"):
        return None, None
    try:
        home = [int(v) for v in snapshot.get("homeBattingOrder", [])]
        away = [int(v) for v in snapshot.get("awayBattingOrder", [])]
    except Exception:
        return None, None
    if len(home) != 9 or len(away) != 9:
        return None, None
    if len(set(home)) != 9 or len(set(away)) != 9:
        return None, None
    if any(v <= 0 for v in home + away):
        return None, None
    return home, away


def lineup_exposure(team_id, order, team_prior_games, team_player_apps):
    games = int(team_prior_games[team_id])
    if games <= 0 or not order:
        return None
    return sum(team_player_apps[(team_id, int(pid))] / games for pid in order) / 9.0


def lineup_continuity(order, previous_order):
    if not order or not previous_order:
        return None
    return len(set(order) & set(previous_order)) / 9.0


def identity_metrics(projected, confirmed):
    pset = set(projected)
    cset = set(confirmed)
    common = pset & cset
    exact_slots = sum(1 for i in range(9) if projected[i] == confirmed[i])
    ppos = {pid: i for i, pid in enumerate(projected)}
    cpos = {pid: i for i, pid in enumerate(confirmed)}
    displacement = [abs(ppos[pid] - cpos[pid]) for pid in common]
    return {
        "identityOverlap": len(common),
        "replacements": 9 - len(common),
        "exactSlotMatches": exact_slots,
        "meanCommonPlayerSlotDisplacement": (
            sum(displacement) / len(displacement) if displacement else None
        ),
    }


def score_manifest_model(model, features):
    prep = model["preprocessor"]
    names = prep["features"]
    eta = float(model["intercept"])
    for idx, name in enumerate(names):
        raw = features.get(name)
        value = float(raw) if finite(raw) else float(prep["medianImpute"][idx])
        z = (value - float(prep["mean"][idx])) / float(prep["scale"][idx])
        eta += float(model["coefficients"][idx]) * z
    cal = model.get("calibration")
    if cal:
        eta = float(cal["slope"]) * eta + float(cal["intercept"])
    return sigmoid(eta)


def score_embedded_model(model, features):
    eta = float(model["intercept"])
    for name, coef, mean, median_impute, scale in model["features"]:
        raw = features.get(name)
        value = float(raw) if finite(raw) else float(median_impute)
        eta += float(coef) * ((value - float(mean)) / float(scale))
    return sigmoid(eta)


def premium(features, contract):
    cfg = contract["frozenAPlusPremium"]["premiumA"]
    required = (
        ("team_win10_diff", cfg["team_win10_diff_gte"]),
        ("starter_kbb_adv", cfg["starter_kbb_adv_gte"]),
        ("lineup_exposure_rate_adv", cfg["lineup_exposure_rate_adv_gte"]),
    )
    return all(finite(features.get(name)) and float(features[name]) >= float(threshold) for name, threshold in required)


def a_plus(features, c4_p, full13_p, contract):
    cfg = contract["frozenAPlusPremium"]["aPlus"]
    return premium(features, contract) and c4_p >= float(cfg["c4PHomeGte"]) and full13_p >= float(cfg["full13PHomeGte"])


def route_label(is_aplus, is_premium):
    if is_aplus:
        return "A_PLUS"
    if is_premium:
        return "PREMIUM"
    return "NO_PLAY_PARENT"


def signed_delta(projected, confirmed):
    return float(projected) - float(confirmed)


def build_report(step12_root, manifest, contract):
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("LINEUP_SENSITIVITY_CONTRACT_INVALID")
    if manifest.get("schemaVersion") != V16_MANIFEST_SCHEMA:
        raise SystemExit("LINEUP_SENSITIVITY_V16_MANIFEST_SCHEMA_INVALID")
    if canonical_digest(manifest) != contract["parentEvidence"]["v16ManifestSha256"]:
        raise SystemExit("LINEUP_SENSITIVITY_V16_MANIFEST_DIGEST_DRIFT")

    v16 = manifest["fullGame"]
    if v16["preprocessor"]["features"] != [
        "lineup_exposure_rate_adv",
        "starter_kbb_adv",
        "combined_team_rs10",
        "team_rd10_diff",
    ]:
        raise SystemExit("LINEUP_SENSITIVITY_V16_C4_FEATURE_DRIFT")

    quantiles = contract["quantiles"]
    records = []
    season_summaries = {}
    parity_max_exposure = 0.0
    parity_max_continuity = 0.0
    parity_exposure_n = 0
    parity_continuity_n = 0

    for season in SEASONS:
        table_path = os.path.join(step12_root, season, "game-anatomy-feature-table.json")
        lineup_path = os.path.join(step12_root, season, "cohort", "pregame-lineup-history.json")
        table = load(table_path)
        lineups = load(lineup_path)
        if table.get("schemaVersion") != BASE_SCHEMA:
            raise SystemExit(f"LINEUP_SENSITIVITY_BASE_SCHEMA_INVALID:{season}")

        rows = table.get("rows", [])
        snapshots = {int(x["gamePk"]): x for x in lineups.get("snapshots", [])}
        valid_target_count = sum(r.get("t5PregameValid") is True for r in rows)
        expected = int(contract["expectedCanonicalRows"][season])
        if valid_target_count != expected:
            raise SystemExit(f"LINEUP_SENSITIVITY_CANONICAL_ROW_DRIFT:{season}:{valid_target_count}:{expected}")

        by_date = defaultdict(list)
        for row in rows:
            by_date[str(row["officialDate"])].append(row)

        team_prior_games = defaultdict(int)
        team_player_apps = defaultdict(int)
        previous_lineup = {}
        season_records = []

        for date in sorted(by_date):
            day_rows = sorted(by_date[date], key=lambda r: int(r["gamePk"]))

            # Score the whole official date before any same-date lineup can update projection state.
            for row in day_rows:
                if row.get("t5PregameValid") is not True:
                    continue
                pk = int(row["gamePk"])
                snapshot = snapshots.get(pk)
                home_confirmed, away_confirmed = valid_lineup(snapshot)
                if home_confirmed is None or away_confirmed is None:
                    continue

                home_id = int(row["homeTeamId"])
                away_id = int(row["awayTeamId"])
                home_projected = previous_lineup.get(home_id)
                away_projected = previous_lineup.get(away_id)
                if not home_projected or not away_projected:
                    continue

                home_exp_confirmed = lineup_exposure(home_id, home_confirmed, team_prior_games, team_player_apps)
                away_exp_confirmed = lineup_exposure(away_id, away_confirmed, team_prior_games, team_player_apps)
                home_exp_projected = lineup_exposure(home_id, home_projected, team_prior_games, team_player_apps)
                away_exp_projected = lineup_exposure(away_id, away_projected, team_prior_games, team_player_apps)
                if None in (home_exp_confirmed, away_exp_confirmed, home_exp_projected, away_exp_projected):
                    continue

                confirmed_exposure_adv = home_exp_confirmed - away_exp_confirmed
                projected_exposure_adv = home_exp_projected - away_exp_projected

                home_cont_confirmed = lineup_continuity(home_confirmed, previous_lineup.get(home_id))
                away_cont_confirmed = lineup_continuity(away_confirmed, previous_lineup.get(away_id))
                home_cont_projected = lineup_continuity(home_projected, previous_lineup.get(home_id))
                away_cont_projected = lineup_continuity(away_projected, previous_lineup.get(away_id))
                if None in (home_cont_confirmed, away_cont_confirmed, home_cont_projected, away_cont_projected):
                    continue
                confirmed_cont_adv = home_cont_confirmed - away_cont_confirmed
                projected_cont_adv = home_cont_projected - away_cont_projected

                canonical = row.get("features") or {}
                if finite(canonical.get("lineup_exposure_rate_adv")):
                    diff = abs(confirmed_exposure_adv - float(canonical["lineup_exposure_rate_adv"]))
                    parity_max_exposure = max(parity_max_exposure, diff)
                    parity_exposure_n += 1
                    if diff > 1e-12:
                        raise SystemExit(f"LINEUP_SENSITIVITY_EXPOSURE_PARITY_FAILED:{season}:{pk}:{diff}")
                if finite(canonical.get("lineup_continuity_rate_adv")):
                    diff = abs(confirmed_cont_adv - float(canonical["lineup_continuity_rate_adv"]))
                    parity_max_continuity = max(parity_max_continuity, diff)
                    parity_continuity_n += 1
                    if diff > 1e-12:
                        raise SystemExit(f"LINEUP_SENSITIVITY_CONTINUITY_PARITY_FAILED:{season}:{pk}:{diff}")

                confirmed_features = dict(canonical)
                projected_features = dict(canonical)
                confirmed_features["lineup_exposure_rate_adv"] = confirmed_exposure_adv
                confirmed_features["lineup_continuity_rate_adv"] = confirmed_cont_adv
                projected_features["lineup_exposure_rate_adv"] = projected_exposure_adv
                projected_features["lineup_continuity_rate_adv"] = projected_cont_adv

                v16_confirmed = score_manifest_model(v16, confirmed_features)
                v16_projected = score_manifest_model(v16, projected_features)
                c4_confirmed = score_embedded_model(contract["frozenAPlusPremium"]["c4Model"], confirmed_features)
                c4_projected = score_embedded_model(contract["frozenAPlusPremium"]["c4Model"], projected_features)
                full13_confirmed = score_embedded_model(contract["frozenAPlusPremium"]["full13Model"], confirmed_features)
                full13_projected = score_embedded_model(contract["frozenAPlusPremium"]["full13Model"], projected_features)

                premium_confirmed = premium(confirmed_features, contract)
                premium_projected = premium(projected_features, contract)
                aplus_confirmed = a_plus(confirmed_features, c4_confirmed, full13_confirmed, contract)
                aplus_projected = a_plus(projected_features, c4_projected, full13_projected, contract)

                hm = identity_metrics(home_projected, home_confirmed)
                am = identity_metrics(away_projected, away_confirmed)
                total_replacements = hm["replacements"] + am["replacements"]
                exact_slots = hm["exactSlotMatches"] + am["exactSlotMatches"]
                overlap = hm["identityOverlap"] + am["identityOverlap"]

                rec = {
                    "season": season,
                    "officialDate": date,
                    "gamePk": pk,
                    "homeTeamId": home_id,
                    "awayTeamId": away_id,
                    "lineup": {
                        "home": hm,
                        "away": am,
                        "combinedIdentityOverlapOf18": overlap,
                        "combinedReplacementsOf18": total_replacements,
                        "combinedExactSlotMatchesOf18": exact_slots,
                    },
                    "features": {
                        "confirmedLineupExposureAdv": confirmed_exposure_adv,
                        "projectedLineupExposureAdv": projected_exposure_adv,
                        "confirmedLineupContinuityAdv": confirmed_cont_adv,
                        "projectedLineupContinuityAdv": projected_cont_adv,
                    },
                    "probabilities": {
                        "v16ConfirmedHome": v16_confirmed,
                        "v16ProjectedHome": v16_projected,
                        "v16SignedDeltaProjectedMinusConfirmed": signed_delta(v16_projected, v16_confirmed),
                        "v16AbsDelta": abs(v16_projected - v16_confirmed),
                        "c4ConfirmedHome": c4_confirmed,
                        "c4ProjectedHome": c4_projected,
                        "c4AbsDelta": abs(c4_projected - c4_confirmed),
                        "full13ConfirmedHome": full13_confirmed,
                        "full13ProjectedHome": full13_projected,
                        "full13AbsDelta": abs(full13_projected - full13_confirmed),
                    },
                    "decisions": {
                        "v16SelectedSideConfirmed": "HOME" if v16_confirmed >= 0.5 else "AWAY",
                        "v16SelectedSideProjected": "HOME" if v16_projected >= 0.5 else "AWAY",
                        "v16SelectedSideFlip": (v16_confirmed >= 0.5) != (v16_projected >= 0.5),
                        "premiumConfirmed": premium_confirmed,
                        "premiumProjected": premium_projected,
                        "premiumFlip": premium_confirmed != premium_projected,
                        "aPlusConfirmed": aplus_confirmed,
                        "aPlusProjected": aplus_projected,
                        "aPlusFlip": aplus_confirmed != aplus_projected,
                        "parentRouteConfirmed": route_label(aplus_confirmed, premium_confirmed),
                        "parentRouteProjected": route_label(aplus_projected, premium_projected),
                        "parentRouteFlip": route_label(aplus_confirmed, premium_confirmed) != route_label(aplus_projected, premium_projected),
                    },
                }
                records.append(rec)
                season_records.append(rec)

            # Update canonical lineup state only after all target games on this date were scored.
            for row in day_rows:
                pk = int(row["gamePk"])
                home_id = int(row["homeTeamId"])
                away_id = int(row["awayTeamId"])
                if row.get("t5PregameValid") is True:
                    home, away = valid_lineup(snapshots.get(pk))
                    if home is not None and away is not None:
                        for tid, order in ((home_id, home), (away_id, away)):
                            for pid in order:
                                team_player_apps[(tid, int(pid))] += 1
                            previous_lineup[tid] = list(order)
                team_prior_games[home_id] += 1
                team_prior_games[away_id] += 1

        season_summaries[season] = {"canonicalT5Rows": valid_target_count, "pairedProjectedConfirmedRows": len(season_records)}

    # Aggregate sensitivity.
    v16_abs = [r["probabilities"]["v16AbsDelta"] for r in records]
    c4_abs = [r["probabilities"]["c4AbsDelta"] for r in records]
    full13_abs = [r["probabilities"]["full13AbsDelta"] for r in records]
    overlap_rates = [r["lineup"]["combinedIdentityOverlapOf18"] / 18.0 for r in records]
    exact_slot_rates = [r["lineup"]["combinedExactSlotMatchesOf18"] / 18.0 for r in records]

    by_replacements = {}
    grouped = defaultdict(list)
    for r in records:
        grouped[int(r["lineup"]["combinedReplacementsOf18"])].append(r)
    for replacements in sorted(grouped):
        rs = grouped[replacements]
        by_replacements[str(replacements)] = {
            "n": len(rs),
            "meanAbsV16ProbabilityDelta": sum(x["probabilities"]["v16AbsDelta"] for x in rs) / len(rs),
            "v16SideFlipRate": sum(bool(x["decisions"]["v16SelectedSideFlip"]) for x in rs) / len(rs),
            "parentRouteFlipRate": sum(bool(x["decisions"]["parentRouteFlip"]) for x in rs) / len(rs),
        }

    # Daily strongest V16 sporting probability sensitivity. This is intentionally not claimed
    # to reproduce the production preprice hierarchy; it isolates whether lineup substitution
    # changes which game has the largest frozen V16 selected-side probability on a date.
    by_date = defaultdict(list)
    for r in records:
        by_date[r["officialDate"]].append(r)
    daily = []
    for date in sorted(by_date):
        rs = by_date[date]
        projected = sorted(
            rs,
            key=lambda r: (-max(r["probabilities"]["v16ProjectedHome"], 1-r["probabilities"]["v16ProjectedHome"]), r["gamePk"]),
        )[0]
        confirmed = sorted(
            rs,
            key=lambda r: (-max(r["probabilities"]["v16ConfirmedHome"], 1-r["probabilities"]["v16ConfirmedHome"]), r["gamePk"]),
        )[0]
        daily.append({
            "officialDate": date,
            "projectedGamePk": projected["gamePk"],
            "confirmedGamePk": confirmed["gamePk"],
            "gameIdentityFlip": projected["gamePk"] != confirmed["gamePk"],
            "projectedSide": projected["decisions"]["v16SelectedSideProjected"],
            "confirmedSide": confirmed["decisions"]["v16SelectedSideConfirmed"],
            "sameGameSideFlip": projected["gamePk"] == confirmed["gamePk"] and projected["decisions"]["v16SelectedSideProjected"] != confirmed["decisions"]["v16SelectedSideConfirmed"],
        })

    report = {
        "schemaVersion": SCHEMA,
        "classification": "PROJECTED_VS_CONFIRMED_LINEUP_SENSITIVITY_MEASURED_NO_PRODUCTION_CHANGE",
        "projectionMethod": contract["projection"],
        "custody": {
            "v16ManifestSha256": canonical_digest(manifest),
            "canonicalConfirmedLineupSource": "STEP12V3_T_MINUS_5",
            "confirmedExposureParityRows": parity_exposure_n,
            "confirmedExposureParityMaxAbsDifference": parity_max_exposure,
            "confirmedContinuityParityRows": parity_continuity_n,
            "confirmedContinuityParityMaxAbsDifference": parity_max_continuity,
        },
        "coverage": {
            "bySeason": season_summaries,
            "pairedRows": len(records),
            "distinctOfficialDates": len(by_date),
        },
        "lineupIdentity": {
            "combinedPlayerIdentityOverlapRate": summarize(overlap_rates, quantiles),
            "combinedExactBattingSlotMatchRate": summarize(exact_slot_rates, quantiles),
            "meanPlayersReplacedAcrossTwoTeams": (
                sum(r["lineup"]["combinedReplacementsOf18"] for r in records) / len(records) if records else None
            ),
            "byCombinedReplacements": by_replacements,
        },
        "probabilitySensitivity": {
            "v16AbsoluteHomeProbabilityDelta": summarize(v16_abs, quantiles),
            "frozenC4AbsoluteHomeProbabilityDelta": summarize(c4_abs, quantiles),
            "frozenFull13AbsoluteHomeProbabilityDelta": summarize(full13_abs, quantiles),
            "v16SideFlips": sum(bool(r["decisions"]["v16SelectedSideFlip"]) for r in records),
            "v16SideFlipRate": sum(bool(r["decisions"]["v16SelectedSideFlip"]) for r in records) / len(records) if records else None,
        },
        "routeSensitivity": {
            "premiumFlips": sum(bool(r["decisions"]["premiumFlip"]) for r in records),
            "aPlusFlips": sum(bool(r["decisions"]["aPlusFlip"]) for r in records),
            "parentRouteFlips": sum(bool(r["decisions"]["parentRouteFlip"]) for r in records),
            "parentRouteFlipRate": sum(bool(r["decisions"]["parentRouteFlip"]) for r in records) / len(records) if records else None,
        },
        "dailyStrongestV16Sensitivity": {
            "dates": len(daily),
            "gameIdentityFlips": sum(bool(x["gameIdentityFlip"]) for x in daily),
            "gameIdentityFlipRate": sum(bool(x["gameIdentityFlip"]) for x in daily) / len(daily) if daily else None,
            "sameGameSideFlips": sum(bool(x["sameGameSideFlip"]) for x in daily),
            "note": "Diagnostic strongest frozen V16 selected-side probability among paired games; not claimed as exact production Daily BEST PICK parity."
        },
        "policy": {
            "outcomesRead": False,
            "marketPricesRead": False,
            "modelRefit": False,
            "recalibration": False,
            "thresholdSearch": False,
            "sameDateLineupLeakageAllowed": False,
            "futureLineupLeakageAllowed": False,
            "thirdPartyHistoricalProjectionClaimed": False,
            "v68Changed": False,
            "v80Changed": False,
            "productionRoutingChanged": False,
            "automaticBetPlacement": False,
            "realFinancialExposure": 0,
        },
        "dailyDiagnostics": daily,
    }
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step12-root", required=True)
    ap.add_argument("--v16-manifest", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    contract = load(args.contract)
    manifest = load(args.v16_manifest)
    report = build_report(args.step12_root, manifest, contract)
    dump(args.out, report)
    print(json.dumps({
        "classification": report["classification"],
        "coverage": report["coverage"],
        "lineupIdentity": report["lineupIdentity"],
        "probabilitySensitivity": report["probabilitySensitivity"],
        "routeSensitivity": report["routeSensitivity"],
        "dailyStrongestV16Sensitivity": report["dailyStrongestV16Sensitivity"],
        "custody": report["custody"],
        "policy": report["policy"],
    }, indent=2))


if __name__ == "__main__":
    main()
