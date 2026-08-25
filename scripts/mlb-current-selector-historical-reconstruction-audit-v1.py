#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import zipfile
from datetime import datetime, timezone

SCHEMA = "courtedge-mlb-current-selector-historical-reconstruction-audit.v1"
CONTRACT_SCHEMA = "courtedge-mlb-current-selector-historical-reconstruction-contract.v1"
PASS = "MLB_CURRENT_SELECTOR_HISTORICAL_RECONSTRUCTION_AUTHORIZED"
FAIL = "MLB_CURRENT_SELECTOR_HISTORICAL_RECONSTRUCTION_IMPOSSIBLE_FROM_IMMUTABLE_AVAILABLE_SOURCES"

RUN_CREATED_AT = {
    31659518059: "2026-08-13T02:01:04Z",
    31962659793: "2026-08-16T17:47:34Z",
    31704085189: "2026-08-13T13:16:24Z",
    31988197440: "2026-08-17T02:30:32Z",
}


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha(path):
    data = open(path, "rb").read()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def require_blob(path, expected, label):
    actual = git_blob_sha(path)
    if actual != expected:
        raise SystemExit(f"MLB_CURRENT_SELECTOR_AUTHORITY_BLOB_DRIFT:{label}:{actual}:{expected}")
    return actual


def require_zip_sha(path, expected_with_prefix, label):
    expected = expected_with_prefix.removeprefix("sha256:")
    actual = sha256_file(path)
    if actual != expected:
        raise SystemExit(f"MLB_CURRENT_SELECTOR_ARTIFACT_DIGEST_DRIFT:{label}:{actual}:{expected}")
    return actual


