import { describe, expect, it, vi } from 'vitest';
import {
  AIOS_AGENT_DEBUG_PROFILE,
  AIOS_AGENT_PROTOCOL_VERSION,
  type AgentDebugFramePayload,
  type ChatRequest,
  type GameDecisionRequest,
} from './protocol';
import {
  canonicalAgentDebugFrame,
  canonicalSidecarRequest,
  canonicalSidecarResponse,
  createSidecarClient,
  SidecarClientError,
  validateGameDecisionRequest,
} from './sidecarClient';

const SECRET = 'x'.repeat(32);
const encoder = new TextEncoder();
const hex = (value: Uint8Array) => [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const signature = async (canonical: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
};
const signedResponse = async (
  init: RequestInit | undefined,
  body: unknown,
  status = 200,
  options: { protocol?: string; requestId?: string; tamperBody?: boolean; tamperSignature?: boolean } = {},
) => {
  const json = JSON.stringify(body);
  const bodyHash = await digest(json);
  const requestHeaders = new Headers(init?.headers);
  const nonce = requestHeaders.get('x-aios-nonce') ?? '';
  const protocol = options.protocol ?? AIOS_AGENT_PROTOCOL_VERSION;
  const requestId = options.requestId ?? 'request-1';
  const canonical = canonicalSidecarResponse(nonce, requestId, status, bodyHash, protocol);
  const responseSignature = await signature(canonical);
  return new Response(options.tamperBody ? `${json} ` : json, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-AIOS-Protocol-Version': protocol,
      'X-Request-Id': requestId,
      'X-AIOS-Request-Nonce': nonce,
      'X-AIOS-Content-SHA256': bodyHash,
      'X-AIOS-Signature': options.tamperSignature ? '0'.repeat(64) : responseSignature,
    },
  });
};
const respond = (body: unknown, status = 200, options?: Parameters<typeof signedResponse>[3]): typeof fetch =>
  async (_input, init) => signedResponse(init, body, status, options);
const config = (fetcher: typeof fetch) => ({
  baseUrl: 'http://127.0.0.1:43127',
  token: SECRET,
  origin: 'http://localhost:5173',
  getOrigin: () => 'http://localhost:5173',
  fetch: fetcher,
});

const base64Url = (value: Uint8Array): string => {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const debugStreamResponse = async (
  init: RequestInit | undefined,
  payloads: readonly AgentDebugFramePayload[],
  options: { tamperFrame?: number; omitTerminalNewline?: boolean; sequenceOffset?: number } = {},
): Promise<Response> => {
  const requestHeaders = new Headers(init?.headers);
  const nonce = requestHeaders.get('x-aios-nonce') ?? '';
  const requestId = 'transport-debug-1';
  let previousMac = '0'.repeat(64);
  const lines: string[] = [];
  for (let index = 0; index < payloads.length; index += 1) {
    const sequence = index + 1 + (options.sequenceOffset ?? 0);
    const bytes = encoder.encode(JSON.stringify(payloads[index]));
    const payloadHash = await digest(decoderForTest(bytes));
    let mac = await signature(canonicalAgentDebugFrame(
      nonce,
      requestId,
      'http://127.0.0.1:43127',
      'POST',
      '/v1/chat/trace',
      200,
      AIOS_AGENT_DEBUG_PROFILE,
      sequence,
      previousMac,
      payloadHash,
      AIOS_AGENT_PROTOCOL_VERSION,
    ));
    if (options.tamperFrame === index) mac = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
    lines.push(`${sequence}.${base64Url(bytes)}.${mac}`);
    previousMac = mac;
  }
  const body = `${lines.join('\n')}${options.omitTerminalNewline ? '' : '\n'}`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'X-AIOS-Protocol-Version': AIOS_AGENT_PROTOCOL_VERSION,
      'X-Request-Id': requestId,
      'X-AIOS-Request-Nonce': nonce,
      'X-AIOS-Stream-Profile': AIOS_AGENT_DEBUG_PROFILE,
    },
  });
};

const decoderForTest = (value: Uint8Array): string => new TextDecoder().decode(value);

