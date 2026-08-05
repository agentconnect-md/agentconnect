import type { FastifyRequest } from 'fastify'
import type { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord } from '../persistence/ports.js'

export interface SessionAccessIssue {
  provider: string
  region?: string
  reason: 'authorization' | 'unavailable'
}

export interface SessionAccessViewer {
  request: FastifyRequest
  orgId: OrgId
  userId: string
  identitySet: Set<string>
}

export interface SessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
  accessIssues?: SessionAccessIssue[]
}

/** Provider-owned half of Session visibility. Core only composes Agent
 * visibility with the result returned here. */
export interface SessionAccessPlugin {
  provider: string
  available: boolean
  addViewerIdentities?(viewer: SessionAccessViewer): Promise<void>
  resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult>
}
