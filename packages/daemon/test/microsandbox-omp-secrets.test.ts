import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'
import { discoverOmpCredentialProviders, readOmpApiCredentials } from '../src/runtimes/omp-credentials.js'
import { prepareRuntimeHome } from '../src/runtimes/runtime-home.js'

const roots: string[] = []
const key = 'fixture-omp-api-key'
const oauth = { access: 'fixture-oauth-access', refresh: 'fixture-oauth-refresh', expires: 1 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ac-omp-api-'))
  roots.push(root)
  const source = join(root, 'host', 'relocated-omp')
  const scopeDir = join(root, 'agent'),
    cwd = join(scopeDir, 'workspace')
  mkdirSync(source, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const db = new DatabaseSync(join(source, 'agent.db'))
  db.exec(`
    CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
      disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER
    );
    INSERT INTO auth_schema_version VALUES (1, 7);
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO cache VALUES ('host-only', 'private-host-cache');
  `)
  db.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, ?, ?, NULL, 1, 1)').run(
    1,
    'deepseek',
    'api_key',
    JSON.stringify({ key, source: 'login' }),
    'expired'
  )
  db.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, ?, NULL, NULL, 1, 1)').run(
    2,
    'anthropic',
    'oauth',
    JSON.stringify(oauth)
  )
  db.close()
  writeFileSync(join(source, 'config.yml'), 'modelRoles:\n  default: deepseek/deepseek-v4-flash\n')
  return {
    root,
    source,
    scopeDir,
    cwd,
    mounts: [],
    runtimeId: 'omp',
    runtime: { command: 'omp', args: ['acp'], env: [] },
    stateSourceEnv: { HOME: join(root, 'host'), PI_CODING_AGENT_DIR: source }
  }
}
function withDatabase<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try {
    return work(db)
  } finally {
    db.close()
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('keeps discovery and SRT native SQLite seeding unchanged', () => {
  const opts = fixture()
  expect(discoverOmpCredentialProviders(join(opts.source, 'agent.db'))).toEqual(['anthropic', 'deepseek'])
  const home = prepareRuntimeHome('omp', opts.scopeDir, opts.stateSourceEnv)
  expect(readOmpApiCredentials(join(home, '.omp/agent/agent.db'))[0]?.key).toBe(key)
  withDatabase(join(opts.source, 'agent.db'), (db) =>
    db.exec("DELETE FROM auth_credentials WHERE credential_type='api_key'")
  )
  expect(prepareMicrosandboxCredentials('omp', opts.runtime, opts.stateSourceEnv)).toBeUndefined()
})

describe.skipIf(process.platform !== 'linux')('microsandbox OMP SQLite API credentials', () => {
  it('seeds placeholders directly from a host WAL snapshot, with native OAuth and no host cache', () => {
    const opts = fixture(),
      source = join(opts.source, 'agent.db')
    const host = new DatabaseSync(source)
    try {
      host.exec(
        'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE padding(data BLOB); INSERT INTO padding VALUES(zeroblob(3145728)); PRAGMA wal_checkpoint(TRUNCATE);'
      )
      host
        .prepare('UPDATE auth_credentials SET data=? WHERE id=1')
        .run(JSON.stringify({ key: 'fixture-wal-key', source: 'login' }))
      const launch = prepareMicrosandboxLaunch(opts),
        secret = launch.microsandbox.secrets![0]!
      expect(secret.readValue()).toBe('fixture-wal-key')
      expect(secret.host).toEqual(['api.deepseek.com'])
      expect(JSON.stringify(launch)).not.toContain('fixture-wal-key')
      const directory = launch.env.PI_CODING_AGENT_DIR!
      expect(readOmpApiCredentials(join(directory, 'agent.db'))[0]?.key).toBe(secret.placeholder)
      for (const file of readdirSync(directory, { withFileTypes: true }).filter((file) => file.isFile()))
        expect(readFileSync(join(directory, file.name)).includes(Buffer.from('fixture-wal-key'))).toBe(false)
      withDatabase(join(directory, 'agent.db'), (db) => {
        expect(JSON.parse(String(db.prepare('SELECT data FROM auth_credentials WHERE id=2').get()!.data))).toEqual(
          oauth
        )
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('cache', 'padding')").all()).toEqual([])
      })
      expect(readOmpApiCredentials(source)[0]?.key).toBe('fixture-wal-key')
      for (const path of [opts.source, source, `${source}-wal`])
        expect(() =>
          prepareMicrosandboxLaunch({ ...opts, mounts: [{ source: path, target: '/raw-state', mode: 'readonly' }] })
        ).toThrow(/protected host/)
    } finally {
      host.close()
    }
  })

  it('rotates host values without rewriting retained SQLite, including live OAuth and usage WAL state', () => {
    const opts = fixture(),
      launch = prepareMicrosandboxLaunch(opts)
    const path = join(launch.env.PI_CODING_AGENT_DIR!, 'agent.db'),
      guest = new DatabaseSync(path)
    try {
      guest.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE usage_history(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO usage_history VALUES('guest-usage');"
      )
      guest
        .prepare('UPDATE auth_credentials SET data=? WHERE id=2')
        .run(JSON.stringify({ ...oauth, access: 'fixture-refreshed' }))
      const before = [readFileSync(path), readFileSync(`${path}-wal`)]
      withDatabase(join(opts.source, 'agent.db'), (db) =>
        db
          .prepare('UPDATE auth_credentials SET data=? WHERE id=1')
          .run(JSON.stringify({ key: 'fixture-rotated-key', source: 'login' }))
      )
      const resumed = prepareMicrosandboxLaunch(opts)
      expect(resumed.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
      expect(resumed.microsandbox.secrets![0]!.placeholder).toBe(launch.microsandbox.secrets![0]!.placeholder)
      expect([readFileSync(path), readFileSync(`${path}-wal`)]).toEqual(before)
      expect(guest.prepare('SELECT value FROM usage_history').get()!.value).toBe('guest-usage')
      expect(String(guest.prepare('SELECT data FROM auth_credentials WHERE id=2').get()!.data)).toContain(
        'fixture-refreshed'
      )
    } finally {
      guest.close()
    }
  })

  it('hides unknown providers and refuses retained plaintext or changed host credentials without rewriting them', () => {
    const opts = fixture()
    withDatabase(join(opts.source, 'agent.db'), (db) =>
      db.exec("UPDATE auth_credentials SET provider='custom-provider' WHERE id=1")
    )
    const launch = prepareMicrosandboxLaunch(opts),
      path = join(launch.env.PI_CODING_AGENT_DIR!, 'agent.db')
    expect(launch.microsandbox.secrets).toEqual([])
    expect(readOmpApiCredentials(path)[0]?.key).toMatch(/^msb-secret-/)
    withDatabase(path, (db) => db.prepare('UPDATE auth_credentials SET data=? WHERE id=1').run(JSON.stringify({ key })))
    const before = readFileSync(path)
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow(/start a new session/)
    expect(readFileSync(path)).toEqual(before)
    const fresh = fixture(),
      protection = prepareMicrosandboxCredentials('omp', fresh.runtime, fresh.stateSourceEnv)!
    const home = prepareRuntimeHome('omp', fresh.scopeDir, fresh.stateSourceEnv, undefined, protection.seedExclusions)
    expect(existsSync(join(home, '.omp/agent/agent.db'))).toBe(false)
    withDatabase(join(fresh.source, 'agent.db'), (db) =>
      db.prepare('UPDATE auth_credentials SET data=? WHERE id=1').run(JSON.stringify({ key: 'fixture-changed' }))
    )
    expect(() => protection.preparePrivateHome(home)).toThrow(/changed/)
    expect(existsSync(join(home, '.omp/agent/agent.db'))).toBe(false)
  })

  it('refuses private database and WAL symlinks and orphan sidecars', () => {
    for (const suffix of ['', '-wal']) {
      const opts = fixture(),
        launch = prepareMicrosandboxLaunch(opts)
      const path = join(launch.env.PI_CODING_AGENT_DIR!, `agent.db${suffix}`)
      rmSync(path, { force: true })
      symlinkSync(join(opts.source, 'agent.db'), path)
      expect(() => prepareMicrosandboxLaunch(opts)).toThrow(/start a new session/)
      expect(readOmpApiCredentials(join(opts.source, 'agent.db'))[0]?.key).toBe(key)
    }
    const opts = fixture(),
      privateDir = join(opts.scopeDir, 'home/.omp/agent')
    mkdirSync(privateDir, { recursive: true })
    writeFileSync(join(privateDir, 'agent.db-wal'), 'orphan')
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow(/start a new session/)
    expect(existsSync(join(privateDir, 'agent.db'))).toBe(false)
  })
})
