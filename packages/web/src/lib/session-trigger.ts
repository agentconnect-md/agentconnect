import { isSelfSender } from './data'

export type SessionTriggerKind = 'agent' | 'person' | 'github' | 'webhook' | 'schedule'

type IdLookup = { has(id: string): boolean }
const GITHUB_REPO_TRIGGER_PREFIX = 'github-repo:'

/** Recover the stable author from a pre-metadata Slack bot attribution footer. The
 *  sender is daemon-recorded provider identity: Slack reserves B-prefixed ids for bots,
 *  so human U/W senders and every non-Slack transport are rejected before inspecting
 *  user-controlled text. Only ids visible in the current Agent directory are accepted. */
export function sessionAttributionAgentId(
  platform: string,
  sender: string,
  text: string,
  agentIds: IdLookup
): string | undefined {
  if (platform !== 'slack' || !/^B[A-Z0-9]+$/.test(sender)) return undefined
  const ids = new Set<string>()
  for (const match of text.matchAll(/(?:^|\n)sent by <https?:\/\/[^<>\s|]+\/agents\/([^/?#|>]+)\|[^>\n]+>/g)) {
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
  messages: readonly { sender: string; text: string }[],
  agentIds: IdLookup
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const message of messages) {
    const id = sessionAttributionAgentId(platform, message.sender, message.text, agentIds)
    if (!id) continue
    const ids = candidates.get(message.sender) ?? new Set<string>()
    ids.add(id)
    candidates.set(message.sender, ids)
  }
  return new Map([...candidates].flatMap(([sender, ids]) => (ids.size === 1 ? [[sender, [...ids][0]!] as const] : [])))
}

export function sessionTriggerFilterValue(trigger: {
  value: string
  hookKind?: 'webhook' | 'github'
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
  session: { triggeredBy?: string; hookKind?: 'webhook' | 'github' },
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
  me: { userId: string; email: string | null } | null | undefined
): string {
  if (!sender) return fallback ?? '—'
  if (isSelfSender(sender, me)) return 'You'
  if (sender.startsWith('hook:')) return fallback ?? 'Webhook'
  return agentNames.get(sender) ?? memberNames.get(sender) ?? fallback ?? sender
}
