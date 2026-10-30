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
