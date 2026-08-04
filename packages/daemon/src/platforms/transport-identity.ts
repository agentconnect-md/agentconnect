/**
 * The **transport identity strategies** (`transportScopeIdentity` /
 * `tenantScope` in §7.4, stage S2) — two different answers to "what identifies
 * this integration's connection?", with two different lifetimes:
 *
 *  - {@link connectionIdentityFor} feeds the TRANSPORT scope: which credential
 *    actually identifies one physical connection, so integrations consolidated
 *    onto the same credential share a scope. It deliberately rotates with the
 *    credential; the caller hashes it and no raw credential is persisted or
 *    logged. The §7.5 connection-pool keys state the same fact for LIVE
 *    connections; this states it for configs, before any connection exists.
 *
 *  - {@link tenantScopeFor} feeds the DURABLE owner identity
 *    (`<platform>:<scope>:<uid>`, session-visibility §2). It must SURVIVE
 *    rotation, so it prefers the platform's own tenant id and falls back to a
 *    scope minted once per integration and persisted by core.
 *
 * Both read the integration's legacy disk-shape config blocks structurally —
 * the same S1b decision (#516) that froze that shape until the emission flip is
 * why these reads belong in a platform strategy and not in core.
 */

interface SlackConfig {
  slack: { mode?: string; botToken: string; appToken?: string }
}
interface TelegramConfig {
  telegram: { botToken: string }
}
interface DiscordConfig {
  discord: { botToken: string }
}
interface FeishuConfig {
  feishu: { region: string; appId: string }
}

/** The stable public BotFather bot-id prefix, or undefined for non-standard
 *  test/config tokens. */
function telegramBotId(botToken: string): string | undefined {
  const botId = botToken.split(':', 1)[0]
  return /^\d+$/.test(botId ?? '') ? botId : undefined
}

const CONNECTION_IDENTITY = new Map<string, (integration: unknown) => string>([
  // A shared bot has no app token to key on; a socket integration keys on it.
  [
    'slack',
    (i) => {
      const slack = (i as SlackConfig).slack
      return slack.mode === 'shared' ? slack.botToken : (slack.appToken ?? slack.botToken)
    }
  ],
  // The bot-id prefix survives a secret rotation; non-standard tokens fall back
  // to the full high-entropy credential before hashing.
  [
    'telegram',
    (i) => {
      const token = (i as TelegramConfig).telegram.botToken
      return telegramBotId(token) ?? token
    }
  ],
  ['discord', (i) => (i as DiscordConfig).discord.botToken],
  [
    'feishu',
    (i) => {
      const feishu = (i as FeishuConfig).feishu
      return `${feishu.region}:${feishu.appId}`
    }
  ]
])

/** The credential string identifying `integration`'s physical connection —
 *  hashed by the caller, never persisted raw. Fail-CLOSED default: an
 *  unregistered platform identifies by integration id, so its scope never
 *  consolidates across integrations (over-isolating is safe; over-sharing a
 *  scope would merge unrelated conversations). */
export function connectionIdentityFor(integration: { id: string; platform: string }): string {
  return CONNECTION_IDENTITY.get(integration.platform)?.(integration) ?? integration.id
}

/** Core-owned inputs a tenant-scope strategy may consult. */
export interface TenantScopeHost {
  /** The live connection's workspace/team id, where the platform exposes one. */
  liveWorkspaceId(integrationId: string): string | undefined
  /** A scope minted once per integration and persisted — the rotation-immune
   *  fallback when the platform exposes no tenant id. */
  minted(integrationId: string): string | undefined
}

const TENANT_SCOPE = new Map<string, (host: TenantScopeHost, integration: unknown) => string | undefined>([
  // The workspace id from auth.test, surfaced by the live connection. A
  // not-yet-authenticated (or test-substituted) connection may not expose it —
  // fall back to the minted scope rather than throw.
  ['slack', (host, i) => host.liveWorkspaceId((i as { id: string }).id) || host.minted((i as { id: string }).id)],
  // The public bot id prefix survives a BotFather token rotation.
  [
    'telegram',
    (host, i) => {
      const botId = telegramBotId((i as TelegramConfig).telegram.botToken)
      return botId ? `bot${botId}` : host.minted((i as { id: string }).id)
    }
  ],
  // App id + region is the tenant anchor Feishu/Lark exposes to us.
  [
    'feishu',
    (_host, i) => {
      const feishu = (i as FeishuConfig).feishu
      return `${feishu.region}:${feishu.appId}`
    }
  ]
])

/** The durable tenant scope for `integration` (session-visibility §2). Total by
 *  construction: a platform with no durable tenant id of its own — Discord, and
 *  anything unregistered — gets the minted per-integration scope. Undefined ⇒
 *  the CP records no owner (fail closed), never a guessed one. */
export function tenantScopeFor(
  host: TenantScopeHost,
  integration: { id: string; platform: string }
): string | undefined {
  const strategy = TENANT_SCOPE.get(integration.platform)
  return strategy ? strategy(host, integration) : host.minted(integration.id)
}
