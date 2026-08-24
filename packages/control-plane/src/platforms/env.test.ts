/**
 * The platform env fold (§9 `envSchema`).
 *
 * `AppConfigSchema` used to spread two provider shapes by name. It now composes
 * whatever `platforms/env.ts` declares — which is only safe if the composed
 * schema still accepts EXACTLY what `loadConfig` accepted before, since every
 * key here is a deployment contract: a key that quietly stops being parsed reads
 * as "feature off" at boot, not as an error.
 *
 * So the first suite pins the current deployment contract, the second pins
 * that the composition and the four PROVIDER instances agree — the drift a
 * static list would otherwise hide — and the third pins the collision guards
 * that make the spread safe.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { AppConfigSchema, loadConfig } from '../config/env.js'
import { CP_PLATFORM_ENV_SCHEMAS, composeCpPlatformEnv } from './env.js'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'

/** Every supported deployment key. */
const EXPECTED_KEYS = [
  'ACK_TIMEOUT_MS',
  'API_KEY_PEPPER',
  'CORS_ORIGIN',
  'CRON_RUN_REAP_INTERVAL_SEC',
  'CRON_RUN_TTL_SEC',
  'DAEMON_DIST_TAG',
  'DAEMON_POOL_ENABLED',
  'DATABASE_URL',
  'FEISHU_PLATFORM_APP_ID',
  'FEISHU_PLATFORM_APP_SECRET',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_B64',
  'GITHUB_APP_SLUG',
  'GITLAB_BASE_URL',
  'GITLAB_CLIENT_ID',
  'GITLAB_CLIENT_SECRET',
  'HEARTBEAT_SEC',
  'HOST',
  'LARK_PLATFORM_APP_ID',
  'LARK_PLATFORM_APP_SECRET',
  'LOGTO_MGMT_APP_ID',
  'LOGTO_MGMT_APP_SECRET',
  'LOGTO_MGMT_ENDPOINT',
  'LOGTO_MGMT_RESOURCE',
  'MISSED_BEATS',
  'NODE_ENV',
  'OIDC_AUDIENCE',
  'OIDC_ISSUER',
  'OPEN_CONNECTOR_PROVIDER_BLOCKLIST',
  'OPEN_CONNECTOR_PROVIDER_WHITELIST',
  'OPEN_CONNECTOR_URL',
  'PORT',
  'PRESET_AGENTS_ENABLED',
  'PRESET_AGENT_POOL_MODEL',
  'PRESET_AGENT_POOL_RUNTIME',
  'PUBLIC_CP_URL',
  'PUBLIC_MCP_URL',
  'PUBLIC_RELAY_URL',
  'PUBLIC_WEB_URL',
  'REASSIGN_GRACE_SEC',
  'RELAY_REAP_INTERVAL_SEC',
  'RELAY_STALE_SEC',
  'RELAY_TOKEN',
  'RELAY_WS_PATH',
  'S3_ACCESS_KEY_ID',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_PUBLIC_BASE_URL',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
  'SECRETS_PROVIDER',
  'SECRET_CIPHER',
  'SESSION_ACCESS_IDENTITY_TTL_SEC',
  'SESSION_ACCESS_PUBLIC_TTL_SEC',
  'SESSION_ACCESS_RECHECK_SEC',
  'SLACK_INSTALL_REAP_INTERVAL_SEC',
  'SLACK_INSTALL_TTL_SEC',
  'SLACK_PLATFORM_APP_ID',
  'SLACK_PLATFORM_CLIENT_ID',
  'SLACK_PLATFORM_CLIENT_SECRET',
  'SLACK_PLATFORM_SIGNING_SECRET',
  'USAGE_COLLECTOR_SERVICE_ACCOUNT',
  'USAGE_INGEST_TOKEN',
  'VAULT_ADDR',
  'VAULT_AUTH_MOUNT',
  'VAULT_JWT_PATH',
  'VAULT_JWT_ROLE',
  'VAULT_NAMESPACE',
  'VAULT_TOKEN',
  'VAULT_TRANSIT_KEY',
  'VAULT_TRANSIT_ORG_KEY_PREFIX',
  'VAULT_TRANSIT_MOUNT',
  'WAITLIST_MODE',
  'WS_PATH'
] as const

