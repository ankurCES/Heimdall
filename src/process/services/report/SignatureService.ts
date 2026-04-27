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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
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

/** Load or generate the per-instance signing key pair. */
async function getOrCreateKeyPair(): Promise<KeyPair> {
  if (cachedKeyPair) return cachedKeyPair

  const path = keyPath()
  if (existsSync(path)) {
    try {
      const buf = readFileSync(path)
      // Stored format: 32 bytes private key. Public derived on load.
      const privateKey = new Uint8Array(buf.slice(0, 32))
      const publicKey = await (await loadEd25519()).getPublicKeyAsync(privateKey)
      cachedKeyPair = { privateKey, publicKey }
      log.info(`SignatureService: loaded existing signing key (fingerprint: ${publicKeyFingerprint(publicKey)})`)
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
    writeFileSync(path, Buffer.from(privateKey), { mode: 0o600 })
    log.info(`SignatureService: generated new signing key (fingerprint: ${publicKeyFingerprint(publicKey)})`)
  } catch (err) {
    log.warn(`SignatureService: failed to persist private key (${err}) — signatures will not survive restart`)
  }

  cachedKeyPair = { privateKey, publicKey }
  return cachedKeyPair
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
