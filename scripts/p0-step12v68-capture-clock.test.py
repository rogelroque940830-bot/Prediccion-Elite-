#!/usr/bin/env python3
import datetime as dt
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


clock = load_module("v68_clock", "p0-step12v68-capture-clock.py")


def game(
    game_pk=1,
    target_date="2026-08-27",
    start="2026-08-27T20:00:00Z",
    coded="S",
    abstract="Preview",
    detailed="Scheduled",
):
    return {
        "gamePk": game_pk,
        "officialDate": target_date,
        "gameDate": start,
        "status": {
            "codedGameState": coded,
            "abstractGameState": abstract,
            "detailedState": detailed,
        },
        "teams": {
            "home": {"team": {"id": 10}},
            "away": {"team": {"id": 20}},
        },
    }


def schedule(*games):
    return {"dates": [{"games": list(games)}]}


class V68CaptureClockTests(unittest.TestCase):
    def test_attempt_order_is_v80_clock(self):
        self.assertEqual(clock.ATTEMPT_LEADS, (10, 7, 4))

    def test_live_abstract_with_coded_p_warmup_is_pregame(self):
        g = game(coded="P", abstract="Live", detailed="Warmup")
        observed = dt.datetime(2026, 8, 27, 19, 50, tzinfo=dt.timezone.utc)
        self.assertEqual(clock.game_disposition(g, "2026-08-27", observed), "PREGAME")

    def test_explicit_live_code_is_terminal(self):
        g = game(coded="I", abstract="Live", detailed="In Progress")
        observed = dt.datetime(2026, 8, 27, 19, 50, tzinfo=dt.timezone.utc)
        self.assertEqual(
            clock.game_disposition(g, "2026-08-27", observed),
            "STARTED_OR_FINAL",
        )

    def test_delayed_is_retryable_state(self):
        g = game(coded="", abstract="", detailed="Delayed")
        observed = dt.datetime(2026, 8, 27, 19, 30, tzinfo=dt.timezone.utc)
        self.assertEqual(clock.game_disposition(g, "2026-08-27", observed), "DELAYED")

    def test_postponed_to_another_date_is_terminal(self):
        g = game(
            target_date="2026-08-28",
            start="2026-08-28T20:00:00Z",
            detailed="Postponed",
        )
        observed = dt.datetime(2026, 8, 27, 19, 30, tzinfo=dt.timezone.utc)
        self.assertEqual(
            clock.game_disposition(g, "2026-08-27", observed),
            "POSTPONED_TO_ANOTHER_DATE",
        )

    def test_snapshot_is_sanitized(self):
        raw = game()
        raw["score"] = {"home": 9, "away": 1}
        payload = clock.snapshot_payload(
            schedule(raw),
            "2026-08-27",
            dt.datetime(2026, 8, 27, 15, 0, tzinfo=dt.timezone.utc),
        )
        self.assertTrue(payload["policy"]["sanitizedScheduleOnly"])
        self.assertFalse(payload["policy"]["scoresStored"])
        self.assertNotIn("score", payload["games"][0])

    def test_planner_selects_only_approaching_uncaptured_game(self):
        observed = dt.datetime(2026, 8, 27, 19, 30, tzinfo=dt.timezone.utc)
        s = schedule(
            game(game_pk=1, start="2026-08-27T19:55:00Z"),
            game(game_pk=2, start="2026-08-27T20:30:00Z"),
            game(game_pk=3, start="2026-08-27T19:40:00Z"),
        )
        rows = clock.plan_games(
            s,
            "2026-08-27",
            observed,
            captured={3},
            terminal_attempts=set(),
            retry_states={},
            min_lead=4,
            max_lead=35,
        )
        self.assertEqual([r["gamePk"] for r in rows], [1])

    def test_wait_stage_ready_at_t10(self):
        fixture = schedule(
            game(
                game_pk=77,
                start="2026-08-27T20:00:00Z",
                coded="P",
                abstract="Live",
                detailed="Warmup",
            )
        )
        with tempfile.TemporaryDirectory() as td:
            fixture_path = Path(td) / "schedule.json"
            out_path = Path(td) / "clock.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "lead_minutes": 10,
                    "now": "2026-08-27T19:50:30Z",
                    "max_wait_minutes": 45.0,
                    "target_date": "2026-08-27",
                    "game_pk": 77,
                    "schedule_fixture": str(fixture_path),
                    "scheduled_start_from_planner": "2026-08-27T20:00:00Z",
                    "late_tolerance_minutes": 0.75,
                    "poll_seconds": 20.0,
                    "out": str(out_path),
                },
            )()
            clock.wait_stage(args)
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "READY")
            self.assertEqual(payload["attemptStage"], "T10")
            self.assertFalse(payload["terminal"])

    def test_wait_stage_missed_t10_advances_to_retry(self):
        fixture = schedule(game(game_pk=88, start="2026-08-27T20:00:00Z"))
        with tempfile.TemporaryDirectory() as td:
            fixture_path = Path(td) / "schedule.json"
            out_path = Path(td) / "clock.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "lead_minutes": 10,
                    "now": "2026-08-27T19:52:00Z",
                    "max_wait_minutes": 45.0,
                    "target_date": "2026-08-27",
                    "game_pk": 88,
                    "schedule_fixture": str(fixture_path),
                    "scheduled_start_from_planner": "2026-08-27T20:00:00Z",
                    "late_tolerance_minutes": 0.75,
                    "poll_seconds": 20.0,
                    "out": str(out_path),
                },
            )()
            clock.wait_stage(args)
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "MISSED_STAGE")
            self.assertFalse(payload["terminal"])


if __name__ == "__main__":
    unittest.main()
