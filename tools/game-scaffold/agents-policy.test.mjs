import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const skillRoot = path.join(repositoryRoot, '.agents', 'skills', 'game-scaffold');

const readRepositoryFile = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const readSkillFile = (relativePath) => readFile(path.join(skillRoot, relativePath), 'utf8');

function extractRoutedReferences(markdown) {
  return [...markdown.matchAll(/`(references\/[^`]+\.md)`/g)].map((match) => match[1]);
}

test('root AGENTS.md keeps only a fail-closed route to the repository game Skill', async () => {
  const agents = await readRepositoryFile('AGENTS.md');

  assert.ok(agents.length <= 2_500, 'AGENTS.md must remain a compact routing surface');
  assert.match(agents, /本文件作用于整个仓库/);
  assert.match(agents, /\$game-scaffold/);
  assert.match(agents, /\.agents\/skills\/game-scaffold\/SKILL\.md/);
  assert.match(agents, /任何实现写操作前加载并完整遵循/);
  assert.match(agents, /无法读取[\s\S]{0,120}必须停止游戏实现/);
  assert.match(agents, /普通非游戏系统应用不触发/);

  assert.ok(!agents.includes('npm run game:create'), 'Detailed scaffold policy belongs in the Skill');
  assert.ok(!agents.includes('window.advanceTime'), 'Runtime details must not expand AGENTS.md context');
  assert.ok(!agents.includes('### 1.'), 'Numbered game policy sections belong in the Skill');
});

test('game-scaffold Skill metadata and progressive reference routing stay valid', async () => {
  const skill = await readSkillFile('SKILL.md');
  const openAiMetadata = await readSkillFile('agents/openai.yaml');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  assert.ok(frontmatter, 'SKILL.md must begin with YAML frontmatter');
  assert.match(frontmatter[1], /^name: game-scaffold$/m);
  const encodedDescription = frontmatter[1].match(/^description: ("[^"]+")$/m)?.[1];
  assert.ok(encodedDescription, 'Skill frontmatter must contain one quoted description');
  const description = JSON.parse(encodedDescription);
  for (const trigger of [
    'browser-game',
    'gameplay simulation',
    'rendering loops',
    'automation',
    'determinism',
    'performance',
    'game scaffold',
    'src/game-platform',
  ]) {
    assert.ok(description.includes(trigger), `Skill description must retain trigger: ${trigger}`);
  }
  assert.match(description, /Do not use for ordinary non-game system apps/);

  const expectedReferences = [
    'references/core-contract.md',
    'references/verification.md',
    'references/new-game.md',
    'references/existing-and-platform.md',
  ].sort();
  const actualReferences = (await readdir(path.join(skillRoot, 'references'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `references/${entry.name}`)
    .sort();
  assert.deepEqual(actualReferences, expectedReferences, 'The checked-in reference set must remain explicit');

  const documents = new Map([['SKILL.md', skill]]);
  for (const reference of actualReferences) {
    const content = await readSkillFile(reference);
    assert.ok(content.trim().length > 0, `${reference} must be non-empty`);
    documents.set(reference, content);
  }

  const graph = new Map(
    [...documents].map(([name, content]) => [name, [...new Set(extractRoutedReferences(content))]]),
  );
  for (const [source, targets] of graph) {
    for (const target of targets) {
      assert.ok(documents.has(target), `${source} routes to missing ${target}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    assert.ok(!visiting.has(node), `Skill reference cycle detected at ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  visit('SKILL.md');
  assert.deepEqual([...visited].sort(), [...documents.keys()].sort(), 'Every reference must be reachable from SKILL.md');

  assert.match(skill, /Always read these Skill references completely/);
  assert.match(skill, /Read `docs\/games\/README\.md`, `docs\/games\/template-contract\.md`/);
  assert.match(skill, /target game's `README\.md` \/ `progress\.md` when present/);
  assert.match(skill, /Read the installed `develop-web-game` Skill completely/);
  assert.match(skill, /If it is unavailable, report that fact and perform an equivalent real-browser workflow/);
  assert.match(skill, /New game: `references\/new-game\.md`/);
  assert.match(skill, /Existing-game migration\/refactor[\s\S]{0,160}`references\/existing-and-platform\.md`/);
  assert.match(skill, /Do not begin implementation until all required references/);
  assert.match(openAiMetadata, /display_name: "AlSniper Game Scaffold"/);
  assert.match(openAiMetadata, /default_prompt: "Use \$game-scaffold/);
  assert.match(openAiMetadata, /allow_implicit_invocation: true/);
});

test('game-scaffold Skill references preserve the mandatory game workflow', async () => {
  const [core, newGame, existing, verification] = await Promise.all([
    readSkillFile('references/core-contract.md'),
    readSkillFile('references/new-game.md'),
    readSkillFile('references/existing-and-platform.md'),
    readSkillFile('references/verification.md'),
  ]);
  const policy = [core, newGame, existing, verification].join('\n');

  assert.match(
    newGame,
    /first implementation write[\s\S]{0,220}npm run game:create -- --id <lowercase-kebab-id> --name "<Display Name>"/,
  );
  assert.match(newGame, /Do not hand-create a game directory/);
  assert.match(newGame, /Do not copy `src\/apps\/space-game`/);
  assert.match(existing, /Never delete an existing game and regenerate it/);
  assert.match(existing, /Audit the existing game against the current generated template before implementation/);
  assert.match(
    existing,
    /public platform or template contract changes[\s\S]{0,260}generating a unique temporary game[\s\S]{0,260}precisely cleaning it up/,
  );
  assert.match(core, /DOM, Canvas2D, or another renderer may replace the render layer/);
  assert.match(core, /retaining the generated domain\/runtime\/web\/testkit boundaries/);
  assert.match(core, /independent `requestAnimationFrame`, second simulation clock/);
  assert.match(core, /incompatible `window\.advanceTime` or `window\.render_game_to_text`/);

  for (const requiredReference of [
    'game-platform/runtime',
    'game-platform/web',
    'game-platform/r3f',
    'game-platform/testkit',
    'game-platform/agent',
    'develop-web-game',
    'window.advanceTime',
    'window.render_game_to_text',
    'npm run typecheck',
    'npm test',
    'npm run build',
    'progress.md',
  ]) {
    assert.ok(policy.includes(requiredReference), `Skill policy must retain ${requiredReference}`);
  }

  assert.match(verification, /Before bypassing the platform[\s\S]{0,600}receive explicit user approval/);
  assert.match(verification, /npm run typecheck\r?\nnpm test\r?\nnpm run build/);
  assert.match(verification, /The task is incomplete while any required evidence/);
  assert.match(core, /AGAP v1 descriptor/);
  assert.match(core, /single-player games/);
  assert.match(core, /action parity:[\s\S]{0,240}same serializable action union[\s\S]{0,240}reducer\/validator/);
  assert.match(core, /Agent[\s\S]{0,180}unauthenticated `window` automation bridge/);
  assert.match(newGame, /generated `<Game>AgentAdapter\.ts` wired to the application/);
  assert.match(existing, /every human-visible decision and control[\s\S]{0,220}AGAP action/);
  assert.match(verification, /human\/Agent parity through bound `ParticipantPort` instances/);
});
