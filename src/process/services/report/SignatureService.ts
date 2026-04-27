// Cryptographic signing for exported reports.
//
// On first use, generates an Ed25519 key pair. Private key is persisted to
// userData/heimdall-signing.key (NEVER leaves the host). Public key + a
// short fingerprint are stored in settings so distributees can verify.
//
// Each export produces:
//   - SHA-256 of the rendered file bytes
//   - Ed25519 signature over the SHA-256
//   - Public key fingerprint (first 16 hex chars of SHA-256 of pubkey)
//
// All recorded in report_distributions for the audit trail. The signature
// page embedded in the PDF/DOCX exposes all three for verification.

// @noble/ed25519 is ESM-only — main-process bundle is CJS so we lazy-load.
// On first use we wire SHA-512 via Node's native crypto (no extra dep).
import { randomBytes, createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { app, safeStorage } from 'electron'
import log from 'electron-log'

interface Ed25519Module {
  getPublicKeyAsync(privateKey: Uint8Array): Promise<Uint8Array>
  signAsync(msg: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>
  verifyAsync(sig: Uint8Array, msg: Uint8Array, pubKey: Uint8Array): Promise<boolean>
  hashes: {
    sha512?: (data: Uint8Array) => Uint8Array
    sha512Async?: (data: Uint8Array) => Promise<Uint8Array>
  }
}

let _ed: Ed25519Module | null = null
async function loadEd25519(): Promise<Ed25519Module> {
  if (_ed) return _ed
  const m = await import('@noble/ed25519')
  const ed = m as unknown as Ed25519Module
  // The module namespace itself is frozen, but the `hashes` object inside
  // it is a regular mutable object — we can set properties on it. v3 needs
  // sha512 (sync) for the async APIs we use (signAsync / getPublicKeyAsync /
  // verifyAsync all go through the same code path under the hood).
  ed.hashes.sha512 = (data: Uint8Array) =>
    new Uint8Array(createHash('sha512').update(data).digest())
  _ed = ed
  return ed
}

const KEY_FILENAME = 'heimdall-signing.key'

interface KeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

let cachedKeyPair: KeyPair | null = null

function keyPath(): string {
  const userData = app.getPath('userData')
  return join(userData, KEY_FILENAME)
}

/**
 * SECURITY (v1.3.2 — finding B9): wrap the on-disk private key with
 * Electron's safeStorage (OS keyring on macOS, libsecret on Linux,
 * DPAPI on Windows). Mode 0600 alone isn't sufficient — anyone with
 * Heimdall-process equivalent can read it; safeStorage adds an OS-level
 * derived-key cipher.
 *
 * Backwards-compatible: if a legacy plaintext key file exists (32 bytes
 * raw), we load it, re-encrypt it, and overwrite. Future loads decrypt.
 */
const KEY_MAGIC = 'HEIMSAFE\x01\x00'   // 10-byte marker for the encrypted format

/** Load or generate the per-instance signing key pair. */
async function getOrCreateKeyPair(): Promise<KeyPair> {
  if (cachedKeyPair) return cachedKeyPair

  const path = keyPath()
  if (existsSync(path)) {
    try {
      const buf = readFileSync(path)
      let privateKey: Uint8Array

      if (buf.length > KEY_MAGIC.length && buf.slice(0, KEY_MAGIC.length).toString('binary') === KEY_MAGIC) {
        // Encrypted-format key — decrypt via safeStorage
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('safeStorage not available; cannot decrypt signing key')
        }
        const cipher = buf.slice(KEY_MAGIC.length)
        privateKey = new Uint8Array(safeStorage.decryptString(cipher).split(',').map(Number))
      } else if (buf.length === 32) {
        // Legacy plaintext key — migrate now
        privateKey = new Uint8Array(buf)
        log.warn('SignatureService: legacy plaintext key found; migrating to encrypted format')
        try { await persistEncryptedKey(privateKey, path) }
        catch (mErr) { log.warn(`SignatureService: migration failed: ${mErr}`) }
      } else {
        throw new Error(`unrecognized key file format (${buf.length} bytes)`)
      }

      const publicKey = await (await loadEd25519()).getPublicKeyAsync(privateKey)
      cachedKeyPair = { privateKey, publicKey }
      log.info(`SignatureService: loaded signing key (fingerprint: ${publicKeyFingerprint(publicKey)}, mode 0${(statSync(path).mode & 0o777).toString(8)})`)
      return cachedKeyPair
    } catch (err) {
      log.warn(`SignatureService: failed to load existing key (${err}), regenerating`)
    }
  }

  // Generate fresh
  const privateKey = new Uint8Array(randomBytes(32))
  const publicKey = await (await loadEd25519()).getPublicKeyAsync(privateKey)
  try {
    mkdirSync(dirname(path), { recursive: true })
    await persistEncryptedKey(privateKey, path)
    log.info(`SignatureService: generated new signing key (fingerprint: ${publicKeyFingerprint(publicKey)})`)
  } catch (err) {
    log.warn(`SignatureService: failed to persist private key (${err}) — signatures will not survive restart`)
  }

  cachedKeyPair = { privateKey, publicKey }
  return cachedKeyPair
}

async function persistEncryptedKey(privateKey: Uint8Array, path: string): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) {
    // We store the bytes as a comma-joined string because safeStorage
    // accepts strings. Round-trip is byte-exact for 0-255 values.
    const cipher = safeStorage.encryptString(Array.from(privateKey).join(','))
    const blob = Buffer.concat([Buffer.from(KEY_MAGIC, 'binary'), cipher])
    writeFileSync(path, blob, { mode: 0o600 })
  } else {
    // Fall back to plaintext mode 0600 if safeStorage isn't available
    // (very rare on Electron — Linux without libsecret etc.)
    log.warn('SignatureService: safeStorage unavailable; persisting key in plaintext (mode 0600)')
    writeFileSync(path, Buffer.from(privateKey), { mode: 0o600 })
  }
}

