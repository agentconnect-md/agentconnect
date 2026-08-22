import { isSelfSender } from './data'
import type { HookKind } from './api'

export type SessionTriggerKind = 'agent' | 'person' | 'github' | 'gitlab' | 'webhook' | 'schedule'

type IdLookup = { has(id: string): boolean }
const GITHUB_REPO_TRIGGER_PREFIX = 'github-repo:'

/** Recover the stable author from a pre-metadata Slack bot attribution footer. The
 *  daemon sets `trustedAgentBot` only after matching a local bot identity or a
 *  CP-advertised AgentConnect app id; absent provenance fails closed. Only ids visible
 *  in the current Agent directory are accepted. */
export function sessionAttributionAgentId(
  platform: string,
  message: { text: string; trustedAgentBot?: boolean },
  agentIds: IdLookup
): string | undefined {
  if (platform !== 'slack' || message.trustedAgentBot !== true) return undefined
  const ids = new Set<string>()
  for (const match of message.text.matchAll(/(?:^|\n)sent by <https?:\/\/[^<>\s|]+\/agents\/([^/?#|>]+)\|[^>\n]+>/g)) {
    try {
      const id = decodeURIComponent(match[1]!)
      if (agentIds.has(id)) ids.add(id)
    } catch {
      // A malformed URL segment is not a trustworthy identity hint.
    }
  }
  return ids.size === 1 ? [...ids][0] : undefined
}

/** Reconcile older rows without their own footer when the same Slack bot sender has
 *  exactly one attributed Agent elsewhere in this transcript. Shared/ambiguous bot ids
 *  deliberately remain unresolved. */
export function sessionAttributionAgentAuthors(
  platform: string,
  messages: readonly { sender: string; text: string; trustedAgentBot?: boolean }[],
  agentIds: IdLookup
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const message of messages) {
    const id = sessionAttributionAgentId(platform, message, agentIds)
    if (!id) continue
    const ids = candidates.get(message.sender) ?? new Set<string>()
    ids.add(id)
    candidates.set(message.sender, ids)
  }
  return new Map([...candidates].flatMap(([sender, ids]) => (ids.size === 1 ? [[sender, [...ids][0]!] as const] : [])))
}

/** Visible Agents that authored rows in this transcript. Direct A2A deliveries
 * carry the Agent id as `sender`; legacy Slack rows recover it from the same
 * trusted attribution used by the message renderer. */
export function sessionTranscriptAgentIds(
  platform: string,
  messages: readonly { sender: string; text: string; trustedAgentBot?: boolean }[],
  agentIds: IdLookup
): ReadonlySet<string> {
  const attributed = sessionAttributionAgentAuthors(platform, messages, agentIds)
  const authors = new Set<string>()
  for (const message of messages) {
    if (agentIds.has(message.sender)) authors.add(message.sender)
    const attributedId = attributed.get(message.sender)
    if (attributedId) authors.add(attributedId)
  }
  return authors
}

/** GitHub subscriptions collapse per repository — the CP indexes their numeric repo id.
 *  Every other trigger, GitLab included, filters by its own raw `hook:<id>` value. */
export function sessionTriggerFilterValue(trigger: {
  value: string
  hookKind?: HookKind
  githubRepoId?: string
}): string {
  return trigger.hookKind === 'github' && trigger.githubRepoId
    ? `${GITHUB_REPO_TRIGGER_PREFIX}${trigger.githubRepoId}`
    : trigger.value
}

export function githubRepoIdFromSessionTriggerFilter(value: string): string | undefined {
  if (!value.startsWith(GITHUB_REPO_TRIGGER_PREFIX)) return undefined
  const repoId = value.slice(GITHUB_REPO_TRIGGER_PREFIX.length)
  return /^[1-9]\d*$/.test(repoId) ? repoId : undefined
}

export function sessionTriggerKind(
  session: { triggeredBy?: string; hookKind?: HookKind },
  agentIds: IdLookup
): SessionTriggerKind | null {
  const trigger = session.triggeredBy
  if (!trigger) return null
  if (trigger.startsWith('cron:')) return 'schedule'
  if (trigger.startsWith('hook:')) return session.hookKind ?? 'webhook'
  return agentIds.has(trigger) ? 'agent' : 'person'
}

export function sessionSenderLabel(
  sender: string | null | undefined,
  fallback: string | undefined,
  agentNames: ReadonlyMap<string, string>,
  memberNames: ReadonlyMap<string, string>,
  me: { userId: string; email: string | null; name?: string | null } | null | undefined
): string {
  if (!sender) return fallback ?? '—'
  if (isSelfSender(sender, me)) return 'You'
  if (sender.startsWith('hook:')) return fallback ?? 'Webhook'
  return agentNames.get(sender) ?? memberNames.get(sender) ?? fallback ?? sender
}