def zip_member_datetime_utc(info):
    # Corroborating archive metadata only. The decision does not rely on this
    # timestamp alone; exact current shortlist/rank custody is independently absent.
    value = datetime(*info.date_time, tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def inspect_step12v3(path):
    by_season = {}
    all_dates = set()
    all_pks = set()
    total_rows = 0
    member_times = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for season in ("2024", "2025", "2026_YTD"):
            member = f"{season}/game-anatomy-feature-table.json"
            if member not in names:
                raise SystemExit(f"MLB_CURRENT_SELECTOR_STEP12V3_MEMBER_MISSING:{member}")
            info = archive.getinfo(member)
            member_times.append(zip_member_datetime_utc(info))
            table = json.loads(archive.read(member))
            rows = [row for row in table.get("rows", []) if row.get("t5PregameValid") is True]
            dates = {str(row["officialDate"]) for row in rows}
            pks = {int(row["gamePk"]) for row in rows}
            if len(pks) != len(rows):
                raise SystemExit(f"MLB_CURRENT_SELECTOR_STEP12V3_DUPLICATE_GAME_PK:{season}")
            row_keys = sorted(rows[0].keys()) if rows else []
            by_season[season] = {
                "t5PregameValidRows": len(rows),
                "distinctOfficialDates": len(dates),
                "firstOfficialDate": min(dates) if dates else None,
                "lastOfficialDate": max(dates) if dates else None,
                "rowKeys": row_keys,
                "featureNames": list(table.get("featureNames", [])),
                "archiveMemberTimestamp": member_times[-1],
            }
            total_rows += len(rows)
            all_dates.update(dates)
            if all_pks.intersection(pks):
                raise SystemExit(f"MLB_CURRENT_SELECTOR_STEP12V3_CROSS_SEASON_GAME_PK_COLLISION:{season}")
            all_pks.update(pks)
    return {
        "combinedT5PregameValidRows": total_rows,
        "combinedDistinctOfficialDates": len(all_dates),
        "combinedDistinctGamePks": len(all_pks),
        "firstOfficialDate": min(all_dates) if all_dates else None,
        "lastOfficialDate": max(all_dates) if all_dates else None,
        "bySeason": by_season,
        "latestFeatureTableArchiveMemberTimestamp": max(member_times) if member_times else None,
    }


def inspect_v66(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {"v66-custody-report.json", "v66-pregame-custody.jsonl.gz"}
        if not required.issubset(names):
            raise SystemExit("MLB_CURRENT_SELECTOR_V66_REQUIRED_MEMBERS_MISSING")
        report = json.loads(archive.read("v66-custody-report.json"))
        members = {
            name: zip_member_datetime_utc(archive.getinfo(name))
            for name in sorted(required)
        }
    return {
        "classification": report.get("classification"),
        "archiveMembers": members,
    }


def inspect_v16(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {"pure-settlement-model-manifest.json", "pure-settlement-probability-report.json"}
        if not required.issubset(names):
            raise SystemExit("MLB_CURRENT_SELECTOR_V16_REQUIRED_MEMBERS_MISSING")
        manifest = json.loads(archive.read("pure-settlement-model-manifest.json"))
        return {
            "manifestSchemaVersion": manifest.get("schemaVersion"),
            "archiveMembers": {
                name: zip_member_datetime_utc(archive.getinfo(name))
                for name in sorted(required)
            },
        }


def inspect_v69(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if names != ["v69-confluence-frequency-quality-frontier.json"]:
            raise SystemExit("MLB_CURRENT_SELECTOR_V69_ARCHIVE_SHAPE_DRIFT")
        raw = archive.read(names[0])
        report = json.loads(raw)
        text = raw.decode("utf-8")
        return {
            "classification": report.get("classification"),
            "containsCurrentPrepriceRankField": "prepriceRank" in text,
            "containsCurrentRankedGamesField": "rankedGames" in text,
            "containsCurrentShortlistField": "shortlist" in text,
            "archiveMemberTimestamp": zip_member_datetime_utc(archive.getinfo(names[0])),
        }


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "contract", "prior-audit-contract", "prior-audit-result",
        "step12v3-zip", "v66-zip", "v16-zip", "v69-zip",
        "shortlist", "intrinsic", "selector", "runtime-adapter",
        "unified-runner", "out",
    ):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("MLB_CURRENT_SELECTOR_RECONSTRUCTION_CONTRACT_INVALID")
    if contract.get("frozenBeforeReplay") is not True:
        raise SystemExit("MLB_CURRENT_SELECTOR_RECONSTRUCTION_NOT_FROZEN_BEFORE_AUDIT")

    prior_contract = load(args.prior_audit_contract)
    prior_result = load(args.prior_audit_result)

    locked = contract["lockedCurrentSelectorAuthority"]
    authority = {
        "shortlist": require_blob(args.shortlist, locked["shortlist"]["blobSha"], "shortlist"),
        "intrinsicEdge": require_blob(args.intrinsic, locked["intrinsicEdge"]["blobSha"], "intrinsicEdge"),
        "dailyBestPickSelector": require_blob(args.selector, locked["dailyBestPickSelector"]["blobSha"], "dailyBestPickSelector"),
        "dailyBestPickRuntimeAdapter": require_blob(args.runtime_adapter, locked["dailyBestPickRuntimeAdapter"]["blobSha"], "dailyBestPickRuntimeAdapter"),
        "unifiedRunner": require_blob(args.unified_runner, locked["unifiedRunner"]["blobSha"], "unifiedRunner"),
    }

    if git_blob_sha(args.prior_audit_contract) != contract["lockedPriorHistoricalAudit"]["contract"]["blobSha"]:
        raise SystemExit("MLB_CURRENT_SELECTOR_PRIOR_AUDIT_CONTRACT_BLOB_DRIFT")
    if git_blob_sha(args.prior_audit_result) != contract["lockedPriorHistoricalAudit"]["resultSummary"]["blobSha"]:
        raise SystemExit("MLB_CURRENT_SELECTOR_PRIOR_AUDIT_RESULT_BLOB_DRIFT")

    immutable = prior_contract["immutableHistoricalInputs"]
    artifact_paths = {
        "step12v3": args.step12v3_zip,
        "v66": args.v66_zip,
        "v16": args.v16_zip,
        "v69": args.v69_zip,
    }
    artifact_specs = {
        "step12v3": immutable["step12v3HistoricalUniverse"],
        "v66": immutable["v66PregameCustody"],
        "v16": immutable["v16PureSettlementManifest"],
        "v69": immutable["v69ParentAudit"],
    }
    artifact_audit = {}
    for key, path in artifact_paths.items():
        spec = artifact_specs[key]
        artifact_audit[key] = {
            "workflowRunId": int(spec["workflowRunId"]),
            "artifactId": int(spec["artifactId"]),
            "artifactName": spec["artifactName"],
            "sha256": require_zip_sha(path, spec["artifactDigest"], key),
            "githubWorkflowCreatedAtUtc": RUN_CREATED_AT[int(spec["workflowRunId"])],
        }

    step12 = inspect_step12v3(args.step12v3_zip)
    if (
        step12["combinedT5PregameValidRows"] != 6610
        or step12["combinedDistinctOfficialDates"] != 505
        or step12["combinedDistinctGamePks"] != 6610
    ):
        raise SystemExit(f"MLB_CURRENT_SELECTOR_STEP12V3_IDENTITY_COUNT_DRIFT:{step12}")

    v66 = inspect_v66(args.v66_zip)
    v16 = inspect_v16(args.v16_zip)
    v69 = inspect_v69(args.v69_zip)

    prior_boundary = prior_result["productionCoverageBoundary"]
    prior_rank = prior_result["sameTierRankSensitivity"]
    if prior_boundary.get("exactCurrentStep11cCoverageCertified") is not False:
        raise SystemExit("MLB_CURRENT_SELECTOR_PRIOR_AUDIT_BOUNDARY_DRIFT")
    if prior_rank.get("currentProductionPrepriceRankPresentInParentRows") is not False:
        raise SystemExit("MLB_CURRENT_SELECTOR_PRIOR_RANK_BOUNDARY_DRIFT")
    if prior_rank.get("currentProductionPrepriceRankSubstitutionPerformed") is not False:
        raise SystemExit("MLB_CURRENT_SELECTOR_PRIOR_RANK_SUBSTITUTION_DRIFT")

    required = [
        {
            "id": "OFFICIAL_DATE_AND_GAME_IDENTITY",
            "status": "PASS",
            "finding": "Locked Step12V3 evidence preserves 6,610 unique T-5-valid gamePk identities across 505 official dates for 2024, 2025, and 2026_YTD.",
        },
        {
            "id": "CURRENT_SHORTLIST_MEMBERSHIP",
            "status": "FAIL",
            "finding": "The locked historical corpus does not preserve exact snapshots of the current certified shortlist membership/payloads. The prior frozen audit explicitly certifies only parent-route coverage, not current Step11c population coverage.",
        },
        {
            "id": "CURRENT_INTRINSIC_RANKED_GAMES_MEMBERSHIP_AND_ORDER",
            "status": "FAIL",
            "finding": "The locked V69 parent evidence does not carry current runtime.intrinsic.rankedGames or current prepriceRank, and the prior frozen audit forbids rank substitution.",
        },
        {
            "id": "FINAL_FROZEN_ROUTE_EVALUATIONS",
            "status": "FAIL",
            "finding": "Frozen parent-route evidence exists, but exact final route evaluations cannot be certified for the unknown current ranked Step11c population on every historical date. Parent-route rows may not substitute for current selected-population custody.",
        },
        {
            "id": "PREGAME_ONLY_PROVENANCE",
            "status": "FAIL",
            "finding": "The locked historical artifacts were materialized in August 2026 after the historical evaluation games they summarize; they are reproducible retrospective evidence, not immutable snapshots captured/versioned before each corresponding game outcome.",
        },
    ]
    all_pass = all(item["status"] == "PASS" for item in required)
    classification = PASS if all_pass else FAIL

    result = {
        "schemaVersion": SCHEMA,
        "stage": contract["stage"],
        "sport": "MLB",
        "classification": classification,
        "decisionRuleSatisfied": all_pass,
        "auditScope": {
            "reconstructabilityDecisionOnly": True,
            "selectedPopulationProbabilityScoringPerformed": False,
            "outcomesUsedToChooseHistoricalSelections": False,
            "approximateCurrentRankUsed": False,
            "mutableExternalApiRefetchUsed": False,
        },
        "authorityCustody": authority,
        "immutableArtifactAudit": artifact_audit,
        "historicalIdentityCoverage": step12,
        "corroboratingArtifactInspection": {
            "v66": v66,
            "v16": v16,
            "v69": v69,
            "priorHistoricalCoverageClassification": prior_result.get("classification"),
            "priorExactCurrentStep11cCoverageCertified": prior_boundary.get("exactCurrentStep11cCoverageCertified"),
            "priorCurrentPrepriceRankPresentInParentRows": prior_rank.get("currentProductionPrepriceRankPresentInParentRows"),
        },
        "requiredInputAudit": required,
        "scientificInterpretation": {
            "exactHistoricalDailyBestPickPopulationAuthorized": all_pass,
            "historicalParentRouteEvidenceDiscarded": False,
            "historicalParentRouteEvidenceMeaning": "VALID_AS_PARENT_ROUTE_AVAILABILITY_AND_OUTCOME_DIAGNOSTICS_ONLY",
            "historicalParentRouteHitRateMayBeUsedAsPerGameProbability": False,
            "currentSelectorHistoricalApproximationAllowed": False,
            "productionSelectorValidityImpactedByThisCustodyFailure": False,
            "reason": "This is a custody/reconstructability failure for the exact current selector population, not evidence that the current selector itself is invalid.",
        },
        "safety": {
            "mlbModelChanged": False,
            "featuresChanged": False,
            "calibrationChanged": False,
            "thresholdsChanged": False,
            "routingChanged": False,
            "rankingChanged": False,
            "selectorHierarchyChanged": False,
            "productionRecommendationBehaviorChanged": False,
            "v68ProspectiveContractChanged": False,
            "crossSportPoolingPerformed": False,
            "globalEliteRankingPerformed": False,
        },
        "crossSportCalibration": "BLOCKED",
        "globalEliteRanker": "BLOCKED",
        "nextAction": (
            "FREEZE_EXACT_CURRENT_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_WITHOUT_CHANGING_SELECTIONS"
            if not all_pass else
            "FREEZE_SEPARATE_SELECTED_POPULATION_PROBABILITY_QUALIFICATION_CONTRACT_BEFORE_SCORING"
        ),
    }

    if not all_pass and classification != contract["decisionRule"]["failClassification"]:
        raise SystemExit("MLB_CURRENT_SELECTOR_FAIL_CLASSIFICATION_DRIFT")
    dump(args.out, result)
    print(json.dumps({
        "classification": classification,
        "requiredInputAudit": required,
        "nextAction": result["nextAction"],
    }, indent=2))


if __name__ == "__main__":
    main()
