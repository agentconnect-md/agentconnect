import { describe, expect, it } from 'vitest'
import type { CodehostTurnFacts } from '@agentconnect.md/protocol/user-turn-body'
import { codeHostTurnRouting } from './SessionDecisionResults'

const facts = (patch: Partial<CodehostTurnFacts>): CodehostTurnFacts => ({
  provider: 'github',
  event: 'issues:opened',
  subject: { repo: 'example-org/example-repo', number: 7 },
  ...patch
})
const routing = { repoId: '42', family: 'issues' as const, decisionId: 'd1', verdictSeq: 9 }

describe('codeHostTurnRouting', () => {
  it('addresses the routed turn’s verdict in its repository lane', () => {
    expect(codeHostTurnRouting(facts({ routing }))).toEqual({
      scope: { provider: 'github', repoId: '42', family: 'issues' },
      seq: 9
    })
  })

  it('returns null for an unrouted turn or a family its provider does not route', () => {
    expect(codeHostTurnRouting(facts({}))).toBeNull()
    expect(codeHostTurnRouting(undefined)).toBeNull()
    expect(codeHostTurnRouting(facts({ routing: { ...routing, family: 'merge_request' } }))).toBeNull()
  })
})
