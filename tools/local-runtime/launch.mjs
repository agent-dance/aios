import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHealthProof,
  parseGoVersionMetadata,
  sanitizedRuntimeEnvironment,
  secureHashEqual,
  SIDECAR_ARTIFACT,
  SIDECAR_DEPENDENCY,
  SIDECAR_DEPENDENCY_VERSION,
  SIDECAR_ORIGIN,
  SIDECAR_PROTOCOL_VERSION,
  validateBuildManifest,
  verifyHealthResponse,
} from './runtime-core.mjs';
import {
  createDesktopShutdownChannel,
  DESKTOP_SHUTDOWN_PIPE_ENV,
  DESKTOP_SHUTDOWN_SECRET_ENV,
} from './desktop-shutdown-channel.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeDirectory = join(repositoryRoot, 'release', 'local-agent-runtime');
const sidecarPath = join(runtimeDirectory, SIDECAR_ARTIFACT);
const manifestPath = join(runtimeDirectory, 'alsniper-agent.manifest.json');
const packagedDesktopDirectory = join(repositoryRoot, 'release', 'AlSniper OS-win32-x64');
const electronExecutable = join(packagedDesktopDirectory, 'AlSniper OS.exe');
const packagedApplication = join(packagedDesktopDirectory, 'resources', 'app.asar');
const READY_TIMEOUT_MS = 45_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const HEALTH_BODY_LIMIT = 1024 * 1024;
const SIDECAR_GRACEFUL_SHUTDOWN_MS = 12_000;
const DESKTOP_GRACEFUL_SHUTDOWN_MS = 30_000;
const DESKTOP_STARTUP_STABILITY_MS = 2_000;
const DESKTOP_READY_TIMEOUT_MS = 30_000;

const children = new Set();
let shuttingDown = false;
let exitCleanupEnabled = true;

async function assertRegularFile(path, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximumBytes) {
    throw new Error(`Required runtime artifact is not a bounded regular file: ${path}`);
  }
  return stats;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function runCaptured(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const capture = (target) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 512 * 1024) {
        child.kill();
        rejectRun(new Error(`${command} produced excessive output.`));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
        rejectRun(new Error(`${command} failed (${signal ?? code})${diagnostic === '' ? '' : `: ${diagnostic}`}`));
        return;
      }
      resolveRun(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function verifySidecarArtifact() {
  await Promise.all([
    assertRegularFile(sidecarPath, 256 * 1024 * 1024),
    assertRegularFile(manifestPath, 64 * 1024),
  ]);
  const manifest = validateBuildManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const actualHash = await sha256File(sidecarPath);
  if (!secureHashEqual(manifest.sha256, actualHash)) {
    throw new Error('The local sidecar binary does not match its recorded SHA-256. Rebuild it before launching.');
  }
  const buildMetadata = parseGoVersionMetadata(await runCaptured('go', ['version', '-m', sidecarPath]));
  if (buildMetadata.dependencySum !== manifest.dependency.sum) {
    throw new Error('The local sidecar dependency metadata does not match its build manifest.');
  }
  return actualHash;
}

async function verifyDesktopArtifacts() {
  await Promise.all([
    assertRegularFile(electronExecutable, 512 * 1024 * 1024),
    assertRegularFile(packagedApplication, 512 * 1024 * 1024),
  ]);
}

async function resolveAuditedCodexExecutable() {
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || appData.trim() === '') {
    throw new Error('APPDATA is unavailable; the audited local Codex installation cannot be resolved.');
  }
  const packageRoot = join(appData, 'npm', 'node_modules', '@openai', 'codex');
  const packageManifestPath = join(packageRoot, 'package.json');
  const executableCandidate = join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  await Promise.all([
    assertRegularFile(packageManifestPath, 1024 * 1024),
    assertRegularFile(executableCandidate, 512 * 1024 * 1024),
  ]);
  const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
  if (packageManifest.name !== '@openai/codex' || packageManifest.version !== '0.145.0') {
    throw new Error('The local Codex package must be exactly @openai/codex 0.145.0.');
  }
  const [canonicalPackageRoot, canonicalExecutable] = await Promise.all([
    realpath(packageRoot),
    realpath(executableCandidate),
  ]);
  const expectedPrefix = `${canonicalPackageRoot.toUpperCase()}\\`;
  if (!canonicalExecutable.toUpperCase().startsWith(expectedPrefix)) {
    throw new Error('The local Codex executable resolves outside its audited package.');
  }
  const version = (await runCaptured(canonicalExecutable, ['--version'])).trim();
  if (version !== 'codex-cli 0.145.0') {
    throw new Error('The local Codex executable failed its exact version check.');
  }
  return canonicalExecutable;
}