const request: ChatRequest = {
  requestId: 'request-1',
  threadId: 'thread-1',
  message: 'Open Finder',
  history: [{ role: 'user', content: 'Continue our previous task.' }, { role: 'assistant', content: 'Ready.' }],
  context: { osRevision: 7, activeAppId: 'settings', theme: 'aurora' },
};

const gameRequest: GameDecisionRequest = {
  requestId: 'game-request-1',
  gameId: 'cards.game',
  gameVersion: '1.0.0',
  matchId: 'match-1',
  seatId: 'seat-a',
  observation: {
    revision: 4,
    terminal: false,
    decision: { mode: 'sequential', phase: 'play', activeSeatIds: ['seat-a'], turnNonce: 'turn-4' },
    observation: { handCount: 5 },
  },
  legalActions: [
    { id: 'action-1', label: 'Play', action: { type: 'play' } },
    { id: 'action-2', label: 'Pass', action: { type: 'pass' } },
  ],
};

describe('sidecar client', () => {
  it('matches the language-neutral HMAC canonical golden vectors', async () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sign = async (canonical: string) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
    const bodyHash = await digest('{"x":1}');
    expect(bodyHash).toBe('5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22');
    expect(await sign(canonicalSidecarRequest(
      'POST', 'http://127.0.0.1:4317', '/v1/chat', 'http://localhost:5173', '1.0.0', '1785038400000',
      '00112233445566778899aabbccddeeff', bodyHash,
    ))).toBe('133421e29d48491b58086f2803475f112d8cf54ce74475c6fd8acd872ff1f9cb');
    const responseHash = await digest('{"ok":true}\n');
    expect(responseHash).toBe('e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726');
    expect(await sign(canonicalSidecarResponse(
      '00112233445566778899aabbccddeeff', 'request-vector-1', 200, responseHash, '1.0.0',
    ))).toBe('f985b14e6fb5979010fd90770e22ec984160048f7f27a9abe70c2028925b6817');
    expect(await sign(canonicalAgentDebugFrame(
      '00112233445566778899aabbccddeeff',
      'request-vector-1',
      'http://127.0.0.1:4317',
      'POST',
      '/v1/chat/trace',
      200,
      'agent-debug.v1',
      1,
      '0'.repeat(64),
      '15b3f7b8244fc365b0fc382807379d9fc1c1ece1b73336dce4c69af89c7d14cb',
      '1.0.0',
    ))).toBe('229288c01c8047188ec52c03d5fd91ba947cbeb92f43e846944c67ee57b9d73f');
  });

  it('sends per-request HMAC metadata without disclosing the shared secret and accepts an authenticated chat response', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const requestHeaders = new Headers(init?.headers);
      expect(requestHeaders.get('authorization')).toBeNull();
      expect([...requestHeaders.values()]).not.toContain(SECRET);
      expect(requestHeaders.get('x-aios-protocol-version')).toBe(AIOS_AGENT_PROTOCOL_VERSION);
      expect(requestHeaders.get('x-aios-nonce')).toMatch(/^[0-9a-f]{32}$/);
      expect(requestHeaders.get('x-aios-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
      expect(requestHeaders.get('x-aios-signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      const requestBody = String(init?.body);
      expect((JSON.parse(requestBody) as ChatRequest).history).toEqual(request.history);
      const bodyHash = await digest(requestBody);
      expect(requestHeaders.get('x-aios-content-sha256')).toBe(bodyHash);
      expect(requestHeaders.get('x-aios-signature')).toBe(await signature(canonicalSidecarRequest(
        'POST', 'http://127.0.0.1:43127', '/v1/chat', 'http://localhost:5173', AIOS_AGENT_PROTOCOL_VERSION,
        requestHeaders.get('x-aios-timestamp') ?? '', requestHeaders.get('x-aios-nonce') ?? '', bodyHash,
      )));
      return signedResponse(init, {
        requestId: 'request-1', runId: 'run-1', message: 'Opening Finder.', mood: 'helpful',
        intents: [{ id: 'intent-1', type: 'open_app', appId: 'finder' }],
        surface: { version: '1.0', id: 'surface-1', components: [{ id: 'button-1', type: 'button', label: 'Open', intentId: 'intent-1' }] },
      });
    });
    const result = await createSidecarClient(config(fetcher)).chat(request);
    expect(result.intents[0]?.type).toBe('open_app');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('authenticates every debug frame before delivering live summary events', async () => {
    const traceId = 'trace-1';
    const completedResponse = {
      requestId: request.requestId,
      runId: 'run-debug-1',
      message: 'Opening Finder.',
      mood: 'helpful' as const,
      intents: [{ id: 'intent-debug-1', type: 'open_app' as const, appId: 'finder' }],
    };
    const payloads: readonly AgentDebugFramePayload[] = [
      {
        kind: 'trace', traceId, timeUnixMs: 1_785_038_400_000, source: 'sidecar', stage: 'analysis',
        status: 'started', title: '正在分析请求', detail: '正在生成受约束的结构化响应。', elapsedMs: 4,
      },
      { kind: 'completed', traceId, timeUnixMs: 1_785_038_400_100, response: completedResponse },
    ];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:43127/v1/chat/trace');
      const sent = JSON.parse(String(init?.body)) as { profile: string; request: Record<string, unknown> };
      expect(sent.profile).toBe(AIOS_AGENT_DEBUG_PROFILE);
      expect(sent.request.debug).toBeUndefined();
      expect(new Headers(init?.headers).get('accept')).toBe('application/x-ndjson');
      return debugStreamResponse(init, payloads);
    });
    const observer = vi.fn();
    const client = createSidecarClient(config(fetcher));
    const response = await client.chat(
      { ...request, debug: { profile: AIOS_AGENT_DEBUG_PROFILE } },
      { onDebugEvent: observer },
    );
    expect(response).toEqual(completedResponse);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1, traceId, stage: 'analysis' }));
  });

  it('fails closed on debug-frame tampering, sequence gaps, and truncated terminal frames', async () => {
    const payloads: readonly AgentDebugFramePayload[] = [
      {
        kind: 'trace', traceId: 'trace-secure', timeUnixMs: 1, source: 'sidecar', stage: 'request',
        status: 'started', title: 'Request accepted', elapsedMs: 0,
      },
      {
        kind: 'completed', traceId: 'trace-secure', timeUnixMs: 2,
        response: { requestId: request.requestId, runId: 'run-secure', message: 'ok', mood: 'neutral', intents: [] },
      },
    ];
    const debugRequest: ChatRequest = { ...request, debug: { profile: AIOS_AGENT_DEBUG_PROFILE } };
    const tampered = createSidecarClient(config(async (_input, init) => debugStreamResponse(init, payloads, { tamperFrame: 0 })));
    await expect(tampered.chat(debugRequest)).rejects.toMatchObject({ code: 'SIDECAR_RESPONSE_AUTH_FAILED' });

    const skipped = createSidecarClient(config(async (_input, init) => debugStreamResponse(init, payloads, { sequenceOffset: 1 })));
    await expect(skipped.chat(debugRequest)).rejects.toMatchObject({ code: 'SIDECAR_RESPONSE_AUTH_FAILED' });

    const truncated = createSidecarClient(config(async (_input, init) => debugStreamResponse(init, payloads, { omitTerminalNewline: true })));
    await expect(truncated.chat(debugRequest)).rejects.toMatchObject({ code: 'SIDECAR_INVALID_RESPONSE' });
  });

  it('surfaces only authenticated terminal failures and isolates a rejecting observer', async () => {
    const debugRequest: ChatRequest = { ...request, debug: { profile: AIOS_AGENT_DEBUG_PROFILE } };
    const failurePayloads: readonly AgentDebugFramePayload[] = [{
      kind: 'failed',
      traceId: 'trace-failed',
      timeUnixMs: 1,
      error: { code: 'AGENT_TIMEOUT', message: 'The Agent did not finish before the deadline.', retryable: true },
    }];
    const failed = createSidecarClient(config(async (_input, init) => debugStreamResponse(init, failurePayloads)));
    await expect(failed.chat(debugRequest)).rejects.toMatchObject({
      code: 'SIDECAR_HTTP_ERROR', remoteCode: 'AGENT_TIMEOUT', retryable: true,
    });

    const tracePayloads: readonly AgentDebugFramePayload[] = [
      {
        kind: 'trace', traceId: 'trace-observer', timeUnixMs: 1, source: 'sidecar', stage: 'analysis',
        status: 'started', title: 'Model execution started', elapsedMs: 0,
      },
      {
        kind: 'completed', traceId: 'trace-observer', timeUnixMs: 2,
        response: { requestId: request.requestId, runId: 'run-observer', message: 'ok', mood: 'neutral', intents: [] },
      },
    ];
    const observerClient = createSidecarClient(config(async (_input, init) => debugStreamResponse(init, tracePayloads)));
    await expect(observerClient.chat(debugRequest, { onDebugEvent: () => { throw new Error('closed consumer'); } }))
      .rejects.toMatchObject({ code: 'SIDECAR_DEBUG_OBSERVER_FAILED' });
  });

  it('rejects unknown response fields, request-id mismatch, and protocol mismatch', async () => {
    const unknown = createSidecarClient(config(respond({
      requestId: 'request-1', runId: 'run-1', message: 'ok', mood: 'neutral', intents: [], debug: 'secret',
    })));
    await expect(unknown.chat(request)).rejects.toMatchObject({ code: 'SIDECAR_INVALID_RESPONSE' });

    const mismatch = createSidecarClient(config(respond({
      requestId: 'other', runId: 'run-1', message: 'ok', mood: 'neutral', intents: [],
    })));
    await expect(mismatch.chat(request)).rejects.toMatchObject({ code: 'SIDECAR_INVALID_RESPONSE' });

    const protocol = createSidecarClient(config(respond({}, 200, { protocol: '2.0.0' })));
    await expect(protocol.health()).rejects.toMatchObject({ code: 'SIDECAR_PROTOCOL_MISMATCH' });
  });

  it('preserves stable remote errors without trusting extra fields', async () => {
    const client = createSidecarClient(config(respond({
      error: { code: 'BUSY', message: 'At capacity.', requestId: 'request-1', retryable: true },
    }, 429, { requestId: 'transport-1' })));
    await expect(client.chat(request)).rejects.toMatchObject({
      code: 'SIDECAR_HTTP_ERROR', remoteCode: 'BUSY', status: 429, retryable: true, requestId: 'request-1',
    });
  });

  it('distinguishes caller cancellation from timeout and never sends across another origin', async () => {
    const pending: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const client = createSidecarClient({ ...config(pending), timeoutMs: 100 });
    await expect(client.health()).rejects.toMatchObject({ code: 'SIDECAR_TIMEOUT', retryable: true });

    const controller = new AbortController();
    const cancelled = client.health({ signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'SIDECAR_ABORTED' });

    const wrongOrigin = createSidecarClient({ ...config(vi.fn()), getOrigin: () => 'https://evil.test' });
    await expect(wrongOrigin.health()).rejects.toBeInstanceOf(SidecarClientError);
  });

  it('preserves timeout semantics while a response body is still streaming', async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const metadata = await signedResponse(init, {});
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(stream, { status: metadata.status, headers: metadata.headers });
    };
    const client = createSidecarClient({ ...config(fetcher), timeoutMs: 100 });
    await expect(client.health()).rejects.toMatchObject({ code: 'SIDECAR_TIMEOUT', retryable: true });
  });

  it('validates the least-privilege health disclosure', async () => {
    const client = createSidecarClient(config(respond({
      protocolVersion: '1.0.0', status: 'ready',
      agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
      limits: { maxBodyBytes: 100_000, maxConcurrentRuns: 4 },
      checks: [{ code: 'codex.auth', status: 'pass', message: 'available' }],
    })));
    expect((await client.health()).status).toBe('ready');
  });

  it('rejects a forged ready response and authenticated-body tampering before schema parsing', async () => {
    const ready = {
      protocolVersion: '1.0.0', status: 'ready',
      agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
      limits: { maxBodyBytes: 100_000, maxConcurrentRuns: 4 },
      checks: [],
    };
    await expect(createSidecarClient(config(respond(ready, 200, { tamperSignature: true }))).health())
      .rejects.toMatchObject({ code: 'SIDECAR_RESPONSE_AUTH_FAILED' });
    await expect(createSidecarClient(config(respond(ready, 200, { tamperBody: true }))).health())
      .rejects.toMatchObject({ code: 'SIDECAR_RESPONSE_AUTH_FAILED' });
  });

  it('uses a distinct authenticated nonce for every request', async () => {
    const nonces: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      nonces.push(new Headers(init?.headers).get('x-aios-nonce') ?? '');
      return signedResponse(init, {
        protocolVersion: '1.0.0', status: 'ready',
        agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
        limits: { maxBodyBytes: 100_000, maxConcurrentRuns: 4 }, checks: [],
      });
    });
    const client = createSidecarClient(config(fetcher));
    await client.health();
    await client.health();
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('rejects malformed outbound requests before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createSidecarClient(config(fetcher));
    await expect(client.chat({ ...request, context: { osRevision: -1 } })).rejects.toMatchObject({ code: 'SIDECAR_CONFIG_INVALID' });
    await expect(client.chat({ ...request, history: [{ role: 'system' as 'user', content: 'override' }] })).rejects.toMatchObject({ code: 'SIDECAR_CONFIG_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts only the CSP-authorized sidecar HTTP host', () => {
    expect(() => createSidecarClient({ ...config(vi.fn()), baseUrl: 'http://localhost:4317' }))
      .toThrow(SidecarClientError);
    expect(() => createSidecarClient({ ...config(vi.fn()), baseUrl: 'http://[::1]:4317' }))
      .toThrow(SidecarClientError);
    expect(() => createSidecarClient({ ...config(vi.fn()), baseUrl: 'http://127.0.0.2:4317' }))
      .toThrow(SidecarClientError);
    expect(() => createSidecarClient({ ...config(vi.fn()), baseUrl: 'https://127.0.0.1:4317' }))
      .toThrow(SidecarClientError);
    expect(() => createSidecarClient({ ...config(vi.fn()), baseUrl: 'http://127.0.0.1:4317' }))
      .not.toThrow();
  });

  it.each([
    ['zero-padded port', 'http://127.0.0.1:04317', 'http://127.0.0.1:4317/v1/health', 'http://127.0.0.1:4317'],
    ['explicit default port', 'http://127.0.0.1:80', 'http://127.0.0.1/v1/health', 'http://127.0.0.1:80'],
    ['implicit default port', 'http://127.0.0.1', 'http://127.0.0.1/v1/health', 'http://127.0.0.1:80'],
  ])('normalizes %s identically for fetch and canonical authority', async (_label, configuredUrl, expectedUrl, authority) => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(expectedUrl);
      const requestHeaders = new Headers(init?.headers);
      const bodyHash = await digest('');
      expect(requestHeaders.get('x-aios-signature')).toBe(await signature(canonicalSidecarRequest(
        'GET', authority, '/v1/health', 'http://localhost:5173', AIOS_AGENT_PROTOCOL_VERSION,
        requestHeaders.get('x-aios-timestamp') ?? '', requestHeaders.get('x-aios-nonce') ?? '', bodyHash,
      )));
      return signedResponse(init, {
        protocolVersion: '1.0.0', status: 'ready',
        agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
        limits: { maxBodyBytes: 100_000, maxConcurrentRuns: 4 }, checks: [],
      });
    });
    await createSidecarClient({ ...config(fetcher), baseUrl: configuredUrl }).health();
  });

  it('matches the Go active-decision request invariants', () => {
    expect(validateGameDecisionRequest(gameRequest)).toEqual(gameRequest);
    expect(() => validateGameDecisionRequest({
      ...gameRequest,
      observation: { ...gameRequest.observation, terminal: true },
    })).toThrow(/terminal observations/);
    expect(() => validateGameDecisionRequest({
      ...gameRequest,
      observation: {
        ...gameRequest.observation,
        decision: { ...gameRequest.observation.decision, activeSeatIds: ['seat-b'] },
      },
    })).toThrow(/request seat must be active/);
    expect(() => validateGameDecisionRequest({
      ...gameRequest,
      legalActions: [gameRequest.legalActions[0], { ...gameRequest.legalActions[1]!, id: 'action-1' }],
    })).toThrow(/duplicate action id/);
  });

  it('projects strict system and enabled Agent context and binds activeAgentId to that context', async () => {
    const contextualRequest: ChatRequest = {
      ...request,
      context: {
        ...request.context,
        systemStatus: {
          wifiEnabled: true,
          wifiLabel: 'AlSniper Mesh',
          bluetoothEnabled: false,
          bluetoothLabel: 'Orbital Link',
          healthScore: 98,
          storageUsedGb: 612,
          storageTotalGb: 1024,
          energyMode: 'Balanced',
          brightness: 72,
          volume: 38,
        },
        runningGameIds: ['space-game'],
        enabledAgents: [{
          id: 'local.productivity',
          name: 'Productivity',
          description: 'Helps with focused work.',
          instructions: 'Route focus-related requests through this domain Agent.',
          capabilities: ['os.app.open'],
          contributions: ['domain-agent'],
        }],
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as ChatRequest;
      expect(sent.context.systemStatus?.brightness).toBe(72);
      expect(sent.context.runningGameIds).toEqual(['space-game']);
      expect(sent.context.enabledAgents?.[0]?.instructions).toContain('focus-related');
      return signedResponse(init, {
        requestId: request.requestId,
        runId: 'run-domain',
        message: 'Opening settings.',
        mood: 'helpful',
        activeAgentId: 'local.productivity',
        intents: [{ id: 'domain-open', type: 'open_app', appId: 'settings' }],
      });
    });
    expect((await createSidecarClient(config(fetcher)).chat(contextualRequest)).activeAgentId).toBe('local.productivity');

    const unknownSelection = createSidecarClient(config(respond({
      requestId: request.requestId,
      runId: 'run-unknown-domain',
      message: 'No.',
      mood: 'concerned',
      activeAgentId: 'local.not-enabled',
      intents: [],
    })));
    await expect(unknownSelection.chat(contextualRequest)).rejects.toMatchObject({ code: 'SIDECAR_INVALID_RESPONSE' });
  });

  it('rejects read-only telemetry in a system status write intent', async () => {
    const client = createSidecarClient(config(respond({
      requestId: request.requestId,
      runId: 'run-forged-health',
      message: 'Changed.',
      mood: 'helpful',
      intents: [{ id: 'forge-health', type: 'set_system_status', statusPatch: { healthScore: 100 } }],
    })));
    await expect(client.chat(request)).rejects.toMatchObject({ code: 'SIDECAR_INVALID_RESPONSE' });
  });

  it('rejects negative storage telemetry before sending context', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createSidecarClient(config(fetcher));
    await expect(client.chat({
      ...request,
      context: {
        osRevision: 0,
        systemStatus: {
          wifiEnabled: true,
          wifiLabel: 'Mesh',
          bluetoothEnabled: true,
          bluetoothLabel: 'Link',
          healthScore: 98,
          storageUsedGb: -1,
          storageTotalGb: 1024,
          energyMode: 'Balanced',
          brightness: 50,
          volume: 50,
        },
      },
    })).rejects.toMatchObject({ code: 'SIDECAR_CONFIG_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['fractional health score', { healthScore: 98.5 }],
    ['health score above 100', { healthScore: 101 }],
    ['non-positive storage total', { storageTotalGb: 0 }],
    ['used storage above total', { storageUsedGb: 1025 }],
    ['fractional brightness', { brightness: 50.5 }],
    ['brightness above 100', { brightness: 101 }],
    ['negative volume', { volume: -1 }],
  ])('rejects %s at the outbound system context boundary', async (_label, statusPatch) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createSidecarClient(config(fetcher));
    const validStatus = {
      wifiEnabled: true,
      wifiLabel: 'Mesh',
      bluetoothEnabled: true,
      bluetoothLabel: 'Link',
      healthScore: 98,
      storageUsedGb: 612,
      storageTotalGb: 1024,
      energyMode: 'Balanced' as const,
      brightness: 50,
      volume: 50,
    };
    await expect(client.chat({
      ...request,
      context: { osRevision: 0, systemStatus: { ...validStatus, ...statusPatch } },
    } as ChatRequest)).rejects.toMatchObject({ code: 'SIDECAR_CONFIG_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
