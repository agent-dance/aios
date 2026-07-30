import type { ApplicationAdapter } from './applicationAdapter.js';
import type { ApplicationControlService } from './applicationControlService.js';
import {
  ApplicationControlHost,
  type ApplicationControlHostLogger,
  type TrustedApplicationApprovalPort,
} from './ApplicationControlHost.js';
import { ApplicationEffectJournal } from './effectJournal.js';
import { UnavailableApplicationControlService } from './UnavailableApplicationControlService.js';

export async function createApplicationControlService(options: {
  readonly journalPath: string;
  readonly approval: TrustedApplicationApprovalPort;
  readonly adapters: readonly ApplicationAdapter[];
  readonly logger?: ApplicationControlHostLogger;
}): Promise<ApplicationControlService> {
  let host: ApplicationControlHost | null = null;
  try {
    host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(options.journalPath),
      approval: options.approval,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await host.initialize();
    for (const adapter of options.adapters) await host.registerAdapter(adapter);
    return host;
  } catch {
    if (host !== null) await host.close().catch(() => undefined);
    options.logger?.error('Application control is unavailable because its durable journal could not be verified.');
    return new UnavailableApplicationControlService();
  }
}
