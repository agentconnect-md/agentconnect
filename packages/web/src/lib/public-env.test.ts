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
