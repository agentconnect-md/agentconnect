// A private HOME copy an srt launch projected for the credential proxy (github-app-git-credentials.md, Provider keys) gets its key field back from the host once a launch no longer protects it; the rest of the private state stays.
import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import { stringify as stringifyYaml } from 'yaml'
import { looksLikePlaceholder, PLACEHOLDER_PREFIX } from '../credential-proxy/placeholder.js'
import { readRegularFileSync } from '../fs/regular-file.js'
import { MAX_SEED_FILE_BYTES, parseDshCredentialDocument } from './runtime-seeded-credentials.js'

const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'

/** A small regular file's text; anything else, or nothing there, reads as undefined. */
function readSmall(path: string): string | undefined {
  try {
    return readRegularFileSync(path, MAX_SEED_FILE_BYTES).toString('utf8')
  } catch {
    return undefined
  }
}

/** Replace the file by rename, so a link put in its place is replaced rather than followed. */
function replaceFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Already renamed, or never written.
    }
    throw error
  }
}

/** Put the host's DeepSeek key back in a private credential file that holds a placeholder for it. */
export function restoreProxiedDeepSeekKey(destination: string, source: string, format: 'dsh' | 'dsh-env'): void {
  const text = readSmall(destination)
  if (text === undefined || !text.includes(PLACEHOLDER_PREFIX)) return
  let current: ReturnType<typeof parseDshCredentialDocument>
  let host: string | undefined
  try {
    current = parseDshCredentialDocument(text, format)
    const hostText = readSmall(source)
    host = hostText === undefined ? undefined : parseDshCredentialDocument(hostText, format).refs[DEEPSEEK_KEY]
  } catch {
    // An unreadable document is left as it is; nothing here may quote it.
    return
  }
  const placeholder = current.refs[DEEPSEEK_KEY]
  if (!placeholder || !looksLikePlaceholder(placeholder) || !host || looksLikePlaceholder(host)) return
  if (format === 'dsh-env') return replaceFile(destination, text.replaceAll(placeholder, host))
  const target = (current.data.version === 1 ? current.data.refs : current.data) as Record<string, unknown>
  target[DEEPSEEK_KEY] = host
  replaceFile(destination, stringifyYaml(current.data))
}

/** Put the host's keys back where a private OpenCode config holds placeholders, each from the same field of the host's config. */
export function restoreProxiedOpenCodeKeys(destination: string, source: string): void {
  const text = readSmall(destination)
  const hostText = text?.includes(PLACEHOLDER_PREFIX) ? readSmall(source) : undefined
  if (text === undefined || hostText === undefined) return
  let data: unknown
  let host: unknown
  try {
    data = JSON.parse(stripJsonComments(text, { trailingCommas: true }))
    host = JSON.parse(stripJsonComments(hostText, { trailingCommas: true }))
  } catch {
    return
  }
  let changed = false
  const restore = (value: unknown, original: unknown): unknown => {
    if (typeof value === 'string') {
      const bare = value.replace(/^Bearer\s+/i, '')
      if (!looksLikePlaceholder(bare) || typeof original !== 'string' || original.includes(PLACEHOLDER_PREFIX))
        return value
      changed = true
      return original
    }
    if (Array.isArray(value))
      return value.map((item, index) => restore(item, Array.isArray(original) ? original[index] : undefined))
    if (value && typeof value === 'object') {
      const from = original && typeof original === 'object' ? (original as Record<string, unknown>) : {}
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, from[key])]))
    }
    return value
  }
  const restored = restore(data, host)
  if (changed) replaceFile(destination, `${JSON.stringify(restored)}\n`)
}