async function assertNoRunningPackagedDesktop() {
  const probe = [
    "$target = [IO.Path]::GetFullPath($env:AIOS_INSPECT_DESKTOP_PATH)",
    '$matching = @()',
    '$unresolved = 0',
    "[Diagnostics.Process]::GetProcessesByName('AlSniper OS') | ForEach-Object {",
    '  try {',
    '    $candidate = [IO.Path]::GetFullPath($_.MainModule.FileName)',
    '    if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $target)) { $matching += $_.Id }',
    '  } catch { $unresolved += 1 } finally { $_.Dispose() }',
    '}',
    '[PSCustomObject]@{ matching = @($matching); unresolved = $unresolved } | ConvertTo-Json -Compress',
  ].join('; ');
  const output = await runCaptured('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe], {
    env: { ...sanitizedRuntimeEnvironment(process.env), AIOS_INSPECT_DESKTOP_PATH: electronExecutable },
  });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('Could not determine whether AlSniper OS is already running.');
  }
  if (
    result === null
    || typeof result !== 'object'
    || !Array.isArray(result.matching)
    || !result.matching.every((pid) => Number.isInteger(pid) && pid > 0)
    || !Number.isInteger(result.unresolved)
    || result.unresolved < 0
  ) {
    throw new Error('The existing AlSniper OS process check returned an invalid result.');
  }
  if (result.unresolved > 0) {
    throw new Error('An AlSniper OS process could not be authenticated. Close all AlSniper OS windows normally, then retry.');
  }
  if (result.matching.length > 0) {
    throw new Error('AlSniper OS is already running. Close it normally before launching the local Agent runtime.');
  }
}

async function chooseHighLoopbackPort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = await new Promise((resolvePort, rejectPort) => {
      const reservation = createServer();
      reservation.unref();
      reservation.once('error', rejectPort);
      reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = reservation.address();
        const candidate = typeof address === 'object' && address !== null ? address.port : 0;
        reservation.close((error) => error === undefined ? resolvePort(candidate) : rejectPort(error));
      });
    });
    // Port zero delegates allocation to Windows' configured dynamic range.
    // That range is host policy and is not necessarily the IANA 49152+
    // default (for example, hardened or developer machines may configure it
    // to begin at 1024).  Security comes from loopback binding plus the
    // per-launch HMAC secret, not from assuming one particular range.
    if (Number.isInteger(port) && port >= 1_024 && port <= 65_535) return port;
  }
  throw new Error('The operating system did not allocate an available high loopback port.');
}

function observeExit(child, name) {
  return new Promise((resolveExit) => {
    child.once('close', (code, signal) => {
      children.delete(child);
      resolveExit(Object.freeze({ child, name, code, signal }));
    });
  });
}

function startManagedChild(command, args, options, name) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    windowsHide: true,
    shell: false,
    detached: false,
    ...options,
  });
  children.add(child);
  child.stdin?.on('error', () => {});
  child.once('error', (error) => {
    if (!shuttingDown) console.error(`${name} could not start: ${error.message}`);
  });
  return { child, exit: observeExit(child, name) };
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[name] = value;
  }
  return normalized;
}

async function signedHealth(port, token) {
  const proof = createHealthProof({ token, port });
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/v1/health',
      headers: {
        Origin: SIDECAR_ORIGIN,
        'X-AIOS-Protocol-Version': SIDECAR_PROTOCOL_VERSION,
        'X-AIOS-Timestamp': proof.timestamp,
        'X-AIOS-Nonce': proof.nonce,
        'X-AIOS-Content-SHA256': proof.bodyHash,
        'X-AIOS-Signature': proof.signature,
      },
    });
    const chunks = [];
    let bodyBytes = 0;
    request.setTimeout(HEALTH_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Sidecar health request timed out.')));
    request.once('error', rejectResponse);
    request.once('response', (incoming) => {
      incoming.on('data', (chunk) => {
        bodyBytes += chunk.byteLength;
        if (bodyBytes > HEALTH_BODY_LIMIT) {
          incoming.destroy(new Error('Sidecar health response exceeded its size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once('error', rejectResponse);
      incoming.once('end', () => resolveResponse({
        status: incoming.statusCode ?? 0,
        headers: normalizeHeaders(incoming.headers),
        body: Buffer.concat(chunks),
      }));
    });
    request.end();
  });

  const payload = verifyHealthResponse({ token, proof, ...response });
  return response.status === 200 && payload.protocolVersion === SIDECAR_PROTOCOL_VERSION && payload.status === 'ready';
}

const delay = (milliseconds) => new Promise((resolveDelay) => {
  const timeout = setTimeout(resolveDelay, milliseconds);
  timeout.unref();
});

async function waitUntilReady(port, token, sidecar) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null || sidecar.signalCode !== null) {
      throw new Error('The local Agent sidecar exited before it became ready.');
    }
    try {
      if (await signedHealth(port, token)) return;
    } catch (error) {
      if (error instanceof Error && !/ECONNREFUSED|ECONNRESET|timed out/u.test(error.message)) throw error;
    }
    await delay(150);
  }
  throw new Error('The local Agent sidecar did not become ready within 45 seconds.');
}