/** Short human-readable fingerprint of the public key (first 16 hex chars). */
export function publicKeyFingerprint(pubKey: Uint8Array): string {
  const hash = createHash('sha256').update(pubKey).digest('hex')
  return hash.slice(0, 16).match(/.{4}/g)!.join(':')
}

export interface SignedFile {
  /** SHA-256 of the file bytes, hex-encoded. */
  sha256: string
  /** Ed25519 signature of the SHA-256 bytes, base64-encoded. */
  signatureB64: string
  /** Short colon-separated fingerprint of the public key. */
  fingerprint: string
  /** Full public key, base64-encoded — for verifiers. */
  publicKeyB64: string
  /** ISO timestamp of signing. */
  signedAt: string
}

/**
 * Compute SHA-256 of the bytes and sign it with this instance's key.
 * Returns everything a recipient needs to verify the file is authentic.
 */
export async function signFile(bytes: Uint8Array): Promise<SignedFile> {
  const kp = await getOrCreateKeyPair()
  const sha = createHash('sha256').update(Buffer.from(bytes)).digest()
  const ed = await loadEd25519()
  const signature = await ed.signAsync(new Uint8Array(sha), kp.privateKey)
  return {
    sha256: sha.toString('hex'),
    signatureB64: Buffer.from(signature).toString('base64'),
    fingerprint: publicKeyFingerprint(kp.publicKey),
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    signedAt: new Date().toISOString()
  }
}

/** Verify a signature against bytes — used by recipients of exported files. */
export async function verifySignature(
  bytes: Uint8Array,
  signatureB64: string,
  publicKeyB64: string
): Promise<boolean> {
  try {
    const sha = createHash('sha256').update(Buffer.from(bytes)).digest()
    const signature = new Uint8Array(Buffer.from(signatureB64, 'base64'))
    const publicKey = new Uint8Array(Buffer.from(publicKeyB64, 'base64'))
    const ed = await loadEd25519()
    return await ed.verifyAsync(signature, new Uint8Array(sha), publicKey)
  } catch (err) {
    log.warn(`verifySignature failed: ${err}`)
    return false
  }
}

/** Public key info for display in the UI. */
export async function getPublicKeyInfo(): Promise<{ publicKeyB64: string; fingerprint: string }> {
  const kp = await getOrCreateKeyPair()
  return {
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    fingerprint: publicKeyFingerprint(kp.publicKey)
  }
}
