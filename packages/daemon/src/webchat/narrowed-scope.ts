// The human's @mention scope in a multi-agent webchat (webchat-multi-agents.md §5.2a): carried on replies so a woken peer outside it is told it was not addressed.
import type { WebchatPost } from '@agentconnect.md/protocol'
import type { QueueEntry } from '../daemon/turn-types.js'
import {
  ADDRESSED_AFTER_OUTSIDE_SCOPE_REMINDER,
  OUTSIDE_HUMAN_SCOPE_REMINDER,
  absorbedOutsideScopeReminder
} from '../session/no-response.js'

type RoutedEntry = Pick<QueueEntry, 'msg' | 'callMeta'>

/** The scope a reply carries: a continuation's inherited one, or the human's mentions; absent means the whole roster. */
export function webchatReplyScope(entry: RoutedEntry): string[] | undefined {
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
  if (scope.includes(targetAgentId)) return { outsideHumanScope: false, addressedAgentIds: [...scope] }
  // Only an invitation joins the exchange; speaking up uninvited leaves the scope (and future reminders) as they were.
  if (!postNamesAgent(post.text, [targetAgentId, ...targetNames])) {
    return { outsideHumanScope: true, addressedAgentIds: [...scope] }
  }
  return { outsideHumanScope: false, addressedAgentIds: [...scope, targetAgentId] }
}

/** One live turn's routing as activations fold into it; `notes` are routing facts its next replacement prompt still owes the model. */
export interface WebchatRouting {
  addressed: boolean
  scope: string[] | undefined
  notes: { becameAddressed: boolean; absorbedOutsideFrom: string[] }
}

export function initialWebchatRouting(entry: RoutedEntry): WebchatRouting {
  return {
    addressed: entry.callMeta?.outsideHumanScope !== true,
    scope: webchatReplyScope(entry),
    notes: { becameAddressed: false, absorbedOutsideFrom: [] }
  }
}

/** Fold an activation coalesced into the turn: the reply answers only addressing activations, so a left-out one shapes neither its scope nor its silence. */
export function foldWebchatRouting(routing: WebchatRouting, absorbed: RoutedEntry): WebchatRouting {
  const next = initialWebchatRouting(absorbed)
  if (routing.addressed && !next.addressed) {
    const from = routing.notes.absorbedOutsideFrom.includes(absorbed.msg.sender.id)
      ? routing.notes.absorbedOutsideFrom
      : [...routing.notes.absorbedOutsideFrom, absorbed.msg.sender.id]
    return { ...routing, notes: { ...routing.notes, absorbedOutsideFrom: from } }
  }
  if (!routing.addressed && next.addressed) {
    return { addressed: true, scope: next.scope, notes: { becameAddressed: true, absorbedOutsideFrom: [] } }
  }
  return { ...routing, scope: mergeScopes(routing.scope, next.scope) }
}

/** The lead of a replacement prompt whose only change is a routing correction no earlier prompt delivered. */
export const WEBCHAT_ROUTING_UPDATE_TEXT =
  '(AgentConnect routing update: who this conversation addressed changed while you were working.\n' +
  'Your previous candidate answer was not delivered. Re-evaluate it with the routing fact below and\n' +
  'produce a replacement final answer, without repeating side effects blindly.)'

/** The routing facts `routing` owes a prompt; only a replacement prompt re-reminds a still-left-out turn, since the first one already carries that reminder. */
export function webchatRoutingNoteBlocks(
  routing: WebchatRouting,
  replacement: boolean
): Array<{ type: 'text'; text: string }> {
  const blocks: Array<{ type: 'text'; text: string }> = []
  if (!routing.addressed) {
    if (replacement) blocks.push({ type: 'text', text: OUTSIDE_HUMAN_SCOPE_REMINDER })
    return blocks
  }
  if (routing.notes.becameAddressed) blocks.push({ type: 'text', text: ADDRESSED_AFTER_OUTSIDE_SCOPE_REMINDER })
  if (routing.notes.absorbedOutsideFrom.length > 0) {
    blocks.push({ type: 'text', text: absorbedOutsideScopeReminder(routing.notes.absorbedOutsideFrom) })
  }
  return blocks
}

// An unscoped activation leaves no one out, so it wins the merge.
function mergeScopes(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a || !b) return undefined
  return [...a, ...b.filter((id) => !a.includes(id))]
}

// A name continues past this character, so `@agent` never matches inside `@agent-2` or `foo@agent.test`.
const NAME_CHAR_RE = /[\p{L}\p{N}_-]/u
// Quoted, code and link text mentions an agent without inviting it.
const NON_INVITING_RE = [/```[\s\S]*?```/g, /`[^`\n]*`/g, /^[ \t]*>.*$/gm, /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi]

/** Whether `text` invites any of `names` with a whole-token @mention outside quotes, code and links (negation is not parsed). */
export function postNamesAgent(text: string, names: readonly (string | undefined)[]): boolean {
  const lower = NON_INVITING_RE.reduce((rest, re) => rest.replace(re, ' '), text).toLowerCase()
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
