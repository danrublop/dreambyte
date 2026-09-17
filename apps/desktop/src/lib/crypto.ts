import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return buf
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing IV + ciphertext + auth tag.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: IV (12 bytes) + tag (16 bytes) + ciphertext
  const combined = Buffer.concat([iv, tag, encrypted])
  return combined.toString('base64')
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 */
export function decrypt(encryptedBase64: string): string {
  const key = getEncryptionKey()
  const combined = Buffer.from(encryptedBase64, 'base64')

  if (combined.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short')
  }

  const iv = combined.subarray(0, IV_LENGTH)
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Check if ENCRYPTION_KEY is configured (without throwing).
 */
export function isEncryptionConfigured(): boolean {
  const key = process.env.ENCRYPTION_KEY
  if (!key) return false
  try {
    const buf = Buffer.from(key, 'hex')
    return buf.length === 32
  } catch {
    return false
  }
}

// ── Password hashing (scrypt) ──────────────────────────────────────────────

const SCRYPT_KEYLEN = 64
const SALT_LENGTH = 16

/**
 * Hash a password using scrypt. Returns "salt:hash" in hex.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * Verify a password against a "salt:hash" string.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const storedHash = Buffer.from(hashHex, 'hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)

  if (derived.length !== storedHash.length) return false
  return timingSafeEqual(derived, storedHash)
}
