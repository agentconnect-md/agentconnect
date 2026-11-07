import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readOmpApiCredentials } from '../src/runtimes/omp-credentials.js'

// The runtimes whose preparers protect API keys kept in their own files: one key each, beside an OAuth sign-in where the runtime has one.
export interface RuntimeKeyFixture {
  runtime: string
  key: string
  /** The prefix of the hashed variable its preparer names the key by. */
  prefix: string
  provider: string
  host: string
  /** Whether the runtime sends the key in `x-api-key` rather than Authorization. */
  apiKeyHeader: boolean
  /** Write the host's files under a fake HOME. */
  seed(home: string): void
  /** The value a HOME's copy holds where the key was. */
  stored(home: string): string | undefined
  /** The OAuth sign-in as a HOME's copy holds it, and as the host wrote it. */
  oauth?: { read(home: string): unknown; expected: unknown }
}

function write(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

function toml(path: string): Record<string, any> {
  return parseToml(readFileSync(path, 'utf8')) as Record<string, any>
}

const PI_OAUTH = { type: 'oauth', access: 'fixture-pi-oauth-access', refresh: 'fixture-pi-oauth-refresh', expires: 1 }
const GROK_OAUTH = { auth_mode: 'oauth', access_token: 'fixture-grok-oauth', refresh_token: 'fixture-grok-refresh' }
const QWEN_OAUTH = { access_token: 'fixture-qwen-oauth', refresh_token: 'fixture-qwen-refresh', expiry_date: 1 }
const OMP_OAUTH = { access: 'fixture-omp-oauth', refresh: 'fixture-omp-refresh', expires: 1 }
const KIMI_OAUTH = { access_token: 'fixture-kimi-oauth', refresh_token: 'fixture-kimi-refresh', expires_at: 1 }
const AMP_NAME = 'apiKey@https://ampcode.com/'
const PI_AUTH = join('.pi', 'agent', 'auth.json')
const GROK_CONFIG = join('.grok', 'config.toml')
const QWEN_SETTINGS = join('.qwen', 'settings.json')
const OMP_DB = join('.omp', 'agent', 'agent.db')
const AMP_SECRETS = join('.local', 'share', 'amp', 'secrets.json')
const KIMI_CONFIG = join('.kimi-code', 'config.toml')
const CLINE_PROVIDERS = join('.cline', 'data', 'settings', 'providers.json')
const CLINE_OAUTH = {
  provider: 'cline',
  auth: { accessToken: 'fixture-cline-oauth', refreshToken: 'fixture-cline-refresh' }
}

/** An OMP credential database with one API key row and one OAuth row. */
export function writeOmpDatabase(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
        disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER
      );
      INSERT INTO auth_schema_version VALUES (1, 7);
    `)
    const insert = db.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, ?, NULL, NULL, 1, 1)')
    insert.run(1, 'anthropic', 'api_key', JSON.stringify({ key }))
    insert.run(2, 'openai', 'oauth', JSON.stringify(OMP_OAUTH))
  } finally {
    db.close()
  }
}

/** The OAuth row of an OMP credential database. */
export function ompOAuth(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return JSON.parse(String(db.prepare("SELECT data FROM auth_credentials WHERE credential_type='oauth'").get()!.data))
  } finally {
    db.close()
  }
}

export const RUNTIME_KEY_FIXTURES: RuntimeKeyFixture[] = [
  {
    runtime: 'pi-acp',
    key: 'fixture-pi-key',
    prefix: 'PI_API',
    provider: 'anthropic',
    host: 'api.anthropic.com',
    apiKeyHeader: true,
    seed: (home) =>
      write(join(home, PI_AUTH), { anthropic: { type: 'api_key', key: 'fixture-pi-key' }, openai: PI_OAUTH }),
    stored: (home) => json(join(home, PI_AUTH)).anthropic?.key,
    oauth: { read: (home) => json(join(home, PI_AUTH)).openai, expected: PI_OAUTH }
  },
  {
    runtime: 'grok-build',
    key: 'fixture-grok-key',
    prefix: 'AC_GROK_API',
    provider: 'xai',
    host: 'api.x.ai',
    apiKeyHeader: false,
    seed: (home) => {
      write(
        join(home, GROK_CONFIG),
        stringifyToml({ model: { fast: { base_url: 'https://api.x.ai/v1', api_key: 'fixture-grok-key' } } })
      )
      write(join(home, '.grok', 'auth.json'), { 'xai::oauth': GROK_OAUTH })
    },
    stored: (home) => toml(join(home, GROK_CONFIG)).model?.fast?.api_key,
    oauth: { read: (home) => json(join(home, '.grok', 'auth.json'))['xai::oauth'], expected: GROK_OAUTH }
  },
  {
    runtime: 'qwen-code',
    key: 'fixture-qwen-key',
    prefix: 'AC_QWEN_API',
    provider: 'openai',
    host: 'api.openai.com',
    apiKeyHeader: false,
    seed: (home) => {
      write(join(home, QWEN_SETTINGS), {
        modelProviders: {
          openai: [{ id: 'example-model', envKey: 'EXAMPLE_MODEL_KEY', baseUrl: 'https://api.openai.com/v1' }]
        },
        env: { EXAMPLE_MODEL_KEY: 'fixture-qwen-key' }
      })
      write(join(home, '.qwen', 'oauth_creds.json'), QWEN_OAUTH)
    },
    stored: (home) => json(join(home, QWEN_SETTINGS)).env?.EXAMPLE_MODEL_KEY,
    oauth: { read: (home) => json(join(home, '.qwen', 'oauth_creds.json')), expected: QWEN_OAUTH }
  },
  {
    runtime: 'omp',
    key: 'fixture-omp-key',
    prefix: 'AC_OMP_API',
    provider: 'anthropic',
    host: 'api.anthropic.com',
    apiKeyHeader: true,
    seed: (home) => writeOmpDatabase(join(home, OMP_DB), 'fixture-omp-key'),
    stored: (home) => readOmpApiCredentials(join(home, OMP_DB))[0]?.key,
    oauth: { read: (home) => ompOAuth(join(home, OMP_DB)), expected: OMP_OAUTH }
  },
  {
    runtime: 'amp-acp',
    key: 'fixture-amp-key',
    prefix: 'AC_AMP_API',
    provider: 'amp',
    host: 'ampcode.com',
    apiKeyHeader: false,
    seed: (home) => write(join(home, AMP_SECRETS), { [AMP_NAME]: 'fixture-amp-key' }),
    stored: (home) => json(join(home, AMP_SECRETS))[AMP_NAME]
  },
  {
    runtime: 'kimi',
    key: 'fixture-kimi-key',
    prefix: 'AC_KIMI_API',
    provider: 'openai',
    host: 'api.openai.com',
    apiKeyHeader: false,
    seed: (home) => {
      write(
        join(home, KIMI_CONFIG),
        stringifyToml({
          providers: {
            main: { type: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'fixture-kimi-key' },
            login: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } }
          }
        })
      )
      write(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), KIMI_OAUTH)
    },
    stored: (home) => toml(join(home, KIMI_CONFIG)).providers?.main?.api_key,
    oauth: { read: (home) => json(join(home, '.kimi-code', 'credentials', 'kimi-code.json')), expected: KIMI_OAUTH }
  },
  {
    runtime: 'cline',
    key: 'fixture-cline-key',
    prefix: 'AC_CLINE_API',
    provider: 'anthropic',
    host: 'api.anthropic.com',
    apiKeyHeader: true,
    seed: (home) =>
      write(join(home, CLINE_PROVIDERS), {
        version: 1,
        modes: {},
        providers: {
          anthropic: { settings: { provider: 'anthropic', apiKey: 'fixture-cline-key' }, tokenSource: 'manual' },
          cline: { settings: CLINE_OAUTH, tokenSource: 'oauth' }
        }
      }),
    stored: (home) => json(join(home, CLINE_PROVIDERS)).providers?.anthropic?.settings?.apiKey,
    oauth: { read: (home) => json(join(home, CLINE_PROVIDERS)).providers?.cline?.settings, expected: CLINE_OAUTH }
  }
]
