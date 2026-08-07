import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret, sha256 } from '../utils/crypto';

describe('crypto edge cases', () => {
  it('encrypts and decrypts empty string returns empty', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('roundtrips unicode content', () => {
    const plain = '密钥-日本語-🔑-test';
    const encrypted = encryptSecret(plain);
    expect(encrypted).not.toBe(plain);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encryptSecret('same-secret');
    const b = encryptSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('secret');
    const parts = encrypted.split('.');
    const tampered = [parts[0], parts[1].replace(/.$/, 'x'), parts[2]].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects malformed format', () => {
    expect(() => decryptSecret('not-a-valid-format')).toThrow();
  });

  it('masks short secrets fully', () => {
    expect(maskSecret('short')).toBe('********');
  });

  it('masks null/undefined', () => {
    expect(maskSecret(null)).toBe('');
    expect(maskSecret(undefined)).toBe('');
  });

  it('sha256 produces consistent hex', () => {
    expect(sha256('test')).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  });
});
