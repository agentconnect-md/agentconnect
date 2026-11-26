import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})
it.each([
  [
    { webchatProtocol: 'legacy', ahp: { enabled: true, publicAccess: false } },
    { WEBCHAT_PROTOCOL: 'legacy', AHP_ENABLED: 'true', AHP_PUBLIC_ACCESS: 'false' }
  ],
  [
    { webchatProtocol: 'ahp', ahp: { enabled: true, publicAccess: true } },
    { WEBCHAT_PROTOCOL: 'ahp', AHP_ENABLED: 'true', AHP_PUBLIC_ACCESS: 'true' }
  ],
  [{}, { WEBCHAT_PROTOCOL: 'legacy', AHP_ENABLED: 'false', AHP_PUBLIC_ACCESS: 'false' }]
])('publishes independent server protocol and public access defaults', async (flags, expected) => {
  vi.resetModules()
  vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 1, config: null, ...flags })))
  )
  const { resolvePublicEnv } = await import('./public-env')
  expect(await resolvePublicEnv()).toMatchObject(expected)
})

it('publishes the SSO connector from the persisted auth config and drops a stale env one', async () => {
  vi.resetModules()
  vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
  vi.stubEnv('SSO_CONNECTOR_ID', 'stale-connector')
  const auth = (sso: object | null) => ({
    endpoint: 'https://auth.example.test',
    issuer: 'https://auth.example.test/oidc',
    appId: 'console',
    apiResource: null,
    socialProviders: [],
    sso
  })
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          schemaVersion: '1',
          revision: 1,
          config: { auth: auth({ connectorId: 'sso-connector', name: 'Example SSO' }) }
        })
      )
  )
  vi.stubGlobal('fetch', fetch)
  const { resolvePublicEnv } = await import('./public-env')
  expect(await resolvePublicEnv()).toMatchObject({ SSO_CONNECTOR_ID: 'sso-connector', SSO_NAME: 'Example SSO' })

  vi.resetModules()
  fetch.mockImplementation(
    async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 2, config: { auth: auth(null) } }))
  )
  const fresh = await import('./public-env')
  expect(await fresh.resolvePublicEnv()).not.toHaveProperty('SSO_CONNECTOR_ID')
})

it('publishes organization SSO only when the persisted auth config declares it', async () => {
  vi.resetModules()
  vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
  vi.stubEnv('ORGANIZATION_SSO', 'true')
  const config = (organizationSso: boolean) => ({
    auth: {
      endpoint: 'https://auth.example.test',
      issuer: 'https://auth.example.test/oidc',
      appId: 'console',
      apiResource: null,
      socialProviders: [],
      sso: null,
      organizationSso
    }
  })
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 1, config: config(true) }))
  )
  vi.stubGlobal('fetch', fetch)
  const { resolvePublicEnv } = await import('./public-env')
  expect(await resolvePublicEnv()).toMatchObject({ ORGANIZATION_SSO: 'true' })

  vi.resetModules()
  fetch.mockImplementation(
    async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 2, config: config(false) }))
  )
  const fresh = await import('./public-env')
  expect(await fresh.resolvePublicEnv()).not.toHaveProperty('ORGANIZATION_SSO')
})

it('publishes the deployment SSO connector’s member source only when the runtime config carries one', async () => {
  vi.resetModules()
  vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
  vi.stubEnv('SSO_MEMBER_SOURCE', 'domain')
  const config = (ssoMemberSource: 'invite' | null) => ({
    auth: {
      endpoint: 'https://auth.example.test',
      issuer: 'https://auth.example.test/oidc',
      appId: 'console',
      apiResource: null,
      socialProviders: [],
      sso: { connectorId: 'sso-1', name: 'SSO' },
      ssoMemberSource,
      organizationSso: false
    }
  })
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 1, config: config('invite') }))
  )
  vi.stubGlobal('fetch', fetch)
  const { resolvePublicEnv } = await import('./public-env')
  expect(await resolvePublicEnv()).toMatchObject({ SSO_MEMBER_SOURCE: 'invite' })

  vi.resetModules()
  fetch.mockImplementation(
    async () => new Response(JSON.stringify({ schemaVersion: '1', revision: 2, config: config(null) }))
  )
  const fresh = await import('./public-env')
  expect(await fresh.resolvePublicEnv()).not.toHaveProperty('SSO_MEMBER_SOURCE')
})

it('picks up a changed CP protocol after its refresh window and keeps serving through a CP outage', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  try {
    vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
    const config = (webchatProtocol: string) =>
      new Response(JSON.stringify({ schemaVersion: '1', revision: 1, config: null, webchatProtocol }))
    const fetch = vi.fn(async () => config('legacy'))
    vi.stubGlobal('fetch', fetch)
    const { resolvePublicEnv } = await import('./public-env')
    expect(await resolvePublicEnv()).toMatchObject({ WEBCHAT_PROTOCOL: 'legacy' })
    fetch.mockImplementation(async () => config('ahp'))
    expect(await resolvePublicEnv()).toMatchObject({ WEBCHAT_PROTOCOL: 'legacy' })
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_001)
    // The stale snapshot answers while the refresh lands for the next page.
    expect(await resolvePublicEnv()).toMatchObject({ WEBCHAT_PROTOCOL: 'legacy' })
    await vi.waitFor(async () => expect(await resolvePublicEnv()).toMatchObject({ WEBCHAT_PROTOCOL: 'ahp' }))
    fetch.mockImplementation(async () => {
      throw new Error('down')
    })
    vi.advanceTimersByTime(30_001)
    expect(await resolvePublicEnv()).toMatchObject({ WEBCHAT_PROTOCOL: 'ahp' })
  } finally {
    vi.useRealTimers()
  }
})

it('publishes the artifact content domain only while the CP offers artifacts, over a stale env value', async () => {
  vi.resetModules()
  vi.stubEnv('CP_INTERNAL_URL', 'https://example.test/api/v1')
  vi.stubEnv('ARTIFACTS_CONTENT_DOMAIN', 'stale-usercontent.example')
  const body = (artifacts: object) => JSON.stringify({ schemaVersion: '1', revision: 1, config: null, artifacts })
  const fetch = vi.fn(async () => new Response(body({ enabled: true, contentDomain: 'example-usercontent.net' })))
  vi.stubGlobal('fetch', fetch)
  const { resolvePublicEnv } = await import('./public-env')
  expect(await resolvePublicEnv()).toMatchObject({ ARTIFACTS_CONTENT_DOMAIN: 'example-usercontent.net' })

  vi.resetModules()
  fetch.mockImplementation(async () => new Response(body({ enabled: false, contentDomain: null })))
  const fresh = await import('./public-env')
  expect(await fresh.resolvePublicEnv()).not.toHaveProperty('ARTIFACTS_CONTENT_DOMAIN')
})
