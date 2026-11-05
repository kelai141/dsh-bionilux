#!/usr/bin/env python3
"""Build local x64 acceptance assets; never publishes or edits source rootfs."""
import argparse
import copy
import hashlib
import json
import pathlib
import tarfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--rootfs', required=True)
p.add_argument('--node', required=True)
p.add_argument('--launcher', required=True)
p.add_argument('--preload', required=True)
p.add_argument('--output', required=True)
p.add_argument('--reuse-base-assets', action='store_true', help='Keep existing rootfs and Node archives; rebuild code bundles and manifest.')
a = p.parse_args()
repo = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(a.output).resolve()
out.mkdir(parents=True, exist_ok=True)
version = json.loads((repo / 'packages/linux-runtime/package.json').read_text())['version']
bootstrap_version = json.loads((repo / 'packages/linux-bootstrap/package.json').read_text())['version']
if bootstrap_version != version:
    raise SystemExit('Bootstrap and runtime package versions must match')
base = f'https://github.com/kelai141/dsh-bionilux/releases/download/v{version}/'

def pack(name, entries):
    with tarfile.open(out / name, 'w:xz', preset=1, dereference=False) as archive:
        for source, target in entries:
            archive.add(source, arcname=target)

def repackage(source, name, transform):
    with tarfile.open(source, 'r:*') as src, tarfile.open(out / name, 'w:xz', preset=1) as dest:
        for entry in src:
            if entry.ischr() or entry.isblk() or entry.isfifo():
                continue
            renamed = transform(entry.name)
            if renamed is None:
                continue
            content = src.extractfile(entry) if entry.isfile() or entry.islnk() else None
            entry = copy.copy(entry)
            entry.name = renamed
            if entry.islnk():
                # Android app UIDs cannot make hard links. Materialize the same
                # bytes as a regular file before distribution.
                entry.type = tarfile.REGTYPE
                entry.size = content.seek(0, 2)
                content.seek(0)
                entry.linkname = ''
            dest.addfile(entry, content)
    print(name, flush=True)

def root_path(name):
    clean = name.removeprefix('./')
    if clean in ('etc/resolv.conf',) or clean.startswith(('root/', 'tmp/', 'var/cache/apt/archives/', 'var/lib/apt/lists/')):
        return None
    return name

if not a.reuse_base_assets:
    repackage(a.rootfs, 'debian-minimal-x86_64.tar.xz', root_path)
    with tarfile.open(a.node, 'r:xz') as archive:
        node_prefix = archive.next().name.split('/')[0] + '/'
    repackage(a.node, 'node-glibc-linux-x64.tar.xz', lambda n: n[len(node_prefix):] if n.startswith(node_prefix) and len(n) > len(node_prefix) else None)
pack('bionilux-backend-x86_64.tar.xz', [
    (a.launcher, 'bin/bionilux'), (a.preload, 'lib/libbionilux_preload.so'),
    (repo / 'scripts/prepare-rootfs.sh', 'scripts/prepare-rootfs.sh'),
    (repo / 'scripts/prepare-android-rootfs.sh', 'scripts/prepare-android-rootfs.sh'),
    (repo / 'scripts/ldconfig-android.sh', 'scripts/ldconfig-android.sh'),
])
for short, directories in [('bootstrap', ['src', 'client']), ('runtime', ['lib', 'modules'])]:
    root = repo / 'packages' / f'linux-{short}'
    pack(f'linux-{short}-plugin.tar.xz', [(root / n, n) for n in ['package.json', 'README.md', *directories]])

def describe(name):
    file = out / name
    with tarfile.open(file) as archive:
        unpacked = sum(m.size for m in archive if m.isfile())
    return dict(url=base + name, sha256=hashlib.file_digest(file.open('rb'), 'sha256').hexdigest(), size=file.stat().st_size, unpackedSize=unpacked)

plugins = {n: describe(f'linux-{n}-plugin.tar.xz') for n in ['bootstrap', 'runtime']}
for v in plugins.values():
    v['pluginReleaseUrl'] = f'https://github.com/kelai141/dsh-bionilux/releases/tag/v{version}'
manifest = dict(schemaVersion=1, version=version, minMobileVersion='0.14.0', plugins=plugins, runtimes=[dict(
    id='debian-minimal-x64', label='Debian x64 local acceptance', architecture='x64', backend='bionilux',
    backendAsset=describe('bionilux-backend-x86_64.tar.xz'),
    rootfsAsset=describe('debian-minimal-x86_64.tar.xz'), nodeAsset=describe('node-glibc-linux-x64.tar.xz'),
)])
(out / 'linux-release.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest), flush=True)
