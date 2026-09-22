import type { CredentialRevocation } from '../platforms/credential-revocation.js'

/** The Slack events that can revoke a socket app's bot token; every other signal, an API error included, is not one. */
export const SLACK_LIFECYCLE_EVENTS = ['app_uninstalled', 'tokens_revoked'] as const

/** Read one lifecycle delivery; null unless it explicitly revokes THIS install's bot token. */
export function slackLifecycleRevocation(
  type: string,
  event: unknown,
  body: unknown,
  self: { teamId: string }
): CredentialRevocation | null {
  const envelope = (body ?? {}) as { team_id?: unknown; event_time?: unknown }
  // The envelope time is the only fence: without it a delayed event could revoke a credential installed after it.
  const eventTime = envelope.event_time
  if (typeof eventTime !== 'number' || !Number.isFinite(eventTime) || eventTime < 0) return null
  // A socket receives every workspace its app is installed in, and another workspace's event says nothing about this bot.
  if (typeof envelope.team_id === 'string' && self.teamId && envelope.team_id !== self.teamId) return null
  const eventAtMs = Math.floor(eventTime * 1000)
  if (type === 'app_uninstalled') return { reason: 'app_uninstalled', eventAtMs }
  if (type !== 'tokens_revoked') return null
  // A user-token-only revocation leaves the bot token alive.
  const bot = (event as { tokens?: { bot?: unknown } } | undefined)?.tokens?.bot
  return Array.isArray(bot) && bot.length > 0 ? { reason: 'tokens_revoked', eventAtMs } : null
}
