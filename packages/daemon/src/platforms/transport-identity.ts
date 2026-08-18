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
 * Both read the integration through the platform module's VALIDATED config
 * (§6.4, `platforms/integration-config.ts`) — the payload is opaque `unknown`
 * on the entry, so an unchecked structural cast would let a malformed value
 * (say `botToken: 42`) reach `.split()` and throw from a path the connection
 * consolidator already skipped. A payload the module schema refuses reads as
 * "no credential", and both strategies fall back fail-closed: the transport
 * scope isolates on the integration id, the tenant scope on the minted value.
 */
import type { Integration } from '../agents/agent-schema.js'
import { integrationCore, platformIntegrationConfig } from './integration-config.js'

/** The stable public BotFather bot-id prefix, or undefined for non-standard
 *  test/config tokens. */
function telegramBotId(botToken: string): string | undefined {
  const botId = botToken.split(':', 1)[0]
  return /^\d+$/.test(botId ?? '') ? botId : undefined
}

const CONNECTION_IDENTITY = new Map<string, (integration: Integration) => string | undefined>([
  // A shared bot has no app token to key on; a socket integration keys on it.
  [
    'slack',
    (int) => {
      const slack = platformIntegrationConfig('slack', int)
      if (!slack) return undefined
      return integrationCore(int).mode === 'shared' ? slack.botToken : (slack.appToken ?? slack.botToken)
    }
  ],
  // The bot-id prefix survives a secret rotation; non-standard tokens fall back
  // to the full high-entropy credential before hashing.
  [
    'telegram',
    (int) => {
      const token = platformIntegrationConfig('telegram', int)?.botToken
      return token === undefined ? undefined : (telegramBotId(token) ?? token)
    }
  ],
  ['discord', (int) => platformIntegrationConfig('discord', int)?.botToken],
  [
    'feishu',
    (int) => {
      const feishu = platformIntegrationConfig('feishu', int)
      // `region` is schema-defaulted ('feishu'), so a validated payload always has it.
      return feishu && `${feishu.region}:${feishu.appId}`
    }
  ]
])

/** The credential string identifying `integration`'s physical connection —
 *  hashed by the caller, never persisted raw. Fail-CLOSED default: an
 *  unregistered platform — or an entry whose config payload does not validate —
 *  identifies by integration id, so its scope never consolidates across
 *  integrations (over-isolating is safe; over-sharing a scope would merge
 *  unrelated conversations). */
export function connectionIdentityFor(integration: Integration): string {
  return CONNECTION_IDENTITY.get(integration.platform)?.(integration) ?? integration.id
}

/** Core-owned inputs a tenant-scope strategy may consult. */
export interface TenantScopeHost {
  /** The live connection's workspace/team id, where the platform exposes one. */
  liveWorkspaceId(integrationId: string): string | undefined
  /** A scope minted once per integration and persisted — the rotation-immune
   *  fallback when the platform exposes no tenant id. */
  minted(integrationId: string): Promise<string | undefined>
}

const TENANT_SCOPE = new Map<string, (host: TenantScopeHost, integration: Integration) => Promise<string | undefined>>([
  // The workspace id from auth.test, surfaced by the live connection. A
  // not-yet-authenticated (or test-substituted) connection may not expose it —
  // fall back to the minted scope rather than throw.
  ['slack', async (host, int) => host.liveWorkspaceId(int.id) || (await host.minted(int.id))],
  // The public bot id prefix survives a BotFather token rotation.
  [
    'telegram',
    async (host, int) => {
      const token = platformIntegrationConfig('telegram', int)?.botToken
      const botId = token === undefined ? undefined : telegramBotId(token)
      return botId ? `bot${botId}` : await host.minted(int.id)
    }
  ],
  // App id + region is the tenant anchor Feishu/Lark exposes to us.
  [
    'feishu',
    async (host, int) => {
      const feishu = platformIntegrationConfig('feishu', int)
      return feishu ? `${feishu.region}:${feishu.appId}` : await host.minted(int.id)
    }
  ]
])

/** The durable tenant scope for `integration` (session-visibility §2). Total by
 *  construction: a platform with no durable tenant id of its own — Discord, and
 *  anything unregistered — gets the minted per-integration scope. Undefined ⇒
 *  the CP records no owner (fail closed), never a guessed one. */
export async function tenantScopeFor(host: TenantScopeHost, integration: Integration): Promise<string | undefined> {
  const strategy = TENANT_SCOPE.get(integration.platform)
  return strategy ? await strategy(host, integration) : await host.minted(integration.id)
}
