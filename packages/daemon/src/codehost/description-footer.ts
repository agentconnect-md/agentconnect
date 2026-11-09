// The attribution footer a change request's or an issue's description carries (github-app-git-credentials.md, Daemon-Mediated Agent Access).
import type { CodeHostBrokerOperation } from './broker.js'
import { escapeMarkdownText } from '../github/poster.js'

/** Everything from this hidden line down is the daemon's: a rewrite replaces only the text above it. */
export const DESCRIPTION_FOOTER_MARKER = '<!-- agentconnect:attribution -->'

/** Recover only the initiator recorded in the published system footer, never the model's replacement body. */
export function descriptionInitiator(description: string): string | undefined {
  const at = description.indexOf(DESCRIPTION_FOOTER_MARKER)
  const encoded =
    at < 0 ? undefined : /<!-- agentconnect:initiator ([A-Za-z0-9_-]+) -->/.exec(description.slice(at))?.[1]
  return encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : undefined
}

/** Names are plain attribution text, so a display name cannot add Markdown or notify a GitHub account. */
export function initiatorFooter(initiator: string): string {
  const encoded = Buffer.from(initiator, 'utf8').toString('base64url')
  const name = escapeMarkdownText(initiator).replace(/@/g, '&#64;')
  return `\n\n<!-- agentconnect:initiator ${encoded} -->\n\nInitiated by **${name}**`
}

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

/** A create or a description rewrite of a change request or an issue, with the footer in place; every other operation passes through. */
export function withOperationFooter(
  op: CodeHostBrokerOperation,
  footer: string,
  initiator?: string
): CodeHostBrokerOperation {
  if (initiator && (op.kind === 'createMergeRequest' || op.kind === 'updateMergeRequest'))
    footer = initiatorFooter(initiator) + footer
  const creates = op.kind === 'createMergeRequest' || op.kind === 'createIssue'
  const rewrites = op.kind === 'updateMergeRequest' || op.kind === 'updateIssue'
  if (creates && (op.description !== undefined || footer.trim()))
    return { ...op, description: withDescriptionFooter(op.description, footer) }
  if (rewrites && op.description !== undefined)
    return { ...op, description: withDescriptionFooter(op.description, footer) }
  return op
}
