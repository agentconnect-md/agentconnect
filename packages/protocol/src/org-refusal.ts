import { z } from 'zod'

// Why an organization was refused, as `[ERR:<code>] <sentence>` inside any refusal's message (docs/designs/org-refusal-tag.md).

/** Registered reasons; a reader treats any other well-formed code as a refusal with no known reason. */
export const OrgRefusalCode = z.enum(['out_of_credits', 'never_funded', 'standing_lapsed'])
export type OrgRefusalCode = z.infer<typeof OrgRefusalCode>

/** A whole message in the format: the tag leads, then one space and a sentence. */
export const ORG_REFUSAL_MESSAGE = /^\[ERR:[a-z][a-z0-9_]{0,63}\] \S/

const TAG = /\[ERR:([a-z][a-z0-9_]{0,63})\] (\S[\s\S]*)$/

export interface OrgRefusal {
  /** As sent, registered or not. */
  code: string
  /** Null for a code this version does not register. */
  known: OrgRefusalCode | null
  /** The text after the tag, including anything a runtime appended. */
  sentence: string
}

/** The message a refuser sends; throws on a code or sentence outside the format. */
export function formatOrgRefusal(code: string, sentence: string): string {
  const message = `[ERR:${code}] ${sentence}`
  if (!ORG_REFUSAL_MESSAGE.test(message)) throw new Error(`not an org refusal: ${message}`)
  return message
}

/** The first tag anywhere in `text`, whatever a runtime or transport put before it; null when there is none. */
export function parseOrgRefusal(text: string): OrgRefusal | null {
  const match = TAG.exec(text)
  if (!match) return null
  const code = match[1]!
  const known = OrgRefusalCode.safeParse(code)
  return { code, known: known.success ? known.data : null, sentence: match[2]!.trim() }
}
