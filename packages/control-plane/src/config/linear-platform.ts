/**
 * The deployment's one Linear OAuth app (docs/designs/linear-integration.md §4.3, §7.1).
 *
 * Linear has no app-creation API, so a deployment administrator creates ONE OAuth app by hand and
 * records its three values as deployment config — the same class of deployment infrastructure as
 * the GitHub App and the platform Slack app, and never per organization or per agent. The client
 * secret exchanges and refreshes workspace grants; the webhook signing secret is the only value
 * that reaches the relay (through the `rc/bot-assign` secrets bag).
 *
 * Opt-in mirrors `resolveSlackPlatformAppConfig`: all three vars ⇒ enabled; none ⇒ the platform is
 * absent and its console surface stays hidden (the self-disable pattern). A PARTIAL set is a deploy
 * mistake ⇒ fail fast naming the missing vars rather than silently running degraded.
 */
import type { AppConfig } from './env.js'

export interface LinearPlatformAppConfig {
  clientId: string
  clientSecret: string
  /** Verifies inbound `Linear-Signature` at the relay; never reaches a daemon. */
  signingSecret: string
}

type LinearPlatformEnvSlice = Pick<
  AppConfig,
  'LINEAR_PLATFORM_CLIENT_ID' | 'LINEAR_PLATFORM_CLIENT_SECRET' | 'LINEAR_PLATFORM_SIGNING_SECRET'
>

/** Undefined ⇒ feature disabled. Throws on a partial set. */
export function resolveLinearPlatformAppConfig(config: LinearPlatformEnvSlice): LinearPlatformAppConfig | undefined {
  const present = {
    LINEAR_PLATFORM_CLIENT_ID: config.LINEAR_PLATFORM_CLIENT_ID !== undefined,
    LINEAR_PLATFORM_CLIENT_SECRET: config.LINEAR_PLATFORM_CLIENT_SECRET !== undefined,
    LINEAR_PLATFORM_SIGNING_SECRET: config.LINEAR_PLATFORM_SIGNING_SECRET !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  if (set === 0) return undefined
  if (set < 3) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    throw new Error(`linear platform app config is partial — missing ${missing.join(', ')} (set all three or none)`)
  }
  return {
    clientId: config.LINEAR_PLATFORM_CLIENT_ID!,
    clientSecret: config.LINEAR_PLATFORM_CLIENT_SECRET!,
    signingSecret: config.LINEAR_PLATFORM_SIGNING_SECRET!
  }
}
