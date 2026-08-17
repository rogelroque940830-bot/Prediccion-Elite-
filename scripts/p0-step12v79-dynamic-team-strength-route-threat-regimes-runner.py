#!/usr/bin/env python3
"""Execute the frozen V79 scorer with one fail-closed implementation repair.

The first V79 scorer correctly defined opponentAdvantageShare only when at least 12
of 16 frozen opponent-warning signals are nonmissing, but then incorrectly aborted
if any target row had fewer than 12. The preregistered contract explicitly permits
such rows to have unavailable share. This runner preserves that definition and only
removes the contradictory global abort. No value is imputed and no outcome-dependent
logic is changed.
"""
import hashlib
from pathlib import Path

SOURCE = Path(__file__).with_name("p0-step12v79-dynamic-team-strength-route-threat-regimes.py")
EXPECTED_BLOB = "4a4f9f8a98d824f529b802477cc98568d9f78b4d"
data = SOURCE.read_bytes()
got = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
if got != EXPECTED_BLOB:
    raise SystemExit(f"V79_RUNNER_SOURCE_BLOB_DRIFT:{got}")
text = data.decode("utf-8")
old = '''    if any(not finite(r.get("opponentAdvantageShare")) for r in rows):\n        raise SystemExit("V79_OPPONENT_ADVANTAGE_SHARE_MISSING_TARGET")\n'''
new = '''    # Contract requires >=12 nonmissing signals for opponentAdvantageShare.\n    # Rows below that coverage remain unavailable (None); do not impute or abort.\n    missing_opponent_advantage_share_rows = sum(not finite(r.get("opponentAdvantageShare")) for r in rows)\n'''
if text.count(old) != 1:
    raise SystemExit("V79_RUNNER_PATCH_TARGET_DRIFT")
patched = text.replace(old, new)
ns = {"__name__": "__main__", "__file__": str(SOURCE)}
exec(compile(patched, str(SOURCE), "exec"), ns, ns)
