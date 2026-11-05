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

test('tool rejection fails activation and partial registration is rolled back', () => {
  const manager = new EventEmitter();
  manager.status = () => ({ healthy: true });
  let count = 0;
  let removed = false;
  const ctx = { tools: { register() {
    if (++count === 2) throw new Error('registry rejected session');
    return () => { removed = true; };
  } }, effect() {} };
  assert.throws(() => apply(ctx, { manager }), /registry rejected session/);
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
