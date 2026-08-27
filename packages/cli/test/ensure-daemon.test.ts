import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

// Mock the version layer so the bootstrap never touches the registry/filesystem;
// we only assert HOW ensureDaemonInstalled drives it.
const versionInstall = vi.fn<(root: string, opts: unknown) => Promise<void>>(async () => {})
vi.mock('../src/version-commands.js', () => ({
  versionInstall: (root: string, opts: unknown) => versionInstall(root, opts)
}))

const currentVersion = vi.fn<(root: string) => string | null>()
const readMeta = vi.fn<(root: string) => { channel: string; previous: string | null }>(() => ({
  channel: 'stable',
  previous: null
}))
vi.mock('../src/version-store.js', () => ({
  currentVersion: (root: string) => currentVersion(root),
  readMeta: (root: string) => readMeta(root)
}))

const repairDaemonBundleModes = vi.fn()
vi.mock('../src/install.js', () => ({
  repairDaemonBundleModes: (root: string) => repairDaemonBundleModes(root)
}))

const { ensureDaemonInstalled } = await import('../src/run-shell.js')

const ENTRY = 'AGENTCONNECT_DAEMON_ENTRY'

beforeEach(() => {
  versionInstall.mockClear()
  repairDaemonBundleModes.mockClear()
  currentVersion.mockReset().mockReturnValue(null)
  delete process.env[ENTRY]
})
afterEach(() => {
  delete process.env[ENTRY]
})

describe('ensureDaemonInstalled', () => {
  it('bootstraps with NO explicit channel when nothing is active', async () => {
    await ensureDaemonInstalled('/root')
    // Empty opts → versionInstall resolves the channel via readMeta and never
    // persists the CLI-derived default as an explicit preference.
    expect(versionInstall).toHaveBeenCalledWith('/root', {})
  })

  it('skips when a version is already active', async () => {
    currentVersion.mockReturnValue('1.2.3')
    await ensureDaemonInstalled('/root')
    expect(versionInstall).not.toHaveBeenCalled()
    expect(repairDaemonBundleModes).toHaveBeenCalledWith(join('/root', 'versions', '1.2.3'))
  })

  it('skips in dev mode (AGENTCONNECT_DAEMON_ENTRY set)', async () => {
    process.env[ENTRY] = '/repo/packages/daemon/src/index.ts'
    await ensureDaemonInstalled('/root')
    expect(versionInstall).not.toHaveBeenCalled()
  })
})
