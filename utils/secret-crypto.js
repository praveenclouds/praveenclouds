const crypto = require('crypto');
const { JWT_SECRET } = require('../config');

const ENCRYPT_KEY = String(
  process.env.ENCRYPT_KEY
  || process.env.SECRET_ENCRYPTION_KEY
  || JWT_SECRET
  || 'terzo_encrypt_fallback_dev'
);

function deriveKey(secret = '') {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function isEncryptedSecret(value = '') {
  return String(value || '').startsWith('enc:');
}

function encryptSecret(plaintext = '') {
  const raw = String(plaintext || '');
  if (!raw) return raw;
  if (isEncryptedSecret(raw)) return raw;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(ENCRYPT_KEY), iv);
  let encrypted = cipher.update(raw, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `enc:${iv.toString('hex')}:${encrypted}`;
}

function decryptSecret(stored = '') {
  const raw = String(stored || '');
  if (!raw) return '';
  if (!isEncryptedSecret(raw)) return raw;

  try {
    const [, ivHex, encrypted] = raw.split(':');
    if (!ivHex || !encrypted) return '';
    const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(ENCRYPT_KEY), Buffer.from(ivHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
};
