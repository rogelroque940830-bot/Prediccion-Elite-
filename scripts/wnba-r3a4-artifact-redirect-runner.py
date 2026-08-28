#!/usr/bin/env python3
from __future__ import annotations

import http.client
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CONTRACT = Path("research/wnba/WNBA_R3A4_FIRST_OOS_FAMILY_ABLATION_CONTRACT.json")
ENGINE = Path("scripts/wnba-r3a4-first-oos-four-factors-ablation.py")


def download_artifact_without_cross_host_auth(repository: str, artifact_id: int, token: str) -> bytes:
    path = f"/repos/{repository}/actions/artifacts/{artifact_id}/zip"
    conn = http.client.HTTPSConnection("api.github.com", timeout=120)
    conn.request(
        "GET",
        path,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Prediccion-Elite-WNBA-R3A4-RedirectRunner/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    response = conn.getresponse()
    location = response.getheader("Location")
    status = response.status
    response.read()
    conn.close()
    if status not in (301, 302, 303, 307, 308) or not location:
        raise RuntimeError(f"GitHub artifact endpoint did not return signed redirect: status={status}")
    parsed = urlparse(location)
    if parsed.scheme != "https":
        raise RuntimeError("artifact signed redirect is not HTTPS")
    # Deliberately do NOT forward the GitHub Authorization header to the signed storage host.
    with urlopen(Request(location, headers={"User-Agent": "Prediccion-Elite-WNBA-R3A4-RedirectRunner/1.0"}), timeout=120) as signed:
        return signed.read()


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    frozen = contract["frozen_inputs"]
    repository = os.getenv("GITHUB_REPOSITORY", "rogelroque940830-bot/Prediccion-Elite-").strip()
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")
    ids = [int(frozen["r2_artifact_id"]), int(frozen["r3a2_artifact_id"])]
    payloads = {artifact_id: download_artifact_without_cross_host_auth(repository, artifact_id, token) for artifact_id in ids}

    spec = importlib.util.spec_from_file_location("wnba_r3a4_engine", ENGINE)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load frozen R3A4 engine")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def frozen_transport(_repository: str, artifact_id: int, _token: str) -> bytes:
        try:
            return payloads[int(artifact_id)]
        except KeyError as exc:
            raise RuntimeError(f"unexpected artifact request: {artifact_id}") from exc

    module.download_artifact = frozen_transport
    module.main()


if __name__ == "__main__":
    main()