function forceKillTreeSync(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      timeout: 5_000,
    });
  } else {
    try { child.kill('SIGKILL'); } catch { /* The exact child has already exited. */ }
  }
}

async function stopManagedChild(child, exitPromise, preferStdin = false, gracefulTimeoutMs = SIDECAR_GRACEFUL_SHUTDOWN_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (preferStdin && child.stdin !== null && !child.stdin.destroyed) {
    child.stdin.end();
  } else {
    try { child.kill('SIGTERM'); } catch { return; }
  }

  let exited = false;
  await Promise.race([
    exitPromise.then(() => { exited = true; }),
    delay(gracefulTimeoutMs),
  ]);
  if (!exited) {
    forceKillTreeSync(child);
    await Promise.race([exitPromise, delay(2_000)]);
  }
}

async function stopManagedDesktop(child, exitPromise, shutdownChannel) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  shutdownChannel.requestShutdown();
  let exited = false;
  await Promise.race([
    exitPromise.then(() => { exited = true; }),
    delay(DESKTOP_GRACEFUL_SHUTDOWN_MS),
  ]);
  if (!exited) {
    forceKillTreeSync(child);
    await Promise.race([exitPromise, delay(2_000)]);
  }
}

function installShutdownSignals(resolveSignal) {
  const handler = (signal) => resolveSignal(signal);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, handler);
  process.stdin.resume();
  process.stdin.once('end', () => resolveSignal('stdin-eof'));
}

