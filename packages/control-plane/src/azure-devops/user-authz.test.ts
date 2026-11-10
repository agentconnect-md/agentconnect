import { describe, expect, it, vi } from 'vitest'
import {
  FakeAzureDevOps,
  LINKED_MICROSOFT,
  ORGANIZATION,
  PROJECT_ID,
  REPOSITORY_ID,
  SECOND_REPOSITORY_ID,
  TENANT_ID,
  USER_IDENTITY_ID,
  exampleRepository
} from '../../test/fakes/azure-devops-api.js'
import type { AzureDevOpsConnectionRecord } from '../persistence/ports.js'
import { LogtoApiError, type MicrosoftIdentity } from '../github/logto-identity.js'
import { AzureDevOpsUserAuthzService } from './user-authz.js'
import { azureIdentityVerificationRequired } from './user-identity.js'
import { readEffectivePermissionBits } from './user-access-api.js'
import { GIT_REPOSITORIES_NAMESPACE } from './api.js'

const connection = { id: 'connection', organization: ORGANIZATION, tenantId: TENANT_ID } as AzureDevOpsConnectionRecord
const repository = {
  ...exampleRepository(),
  cloneUrl: 'https://dev.azure.com/example-org/p/_git/r',
  defaultBranch: 'main'
}
const located = { connection, repository }
const gitToken = `repoV2/${PROJECT_ID}/${REPOSITORY_ID}`
const projectToken = `$PROJECT:vstfs:///Classification/TeamProject/${PROJECT_ID}`
const tokens = {
  withApi: async <T>(_connection: AzureDevOpsConnectionRecord, call: (token: string) => Promise<T>): Promise<T> =>
    call('example-token-1')
}

function harness() {
  const fake = new FakeAzureDevOps()
  const identity = vi.fn(async () => LINKED_MICROSOFT)
  const tenantIdentity = vi.fn<
    (_userId: string, _linked: MicrosoftIdentity, _tenantId: string) => Promise<MicrosoftIdentity | null>
  >(async () => null)
  const authz = new AzureDevOpsUserAuthzService({
    api: fake.api,
    service: tokens,
    microsoftIdentityFor: identity,
    microsoftTenantIdentityFor: tenantIdentity
  })
  return { fake, authz, identity, tenantIdentity }
}

