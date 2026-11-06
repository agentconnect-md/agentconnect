// The attribution footer a change request's description carries (github-app-git-credentials.md, Daemon-Mediated Agent Access).
import type { CodeHostBrokerOperation } from './broker.js'

/** Everything from this hidden line down is the daemon's: a rewrite replaces only the text above it. */
export const DESCRIPTION_FOOTER_MARKER = '<!-- agentconnect:attribution -->'

/** The agent's own text: a daemon footer it copied in, and anything after it, is dropped. */
export function descriptionBody(description: string): string {
  const at = description.indexOf(DESCRIPTION_FOOTER_MARKER)
  return (at === -1 ? description : description.slice(0, at)).trimEnd()
}

/** The description as published: the agent's text, then the marker and `footer` when there is one. */
export function withDescriptionFooter(description: string | undefined, footer: string): string {
  const body = descriptionBody(description ?? '')
  if (!footer.trim()) return body
  return `${body}${body ? '\n\n' : ''}${DESCRIPTION_FOOTER_MARKER}${footer}`
}

/** A create or a description rewrite, with the footer in place; every other operation passes through. */
export function withOperationFooter(op: CodeHostBrokerOperation, footer: string): CodeHostBrokerOperation {
  if (op.kind === 'createMergeRequest' && (op.description !== undefined || footer.trim()))
    return { ...op, description: withDescriptionFooter(op.description, footer) }
  if (op.kind === 'updateMergeRequest' && op.description !== undefined)
    return { ...op, description: withDescriptionFooter(op.description, footer) }
  return op
}
