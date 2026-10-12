import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'
import type { SessionAccessPlugin } from './session-access-plugin.js'
import { sessionsVisibleTo } from './read-access.js'

const AGENT = '11111111-1111-4111-8111-111111111111'

/** Sessions as the console stores them; a DM on a platform without sync, or with sync off, is org-visible. */
const ROWS: Record<string, Record<string, unknown>> = {
  'ses-channel': { visibility: 'org', ownerIdentity: null, platform: 'slack' },
  'ses-dm': { visibility: 'private', ownerIdentity: 'slack:T0AAA:U_P', platform: 'slack' },
  'ses-slack-dm-off': { visibility: 'org', ownerIdentity: 'slack:T0AAA:U_P', platform: 'slack' },
  'ses-tg-dm': { visibility: 'org', ownerIdentity: 'telegram:bot-1:42', platform: 'telegram' },
  'ses-dc-dm': { visibility: 'org', ownerIdentity: 'discord:guild-1:77', platform: 'discord' },
  'ses-dm-unowned': { visibility: 'org', ownerIdentity: null, platform: 'telegram' },
  'ses-web-p': { visibility: 'private', ownerIdentity: 'user:user-p', platform: 'webchat' },
  'ses-web-org': { visibility: 'org', ownerIdentity: 'user:user-p', platform: 'webchat' },
  'ses-other-agent': {
    visibility: 'org',
    ownerIdentity: null,
    platform: 'slack',
    agentId: '22222222-2222-4222-8222-222222222222'
  }
}

function deps(): HttpDeps {
  // A viewer's linked chat identities come from the sign-in provider, keyed by their own subject.
  const linked: SessionAccessPlugin = {
    provider: 'slack',
    available: true,
    addViewerIdentities: async ({ request, identitySet }) => {
      if (request.oidcSubject === 'sub:user-p') identitySet.add('slack:T0AAA:U_P')
      if (request.oidcSubject === 'sub:user-tg') identitySet.add('telegram:bot-1:42')
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
    sessionAccessPlugins: [linked]
  } as unknown as HttpDeps
}

const log = () => ({ warn: vi.fn() }) as never
const viewer = (userId: string, orgId = 'org-1') => ({ orgId, userId, role: 'owner' as const })

describe('sessionsVisibleTo', () => {
  it("gives the console's own verdict: org sessions to any member, private ones to their owner alone", async () => {
    const visible = sessionsVisibleTo(deps(), log)
    const all = ['ses-channel', 'ses-dm', 'ses-web-p', 'ses-other-agent', 'ses-missing']
    expect(await visible(viewer('user-p'), AGENT, all, false)).toEqual(['ses-channel', 'ses-dm', 'ses-web-p'])
    expect(await visible(viewer('user-q'), AGENT, all, false)).toEqual(['ses-channel'])
    expect(await visible(viewer('user-p', 'org-2'), AGENT, all, false)).toEqual([])
  })

  it('reads an org-visible DM only for its recorded owner, and one with no owner for nobody', async () => {
    const visible = sessionsVisibleTo(deps(), log)
    const dms = ['ses-tg-dm', 'ses-dc-dm', 'ses-slack-dm-off', 'ses-dm-unowned']
    // The console shows every member these sessions; the read rule does not.
    expect(await visible(viewer('user-q'), AGENT, dms, false)).toEqual(dms)
    expect(await visible(viewer('user-q'), AGENT, dms, true)).toEqual([])
    expect(await visible(viewer('user-p'), AGENT, dms, true)).toEqual(['ses-slack-dm-off'])
    expect(await visible(viewer('user-tg'), AGENT, dms, true)).toEqual(['ses-tg-dm'])
  })

  it('reads a webchat conversation only for its owner, whether or not the daemon asked for ownership', async () => {
    const visible = sessionsVisibleTo(deps(), log)
    expect(await visible(viewer('user-p'), AGENT, ['ses-web-p', 'ses-web-org'], false)).toEqual([
      'ses-web-p',
      'ses-web-org'
    ])
    expect(await visible(viewer('user-q'), AGENT, ['ses-web-p', 'ses-web-org'], false)).toEqual([])
  })
})
