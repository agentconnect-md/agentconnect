// The in-channel notice for an elicitation declined because this turn's surface cannot render it.
// Without it the agent asks the reader a question and the reader never learns it was asked (#1794).
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { NoticeMarkup } from '../platforms/turn-chrome.js'
import { clampTo } from '../slack/render.js'

// Stops at whitespace and at the bracketing a link syntax uses, so a defused URL keeps its own
// punctuation out of the code span it lands in.
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi

/** How much of the agent's question the notice quotes. Every transport here takes far more; this
 *  only stops one runaway `message` from filling the channel. */
const NOTICE_QUESTION_CAP = 900

/** Defuse agent-authored text bound for a plain notice. A question may not send the reader
 *  anywhere — the spec keeps URLs on URL-mode elicitations, whose consent card is the only place
 *  one is ever followable — so each surface's own link syntax is neutralised the way that surface
 *  reads it: Slack's `<url|label>` and autolink, Discord's `[label](url)` and autolink. A surface
 *  declaring no markup shows the text verbatim and has no label syntax to spoof with. Pure. */
export function defuseNoticeText(raw: string, markup?: NoticeMarkup): string {
  if (markup === 'slack-mrkdwn')
    return raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(BARE_URL_RE, (m) => `\`${m}\``)
  if (markup === 'markdown') return raw.replace(/[[\]]/g, (c) => `\\${c}`).replace(BARE_URL_RE, (m) => `\`${m}\``)
  return raw
}

/** The agent's question as the notice quotes it — already `maskAgentSecrets`-masked by the caller,
 *  clamped here, then defused so the clamp cannot cut a defusing apart. Pure. */
export function elicitNoticeQuestion(params: CreateElicitationRequest, markup?: NoticeMarkup): string {
  const raw = (params as { message?: string }).message?.trim() || 'The agent needs your input'
  return defuseNoticeText(clampTo(raw, NOTICE_QUESTION_CAP), markup)
}

/** The whole notice: that something was asked, what it was, that this chat cannot collect the
 *  answer, and where it can be answered. It names nothing from the schema — the reader did not
 *  write the schema, and "multi-enum" tells them nothing they can act on. Pure. */
export function buildElicitDeclinedNotice(
  params: CreateElicitationRequest,
  markup?: NoticeMarkup,
  sessionUrl?: string
): string {
  const tail = sessionUrl ? `\nYou can answer it in the session console: ${sessionUrl}` : ''
  const head = "💬 The agent asked something this chat can't collect an answer for, so it was declined:"
  return `${head}\n${elicitNoticeQuestion(params, markup)}${tail}`
}
