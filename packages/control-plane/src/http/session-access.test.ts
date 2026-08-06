import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { canViewSession } from '../authorization/policy.js'
import type { ExternalScopeRecord, SessionFilterQuery } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import type { SessionAccessPlugin } from './session-access-plugin.js'
import { makeSessionAccessResolver } from './session-access.js'

const scope: ExternalScopeRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  provider: 'feishu',
  realmKey: 'lark:cli_custom_bot',
  resourceKind: 'conversation',
  resourceKey: 'oc_p2p',
  credentialKind: 'bot',
  credentialId: '22222222-2222-4222-8222-222222222222',
  aclRevision: 2n,
  revokedAt: null
}

function request(): FastifyRequest {
  return {
    headers: {},
    oidcSubject: 'logto-subject',
    orgCtx: { orgId: 'org-1', role: 'collaborator', userId: 'user-1' },
    log: { warn: vi.fn() }
  } as unknown as FastifyRequest
}

describe('makeSessionAccessResolver', () => {
  it('matches a custom-Bot p2p owner by union_id without an external access check', async () => {
    const getExternalScopes = vi.fn(async () => [scope])
    const resolve = vi.fn(async (scopes: readonly ExternalScopeRecord[]) => {
      expect(scopes).toEqual([])
      return { allowedScopes: [], degraded: false, accessIssues: [] }
    })
    const plugin: SessionAccessPlugin = {
      provider: 'feishu',
      available: true,
      addViewerIdentities: async ({ identitySet }) => {
        identitySet.add('feishu:lark:cli_custom_bot:on_member')
      },
      resolve
    }
    const policy = {
      orgId: 'org-1',
      provider: 'feishu',
      state: 'disabled',
      currentRev: 0n,
      readFenceRev: null,
      migrationCursor: null
    } as const
    const deps = {
      repos: {
        session: {
          getExternalScopes,
          getExternalAccessPolicy: vi.fn(async (_orgId: string, provider: string) =>
            provider === 'feishu' ? policy : null
          )
        }
      },
      clock: { now: () => 1_000 },
      sessionAccessPlugins: [plugin]
    } as unknown as HttpDeps
    const session = {
      visibility: 'private' as const,
      ownerIdentity: 'feishu:lark:cli_custom_bot:on_member',
      externalProvider: 'feishu',
      externalScopeId: scope.id,
      externalResolution: 'settled' as const
    }

    const access = await makeSessionAccessResolver(deps).forSessions(request(), [session])

    expect(getExternalScopes).toHaveBeenCalledWith([scope.id])
    expect(access.identitySet).toContain(session.ownerIdentity)
    expect(
      canViewSession(session, { userId: 'user-1', role: 'collaborator' }, access.identitySet, access.externalAccess)
    ).toBe(true)
  })

  it('passes the login union_id to the Bot-app group membership resolver', async () => {
    const getExternalScopes = vi.fn(async (ids: readonly string[]) => (ids.length > 0 ? [scope] : []))
    const resolve = vi.fn(async (scopes: readonly ExternalScopeRecord[], viewer) => {
      expect(viewer.identitySet).toContain('feishu:lark:cli_custom_bot:on_member')
      return {
        allowedScopes: scopes.map(({ id, aclRevision }) => ({ id, aclRevision })),
        degraded: false,
        accessIssues: []
      }
    }) satisfies SessionAccessPlugin['resolve']
    const deps = {
      repos: {
        session: {
          getExternalScopes,
          getExternalAccessPolicy: vi.fn(async () => null)
        }
      },
      clock: { now: () => 1_000 },
      sessionAccessPlugins: [
        {
          provider: 'feishu',
          available: true,
          addViewerIdentities: async ({ identitySet }) => {
            identitySet.add('feishu:lark:cli_custom_bot:on_member')
          },
          resolve
        }
      ]
    } as unknown as HttpDeps

    const access = await makeSessionAccessResolver(deps).forSessions(request(), [
      {
        visibility: 'external',
        ownerIdentity: null,
        externalProvider: 'feishu',
        externalScopeId: scope.id
      }
    ])

    expect(access.degraded).toBe(false)
    expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
  })
})

/**
 * One console page load asks the same authorization question from `/sessions`,
 * `/sessions/facets` and `/usage` at once, and each answer used to cost its own
 * provider sweep — which is what made those three the only reads on the page
 * measured in seconds.
 */
describe('makeSessionAccessResolver snapshot', () => {
  const query: SessionFilterQuery = { agentIds: [] } as unknown as SessionFilterQuery

  function harness(scopes: readonly ExternalScopeRecord[] = [scope]) {
    const clock = new FakeClock()
    const resolve = vi.fn(async (given: readonly ExternalScopeRecord[]) => ({
      allowedScopes: given.map(({ id, aclRevision }) => ({ id, aclRevision })),
      degraded: false,
      accessIssues: []
    })) satisfies SessionAccessPlugin['resolve']
    const deps = {
      repos: {
        session: {
          listExternalScopes: vi.fn(async () => scopes),
          getExternalScopes: vi.fn(async (ids: readonly string[]) => scopes.filter((row) => ids.includes(row.id))),
          getExternalAccessPolicy: vi.fn(async () => null)
        }
      },
      clock,
      sessionAccessPlugins: [{ provider: 'feishu', available: true, resolve }]
    } as unknown as HttpDeps
    return { deps, clock, resolve }
  }

  it('collapses the concurrent reads of one page load into a single provider sweep', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    const [first, second, third] = await Promise.all([
      resolver.forQuery(request(), query),
      resolver.forQuery(request(), query),
      resolver.forQuery(request(), query)
    ])

    expect(resolve).toHaveBeenCalledTimes(1)
    for (const access of [first, second, third]) {
      expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
    }
  })

  it('shares one snapshot across the route modules that each build a resolver', async () => {
    const { deps, resolve } = harness()

    await makeSessionAccessResolver(deps).forQuery(request(), query)
    await makeSessionAccessResolver(deps).forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('re-asks the providers once the snapshot window closes', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(4_999)
    await resolver.forQuery(request(), query)
    expect(resolve).toHaveBeenCalledTimes(1)

    clock.advance(2)
    await resolver.forQuery(request(), query)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('keys the snapshot on the scope set, so a re-fenced scope never hits a stale entry', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    // An ACL bump rewrites `aclRevision`; the same conversation is now a
    // different authorization question and must not reuse the old answer.
    deps.repos.session.listExternalScopes = vi.fn(async () => [{ ...scope, aclRevision: 3n }]) as never
    await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('never caches a failed sweep as a verdict', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)
    resolve.mockRejectedValueOnce(new Error('slack unreachable'))

    await expect(resolver.forQuery(request(), query)).rejects.toThrow('slack unreachable')
    const access = await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
  })
})
