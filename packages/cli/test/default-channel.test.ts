import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the CLI version before importing the store to exercise both stable and rc defaults.
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
    expect(await channelForVersion('2.0.0-dev')).toBe('stable')
  })
})
