import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDesktopShutdownChannel,
  DESKTOP_SHUTDOWN_PIPE_ENV,
  DESKTOP_SHUTDOWN_SECRET_ENV,
} from '../tools/local-runtime/desktop-shutdown-channel.mjs';
import { sanitizedRuntimeEnvironment } from '../tools/local-runtime/runtime-core.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagedRoot = join(repositoryRoot, 'release', 'AlSniper OS-win32-x64');
const executable = join(packagedRoot, 'AlSniper OS.exe');
const packagedApplication = join(packagedRoot, 'resources', 'app.asar');
const temporaryPrefix = join(tmpdir(), 'alsniper-desktop-pipe-smoke-');
const READY_TIMEOUT_MS = 30_000;
const HOLD_OPEN_MS = 3_000;
const EXIT_TIMEOUT_MS = 35_000;

const delay = (milliseconds) => new Promise((resolveDelay) => {
  const timeout = setTimeout(resolveDelay, milliseconds);
  timeout.unref();
});

function isOwnedProfile(profilePath) {
  const resolvedTemporaryRoot = resolve(tmpdir());
  const resolvedProfile = resolve(profilePath);
  return (
    resolvedProfile.startsWith(`${resolvedTemporaryRoot}${sep}`)
    && basename(resolvedProfile).startsWith('alsniper-desktop-pipe-smoke-')
  );
}

function forceKillTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    timeout: 5_000,
  });
}

function assertVisibleDesktopWindow(processId) {
  const probe = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AiosDesktopWindow { [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr handle); }'",
    '$deadline = [DateTime]::UtcNow.AddSeconds(10)',
    'do {',
    '  $desktop = Get-Process -Id ([int]$env:AIOS_SMOKE_DESKTOP_PID) -ErrorAction Stop',
    '  $desktop.Refresh()',
    '  if ($desktop.MainWindowHandle -ne 0 -and [AiosDesktopWindow]::IsWindowVisible($desktop.MainWindowHandle)) { exit 0 }',
    '  Start-Sleep -Milliseconds 100',
    '} while ([DateTime]::UtcNow -lt $deadline)',
    'exit 1',
  ].join('; ');
  const environment = sanitizedRuntimeEnvironment(process.env);
  environment.AIOS_SMOKE_DESKTOP_PID = String(processId);
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe],
    {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      timeout: 15_000,
    },
  );
  delete environment.AIOS_SMOKE_DESKTOP_PID;
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error('Packaged desktop did not expose a visible main window after startup.');
  }
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The packaged desktop shutdown-pipe smoke requires Windows x64.');
}
await Promise.all([access(executable), access(packagedApplication)]);

const profilePath = await mkdtemp(temporaryPrefix);
const channel = await createDesktopShutdownChannel();
let cleanupProfile = true;
let child;
try {
  const environment = sanitizedRuntimeEnvironment(process.env);
  environment[DESKTOP_SHUTDOWN_PIPE_ENV] = channel.pipePath;
  environment[DESKTOP_SHUTDOWN_SECRET_ENV] = channel.secret;
  child = spawn(executable, [`--user-data-dir=${profilePath}`], {
    cwd: repositoryRoot,
    env: environment,
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (child.pid === undefined) throw new Error('Packaged desktop did not receive a process identifier.');
  channel.expectClientPid(child.pid);
  delete environment[DESKTOP_SHUTDOWN_PIPE_ENV];
  delete environment[DESKTOP_SHUTDOWN_SECRET_ENV];
  const exited = new Promise((resolveExit) => child.once('close', (code, signal) => {
    resolveExit({ code, signal });
  }));
  const spawnError = new Promise((_, rejectError) => child.once('error', rejectError));

  const readiness = await Promise.race([
    channel.ready.then(() => ({ event: 'ready' })),
    exited.then((outcome) => ({ event: 'exit', outcome })),
    spawnError,
    delay(READY_TIMEOUT_MS).then(() => ({ event: 'timeout' })),
  ]);
  if (readiness.event !== 'ready') {
    throw new Error(`Packaged desktop did not complete its named-pipe handshake: ${JSON.stringify(readiness)}.`);
  }
  assertVisibleDesktopWindow(child.pid);

  const holdOutcome = await Promise.race([
    delay(HOLD_OPEN_MS).then(() => null),
    exited,
  ]);
  if (holdOutcome !== null) {
    throw new Error(`Packaged desktop exited while its supervisor pipe was held open: ${JSON.stringify(holdOutcome)}.`);
  }

  channel.requestShutdown();
  const exitOutcome = await Promise.race([
    exited,
    delay(EXIT_TIMEOUT_MS).then(() => null),
  ]);
  if (exitOutcome === null) {
    cleanupProfile = false;
    throw new Error('Packaged desktop did not complete its storage-gated shutdown within 35 seconds.');
  }
  if (exitOutcome.code !== 0 || exitOutcome.signal !== null) {
    throw new Error(`Packaged desktop shutdown was not clean: ${JSON.stringify(exitOutcome)}.`);
  }
  console.log('Packaged AlSniper OS displayed its window, stayed alive for 3 seconds, and exited cleanly after its named pipe closed.');
} finally {
  channel.dispose();
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    forceKillTree(child);
    cleanupProfile = false;
  }
  if (!isOwnedProfile(profilePath)) {
    throw new Error('Refusing to remove an unowned desktop shutdown-pipe smoke profile.');
  }
  if (cleanupProfile) {
    await rm(profilePath, { recursive: true, force: true });
  } else {
    console.error(`Preserved locked desktop shutdown-pipe smoke profile: ${profilePath}`);
  }
}
