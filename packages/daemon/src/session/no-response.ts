/**
 * Runtime-independent "not for me" suppression.
 *
 * Every agent session receives the same standing response-choice contract. When an
 * activation is not directed at the agent, it replies with one product-specific
 * control marker; visible platform delivery boundaries suppress that marker. Direct
 * messages and direct agent calls are explicitly described as addressed, while shared
 * conversations are where the silent branch is normally useful.
 *
 * Kept in one module so the rule that TEACHES the sentinel and the convergers that
 * DETECT it (Slack/Telegram/Discord/Feishu render) can never drift apart.
 */

/** The reserved reply meaning "this message isn't for me — stay silent". */
export const NO_RESPONSE_SENTINEL = 'AC_NO_RESPONSE'

/** Standing system-prompt guidance injected into every agent session. It teaches the
 *  agent to stay silent on activations that are not for it by replying with the bare
 *  sentinel, which visible platform delivery boundaries drop before chat. */
export const NO_RESPONSE_RULE =
  `# Choosing whether to respond\n` +
  `Apply this rule in every conversation type. Respond normally to messages directed at you or clearly within ` +
  `your role. A direct message or direct agent call is addressed to you. A message that @-mentions you, directly ` +
  `replies to you, or plainly asks you something is also addressed to you. Only when an activation is not for ` +
  `you (for example, it addresses someone else, continues a conversation you are not part of, or is unrelated ` +
  `chatter between others), ` +
  `do NOT respond: your entire reply must be exactly \`${NO_RESPONSE_SENTINEL}\` — start with that token ` +
  `and stop. Do not explain why, add punctuation, or output any other text. When a message plausibly concerns ` +
  `your role and you're unsure, respond normally rather than staying silent.`

/** A compact restatement of the rule, re-injected as a system reminder on long-running
 *  sessions (every N turns, or right after a context compaction). The full rule is
 *  asserted once at session start — for Claude it lives in the persistent
 *  system-prompt append, but for non-Claude runtimes it rides only the first prompt block
 *  and is summarized away once the runtime compacts its history, so it must be re-asserted.
 *  Kept short (unlike the full rule) so periodic re-injection costs almost nothing. */
export const NO_RESPONSE_REMINDER =
  `<system-reminder>\n` +
  `The response-choice rule still applies. Follow the activation chronologically. A direct message, direct ` +
  `agent call, @-mention, direct reply, or plain request to you is for you. Only when the activation is not ` +
  `directed at you or within your role, your entire reply must be exactly ${NO_RESPONSE_SENTINEL}: start with ` +
  `that token, stop, and do not explain.\n` +
  `</system-reminder>`

/** Trusted per-turn routing context for an explicit platform @mention. Slack and
 *  similar platforms expose an opaque user id in the raw message, so the model cannot
 *  infer from its AgentConnect name alone that the token denotes its own bound bot. */
export const EXPLICIT_MENTION_REMINDER =
  `<system-reminder>\n` +
  `Routing fact: A platform message in this activation explicitly @-mentioned your bound bot identity. ` +
  `That mentioned message is directed at you, even if its raw mention is an opaque platform user ID that ` +
  `does not resemble your AgentConnect name. Follow the conversation chronologically and respond normally; ` +
  `do not return ${NO_RESPONSE_SENTINEL} merely because of that ID mismatch.\n` +
  `</system-reminder>`

/** True while `trimmedBody` could still become the bare sentinel as more chunks stream
 *  in — i.e. it is a prefix of (or exactly) the sentinel. Convergers use this to HOLD
 *  buffered body instead of posting it, so a streamed sentinel never leaks a partial
 *  post before the turn ends. Case-sensitive, so ordinary replies that merely start with
 *  "N"/"NO" are released the instant they diverge. */
export function isNoResponsePrefix(trimmedBody: string): boolean {
  return NO_RESPONSE_SENTINEL.startsWith(trimmedBody)
}

/** True when the turn is the bare sentinel, or when a non-compliant model explains itself
 *  and then emits the sentinel as the final standalone line. The terminal-line fallback is
 *  deliberately narrow: inline mentions, punctuation, fenced examples, and any content
 *  after the sentinel remain ordinary replies. */
export function isNoResponseBody(trimmedBody: string): boolean {
  const terminalLine = trimmedBody.split(/\r?\n/).at(-1)?.trim()
  return terminalLine === NO_RESPONSE_SENTINEL
}
