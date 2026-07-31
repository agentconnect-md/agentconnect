import { createHash } from 'node:crypto'
import type { OrganizationSuggestionRecord } from '../persistence/ports.js'

/** Stable token for every review-relevant field in an inspected suggestion.
 * `digest` + `contentBytes` bind the staged body; transport location and
 * timestamps are excluded so an identical candidate survives daemon reconnects. */
export function organizationSuggestionSnapshotToken(
  suggestion: Pick<
    OrganizationSuggestionRecord,
    | 'id'
    | 'orgId'
    | 'sourceAgentId'
    | 'dreamId'
    | 'candidateId'
    | 'kind'
    | 'operation'
    | 'targetArtifactId'
    | 'targetRevision'
    | 'title'
    | 'summary'
    | 'tags'
    | 'digest'
    | 'contentBytes'
    | 'sessionIds'
  >
): string {
  const canonical = JSON.stringify({
    id: suggestion.id,
    orgId: suggestion.orgId,
    sourceAgentId: suggestion.sourceAgentId,
    dreamId: suggestion.dreamId,
    candidateId: suggestion.candidateId,
    kind: suggestion.kind,
    operation: suggestion.operation,
    targetArtifactId: suggestion.targetArtifactId,
    targetRevision: suggestion.targetRevision,
    title: suggestion.title,
    summary: suggestion.summary,
    tags: suggestion.tags,
    digest: suggestion.digest,
    contentBytes: suggestion.contentBytes,
    sessionIds: suggestion.sessionIds
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}
