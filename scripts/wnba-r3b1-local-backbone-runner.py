#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from collections import Counter
from pathlib import Path

MODULE_PATH = Path("scripts/wnba-r3b1-prefix-feature-materializer.py")
spec = importlib.util.spec_from_file_location("wnba_r3b1_materializer", MODULE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("unable to load R3B1 materializer")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def local_download_backbone(contract):
    cfg = contract["target_backbone"]
    path = Path(os.environ.get("WNBA_R3B1_BACKBONE_FILE", "r3b1-input/wnba-r1a5-neutral-availability-candidate-rowset.jsonl"))
    raw = path.read_bytes()
    got_sha = hashlib.sha256(raw).hexdigest()
    if got_sha != cfg["sha256"]:
        raise SystemExit(f"backbone SHA mismatch {got_sha}")
    rows = [json.loads(x) for x in raw.decode("utf-8").splitlines() if x.strip()]
    if len(rows) != int(cfg["rows"]):
        raise SystemExit(f"backbone row mismatch {len(rows)}")
    ids = [str(r["gameId"]) for r in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate gameId in backbone")
    counts = Counter(int(r["season"]) for r in rows)
    expected = {int(k): int(v) for k, v in cfg["season_rows"].items()}
    if dict(sorted(counts.items())) != dict(sorted(expected.items())):
        raise SystemExit(f"backbone season count mismatch {counts}")
    return rows, {
        "artifact_id": cfg["artifact_id"],
        "file": cfg["file"],
        "transport": "actions/download-artifact@v4 pinned by run-id and artifact name",
        "bytes": len(raw),
        "sha256": got_sha,
        "rows": len(rows),
        "season_rows": dict(sorted(counts.items())),
    }


mod.download_backbone = local_download_backbone
mod.main()
