import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { canViewSession } from '../authorization/policy.js'
import type { ExternalScopeRecord } from '../persistence/ports.js'
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
