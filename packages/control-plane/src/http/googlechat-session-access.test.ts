import { describe, expect, it, vi } from 'vitest'
import { classifySession } from '../domain/session-visibility.js'
import { OrgId } from '../domain/ids.js'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import type { SessionAccessPlugin, SessionAccessViewer } from './session-access-plugin.js'
import { GoogleChatSessionAccessService } from './googlechat-session-access.js'

const PROJECT = '123456789012'
const OTHER_PROJECT = '210987654321'
const ACCOUNT = '100000000000000000001'

function bots(): BotRecord[] {
  return [
    { platform: 'googlechat', externalAppId: PROJECT, revokedAt: null },
    { platform: 'googlechat', externalAppId: PROJECT, revokedAt: null },
    { platform: 'googlechat', externalAppId: OTHER_PROJECT, revokedAt: new Date(0) },
    { platform: 'googlechat', externalAppId: null, revokedAt: null },
    { platform: 'slack', externalAppId: 'A0SLACK', revokedAt: null }
  ] as BotRecord[]
}

function viewer(oidcSubject: string | null = 'logto-sub'): SessionAccessViewer {
  return {
    request: (oidcSubject ? { oidcSubject } : {}) as never,
    orgId: OrgId('org-1'),
    userId: 'user-1',
    identitySet: new Set(['user:user-1'])
  }
}

function setup(opts: { reported?: () => Promise<string | null>; recorded?: string | null; bots?: BotRecord[] } = {}) {
  const googleAccountIdFor = vi.fn(opts.reported ?? (async () => ACCOUNT))
  const setGoogleAccountId = vi.fn(async () => {})
  const listForOrg = vi.fn(async () => opts.bots ?? bots())
  const service = new GoogleChatSessionAccessService({
    bots: { listForOrg },
    users: { getGoogleAccountId: async () => opts.recorded ?? null, setGoogleAccountId },
    identity: { googleAccountIdFor }
  })
  return { service, googleAccountIdFor, setGoogleAccountId, listForOrg }
}

/** The owner the ingest path records for a DM this account sent through this app. */
function dmOwner(project: string, account: string): string | null {
  const classified = classifySession({
    platform: 'googlechat',
    conversationKind: 'dm',
    transportScope: project,
    triggeredBy: `users/${account}`
  })
  return classified.inherit ? null : classified.ownerIdentity
}

describe('GoogleChatSessionAccessService', () => {
  it('adds the owner that a DM from this Google account records, under every Chat app of the org', async () => {
    const { service, googleAccountIdFor } = setup()
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet).toEqual(
      new Set(['user:user-1', dmOwner(PROJECT, ACCOUNT), dmOwner(OTHER_PROJECT, ACCOUNT)])
    )
    // Served under the identity lease, never a fresh identity provider read.
    expect(googleAccountIdFor).toHaveBeenCalledWith('logto-sub', undefined)
  })

  it('does not match a DM sent by a different Google account', async () => {
    const { service } = setup({ reported: async () => '100000000000000000002' })
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet.has(dmOwner(PROJECT, ACCOUNT)!)).toBe(false)
  })

  it('adds nothing for a viewer without a Google identity and clears a stale recorded id', async () => {
    const { service, setGoogleAccountId } = setup({ reported: async () => null, recorded: ACCOUNT })
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet).toEqual(new Set(['user:user-1']))
    expect(setGoogleAccountId).toHaveBeenCalledWith('user-1', null)
  })

  it('fails closed on an identity provider failure and caches nothing', async () => {
    const reported = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('logto user lookup failed: 503'))
      .mockResolvedValueOnce(ACCOUNT)
    const { service, setGoogleAccountId } = setup({ reported, recorded: ACCOUNT })
    const failed = viewer()

    await expect(service.addViewerIdentities(failed)).rejects.toThrow('503')
    expect(failed.identitySet).toEqual(new Set(['user:user-1']))
    expect(setGoogleAccountId).not.toHaveBeenCalled()

    const retried = viewer()
    await service.addViewerIdentities(retried)
    expect(retried.identitySet.has(dmOwner(PROJECT, ACCOUNT)!)).toBe(true)
    expect(reported).toHaveBeenCalledTimes(2)
  })

  it('asks the identity provider nothing for a caller without a verified subject or an org without Chat apps', async () => {
    const unverified = setup()
    await unverified.service.addViewerIdentities(viewer(null))
    expect(unverified.listForOrg).not.toHaveBeenCalled()
    expect(unverified.googleAccountIdFor).not.toHaveBeenCalled()

    const noChat = setup({ bots: [{ platform: 'slack', externalAppId: 'A0SLACK', revokedAt: null } as BotRecord] })
    const current = viewer()
    await noChat.service.addViewerIdentities(current)
    expect(noChat.googleAccountIdFor).not.toHaveBeenCalled()
    expect(current.identitySet).toEqual(new Set(['user:user-1']))
  })

  it('is available only with an identity provider client', async () => {
    expect(setup().service.available).toBe(true)
    const listForOrg = vi.fn(async () => bots())
    const without = new GoogleChatSessionAccessService({
      bots: { listForOrg },
      users: { getGoogleAccountId: async () => ACCOUNT, setGoogleAccountId: async () => {} }
    })
    const current = viewer()

    await without.addViewerIdentities(current)

    expect(without.available).toBe(false)
    expect(listForOrg).not.toHaveBeenCalled()
    expect(current.identitySet).toEqual(new Set(['user:user-1']))
  })

  it('resolves no scope, leaving a Space to organization visibility', async () => {
    const space: ExternalScopeRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      orgId: OrgId('org-1'),
      provider: 'googlechat',
      realmKey: PROJECT,
      resourceKind: 'conversation',
      resourceKey: 'spaces/AAAAAAAAAAA',
      credentialKind: 'bot',
      credentialId: 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      aclRevision: 1n,
      revokedAt: null
    }
    const plugin: SessionAccessPlugin = setup().service
    const current = viewer()
    await plugin.addViewerIdentities!(current)

    await expect(plugin.resolve([space], current)).resolves.toEqual({
      allowedScopes: [],
      degraded: false,
      accessIssues: []
    })
  })
})
