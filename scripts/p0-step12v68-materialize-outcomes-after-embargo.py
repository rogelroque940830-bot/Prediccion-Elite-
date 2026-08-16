#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

CAPTURE_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-capture.v1"
CONTRACT_SCHEMA = "courtedge-p0-step12v68-fg-winner-prospective-confirmation-contract.v1"
OUTCOME_SCHEMA = "courtedge-p0-step12v68-official-outcomes.v1"
REQUEST_TIMEOUT = 20
MAX_ATTEMPTS = 3


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")


def fetch_json(url, label):
    last = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            req = Request(url, headers={"User-Agent": "CourtEdge-V68-Outcome-Gate/1.0", "Accept": "application/json"})
            with urlopen(req, timeout=REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            last = exc
            if isinstance(exc, HTTPError) and exc.code < 500 and exc.code not in (408, 425, 429):
                break
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(0.3 * (2 ** attempt))
    raise RuntimeError(f"{label}:{type(last).__name__}:{last}")


def positive_int(value):
    try:
        x = int(value)
        return x if x > 0 else None
    except Exception:
        return None


def nonnegative_int(value):
    try:
        x = int(value)
        return x if x >= 0 else None
    except Exception:
        return None


def final_status(feed):
    status = (feed.get("gameData") or {}).get("status") or {}
    abstract = str(status.get("abstractGameState") or "").lower()
    detailed = str(status.get("detailedState") or "").lower()
    return abstract == "final" or any(token in detailed for token in ("final", "game over", "completed early"))


def materialize_one(capture_row):
    gp = int(capture_row["gamePk"])
    feed = fetch_json(f"https://statsapi.mlb.com/api/v1.1/game/{gp}/feed/live", f"game:{gp}")
    if not final_status(feed):
        return {"gamePk": gp, "final": False}
    gd = feed.get("gameData") or {}
    teams = gd.get("teams") or {}
    official_date = str((gd.get("datetime") or {}).get("officialDate") or "")
    home = positive_int((teams.get("home") or {}).get("id"))
    away = positive_int((teams.get("away") or {}).get("id"))
    if official_date != str(capture_row["officialDate"]):
        raise RuntimeError(f"V68_OUTCOME_DATE_MISMATCH:{gp}:{official_date}:{capture_row['officialDate']}")
    if home != int(capture_row["homeTeamId"]) or away != int(capture_row["awayTeamId"]):
        raise RuntimeError(f"V68_OUTCOME_TEAM_IDENTITY_MISMATCH:{gp}")
    linescore = (feed.get("liveData") or {}).get("linescore") or {}
    score = linescore.get("teams") or {}
    home_runs = nonnegative_int((score.get("home") or {}).get("runs"))
    away_runs = nonnegative_int((score.get("away") or {}).get("runs"))
    if home_runs is None or away_runs is None:
        raise RuntimeError(f"V68_OUTCOME_RUNS_MISSING:{gp}")
    if home_runs == away_runs:
        raise RuntimeError(f"V68_OUTCOME_TIE_UNSUPPORTED:{gp}:{home_runs}:{away_runs}")
    return {
        "gamePk": gp,
        "officialDate": official_date,
        "homeTeamId": home,
        "awayTeamId": away,
        "homeRuns": home_runs,
        "awayRuns": away_runs,
        "final": True,
        "source": "MLB_STATS_API_FINAL_FEED",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    if args.workers < 1 or args.workers > 12:
        raise SystemExit("V68_OUTCOME_WORKERS_INVALID")

    capture = load(args.capture)
    contract = load(args.contract)
    if capture.get("schemaVersion") != CAPTURE_SCHEMA:
        raise SystemExit("V68_OUTCOME_CAPTURE_SCHEMA_INVALID")
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        raise SystemExit("V68_OUTCOME_CONTRACT_SCHEMA_INVALID")
    rows = list(capture.get("rows", []))
    if len({int(r["gamePk"]) for r in rows}) != len(rows):
        raise SystemExit("V68_OUTCOME_CAPTURE_DUPLICATE_GAME")
    dates = {str(r["officialDate"]) for r in rows}
    gate = contract["outcomeEmbargo"]
    min_games = int(gate["minimumCanonicalGamesBeforeOutcomeScoring"])
    min_dates = int(gate["minimumDistinctOfficialDatesBeforeOutcomeScoring"])
    mature = len(rows) >= min_games and len(dates) >= min_dates

    if not mature:
        # Critical scientific boundary: return before any outcome HTTP request.
        payload = {
            "schemaVersion": OUTCOME_SCHEMA,
            "scientificStatus": "OUTCOMES_NOT_READ_BECAUSE_PROSPECTIVE_EMBARGO_NOT_MATURE",
            "outcomesRead": False,
            "captureMaturity": {
                "canonicalGames": len(rows),
                "distinctOfficialDates": len(dates),
                "minimumCanonicalGames": min_games,
                "minimumDistinctOfficialDates": min_dates,
                "mature": False,
            },
            "rows": [],
            "policy": {"researchOnly": True, "marketPricesRead": False, "realFinancialExposure": 0},
        }
        dump(args.out, payload)
        print(json.dumps(payload["captureMaturity"], indent=2))
        return

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(materialize_one, row): int(row["gamePk"]) for row in rows}
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda r: next((str(x["officialDate"]) for x in rows if int(x["gamePk"]) == int(r["gamePk"])), ""))
    pending = sorted(int(r["gamePk"]) for r in results if r.get("final") is not True)
    final_rows = [r for r in results if r.get("final") is True]
    payload = {
        "schemaVersion": OUTCOME_SCHEMA,
        "scientificStatus": "MATURE_CAPTURE_OUTCOMES_MATERIALIZED" if not pending else "MATURE_CAPTURE_WAITING_FOR_ALL_OFFICIAL_FINALS",
        "outcomesRead": True,
        "captureMaturity": {
            "canonicalGames": len(rows),
            "distinctOfficialDates": len(dates),
            "minimumCanonicalGames": min_games,
            "minimumDistinctOfficialDates": min_dates,
            "mature": True,
        },
        "allCapturedGamesOfficialFinal": not pending,
        "pendingGamePks": pending,
        "rows": final_rows,
        "policy": {"researchOnly": True, "marketPricesRead": False, "realFinancialExposure": 0},
    }
    dump(args.out, payload)
    print(json.dumps({"mature": True, "finalRows": len(final_rows), "pending": len(pending)}, indent=2))


if __name__ == "__main__":
    main()
