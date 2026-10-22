#!/usr/bin/env python3
"""Check a tag through Git refs (missing refs are 404, unlike commits' 422)."""

import json
import os
import subprocess


def github(path):
    result = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if result.returncode:
        if "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)


def check_tag(repository, tag, source_sha, request=github):
    ref = request(f"repos/{repository}/git/ref/tags/{tag}")
    if ref is None:
        return
    obj = ref["object"]
    seen = set()
    while obj["type"] == "tag":
        if obj["sha"] in seen or len(seen) >= 16:
            raise ValueError("invalid annotated tag chain")
        seen.add(obj["sha"])
        annotated = request(f"repos/{repository}/git/tags/{obj['sha']}")
        if annotated is None:
            raise ValueError("annotated tag object is missing")
        obj = annotated["object"]
    if obj["type"] != "commit" or obj["sha"] != source_sha:
        raise ValueError("existing tag does not point at the selected source commit")


if __name__ == "__main__":
    check_tag(os.environ["GITHUB_REPOSITORY"], os.environ["RELEASE_TAG"], os.environ["SOURCE_SHA"])
    print("Release tag is absent or matches the selected source commit.")
