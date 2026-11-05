/**
 * DNS configuration for a prepared Linux rootfs.
 *
 * Android does not expose its resolver through /etc/resolv.conf, and a Node
 * process inside the app can report only the loopback stub. Writing that stub
 * into the guest would make name resolution look configured while every query
 * still failed. This module only accepts addresses a guest can reach, probes
 * public fallbacks with a bounded timeout, and reports a missing resolver
 * instead of inventing one.
 */
import { Resolver } from 'node:dns/promises';
import { getServers as getHostDnsServers } from 'node:dns';
import { lstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const DEFAULT_PUBLIC_DNS_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);
export const DEFAULT_DNS_PROBE_TIMEOUT_MS = 3_000;
export const DNS_PROBE_NAME = 'deb.debian.org';

function dnsError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw dnsError('DNS configuration was aborted', 'ABORT_ERR');
}

/** True for an address a guest resolver can actually use. */
export function isUsableNameserver(value) {
  if (typeof value !== 'string') return false;
  let address = value.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (!address) return false;
  const zone = address.indexOf('%');
  const literal = zone === -1 ? address : address.slice(0, zone);
  const family = isIP(literal);
  if (family === 4) {
    if (literal === '0.0.0.0' || literal === '255.255.255.255') return false;
    const first = Number(literal.split('.')[0]);
    if (first === 127 || first >= 224) return false;
    return true;
  }
  if (family === 6) {
    const lower = literal.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('fe80:') || lower.startsWith('ff')) return false;
    return true;
  }
  return false;
}

/**
 * Validate an explicit server list. An unusable address is a configuration
 * error: silently dropping it would leave the caller believing its choice was
 * applied.
 */
export function normaliseDnsServers(values, field = 'dnsServers') {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array of IP addresses`);
  const servers = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError(`${field} must contain only strings`);
    const address = value.trim();
    if (!isUsableNameserver(address)) {
      throw new TypeError(`${field} contains an unusable DNS address: ${JSON.stringify(value)}`);
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push(address);
  }
  return servers;
}

/** Keep the usable subset of a host-provided list without failing the install. */
export function filterUsableDnsServers(values) {
  if (!Array.isArray(values)) return [];
  const servers = [];
  const seen = new Set();
  for (const value of values) {
    if (!isUsableNameserver(value)) continue;
    const address = value.trim();
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push(address);
  }
  return servers;
}

/** Parse nameserver entries from resolv.conf text. */
export function parseNameservers(text) {
  if (typeof text !== 'string') return [];
  const servers = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const [keyword, address] = line.split(/\s+/);
    if (keyword !== 'nameserver' || !isUsableNameserver(address)) continue;
    if (!servers.includes(address)) servers.push(address);
  }
  return servers;
}

/**
 * Inspect the guest's current resolver file without following it outside the
 * rootfs. A symlink is reported but never considered usable: prepare-rootfs.sh
 * would otherwise follow it when writing a replacement.
 */
export function inspectResolvConf(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { exists: false, symlink: false, usable: false, servers: [] };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return { exists: true, symlink: true, usable: false, servers: [] };
  if (!stat.isFile()) return { exists: true, symlink: false, usable: false, servers: [] };
  const servers = parseNameservers(readFileSync(file, 'utf8'));
  return { exists: true, symlink: false, usable: servers.length > 0, servers };
}

/**
 * Refuse to let prepare-rootfs.sh write through a guest symlink.
 *
 * The script replaces resolv.conf with a shell redirect, which follows a
 * symbolic link. A link that points outside the rootfs would therefore write
 * to a host path. Release rootfs archives omit the file entirely; a symlink is
 * only possible in an operator-supplied tree, and that needs an explicit fix.
 */
export function assertResolvConfWritable(state) {
  if (!state.symlink) return;
  throw dnsError(
    'refusing to write DNS configuration through a symlinked /etc/resolv.conf; replace the link with a regular file',
    'ERR_RUNTIME_DNS_RESOLV_SYMLINK',
  );
}

/**
 * Probe one resolver by asking it for an ordinary A record.
 *
 * The resolver's own timeout and the outer timer are both bounded. Cancelling
 * the query settles the promise even when the native resolver would otherwise
 * keep it pending.
 */
export async function probeDnsServer(server, { timeoutMs = DEFAULT_DNS_PROBE_TIMEOUT_MS, signal } = {}) {
  throwIfAborted(signal);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DNS_PROBE_TIMEOUT_MS;
  const resolver = new Resolver({ timeout: deadline, tries: 1 });
  resolver.setServers([server]);
  const reachable = await new Promise((resolve) => {
    let settled = false;
    let timer;
    const onAbort = () => finish(false);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    timer = setTimeout(() => {
      try {
        resolver.cancel();
      } catch {
        // The query may already have settled.
      }
      finish(false);
    }, deadline);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    resolver.resolve4(DNS_PROBE_NAME).then(
      () => finish(true),
      () => finish(false),
    );
  });
  throwIfAborted(signal);
  return reachable;
}

/**
 * Resolve the nameservers to give prepare-rootfs.sh.
 *
 * Precedence is explicit option, provider, host resolver, then a probed public
 * resolver. Public probing is opt-in through allowPublicDnsFallback so desktop
 * and CI installs do not acquire a network dependency.
 */
export async function resolveDnsServers({
  dnsServers,
  dnsServersProvider,
  dnsGetServers = getHostDnsServers,
  dnsFallback = DEFAULT_PUBLIC_DNS_SERVERS,
  dnsProbe = probeDnsServer,
  dnsProbeTimeoutMs = DEFAULT_DNS_PROBE_TIMEOUT_MS,
  allowPublicDnsFallback = false,
  requireDns = false,
  platform = process.platform,
  rootfs,
  signal,
} = {}) {
  throwIfAborted(signal);

  if (dnsServers !== undefined) {
    const servers = normaliseDnsServers(dnsServers, 'dnsServers');
    if (servers.length > 0) return { servers, source: 'explicit' };
  }

  if (dnsServersProvider !== undefined) {
    const value = await dnsServersProvider({ rootfs, platform, signal });
    const servers = normaliseDnsServers(value ?? [], 'dnsServersProvider result');
    if (servers.length > 0) return { servers, source: 'provider' };
  }

  throwIfAborted(signal);
  let hostServers = [];
  try {
    hostServers = filterUsableDnsServers(dnsGetServers());
  } catch {
    // An unavailable host resolver is not a failure; it means "no local hint".
  }
  if (hostServers.length > 0) return { servers: hostServers, source: 'host' };

  const attempts = [];
  if (allowPublicDnsFallback) {
    const fallback = filterUsableDnsServers(dnsFallback);
    for (const server of fallback) {
      throwIfAborted(signal);
      attempts.push(server);
      let reachable = false;
      try {
        reachable = Boolean(await dnsProbe(server, { timeoutMs: dnsProbeTimeoutMs, signal, platform }));
      } catch (error) {
        throwIfAborted(signal);
        // A probe implementation failure is equivalent to an unreachable
        // server; the final error still reports every attempted address.
      }
      if (reachable) return { servers: [server], source: 'fallback', attempts };
    }
  }

  if (requireDns) {
    const checked = attempts.length > 0 ? ` after probing ${attempts.join(', ')}` : '';
    throw dnsError(
      `No usable DNS resolver is available for the Linux runtime${checked}. ` +
        'Pass dnsServers or dnsServersProvider, or make a public resolver reachable.',
      'ERR_RUNTIME_DNS_UNAVAILABLE',
    );
  }
  return { servers: [], source: 'none', attempts };
}
