import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { canViewSession } from '../authorization/policy.js'
import type { ExternalScopeRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import type { FeishuSessionViewer } from './feishu-session-access.js'
import { LOGTO_ACCOUNT_TOKEN_HEADER, LogtoFederatedTokenError } from './logto-federated-token.js'
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
    headers: { [LOGTO_ACCOUNT_TOKEN_HEADER]: 'account-token' },
    oidcSubject: 'logto-subject',
    orgCtx: { orgId: 'org-1', role: 'collaborator', userId: 'user-1' },
    log: { warn: vi.fn() }
  } as unknown as FastifyRequest
}

describe('makeSessionAccessResolver', () => {
  it('proves a custom-Bot p2p owner with the different login-app user token', async () => {
    const accessTokenFor = vi.fn(async () => 'lark-user-token')
    const forRequest = vi.fn(() => ({ accessTokenFor }))
    const feishuResolve = vi.fn(async (scopes: readonly ExternalScopeRecord[], viewer?: FeishuSessionViewer) => {
      expect(scopes).toEqual([scope])
      expect(viewer?.subject).toBe('logto-subject')
      await expect(viewer?.accessTokenFor('lark')).resolves.toBe('lark-user-token')
      return { allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }], degraded: false, accessIssues: [] }
    })
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
          getExternalScopes: vi.fn(async () => [scope]),
          getExternalAccessPolicy: vi.fn(async (_orgId: string, provider: string) =>
            provider === 'feishu' ? policy : null
          )
        }
      },
      clock: { now: () => 1_000 },
      logtoIdentity: {
        feishuIdentitiesFor: async () => [{ region: 'lark', openId: 'ou_login_app' }]
      },
      feishuPlatformApps: { lark: { appId: 'cli_login_app', appSecret: 'secret' } },
      logtoFederatedToken: { forRequest },
      feishuSessionAccess: { resolve: feishuResolve }
    } as unknown as HttpDeps
    const session = {
      visibility: 'private' as const,
      ownerIdentity: 'feishu:lark:cli_custom_bot:ou_custom_app',
      externalProvider: 'feishu',
      externalScopeId: scope.id,
      externalResolution: 'settled' as const
    }

    const access = await makeSessionAccessResolver(deps).forSessions(request(), [session])

    expect(forRequest).toHaveBeenCalledWith('logto-subject', 'account-token')
    expect(access.identitySet).toContain('feishu:lark:cli_login_app:ou_login_app')
    expect(access.identitySet).not.toContain(session.ownerIdentity)
    expect(
      canViewSession(session, { userId: 'user-1', role: 'collaborator' }, access.identitySet, access.externalAccess)
    ).toBe(true)
  })

  it('logs safe federated-token diagnostics and returns an actionable access issue', async () => {
    const req = request()
    const upstream = new LogtoFederatedTokenError('Federated access token is unavailable', {
      stage: 'federated_token',
      target: 'lark',
      status: 400,
      code: 'connector.general'
    })
    const getExternalScopes = vi.fn(async (ids: readonly string[]) => (ids.length > 0 ? [scope] : []))
    const deps = {
      repos: {
        session: {
          getExternalScopes,
          getExternalAccessPolicy: vi.fn(async () => null)
        }
      },
      clock: { now: () => 1_000 },
      logtoIdentity: { feishuIdentitiesFor: async () => [] },
      logtoFederatedToken: {
        forRequest: () => ({
          accessTokenFor: async () => {
            throw upstream
          }
        })
      },
      feishuSessionAccess: {
        resolve: async (_scopes: readonly ExternalScopeRecord[], viewer?: FeishuSessionViewer) => {
          await viewer?.accessTokenFor('lark').catch(() => undefined)
          return {
            allowedScopes: [],
            degraded: true,
            accessIssues: [{ provider: 'feishu', region: 'lark', reason: 'authorization' as const }]
          }
        }
      }
    } as unknown as HttpDeps

    const access = await makeSessionAccessResolver(deps).forSessions(req, [
      {
        visibility: 'external',
        externalProvider: 'feishu',
        externalScopeId: scope.id
      }
    ])

    expect(access.accessIssues).toEqual([{ provider: 'feishu', region: 'lark', reason: 'authorization' }])
    expect(req.log.warn).toHaveBeenCalledWith(
      {
        provider: 'feishu',
        target: 'lark',
        stage: 'federated_token',
        status: 400,
        code: 'connector.general'
      },
      'Federated session access token is unavailable'
    )
  })
})
