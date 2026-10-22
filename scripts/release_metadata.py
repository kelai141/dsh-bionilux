#!/usr/bin/env python3
"""Resolve build identity and release notes without interpolating inputs into shell code."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess


VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?")


def identity(root, tag, run_id, attempt):
    versions = [json.loads((root / "packages" / name / "package.json").read_text())["version"]
                for name in ("linux-bootstrap", "linux-runtime")]
    version = versions[0]
    if versions[1] != version or not VERSION.fullmatch(version):
        raise ValueError("bootstrap/runtime package versions must agree and be valid versions")
    if tag:
        if not tag.startswith("v") or not VERSION.fullmatch(tag[1:]):
            raise ValueError("tag must be a version such as v0.5.0 or v0.5.0-rc.1")
        if tag[1:] != version:
            raise ValueError(f"tag {tag} does not match plugin package version {version}")
        mode = "release"
    else:
        if not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", attempt):
            raise ValueError("debug builds require numeric run ID and attempt")
        tag = f"v{version}-debug.{run_id}.{attempt}"
        mode = "debug"
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("build source must resolve to a commit SHA")
    return {"source_sha": sha, "tag": tag, "version": tag[1:],
            "package_version": version, "mode": mode}


def release_notes(root, content, filename):
    if content:
        text = content.removeprefix("\ufeff")
    else:
        relative = Path(filename)
        if relative.is_absolute():
            raise ValueError("notes_file must be relative to the checked-out source")
        source = (root / relative).resolve()
        if not source.is_relative_to(root.resolve()):
            raise ValueError("notes_file must stay inside the checked-out source")
        text = source.read_text(encoding="utf-8-sig")
    if not text.strip():
        raise ValueError("release notes must not be empty")
    if len(text.encode("utf-8")) > 1_000_000:
        raise ValueError("release notes exceed the 1 MB local limit")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("identity", "notes"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--release", action="store_true", help="reject a missing release tag")
    args = parser.parse_args()
    if args.operation == "identity":
        if args.release and not os.environ.get("BUILD_TAG"):
            raise ValueError("a draft release requires an explicit tag")
        value = identity(args.root, os.environ.get("BUILD_TAG", ""),
                         os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", ""))
        args.output.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                for key, item in value.items():
                    stream.write(f"{key}={item}\n")
    else:
        args.output.write_text(release_notes(args.root, os.environ.get("NOTES_CONTENT", ""),
                                             os.environ.get("NOTES_FILE", "notes.md")), encoding="utf-8")


if __name__ == "__main__":
    main()
