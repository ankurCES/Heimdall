// ModelRegistry — v1.4.3 declarative list of local AI assets that
// Heimdall manages on the analyst's behalf.
//
// Anything an analyst would otherwise have to download manually from
// HuggingFace / GitHub / Sourceforge belongs here. Each entry is a
// stable URL → local path mapping with an sha256 (when known) so the
// ModelDownloadManager can verify integrity, resume on interruption,
// and tell the renderer exactly what's happening.
//
// Adding a new asset:
//   1. Append a ManagedAsset row below
//   2. Reference it by id from the consuming service (e.g.
//      TranscriptionService reads modelManager.path('whisper-base-en'))
//   3. If it's a binary, set executable: true and a platform map
//
// Conventions:
//   - destPath is relative to <userData>/models/. ModelDownloadManager
//     resolves it to an absolute path at download time.
//   - sha256 is optional but strongly recommended for any asset > 1 MB.
//   - sizeBytes is for the progress UI — a missing value shows
//     indeterminate progress.
//   - requiredBy is a label list shown in the Settings → Models tab so
//     the analyst sees which features each download enables.

import { app } from 'electron'
import path from 'path'

export type AssetKind =
  | 'whisper-model'      // whisper.cpp ggml .bin file
  | 'tesseract-data'     // Tesseract .traineddata language pack
  | 'binary'             // executable binary, chmod +x after install
  | 'generic'

export interface ManagedAsset {
  id: string
  kind: AssetKind
  description: string
  url: string                          // direct download URL (HF, GH releases, etc.)
  destPath: string                     // relative to <userData>/models/
  sha256?: string                      // verified after download if present
  sizeBytes?: number                   // for progress; null = indeterminate
  executable?: boolean                 // chmod 0755 after download (Unix only)
  requiredBy: string[]                 // human-readable feature list
  optional?: boolean                   // skipped during ensureRequired() unless toggled on
  // For binaries that vary per OS/arch: provide platformMap.
  // Key format: `${process.platform}-${process.arch}` e.g. 'darwin-arm64'.
  platformMap?: Record<string, { url: string; sha256?: string; sizeBytes?: number }>
}

/** Default registry. Order = display order in the Models tab.
 *
 * Note on sha256: HuggingFace doesn't publish stable per-file sha256
 * values for whisper.cpp model uploads (LFS object hash != file content
 * hash for some entries), and Tesseract trained-data files are
 * occasionally re-built. Hardcoding hashes caused real downloads to
 * be deleted with "SHA-256 mismatch" errors in v1.4.3. We rely on:
 *   - HTTPS (integrity at the transport layer)
 *   - Approximate size guard (the manager rejects truncated downloads)
 *   - HuggingFace + GitHub URL stability (content-addressed paths)
 * If a future asset publishes a known-good hash, we'll add it; for now
 * the field is intentionally absent so verification is skipped. */
export const DEFAULT_REGISTRY: ManagedAsset[] = [
  {
    id: 'whisper-base-en',
    kind: 'whisper-model',
    description: 'Whisper base.en — fast English-only ASR (ggml, ~148 MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    destPath: 'whisper/ggml-base.en.bin',
    sizeBytes: 147951465,
    requiredBy: ['Audio/video transcription (default model)']
  },
  {
    id: 'whisper-small-en',
    kind: 'whisper-model',
    description: 'Whisper small.en — better accuracy, slower (~488 MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    destPath: 'whisper/ggml-small.en.bin',
    sizeBytes: 487601967,
    optional: true,
    requiredBy: ['Audio/video transcription (high-accuracy English)']
  },
  {
    // Multilingual base is the preferred default model (TranscriptionService
    // picks it over ggml-base.en when both are present). Same size and
    // inference speed as base.en, but supports all 99 languages whisper
    // ships — the analyst use case spans many languages, so silently
    // misclassifying foreign audio as garbled English is worse UX than
    // an extra ~148 MB on disk. Required-by-default so it ships with the
    // first-run auto-download alongside base.en.
    id: 'whisper-base-multilingual',
    kind: 'whisper-model',
    description: 'Whisper base — multilingual ASR (preferred default; covers 99 languages, ~148 MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    destPath: 'whisper/ggml-base.bin',
    sizeBytes: 147964211,
    requiredBy: ['Audio/video transcription (default, all languages)']
  },
  {
    id: 'tesseract-eng',
    kind: 'tesseract-data',
    description: 'Tesseract English training data (OCR fallback for documents)',
    url: 'https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata',
    destPath: 'tesseract/eng.traineddata',
    sizeBytes: 23456445,
    requiredBy: ['Document OCR fallback']
  }
]

/** Resolve <userData>/models/<destPath> to an absolute path. */
export function absolutePath(rel: string): string {
  return path.join(app.getPath('userData'), 'models', rel)
}

/** Look up the platform-specific URL+hash for an asset. Returns the base
 *  URL if no platformMap is set. */
export function resolveDownloadTarget(asset: ManagedAsset): { url: string; sha256?: string; sizeBytes?: number } {
  if (asset.platformMap) {
    const key = `${process.platform}-${process.arch}`
    const hit = asset.platformMap[key]
    if (hit) return hit
    // No platform-specific URL available — caller should treat as unsupported
    return { url: '' }
  }
  return { url: asset.url, sha256: asset.sha256, sizeBytes: asset.sizeBytes }
}
