/**
 * Mattermost mention ADDRESSES for AgentConnect agents.
 *
 * Mirror of `slack-mention-address.ts` for Mattermost `@botUsername` syntax:
 *  - RENDER — `@<handle>` for a dedicated bot, or `@<handle> <slug>` when shared.
 *  - RESOLVE — boundary-aware scan of `@<handle>` tokens back into deduplicated
 *    recipient `agentId`s in first-appearance order.
 */
import type { AgentMentionIdentity } from './slack-mention-address.js'
import { stripMattermostNonMentionSpans } from './mattermost-message.js'

const MATTERMOST_HANDLE_RE = /^[A-Za-z0-9._-]+$/
const MATTERMOST_MENTION_RE = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g
const TRAILING_SLUG_RE = /^[ \t]*([A-Za-z0-9._-]+)/

function normalizeHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const handle = raw.trim().replace(/^@+/, '')
  return MATTERMOST_HANDLE_RE.test(handle) ? handle : undefined
}

/**
 * The exact Mattermost `@mention` address for `agent` in the conversation this
 * identity came from, or undefined when the agent has no valid Mattermost handle
 * (or is behind a shared bot without a slug to disambiguate it).
 */
export function mattermostMentionAddress(agent: AgentMentionIdentity): string | undefined {
  const handle = normalizeHandle(agent.botUsername)
  if (!handle) return undefined
  if (!agent.botShared) return `@${handle}`
  return agent.name ? `@${handle} ${agent.name}` : undefined
}

/**
 * Every agent EXACTLY addressed by `text` via Mattermost `@handle`, in
 * first-appearance order, deduplicated.
 *
 * Boundary-aware scanning ensures email-like strings (`user@bot`) do not match.
 * When multiple agents in the conversation share a handle or `botUserId`, a
 * trailing slug (case-insensitive) is required and a bare mention resolves nothing.
 */
export function resolveMattermostMentionedAgents(text: string, agents: readonly AgentMentionIdentity[]): string[] {
  const visible = stripMattermostNonMentionSpans(text)
  if (!visible) return []

  const byHandle = new Map<string, AgentMentionIdentity[]>()
  const byBotUserId = new Map<string, AgentMentionIdentity[]>()
  for (const agent of agents) {
    const handle = normalizeHandle(agent.botUsername)?.toLowerCase()
    if (handle) {
      const bucket = byHandle.get(handle)
      if (bucket) bucket.push(agent)
      else byHandle.set(handle, [agent])
    }
    if (agent.botUserId) {
      const bucket = byBotUserId.get(agent.botUserId)
      if (bucket) bucket.push(agent)
      else byBotUserId.set(agent.botUserId, [agent])
    }
  }

  const resolved: string[] = []
  const seen = new Set<string>()
  for (const match of visible.matchAll(MATTERMOST_MENTION_RE)) {
    const raw = match[1]!.toLowerCase()
    const exactCandidates = byHandle.get(raw)
    const strippedTrailingDot = raw.endsWith('.') ? raw.replace(/\.+$/, '') : undefined
    const handleCandidates = exactCandidates ?? (strippedTrailingDot ? byHandle.get(strippedTrailingDot) : undefined)
    if (!handleCandidates) continue
    const usedDotStrip = !exactCandidates

    // Gather every candidate sharing this handle or any of its botUserIds so a stale
    // partial identity cannot downgrade a shared bot into a bare-mention match.
    const candidates: AgentMentionIdentity[] = []
    const seenCandidateIds = new Set<string>()
    const addCandidate = (candidate: AgentMentionIdentity) => {
      if (seenCandidateIds.has(candidate.agentId)) return
      seenCandidateIds.add(candidate.agentId)
      candidates.push(candidate)
    }
    for (const candidate of handleCandidates) {
      addCandidate(candidate)
      if (candidate.botUserId) {
        for (const peer of byBotUserId.get(candidate.botUserId) ?? []) addCandidate(peer)
      }
    }

    const shared = candidates.length > 1
    let agent: AgentMentionIdentity | undefined
    if (!shared) {
      agent = candidates[0]
    } else if (!usedDotStrip) {
      const rawSlug = TRAILING_SLUG_RE.exec(visible.slice(match.index + match[0].length))?.[1]?.toLowerCase()
      const cleanSlug = rawSlug?.endsWith('.') ? rawSlug.replace(/\.+$/, '') : undefined
      agent = rawSlug
        ? (candidates.find((c) => c.name?.toLowerCase() === rawSlug) ??
          (cleanSlug ? candidates.find((c) => c.name?.toLowerCase() === cleanSlug) : undefined))
        : undefined
    }
    if (agent && !seen.has(agent.agentId)) {
      seen.add(agent.agentId)
      resolved.push(agent.agentId)
    }
  }
  return resolved
}
