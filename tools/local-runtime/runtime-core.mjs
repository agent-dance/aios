import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIDECAR_PROTOCOL_VERSION = '1.1.0';
export const SIDECAR_ORIGIN = 'app://alsniper';
export const SIDECAR_DEPENDENCY = 'github.com/agent-dance/agent-adaptor';
export const SIDECAR_DEPENDENCY_VERSION = 'v1.0.0';
export const SIDECAR_DEPENDENCY_SUM = 'h1:eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=';
export const SIDECAR_ARTIFACT = 'alsniper-agent.exe';
export const SIDECAR_MANIFEST_SCHEMA = 1;

const REQUEST_SIGNATURE_CONTEXT = 'AIOS1-REQUEST';
const RESPONSE_SIGNATURE_CONTEXT = 'AIOS1-RESPONSE';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function canonicalSidecarRequest({
  method,
  authority,
  path,
  origin,
  protocolVersion,
  timestamp,
  nonce,
  bodyHash,
}) {
  return [
    REQUEST_SIGNATURE_CONTEXT,
    method,
    authority,
    path,
    origin,
    protocolVersion,
    timestamp,
    nonce,
    bodyHash,
  ].join('\n');
}

export function canonicalSidecarResponse({ nonce, requestId, status, bodyHash, protocolVersion }) {
  return [
    RESPONSE_SIGNATURE_CONTEXT,
    nonce,
    requestId,
    String(status),
    bodyHash,
    protocolVersion,
  ].join('\n');
}

export function createHealthProof({ token, port, now = Date.now, random = randomBytes }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The sidecar port is invalid.');
  }
  if (!Buffer.isBuffer(token) || token.byteLength < 32) {
    throw new Error('The sidecar secret must contain at least 32 random bytes.');
  }

  const timestamp = String(Math.trunc(now()));
  if (!/^\d{1,16}$/u.test(timestamp)) {
    throw new Error('The system time cannot be represented for sidecar authentication.');
  }
  const nonce = random(16).toString('hex');
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('The secure random source returned an invalid nonce.');
  }

  const bodyHash = sha256Hex(Buffer.alloc(0));
  const authority = `http://127.0.0.1:${port}`;
  const signature = hmacSha256Hex(token, canonicalSidecarRequest({
    method: 'GET',
    authority,
    path: '/v1/health',
    origin: SIDECAR_ORIGIN,
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    timestamp,
    nonce,
    bodyHash,
  }));

  return Object.freeze({ authority, bodyHash, nonce, signature, timestamp });
}

