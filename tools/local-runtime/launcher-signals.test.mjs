import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installShutdownSignals } from './launcher-signals.mjs';

class TestStdin extends EventEmitter {
  resumeCalls = 0;
  pauseCalls = 0;

  resume() {
    this.resumeCalls += 1;
  }

  pause() {
    this.pauseCalls += 1;
  }
}

class TestProcess extends EventEmitter {
  stdin = new TestStdin();
}

test('launcher signal bindings resolve an explicit shutdown request', () => {
  const processLike = new TestProcess();
  const outcomes = [];
  const dispose = installShutdownSignals(processLike, (outcome) => outcomes.push(outcome));

  assert.equal(processLike.stdin.resumeCalls, 1);
  processLike.emit('SIGTERM');
  assert.deepEqual(outcomes, ['SIGTERM']);

  dispose();
});

test('launcher signal bindings resolve a closed supervisor stdin', () => {
  const processLike = new TestProcess();
  const outcomes = [];
  const dispose = installShutdownSignals(processLike, (outcome) => outcomes.push(outcome));

  processLike.stdin.emit('end');
  assert.deepEqual(outcomes, ['stdin-eof']);

  dispose();
});

test('launcher signal cleanup is idempotent and releases every event-loop binding', () => {
  const processLike = new TestProcess();
  const outcomes = [];
  const dispose = installShutdownSignals(processLike, (outcome) => outcomes.push(outcome));

  dispose();
  dispose();

  assert.equal(processLike.stdin.pauseCalls, 1);
  assert.equal(processLike.stdin.listenerCount('end'), 0);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.equal(processLike.listenerCount(signal), 0);
    processLike.emit(signal);
  }
  processLike.stdin.emit('end');
  assert.deepEqual(outcomes, []);
});

test('launcher signal bindings reject an incomplete process contract', () => {
  assert.throws(
    () => installShutdownSignals({ stdin: {} }, () => {}),
    /controllable stdin/u,
  );
});

test('launcher process exits after supervisor stdin closes and bindings are disposed', async () => {
  const moduleUrl = new URL('./launcher-signals.mjs', import.meta.url).href;
  const program = [
    `import { installShutdownSignals } from ${JSON.stringify(moduleUrl)};`,
    'let dispose;',
    'await new Promise((resolve) => {',
    '  dispose = installShutdownSignals(process, (outcome) => {',
    "    if (outcome !== 'stdin-eof') throw new Error(`Unexpected outcome: ${outcome}`);",
    '    dispose();',
    '    resolve();',
    '  });',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const outcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The launcher fixture retained event-loop bindings after stdin closed.'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  child.stdin.end();
  assert.deepEqual(await outcome, { code: 0, signal: null });
});
