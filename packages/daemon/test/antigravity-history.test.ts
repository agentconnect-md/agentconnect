import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { LocalDriver } from '../src/acp/spawn-driver.js'
import { importAntigravityHistory } from '../src/runtime-defs/antigravity-history.js'

it('restores committed WAL history once and preserves the native continuation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-history-'))
  const legacy = join(home, '.gemini', 'antigravity-acp', 'conversations')
  const native = join(home, '.gemini', 'antigravity-cli', 'conversations')
  const id = randomUUID()
  const driver = new LocalDriver()
  const launch = { env: { PATH: process.env.PATH!, HOME: home, USERPROFILE: home } }
  mkdirSync(legacy, { recursive: true })
  const source = new DatabaseSync(join(legacy, id + '.db'))
  try {
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE turns(v); INSERT INTO turns VALUES ('old')")
    expect(await importAntigravityHistory(driver, launch, randomUUID())).toBe(false)
    await Promise.all([importAntigravityHistory(driver, launch, id), importAntigravityHistory(driver, launch, id)])
    expect(readdirSync(native)).toEqual([id + '.db'])
    const dest = new DatabaseSync(join(native, id + '.db'))
    try {
      expect(dest.prepare('SELECT v FROM turns').get()?.v).toBe('old')
      dest.exec("UPDATE turns SET v = 'continued'")
    } finally {
      dest.close()
    }
    expect(await importAntigravityHistory(driver, launch, id)).toBe(true)
    const reopened = new DatabaseSync(join(native, id + '.db'), { readOnly: true })
    try {
      expect(reopened.prepare('SELECT v FROM turns').get()?.v).toBe('continued')
      expect(source.prepare('SELECT v FROM turns').get()?.v).toBe('old')
    } finally {
      reopened.close()
    }
  } finally {
    source.close()
    rmSync(home, { recursive: true, force: true })
  }
})
