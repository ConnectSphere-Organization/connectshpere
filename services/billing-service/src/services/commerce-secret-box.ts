import crypto from 'crypto';

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer {
  const key = process.env.COMMERCE_SETTINGS_ENCRYPTION_KEY || process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('COMMERCE_SETTINGS_ENCRYPTION_KEY must be configured before saving payment credentials');
  }
  return crypto.scryptSync(key, 'connectsphere-commerce-secrets', 32);
}

export function encryptCommerceSecret(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith(PREFIX)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptCommerceSecret(value?: string | null): string | undefined {
  if (!value) return undefined;
  // Legacy plaintext values remain readable so existing workspaces can be migrated on their next save.
  if (!value.startsWith(PREFIX)) return value;

  const [ivHex, tagHex, encryptedHex] = value.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || !encryptedHex) throw new Error('Invalid encrypted commerce credential');

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}
