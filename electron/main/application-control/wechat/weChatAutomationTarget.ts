/**
 * A narrowly scoped lease over the currently attested Web WeChat document.
 *
 * The adapter deliberately receives neither WebContents nor arbitrary CDP/JS
 * facilities. It can invoke only the fixed semantic operations below; their
 * scripts and selectors are compiled inside the controller-owned boundary.
 */
export interface WeChatAutomationBinding {
  readonly controllerGeneration: number;
  readonly documentSequence: number;
  readonly origin: string;
}

export interface WeChatAutomationTarget {
  readonly binding: WeChatAutomationBinding;
  isCurrent(): boolean;
  prepareMessage(input: WeChatMessageRuntimePrepareInput): Promise<unknown>;
  commitMessage(input: WeChatMessageRuntimeCommitInput): Promise<unknown>;
}

export type WeChatAutomationTargetProvider = () => WeChatAutomationTarget | null;
import type {
  WeChatMessageRuntimeCommitInput,
  WeChatMessageRuntimePrepareInput,
} from './weChatMessageRuntime.js';
