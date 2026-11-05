import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LinuxRuntimeManager } from '../modules/manager.js';
import { SessionRegistry } from '../modules/session.js';

// Windows fixtures use real directories outside the guest's POSIX namespace.
// The final Android acceptance exercises these projections in the real guest.
test('an explicit guest cwd still sees the conversation workspace', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'linux-workspace-'));
  const manager = Object.create(LinuxRuntimeManager.prototype);
  try {
    const workspace = path.join(root, 'conversation');
    const rootfs = path.join(root, 'rootfs');
    await mkdir(workspace);
    await mkdir(rootfs);
    await writeFile(path.join(workspace, 'edited.cpp'), 'int main() {}');
    const initial = manager._resolveCwd(undefined, rootfs, [workspace]);
    assert.equal(initial.guestCwd, workspace);
    const guest = manager._resolveCwd('/root', rootfs, [workspace]);
    assert.equal(guest.guestCwd, '/root');
    assert.ok(guest.hostPaths.includes(workspace));
    const env = manager._executionEnvironment({ node: path.join(root, 'node'), rootfs, preload: 'preload' }, guest);
    assert.ok(env.BIONILUX_HOST_PATHS.includes(workspace));
    assert.throws(() => manager._resolveCwd('/root', rootfs, ['relative']), /absolute/);
    assert.throws(() => manager._resolveCwd('/root', rootfs, [rootfs]), /guest rootfs/);
    assert.throws(() => manager._resolveCwd('/root', rootfs, [path.join(workspace, 'edited.cpp')]), /not a directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sharing a guest directory or the filesystem root is rejected', { skip: process.platform === 'win32' }, () => {
  const manager = Object.create(LinuxRuntimeManager.prototype);
  assert.throws(() => manager._resolveCwd('/root', '/private/rootfs', ['/usr']), /guest namespace/);
  assert.throws(() => manager._resolveCwd('/root', '/private/rootfs', ['/']), /cover the guest namespace/);
});

test('shared-path validation does not reset cwd on a later persistent call', async () => {
  const cwdArgs = [];
  const manager = {
    status: () => ({ healthy: true, paths: { rootfs: '/private/rootfs' } }),
    gate: {},
    _resolveCwd: (cwd, _rootfs, sharedPaths) => ({ guestCwd: cwd ?? sharedPaths[0], sharedPaths }),
  };
  const registry = new SessionRegistry(manager);
  registry.sessions.set('build', { id: 'build', running: true, _sharedPaths: ['/data/workspace'], run: async args => { cwdArgs.push(args.cwd); return {}; } });
  await registry.run('build', { command: 'cd subdir', sharedPaths: ['/data/workspace'] });
  await registry.run('build', { command: 'pwd', sharedPaths: ['/data/workspace'] });
  await registry.run('build', { command: 'pwd', cwd: '/root', sharedPaths: ['/data/workspace'] });
  assert.deepEqual(cwdArgs, [undefined, undefined, '/root']);
  await assert.rejects(registry.run('build', { command: 'pwd', sharedPaths: ['/data/other'] }), /different sharedPaths/);
});
