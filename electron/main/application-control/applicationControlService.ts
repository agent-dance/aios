import type {
  ApplicationActionCapability,
  ApplicationControlReceipt,
} from '../../shared/applicationControlProtocol.js';

export interface ApplicationControlService {
  listCapabilities(): readonly ApplicationActionCapability[];
  execute(candidate: unknown): Promise<ApplicationControlReceipt>;
  getReceipt(candidate: unknown): ApplicationControlReceipt | null;
  close(): Promise<void>;
}
