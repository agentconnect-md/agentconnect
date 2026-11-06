import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readLevelDb, writeLevelDb } from './leveldb.js'
import { BASELINE_FILE, forkMerge } from './profile-merge.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
// 2026-11-05 in Chromium's clock (microseconds since 1601), and a far-future expiry.
const NOW_MS = 1_793_874_025_000
const FAR = 13_600_000_000_000_000n
const options = { now: () => NOW_MS, sleep: async () => undefined }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-profile-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'Default'))
  cpSync(join(FIXTURES, 'Cookies'), join(dir, 'Default', 'Cookies'))
  const db = new DatabaseSync(join(dir, 'Default', 'Cookies'))
  db.exec('DELETE FROM cookies')
  db.close()
  return dir
}

function setCookie(dir: string, host: string, name: string, value: string, updated: bigint, expires = FAR): void {
  const db = new DatabaseSync(join(dir, 'Default', 'Cookies'))
  db.prepare(
    `INSERT OR REPLACE INTO cookies VALUES (?, ?, '', ?, ?, ?, '/', ?, 0, 1, ?, 1, 1, 1, 0, 1, 443, ?, 0, 0)`
  ).run(updated, host, name, value, new Uint8Array(), expires, updated, updated)
  db.close()
}

function deleteCookie(dir: string, name: string): void {
  const db = new DatabaseSync(join(dir, 'Default', 'Cookies'))
  db.prepare('DELETE FROM cookies WHERE name = ?').run(name)
  db.close()
}

function cookies(dir: string): Record<string, string> {
  const db = new DatabaseSync(join(dir, 'Default', 'Cookies'))
  const rows = db.prepare('SELECT name, value FROM cookies').all() as { name: string; value: string }[]
  db.close()
  return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}

const lsDir = (dir: string): string => join(dir, 'Default', 'Local Storage', 'leveldb')

// One origin's `who` item, with META's last_modified (protobuf field 1) set to `modified`.
function setWho(dir: string, origin: string, who: string, modified: number): void {
  const data = readLevelDb(lsDir(dir))
  data.set('VERSION', Buffer.from('1'))
  data.set(`META:${origin}`, Buffer.from([0x08, modified, 0x10, who.length]))
  data.set(`_${origin}\u0000\u0001who`, Buffer.from(`\u0001${who}`, 'latin1'))
  writeLevelDb(lsDir(dir), data)
}

const who = (dir: string, origin: string): string | undefined =>
  readLevelDb(lsDir(dir)).get(`_${origin}\u0000\u0001who`)?.subarray(1).toString('latin1')

function setIndexedDb(dir: string, origin: string, content: string, mtimeSeconds: number): void {
  const db = join(dir, 'Default', 'IndexedDB', `${origin}.indexeddb.leveldb`)
  mkdirSync(db, { recursive: true })
  writeFileSync(join(db, '000001.log'), content)
  utimesSync(join(db, '000001.log'), mtimeSeconds, mtimeSeconds)
}

