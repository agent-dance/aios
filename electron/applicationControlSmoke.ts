import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationControlExecuteRequest } from './shared/applicationControlProtocol.js';
import { ApplicationEffectJournal } from './main/application-control/effectJournal.js';

const temporaryPrefix = join(tmpdir(), 'alsniper-application-control-smoke-');
const secretBody = 'APPLICATION_CONTROL_SMOKE_SECRET_BODY';

function smokeRequest(): ApplicationControlExecuteRequest {
  return {
    protocolVersion: 1,
    intentId: 'smoke-intent-1',
    idempotencyKey: 'smoke-idempotency-1',
    principal: {
      kind: 'agent',
      instanceId: 'domain-agent:smoke@1.0.0#sha256:abc:local',
      packageId: 'ai.alsniper.smoke@1.0.0',
      userId: 'smoke-user',
    },
    appId: 'wechat',
    actionId: 'wechat.message.send_to_current',
    arguments: { text: secretBody },
    expectedRevision: 1,
  };
}

function journalArgument(): string | null {
  const prefix = '--journal=';
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function runWorker(path: string): Promise<never> {
  const journal = await ApplicationEffectJournal.open(path);
  const request = smokeRequest();
  await journal.appendDispatchFence({
    request,
    requestFingerprint: journal.fingerprintRequest(request),
    preparedFingerprint: 'a'.repeat(64),
    approvedByUser: true,
  });
  // Simulates loss of the process after the durable fence and before any
  // terminal Receipt. No close/checkpoint path is allowed to run.
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate the smoke worker.');
}

function runCrashWorker(scriptPath: string, journalPath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, '--worker', `--journal=${journalPath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('Application-control crash worker timed out.'));
    }, 15_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        rejectPromise(new Error('Crash worker exited successfully instead of being terminated.'));
        return;
      }
      if (stderr.length > 0) {
        rejectPromise(new Error('Crash worker emitted unexpected diagnostics.'));
        return;
      }
      if (signal === null && code === null) {
        rejectPromise(new Error('Crash worker produced no exit status.'));
        return;
      }
      resolvePromise();
    });
  });
}

function assertOwnedTemporaryDirectory(path: string): void {
  const temporaryRoot = resolve(tmpdir());
  const candidate = resolve(path);
  if (
    !candidate.startsWith(`${temporaryRoot}${sep}`)
    || !basename(candidate).startsWith('alsniper-application-control-smoke-')
  ) throw new Error('Refusing to clean an unowned application-control smoke directory.');
}

async function runParent(): Promise<void> {
  const directory = await mkdtemp(temporaryPrefix);
  try {
    const path = join(directory, 'trust', 'application-control-v1.jsonl');
    const scriptPath = fileURLToPath(import.meta.url);
    await runCrashWorker(scriptPath, path);

    let journal = await ApplicationEffectJournal.open(path);
    const recovered = await journal.recoverInterruptedDispatches();
    if (
      recovered.length !== 1
      || recovered[0]?.status !== 'unknown'
      || recovered[0]?.retryable !== false
      || recovered[0]?.errorCode !== 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE'
    ) throw new Error('Crash-fenced effect did not recover as a non-retryable Unknown receipt.');
    const stableReceiptId = recovered[0].receiptId;
    await journal.close();

    const raw = await readFile(path, 'utf8');
    if (raw.includes(secretBody)) throw new Error('Effect journal persisted a secret message body.');
    const stableBytes = Buffer.byteLength(raw, 'utf8');
    for (let launch = 0; launch < 3; launch += 1) {
      journal = await ApplicationEffectJournal.open(path);
      if ((await journal.recoverInterruptedDispatches()).length !== 0) {
        throw new Error('Restart recovery appended a duplicate terminal record.');
      }
      if (journal.getLatestReceipt('smoke-idempotency-1')?.receiptId !== stableReceiptId) {
        throw new Error('Unknown receipt identity changed across restarts.');
      }
      await journal.close();
      if ((await readFile(path)).byteLength !== stableBytes) {
        throw new Error('Unchanged Unknown reconciliation grew the effect journal.');
      }
    }
    console.log(`Application-control crash smoke passed: ${stableReceiptId}`);
  } finally {
    assertOwnedTemporaryDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  }
}

const requestedJournal = journalArgument();
if (process.argv.includes('--worker')) {
  if (requestedJournal === null || dirname(requestedJournal).length === 0) {
    throw new Error('Crash worker requires an explicit journal path.');
  }
  await runWorker(requestedJournal);
} else {
  await runParent();
}
