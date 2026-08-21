#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("p0-step12v80-capture-clock.py")
spec = importlib.util.spec_from_file_location("v80_clock", MODULE_PATH)
assert spec and spec.loader
clock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clock)


def game(game_pk, start, abstract="Preview", detailed="Scheduled", official_date="2026-08-21"):
    return {
        "gamePk": game_pk,
        "officialDate": official_date,
        "gameDate": start,
        "status": {
            "abstractGameState": abstract,
            "detailedState": detailed,
            "codedGameState": "S",
        },
        "teams": {
            "home": {"team": {"id": 110}, "score": 9},
            "away": {"team": {"id": 147}, "score": 1},
        },
    }


class CaptureClockTest(unittest.TestCase):
    def test_attempt_order_is_exactly_t10_t7_t4(self):
        self.assertEqual(clock.ATTEMPT_LEADS, (10, 7, 4))

    def test_operational_window_is_1030_to_2300_et(self):
        self.assertEqual(clock.operational_window("2026-08-21", clock.parse_time("2026-08-21T14:29:59Z")), "BEFORE_WINDOW")
        self.assertEqual(clock.operational_window("2026-08-21", clock.parse_time("2026-08-21T14:30:00Z")), "ACTIVE")
        self.assertEqual(clock.operational_window("2026-08-21", clock.parse_time("2026-08-22T02:59:59Z")), "ACTIVE")
        self.assertEqual(clock.operational_window("2026-08-21", clock.parse_time("2026-08-22T03:00:00Z")), "AFTER_CUTOFF")

    def test_snapshot_is_sanitized_and_drops_scores(self):
        schedule = {"dates": [{"games": [game(1, "2026-08-21T18:20:00Z")]}]}
        snap = clock.snapshot_payload(schedule, "2026-08-21", clock.parse_time("2026-08-21T14:30:00Z"))
        self.assertEqual(snap["schemaVersion"], clock.SLATE_SCHEMA)
        self.assertTrue(snap["policy"]["sanitizedScheduleOnly"])
        self.assertFalse(snap["policy"]["scoresStored"])
        encoded = json.dumps(snap)
        self.assertNotIn('"score"', encoded)

    def test_planner_dispatches_only_uncaptured_nonterminal_games_in_window(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        schedule = clock.snapshot_payload({
            "dates": [{
                "games": [
                    game(1, "2026-08-21T18:20:00Z"),
                    game(2, "2026-08-21T18:25:00Z"),
                    game(3, "2026-08-21T18:40:00Z"),
                    game(4, "2026-08-21T18:03:00Z"),
                    game(5, "2026-08-21T18:18:00Z"),
                ]
            }]
        }, "2026-08-21", clock.parse_time("2026-08-21T14:30:00Z"))
        rows = clock.plan_games(
            schedule,
            "2026-08-21",
            now,
            captured={2},
            terminal_attempts={5},
            retry_states={},
            min_lead=4,
            max_lead=35,
        )
        self.assertEqual([row["gamePk"] for row in rows], [1])
        self.assertAlmostEqual(rows[0]["leadMinutesAtPlanner"], 20.0)

    def test_retry_state_can_move_game_to_new_same_day_start(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        schedule = clock.snapshot_payload(
            {"dates": [{"games": [game(7, "2026-08-21T18:05:00Z")]}]},
            "2026-08-21",
            clock.parse_time("2026-08-21T14:30:00Z"),
        )
        rows = clock.plan_games(
            schedule,
            "2026-08-21",
            now,
            captured=set(),
            terminal_attempts=set(),
            retry_states={7: {"retryEligible": True, "retryStartTime": "2026-08-21T18:25:00Z"}},
            min_lead=4,
            max_lead=35,
        )
        self.assertEqual([r["gamePk"] for r in rows], [7])
        self.assertEqual(rows[0]["startTime"], "2026-08-21T18:25:00Z")

    def test_unresolved_delay_is_recheck_candidate(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        schedule = clock.snapshot_payload(
            {"dates": [{"games": [game(8, "2026-08-21T17:00:00Z")]}]},
            "2026-08-21",
            clock.parse_time("2026-08-21T14:30:00Z"),
        )
        rows = clock.plan_games(
            schedule,
            "2026-08-21",
            now,
            captured=set(),
            terminal_attempts=set(),
            retry_states={8: {"retryEligible": True, "retryStartTime": None}},
            min_lead=4,
            max_lead=35,
        )
        self.assertEqual([r["gamePk"] for r in rows], [8])
        self.assertEqual(rows[0]["dispatchReason"], "RECHECK_UNRESOLVED_DELAY")

    def test_postponed_same_date_is_not_terminal(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        g = game(9, "2026-08-21T20:00:00Z", detailed="Postponed")
        self.assertEqual(clock.game_disposition(g, "2026-08-21", now), "POSTPONED_SAME_DATE_UNRESOLVED")
        self.assertFalse(clock.schedule_pregame(g, "2026-08-21", now))

    def test_postponed_to_other_date_is_terminal(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        g = game(10, "2026-08-22T18:00:00Z", detailed="Postponed", official_date="2026-08-22")
        self.assertEqual(clock.game_disposition(g, "2026-08-21", now), "POSTPONED_TO_ANOTHER_DATE")

    def test_delayed_is_nonterminal_hold(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        g = game(11, "2026-08-21T18:10:00Z", detailed="Delayed")
        self.assertEqual(clock.game_disposition(g, "2026-08-21", now), "DELAYED")

    def test_wait_stage_keeps_same_date_postponement_retryable(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = pathlib.Path(tmp, "schedule.json")
            out = pathlib.Path(tmp, "out.json")
            fixture.write_text(json.dumps({"dates":[{"games":[game(12, "2026-08-21T20:00:00Z", detailed="Postponed")]}]}), encoding="utf-8")
            args = type("Args", (), {
                "lead_minutes": 10,
                "now": "2026-08-21T19:50:00Z",
                "max_wait_minutes": 45,
                "target_date": "2026-08-21",
                "game_pk": 12,
                "schedule_fixture": str(fixture),
                "late_tolerance_minutes": 0.75,
                "poll_seconds": 1,
                "scheduled_start_from_planner": "2026-08-21T20:00:00Z",
                "out": str(out),
            })()
            clock.wait_stage(args)
            x=json.loads(out.read_text())
            self.assertEqual(x["status"], "WAITING_FOR_RESCHEDULE")
            self.assertTrue(x["retryEligible"])
            self.assertFalse(x["terminal"])

    def test_wait_stage_closes_postponed_other_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = pathlib.Path(tmp, "schedule.json")
            out = pathlib.Path(tmp, "out.json")
            fixture.write_text(json.dumps({"dates":[{"games":[game(13, "2026-08-22T20:00:00Z", detailed="Postponed", official_date="2026-08-22")]}]}), encoding="utf-8")
            args = type("Args", (), {
                "lead_minutes": 10,
                "now": "2026-08-21T19:50:00Z",
                "max_wait_minutes": 45,
                "target_date": "2026-08-21",
                "game_pk": 13,
                "schedule_fixture": str(fixture),
                "late_tolerance_minutes": 0.75,
                "poll_seconds": 1,
                "scheduled_start_from_planner": "2026-08-21T20:00:00Z",
                "out": str(out),
            })()
            clock.wait_stage(args)
            x=json.loads(out.read_text())
            self.assertEqual(x["status"], "POSTPONED_TO_ANOTHER_DATE")
            self.assertTrue(x["terminal"])
            self.assertFalse(x["retryEligible"])

    def test_terminal_attempt_reader_blocks_only_terminal_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, "1.json").write_text('{"gamePk":1,"terminal":true}\n', encoding="utf-8")
            pathlib.Path(tmp, "2.json").write_text('{"gamePk":2,"terminal":false,"retryEligible":true,"retryStartTime":"2026-08-21T19:00:00Z","updatedAt":"2026-08-21T18:00:00Z"}\n', encoding="utf-8")
            terminal, retries = clock.attempt_state(tmp)
            self.assertEqual(terminal, {1})
            self.assertIn(2, retries)

    def test_stage_late_boundary_supports_retry_progression(self):
        stage = 10
        tolerance = clock.DEFAULT_STAGE_LATE_TOLERANCE_MINUTES
        self.assertLess(8.0, stage - tolerance)
        self.assertGreaterEqual(9.5, stage - tolerance)


if __name__ == "__main__":
    unittest.main()