/** The minimum a boot needs; every other key is optional or defaulted. */
const MINIMAL_ENV = {
  DATABASE_URL: 'postgres://user:pass@db.example.test:5432/cp',
  API_KEY_PEPPER: 'x'.repeat(32)
}

describe('composed AppConfigSchema', () => {
  it('accepts exactly the supported deployment keys', () => {
    expect(Object.keys(AppConfigSchema.shape).sort()).toEqual([...EXPECTED_KEYS].sort())
  })

  it('keeps each platform key parsing as its provider declared it', () => {
    const config = loadConfig({
      ...MINIMAL_ENV,
      SLACK_INSTALL_TTL_SEC: '120',
      SLACK_PLATFORM_APP_ID: 'A1',
      SLACK_PLATFORM_CLIENT_ID: 'cid',
      SLACK_PLATFORM_CLIENT_SECRET: 'csecret',
      SLACK_PLATFORM_SIGNING_SECRET: 'sig',
      FEISHU_PLATFORM_APP_ID: 'cli_feishu',
      FEISHU_PLATFORM_APP_SECRET: 'fsecret',
      LARK_PLATFORM_APP_ID: 'cli_lark',
      LARK_PLATFORM_APP_SECRET: 'lsecret'
    } as NodeJS.ProcessEnv)

    // Coerced number + the reaper default that is NOT in the environment.
    expect(config.SLACK_INSTALL_TTL_SEC).toBe(120)
    expect(config.SLACK_INSTALL_REAP_INTERVAL_SEC).toBe(600)
    expect(config.SLACK_PLATFORM_APP_ID).toBe('A1')
    expect(config.FEISHU_PLATFORM_APP_SECRET).toBe('fsecret')
    expect(config.LARK_PLATFORM_APP_ID).toBe('cli_lark')
  })

  it('leaves every platform key optional — an unset one never fail-fasts a boot', () => {
    const config = loadConfig(MINIMAL_ENV as NodeJS.ProcessEnv)
    expect(config.SLACK_PLATFORM_APP_ID).toBeUndefined()
    expect(config.FEISHU_PLATFORM_APP_ID).toBeUndefined()
    expect(config.SLACK_INSTALL_TTL_SEC).toBe(3600)
  })
})

describe('platform env declarations', () => {
  it('match what the production providers declare (no drift between list and provider)', () => {
    const registry = buildCpPlatformRegistry([
      createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
      createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
      createSlackCpProvider({}),
      createFeishuCpProvider({})
    ])
    const fromProviders = registry
      .all()
      .flatMap((provider) => Object.keys(provider.envSchema ?? {}))
      .sort()
    const fromDeclaration = CP_PLATFORM_ENV_SCHEMAS.flatMap(({ envSchema }) => Object.keys(envSchema)).sort()

    expect(fromDeclaration).toEqual(fromProviders)
    // …and both are what the composed schema actually folded in.
    expect(Object.keys(composeCpPlatformEnv([])).sort()).toEqual(fromProviders)
  })

  it('declares nothing for a platform with no deployment configuration', () => {
    for (const platformId of ['telegram', 'discord']) {
      expect(CP_PLATFORM_ENV_SCHEMAS.some((decl) => decl.platformId === platformId)).toBe(false)
    }
  })
})

describe('fold collision guards', () => {
  it('refuses a platform key that shadows a core one', () => {
    // The real declaration, folded against a core list that claims one of its keys.
    expect(() => composeCpPlatformEnv(['SLACK_INSTALL_TTL_SEC'])).toThrow(
      /platform slack env key shadows a core config key: SLACK_INSTALL_TTL_SEC/
    )
  })

  it('refuses two platforms claiming one key', () => {
    const claim = (platformId: string) => ({ platformId, envSchema: { SHARED_KEY: z.string().optional() } })
    expect(() => composeCpPlatformEnv([], [claim('alpha'), claim('beta')])).toThrow(
      /platform env key SHARED_KEY is declared by both alpha and beta/
    )
  })

  it('folds a newly declared platform in with no core edit', () => {
    const composed = composeCpPlatformEnv(Object.keys(AppConfigSchema.shape), [
      { platformId: 'mastodon', envSchema: { MASTODON_INSTANCE_URL: z.string().url().optional() } }
    ])
    expect(Object.keys(composed)).toEqual(['MASTODON_INSTANCE_URL'])
  })
})
