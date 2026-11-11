import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLinuxBash, registerLinuxSession } from '../lib/index.js';

test('long build metadata reaches the model through the tool text renderer', async () => {
  let tool;
  const registry = { start: async () => ({ job: 'build-1', nextOffset: 32, running: true }) };
  const dispose = registerLinuxSession({ tools: { register: value => { tool = value; return () => {}; } } }, {}, { registry });
  const result = await tool.execute({ action: 'start', session: 'build', command: 'make -j8' });
  const text = tool.output.render({}, result).map(item => item.text).join('\n');
  assert.match(text, /Execution environment: Debian\/glibc Linux/);
  assert.match(text, /"job":"build-1"/);
  assert.match(text, /"nextOffset":32/);
  assert.match(text, /"running":true/);
  dispose();
});

test('one-shot tool preserves truncation, timeout diagnostics and cancellation', async () => {
  const registered = new Map();
  const signal = new AbortController().signal;
  const manager = {
    status: () => ({ runtimeId: 'test' }),
    execute: async spec => {
      assert.equal(spec.signal, signal);
      return { stdout: 'partial', stderr: 'before timeout', exitCode: null,
        signal: 'SIGKILL', timedOut: true, stdoutTruncated: true, stderrTruncated: false,
        cwd: '/', runtimeId: 'test' };
    },
  };
  const dispose = registerLinuxBash({ tools: { register(tool) {
    registered.set(tool.name, tool); return () => registered.delete(tool.name);
  } } }, manager);
  try {
    const tool = registered.get('linux_bash');
    const result = await tool.execute({ command: 'build', timeoutMs: 10 }, { signal });
    assert.equal(result.stdout, 'partial');
    assert.equal(result.stderr, 'before timeout');
    assert.equal(result.timedOut, true);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, false);
    assert.equal(result.signal, 'SIGKILL');
    const text = tool.output.render({}, result).map(item => item.text).join('\n');
    assert.match(text, /partial/);
    assert.match(text, /"stdoutTruncated":true/);
    assert.match(text, /"timedOut":true/);
  } finally { dispose(); }
});

test('session tool preserves partial timeout output instead of throwing it away', async () => {
  const registered = new Map();
  const manager = { status: () => ({ runtimeId: 'test' }) };
  const registry = { run: async () => ({ stdout: 'compiled prefix', stderr: 'diagnostic',
    exitCode: null, timedOut: true, sessionClosed: true, stdoutTruncated: false }) };
  const dispose = registerLinuxBash({ tools: { register(tool) {
    registered.set(tool.name, tool); return () => registered.delete(tool.name);
  } } }, manager, { registry });
  try {
    const result = await registered.get('linux_bash').execute({ command: 'build', session: 'build', timeoutMs: 10 });
    assert.equal(result.stdout, 'compiled prefix');
    assert.equal(result.stderr, 'diagnostic');
    assert.equal(result.timedOut, true);
    assert.equal(result.sessionClosed, true);
  } finally { dispose(); }
});
