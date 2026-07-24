import { describe, it, expect, vi, afterEach } from 'vitest'

// defaultChannel() keys off the CLI's own version, which is read from package.json
// at import time. The repo build is `1.0.0-dev` (→ stable), so exercise the rc
// branch by mocking the version module and importing the store fresh.
async function channelForVersion(version: string): Promise<'stable' | 'rc'> {
  vi.resetModules()
  vi.doMock('../src/version.js', () => ({ CLI_VERSION: version }))
  const { defaultChannel } = await import('../src/version-store.js')
  return defaultChannel()
}

afterEach(() => {
  vi.doUnmock('../src/version.js')
  vi.resetModules()
})

describe('defaultChannel', () => {
  it('tracks rc for a release-candidate CLI', async () => {
    expect(await channelForVersion('1.5.0-rc.2')).toBe('rc')
  })
  it('tracks stable for a stable CLI', async () => {
    expect(await channelForVersion('1.5.0')).toBe('stable')
  })
  it('tracks stable for a non-rc prerelease (e.g. the -dev repo build)', async () => {
    expect(await channelForVersion('1.0.0-dev')).toBe('stable')
  })
})
