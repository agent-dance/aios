import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WECHAT_VIEW_ERROR_CODES,
  WECHAT_VIEW_PHASES,
} from '../../src/apps/wechat/bridge';
import {
  WECHAT_ERROR_CODES,
  WECHAT_PHASES,
  WECHAT_IPC_CHANNELS,
} from './wechatProtocol.js';

function extractQuotedValues(source: string, declaration: string): readonly string[] {
  const declarationPattern = new RegExp(
    `(?:const|type)\\s+${declaration}\\s*=\\s*(?:new Set<unknown>\\()?\\[([\\s\\S]*?)\\]`,
  );
  const match = declarationPattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`Unable to find ${declaration} in the preload source.`);
  }

  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function extractChannels(source: string): Readonly<Record<string, string>> {
  const match = /const CHANNELS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
  if (!match?.[1]) {
    throw new Error('Unable to find CHANNELS in the preload source.');
  }

  return Object.fromEntries(
    [...match[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((item) => [item[1], item[2]]),
  );
}

describe('WeChat bridge contract parity', () => {
  const preloadSource = readFileSync(
    fileURLToPath(new URL('../preload.cts', import.meta.url)),
    'utf8',
  );

  it('keeps renderer, preload, and main-process state values aligned', () => {
    expect(WECHAT_VIEW_PHASES).toEqual(WECHAT_PHASES);
    expect(WECHAT_VIEW_ERROR_CODES).toEqual(WECHAT_ERROR_CODES);
    expect(extractQuotedValues(preloadSource, 'PHASES')).toEqual(WECHAT_PHASES);
    expect(extractQuotedValues(preloadSource, 'ERROR_CODES')).toEqual(WECHAT_ERROR_CODES);
  });

  it('keeps preload and main-process IPC channels aligned', () => {
    expect(extractChannels(preloadSource)).toEqual(WECHAT_IPC_CHANNELS);
  });
});
