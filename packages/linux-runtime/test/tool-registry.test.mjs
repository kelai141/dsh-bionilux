import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import { apply, registerLinuxBash, registerLinuxSession } from '../lib/index.js';
import { SessionRegistry } from '../modules/session.js';

test('real engine registry exposes and executes both Linux tools', async () => {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {} });
  const tools = new ToolRuntime(ctx);
  const manager = {
    status: () => ({ healthy: true, runtimeId: 'test' }),
    execute: async () => ({ stdout: 'Debian', stderr: '', exitCode: 0, timedOut: false, cwd: '/root', runtimeId: 'test' }),
  };
  const dispose = registerLinuxBash({ tools }, manager);
  try {
    assert.deepEqual(tools.schemas().map(t => t.name), ['linux_bash', 'linux_session']);
    for (const schema of tools.schemas()) assertObjectJsonSchema(schema.parameters);
    const result = await tools.execute({ name: 'linux_bash', arguments: { command: 'cat /etc/os-release' }, callId: 'acceptance', signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.stdout, 'Debian');
    const listed = await tools.execute({ name: 'linux_session', arguments: { action: 'list' }, callId: 'sessions', signal: new AbortController().signal });
    assert.equal(listed.isError, false, JSON.stringify(listed));
    assert.deepEqual(listed.value.sessions, []);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('real registry accepts live session and asynchronous job lifecycle outputs', async () => {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {} });
  const tools = new ToolRuntime(ctx);
  const registry = {
    open: async () => ({ session: 'build', running: true, pid: 12, cwd: '/root', exitCode: null, jobs: [] }),
    run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, signal: null, cwd: '/root', session: 'build', running: true }),
    start: async () => ({ session: 'build', job: 'j1', pid: null, running: true, launchExitCode: 0, launchStderr: '' }),
    poll: async () => ({ session: 'build', job: 'j1', stdout: '', exitCode: null, running: true, finished: false, nextOffset: 0, eof: true, logLimit: 1024 }),
    close: async () => ({ exitCode: 0, signal: null }),
    list: () => [],
  };
  const dispose = registerLinuxSession({ tools }, { status: () => ({ runtimeId: 'test' }) }, { registry });
  try {
    for (const action of ['open', 'run', 'start', 'poll', 'close']) {
      const result = await tools.execute({ name: 'linux_session', arguments: { action, session: 'build', command: 'pwd', job: 'j1' }, callId: action, signal: new AbortController().signal });
      assert.equal(result.isError, false, action + ': ' + JSON.stringify(result));
    }
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('tool rejection fails activation and partial registration is rolled back', async () => {
  const manager = new EventEmitter();
  manager.status = () => ({ healthy: true });
  let count = 0;
  let removed = false;
  const ctx = { tools: { register() {
    if (++count === 2) throw new Error('registry rejected session');
    return () => { removed = true; };
  } }, effect() {} };
  await assert.rejects(apply(ctx, { manager }), /registry rejected session/);
  assert.equal(removed, true);
  assert.equal(manager.listenerCount('change'), 0);
});

test('Linux tools share the file-tool workspace without resetting an existing shell cwd', async () => {
  const tools = new Map();
  const agent = {};
  const signal = new AbortController().signal;
  const received = [];
  const registry = {
    open: async args => { received.push(args); return {}; },
    run: async (_id, args) => { received.push(args); return {}; },
  };
  const manager = {
    status: () => ({ runtimeId: 'test' }),
    execute: async args => { received.push(args); return { stdout: '', stderr: '', exitCode: 0 }; },
  };
  const ctx = {
    get(name) {
      assert.equal(name, 'workingDirectory');
      return { ensure: async (owner, abort) => { assert.equal(owner, agent); assert.equal(abort, signal); return '/data/workspaces/conversation'; } };
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  };
  const dispose = registerLinuxBash(ctx, manager, { registry });
  try {
    await tools.get('linux_bash').execute({ command: 'make', cwd: '/root' }, { agent, signal });
    await tools.get('linux_session').execute({ action: 'open', session: 'build' }, { agent, signal });
    await tools.get('linux_session').execute({ action: 'run', session: 'build', command: 'pwd' }, { agent, signal });
    for (const args of received) assert.deepEqual(args.sharedPaths, ['/data/workspaces/conversation']);
    assert.equal(received[0].cwd, '/root');
    assert.equal(received[2].cwd, undefined, 'a later call retains the shell working directory');
  } finally { dispose(); }
});

test('the two Linux tools share one registry per agent and isolate other agents', async () => {
  const tools = new Map();
  const calls = [];
  const original = SessionRegistry.prototype.run;
  SessionRegistry.prototype.run = async function () { calls.push(this); return { stdout: '', stderr: '', exitCode: 0 }; };
  const ctx = { get: () => ({ ensure: async () => '/data/workspace' }), tools: { register: t => { tools.set(t.name, t); return () => {}; } } };
  const dispose = registerLinuxBash(ctx, { status: () => ({ runtimeId: 'test' }) });
  try {
    const agentA = {}, agentB = {};
    await tools.get('linux_bash').execute({ command: 'pwd', session: 'build' }, { agent: agentA });
    await tools.get('linux_session').execute({ action: 'run', command: 'pwd', session: 'build' }, { agent: agentA });
    await tools.get('linux_session').execute({ action: 'run', command: 'pwd', session: 'build' }, { agent: agentB });
    assert.equal(calls[0], calls[1]);
    assert.notEqual(calls[1], calls[2]);
  } finally {
    SessionRegistry.prototype.run = original;
    dispose();
  }
});
function delayedActivation() {
  const manager = new EventEmitter();
  let state = { healthy: false, runtimeId: 'verified-test', reason: 'execution not verified' };
  let resolveProof;
  let rejectProof;
  manager.status = () => state;
  manager.verify = () => new Promise((resolve, reject) => { resolveProof = resolve; rejectProof = reject; });
  const registered = new Map();
  const registrations = [];
  const removals = [];
  const published = [];
  let cleanup;
  const ctx = {
    tools: { register(tool) {
      assert.equal(registered.has(tool.name), false, 'a tool must not be registered twice');
      registered.set(tool.name, tool);
      registrations.push(tool);
      return () => { removals.push(tool); registered.delete(tool.name); };
    } },
    effect(setup) { cleanup = setup(); },
    provide(name, service) { published.push({ name, service }); },
  };
  const pending = apply(ctx, { manager });
  return {
    manager, pending, registered, registrations, removals, published,
    cleanup: () => cleanup(),
    setHealth(healthy, reason = healthy ? 'verified' : 'probe failed') {
      state = { ...state, healthy, reason };
      manager.emit('change', state);
    },
    finishProof(healthy) {
      state = { ...state, healthy, reason: healthy ? 'verified' : 'probe failed' };
      // The production manager publishes its verdict before verify() resolves.
      manager.emit('change', state);
      resolveProof(state);
    },
    rejectProof(error) { rejectProof(error); },
  };
}

test('async apply publishes neither tools nor its service before delayed execution proof', async () => {
  const fixture = delayedActivation();
  try {
    await Promise.resolve();
    assert.equal(fixture.registrations.length, 0);
    assert.equal(fixture.registered.size, 0);
    assert.deepEqual(fixture.published, []);
    fixture.finishProof(true);
    assert.equal(await fixture.pending, fixture.manager);
    assert.deepEqual([...fixture.registered.keys()], ['linux_bash', 'linux_session']);
    assert.equal(fixture.registrations.length, 2, 'the proof event and apply continuation register only once');
    assert.equal(fixture.removals.length, 0);
    assert.deepEqual(fixture.published, [{ name: 'linuxRuntimeManager', service: fixture.manager }]);
  } finally { fixture.cleanup(); }
});

test('healthy proof refreshes retain tool identities and their persistent session registry', async () => {
  const fixture = delayedActivation();
  const originalRun = SessionRegistry.prototype.run;
  let registry;
  let closed = 0;
  SessionRegistry.prototype.run = async function () {
    registry = this;
    return { stdout: 'persisted', stderr: '', exitCode: 0 };
  };
  try {
    fixture.finishProof(true);
    await fixture.pending;
    const bash = fixture.registered.get('linux_bash');
    const session = fixture.registered.get('linux_session');
    await bash.execute({ command: 'pwd', session: 'retained' });
    const persistent = {
      info: () => ({ session: 'retained', running: true }),
      close: async () => { closed += 1; },
    };
    registry.sessions.set('retained', persistent);
    fixture.setHealth(true);
    fixture.setHealth(true);
    assert.equal(fixture.registered.get('linux_bash'), bash);
    assert.equal(fixture.registered.get('linux_session'), session);
    assert.equal(fixture.registrations.length, 2);
    assert.equal(fixture.removals.length, 0);
    assert.equal(registry.disposed, false);
    assert.equal(registry.sessions.get('retained'), persistent);
    assert.equal(closed, 0, 'a successful refresh must not close a live shell');
    const listed = await session.execute({ action: 'list' });
    assert.deepEqual(listed.sessions, [{ session: 'retained', running: true }]);
    fixture.setHealth(false);
    assert.equal(fixture.registered.size, 0, 'failed health must withdraw both tools');
    assert.equal(registry.disposed, true);
    assert.equal(closed, 1);
    fixture.setHealth(true);
    assert.equal(fixture.registrations.length, 4, 'recovery creates one fresh tool pair');
    assert.notEqual(fixture.registered.get('linux_bash'), bash);
    assert.notEqual(fixture.registered.get('linux_session'), session);
  } finally {
    SessionRegistry.prototype.run = originalRun;
    fixture.cleanup();
  }
});

test('unloading during delayed proof cannot publish late tools or a service', async () => {
  const fixture = delayedActivation();
  fixture.cleanup();
  fixture.cleanup();
  assert.equal(fixture.manager.listenerCount('change'), 0);
  fixture.finishProof(true);
  await fixture.pending;
  fixture.setHealth(true);
  assert.equal(fixture.registrations.length, 0);
  assert.equal(fixture.registered.size, 0);
  assert.deepEqual(fixture.published, []);
});

test('a failed execution verdict remains inspectable without exposing Linux tools', async () => {
  const fixture = delayedActivation();
  try {
    fixture.finishProof(false);
    await fixture.pending;
    assert.equal(fixture.registrations.length, 0);
    assert.equal(fixture.registered.size, 0);
    assert.equal(fixture.manager.status().healthy, false);
    assert.deepEqual(fixture.published, [{ name: 'linuxRuntimeManager', service: fixture.manager }]);
  } finally { fixture.cleanup(); }
});

test('a rejected execution proof rolls back activation without publishing tools or service', async () => {
  const fixture = delayedActivation();
  const failure = new Error('injected verification rejection');
  fixture.rejectProof(failure);
  await assert.rejects(fixture.pending, error => error === failure);
  assert.equal(fixture.registrations.length, 0);
  assert.equal(fixture.registered.size, 0);
  assert.deepEqual(fixture.published, []);
  assert.equal(fixture.manager.listenerCount('change'), 0);
  fixture.setHealth(true);
  assert.equal(fixture.registrations.length, 0, 'a failed apply must not retain its change listener');
});
