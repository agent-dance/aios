import { APP_IDS } from '../system/appRegistry';
import type { AppId, AppInstallation } from '../system/types';
import type { DesktopIconDefinition } from './shellTypes';

export function getDefaultDesktopIcons(
  appInstallations: Partial<Record<AppId, AppInstallation>>,
): DesktopIconDefinition[] {
  return APP_IDS
    .filter((appId) => appInstallations[appId]?.enabled === true)
    .map((appId) => ({ appId }));
}
