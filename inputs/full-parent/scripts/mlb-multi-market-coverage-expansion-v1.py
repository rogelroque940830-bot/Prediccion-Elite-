#!/usr/bin/env python3
"""Test-only pinned loader for the exact immutable multi-market parent scorer.

The Full Modular reporting-compat module resolves its parent by sibling path.
This shim verifies that the checkout's authoritative parent source has the exact
Git blob used by #641, then re-exports only public symbols. All shim internals
use double-underscore names so the reporting-compat adapter ignores them.

The atexit diagnostic below is read-only and runs only after the scorer has
finished writing its output. It cannot affect candidate generation, fitting,
ranking, selection, settlement, or any scientific metric.
"""
import atexit as __atexit
import importlib.util as __importlib_util
import json as __json
import math as __math
import pathlib as __pathlib
import subprocess as __subprocess

__EXPECTED_BLOB = "5c67ba71975eb2c851f1c48feeb93605ed39b209"
__REPO = __pathlib.Path(__file__).resolve().parents[3]
__REAL_REL = __pathlib.Path("scripts/mlb-multi-market-coverage-expansion-v1.py")
__REAL = __REPO / __REAL_REL

__actual_blob = __subprocess.check_output(
    ["git", "-C", str(__REPO), "rev-parse", f"HEAD:{__REAL_REL.as_posix()}"],
    text=True,
).strip()
if __actual_blob != __EXPECTED_BLOB:
    raise RuntimeError(
        f"FULL_MODULAR_PARENT_MULTI_MARKET_BLOB_DRIFT:{__actual_blob}:{__EXPECTED_BLOB}"
    )

__spec = __importlib_util.spec_from_file_location("mlb_multi_market_exact_parent_pinned", __REAL)
if __spec is None or __spec.loader is None:
    raise RuntimeError(f"FULL_MODULAR_PARENT_MULTI_MARKET_IMPORT_FAILED:{__REAL}")
__source_module = __importlib_util.module_from_spec(__spec)
__spec.loader.exec_module(__source_module)

__public_exports = {
    __name: getattr(__source_module, __name)
    for __name in dir(__source_module)
    if not __name.startswith("_")
}
globals().update(__public_exports)


def __post_score_pick_diff():
    try:
        __generated = __REPO / "work/full-modular-reconstructed-result.json"
        __original_root = __REPO / "inputs/original-result"
        if not __generated.exists() or not __original_root.exists():
            return
        __matches = list(__original_root.rglob("mlb-market-state-matchup-modular-router-v1.json"))
        if len(__matches) != 1:
            print("FULL_MODULAR_POST_SCORE_DIAGNOSTIC_ORIGINAL_MATCH_COUNT", len(__matches))
            return
        __original = __json.loads(__matches[0].read_text())
        __new = __json.loads(__generated.read_text())
        __op = __original["dailyShadowPicks"]["CHALLENGER_FULL_MODULAR"]
        __gp = __new["dailyShadowPicks"]["CHALLENGER_FULL_MODULAR"]
        __identity = (
            "season", "officialDate", "gamePk", "market", "horizon", "side",
            "selectedLine", "lineGeometry", "strengthTier", "matchupStructure", "frontier",
        )
        __id_mismatch = 0
        __object_mismatch = 0
        __field_stats = {}
        __examples = []
        for __i, (__a, __b) in enumerate(zip(__op, __gp)):
            if tuple(__a.get(__k) for __k in __identity) != tuple(__b.get(__k) for __k in __identity):
                __id_mismatch += 1
            if __a != __b:
                __object_mismatch += 1
                __diffs = []
                for __k in sorted(set(__a) | set(__b)):
                    __x = __a.get(__k)
                    __y = __b.get(__k)
                    if __x == __y:
                        continue
                    __entry = __field_stats.setdefault(__k, {"count": 0, "maxAbsDiff": 0.0, "nonNumeric": 0})
                    __entry["count"] += 1
                    if isinstance(__x, (int, float)) and isinstance(__y, (int, float)) and not isinstance(__x, bool) and not isinstance(__y, bool) and __math.isfinite(float(__x)) and __math.isfinite(float(__y)):
                        __d = abs(float(__x) - float(__y))
                        __entry["maxAbsDiff"] = max(__entry["maxAbsDiff"], __d)
                        __diffs.append({"field": __k, "original": __x, "generated": __y, "absDiff": __d})
                    else:
                        __entry["nonNumeric"] += 1
                        __diffs.append({"field": __k, "original": __x, "generated": __y})
                if len(__examples) < 12:
                    __examples.append({"index": __i, "identity": [__a.get(__k) for __k in __identity], "diffs": __diffs})
        print("FULL_MODULAR_POST_SCORE_PICK_COUNTS", len(__op), len(__gp))
        print("FULL_MODULAR_POST_SCORE_IDENTITY_MISMATCHES", __id_mismatch)
        print("FULL_MODULAR_POST_SCORE_OBJECT_MISMATCHES", __object_mismatch)
        print("FULL_MODULAR_POST_SCORE_FIELD_DIFF_STATS", __json.dumps(__field_stats, sort_keys=True))
        print("FULL_MODULAR_POST_SCORE_DIFF_EXAMPLES", __json.dumps(__examples, sort_keys=True))
        __ofm = __original["policyResults"]["CHALLENGER_FULL_MODULAR"]
        __gfm = __new["policyResults"]["CHALLENGER_FULL_MODULAR"]
        __metric_keys = ["shadowPickDates", "wins", "losses", "pushes", "decisive", "hitRate", "brierScore", "absoluteCalibrationGap", "combinedDailyOpportunityCoveragePct"]
        print("FULL_MODULAR_POST_SCORE_METRICS_ORIGINAL", __json.dumps({__k: __ofm.get(__k) for __k in __metric_keys}, sort_keys=True))
        print("FULL_MODULAR_POST_SCORE_METRICS_GENERATED", __json.dumps({__k: __gfm.get(__k) for __k in __metric_keys}, sort_keys=True))
    except Exception as __exc:
        print("FULL_MODULAR_POST_SCORE_DIAGNOSTIC_ERROR", type(__exc).__name__, str(__exc))


__atexit.register(__post_score_pick_diff)
