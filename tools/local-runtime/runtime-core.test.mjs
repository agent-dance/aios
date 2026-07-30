import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  canonicalSidecarRequest,
  canonicalSidecarResponse,
  createHealthProof,
  parseGoVersionMetadata,
  sanitizedRuntimeEnvironment,
  SIDECAR_ORIGIN,
  validateBuildManifest,
  verifyHealthResponse,
} from './runtime-core.mjs';

const token = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

test('health proof binds the exact production origin and loopback authority', () => {
  const proof = createHealthProof({
    token,
    port: 54_321,
    now: () => 1_722_345_678_901,
    random: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  });
  assert.deepEqual(proof, {
    authority: 'http://127.0.0.1:54321',
    bodyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    nonce: '00112233445566778899aabbccddeeff',
    signature: 'c68db45eb428b4d23f83842e97a547d7c1cbbffd4f8cf4404442acc89fbd1edc',
    timestamp: '1722345678901',
  });
  assert.match(canonicalSidecarRequest({
    method: 'GET',
    authority: proof.authority,
    path: '/v1/health',
    origin: SIDECAR_ORIGIN,
    protocolVersion: '1.1.0',
    timestamp: proof.timestamp,
    nonce: proof.nonce,
    bodyHash: proof.bodyHash,
  }), /\napp:\/\/alsniper\n/u);
});

test('signed health verification rejects body and signature tampering', () => {
  const proof = createHealthProof({
    token,
    port: 54_321,
    now: () => 1_722_345_678_901,
    random: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  });
  const body = Buffer.from('{"protocolVersion":"1.1.0","status":"ready"}\n');
  const bodyHash = '35ecb48dddd73df65c53e884601dd1323641ae10b6cbc8cfcf8d424f7825d1ed';
  const responseCanonical = canonicalSidecarResponse({
    nonce: proof.nonce,
    requestId: '00112233445566778899aabbccddeeff',
    status: 200,
    bodyHash,
    protocolVersion: '1.1.0',
  });
  const signature = createHmac('sha256', token).update(responseCanonical).digest('hex');
  const headers = {
    'access-control-allow-origin': 'app://alsniper',
    'x-aios-protocol-version': '1.1.0',
    'x-aios-request-nonce': proof.nonce,
    'x-request-id': '00112233445566778899aabbccddeeff',
    'x-aios-content-sha256': bodyHash,
    'x-aios-signature': signature,
  };

  assert.deepEqual(verifyHealthResponse({ token, proof, status: 200, headers, body }), {
    protocolVersion: '1.1.0',
    status: 'ready',
  });
  assert.throws(
    () => verifyHealthResponse({ token, proof, status: 200, headers, body: Buffer.from('{}') }),
    /integrity/u,
  );
  assert.throws(
    () => verifyHealthResponse({ token, proof, status: 200, headers: { ...headers, 'x-aios-signature': '0'.repeat(64) }, body }),
    /signature/u,
  );
  assert.throws(
    () => verifyHealthResponse({ token, proof, status: 200, headers: { ...headers, 'access-control-allow-origin': '*' }, body }),
    /envelope/u,
  );
});

test('Go build metadata requires the exact unreplaced v1 dependency and Windows target', () => {
  const output = [
    'alsniper-agent.exe: go1.26.0',
    '\tpath\tgithub.com/buthim/alsniper-os/sidecar/cmd/alsniper-agent',
    '\tdep\tgithub.com/agent-dance/agent-adaptor\tv1.0.0\th1:eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=',
    '\tbuild\tCGO_ENABLED=0',
    '\tbuild\tGOARCH=amd64',
    '\tbuild\tGOOS=windows',
    '\tbuild\tvcs.revision=0123456789abcdef0123456789abcdef01234567',
    '\tbuild\tvcs.modified=true',
  ].join('\n');
  assert.deepEqual(parseGoVersionMetadata(output), {
    dependencySum: 'h1:eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=',
    goVersion: 'go1.26.0',
    goos: 'windows',
    goarch: 'amd64',
    cgoEnabled: '0',
    vcsRevision: '0123456789abcdef0123456789abcdef01234567',
    vcsModified: true,
  });
  assert.throws(() => parseGoVersionMetadata(output.replace('v1.0.0', 'v0.12.1')), /v1\.0\.0/u);
  assert.throws(() => parseGoVersionMetadata(output.replace('eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')), /checksum/u);
  assert.throws(() => parseGoVersionMetadata(`${output}\n\t=>\t../fork`), /replacement/u);
});

test('manifest validation is closed to extra fields and wrong dependency versions', () => {
  const manifest = {
    schemaVersion: 1,
    artifact: 'alsniper-agent.exe',
    sha256: 'a'.repeat(64),
    dependency: {
      module: 'github.com/agent-dance/agent-adaptor',
      version: 'v1.0.0',
      sum: 'h1:eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=',
    },
    target: { goos: 'windows', goarch: 'amd64', cgoEnabled: '0' },
    build: { goVersion: 'go1.26.0', vcsRevision: null, vcsModified: false },
  };
  assert.equal(validateBuildManifest(manifest), manifest);
  assert.throws(() => validateBuildManifest({ ...manifest, unexpected: true }), /shape/u);
  assert.throws(() => validateBuildManifest({
    ...manifest,
    dependency: { ...manifest.dependency, version: 'v0.12.1' },
  }), /policy/u);
});

test('runtime environment is closed to every case variant of AIOS and Vite AIOS input', () => {
  assert.deepEqual(sanitizedRuntimeEnvironment({
    Path: 'trusted-path',
    CODEX_HOME: 'native-profile',
    AIOS_CODEX_COMMAND: 'malicious',
    aios_sidecar_token: 'secret',
    AiOs_Desktop_Shutdown_Pipe: 'poisoned',
    VITE_AIOS_SIDECAR_TOKEN: 'embedded-secret',
    vite_aios_future_option: 'poisoned',
    UNRELATED: 'preserved',
  }), {
    Path: 'trusted-path',
    CODEX_HOME: 'native-profile',
    UNRELATED: 'preserved',
  });
});
