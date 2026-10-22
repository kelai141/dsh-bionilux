#!/usr/bin/env python3
"""Validate complete dual-architecture assets and emit manifest/checksums."""
import hashlib
import json
import os
import pathlib
import sys
import tarfile
from urllib.parse import quote

root = pathlib.Path(sys.argv[1])
repository, tag, version, min_mobile, node_version = sys.argv[2:]
runtime_specs = (
    ("aarch64", "debian-minimal", "arm64", "arm64", "ARM64"),
    ("x86_64", "debian-minimal-x64", "x64", "x64", "x86_64"),
)
required = [
    "linux-bootstrap-plugin.tar.xz",
    "linux-runtime-plugin.tar.xz",
]
for asset_arch, _runtime_id, _runtime_arch, node_arch, _label in runtime_specs:
    required.extend((
        f"bionilux-{asset_arch}",
        f"libbionilux_preload-{asset_arch}.so",
        f"bionilux-backend-{asset_arch}.tar.xz",
        f"debian-minimal-{asset_arch}.tar.xz",
        f"node-glibc-v{node_version}-linux-{node_arch}.tar.xz",
    ))
pointer = b"version https://git-lfs.github.com/spec/v1\n"
for name in required:
    path = root / name
    if not path.is_file() or path.stat().st_size <= 0:
        raise SystemExit(f"Missing or empty required release asset: {name}")
    if path.stat().st_size >= 2**31:
        raise SystemExit(f"Release asset exceeds GitHub's 2 GiB per-file limit: {name}")
    with path.open("rb") as stream:
        if stream.read(1024).startswith(pointer):
            raise SystemExit(f"Refusing to publish a Git LFS pointer as an asset: {name}")

base_url = f"https://github.com/{repository}/releases/download/{quote(tag, safe='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-')}"
page_url = f"https://github.com/{repository}/releases/tag/{quote(tag, safe='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-')}"

def describe(name):
    path = root / name
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    unpacked = 0
    with tarfile.open(path, mode="r:xz") as archive:
        for member in archive:
            member_path = pathlib.PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise SystemExit(f"Unsafe archive member in {name}: {member.name}")
            if member.isreg():
                unpacked += member.size
    if unpacked <= 0:
        raise SystemExit(f"Archive has no regular-file payload: {name}")
    return {
        "url": f"{base_url}/{quote(name, safe='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-')}" ,
        "sha256": digest.hexdigest(),
        "size": path.stat().st_size,
        "unpackedSize": unpacked,
    }

bootstrap = describe("linux-bootstrap-plugin.tar.xz")
runtime_plugin = describe("linux-runtime-plugin.tar.xz")
bootstrap["pluginReleaseUrl"] = page_url
runtime_plugin["pluginReleaseUrl"] = page_url
manifest = {
    "schemaVersion": 1,
    "version": version,
    "minMobileVersion": min_mobile,
    "plugins": {
        "bootstrap": bootstrap,
        "runtime": runtime_plugin,
    },
    "runtimes": [{
        "id": runtime_id,
        "label": f"Debian 13 (trixie) for {label}",
        "architecture": runtime_arch,
        "backend": "bionilux",
        "backendAsset": describe(f"bionilux-backend-{asset_arch}.tar.xz"),
        "rootfsAsset": describe(f"debian-minimal-{asset_arch}.tar.xz"),
        "nodeAsset": describe(f"node-glibc-v{node_version}-linux-{node_arch}.tar.xz"),
    } for asset_arch, runtime_id, runtime_arch, node_arch, label in runtime_specs],
}
out = root / "linux-release.json"
out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Generated {out} for {repository}@{tag}")

expected = {
    "linux-bootstrap-plugin.tar.xz", "linux-runtime-plugin.tar.xz",
    "linux-release.json", "BUILD_INFO.json",
}
for asset_arch, node_arch in (("aarch64", "arm64"), ("x86_64", "x64")):
    expected.update({
        f"bionilux-{asset_arch}",
        f"libbionilux_preload-{asset_arch}.so",
        f"bionilux-backend-{asset_arch}.tar.xz",
        f"debian-minimal-{asset_arch}.tar.xz",
        f"node-glibc-v{node_version}-linux-{node_arch}.tar.xz",
    })
actual = {path.name for path in root.iterdir() if path.is_file()}
if actual != expected:
    raise SystemExit(f"Unexpected release asset set: missing={expected-actual}, extra={actual-expected}")
print("Release asset set contains all required stable filenames and no build leftovers.")
info = json.loads((root / "BUILD_INFO.json").read_text(encoding="utf-8"))
if info["tag"] != tag or info["version"] != version or info["source_sha"] != os.environ["SOURCE_SHA"]:
    raise SystemExit("Build identity does not match requested source/tag")
names = sorted(path.name for path in root.iterdir() if path.is_file())
with (root / "SHA256SUMS").open("w", encoding="utf-8") as sums:
    for name in names:
        with (root / name).open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        sums.write(f"{digest}  {name}\n")
