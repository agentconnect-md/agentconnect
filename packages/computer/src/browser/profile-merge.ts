// Fork-merge of Chromium profiles: pulls other profiles' login state into a closed one (computer-use.md §3.10).
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { readLevelDb, writeLevelDb } from './leveldb.js'

export const BASELINE_FILE = 'ac-fork-baseline.json'
// Chromium's clock counts microseconds from 1601-01-01.
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n
const SNAPSHOT_TRIES = 6
const SNAPSHOT_RETRY_MS = 300

interface SourceBaseline {
  cookies: Record<string, string>
  localStorage: Record<string, string>
  indexedDb: Record<string, number>
}

interface Baselines {
  version: 1
  sources: Record<string, SourceBaseline>
}

export interface SourceReport {
  source: string
  firstFork: boolean
  cookies: { inserted: number; updated: number; kept: number; expired: number; deleted: number }
  localStorage: { taken: string[]; kept: number }
  indexedDb: { taken: string[]; kept: number }
}

export interface ForkMergeOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The cookie database of a profile's Default directory: Network/Cookies on current Chromium, Cookies before. */
export function cookiesPath(profile: string): string {
  const network = join(profile, 'Default', 'Network', 'Cookies')
  return existsSync(network) ? network : join(profile, 'Default', 'Cookies')
}

let sqlite: typeof import('node:sqlite') | undefined

// Loaded on first use, with Node 24's one-time "SQLite is experimental" warning dropped from every browser launch.
function openDb(path: string): DatabaseSync {
  if (!sqlite) {
    const emit = process.emitWarning
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (!String(warning).includes('SQLite')) (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
    }) as typeof process.emitWarning
    try {
      sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    } finally {
      process.emitWarning = emit
    }
  }
  return new sqlite.DatabaseSync(path)
}

const localStoragePath = (profile: string): string => join(profile, 'Default', 'Local Storage', 'leveldb')
const indexedDbPath = (profile: string): string => join(profile, 'Default', 'IndexedDB')

/** Merges every source profile into the closed target profile, three-way against what the target took last time. */
export async function forkMerge(
  target: string,
  sources: string[],
  options: ForkMergeOptions = {}
): Promise<SourceReport[]> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const baselinePath = join(target, BASELINE_FILE)
  const baselines = loadBaselines(baselinePath)
  const reports: SourceReport[] = []
  for (const source of sources) {
    const key = realpathSync(source)
    const previous = baselines.sources[key]
    const work = mkdtempSync(join(tmpdir(), 'ac-fork-'))
    try {
      const snapshot = await takeSnapshot(source, work, sleep)
      const next: SourceBaseline = { cookies: {}, localStorage: {}, indexedDb: {} }
      const report: SourceReport = {
        source,
        firstFork: previous === undefined,
        cookies: { inserted: 0, updated: 0, kept: 0, expired: 0, deleted: 0 },
        localStorage: { taken: [], kept: 0 },
        indexedDb: { taken: [], kept: 0 }
      }
      if (snapshot.cookies) {
        mergeCookies(snapshot.cookies, cookiesPath(target), previous?.cookies, next.cookies, report.cookies, now)
      }
      mergeLocalStorage(
        snapshot.localStorage,
        localStoragePath(target),
        previous?.localStorage,
        next.localStorage,
        report.localStorage
      )
      if (snapshot.indexedDb) {
        mergeIndexedDb(snapshot.indexedDb, indexedDbPath(target), previous?.indexedDb, next.indexedDb, report.indexedDb)
      }
      baselines.sources[key] = next
      reports.push(report)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  writeFileSync(baselinePath, JSON.stringify(baselines))
  return reports
}

function loadBaselines(path: string): Baselines {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baselines
    if (parsed.version === 1 && parsed.sources && typeof parsed.sources === 'object') return parsed
  } catch {
    // No baseline yet, or an unreadable one: this fork is a first fork.
  }
  return { version: 1, sources: {} }
}

interface Snapshot {
  cookies?: string
  localStorage: Map<string, Buffer>
  indexedDb?: string
}

