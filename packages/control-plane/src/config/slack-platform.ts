/**
 * Platform-published (distributed) Slack app deployment identity
 * (docs/designs/preset-agents.md §5.3).
 *
 * One Slack app, published by the platform operator, that every org installs
 * into its own workspace via standard OAuth v2 — the "Add to Slack" path. The
 * client secret + signing secret are DEPLOYMENT CONFIG: they never leave env →
 * process memory except that the signing secret is stored per-Bot (sealed via
 * SecretCipher, like every bot's) so the existing relay assign path verifies
 * inbound events unchanged.
 *
 * Opt-in mirrors resolveGithubAppConfig: all four vars ⇒ enabled; none ⇒ feature
 * absent (self-hosted default). A PARTIAL set is a deploy mistake ⇒ fail fast
 * naming the missing vars rather than silently running degraded.
 */
import type { AppConfig } from './env.js'

export interface SlackPlatformAppConfig {
  appId: string // A… — == the Events API envelope `api_app_id`
  clientId: string
  clientSecret: string
  signingSecret: string
}

type SlackPlatformEnvSlice = Pick<
  AppConfig,
  | 'SLACK_PLATFORM_APP_ID'
  | 'SLACK_PLATFORM_CLIENT_ID'
  | 'SLACK_PLATFORM_CLIENT_SECRET'
  | 'SLACK_PLATFORM_SIGNING_SECRET'
>

/** Undefined ⇒ feature disabled. Throws on a partial set. */
export function resolveSlackPlatformAppConfig(config: SlackPlatformEnvSlice): SlackPlatformAppConfig | undefined {
  const present = {
    SLACK_PLATFORM_APP_ID: config.SLACK_PLATFORM_APP_ID !== undefined,
    SLACK_PLATFORM_CLIENT_ID: config.SLACK_PLATFORM_CLIENT_ID !== undefined,
    SLACK_PLATFORM_CLIENT_SECRET: config.SLACK_PLATFORM_CLIENT_SECRET !== undefined,
    SLACK_PLATFORM_SIGNING_SECRET: config.SLACK_PLATFORM_SIGNING_SECRET !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  if (set === 0) return undefined
  if (set < 4) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    throw new Error(`slack platform app config is partial — missing ${missing.join(', ')} (set all four or none)`)
  }
  return {
    appId: config.SLACK_PLATFORM_APP_ID!,
    clientId: config.SLACK_PLATFORM_CLIENT_ID!,
    clientSecret: config.SLACK_PLATFORM_CLIENT_SECRET!,
    signingSecret: config.SLACK_PLATFORM_SIGNING_SECRET!
  }
}
