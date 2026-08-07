import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

function key(): Buffer {
  return createHash('sha256').update(env.APP_SECRET).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join('.');
}

export function decryptSecret(value: string): string {
  if (!value) return '';
  const [ivB64, ciphertextB64, tagB64] = value.split('.');
  if (!ivB64 || !ciphertextB64 || !tagB64) throw new Error('Invalid encrypted secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
