import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// SVG rasterization fonts: resvg-wasm cannot see the system, so a bounded, CJK-first set is read once per worker.

export const FONT_BUDGET_BYTES = 80 * 1024 * 1024
const FONT_FILE_MAX_BYTES = 40 * 1024 * 1024
const MAX_SCANNED_ENTRIES = 20_000
const MAX_DEPTH = 5

// Families that cover Chinese/Japanese/Korean diagrams, best first.
const CJK_PATTERNS = [
  /NotoSans(?:CJK|SC|TC|JP|KR)/i,
  /SourceHanSans/i,
  /wqy-(?:zenhei|microhei)/i,
  /PingFang/i,
  /^msyh\./i,
  /^simhei\./i,
  /Hiragino Sans GB/i,
  /STHeiti/i,
  /NotoSerifCJK/i,
  /^simsun\./i,
  /DroidSansFallback/i
]
// One plain Latin sans as the default family.
const LATIN_PATTERNS = [
  /^DejaVuSans\.ttf$/i,
  /^LiberationSans-Regular\.ttf$/i,
  /^NotoSans-Regular\.ttf$/i,
  /^Arial\.ttf$/i,
  /^Helvetica\.ttc$/i,
  /^segoeui\.ttf$/i,
  /^Roboto-Regular\.ttf$/i,
  /^FreeSans\.ttf$/i
]

export function systemFontDirs(): string[] {
  if (process.platform === 'win32') return [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')]
  if (process.platform === 'darwin')
    return ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library', 'Fonts')]
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    join(homedir(), '.fonts'),
    join(homedir(), '.local/share/fonts')
  ]
}

function listFontFiles(dirs: string[]): { path: string; name: string; size: number }[] {
  const found: { path: string; name: string; size: number }[] = []
  let scanned = 0
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || scanned > MAX_SCANNED_ENTRIES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (/\.(?:ttf|otf|ttc|otc)$/i.test(entry.name)) {
        try {
          const size = statSync(path).size
          if (size > 0 && size <= FONT_FILE_MAX_BYTES) found.push({ path, name: entry.name, size })
        } catch {
          // Unreadable font files are skipped.
        }
      }
    }
  }
  for (const dir of dirs) walk(dir, 0)
  return found
}

export type FontSet = { buffers: Uint8Array[]; defaultFamily?: string }

/** Pick the best CJK font and one Latin sans within the byte budget; an empty set is valid (text is then not drawn). */
export function selectFonts(dirs = systemFontDirs(), budget = FONT_BUDGET_BYTES): FontSet {
  const files = listFontFiles(dirs)
  const chosen: { path: string; size: number }[] = []
  let used = 0
  const take = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = files
        .filter((f) => pattern.test(f.name) && !chosen.some((c) => c.path === f.path))
        .sort((a, b) => a.size - b.size)
        .find((f) => used + f.size <= budget)
      if (match) {
        chosen.push(match)
        used += match.size
        return match
      }
    }
    return undefined
  }
  const latin = take(LATIN_PATTERNS)
  const cjk = take(CJK_PATTERNS)
  // Nothing recognizable: the smallest few fonts still render Latin text.
  if (!latin && !cjk) {
    for (const f of [...files].sort((a, b) => a.size - b.size).slice(0, 3)) {
      if (used + f.size > budget) break
      chosen.push(f)
      used += f.size
    }
  }
  const buffers: Uint8Array[] = []
  let defaultFamily: string | undefined
  for (const f of chosen) {
    try {
      const bytes = readFileSync(f.path)
      buffers.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      defaultFamily ??= fontFamilyName(bytes)
    } catch {
      // A font that vanished between scan and read is skipped.
    }
  }
  return { buffers, ...(defaultFamily ? { defaultFamily } : {}) }
}

let cached: FontSet | undefined

export function rasterFonts(): FontSet {
  cached ??= selectFonts()
  return cached
}

/** The family name (name ID 1) of a TrueType/OpenType font or a collection's first face. */
export function fontFamilyName(bytes: Buffer): string | undefined {
  try {
    let offset = 0
    if (bytes.toString('latin1', 0, 4) === 'ttcf') offset = bytes.readUInt32BE(12)
    const numTables = bytes.readUInt16BE(offset + 4)
    for (let t = 0; t < numTables; t++) {
      const rec = offset + 12 + t * 16
      if (bytes.toString('latin1', rec, rec + 4) !== 'name') continue
      const table = bytes.readUInt32BE(rec + 8)
      const count = bytes.readUInt16BE(table + 2)
      const strings = table + bytes.readUInt16BE(table + 4)
      let fallback: string | undefined
      for (let r = 0; r < count; r++) {
        const n = table + 6 + r * 12
        const platform = bytes.readUInt16BE(n)
        const language = bytes.readUInt16BE(n + 4)
        if (bytes.readUInt16BE(n + 6) !== 1) continue
        const len = bytes.readUInt16BE(n + 8)
        const start = strings + bytes.readUInt16BE(n + 10)
        if (platform === 3 || platform === 0) {
          const raw = bytes.subarray(start, start + len)
          const swapped = Buffer.from(raw).swap16()
          const name = swapped.toString('utf16le')
          if (platform === 3 && language === 0x409) return name
          fallback ??= name
        } else if (platform === 1 && language === 0) {
          fallback ??= bytes.toString('latin1', start, start + len)
        }
      }
      return fallback
    }
  } catch {
    // Malformed font tables yield no name.
  }
  return undefined
}
