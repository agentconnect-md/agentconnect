// The text a control command is read from: a platform drops its own address of the receiving bot and its own attribution suffix.

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

/** The text a command addressed to the bot with ids `self` is read from; unchanged on a platform with no reader. */
export function commandText(platform: string, text: string, self: readonly string[]): string {
  return READERS.get(platform)?.(text, self) ?? text
}

/** Every platform's reading of a recorded row, which carries no platform or receiver, with an address of anyone accepted. */
export function recordedCommandTexts(text: string): string[] {
  return [...READERS.values()].map((read) => read(text))
}
