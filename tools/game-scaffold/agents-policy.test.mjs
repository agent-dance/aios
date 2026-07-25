import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');

test('root AGENTS.md enforces the shared game scaffold workflow', async () => {
  const policy = await readFile(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');

  assert.match(policy, /本文件作用于整个仓库/);
  assert.match(
    policy,
    /npm run game:create -- --id <lowercase-kebab-id> --name "<Display Name>"/,
  );
  assert.match(policy, /新游戏的第一项写操作必须/);
  assert.match(
    policy,
    /新游戏的第一项写操作必须[\s\S]{0,300}npm run game:create -- --id <lowercase-kebab-id> --name "<Display Name>"/,
  );
  assert.match(policy, /必须直接以生成的 `src\/apps\/<id>` 为实现起点/);
  assert.match(policy, /禁止先手工创建游戏目录/);
  assert.match(policy, /禁止复制 `src\/apps\/space-game`/);
  assert.match(policy, /迁移或重构既有游戏时，禁止删除原目录后重生成/);
  assert.match(
    policy,
    /迁移或重构既有游戏时，禁止删除原目录后重生成[\s\S]{0,500}必须先审计其与生成模板的差异/,
  );
  assert.match(
    policy,
    /公共契约发生变化时[\s\S]{0,300}实际生成一个唯一临时游戏[\s\S]{0,300}精确清理/,
  );
  assert.match(policy, /DOM、Canvas2D 或其他渲染器可以替换渲染层/);
  assert.match(
    policy,
    /DOM、Canvas2D 或其他渲染器可以替换渲染层[\s\S]{0,300}必须保留生成器建立的 domain\/runtime\/web\/testkit 边界/,
  );
  assert.match(policy, /未经下述例外流程批准，禁止/);
  assert.match(policy, /添加独立 `requestAnimationFrame`、第二个模拟时钟或并行模拟循环/);
  assert.match(policy, /自行安装不兼容的 `window\.advanceTime` 或 `window\.render_game_to_text`/);
  assert.match(
    policy,
    /必须在旁路基座之前[\s\S]{0,500}请求并获得用户明确批准/,
  );
  assert.match(policy, /npm run typecheck\r?\nnpm test\r?\nnpm run build/);

  for (const requiredReference of [
    'docs/games/README.md',
    'docs/games/template-contract.md',
    'game-platform/runtime',
    'game-platform/web',
    'game-platform/r3f',
    'game-platform/testkit',
    'develop-web-game',
    'window.advanceTime',
    'window.render_game_to_text',
    'npm run typecheck',
    'npm test',
    'npm run build',
  ]) {
    assert.ok(policy.includes(requiredReference), `AGENTS.md must retain ${requiredReference}`);
  }

  assert.match(policy, /请求并获得用户明确批准/);
  assert.match(policy, /不得默许或事后补报例外/);
  assert.match(policy, /任务不视为完成/);
});
