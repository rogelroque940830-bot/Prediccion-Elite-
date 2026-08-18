#!/usr/bin/env python3
"""Test-only pinned loader for the exact immutable multi-market parent scorer.

The Full Modular reporting-compat module resolves its parent by sibling path.
This shim verifies that the checkout's authoritative parent source has the exact
Git blob used by #641, then re-exports only public symbols. All shim internals
use double-underscore names so the reporting-compat adapter ignores them.
"""
import importlib.util as __importlib_util
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
