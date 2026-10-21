export const MANIFEST_SCHEMA_VERSION = 1;
export const PACKAGE_VERSION = '0.5.0';
export const MIN_MOBILE_VERSION = '0.14.0';
export const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);
export const DEFAULT_RUNTIME_IDS = Object.freeze({
  arm64: 'debian-minimal',
  x64: 'debian-minimal-x64',
});

/** Resolve the architecture explicitly, or from the Node host when omitted. */
export function resolveHostArchitecture(value) {
  if (value !== undefined) {
    if (!SUPPORTED_ARCHITECTURES.has(value)) {
      throw new TypeError('arch must be arm64 or x64');
    }
    return value;
  }
  if (SUPPORTED_ARCHITECTURES.has(process.arch)) return process.arch;
  throw new Error(
    `Unsupported host architecture ${process.arch}; pass arch: 'arm64' or 'x64' explicitly`,
  );
}

export function defaultRuntimeIdForArch(arch) {
  const id = DEFAULT_RUNTIME_IDS[arch];
  if (!id) throw new TypeError('arch must be arm64 or x64');
  return id;
}
/** Manifest versions are semantic versions of the Linux release, not of this package. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function validateAsset(asset, field = 'asset', { allowPluginReleaseUrl = false } = {}) {
  if (!isObject(asset)) {
    throw new TypeError(`${field} must be an object`);
  }
  const url = requireString(asset.url, `${field}.url`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${field}.url must be an absolute URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) ||
    !parsed.pathname.includes('/releases/download/')
  ) {
    throw new TypeError(`${field}.url must be an official GitHub HTTPS release asset URL`);
  }
  const sha256 = requireString(asset.sha256, `${field}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError(`${field}.sha256 must be 64 lowercase hexadecimal characters`);
  }
  const validated = {
    url,
    sha256,
    size: requirePositiveInteger(asset.size, `${field}.size`),
    unpackedSize: requirePositiveInteger(asset.unpackedSize, `${field}.unpackedSize`),
  };
  if (allowPluginReleaseUrl && asset.pluginReleaseUrl !== undefined) {
    const releaseUrl = requireString(asset.pluginReleaseUrl, `${field}.pluginReleaseUrl`);
    let releasePage;
    try {
      releasePage = new URL(releaseUrl);
    } catch {
      throw new TypeError(`${field}.pluginReleaseUrl must be an absolute URL`);
    }
    if (
      releasePage.protocol !== 'https:' ||
      !['github.com', 'www.github.com'].includes(releasePage.hostname.toLowerCase()) ||
      !releasePage.pathname.includes('/releases/') ||
      releasePage.pathname.includes('/releases/download/')
    ) {
      throw new TypeError(`${field}.pluginReleaseUrl must be a GitHub release page URL`);
    }
    validated.pluginReleaseUrl = releaseUrl;
  }
  return Object.freeze(validated);
}

export function validateManifest(manifest) {
  if (!isObject(manifest)) {
    throw new TypeError('manifest must be an object');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    throw new TypeError('manifest.version must be a semantic version of the Linux release');
  }
  if (typeof manifest.minMobileVersion !== 'string' || !SEMVER.test(manifest.minMobileVersion)) {
    throw new TypeError('manifest.minMobileVersion must be a semantic version');
  }
  if (!isObject(manifest.plugins)) {
    throw new TypeError('manifest.plugins must be an object');
  }
  const plugins = Object.freeze({
    bootstrap: validateAsset(manifest.plugins.bootstrap, 'manifest.plugins.bootstrap', { allowPluginReleaseUrl: true }),
    runtime: validateAsset(manifest.plugins.runtime, 'manifest.plugins.runtime', { allowPluginReleaseUrl: true }),
  });
  if (!Array.isArray(manifest.runtimes) || manifest.runtimes.length === 0) {
    throw new TypeError('manifest.runtimes must be a non-empty array');
  }
  const runtimes = manifest.runtimes.map((runtime, index) => {
    const field = `manifest.runtimes[${index}]`;
    if (!isObject(runtime)) {
      throw new TypeError(`${field} must be an object`);
    }
    const id = requireString(runtime.id, `${field}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new TypeError(`${field}.id contains unsafe path characters`);
    }
    const architecture = requireString(runtime.architecture, `${field}.architecture`);
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
      throw new TypeError(`${field}.architecture must be arm64 or x64`);
    }
    if (runtime.backend !== 'bionilux') {
      throw new TypeError(`${field}.backend must be bionilux`);
    }
    return Object.freeze({
      id,
      label: requireString(runtime.label, `${field}.label`),
      architecture,
      backend: 'bionilux',
      backendAsset: validateAsset(runtime.backendAsset, `${field}.backendAsset`),
      rootfsAsset: validateAsset(runtime.rootfsAsset, `${field}.rootfsAsset`),
      nodeAsset: validateAsset(runtime.nodeAsset, `${field}.nodeAsset`),
    });
  });
  const ids = new Set();
  for (const runtime of runtimes) {
    if (ids.has(runtime.id)) {
      throw new TypeError(`manifest.runtimes contains duplicate id ${runtime.id}`);
    }
    ids.add(runtime.id);
  }
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: manifest.version,
    minMobileVersion: manifest.minMobileVersion,
    plugins,
    runtimes: Object.freeze(runtimes),
  });
}

export function selectRuntime(manifest, runtimeId, architecture) {
  const validated = validateManifest(manifest);
  const runtime = validated.runtimes.find(
    (candidate) => candidate.id === runtimeId && candidate.architecture === architecture,
  );
  if (!runtime) {
    const otherArchitecture = validated.runtimes.find((candidate) => candidate.id === runtimeId);
    if (otherArchitecture) {
      throw new Error(
        `runtime ${runtimeId} targets ${otherArchitecture.architecture}, but this host is ${architecture}`,
      );
    }
    const available = validated.runtimes
      .filter((candidate) => candidate.architecture === architecture)
      .map((candidate) => candidate.id)
      .join(', ');
    throw new Error(
      `runtime ${runtimeId} for ${architecture} is not present in the manifest` +
        (available ? ` (available: ${available})` : ''),
    );
  }
  return { manifest: validated, runtime };
}
