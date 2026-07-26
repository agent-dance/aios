export type VoiceDisclosureConsent = 'unknown' | 'accepted' | 'declined';

export const VOICE_DISCLOSURE_STORAGE_KEY = 'alsniper.voice-disclosure.v1';

interface DisclosureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const readVoiceDisclosureConsent = (
  storage?: DisclosureStorage,
): VoiceDisclosureConsent => {
  if (!storage) return 'unknown';
  try {
    const stored = storage.getItem(VOICE_DISCLOSURE_STORAGE_KEY);
    return stored === 'accepted' || stored === 'declined' ? stored : 'unknown';
  } catch {
    return 'unknown';
  }
};

export const writeVoiceDisclosureConsent = (
  storage: DisclosureStorage | undefined,
  consent: Exclude<VoiceDisclosureConsent, 'unknown'>,
) => {
  if (!storage) return;
  try {
    storage.setItem(VOICE_DISCLOSURE_STORAGE_KEY, consent);
  } catch {
    // Consent remains valid for this session when storage is unavailable.
  }
};