// Copies a source's stores, which may belong to a running browser: LevelDB is retried until a copy reads cleanly.
async function takeSnapshot(source: string, work: string, sleep: (ms: number) => Promise<void>): Promise<Snapshot> {
  const snapshot: Snapshot = { localStorage: new Map() }
  const cookies = cookiesPath(source)
  if (existsSync(cookies)) {
    snapshot.cookies = join(work, 'Cookies')
    cpSync(cookies, snapshot.cookies)
    for (const suffix of ['-journal', '-wal']) {
      if (existsSync(cookies + suffix)) cpSync(cookies + suffix, snapshot.cookies + suffix)
    }
  }
  const localStorage = localStoragePath(source)
  if (existsSync(localStorage)) {
    snapshot.localStorage = await retried(sleep, () => {
      const copy = join(work, 'ls')
      rmSync(copy, { recursive: true, force: true })
      cpSync(localStorage, copy, { recursive: true, filter: (path) => basename(path) !== 'LOCK' })
      return readLevelDb(copy)
    })
  }
  const indexedDb = indexedDbPath(source)
  if (existsSync(indexedDb)) {
    snapshot.indexedDb = join(work, 'idb')
    await retried(sleep, () => {
      rmSync(snapshot.indexedDb!, { recursive: true, force: true })
      cpSync(indexedDb, snapshot.indexedDb!, {
        recursive: true,
        preserveTimestamps: true,
        filter: (path) => basename(path) !== 'LOCK'
      })
    })
  }
  return snapshot
}

async function retried<T>(sleep: (ms: number) => Promise<void>, attempt: () => T): Promise<T> {
  let last: unknown
  for (let i = 0; i < SNAPSHOT_TRIES; i++) {
    try {
      return attempt()
    } catch (error) {
      last = error
      await sleep(SNAPSHOT_RETRY_MS)
    }
  }
  throw new Error(`could not snapshot a running profile: ${(last as Error).message}`)
}

// ---- cookies ----

type Row = Record<string, unknown>

const scalar = (value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value)

// node:sqlite binds an empty blob it returned as NULL, which encrypted_value refuses; a copy binds as a blob.
const bindable = (value: unknown): SQLInputValue =>
  value instanceof Uint8Array ? Buffer.from(value) : (value as SQLInputValue)

function uniqueKey(db: DatabaseSync): string[] {
  for (const index of db.prepare('PRAGMA index_list(cookies)').all() as Row[]) {
    if (Number(index.unique) !== 1) continue
    const name = String(index.name).replaceAll("'", "''")
    return (db.prepare(`PRAGMA index_info('${name}')`).all() as Row[]).map((column) => String(column.name))
  }
  throw new Error('the cookies table has no unique index')
}

