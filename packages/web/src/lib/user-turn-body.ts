import type { UserTurnBody } from '@agentconnect.md/protocol'
import { CodehostTurnFacts, LinearTurnFacts } from '@agentconnect.md/protocol/user-turn-body'

/**
 * The `UserTurnBody` behind a text row (transcript-full-tool-body.md §9), decoded fail-closed
 * against the protocol's own schemas: a row from before the body existed, a tool body, a corrupt
 * string, or a fact of the wrong shape yields no fold rather than one that throws when opened.
 * The console never reads `prompt`; only the facts, each validated whole.
 */
export function parseUserTurnBody(body: string | undefined): UserTurnBody | undefined {
  if (!body) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { linear, codehost } = parsed as { linear?: unknown; codehost?: unknown }
  const facts: UserTurnBody = {}
  const linearFacts = LinearTurnFacts.safeParse(linear)
  if (linearFacts.success) facts.linear = linearFacts.data
  const codehostFacts = CodehostTurnFacts.safeParse(codehost)
  if (codehostFacts.success) facts.codehost = codehostFacts.data
  return facts.linear || facts.codehost ? facts : undefined
}

/** `7830b10` — the seven characters a person quotes a commit by. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

const XML_ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }

/** `&lt;` and friends, as Linear's XML-shaped context escapes them. */
const decodeEntities = (value: string): string =>
  value.replace(/&(lt|gt|quot|#39|amp);/g, (entity) => XML_ENTITIES[entity] ?? entity).trim()

/**
 * Linear hands the agent the issue as XML-shaped text (`promptContext`): `<issue …><title>…</title>
 * <description>…</description> …</issue>`. The console shows the description as the markdown it is.
 *
 * Three shapes, because the relay cuts the context at a byte budget and carries `truncated`:
 * a closed `<description>` is that element; an OPEN one whose close was cut away is everything
 * after it, so a long description stays readable; and an `<issue>` envelope with no such element
 * at all is an issue that has none — its identifier, title and team are rows of their own, so the
 * envelope is not worth printing back. Only a context that is not the envelope at all is shown
 * whole, since guessing at its shape would hide it.
 */
export function linearDescriptionMarkdown(description: string): { markdown: string; parsed: boolean } {
  const closed = /<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i.exec(description)
  if (closed) return { markdown: decodeEntities(closed[1]!), parsed: true }
  const open = /<description(?:\s[^>]*)?>([\s\S]*)$/i.exec(description)
  if (open) return { markdown: decodeEntities(open[1]!), parsed: true }
  if (/^\s*<issue[\s>]/i.test(description)) return { markdown: '', parsed: true }
  return { markdown: description, parsed: false }
}
