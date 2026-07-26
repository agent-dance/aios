import { describe, expect, it, vi } from 'vitest';
import {
  readVoiceDisclosureConsent,
  VOICE_DISCLOSURE_STORAGE_KEY,
  writeVoiceDisclosureConsent,
} from './voiceDisclosure';

describe('voice disclosure consent storage', () => {
  it('stores only the explicit decision and never any audio or transcript data', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeVoiceDisclosureConsent(storage, 'accepted');

    expect([...values.entries()]).toEqual([[VOICE_DISCLOSURE_STORAGE_KEY, 'accepted']]);
    expect(readVoiceDisclosureConsent(storage)).toBe('accepted');
  });

  it('fails closed when storage is unavailable or contains an unknown value', () => {
    expect(readVoiceDisclosureConsent()).toBe('unknown');
    expect(readVoiceDisclosureConsent({ getItem: () => 'transcript', setItem: vi.fn() })).toBe(
      'unknown',
    );
    expect(
      readVoiceDisclosureConsent({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: vi.fn(),
      }),
    ).toBe('unknown');
  });
});
