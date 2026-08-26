#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


source = load_module("v68_source", "p0-step12v68-prospective-source.py")
supervisor = load_module("v68_supervisor", "p0-step12v68-capture-supervisor.py")


def feed(coded: str, abstract: str, detailed: str):
    return {
        "gameData": {
            "status": {
                "codedGameState": coded,
                "abstractGameState": abstract,
                "detailedState": detailed,
            }
        }
    }


class PregameStateParityTests(unittest.TestCase):
    def assert_parity(self, payload, expected):
        self.assertEqual(source.pregame(payload), expected)
        self.assertEqual(supervisor.pregame_status(payload)[0], expected)

    def test_real_mlb_live_p_warmup_is_pregame(self):
        self.assert_parity(feed("P", "Live", "Warmup"), True)

    def test_coded_scheduled_and_pregame_states_are_accepted(self):
        self.assert_parity(feed("S", "Preview", "Scheduled"), True)
        self.assert_parity(feed("P", "Live", "Pre-Game"), True)

    def test_explicit_coded_live_and_final_states_are_rejected(self):
        self.assert_parity(feed("I", "Live", "In Progress"), False)
        self.assert_parity(feed("F", "Final", "Final"), False)
        self.assert_parity(feed("O", "Final", "Game Over"), False)

    def test_explicit_detailed_terminal_states_are_rejected(self):
        self.assert_parity(feed("X", "Preview", "In Progress"), False)
        self.assert_parity(feed("X", "Preview", "Completed Early"), False)

    def test_detailed_pregame_states_are_accepted(self):
        self.assert_parity(feed("X", "Live", "Warmup"), True)
        self.assert_parity(feed("X", "Live", "Delayed Start"), True)

    def test_unknown_broad_live_state_fails_closed(self):
        self.assert_parity(feed("X", "Live", "Unknown"), False)

    def test_preview_fallback_remains_pregame(self):
        self.assert_parity(feed("X", "Preview", "Unknown"), True)

    def test_source_hard_guard_cannot_widen_beyond_twenty_minutes(self):
        text = (ROOT / "p0-step12v68-prospective-source.py").read_text(encoding="utf-8")
        self.assertIn("0<a.max_lead_minutes<=20", text)
        self.assertNotIn("0<a.max_lead_minutes<=60", text)


if __name__ == "__main__":
    unittest.main()
