import { isSelfSender } from './data'

export type SessionTriggerKind = 'agent' | 'person' | 'github' | 'webhook' | 'schedule'

type IdLookup = { has(id: string): boolean }
const GITHUB_REPO_TRIGGER_PREFIX = 'github-repo:'

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
