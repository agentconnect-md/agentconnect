// The Entra and Azure DevOps edge (azure-devops-integration.md §3.4, §3.5, §5, §6.5, §12) against the anonymized fake.
import { describe, expect, it, vi } from 'vitest'
import {
  AzureDevOpsApiError,
  AzureDevOpsApiClient,
  readMicrosoftUser,
  evaluateRepositoryPermissions,
  listRepositories,
  readConnectionData,
  requestAccessToken
} from './api.js'
import {
  CLIENT_ID,
  FakeAzureDevOps,
  IDENTITY_ID,
  INSTANCE_ID,
  ORGANIZATION,
  PROJECT_ID,
  REPOSITORY_ID,
  SECOND_REPOSITORY_ID,
  TENANT_ID,
  exampleRepository
} from '../../test/fakes/azure-devops-api.js'

const credentials = { tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: 'example-secret' }

describe('Microsoft initiator identity', () => {
  const input = {
    organization: ORGANIZATION,
    tenantId: TENANT_ID,
    objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    email: 'alex@example.test'
  }
  const identity = {
    providerDisplayName: 'Alex Example',
    isActive: true,
    isContainer: false,
    properties: {
      SchemaClassName: { $value: 'User' },
      Domain: { $value: TENANT_ID },
      Mail: { $value: input.email },
      'http://schemas.microsoft.com/identity/claims/objectidentifier': { $value: input.objectId }
    }
  }
  it('reads candidates by email and confirms the exact tenant and Entra object ID', async () => {
    const fetch = vi.fn(async () => Response.json({ value: [identity] }))
    expect(await readMicrosoftUser(new AzureDevOpsApiClient({ fetch }), 'example-token', input)).toEqual({
      name: identity.providerDisplayName,
      email: input.email
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe(`https://vssps.dev.azure.com/${ORGANIZATION}/_apis/identities`)
    expect(target.searchParams.get('searchFilter')).toBe('MailAddress')
    expect(target.searchParams.get('filterValue')).toBe(input.email)
    expect(init.method).toBe('GET')
  })

  it('requires one active human matching the tenant, object ID, and email, rather than a same-name candidate', async () => {
    const withProperty = (key: keyof typeof identity.properties, value: string) => ({
      ...identity,
      properties: { ...identity.properties, [key]: { $value: value } }
    })
    for (const value of [
      [],
      [withProperty('Domain', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1')],
      [
        withProperty(
          'http://schemas.microsoft.com/identity/claims/objectidentifier',
          'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
        )
      ],
      [withProperty('Mail', 'someone-else@example.test')],
      [{ ...identity, isActive: false }],
      [{ ...identity, isContainer: true }],
      [identity, identity]
    ]) {
      const api = new AzureDevOpsApiClient({ fetch: async () => Response.json({ value }) })
      expect(await readMicrosoftUser(api, 'example-token', input)).toBeNull()
    }
  })
})

describe('client credentials token (§3.1)', () => {
  it('posts the Azure DevOps scope at the tenant authority and keeps the issued lifetime', async () => {
    const fake = new FakeAzureDevOps({ expiresInSec: 4242 })
    const token = await requestAccessToken(fake.api, credentials)
    expect(token).toEqual({ accessToken: expect.stringMatching(/^example-token-1\./), expiresInSec: 4242 })
    expect(fake.requests[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`)
  })

  it('maps invalid_client and the secret error codes to secret_rejected', async () => {
    const fake = new FakeAzureDevOps()
    await expect(requestAccessToken(fake.api, { ...credentials, clientSecret: 'wrong' })).rejects.toMatchObject({
      code: 'SECRET_REJECTED'
    })
    const expired = new FakeAzureDevOps()
    expired.api.fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_request', error_codes: [7000222] }), { status: 400 })
    await expect(requestAccessToken(expired.api, credentials)).rejects.toMatchObject({ code: 'SECRET_REJECTED' })
  })

  it('reads an application missing from the tenant as revoked access', async () => {
    const fake = new FakeAzureDevOps({ secrets: {} })
    await expect(requestAccessToken(fake.api, credentials)).rejects.toMatchObject({ code: 'ACCESS_REVOKED' })
  })
})

describe('dev.azure.com reads', () => {
  it('reads the identity and the organization instance from connectionData', async () => {
    const fake = new FakeAzureDevOps()
    expect(await readConnectionData(fake.api, 'example-token-1', ORGANIZATION)).toEqual({
      identityId: IDENTITY_ID,
      identityName: 'Example Application',
      instanceId: INSTANCE_ID
    })
  })

  it('maps TF401444 and TF400813 to access_revoked, and any other 401 to a stale token', async () => {
    const fake = new FakeAzureDevOps()
    for (const code of ['TF401444', 'TF400813']) {
      fake.revoked = code
      await expect(readConnectionData(fake.api, 'example-token-1', ORGANIZATION)).rejects.toMatchObject({
        code: 'ACCESS_REVOKED',
        status: 401
      })
    }
    fake.revoked = undefined
    await expect(readConnectionData(fake.api, 'another-token', ORGANIZATION)).rejects.toMatchObject({
      code: 'ACCESS_REVOKED'
    })
    const stale = new FakeAzureDevOps()
    stale.api.fetch = async () => new Response('{"message":"expired"}', { status: 401 })
    await expect(readConnectionData(stale.api, 'example-token-1', ORGANIZATION)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: true
    })
  })

  it('lists the whole organization by GUID, without disabled or in-maintenance repositories', async () => {
    const fake = new FakeAzureDevOps({
      repositories: [
        exampleRepository(),
        exampleRepository({ id: SECOND_REPOSITORY_ID, name: 'Disabled Repo', isDisabled: true }),
        exampleRepository({ id: '00000000-0000-4000-8000-000000000004', name: 'Moving Repo', isInMaintenance: true })
      ]
    })
    const repositories = await listRepositories(fake.api, 'example-token-1', ORGANIZATION)
    expect(repositories).toEqual([
      {
        id: REPOSITORY_ID,
        name: 'Example Repo',
        projectId: PROJECT_ID,
        projectName: 'Example Project',
        // The organization user-info is dropped and each space stays %20 (§12 item 8).
        cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo',
        defaultBranch: 'main'
      }
    ])
    expect(fake.requests.at(-1)!.url).toBe('https://dev.azure.com/example-org/_apis/git/repositories?api-version=7.1')
  })

  it('reads GenericRead and GenericContribute in one permission evaluation (§12 item 7)', async () => {
    const fake = new FakeAzureDevOps({ repositories: [exampleRepository({ contribute: false })] })
    let sent: unknown
    const inner = fake.api.fetch.bind(fake.api)
    fake.api.fetch = async (url, init) => {
      sent = JSON.parse(String(init?.body))
      return inner(url, init)
    }
    expect(
      await evaluateRepositoryPermissions(fake.api, 'example-token-1', ORGANIZATION, PROJECT_ID, REPOSITORY_ID)
    ).toEqual({
      read: true,
      contribute: false
    })
    expect(sent).toMatchObject({
      evaluations: [
        {
          securityNamespaceId: '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87',
          token: `repoV2/${PROJECT_ID}/${REPOSITORY_ID}`,
          permissions: 2
        },
        {
          securityNamespaceId: '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87',
          token: `repoV2/${PROJECT_ID}/${REPOSITORY_ID}`,
          permissions: 4
        }
      ]
    })
  })
})

describe('rate limits (§6.5)', () => {
  it('answers 429 as retryable and refuses locally until Retry-After passes, so nothing hot-loops', async () => {
    let now = 1_000_000
    const fake = new FakeAzureDevOps({}, () => now)
    fake.throttleOnceSec = 30
    const first = await readConnectionData(fake.api, 'example-token-1', ORGANIZATION).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(AzureDevOpsApiError)
    expect(first).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 30_000 })
    const sent = fake.requests.length
    await expect(listRepositories(fake.api, 'example-token-1', ORGANIZATION)).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    })
    expect(fake.requests.length).toBe(sent)
    now += 30_001
    await expect(listRepositories(fake.api, 'example-token-1', ORGANIZATION)).resolves.toHaveLength(1)
  })

  it('holds back once X-RateLimit-Remaining reaches zero, until the reset', async () => {
    let now = 2_000_000_000
    const fake = new FakeAzureDevOps({}, () => now)
    const inner = fake.api.fetch.bind(fake.api)
    fake.api.fetch = async (url, init) => {
      const res = await inner(url, init)
      const headers = new Headers(res.headers)
      headers.set('x-ratelimit-remaining', '0')
      headers.set('x-ratelimit-reset', String(Math.floor(now / 1000) + 10))
      return new Response(await res.text(), { status: res.status, headers })
    }
    await readConnectionData(fake.api, 'example-token-1', ORGANIZATION)
    await expect(readConnectionData(fake.api, 'example-token-1', ORGANIZATION)).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    })
    now += 10_001
    await expect(readConnectionData(fake.api, 'example-token-1', ORGANIZATION)).resolves.toBeTruthy()
  })
})
