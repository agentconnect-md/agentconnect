import { get as getEmoji } from 'node-emoji'

/**
 * Normalize Slack's message-control syntax into standard CommonMark so a plain
 * react-markdown pipeline can render transcript rows.
 *
 * Agent rows are recorded as the verbatim markdown the daemon sent (already
 * CommonMark — nothing to do). User/inbound rows still carry Slack's own markup:
 * `<@U123|name>` mentions, `<#C123|name>` channel refs, `<!here>` specials, and
 * `<url|label>` links, and standard Unicode emoji shortcodes — plus HTML-escaped
 * `&lt;` `&gt;` `&amp;` for text the user literally typed. This is a lightweight
 * pass, not a full mrkdwn parser: emphasis (`*bold*` vs `**bold**`) is left to
 * react-markdown, which reads it as CommonMark.
 *
 * Two correctness safeguards:
 *  - Interpolated display names / link labels are escaped so a name containing
 *    Markdown metacharacters (`]`, `*`, `_`, backtick, …) renders literally
 *    instead of breaking a `[label]` or turning into emphasis.
 *  - Inline/fenced code is masked before the token rewrites run, so a code sample
 *    that happens to contain `<@…>`- or `<url|…>`-looking text is left verbatim.
 *
 * Order matters: Slack control tokens use REAL angle brackets, while literal user
 * angle brackets arrive escaped, so we rewrite tokens first and only then decode
 * entities. Known tradeoff (inherited): an agent row containing a literal `&amp;`
 * is over-decoded, since rows don't carry a per-source flag.
 */

// <url|label> / <url> — only http(s)/mailto/tel targets become links.
const LINK = /<((?:https?|mailto|tel):[^>|]+)(?:\|([^>]+))?>/g
// <@U123> / <@U123|name>
const USER = /<@([^>|]+)(?:\|([^>]+))?>/g
// <#C123> / <#C123|name>
const CHANNEL = /<#([^>|]+)(?:\|([^>]+))?>/g
// <!here> / <!subteam^S123|name> / <!channel>
const SPECIAL = /<!([^>|]+)(?:\|([^>]+))?>/g
// Built-in Slack emoji shortcode form. Slack stores/renders many Unicode emoji as
// :name: in text payloads; unknown names are likely workspace custom emoji, so they
// intentionally stay as :name: until we have a workspace emoji catalog.
const EMOJI = /:([a-z0-9_+-]+):/g
// Fenced ```…``` and inline `…` code — matched first so nothing inside is rewritten.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g
// NUL sentinel that never occurs in transcript prose, used to stash code runs.
const CODE_MARK = '\u0000'

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Backslash-escape CommonMark inline-active characters so an interpolated Slack
 *  display name or link label renders as literal text, not markup. */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]()~<>]/g, '\\$&')
}

function rewriteTokens(s: string): string {
  return s
    .replace(LINK, (_m, url: string, label?: string) => (label ? `[${escapeMd(label)}](${url})` : url))
    .replace(USER, (_m, id: string, name?: string) => `@${escapeMd(name || id)}`)
    .replace(CHANNEL, (_m, id: string, name?: string) => `#${escapeMd(name || id)}`)
    .replace(SPECIAL, (_m, target: string, name?: string) => `@${escapeMd(name || target.split('^')[0] || target)}`)
    .replace(EMOJI, (m, name: string) => getEmoji(name) ?? m)
}

export function slackToMarkdown(text: string): string {
  // Stash code spans/fences behind NUL markers so the token rewrites can't reach
  // into them, run the rewrites on the rest, then restore the code verbatim.
  const code: string[] = []
  const masked = text.replace(CODE, (m) => `${CODE_MARK}${code.push(m) - 1}${CODE_MARK}`)
  const rewritten = rewriteTokens(masked)
  const restored = rewritten.replace(
    new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'),
    (_m, i: string) => code[Number(i)] ?? ''
  )
  return decodeEntities(restored)
}
