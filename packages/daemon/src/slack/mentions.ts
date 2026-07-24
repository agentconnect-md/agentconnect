/**
 * Slack `<@U…>` user-mention helpers, shared by the name-resolver (which warms the
 * display-name cache for mentioned users) and the session reader (which rewrites
 * mentions to `@name` for read-back). Slack encodes a user mention as `<@U123>` or
 * `<@U123|label>`; the id is a `U…`/`W…` user id (resolvable via users.info even for
 * a bot's user id, unlike a bot SENDER's `B…` id).
 */

// Global + capture so we can both iterate ids and String.replace over the text.
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

/** Distinct `U…/W…` user ids mentioned in a message body (empty for none/nullish). */
export function mentionedUserIds(text?: string | null): string[] {
  if (!text) return []
  const ids = new Set<string>()
  for (const m of text.matchAll(MENTION_RE)) ids.add(m[1]!)
  return [...ids]
}

/** Rewrite `<@U123>` / `<@U123|x>` to `@<display name>` when the id is known; an
 *  unknown id is left as the raw token so the web renderer's own fallback applies. */
export function substituteUserMentions(text: string, names: Map<string, string>): string {
  return text.replace(MENTION_RE, (raw, id: string) => {
    const name = names.get(id)
    return name ? `@${name}` : raw
  })
}