function mergeCookies(
  snapshot: string,
  target: string,
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
  counts: SourceReport['cookies'],
  now: () => number
): void {
  if (!existsSync(target)) cpSync(snapshot, target)
  const source = openDb(snapshot)
  const db = openDb(target)
  try {
    const columns = (db.prepare('PRAGMA table_info(cookies)').all() as Row[]).map((column) => String(column.name))
    const sourceColumns = (source.prepare('PRAGMA table_info(cookies)').all() as Row[]).map((column) =>
      String(column.name)
    )
    if (columns.join() !== sourceColumns.join()) throw new Error('the cookie databases have different schemas')
    const key = uniqueKey(db)
    const stamp = columns.includes('last_update_utc') ? 'last_update_utc' : 'creation_utc'
    const keyOf = (row: Row): string => JSON.stringify(key.map((column) => scalar(row[column])))
    const list = (database: DatabaseSync, sql: string): Row[] => {
      const statement = database.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all() as Row[]
    }
    const quoted = columns.map((column) => `"${column}"`).join(',')
    const mine = new Map<string, { rowid: bigint; stamp: bigint }>()
    for (const row of list(db, `SELECT rowid AS ac_rowid, ${quoted} FROM cookies`)) {
      mine.set(keyOf(row), { rowid: row.ac_rowid as bigint, stamp: row[stamp] as bigint })
    }
    const insert = db.prepare(`INSERT OR REPLACE INTO cookies (${quoted}) VALUES (${columns.map(() => '?').join(',')})`)
    const remove = db.prepare('DELETE FROM cookies WHERE rowid = ?')
    const nowUs = BigInt(now()) * 1000n + CHROME_EPOCH_OFFSET_US
    db.exec('BEGIN')
    try {
      for (const row of list(source, `SELECT ${quoted} FROM cookies`)) {
        const id = keyOf(row)
        const updated = row[stamp] as bigint
        next[id] = updated.toString()
        const expires = row.expires_utc as bigint
        if (Number(row.is_persistent) === 1 && expires > 0n && expires < nowUs) {
          counts.expired++
          continue
        }
        const current = mine.get(id)
        const changed = previous === undefined || previous[id] !== updated.toString()
        if (!changed || current?.stamp === updated) {
          counts.kept++
          continue
        }
        insert.run(...columns.map((column) => bindable(row[column])))
        counts[current ? 'updated' : 'inserted']++
      }
      if (previous) {
        for (const id of Object.keys(previous)) {
          if (id in next) continue
          const current = mine.get(id)
          if (current) {
            remove.run(current.rowid)
            counts.deleted++
          }
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    source.close()
    db.close()
  }
}

// ---- localStorage: keys `META:<origin>` (protobuf, field 1 is last_modified) and `_<origin>\0<key>` ----

function lastModified(meta: Buffer): string {
  let pos = 0
  while (pos < meta.length) {
    const tag = meta[pos++]!
    let value = 0n
    let shift = 0n
    for (;;) {
      const byte = meta[pos++]
      if (byte === undefined) return value.toString()
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n
      if (!(byte & 0x80)) break
    }
    if (tag === 0x08) return value.toString()
  }
  return '0'
}

function mergeLocalStorage(
  source: Map<string, Buffer>,
  target: string,
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
  report: SourceReport['localStorage']
): void {
  const merged = readLevelDb(target)
  let changed = false
  if (!merged.has('VERSION') && source.has('VERSION')) {
    merged.set('VERSION', source.get('VERSION')!)
    changed = true
  }
  for (const [key, meta] of source) {
    if (!key.startsWith('META:')) continue
    const origin = key.slice('META:'.length)
    const modified = lastModified(meta)
    next[origin] = modified
    const mine = merged.get(key)
    if ((previous !== undefined && previous[origin] === modified) || (mine && mine.equals(meta))) {
      report.kept++
      continue
    }
    const prefix = `_${origin}\u0000`
    for (const existing of [...merged.keys()]) if (existing.startsWith(prefix)) merged.delete(existing)
    for (const [entry, value] of source) if (entry.startsWith(prefix)) merged.set(entry, value)
    merged.set(key, meta)
    const access = source.get(`METAACCESS:${origin}`)
    if (access) merged.set(`METAACCESS:${origin}`, access)
    report.taken.push(origin)
    changed = true
  }
  if (changed) writeLevelDb(target, merged)
}

// ---- IndexedDB: one `<origin>.indexeddb.leveldb` directory (and its `.blob` sibling) per origin ----

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
  }
  return newest
}

function mergeIndexedDb(
  snapshot: string,
  target: string,
  previous: Record<string, number> | undefined,
  next: Record<string, number>,
  report: SourceReport['indexedDb']
): void {
  for (const name of readdirSync(snapshot)) {
    if (!name.endsWith('.indexeddb.leveldb')) continue
    const origin = name.slice(0, -'.indexeddb.leveldb'.length)
    const modified = newestMtime(join(snapshot, name))
    next[origin] = modified
    const mine = join(target, name)
    if (
      (previous !== undefined && previous[origin] === modified) ||
      (existsSync(mine) && newestMtime(mine) === modified)
    ) {
      report.kept++
      continue
    }
    for (const suffix of ['.indexeddb.leveldb', '.indexeddb.blob']) {
      const to = join(target, origin + suffix)
      rmSync(to, { recursive: true, force: true })
      const from = join(snapshot, origin + suffix)
      if (existsSync(from)) cpSync(from, to, { recursive: true, preserveTimestamps: true })
    }
    report.taken.push(origin)
  }
}