describe('Azure repository authority from the existing Microsoft identity', () => {
  it('uses the caller’s identity and effective group/inherited grants, even without a direct ACE', async () => {
    const { fake, authz, identity, tenantIdentity } = harness()
    expect(await authz.assertAccess('acting-user', located, 'write')).toEqual({ read: true, write: true })
    expect(identity).toHaveBeenCalledWith('acting-user')
    expect(tenantIdentity).not.toHaveBeenCalled()
    const permissions = fake.requests.filter((request) => request.url.includes('/accesscontrollists/'))
    expect(permissions).toHaveLength(2)
    for (const request of permissions) {
      const query = new URL(request.url).searchParams
      expect(query.get('descriptors')).toBe(fake.user.descriptor)
      expect(query.get('includeExtendedInfo')).toBe('true')
      expect(query.get('recurse')).toBe('false')
    }
    expect(fake.requests.every((request) => request.method === 'GET')).toBe(true)
    expect(fake.requests.find((request) => request.url.includes('/userentitlements'))!.url).not.toContain('select=')
  })

  it('uses effective denial and rechecks after a previous allow, including read-to-comment increases', async () => {
    const { fake, authz } = harness()
    await authz.assertAccess('user', located, 'write')
    fake.effectivePermissions.set(gitToken, { effectiveAllow: 6, effectiveDeny: 4 })
    expect(await authz.assertAccess('user', located, 'comment')).toEqual({ read: true, write: false })
    await expect(authz.assertAccess('user', located, 'write')).rejects.toMatchObject({ status: 403 })
    fake.effectivePermissions.set(gitToken, { effectiveAllow: 6, effectiveDeny: 2 })
    await expect(authz.assertAccess('user', located, 'comment')).rejects.toMatchObject({ status: 403 })
    fake.effectivePermissions.set(gitToken, {})
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
  })

  it('requires project visibility even when repository permissions allow access', async () => {
    const { fake, authz } = harness()
    fake.effectivePermissions.set(projectToken, { effectiveAllow: 1, effectiveDeny: 1 })
    expect(await authz.filterRepositories('user', connection, [repository])).toEqual([])
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
  })

  it('accepts a verified guest object but refuses an email-equivalent guest or another tenant', async () => {
    const { fake, authz } = harness()
    fake.user.metaType = 'guest'
    expect((await authz.assertAccess('user', located, 'read')).read).toBe(true)
    fake.user.objectId = '00000000-0000-4000-8000-0000000000ee'
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
    fake.user.objectId = LINKED_MICROSOFT.objectId
    fake.user.tenantId = '00000000-0000-4000-8000-0000000000ee'
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
  })

  it('resolves a different guest object, checks its entitlement, and rechecks its ACL after revocation', async () => {
    const { fake, authz, tenantIdentity } = harness()
    fake.user.metaType = 'guest'
    fake.user.objectId = '00000000-0000-4000-8000-0000000000ee'
    await expect(authz.assertAccess('user', located, 'write')).rejects.toMatchObject({ status: 403 })
    tenantIdentity.mockResolvedValue({ ...LINKED_MICROSOFT, objectId: fake.user.objectId })
    expect(await authz.assertAccess('user', located, 'write')).toEqual({ read: true, write: true })
    expect(tenantIdentity).toHaveBeenLastCalledWith('user', LINKED_MICROSOFT, TENANT_ID)
    fake.effectivePermissions.set(gitToken, { effectiveAllow: 6, effectiveDeny: 4 })
    await expect(authz.assertAccess('user', located, 'write')).rejects.toMatchObject({ status: 403 })
    expect(await authz.assertAccess('user', located, 'read')).toEqual({ read: true, write: false })
    fake.user.tenantId = '00000000-0000-4000-8000-0000000000ef'
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
  })

  it('does not suspend grants for unavailable tenant resolution or a required sign-in refresh', async () => {
    const { fake, authz, tenantIdentity } = harness()
    fake.user.objectId = '00000000-0000-4000-8000-0000000000ee'
    tenantIdentity.mockRejectedValue(new LogtoApiError('provider unavailable', 502, true))
    await expect(authz.attestAccess('user', located, 'read')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true
    })
    tenantIdentity.mockRejectedValue(azureIdentityVerificationRequired())
    await expect(authz.attestAccess('user', located, 'read')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED'
    })
  })

  it('refuses missing actors, inactive users and unavailable identity verification', async () => {
    const { fake, authz, identity } = harness()
    await expect(authz.assertAccess(undefined, located, 'read')).rejects.toMatchObject({
      code: 'MICROSOFT_IDENTITY_REQUIRED'
    })
    fake.user.active = false
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ status: 403 })
    identity.mockRejectedValue(new LogtoApiError('unreachable', 0, true))
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true
    })
  })

  it.each([
    ['Basic', { accountLicenseType: 'express' }, true],
    ['Basic with Test Plans', { accountLicenseType: 'advanced' }, true],
    [
      'unrecognized Visual Studio subscriber',
      { status: 'pending', accountLicenseType: 'none', licensingSource: 'msdn', msdnLicenseType: 'eligible' },
      false
    ],
    [
      'Visual Studio Enterprise',
      { accountLicenseType: 'none', licensingSource: 'msdn', msdnLicenseType: 'enterprise' },
      true
    ],
    [
      'GitHub Enterprise',
      { accountLicenseType: 'none', licensingSource: 'gitHub', gitHubLicenseType: 'enterprise' },
      true
    ],
    ['Stakeholder', { accountLicenseType: 'stakeholder' }, false],
    ['unknown license', { accountLicenseType: 'unknown' }, false],
    ['unknown licensing source', { licensingSource: 'unknown' }, false],
    ['disabled account', { status: 'disabled' }, false],
    ['removed account', { status: 'deleted' }, false],
    ['disabled invitation', { status: 'pendingDisabled' }, false],
    ['unknown status', { status: 'unknown' }, false],
    ['expired license', { status: 'expired' }, false],
    ['active identity with pending invitation', { status: 'pending' }, true]
  ])('checks the effective entitlement: %s', async (_name, level, allowed) => {
    const { fake, authz } = harness()
    Object.assign(fake.user.accessLevel, level)
    const repos = await authz.filterRepositories('user', connection, [repository])
    expect(repos).toEqual(allowed ? [repository] : [])
  })

  it('allows Stakeholder repository access only with authoritative public-project visibility', async () => {
    const { fake, authz } = harness()
    fake.user.accessLevel.accountLicenseType = 'stakeholder'
    expect(await authz.filterRepositories('user', connection, [repository])).toEqual([])
    fake.projectVisibility = 'public'
    expect(await authz.assertAccess('user', located, 'write')).toEqual({ read: true, write: true })
  })

  it('follows entitlement pages and matches immutable identity fields rather than the name search', async () => {
    const { fake, authz } = harness()
    const original = fake.api.fetch.bind(fake.api)
    vi.spyOn(fake.api, 'fetch').mockImplementation(async (url, init) => {
      if (!url.includes('/userentitlements?')) return original(url, init)
      const response = await original(url, init)
      const body = (await response.json()) as { items: Array<{ id: string; user: { originId: string } }> }
      if (!new URL(url).searchParams.has('continuationToken')) {
        body.items[0]!.id = '00000000-0000-4000-8000-0000000000ee'
        return Response.json({ ...body, continuationToken: 'next-page' })
      }
      return Response.json({ ...body, continuationToken: null })
    })
    expect((await authz.assertAccess('user', located, 'read')).read).toBe(true)
    expect(fake.api.fetch).toHaveBeenCalledWith(
      expect.stringContaining('continuationToken=next-page'),
      expect.anything()
    )
  })

  it.each(['tenant', 'object', 'duplicate', 'pagination', 'body'])(
    'refuses inconsistent entitlement evidence: %s',
    async (fault) => {
      const { fake, authz } = harness()
      const original = fake.api.fetch.bind(fake.api)
      vi.spyOn(fake.api, 'fetch').mockImplementation(async (url, init) => {
        if (!url.includes('/userentitlements?')) return original(url, init)
        const body = (await (await original(url, init)).json()) as {
          items: Array<{ id: string; user: { domain: string; originId: string } }>
          continuationToken: string | null
        }
        expect(body.items[0]!.id).toBe(USER_IDENTITY_ID)
        if (fault === 'body') return Response.json({})
        if (fault === 'tenant') body.items[0]!.user.domain = 'different-tenant'
        if (fault === 'object') body.items[0]!.user.originId = 'different-object'
        if (fault === 'duplicate') body.items.push(body.items[0]!)
        if (fault === 'pagination') body.continuationToken = 'repeated'
        return Response.json(body)
      })
      await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
  )

  it('filters individually, reuses project evidence only within the request, and preserves transient failures', async () => {
    const { fake, authz } = harness()
    fake.aclForbidden.add(gitToken)
    const second = { ...repository, id: SECOND_REPOSITORY_ID }
    expect(await authz.filterRepositories('user', connection, [repository, second])).toEqual([second])
    const projectReads = fake.requests.filter((request) => request.url.includes(`/_apis/projects/${PROJECT_ID}`))
    expect(projectReads).toHaveLength(1)
    const original = fake.api.fetch.bind(fake.api)
    vi.spyOn(fake.api, 'fetch').mockImplementation((url, init) =>
      url.includes('/accesscontrollists/') ? Promise.resolve(Response.json({}, { status: 503 })) : original(url, init)
    )
    await expect(authz.assertAccess('user', located, 'read')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('effective ACL evidence', () => {
  it.each(['missing', 'wrong-resource', 'wrong-subject', 'malformed', 'null', 'duplicate'])(
    'never substitutes raw ACE grants for %s effective evidence',
    async (fault) => {
      const fake = new FakeAzureDevOps()
      const descriptor = fake.user.descriptor
      const ace = { descriptor, allow: 6, deny: 0, extendedInfo: { effectiveAllow: '6' as unknown } }
      const entry = { token: gitToken, acesDictionary: { [descriptor]: ace } }
      const value = [entry]
      if (fault === 'missing') delete (ace as { extendedInfo?: unknown }).extendedInfo
      if (fault === 'null') ace.extendedInfo.effectiveAllow = null
      if (fault === 'wrong-resource') entry.token = projectToken
      if (fault === 'wrong-subject') ace.descriptor = 'another-person'
      if (fault === 'duplicate') value.push(entry)
      fake.api.fetch = async () => Response.json({ value })
      const read = readEffectivePermissionBits(
        fake.api,
        'token',
        ORGANIZATION,
        GIT_REPOSITORIES_NAMESPACE,
        gitToken,
        descriptor
      )
      if (fault === 'wrong-resource') expect(await read).toBe(0)
      else await expect(read).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
  )
})
