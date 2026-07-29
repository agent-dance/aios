import type { AppId, AppInstallation, AppInstallationResult } from '../../system/types';

export type LocalApplicationState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'disabled'; readonly installation: AppInstallation }
  | { readonly kind: 'ready'; readonly installation: AppInstallation };

export type LocalApplicationTransition =
  | { readonly kind: 'installed'; readonly result: AppInstallationResult }
  | { readonly kind: 'enabled'; readonly result: AppInstallationResult }
  | { readonly kind: 'opened' };

export interface LocalApplicationCommands {
  readonly install: (appId: AppId) => AppInstallationResult;
  readonly enable: (appId: AppId) => AppInstallationResult;
  readonly open: (appId: AppId) => void;
}

export function getLocalApplicationState(
  installation: AppInstallation | undefined,
): LocalApplicationState {
  if (!installation) return { kind: 'missing' };
  if (!installation.enabled) return { kind: 'disabled', installation };
  return { kind: 'ready', installation };
}

export function runLocalApplicationPrimaryAction(
  appId: AppId,
  installation: AppInstallation | undefined,
  commands: LocalApplicationCommands,
): LocalApplicationTransition {
  const state = getLocalApplicationState(installation);

  switch (state.kind) {
    case 'missing':
      return { kind: 'installed', result: commands.install(appId) };
    case 'disabled':
      return { kind: 'enabled', result: commands.enable(appId) };
    case 'ready':
      commands.open(appId);
      return { kind: 'opened' };
  }
}
