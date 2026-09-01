import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { hostPackageCacheEnv, prepareRuntimeHome, runtimeHomeEnvironment } from '../src/runtimes/runtime-home.js'
import { extractOmpCredentials } from '../src/runtimes/omp-credentials.js'

function fixture(): { root: string; hostHome: string; scopeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-home-'))
  const hostHome = join(root, 'host')
  const scopeDir = join(root, 'agent')
  mkdirSync(join(hostHome, '.claude', 'sessions'), { recursive: true })
  mkdirSync(scopeDir)
  return { root, hostHome, scopeDir }
}

describe('private runtime HOME', () => {
  it('seeds only Claude model rollout cache and keeps other host state out', () => {
    const { hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"token":"host"}')
    writeFileSync(join(hostHome, '.claude', 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(hostHome, '.claude', 'state.sqlite'), 'do-not-copy')
    writeFileSync(join(hostHome, '.claude', 'sessions', 'old.json'), '{"old":true}')
    writeFileSync(
      join(hostHome, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }],
        mcpServers: { private: { token: 'do-not-copy' } },
        projects: { '/host/private': { allowedTools: [] } },
        oauthAccount: { emailAddress: 'do-not-copy@example.test' }
      })
    )

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.claude', '.credentials.json'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }]
    })
    // Global config also lands in CLAUDE_CONFIG_DIR (<home>/.claude), which is
    // where a CLAUDE_CONFIG_DIR-pinned Claude Code actually reads it (the feature
    // cache there gates newer models like Fable 5).
    expect(JSON.parse(readFileSync(join(home, '.claude', '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }]
    })
    expect(existsSync(join(home, '.claude', 'state.sqlite'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'sessions'))).toBe(false)
  })

  it('leaves Claude cold when the host global config has no model rollout cache', () => {
    const { hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude.json'), JSON.stringify({ mcpServers: { private: {} } }))

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    expect(existsSync(join(home, '.claude', '.claude.json'))).toBe(false)
  })

  it('seeds only Pi auth/settings from its nested agent directory', () => {
    const { hostHome, scopeDir } = fixture()
    const agentDir = join(hostHome, '.pi', 'agent')
    mkdirSync(join(agentDir, 'sessions'), { recursive: true })
    mkdirSync(join(agentDir, 'bin'))
    writeFileSync(join(agentDir, 'auth.json'), '{"provider":"host"}')
    writeFileSync(join(agentDir, 'settings.json'), '{"quietStartup":true}')
    writeFileSync(join(agentDir, 'sessions', 'old.jsonl'), 'do-not-copy')
    writeFileSync(join(agentDir, 'bin', 'fd'), 'do-not-copy')

    const home = prepareRuntimeHome('pi-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.pi', 'agent', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.pi', 'agent', 'sessions'))).toBe(false)
    expect(existsSync(join(home, '.pi', 'agent', 'bin'))).toBe(false)

    const env = runtimeHomeEnvironment('pi-acp', home, {}, { HOME: hostHome })
    expect(env.PI_CODING_AGENT_DIR).toBe(join(home, '.pi', 'agent'))
  })

  it('seeds Qoder config + browser-login credentials without copying sessions', () => {
    const { hostHome, scopeDir } = fixture()
    const qoder = join(hostHome, '.qoder')
    mkdirSync(join(qoder, 'sessions'), { recursive: true })
    writeFileSync(join(qoder, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(qoder, '.keychain-salt'), 'salt-bytes')
    writeFileSync(join(qoder, 'qoder-cli-credentials.json'), '{"token":"host"}')
    writeFileSync(join(qoder, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('qoder-cli', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.qoder', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.qoder', '.keychain-salt'))).toBe(true)
    expect(readFileSync(join(home, '.qoder', 'qoder-cli-credentials.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.qoder', 'sessions'))).toBe(false)
  })

  it('strips host Qoder config-dir overrides so isolation cannot be bypassed', () => {
    const { hostHome, scopeDir } = fixture()
    const home = prepareRuntimeHome('qoder-cli', scopeDir, { HOME: hostHome })
    const env = runtimeHomeEnvironment(
      'qoder-cli',
      home,
      {},
      {
        HOME: hostHome,
        QODER_CONFIG_DIR: '/host/leak',
        QODER_CLI_HOME: '/host/leak',
        GEMINI_CLI_HOME: '/host/leak'
      }
    )
    expect(env.HOME).toBe(home)
    expect(env.QODER_CONFIG_DIR).toBe(join(home, '.qoder'))
    expect(env.QODER_CLI_HOME).toBeUndefined()
    expect(env.GEMINI_CLI_HOME).toBeUndefined()
  })

  it('seeds DeepSeek Harness credentials and pins $DSH_HOME into the private home', () => {
    const { hostHome, scopeDir } = fixture()
    const dsh = join(hostHome, '.dsh')
    mkdirSync(join(dsh, 'sessions'), { recursive: true })
    writeFileSync(join(dsh, '.credentials.yaml'), 'deepseek: host-key')
    writeFileSync(join(dsh, '.env'), 'DEEPSEEK_BASE_URL=https://host.example')
    writeFileSync(join(dsh, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('dsh-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('host-key')
    expect(existsSync(join(home, '.dsh', '.env'))).toBe(true)
    expect(existsSync(join(home, '.dsh', 'sessions'))).toBe(false)

    const env = runtimeHomeEnvironment('dsh-acp', home, {}, { HOME: hostHome, DSH_HOME: '/host/leak' })
    expect(env.DSH_HOME).toBe(join(home, '.dsh'))
  })

  it('seeds the OpenClaw gateway config and pins $OPENCLAW_STATE_DIR into the private home', () => {
    const { hostHome, scopeDir } = fixture()
    const openclaw = join(hostHome, '.openclaw')
    mkdirSync(join(openclaw, 'sessions'), { recursive: true })
    writeFileSync(join(openclaw, 'openclaw.json'), '{"gateway":{"url":"ws://127.0.0.1:18789","token":"host-token"}}')
    writeFileSync(join(openclaw, '.env'), 'OPENCLAW_GATEWAY_TOKEN=host-token')
    writeFileSync(join(openclaw, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('openclaw', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toContain('18789')
    expect(existsSync(join(home, '.openclaw', '.env'))).toBe(true)
    expect(existsSync(join(home, '.openclaw', 'sessions'))).toBe(false)

    const env = runtimeHomeEnvironment(
      'openclaw',
      home,
      {},
      {
        HOME: hostHome,
        OPENCLAW_STATE_DIR: '/host/leak',
        OPENCLAW_HOME: '/host/leak-home',
        OPENCLAW_CONFIG_PATH: '/host/leak.json',
        OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:19000'
      }
    )
    expect(env.OPENCLAW_STATE_DIR).toBe(join(home, '.openclaw'))
    expect(env.OPENCLAW_HOME).toBeUndefined()
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined()
    // Gateway connection overrides are credentials, not user state — inherited.
    expect(env.OPENCLAW_GATEWAY_URL).toBe('ws://127.0.0.1:19000')
  })

  it('seeds a relocated $OPENCLAW_CONFIG_PATH config ahead of the stale state-dir copy', () => {
    const { root, hostHome, scopeDir } = fixture()
    mkdirSync(join(hostHome, '.openclaw'), { recursive: true })
    writeFileSync(join(hostHome, '.openclaw', 'openclaw.json'), '{"gateway":{"url":"ws://stale.invalid"}}')
    const configPath = join(root, 'etc-openclaw.json')
    writeFileSync(configPath, '{"gateway":{"url":"ws://127.0.0.1:18789"}}')

    const home = prepareRuntimeHome('openclaw', scopeDir, { HOME: hostHome, OPENCLAW_CONFIG_PATH: configPath })
    expect(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toContain('18789')
  })

  it('seeds Cline provider auth from its data directory without copying databases', () => {
    const { hostHome, scopeDir } = fixture()
    const clineDir = join(hostHome, '.cline')
    mkdirSync(join(clineDir, 'data', 'settings'), { recursive: true })
    mkdirSync(join(clineDir, 'data', 'db'))
    mkdirSync(join(clineDir, 'data', 'logs'))
    writeFileSync(join(clineDir, 'data', 'settings', 'providers.json'), '{"providers":{"host":{}}}')
    writeFileSync(join(clineDir, 'data', 'db', 'sessions.db'), 'do-not-copy')
    writeFileSync(join(clineDir, 'data', 'logs', 'cline.log'), 'do-not-copy')

    const home = prepareRuntimeHome('cline', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.cline', 'data', 'settings', 'providers.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.cline', 'data', 'db'))).toBe(false)
    expect(existsSync(join(home, '.cline', 'data', 'logs'))).toBe(false)

    const env = runtimeHomeEnvironment(
      'cline',
      home,
      {},
      {
        HOME: hostHome,
        CLINE_DATA_DIR: '/tmp/shared-cline-data',
        CLINE_PROVIDER_SETTINGS_PATH: '/tmp/shared-providers.json'
      }
    )
    expect(env.CLINE_DIR).toBe(join(home, '.cline'))
    expect(env.CLINE_DATA_DIR).toBe(join(home, '.cline', 'data'))
    expect(env.CLINE_PROVIDER_SETTINGS_PATH).toBeUndefined()
  })

  it('uses private HOME/XDG state and drops ambient tool state overrides', () => {
    const { hostHome, scopeDir } = fixture()
    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    const env = runtimeHomeEnvironment(
      'claude-acp',
      home,
      { NPM_CONFIG_REGISTRY: 'https://registry.example.test' },
      {
        HOME: hostHome,
        PATH: '/usr/bin',
        NPM_CONFIG_CACHE: '/tmp/shared-cache',
        CARGO_HOME: '/tmp/shared-cargo',
        RUSTUP_HOME: '/tmp/shared-rustup'
      }
    )

    expect(env.HOME).toBe(home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
    expect(env.XDG_CACHE_HOME).toBe(join(home, '.cache'))
    expect(env.NPM_CONFIG_CACHE).toBeUndefined()
    expect(env.CARGO_HOME).toBeUndefined()
    expect(env.RUSTUP_HOME).toBeUndefined()
    expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.example.test')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('moves legacy per-agent runtime state under the private HOME', () => {
    const { hostHome, scopeDir } = fixture()
    const legacyMemory = join(scopeDir, '.claude', 'projects', 'workspace', 'memory')
    mkdirSync(legacyMemory, { recursive: true })
    writeFileSync(join(legacyMemory, 'MEMORY.md'), 'legacy memory')

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.claude', 'projects', 'workspace', 'memory', 'MEMORY.md'), 'utf8')).toBe(
      'legacy memory'
    )
    expect(existsSync(join(scopeDir, '.claude'))).toBe(false)
  })

  it('refuses to seed through a symlink created inside the private HOME', () => {
    const { root, hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"token":"host"}')
    const home = join(scopeDir, 'home')
    const outside = join(root, 'outside')
    mkdirSync(home)
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.claude'))

    expect(() => prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })).toThrow(/symlink/)
  })

  it('seeds only reviewed curated config files and maps every private state root', () => {
    const { hostHome, scopeDir } = fixture()
    const hermes = join(hostHome, '.hermes')
    const interpreter = join(hostHome, '.openinterpreter')
    const kiro = join(hostHome, '.kiro')
    const zeroclaw = join(hostHome, '.zeroclaw')
    mkdirSync(join(hermes, 'memories'), { recursive: true })
    mkdirSync(join(interpreter, 'sessions'), { recursive: true })
    mkdirSync(join(kiro, 'settings'), { recursive: true })
    mkdirSync(join(kiro, 'sessions'), { recursive: true })
    mkdirSync(join(zeroclaw, 'data'), { recursive: true })
    writeFileSync(join(hermes, 'config.yaml'), 'model: test')
    writeFileSync(join(hermes, 'memories', 'private.md'), 'do-not-copy')
    writeFileSync(join(interpreter, 'config.toml'), 'model = "test"')
    writeFileSync(join(interpreter, 'sessions', 'old.json'), 'do-not-copy')
    writeFileSync(join(kiro, 'settings', 'cli.json'), '{}')
    writeFileSync(join(kiro, 'sessions', 'old.json'), 'do-not-copy')
    writeFileSync(join(zeroclaw, 'config.toml'), 'provider = "test"')
    writeFileSync(join(zeroclaw, 'data', 'memory.db'), 'do-not-copy')

    const hermesHome = prepareRuntimeHome('hermes-agent', join(scopeDir, 'hermes'), { HOME: hostHome })
    const interpreterHome = prepareRuntimeHome('open-interpreter', join(scopeDir, 'interpreter'), { HOME: hostHome })
    const kiroHome = prepareRuntimeHome('kiro-cli', join(scopeDir, 'kiro'), { HOME: hostHome })
    const zeroclawHome = prepareRuntimeHome('zeroclaw', join(scopeDir, 'zeroclaw'), { HOME: hostHome })

    expect(existsSync(join(hermesHome, '.hermes', 'config.yaml'))).toBe(true)
    expect(existsSync(join(hermesHome, '.hermes', 'memories'))).toBe(false)
    expect(existsSync(join(interpreterHome, '.openinterpreter', 'config.toml'))).toBe(true)
    expect(existsSync(join(interpreterHome, '.openinterpreter', 'sessions'))).toBe(false)
    expect(existsSync(join(kiroHome, '.kiro', 'settings', 'cli.json'))).toBe(true)
    expect(existsSync(join(kiroHome, '.kiro', 'sessions'))).toBe(false)
    expect(existsSync(join(zeroclawHome, '.zeroclaw', 'config.toml'))).toBe(true)
    expect(existsSync(join(zeroclawHome, '.zeroclaw', 'data'))).toBe(false)

    expect(runtimeHomeEnvironment('hermes-agent', hermesHome).HERMES_HOME).toBe(join(hermesHome, '.hermes'))
    expect(runtimeHomeEnvironment('open-interpreter', interpreterHome).INTERPRETER_HOME).toBe(
      join(interpreterHome, '.openinterpreter')
    )
    expect(runtimeHomeEnvironment('open-interpreter', interpreterHome).CODEX_HOME).toBe(join(interpreterHome, '.codex'))
    expect(runtimeHomeEnvironment('kiro-cli', kiroHome).KIRO_HOME).toBe(join(kiroHome, '.kiro'))
    expect(runtimeHomeEnvironment('zeroclaw', zeroclawHome).ZEROCLAW_CONFIG_DIR).toBe(join(zeroclawHome, '.zeroclaw'))
    expect(runtimeHomeEnvironment('zeroclaw', zeroclawHome).ZEROCLAW_DATA_DIR).toBe(
      join(zeroclawHome, '.zeroclaw', 'data')
    )
  })

  it('seeds Maki config without copying XDG data/state memory', () => {
    const { root, hostHome, scopeDir } = fixture()
    const config = join(root, 'config')
    const data = join(root, 'data')
    const state = join(root, 'state')
    mkdirSync(join(config, 'maki'), { recursive: true })
    mkdirSync(join(data, 'maki'), { recursive: true })
    mkdirSync(join(state, 'maki'), { recursive: true })
    writeFileSync(join(config, 'maki', 'init.lua'), 'maki.setup({})')
    writeFileSync(join(config, 'maki', 'permissions.toml'), 'default = "ask"')
    writeFileSync(join(data, 'maki', 'memory.db'), 'do-not-copy')
    writeFileSync(join(state, 'maki', 'session.db'), 'do-not-copy')

    const home = prepareRuntimeHome('maki', scopeDir, {
      HOME: hostHome,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state
    })

    expect(existsSync(join(home, '.config', 'maki', 'init.lua'))).toBe(true)
    expect(existsSync(join(home, '.config', 'maki', 'permissions.toml'))).toBe(true)
    expect(existsSync(join(home, '.local', 'share', 'maki', 'memory.db'))).toBe(false)
    expect(existsSync(join(home, '.local', 'state', 'maki', 'session.db'))).toBe(false)
  })

  it('extracts only OMP credential tables from a WAL database above the generic seed limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-db-'))
    const sourcePath = join(root, 'agent.db')
    const destinationPath = join(root, 'private', 'agent.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE padding (payload BLOB NOT NULL);
      INSERT INTO auth_schema_version VALUES (1, 3);
      INSERT INTO settings VALUES ('theme', 'dark');
      INSERT INTO padding VALUES (zeroblob(3145728));
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO auth_credentials(provider, credential_type, data, created_at, updated_at)
        VALUES ('anthropic', 'api_key', '{"key":"secret"}', 1, 1);
    `)
    expect(statSync(sourcePath).size).toBeGreaterThan(2 * 1024 * 1024)
    const sourceDigest = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')

    extractOmpCredentials(sourcePath, destinationPath)

    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceDigest)
    source.close()
    const destination = new DatabaseSync(destinationPath, { readOnly: true })
    const tables = destination
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toEqual(['auth_credentials', 'auth_schema_version'])
    expect(destination.prepare('SELECT provider, data FROM auth_credentials').get()).toEqual({
      provider: 'anthropic',
      data: '{"key":"secret"}'
    })
    destination.close()
  })

  it('rejects an oversized OMP credential row', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-large-'))
    const sourcePath = join(root, 'agent.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT);
      INSERT INTO auth_schema_version VALUES (1, 1);
    `)
    source.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?)').run(1, 'test', 'x'.repeat(300 * 1024))
    source.close()

    expect(() => extractOmpCredentials(sourcePath, join(root, 'private.db'))).toThrow(/credential row/i)
  })

  it('refuses an OMP credential destination symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-symlink-'))
    const sourcePath = join(root, 'agent.db')
    const outsidePath = join(root, 'outside.db')
    const destinationPath = join(root, 'private.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT);
      INSERT INTO auth_schema_version VALUES (1, 1);
    `)
    source.close()
    writeFileSync(outsidePath, 'outside')
    symlinkSync(outsidePath, destinationPath)

    expect(() => extractOmpCredentials(sourcePath, destinationPath)).toThrow(/symlink/i)
    expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
  })
})

describe('hostPackageCacheEnv', () => {
  it('pins npx at the host npm cache so a fresh probe HOME does not rebuild the tree', () => {
    expect(hostPackageCacheEnv('npx', { HOME: '/host' })).toEqual({ npm_config_cache: join('/host', '.npm') })
  })

  it('honors an ambient npm cache override', () => {
    expect(hostPackageCacheEnv('npx', { HOME: '/host', NPM_CONFIG_CACHE: '/shared/npm' })).toEqual({
      npm_config_cache: '/shared/npm'
    })
  })

  it('pins uvx at the host uv cache, honoring XDG_CACHE_HOME', () => {
    expect(hostPackageCacheEnv('uvx', { HOME: '/host' })).toEqual({ UV_CACHE_DIR: join('/host', '.cache', 'uv') })
    expect(hostPackageCacheEnv('uvx', { HOME: '/host', XDG_CACHE_HOME: '/xdg' })).toEqual({
      UV_CACHE_DIR: join('/xdg', 'uv')
    })
  })

  it('pins nothing for a real binary distribution', () => {
    expect(hostPackageCacheEnv('qodercli', { HOME: '/host' })).toEqual({})
    expect(hostPackageCacheEnv(undefined, { HOME: '/host' })).toEqual({})
  })
})