async function startReadySidecar({ token, codexExecutable, artifactHash, shutdownSignal }) {
  let lastError = new Error('The local Agent sidecar could not start.');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const port = await chooseHighLoopbackPort();
    let tokenText = token.toString('utf8');
    const sidecarEnvironment = sanitizedRuntimeEnvironment(process.env);
    sidecarEnvironment.AIOS_SIDECAR_LISTEN = `127.0.0.1:${port}`;
    sidecarEnvironment.AIOS_SIDECAR_ORIGIN = SIDECAR_ORIGIN;
    sidecarEnvironment.AIOS_SIDECAR_TOKEN = tokenText;
    sidecarEnvironment.AIOS_SIDECAR_SHUTDOWN_STDIN = '1';
    sidecarEnvironment.AIOS_CODEX_COMMAND = codexExecutable;

    const sidecar = startManagedChild(sidecarPath, [], {
      env: sidecarEnvironment,
      stdio: ['pipe', 'inherit', 'inherit'],
    }, 'AlSniper Agent sidecar');
    delete sidecarEnvironment.AIOS_SIDECAR_TOKEN;
    delete sidecarEnvironment.AIOS_SIDECAR_LISTEN;
    delete sidecarEnvironment.AIOS_SIDECAR_ORIGIN;
    delete sidecarEnvironment.AIOS_SIDECAR_SHUTDOWN_STDIN;
    delete sidecarEnvironment.AIOS_CODEX_COMMAND;
    tokenText = '';

    try {
      if (!secureHashEqual(artifactHash, await sha256File(sidecarPath))) {
        throw new Error('The local sidecar binary changed while it was being started.');
      }
      await Promise.race([
        waitUntilReady(port, token, sidecar.child),
        shutdownSignal.then(() => { throw new Error('Local runtime shutdown was requested during startup.'); }),
      ]);
      return Object.freeze({ ...sidecar, port });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('The local Agent sidecar could not start.');
      const exitedDuringStartup = sidecar.child.exitCode !== null || sidecar.child.signalCode !== null;
      let exitOutcome;
      if (exitedDuringStartup) exitOutcome = await sidecar.exit;
      await stopManagedChild(sidecar.child, sidecar.exit, true, SIDECAR_GRACEFUL_SHUTDOWN_MS);
      if (exitOutcome?.code === 1 && attempt < 4) {
        console.warn('The sidecar exited during loopback startup; retrying with another high port.');
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

process.once('exit', () => {
  if (!exitCleanupEnabled) return;
  for (const child of children) forceKillTreeSync(child);
});

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The trusted local runtime launcher currently supports Windows x64 only.');
  }
  const [artifactHash, , codexExecutable] = await Promise.all([
    verifySidecarArtifact(),
    verifyDesktopArtifacts(),
    resolveAuditedCodexExecutable(),
  ]);
  await assertNoRunningPackagedDesktop();
  console.log(`Verified local ${SIDECAR_DEPENDENCY} ${SIDECAR_DEPENDENCY_VERSION} sidecar (${artifactHash}).`);

  // The protocol secret is transported as text in child environments and is
  // therefore also HMACed as those exact UTF-8 bytes.  Keeping the 256 bits of
  // entropy hex-encoded avoids the raw-bytes/text mismatch that would make a
  // correctly authenticated sidecar appear untrusted to the supervisor.
  const token = Buffer.from(randomBytes(32).toString('hex'), 'utf8');
  let tokenText = '';
  let sidecar;
  let electron;
  let desktopShutdownChannel;
  let signalResolve;
  const signal = new Promise((resolveSignal) => { signalResolve = resolveSignal; });
  installShutdownSignals(signalResolve);

  try {
    sidecar = await startReadySidecar({ token, codexExecutable, artifactHash, shutdownSignal: signal });
    await assertNoRunningPackagedDesktop();
    console.log('Local Agent sidecar is authenticated and ready; starting AlSniper OS.');

    desktopShutdownChannel = await createDesktopShutdownChannel();
    tokenText = token.toString('utf8');
    const electronEnvironment = sanitizedRuntimeEnvironment(process.env);
    electronEnvironment.AIOS_DESKTOP_SIDECAR_URL = `http://127.0.0.1:${sidecar.port}`;
    electronEnvironment.AIOS_DESKTOP_SIDECAR_ORIGIN = SIDECAR_ORIGIN;
    electronEnvironment.AIOS_DESKTOP_SIDECAR_TOKEN = tokenText;
    electronEnvironment[DESKTOP_SHUTDOWN_PIPE_ENV] = desktopShutdownChannel.pipePath;
    electronEnvironment[DESKTOP_SHUTDOWN_SECRET_ENV] = desktopShutdownChannel.secret;
    electron = startManagedChild(electronExecutable, [], {
      env: electronEnvironment,
      stdio: ['ignore', 'inherit', 'inherit'],
    }, 'AlSniper OS');
    if (electron.child.pid === undefined) {
      throw new Error('AlSniper OS did not receive a process identifier.');
    }
    desktopShutdownChannel.expectClientPid(electron.child.pid);
    delete electronEnvironment.AIOS_DESKTOP_SIDECAR_TOKEN;
    delete electronEnvironment.AIOS_DESKTOP_SIDECAR_URL;
    delete electronEnvironment.AIOS_DESKTOP_SIDECAR_ORIGIN;
    delete electronEnvironment[DESKTOP_SHUTDOWN_PIPE_ENV];
    delete electronEnvironment[DESKTOP_SHUTDOWN_SECRET_ENV];
    tokenText = '';
    token.fill(0);

    const readinessOutcome = await Promise.race([
      desktopShutdownChannel.ready.then(() => null),
      delay(DESKTOP_READY_TIMEOUT_MS).then(() => ({ name: 'desktop-ready-timeout' })),
      sidecar.exit,
      electron.exit,
      signal.then((name) => ({ name })),
    ]);
    if (readinessOutcome !== null) {
      if ('child' in readinessOutcome) {
        throw new Error(`${readinessOutcome.name} exited before the desktop readiness handshake completed.`);
      }
      if (readinessOutcome.name === 'desktop-ready-timeout') {
        throw new Error('AlSniper OS did not authenticate its desktop shutdown channel within 30 seconds.');
      }
      throw new Error('Local runtime shutdown was requested before the desktop readiness handshake.');
    }
    console.log('AlSniper OS established its desktop lifecycle channel.');

    const stabilityOutcome = await Promise.race([
      delay(DESKTOP_STARTUP_STABILITY_MS).then(() => null),
      sidecar.exit,
      electron.exit,
      signal.then((name) => ({ name })),
    ]);
    if (stabilityOutcome !== null) {
      if ('child' in stabilityOutcome) {
        throw new Error(`${stabilityOutcome.name} exited during desktop startup stabilization.`);
      }
      throw new Error('Local runtime shutdown was requested during desktop startup stabilization.');
    }

    const outcome = await Promise.race([sidecar.exit, electron.exit, signal.then((name) => ({ name }))]);
    if ('child' in outcome && !shuttingDown) {
      const reason = outcome.signal ?? outcome.code;
      console.log(`${outcome.name} exited (${reason ?? 'clean'}); stopping the local runtime.`);
    }
  } finally {
    tokenText = '';
    token.fill(0);
    shuttingDown = true;
    await Promise.all([
      sidecar === undefined ? Promise.resolve() : stopManagedChild(sidecar.child, sidecar.exit, true, SIDECAR_GRACEFUL_SHUTDOWN_MS),
      electron === undefined || desktopShutdownChannel === undefined
        ? Promise.resolve()
        : stopManagedDesktop(electron.child, electron.exit, desktopShutdownChannel),
    ]);
    desktopShutdownChannel?.dispose();
    exitCleanupEnabled = false;
  }
}

await main();
