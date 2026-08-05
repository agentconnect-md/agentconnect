import { describe, expect, it, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { makeViewerIdentitySet } from './viewer-identity.js'
import { LogtoApiError } from '../github/logto-identity.js'

function reqOf(input: { userId: string; oidcSubject?: string }): FastifyRequest {
  return {
    orgCtx: { orgId: 'org-1', role: 'collaborator', userId: input.userId },
    ...(input.oidcSubject ? { oidcSubject: input.oidcSubject } : {}),
    log: { warn: vi.fn() }
  } as unknown as FastifyRequest
}

describe('makeViewerIdentitySet', () => {
  it('adds the linked Slack identity as the three-part ownerIdentity tuple', async () => {
    const slackIdentityFor = vi.fn(async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' }))
    const resolve = makeViewerIdentitySet({ slackIdentityFor })

    const set = await resolve(reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' }))

    expect(set).toEqual(new Set(['user:u-1', 'slack:T024BE7LD:U0123ABCD']))
    expect(slackIdentityFor).toHaveBeenCalledWith('logto-sub')
  })

  it('adds the same Lark union_id in every active app domain registered to the org', async () => {
    const resolve = makeViewerIdentitySet(
      { feishuIdentitiesFor: async () => [{ region: 'lark', unionId: 'on_member' }] },
      {
        listForOrg: async () =>
          [
            { platform: 'feishu', feishuRegion: 'lark', feishuAppId: 'cli_one', revokedAt: null },
            { platform: 'feishu', feishuRegion: 'lark', feishuAppId: 'cli_two', revokedAt: null },
            { platform: 'feishu', feishuRegion: 'feishu', feishuAppId: 'cli_mainland', revokedAt: null }
          ] as never
      }
    )
    expect(await resolve(reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' }))).toEqual(
      new Set(['user:u-1', 'feishu:lark:cli_one:on_member', 'feishu:lark:cli_two:on_member'])
    )
  })

  it('does not admit a Lark union_id without a registered app domain', async () => {
    const resolve = makeViewerIdentitySet({
      feishuIdentitiesFor: async () => [{ region: 'lark', unionId: 'on_member' }]
    })
    expect(await resolve(reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' }))).toEqual(new Set(['user:u-1']))
  })

  it('stays console-only without an OIDC subject (devAuth / API key)', async () => {
    const slackIdentityFor = vi.fn(async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' }))
    const resolve = makeViewerIdentitySet({ slackIdentityFor })

    expect(await resolve(reqOf({ userId: 'u-1' }))).toEqual(new Set(['user:u-1']))
    // The provider is never consulted — an unverified principal must not
    // borrow whatever identity happens to live behind a lookalike subject.
    expect(slackIdentityFor).not.toHaveBeenCalled()
  })

  it('stays console-only when identity management is not configured', async () => {
    const resolve = makeViewerIdentitySet(undefined)
    expect(await resolve(reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' }))).toEqual(new Set(['user:u-1']))
  })

  it('stays console-only when the account has no Slack identity', async () => {
    const resolve = makeViewerIdentitySet({ slackIdentityFor: async () => null })
    expect(await resolve(reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' }))).toEqual(new Set(['user:u-1']))
  })

  it('fails closed (console identity only) when the provider read errors', async () => {
    const resolve = makeViewerIdentitySet({
      slackIdentityFor: async () => {
        throw new LogtoApiError('logto unreachable', 0, true)
      }
    })
    const req = reqOf({ userId: 'u-1', oidcSubject: 'logto-sub' })

    expect(await resolve(req)).toEqual(new Set(['user:u-1']))
    expect(req.log.warn).toHaveBeenCalledOnce()
  })
})
