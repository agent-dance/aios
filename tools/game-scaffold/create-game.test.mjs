import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ScaffoldError,
  generateGame,
  parseArguments,
  validateDisplayName,
  validateGameId,
} from './create-game.mjs';

async function withRepository(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alsniper-game-scaffold-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parses both spaced and equals arguments', () => {
  assert.deepEqual(parseArguments(['--id', 'asteroid-run', '--name=Asteroid Run']), {
    id: 'asteroid-run',
    name: 'Asteroid Run',
  });
});

test('rejects unsafe, malformed, reserved, duplicate, and missing arguments', () => {
  for (const id of ['../escape', 'Uppercase', '-leading', 'two--dashes', 'space game', 'con', 'space-game']) {
    assert.throws(() => validateGameId(id), ScaffoldError);
  }
  assert.throws(() => validateDisplayName('\u0000bad'), ScaffoldError);
  assert.throws(() => parseArguments(['--id', 'safe-game', '--id', 'other', '--name', 'Safe']), ScaffoldError);
  assert.throws(() => parseArguments(['--id', 'safe-game']), ScaffoldError);
  assert.throws(() => parseArguments(['--unknown', 'value']), ScaffoldError);
});

test('creates a complete platform-backed template in one committed directory', async () => {
  await withRepository(async (root) => {
    const result = await generateGame({ id: 'asteroid-run', name: 'Asteroid Run', repositoryRoot: root });
    assert.deepEqual(result.files.sort(), [
      'AsteroidRunAgentAdapter.test.ts',
      'AsteroidRunAgentAdapter.ts',
      'AsteroidRunApp.tsx',
      'AsteroidRunEngine.test.ts',
      'AsteroidRunEngine.ts',
      'README.md',
      'index.ts',
    ].sort());
    const app = await readFile(path.join(result.target, 'AsteroidRunApp.tsx'), 'utf8');
    const adapter = await readFile(path.join(result.target, 'AsteroidRunAgentAdapter.ts'), 'utf8');
    const adapterTest = await readFile(path.join(result.target, 'AsteroidRunAgentAdapter.test.ts'), 'utf8');
    const engine = await readFile(path.join(result.target, 'AsteroidRunEngine.ts'), 'utf8');
    const generatedReadme = await readFile(path.join(result.target, 'README.md'), 'utf8');
    const testSource = await readFile(path.join(result.target, 'AsteroidRunEngine.test.ts'), 'utf8');
    assert.match(app, /game-platform\/runtime/);
    assert.match(app, /game-platform\/web/);
    assert.match(app, /game-platform\/r3f/);
    assert.match(app, /frameloop=.*demand/);
    assert.match(app, /useGameAutomationBridge/);
    assert.match(app, /useGameAutomationBridge\(\{\s*enabled: isActive,/);
    assert.match(app, /hasVirtualTimeMarker\(window as GameAutomationTarget\)/);
    assert.match(app, /const manualClockRef = useRef\(manualClock\)/);
    assert.match(app, /if \(manualClockRef\.current\) return;/);
    assert.match(app, /onManualClockRequested: requestManualClock/);
    assert.match(app, /manual=\{manualClock\}/);
    assert.match(app, /suspendOnInactive: true/);
    assert.match(app, /suspendOnBlur: true/);
    assert.match(app, /suspendWhenHidden: true/);
    assert.match(app, /resetInputOnSuspend: true/);
    assert.match(app, /useFullscreenController\(\{ target: shellRef \}\)/);
    assert.match(app, /createAsteroidRunAgentGameHost\('asteroid-run-local'\)\.bindParticipant/);
    assert.match(app, /kind: 'human'/);
    assert.match(app, /humanPort\.act\(/);
    assert.match(app, /useState\(\(\) => humanPort\.observe\(\)\.observation\)/);
    assert.match(app, /setSnapshot\(humanPort\.observe\(\)\.observation\)/);
    assert.match(app, /dispatchAction\(\{ type: 'move'/);
    assert.match(app, /dispatchAction\(\{ type: 'restart' \}\);\s*resetPresentation\(\)/);
    assert.match(app, /key === 'r'[\s\S]{0,100}restart\(\)/);
    assert.match(app, /id="restart-btn"[\s\S]{0,100}onClick=\{restart\}/);
    assert.match(app, /renderAsteroidRunToText\([\s\S]{0,120}humanPort\.observe\(\)\.observation,[\s\S]{0,80}runtime\.getState\(\)/);
    assert.match(app, /<Player playerX=\{snapshot\.player\.x\}/);
    assert.doesNotMatch(app, /reduceAsteroidRunAction/);
    assert.equal(app.match(/runtime\.replaceState/g)?.length, 1);
    assert.match(app, /runtime\.replaceState\(createInitialAsteroidRunPresentationState\(\)\)/);
    assert.doesNotMatch(app, /runtime\.replaceState\(\{[\s\S]{0,160}(mode|player|score)/);
    assert.match(app, /resetPresentation[\s\S]{0,180}runtime\.resetInput\(\)[\s\S]{0,100}runtime\.resetClock\(\)/);
    assert.equal(app.match(/<Canvas\b/g)?.length, 1);
    assert.equal(app.match(/<FixedStepDriver\b/g)?.length, 1);
    assert.doesNotMatch(app, /requestAnimationFrame/);
    assert.doesNotMatch(app, /Date\.now|performance\.now/);
    assert.match(testSource, /game-platform\/testkit/);
    assert.match(testSource, /whole\.advance\(2_000\)/);
    assert.match(testSource, /createRuntime\(120\)/);
    assert.match(engine, /export function listLegalAsteroidRunActions/);
    assert.match(engine, /export function reduceAsteroidRunAction/);
    assert.match(engine, /action\.type === 'restart'\) return createInitialAsteroidRunState\(\)/);
    assert.match(engine, /export interface AsteroidRunPresentationState \{\s*readonly elapsedMs: number;\s*\}/);
    const presentationState = engine.match(/export interface AsteroidRunPresentationState \{([\s\S]*?)\}/)?.[1] ?? '';
    assert.doesNotMatch(presentationState, /mode|player|score/);
    assert.match(app, /createFixedStepRuntime<AsteroidRunPresentationState, AsteroidRunPresentationInput>/);
    assert.match(adapter, /game-platform\/agent/);
    assert.match(adapter, /AGAP_PROTOCOL_VERSION/);
    assert.match(adapter, /seats: \[\{ id: ASTEROIDRUN_PLAYER_SEAT_ID/);
    assert.match(adapter, /seatProjection: 'player-visible'/);
    assert.match(adapter, /actionTypes: \['start', 'move', 'pause', 'resume', 'restart'\]/);
    assert.match(adapter, /state: Readonly<AsteroidRunState>/);
    assert.match(adapter, /_seatId: AsteroidRunSeatId/);
    assert.match(adapter, /action: Readonly<AsteroidRunAction>/);
    assert.match(adapter, /projectAsteroidRunState\(state\)/);
    assert.match(adapter, /legalActions:[\s\S]{0,180}listLegalAsteroidRunActions\(state\)/);
    assert.match(adapter, /transition:[\s\S]{0,160}reduceAsteroidRunAction/);
    assert.match(adapterTest, /human and agent participants identical observations and formal actions/);
    assert.match(adapterTest, /bind\('human'/);
    assert.match(adapterTest, /bind\('agent'/);
    assert.equal(adapterTest.match(/'parity-contract'/g)?.length, 2);
    assert.match(adapterTest, /const requestId = `parity-\$\{index\}`/);
    assert.match(adapterTest, /stableSerialize\(agentReceipt\)[\s\S]{0,100}stableSerialize\(humanReceipt\)/);
    assert.match(
      adapterTest,
      /stableSerialize\(agent\.observe\(\)\.observation\)[\s\S]{0,100}stableSerialize\(human\.observe\(\)\.observation\)/,
    );
    assert.match(
      adapterTest,
      /agent\.listLegalActions\(\)\.actions[\s\S]{0,180}human\.listLegalActions\(\)\.actions/,
    );
    assert.match(adapterTest, /stableSerialize\(agent\.readEvents\(\)\)[\s\S]{0,100}stableSerialize\(human\.readEvents\(\)\)/);
    assert.match(adapterTest, /\{ type: 'restart' \}/);
    assert.match(adapterTest, /mode: 'ready'[\s\S]{0,100}player: \{ x: 0, y: 0, z: 0 \}[\s\S]{0,80}score: 0/);
    assert.match(testSource, /not\.toHaveProperty\('mode'\)/);
    assert.doesNotMatch(testSource, /runtime\.replaceState/);
    assert.match(generatedReadme, /__vt_pending/);
    assert.match(generatedReadme, /default 240-step budget/);
    assert.match(generatedReadme, /AGAP Host is the sole gameplay authority/);
    assert.match(generatedReadme, /fixed-step runtime stores presentation time only/);
    assert.deepEqual((await readdir(path.join(root, 'src', 'apps'))).filter((entry) => entry.startsWith('.game-scaffold-')), []);
  });
});

test('encodes a display name as data instead of executable TSX', async () => {
  await withRepository(async (root) => {
    const result = await generateGame({ id: 'encoded-name', name: 'Name </h2>{danger}', repositoryRoot: root });
    const app = await readFile(path.join(result.target, 'EncodedNameApp.tsx'), 'utf8');
    assert.ok(app.includes('const GAME_NAME = "Name </h2>{danger}";'));
    assert.doesNotMatch(app, /<h2[^>]*>Name/);
  });
});

test('refuses to overwrite an existing game', async () => {
  await withRepository(async (root) => {
    await generateGame({ id: 'safe-game', name: 'Safe Game', repositoryRoot: root });
    await assert.rejects(
      generateGame({ id: 'safe-game', name: 'Replacement', repositoryRoot: root }),
      /Refusing to overwrite/,
    );
  });
});

test('removes its temporary directory after a pre-commit failure', async () => {
  await withRepository(async (root) => {
    await assert.rejects(
      generateGame({
        id: 'failure-probe',
        name: 'Failure Probe',
        repositoryRoot: root,
        beforeCommit: async () => { throw new Error('injected failure'); },
      }),
      /injected failure/,
    );
    const appsRoot = path.join(root, 'src', 'apps');
    assert.deepEqual(await readdir(appsRoot), []);
  });
});

test('detects a destination created concurrently and cleans up', async () => {
  await withRepository(async (root) => {
    await assert.rejects(
      generateGame({
        id: 'race-safe',
        name: 'Race Safe',
        repositoryRoot: root,
        beforeCommit: async ({ target }) => mkdir(target),
      }),
      /Refusing to overwrite/,
    );
    const entries = await readdir(path.join(root, 'src', 'apps'));
    assert.deepEqual(entries, ['race-safe']);
  });
});
