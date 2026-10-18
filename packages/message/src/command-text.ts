// The text a control command is read from: a leading address of the receiving bot and a platform's own attribution suffix dropped.

/** Reads a message's command text; `self` holds the receiving bot's ids, undefined accepts an address of anyone. */
type CommandTextReader = (text: string, self?: readonly string[]) => string

const SLACK_LEADING_MENTION = /^\s*<@([A-Z0-9]+)(?:\|[^>]*)?>/
// Slack's attribution on a post a person made through an app.
const SLACK_SENT_USING = /\s+\*Sent using\*\s+<@[A-Z0-9]+(?:\|[^>]*)?>\s*$/

/** Slack: leading `<@U…>` mentions of `self`, then the trailing "Sent using" attribution, removed. */
export function slackCommandText(text: string, self?: readonly string[]): string {
  let out = text.replace(SLACK_SENT_USING, '')
  let m: RegExpExecArray | null
  while ((m = SLACK_LEADING_MENTION.exec(out)) && (!self || self.includes(m[1]!))) out = out.slice(m[0].length)
  return out
}

const READERS = new Map<string, CommandTextReader>([['slack', slackCommandText]])

/** A mention as a message's text reads it: the platform id it names and its literal text. */
export interface LeadingMention {
  id: string
  text: string
}

const MAX_LEADING_MENTIONS = 20
const MAX_MENTION_FIELD = 256

/** The mentions `text` opens with, each the longest of `mentions` ending at a space or the end; stops at a label two ids share. */
export function leadingMentions(text: string, mentions: readonly LeadingMention[]): LeadingMention[] | undefined {
  const usable = mentions.filter(
    (m) => m.id && m.text && m.id.length <= MAX_MENTION_FIELD && m.text.length <= MAX_MENTION_FIELD
  )
  const out: LeadingMention[] = []
  let at = 0
  while (out.length < MAX_LEADING_MENTIONS) {
    while (at < text.length && /\s/.test(text[at]!)) at++
    let best: LeadingMention[] = []
    for (const m of usable) {
      const next = text[at + m.text.length]
      if (!text.startsWith(m.text, at) || (next !== undefined && !/\s/.test(next))) continue
      if (!best.length || m.text.length > best[0]!.text.length) best = [m]
      else if (m.text.length === best[0]!.text.length) best.push(m)
    }
    if (new Set(best.map((m) => m.id)).size !== 1) break
    out.push({ id: best[0]!.id, text: best[0]!.text })
    at += best[0]!.text.length
  }
  return out.length ? out : undefined
}

/** The text a command addressed to the bot with ids `self` is read from: the platform's reader, then leading mentions of `self` dropped. */
export function commandText(
  msg: { platform: string; text: string; leadingMentions?: readonly LeadingMention[] },
  self: readonly string[]
): string {
  let out = READERS.get(msg.platform)?.(msg.text, self) ?? msg.text
  for (const mention of msg.leadingMentions ?? []) {
    const rest = out.trimStart()
    if (!self.includes(mention.id) || !rest.startsWith(mention.text)) break
    out = rest.slice(mention.text.length)
  }
  return out
}

// A row keeps no mention ids, so a label of one word is the only one its reading can bound.
const LEADING_LABELS = /^(?:\s*@\S+(?=\s|$))+/

/** Every reading of a recorded row, which carries no platform or receiver, with an address of anyone accepted. */
export function recordedCommandTexts(text: string): string[] {
  return [...[...READERS.values()].map((read) => read(text)), text.replace(LEADING_LABELS, '')]
}
