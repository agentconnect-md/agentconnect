import { createHash } from 'node:crypto'

/** Backend identities are opaque, including legacy runtime ids; aliases are bounded canonical URI segments. */
export function historicalSessionUri(scope: { orgId: string; agentId: string; sessionId: string }): string {
  const digest = createHash('sha256')
    .update('agentconnect.ahp-session-uri.v1\0')
    .update(JSON.stringify([scope.orgId, scope.agentId, scope.sessionId]))
    .digest('hex')
  return `ahp-session:/session/${digest}`
}
