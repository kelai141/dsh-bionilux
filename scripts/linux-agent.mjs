#!/usr/bin/env node
/** Agent client for the independent emulator environment; discovers auth itself. */
import { execFileSync } from 'node:child_process';

const serial = process.env.BN_DEVICE ?? 'emulator-5580';
const fixture = '/data/user/0/com.dsharnessmobile.shell/files/independent-linux';
const origin = process.env.BN_AGENT_ORIGIN ?? 'http://127.0.0.1:19790';
const [action = 'status', ...rest] = process.argv.slice(2);
try {
  if (action === 'exec' || action === 'call') {
    let ready = false;
    try {
      execFileSync('adb', ['-s', serial, 'forward', 'tcp:19790', 'tcp:18790'], { stdio: 'ignore', windowsHide: true });
      const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(1500) });
      ready = response.ok && (await response.json()).ready === true;
    } catch { /* The Windows launcher restores the persistent instance below. */ }
    if (!ready) {
      throw new Error('Linux runtime is not reachable; start it from acp-agent-ui (the standalone launcher was removed)');
    }
  }
  execFileSync('adb', ['-s', serial, 'forward', 'tcp:19790', 'tcp:18790'], { stdio: 'ignore' });
  const token = execFileSync('adb', ['-s', serial, 'shell', 'run-as', 'com.dsharnessmobile.shell', 'cat', `${fixture}/service-token`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let route;
  let body;
  if (action === 'status') route = '/api/android/linux-environment/status';
  else if (action === 'tools') route = '/tools';
  else if (action === 'exec') {
    route = '/tools/linux_bash';
    body = { session: process.env.BN_SESSION ?? 'agent', command: rest.join(' '), timeoutMs: Number(process.env.BN_COMMAND_TIMEOUT ?? 600000) };
    // open() reuses an existing shell without resetting its cwd. New shells
    // begin in the external workspace, which survives rootfs replacement.
    const opened = await fetch(new URL('/tools/linux_session', origin), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', session: body.session, cwd: `${fixture}/workspace` }),
      signal: AbortSignal.timeout(15000),
    });
    if (!opened.ok) throw new Error(`Cannot open Linux session: ${JSON.stringify(await opened.json())}`);
  } else if (action === 'call') {
    route = '/tools/' + encodeURIComponent(rest[0]);
    body = JSON.parse(rest.slice(1).join(' ') || '{}');
  } else throw new Error('Usage: node scripts/linux-agent.mjs status|tools|exec <command>|call <tool> <JSON>');
  const response = await fetch(new URL(route, origin), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(Number(process.env.BN_COMMAND_TIMEOUT ?? 600000) + 30000),
  });
  const value = await response.json();
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (!response.ok) process.exitCode = 1;
  else if (Number.isInteger(value.exitCode) && value.exitCode !== 0) process.exitCode = value.exitCode;
} catch (error) {
  // execFile errors can contain captured command output; credentials never do.
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
