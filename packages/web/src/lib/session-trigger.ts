import {
  CODE_HOST_PROVIDERS,
  GENERIC_HOOK_KIND,
  isCodeHostProvider,
  type HookKind
} from '@agentconnect.md/protocol/code-host'
import { isSelfSender } from './data'

/**
 * Session source taxonomy. A hook kind IS a trigger kind, so the union is the three
 * non-hook origins plus the shared hook-kind vocabulary rather than a hand-copied
 * list — a new code host widens it here and every total mapping below (and every
 * `Record<HookKind, …>` in the views) stops compiling until it is given an entry.
 * That is the constraint GitLab was missing: it could be typed out of the union and
 * silently inherit the generic webhook rendering.
 */
export type SessionTriggerKind = 'agent' | 'person' | 'schedule' | HookKind

/** Hook kinds in console display order — every code host first, the generic endpoint last. */
export const HOOK_TRIGGER_KINDS = [...CODE_HOST_PROVIDERS, GENERIC_HOOK_KIND] as const

/** Trigger filter-group heading per hook kind. Total: a new kind gets its own group. */
export const HOOK_KIND_GROUP_LABEL: Record<HookKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  webhook: 'Webhooks'
}

/** Display name for a hook source the daemon left unnamed. Total, so no code host reads as "Webhook". */
export const HOOK_KIND_LABEL: Record<HookKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  webhook: 'Webhook'
}

/** The name to show for an unnamed hook source; an unresolvable hook is generic by definition. */
export function hookSourceLabel(kind: HookKind | null | undefined): string {
  return HOOK_KIND_LABEL[kind ?? GENERIC_HOOK_KIND]
}

/** The kind that stands for a set of them where only one mark fits — code hosts first,
 *  so an agent's GitLab subscription is never represented by the generic webhook glyph. */
export function primaryHookKind(kinds: readonly HookKind[]): HookKind | undefined {
  return HOOK_TRIGGER_KINDS.find((kind) => kinds.includes(kind))
}

/** The hook kind an integration facet value names — the CP promotes each code host
 *  out of the generic `hook` bucket, so only that one value needs translating. */
export function hookKindFromIntegration(integration: string): HookKind | undefined {
  if (integration === 'hook') return GENERIC_HOOK_KIND
  return isCodeHostProvider(integration) ? integration : undefined
}

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
  // A hook kind IS its own trigger kind. The generic kind is a mapping, never a
  // fallback: only a hook the CP could not resolve (deleted definition, local row)
  // arrives without one, and an unidentified hook source is generic by definition.
  if (trigger.startsWith('hook:')) return session.hookKind ?? GENERIC_HOOK_KIND
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
  if (sender.startsWith('hook:')) return fallback ?? HOOK_KIND_LABEL[GENERIC_HOOK_KIND]
  return agentNames.get(sender) ?? memberNames.get(sender) ?? fallback ?? sender
}
