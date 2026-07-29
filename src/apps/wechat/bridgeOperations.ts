import type { WeChatEmbeddedViewBridge } from './bridge';

// Operations must stay ordered across React StrictMode's development
// mount -> unmount -> mount probe. Weak keys avoid retaining a closed window's
// preload bridge.
const queues = new WeakMap<WeChatEmbeddedViewBridge, Promise<void>>();

export function enqueueWeChatBridgeOperation<T>(
  bridge: WeChatEmbeddedViewBridge,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(bridge) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  queues.set(bridge, result.then(() => undefined, () => undefined));
  return result;
}
