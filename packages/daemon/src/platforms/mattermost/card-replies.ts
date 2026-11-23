/** Matching a plain-text reply to an open card, for the pure-WebSocket fallback where no button callback can arrive. */
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { ChatCardClick } from '../contract.js'
import { MATTERMOST_DM_THREAD } from './module.js'

export type MattermostCardReplyEntry =
  | {
      tag: string
      channel: string
      thread?: string
      postId: string
      agentId: string
      integrationId: string
      kind: 'approval'
      requestId: string
      optionCount: number
    }
  | {
      tag: string
      channel: string
      thread?: string
      postId: string
      agentId: string
      integrationId: string
      kind: 'draft'
      draftId: string
    }

export interface QuestionTagEntry {
  channel: string
  thread?: string
  replyToValue?: string
}

export function stripLeadingMentions(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/^(?:@[A-Za-z0-9._-]+[\s,:]*)+/i, '')
    .trim()
}

export function matchesReplyScope(
  entryChannel: string,
  entryThread: string | undefined,
  entryPostId: string | undefined,
  msg: NormalizedMessage
): boolean {
  if (entryChannel !== msg.channel) return false
  if (msg.isDm) {
    return (
      entryThread === undefined ||
      entryThread === MATTERMOST_DM_THREAD ||
      entryThread === msg.replyThread ||
      (entryPostId !== undefined && entryPostId === msg.replyThread)
    )
  }
  const effectiveThread = msg.replyThread ?? msg.thread
  const targetThread = entryThread ?? entryPostId
  return targetThread !== undefined && targetThread === effectiveThread
}

export const STANDARD_CARD_TAG_RE = /^[A-Z]-[0-9A-F]{8}$/i
const LEAD_STANDARD_TAG_RE = /^([A-Z]-[0-9A-F]{8})(?:\s*[:\-]\s*|\s+)([^\r\n]+)$/i
export const SCAN_STANDARD_TAG_RE = /\b[A-Z]-[0-9A-F]{8}\b/gi

function isWsChar(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12 || code === 160
}

function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

export function containsTokenBoundary(haystackLower: string, needleLower: string): boolean {
  if (!needleLower) return false
  let from = 0
  while (from <= haystackLower.length - needleLower.length) {
    const idx = haystackLower.indexOf(needleLower, from)
    if (idx === -1) return false
    const beforeOk = idx === 0 || !isWordCode(haystackLower.charCodeAt(idx - 1))
    const afterIdx = idx + needleLower.length
    const afterOk = afterIdx >= haystackLower.length || !isWordCode(haystackLower.charCodeAt(afterIdx))
    if (beforeOk && afterOk) return true
    from = idx + 1
  }
  return false
}

function parseLeadingCustomTagChoice(clean: string, tag: string): string | null {
  if (clean.length <= tag.length) return null
  if (clean.slice(0, tag.length).toLowerCase() !== tag.toLowerCase()) return null
  let pos = tag.length
  let sawWs = false
  while (pos < clean.length && isWsChar(clean.charCodeAt(pos))) {
    sawWs = true
    pos++
  }
  if (pos < clean.length && (clean[pos] === ':' || clean[pos] === '-')) {
    pos++
    while (pos < clean.length && isWsChar(clean.charCodeAt(pos))) pos++
  } else if (!sawWs) {
    return null
  }
  const rest = clean.slice(pos)
  return rest && !rest.includes('\n') && !rest.includes('\r') ? rest : null
}

function parseCardReplyChoice(
  entry: MattermostCardReplyEntry,
  choiceToken: string,
  msg: NormalizedMessage
): ChatCardClick | null {
  const token = choiceToken.normalize('NFKC').trim().toLowerCase()
  if (!token) return null
  const actor = {
    userId: msg.sender.id,
    ...(msg.sender.isBot ? { isBot: true } : {}),
    ...(msg.sender.name ? { name: msg.sender.name } : {})
  }
  if (entry.kind === 'approval') {
    if (!/^\d{1,2}$/.test(token)) return null
    const choiceNum = Number(token)
    if (choiceNum < 1 || choiceNum > entry.optionCount) return null
    return {
      answer: { kind: 'approval', requestId: entry.requestId, option: choiceNum - 1 },
      ts: entry.postId,
      actor
    }
  }
  let optionId: 'approve' | 'discard' | undefined
  if (token === '1' || token === 'approve') optionId = 'approve'
  else if (token === '2' || token === 'deny' || token === 'discard') optionId = 'discard'
  if (!optionId) return null
  return {
    answer: { kind: 'draft', draftId: entry.draftId, optionId },
    ts: entry.postId,
    actor
  }
}

export function matchCardReply(
  cardReplies: ReadonlyMap<string, MattermostCardReplyEntry>,
  cardRepliesByUpper: ReadonlyMap<string, MattermostCardReplyEntry>,
  questionTags: ReadonlyMap<string, QuestionTagEntry>,
  msg: NormalizedMessage
): { entry: MattermostCardReplyEntry; click: ChatCardClick } | null {
  const clean = stripLeadingMentions(msg.text ?? '')
  if (!clean) return null

  // 1. O(1) leading standard tag (`A-XXXXXXXX 1` / `D-XXXXXXXX: 2`)
  const lead = LEAD_STANDARD_TAG_RE.exec(clean)
  if (lead) {
    const entry = cardRepliesByUpper.get(lead[1]!.toUpperCase())
    if (entry && entry.channel === msg.channel) {
      const click = parseCardReplyChoice(entry, lead[2]!, msg)
      if (click) return { entry, click }
    }
  }

  // 2. O(N) linear trailing-tag scan (`1 A-XXXXXXXX`) with Map lookup (zero backtracking)
  let wsEnd = clean.length - 1
  while (wsEnd >= 0 && !isWsChar(clean.charCodeAt(wsEnd))) wsEnd--
  if (wsEnd > 0) {
    const tail = clean.slice(wsEnd + 1)
    let wsStart = wsEnd
    while (wsStart > 0 && isWsChar(clean.charCodeAt(wsStart - 1))) wsStart--
    const prefix = clean.slice(0, wsStart)
    if (prefix && !prefix.includes('\n') && !prefix.includes('\r')) {
      const entry = cardRepliesByUpper.get(tail.toUpperCase())
      if (entry && entry.channel === msg.channel) {
        const click = parseCardReplyChoice(entry, prefix, msg)
        if (click) return { entry, click }
      }
    }
  }

  // 3. Fallback for any non-standard leading tag registered in tests
  for (const entry of cardReplies.values()) {
    if (entry.channel !== msg.channel || STANDARD_CARD_TAG_RE.test(entry.tag)) continue
    const choice = parseLeadingCustomTagChoice(clean, entry.tag)
    if (!choice) continue
    const click = parseCardReplyChoice(entry, choice, msg)
    if (click) return { entry, click }
  }

  const scopedCards: MattermostCardReplyEntry[] = []
  for (const entry of cardReplies.values()) {
    if (matchesReplyScope(entry.channel, entry.thread, entry.postId, msg)) {
      scopedCards.push(entry)
    }
  }
  if (scopedCards.length !== 1) return null

  for (const entry of questionTags.values()) {
    if (matchesReplyScope(entry.channel, entry.thread, entry.replyToValue, msg)) {
      return null
    }
  }

  const target = scopedCards[0]!
  const click = parseCardReplyChoice(target, clean, msg)
  return click ? { entry: target, click } : null
}
