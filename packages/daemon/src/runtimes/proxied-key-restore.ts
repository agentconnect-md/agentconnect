// A private HOME copy an srt launch projected for the credential proxy (github-app-git-credentials.md, Provider keys) gets its key field back from the host once a launch no longer protects it; the rest of the private state stays.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import stripJsonComments from 'strip-json-comments'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { looksLikePlaceholder, PLACEHOLDER_PREFIX } from '../credential-proxy/placeholder.js'
import { readRegularFileSync } from '../fs/regular-file.js'
import { copyOmpDatabase, installOmpDatabase, readOmpApiCredentials, rewriteOmpApiKeys } from './omp-credentials.js'
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

const JSON_FORMAT = {
  parse: (text: string): unknown =>
    JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''), { trailingCommas: true })),
  write: (data: unknown) => `${JSON.stringify(data)}\n`
}
const YAML_FORMAT = { parse: (text: string): unknown => parseYaml(text), write: (data: unknown) => stringifyYaml(data) }
/** A structured document's reader and writer, by extension; any other file is plain text. */
const FORMATS: Record<string, typeof JSON_FORMAT> = {
  '.json': JSON_FORMAT,
  '.jsonc': JSON_FORMAT,
  '.toml': { parse: (text) => parseToml(text), write: (data) => stringifyToml(data as Record<string, unknown>) },
  '.yml': YAML_FORMAT,
  '.yaml': YAML_FORMAT
}

/** Put the host's keys back where a private copy of a sign-in or config file holds placeholders, each from the same field of the host's file; a plain-text copy is the host's again. */
export function restoreProxiedFileKeys(destination: string, source: string): void {
  const text = readSmall(destination)
  const hostText = text?.includes(PLACEHOLDER_PREFIX) ? readSmall(source) : undefined
  if (text === undefined || hostText === undefined || hostText.includes(PLACEHOLDER_PREFIX)) return
  const format = Object.hasOwn(FORMATS, extname(destination).toLowerCase())
    ? FORMATS[extname(destination).toLowerCase()]
    : undefined
  if (!format) return replaceFile(destination, hostText)
  let data: unknown
  let host: unknown
  try {
    data = format.parse(text)
    host = format.parse(hostText)
  } catch {
    return
  }
  let changed = false
  const restore = (value: unknown, original: unknown): unknown => {
    if (typeof value === 'string') {
      if (!looksLikePlaceholder(value.replace(/^Bearer\s+/i, '')) || typeof original !== 'string') return value
      changed = true
      return original
    }
    if (Array.isArray(value))
      return value.map((item, index) => restore(item, Array.isArray(original) ? original[index] : undefined))
    // A parsed date or any other non-plain value stays as it is.
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const from = original && typeof original === 'object' ? (original as Record<string, unknown>) : {}
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, from[key])]))
    }
    return value
  }
  const restored = restore(data, host)
  if (changed) replaceFile(destination, format.write(restored))
}

/** Put the host's key back in each API key row of a private OMP database that holds a placeholder, through a copy outside it. */
export function restoreProxiedOmpKeys(parent: string, source: string): void {
  const temporary = mkdtempSync(join(tmpdir(), 'ac-omp-restore-'))
  try {
    if (!copyOmpDatabase(parent, temporary)) return
    const copy = join(temporary, 'agent.db')
    const host = new Map(readOmpApiCredentials(source).map((row) => [`${row.id}:${row.provider}`, row.key]))
    const restored = readOmpApiCredentials(copy).flatMap((row) => {
      const key = host.get(`${row.id}:${row.provider}`)
      return looksLikePlaceholder(row.key) && key && !looksLikePlaceholder(key) ? [[row, key] as const] : []
    })
    if (restored.length === 0) return
    rewriteOmpApiKeys(copy, restored)
    installOmpDatabase(copy, parent)
  } catch {
    // A database that cannot be read safely is left as it is; nothing here may quote it.
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
