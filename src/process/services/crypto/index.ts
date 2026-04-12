import { safeStorage } from 'electron'
import log from 'electron-log'

const ENCRYPTED_PREFIX = 'enc::'

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plaintext)
    return ENCRYPTED_PREFIX + encrypted.toString('base64')
  }

  log.warn('safeStorage not available, falling back to base64 encoding')
  return 'b64::' + Buffer.from(plaintext).toString('base64')
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext

  if (ciphertext.startsWith(ENCRYPTED_PREFIX)) {
    const buf = Buffer.from(ciphertext.slice(ENCRYPTED_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  }

  if (ciphertext.startsWith('b64::')) {
    return Buffer.from(ciphertext.slice(5), 'base64').toString('utf-8')
  }

  return ciphertext
}

export function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    'password', 'secret', 'token', 'apikey', 'api_key',
    'smtp.password', 'telegram.botToken', 'meshtastic'
  ]
  return sensitivePatterns.some(p => key.toLowerCase().includes(p.toLowerCase()))
}
