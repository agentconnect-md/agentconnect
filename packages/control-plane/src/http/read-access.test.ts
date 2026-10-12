import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'
import type { SessionAccessPlugin } from './session-access-plugin.js'
import { sessionsVisibleTo } from './read-access.js'

const AGENT = '11111111-1111-4111-8111-111111111111'

/** Sessions as the console stores them: an org-visible channel, a Slack DM and a Playground conversation. */
const ROWS: Record<string, Record<string, unknown>> = {
  'ses-channel': { visibility: 'org', ownerIdentity: null },
  'ses-dm': { visibility: 'private', ownerIdentity: 'slack:T0AAA:U_P' },
  'ses-web-p': { visibility: 'private', ownerIdentity: 'user:user-p' },
  'ses-other-agent': { visibility: 'org', ownerIdentity: null, agentId: '22222222-2222-4222-8222-222222222222' }
}

function deps(): HttpDeps {
  // The viewer's linked Slack identity comes from the sign-in provider, keyed by their own subject.
  const slack: SessionAccessPlugin = {
    provider: 'slack',
    available: true,
    addViewerIdentities: async ({ request, identitySet }) => {
      if (request.oidcSubject === 'sub:user-p') identitySet.add('slack:T0AAA:U_P')
    },
    resolve: async () => ({ allowedScopes: [], degraded: false, accessIssues: [] })
  }
  return {
    repos: {
      session: {
        getUnscoped: vi.fn(async (id: string) =>
          ROWS[id]
            ? {
                id,
                orgId: OrgId('org-1'),
                agentId: AGENT,
                externalProvider: null,
                externalScopeId: null,
                externalResolution: null,
                ...ROWS[id]
              }
            : null
        ),
        getExternalScopes: vi.fn(async () => []),
        getExternalAccessPolicy: vi.fn(async () => null)
      },
      user: { getOidcSubject: vi.fn(async (userId: string) => `sub:${userId}`) }
    },
    clock: { now: () => 1_000 },
    sessionAccessPlugins: [slack]
  } as unknown as HttpDeps
}

const log = () => ({ warn: vi.fn() }) as never

describe('sessionsVisibleTo', () => {
  it("gives the console's own verdict: org sessions to any member, private ones to their owner alone", async () => {
    const visible = sessionsVisibleTo(deps(), log)
    const all = ['ses-channel', 'ses-dm', 'ses-web-p', 'ses-other-agent', 'ses-missing']
    expect(await visible({ orgId: 'org-1', userId: 'user-p', role: 'viewer' }, AGENT, all)).toEqual([
      'ses-channel',
      'ses-dm',
      'ses-web-p'
    ])
    expect(await visible({ orgId: 'org-1', userId: 'user-q', role: 'owner' }, AGENT, all)).toEqual(['ses-channel'])
    expect(await visible({ orgId: 'org-2', userId: 'user-p', role: 'owner' }, AGENT, all)).toEqual([])
  })
})
