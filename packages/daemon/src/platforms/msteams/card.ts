// Teams' Adaptive Card pieces (teams-integration.md §4.4): plain text runs, rows of `Action.Execute` buttons, and the card envelope.
import { clampTo } from '../../slack/render.js'

/** The schema version every card declares; Teams renders up to 1.5 on every client. */
export const MSTEAMS_CARD_VERSION = '1.5'
/** The verb of a permission card's buttons. */
export const MSTEAMS_APPROVAL_VERB = 'agentconnect.approval'
/** The verb of a question card's buttons. */
export const MSTEAMS_ELICIT_VERB = 'agentconnect.elicit'
/** Our own cap on a button title or an input label. */
export const MSTEAMS_LABEL_CAP = 75

// Each row is its own action set, so a long list wraps rather than spilling past the host's per-set action limit.
const ACTIONS_PER_ROW = 5

export type AdaptiveElement = Record<string, unknown>

/** Text as one block per line: a TextRun is never read as Markdown, so runtime and agent words never become a link or formatting. */
export function plainText(text: string, opts: { bold?: boolean } = {}): AdaptiveElement[] {
  return text.split('\n').map((line, i) => ({
    type: 'RichTextBlock',
    ...(i > 0 ? { spacing: 'None' } : {}),
    inlines: [{ type: 'TextRun', text: line || ' ', ...(opts.bold ? { weight: 'Bolder' } : {}) }]
  }))
}

/** One `Action.Execute` button; the click comes back as an `adaptiveCard/action` invoke carrying `data`. */
export function executeButton(
  title: string,
  verb: string,
  data: Record<string, string>,
  opts: { style?: 'positive' | 'destructive'; withInputs?: boolean } = {}
): AdaptiveElement {
  return {
    type: 'Action.Execute',
    title: clampTo(title, MSTEAMS_LABEL_CAP),
    verb,
    data,
    // Only a form's Confirm submits the card's inputs; Dismiss and one-tap answers never wait on them.
    associatedInputs: opts.withInputs ? 'auto' : 'none',
    ...(opts.style ? { style: opts.style } : {})
  }
}

/** Buttons as consecutive action sets of a few each. */
export function buttonRows(buttons: readonly AdaptiveElement[]): AdaptiveElement[] {
  const rows: AdaptiveElement[] = []
  for (let i = 0; i < buttons.length; i += ACTIONS_PER_ROW)
    rows.push({ type: 'ActionSet', actions: buttons.slice(i, i + ACTIONS_PER_ROW) })
  return rows
}

/** A link button to a URL of ours, the only place a card opens a page. */
export function openUrlRow(title: string, url: string): AdaptiveElement {
  return { type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title, url }] }
}

export function adaptiveCard(body: readonly AdaptiveElement[]): Record<string, unknown> {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: MSTEAMS_CARD_VERSION,
    msteams: { width: 'Full' },
    body
  }
}

/** A string field of a click's `data`, or undefined. */
export function dataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value ? value : undefined
}
