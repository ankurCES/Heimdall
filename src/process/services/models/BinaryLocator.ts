// BinaryLocator — v1.4.3 cross-platform helper for finding external
// CLI tools that Heimdall integrates with but doesn't bundle.
//
// We intentionally don't ship whisper-cli, ffmpeg, etc. inside the
// Electron app: code-signing + notarisation + AV false-positives make
// shipping arbitrary binaries fragile, and most analyst machines
// already have these (or can install them with a one-liner).
//
// This module just searches the obvious places so the analyst doesn't
// have to type the absolute path into Settings:
//   - PATH (via `which` / `where`)
//   - Homebrew prefixes (`/opt/homebrew/bin`, `/usr/local/bin`)
//   - System dirs (`/usr/bin`, `/usr/local/bin`)
//   - Snap, MacPorts, common Windows install dirs
//
// Returns null when nothing is found; callers surface a clear
// "needs install" message with copy-pasteable commands per platform.

import { existsSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'

const COMMON_DIRS_UNIX = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin',          // MacPorts
  '/snap/bin',
  '/var/lib/snapd/snap/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'bin')
]

const COMMON_DIRS_WIN = [
  'C:\\Program Files\\whisper.cpp',
  'C:\\Program Files (x86)\\whisper.cpp',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\ProgramData\\chocolatey\\bin',
  path.join(process.env.LOCALAPPDATA || '', 'Programs')
]

/** Find an executable across PATH and common install dirs.
 *  Pass aliases (e.g. ['whisper-cli', 'whisper-cpp', 'whisper']) and
 *  the first hit wins. Returns absolute path or null. */
export async function findBinary(names: string[]): Promise<string | null> {
  // 1. Check PATH via which/where
  for (const n of names) {
    const viaPath = await whichLike(n)
    if (viaPath) return viaPath
  }
  // 2. Check common install dirs
  const dirs = process.platform === 'win32' ? COMMON_DIRS_WIN : COMMON_DIRS_UNIX
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue
    for (const n of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, n + ext)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

/** Spawn `which`/`where` and return the first matching absolute path. */
async function whichLike(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const tool = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(tool, [cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      resolve(first || null)
    })
  })
}

/** Per-platform install hints surfaced to the user when nothing is found. */
export function installHint(toolset: 'whisper' | 'ffmpeg'): { platform: string; commands: string[] }[] {
  if (toolset === 'whisper') {
    return [
      { platform: 'macOS', commands: ['brew install whisper-cpp'] },
      { platform: 'Linux (Debian/Ubuntu)', commands: [
        'sudo apt install build-essential cmake',
        'git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make',
        'sudo cp main /usr/local/bin/whisper-cli'
      ]},
      { platform: 'Windows', commands: [
        'Download whisper-bin-x64.zip from https://github.com/ggerganov/whisper.cpp/releases',
        'Extract to C:\\Program Files\\whisper.cpp',
        'Restart Heimdall'
      ]}
    ]
  }
  return [
    { platform: 'macOS', commands: ['brew install ffmpeg'] },
    { platform: 'Linux', commands: ['sudo apt install ffmpeg', 'sudo dnf install ffmpeg'] },
    { platform: 'Windows', commands: [
      'winget install Gyan.FFmpeg',
      'or: choco install ffmpeg'
    ]}
  ]
}
