const stableRemoteCode = (error: Error): string | undefined => {
  const value = (error as Error & { readonly remoteCode?: unknown }).remoteCode;
  return typeof value === 'string' ? value : undefined;
};

const stableRequestId = (error: Error): string | undefined => {
  const value = (error as Error & { readonly requestId?: unknown }).requestId;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
};

export const normalizeAssistantError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Agent 暂时无法响应，请稍后重试。';

  const remoteCode = stableRemoteCode(error);
  switch (remoteCode) {
    case 'AGENT_AUTH_REQUIRED':
      return 'Codex 认证已被拒绝。请运行 codex login，完成登录后直接重试；Runtime 会自动同步新凭据。';
    case 'INVALID_AGENT_OUTPUT':
      return 'Agent 返回的结果格式不正确，请重试。';
    case 'AGENT_TIMEOUT':
      return 'Agent 本次思考超时，请稍后重试。';
    case 'AGENT_UNAVAILABLE':
      return '本机 Codex Runtime 当前不可用，请检查 Sidecar 与 Codex CLI。';
    case 'BUSY':
      return 'Agent 当前任务较多，请稍后重试。';
    default: {
      if (remoteCode !== undefined) {
        const requestId = stableRequestId(error);
        return requestId === undefined
          ? 'Agent 暂时无法响应，请稍后重试。'
          : `Agent 暂时无法响应，请稍后重试。请求 ID：${requestId}`;
      }
      const message = error.message.trim();
      if (message) return message;
      return 'Agent 暂时无法响应，请稍后重试。';
    }
  }
};
