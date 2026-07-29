import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/logto/social-connectors/route'

describe('Logto social connector metadata route', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('loads public connector metadata server-side for the browser', async () => {
    vi.stubEnv('LOGTO_ENDPOINT', 'https://login.example.test/')
    vi.stubEnv('LOGTO_APP_ID', 'web-app')
    const socialConnectors = [{ id: 'github-connector', target: 'github', name: { en: 'GitHub' } }]
    const fetchMock = vi.fn(async (_input: URL | RequestInfo) =>
      Response.json({ socialConnectors, customCss: 'not forwarded' })
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ socialConnectors })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://login.example.test/api/.well-known/experience?appId=web-app'
    )
  })
})
