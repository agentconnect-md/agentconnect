// The human's @mention scope in a multi-agent webchat (webchat-multi-agents.md §5.2a): carried on replies so a woken peer outside it is told it was not addressed.
import type { WebchatPost } from '@agentconnect.md/protocol'
import type { QueueEntry } from '../daemon/turn-types.js'

/** The scope a reply carries: a continuation's inherited one, or the human's mentions; absent means the whole roster. */
export function webchatReplyScope(entry: Pick<QueueEntry, 'msg' | 'callMeta'>): string[] | undefined {
  if (entry.callMeta?.conversationContinuation) return entry.callMeta.addressedAgentIds
  if (entry.msg.source !== 'user' || entry.msg.mentionedBots.length === 0) return undefined
  return [...entry.msg.mentionedBots]
}

/** How a peer post addresses `targetAgentId`: whether the human left it out, and the scope its own reply inherits. */
export function continuationScope(
  post: WebchatPost,
  targetAgentId: string,
  targetNames: readonly (string | undefined)[]
): { outsideHumanScope: boolean; addressedAgentIds?: string[] } {
  const scope = post.author.kind === 'agent' ? post.author.addressedAgentIds : undefined
  if (!scope) return { outsideHumanScope: false }
  const inScope = scope.includes(targetAgentId)
  return {
    outsideHumanScope: !inScope && !postNamesAgent(post.text, [targetAgentId, ...targetNames]),
    addressedAgentIds: inScope ? [...scope] : [...scope, targetAgentId]
  }
}

// A name continues past this character, so `@agent` never matches inside `@agent-2` or `foo@agent.test`.
const NAME_CHAR_RE = /[\p{L}\p{N}_-]/u

/** Whether `text` @-addresses any of `names` as a whole token, case-insensitively. */
export function postNamesAgent(text: string, names: readonly (string | undefined)[]): boolean {
  const lower = text.toLowerCase()
  for (const raw of names) {
    const name = raw?.trim().toLowerCase()
    if (!name) continue
    const needle = `@${name}`
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const before = at > 0 ? lower[at - 1]! : ''
      const after = lower[at + needle.length] ?? ''
      if ((!before || !NAME_CHAR_RE.test(before)) && (!after || !NAME_CHAR_RE.test(after))) return true
    }
  }
  return false
}
