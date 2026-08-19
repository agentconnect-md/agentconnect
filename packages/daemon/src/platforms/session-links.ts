import type { SessionRecord } from '../store/local-store.js'
import { slackThreadUrl } from './slack/permalink.js'
import type { PlatformConnection } from './contract.js'

type SessionLinkConnection = Pick<PlatformConnection, 'workspaceUrl'>

/**
 * Platform strategy for session-title source links. Ingress adapters persist an
 * exact `threadUrl` when the provider event already supplies one (GitHub,
 * Discord, Telegram). This registry covers links that must instead be derived
 * from live adapter identity at read time — Slack needs its authenticated
 * workspace base URL.
 *
 * This is post-dispatch presentation behavior, so it belongs beside the other
 * daemon platform strategies (§7.4), not in the pre-dispatch manifest and not in
 * the console.
 */
type SessionLinkStrategy = (connection: SessionLinkConnection | undefined, session: SessionRecord) => string | undefined

const STRATEGIES = new Map<string, SessionLinkStrategy>([
  ['slack', (connection, session) => slackThreadUrl(connection?.workspaceUrl, session.channel, session.thread)]
])

/** No registered strategy means the platform must have persisted an ingress URL
 * (or has no addressable source); core never guesses a Slack-shaped fallback. */
export function sessionThreadUrlFor(session: SessionRecord, connection?: SessionLinkConnection): string | undefined {
  return STRATEGIES.get(session.platform)?.(connection, session)
}
