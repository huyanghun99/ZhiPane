import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret } from '../utils/crypto';

describe('secret encryption', () => {
  it('roundtrips an API key', () => {
    const encrypted = encryptSecret('sk-test-123456789');
    expect(encrypted).not.toContain('sk-test');
    expect(decryptSecret(encrypted)).toBe('sk-test-123456789');
  });

  it('masks secrets for UI', () => {
    expect(maskSecret('sk-1234567890')).toBe('sk-1...7890');
  });
});