const indexedDb = (dir: string, origin: string): string | undefined => {
  const file = join(dir, 'Default', 'IndexedDB', `${origin}.indexeddb.leveldb`, '000001.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

describe('forkMerge', () => {
  it('on a first fork takes whatever differs in the source and keeps what only the target has', async () => {
    const master = profile()
    const target = profile()
    setCookie(master, 'github.com', 'user_session', 'master', 100n)
    setCookie(master, 'github.com', 'shared', 'master', 100n)
    setCookie(target, 'github.com', 'shared', 'target', 200n)
    setCookie(target, 'example.com', 'own', 'target', 50n)
    setWho(master, 'https://app.example', 'master', 10)
    setWho(target, 'https://other.example', 'target', 10)
    setIndexedDb(master, 'https_app.example_0', 'master', 1_000)

    const [report] = await forkMerge(target, [master], options)

    expect(report!.firstFork).toBe(true)
    expect(cookies(target)).toEqual({ user_session: 'master', shared: 'master', own: 'target' })
    expect(report!.cookies).toMatchObject({ inserted: 1, updated: 1 })
    expect(who(target, 'https://app.example')).toBe('master')
    expect(who(target, 'https://other.example')).toBe('target')
    expect(indexedDb(target, 'https_app.example_0')).toBe('master')
    expect(existsSync(join(target, BASELINE_FILE))).toBe(true)
  })

  it('lets a source change made since the last fork win over a later logged-out visit on the target', async () => {
    const master = profile()
    const target = profile()
    setCookie(master, 'site.example', 's', 'none', 100n)
    setWho(master, 'https://site.example', 'none', 10)
    setIndexedDb(master, 'https_site.example_0', 'none', 1_000)
    await forkMerge(target, [master], options)

    // The person logs in on the main desktop; later the agent's desktop visits the site logged out.
    setCookie(master, 'site.example', 's', 'user', 300n)
    setWho(master, 'https://site.example', 'user', 30)
    setIndexedDb(master, 'https_site.example_0', 'user', 3_000)
    setCookie(target, 'site.example', 's', 'anon', 400n)
    setWho(target, 'https://site.example', 'anon', 40)
    setIndexedDb(target, 'https_site.example_0', 'anon', 4_000)
    setCookie(target, 'own.example', 't', 'own', 400n)

    const [report] = await forkMerge(target, [master], options)

    expect(report!.firstFork).toBe(false)
    expect(cookies(target)).toMatchObject({ s: 'user', t: 'own' })
    expect(who(target, 'https://site.example')).toBe('user')
    expect(indexedDb(target, 'https_site.example_0')).toBe('user')
  })

  it("keeps the target's own change when the source has not changed since the last fork", async () => {
    const master = profile()
    const target = profile()
    setCookie(master, 'site.example', 's', 'master', 100n)
    setWho(master, 'https://site.example', 'master', 10)
    await forkMerge(target, [master], options)
    setCookie(target, 'site.example', 's', 'agent-login', 500n)
    setWho(target, 'https://site.example', 'agent-login', 50)

    const [report] = await forkMerge(target, [master], options)

    expect(cookies(target)).toMatchObject({ s: 'agent-login' })
    expect(who(target, 'https://site.example')).toBe('agent-login')
    expect(report!.cookies).toMatchObject({ inserted: 0, updated: 0, deleted: 0 })
    expect(report!.localStorage.taken).toEqual([])
  })

  it('deletes a cookie the source deleted since the last fork, so a logout spreads', async () => {
    const master = profile()
    const target = profile()
    setCookie(master, 'site.example', 's', 'user', 100n)
    setCookie(master, 'site.example', 'prefs', 'dark', 100n)
    await forkMerge(target, [master], options)
    deleteCookie(master, 's')

    const [report] = await forkMerge(target, [master], options)

    expect(cookies(target)).toEqual({ prefs: 'dark' })
    expect(report!.cookies.deleted).toBe(1)
  })

  it('skips expired cookies', async () => {
    const master = profile()
    const target = profile()
    setCookie(master, 'site.example', 'old', 'x', 100n, 13_000_000_000_000_000n)

    const [report] = await forkMerge(target, [master], options)

    expect(cookies(target)).toEqual({})
    expect(report!.cookies.expired).toBe(1)
  })

  it("takes Chromium's own localStorage, tables and snappy blocks included", async () => {
    const master = profile()
    const target = profile()
    cpSync(join(FIXTURES, 'Local Storage'), join(master, 'Default', 'Local Storage'), { recursive: true })

    const [report] = await forkMerge(target, [master], options)

    expect(report!.localStorage.taken.sort()).toEqual(['http://127.0.0.1:8000', 'http://localhost:8000'])
    expect(who(target, 'http://127.0.0.1:8000')).toBe('fixture')
    expect(who(target, 'http://localhost:8000')).toBe('other')
    expect(readLevelDb(lsDir(target)).get('_http://127.0.0.1:8000\u0000\u0001big7')?.length).toBe(100_001)
  })
})
