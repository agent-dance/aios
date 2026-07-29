import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repositoryRoot, 'dist-electron', 'persistenceSmoke.js');
const temporaryPrefix = join(tmpdir(), 'alsniper-persistence-smoke-');
const processTimeoutMs = 30_000;
const terminationFallbackMs = 5_000;
const terminationAbandonMs = 10_000;
let profileCleanupSafe = true;

function isOwnedProfile(profilePath) {
  const resolvedTemporaryRoot = resolve(tmpdir());
  const resolvedProfile = resolve(profilePath);
  return (
    resolvedProfile.startsWith(`${resolvedTemporaryRoot}${sep}`)
    && basename(resolvedProfile).startsWith('alsniper-persistence-smoke-')
  );
}

async function runPhase(phase, profilePath, marker) {
  const arguments_ = [
    workerPath,
    `--phase=${phase}`,
    `--profile=${profilePath}`,
    `--marker=${marker}`,
  ];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(electronPath, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let terminationFallback;
    let terminationAbandon;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid !== undefined) {
        const terminator = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        terminator.once('error', () => child.kill());
        terminator.once('close', (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            child.kill();
          }
        });
      } else {
        child.kill('SIGKILL');
      }
      terminationFallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }, terminationFallbackMs);
      terminationAbandon = setTimeout(() => {
        profileCleanupSafe = false;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        rejectPromise(new Error(
          `Persistence smoke ${phase} did not terminate; its isolated profile was preserved for safety.`,
        ));
      }, terminationAbandonMs);
    }, processTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(terminationFallback);
      clearTimeout(terminationAbandon);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(terminationFallback);
      clearTimeout(terminationAbandon);
      if (timedOut) {
        rejectPromise(new Error(`Persistence smoke ${phase} phase timed out and was terminated.`));
        return;
      }
      const successMarker = JSON.stringify({ event: 'PERSISTENCE_SMOKE_OK', phase, marker });
      if (code === 0 && signal === null && stdout.includes(successMarker)) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `Persistence smoke ${phase} failed (code=${String(code)}, signal=${String(signal)}).\n${stdout}\n${stderr}`,
      ));
    });
  });
}

const profilePath = await mkdtemp(temporaryPrefix);
const marker = randomUUID();
try {
  await runPhase('write', profilePath, marker);
  await runPhase('read', profilePath, marker);
  console.log(`Persistent shell and WeChat storage survived a real process restart (${marker}).`);
} finally {
  if (!isOwnedProfile(profilePath)) {
    throw new Error('Refusing to remove an unowned persistence smoke profile.');
  }
  if (profileCleanupSafe) {
    await rm(profilePath, { recursive: true, force: true });
  } else {
    console.error(`Preserved locked persistence smoke profile: ${profilePath}`);
  }
}