function exactHexEqual(expected, received) {
  if (!SHA256_PATTERN.test(received)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const receivedBytes = Buffer.from(received, 'hex');
  return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}

export function verifyHealthResponse({ token, proof, status, headers, body }) {
  const protocolVersion = headers['x-aios-protocol-version'] ?? '';
  const requestNonce = headers['x-aios-request-nonce'] ?? '';
  const requestId = headers['x-request-id'] ?? '';
  const declaredBodyHash = headers['x-aios-content-sha256'] ?? '';
  const receivedSignature = headers['x-aios-signature'] ?? '';
  const allowedOrigin = headers['access-control-allow-origin'] ?? '';

  if (
    protocolVersion !== SIDECAR_PROTOCOL_VERSION
    || requestNonce !== proof.nonce
    || !REQUEST_ID_PATTERN.test(requestId)
    || !SHA256_PATTERN.test(declaredBodyHash)
    || allowedOrigin !== SIDECAR_ORIGIN
  ) {
    throw new Error('The sidecar health response authentication envelope is invalid.');
  }

  const actualBodyHash = sha256Hex(body);
  if (!exactHexEqual(actualBodyHash, declaredBodyHash)) {
    throw new Error('The sidecar health response body failed its integrity check.');
  }

  const expectedSignature = hmacSha256Hex(token, canonicalSidecarResponse({
    nonce: proof.nonce,
    requestId,
    status,
    bodyHash: declaredBodyHash,
    protocolVersion,
  }));
  if (!exactHexEqual(expectedSignature, receivedSignature)) {
    throw new Error('The sidecar health response signature is invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('The authenticated sidecar health response is not valid JSON.');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The authenticated sidecar health response is invalid.');
  }
  return payload;
}

export function parseGoVersionMetadata(output) {
  if (typeof output !== 'string' || output.length > 256 * 1024) {
    throw new Error('Go build metadata is unavailable or unreasonably large.');
  }

  const lines = output.split(/\r?\n/u);
  const dependencyLines = lines
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields[0] === 'dep' && fields[1] === SIDECAR_DEPENDENCY);
  if (dependencyLines.length !== 1 || dependencyLines[0][2] !== SIDECAR_DEPENDENCY_VERSION) {
    throw new Error(`Sidecar must embed ${SIDECAR_DEPENDENCY} ${SIDECAR_DEPENDENCY_VERSION}.`);
  }
  if (lines.some((line) => /^\s*=>\s+/u.test(line))) {
    throw new Error('Sidecar build metadata contains an unapproved module replacement.');
  }

  const goVersion = /^.*:\s+(go\d+\.\d+(?:\.\d+)?(?:[^\s]*)?)\s*$/u.exec(lines[0] ?? '')?.[1] ?? 'unknown';
  const settings = new Map();
  for (const line of lines) {
    const match = /^\s*build\s+([^=\s]+)=(.*)$/u.exec(line);
    if (match !== null) settings.set(match[1], match[2]);
  }
  if (settings.get('GOOS') !== 'windows' || settings.get('GOARCH') !== 'amd64' || settings.get('CGO_ENABLED') !== '0') {
    throw new Error('Sidecar must be a CGO-free Windows amd64 build.');
  }

  const dependencySum = dependencyLines[0][3] ?? '';
  if (dependencySum !== SIDECAR_DEPENDENCY_SUM) {
    throw new Error('Sidecar dependency checksum does not match the audited v1.0.0 module.');
  }

  return Object.freeze({
    dependencySum,
    goVersion,
    goos: settings.get('GOOS'),
    goarch: settings.get('GOARCH'),
    cgoEnabled: settings.get('CGO_ENABLED'),
    vcsRevision: settings.get('vcs.revision') ?? null,
    vcsModified: settings.get('vcs.modified') === 'true',
  });
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function validateBuildManifest(value) {
  const keys = [
    'schemaVersion',
    'artifact',
    'sha256',
    'dependency',
    'target',
    'build',
  ];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, keys)) {
    throw new Error('The local sidecar build manifest has an invalid shape.');
  }
  if (
    value.schemaVersion !== SIDECAR_MANIFEST_SCHEMA
    || value.artifact !== SIDECAR_ARTIFACT
    || !SHA256_PATTERN.test(value.sha256)
    || value.dependency === null
    || typeof value.dependency !== 'object'
    || !hasExactKeys(value.dependency, ['module', 'version', 'sum'])
    || value.dependency.module !== SIDECAR_DEPENDENCY
    || value.dependency.version !== SIDECAR_DEPENDENCY_VERSION
    || value.dependency.sum !== SIDECAR_DEPENDENCY_SUM
    || value.target === null
    || typeof value.target !== 'object'
    || !hasExactKeys(value.target, ['goos', 'goarch', 'cgoEnabled'])
    || value.target.goos !== 'windows'
    || value.target.goarch !== 'amd64'
    || value.target.cgoEnabled !== '0'
    || value.build === null
    || typeof value.build !== 'object'
    || !hasExactKeys(value.build, ['goVersion', 'vcsRevision', 'vcsModified'])
    || typeof value.build.goVersion !== 'string'
    || value.build.goVersion.length > 64
    || !(value.build.vcsRevision === null || /^[0-9a-f]{40}$/u.test(value.build.vcsRevision))
    || typeof value.build.vcsModified !== 'boolean'
  ) {
    throw new Error('The local sidecar build manifest failed policy validation.');
  }
  return value;
}

export function secureHashEqual(expected, actual) {
  if (!SHA256_PATTERN.test(expected) || !SHA256_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function sanitizedRuntimeEnvironment(source) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    const canonicalKey = key.toUpperCase();
    if (canonicalKey.startsWith('AIOS_') || canonicalKey.startsWith('VITE_AIOS_')) {
      delete environment[key];
    }
  }
  return environment;
}
