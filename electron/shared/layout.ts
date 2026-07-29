import type { WeChatBounds } from './wechatProtocol.js';

export interface ContentSize {
  readonly width: number;
  readonly height: number;
}

export function fitBoundsToContent(requested: WeChatBounds, content: ContentSize): WeChatBounds | null {
  if (
    !Number.isInteger(content.width)
    || !Number.isInteger(content.height)
    || content.width <= 0
    || content.height <= 0
  ) {
    return null;
  }

  const x = Math.min(requested.x, content.width - 1);
  const y = Math.min(requested.y, content.height - 1);

  return Object.freeze({
    x,
    y,
    width: Math.min(requested.width, content.width - x),
    height: Math.min(requested.height, content.height - y),
  });
}
