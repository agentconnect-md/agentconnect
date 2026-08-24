import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock the registry-backed install layer so the test never hits the network.
// `installTarget` materializes the version dir so the real `useVersion`
// (activation) can symlink `current` at it.
const resolveTarget = vi.fn()
const installTarget = vi.fn(
  async (
    root: string,
    target: { version: string },
    _log?: (m: string) => void,
    _opts?: { force?: boolean }
  ): Promise<string> => {
    mkdirSync(join(root, 'versions', target.version), { recursive: true })
    return target.version
  }
)
vi.mock('../src/install.js', () => ({
  resolveTarget: (o: unknown) => resolveTarget(o),
  installTarget: (r: string, t: { version: string }, log?: (m: string) => void, opts?: { force?: boolean }) =>
    installTarget(r, t, log, opts)
}))

const { versionInstall, versionReinstallLatest, versionRollback } = await import('../src/version-commands.js')
const { currentVersion, readMeta, writeMeta } = await import('../src/version-store.js')

const root = () => mkdtempSync(join(tmpdir(), 'ac-vinstall-'))

beforeEach(() => {
  resolveTarget.mockReset()
  installTarget.mockClear()
})

describe('versionInstall', () => {
  it('activates the first installed version (fresh root has no current)', async () => {
    const r = root()
    resolveTarget.mockResolvedValue({ version: '1.0.0', channel: 'stable' })
    await versionInstall(r, { channel: 'stable' })
    expect(currentVersion(r)).toBe('1.0.0')
  })

  it('resolves against the requested channel', async () => {
    const r = root()
    resolveTarget.mockResolvedValue({ version: '2.0.0-rc.1', channel: 'rc' })
    await versionInstall(r, { channel: 'rc' })
    expect(resolveTarget).toHaveBeenCalledWith({ to: undefined, channel: 'rc' })
    expect(currentVersion(r)).toBe('2.0.0-rc.1')
  })

  it('does NOT switch current when a version is already active', async () => {
    const r = root()
    resolveTarget.mockResolvedValueOnce({ version: '1.0.0', channel: 'stable' })
    await versionInstall(r, { channel: 'stable' }) // first install → activates 1.0.0
    resolveTarget.mockResolvedValueOnce({ version: '1.1.0', channel: 'stable' })
    await versionInstall(r, { to: '1.1.0' }) // second install → stays on 1.0.0
    expect(currentVersion(r)).toBe('1.0.0')
  })

  // Bootstrap path (ensureDaemonInstalled) installs with no explicit channel.
  it('resolves against the STORED channel when none is passed', async () => {
    const r = root()
    writeMeta(r, { channel: 'rc', previous: null })
    resolveTarget.mockResolvedValue({ version: '2.0.0-rc.1', channel: 'rc' })
    await versionInstall(r, {})
    expect(resolveTarget).toHaveBeenCalledWith({ to: undefined, channel: 'rc' })
    // The stored preference is left untouched — a bare install never rewrites it.
    expect(readMeta(r).channel).toBe('rc')
  })

  it('uses the CLI-derived default without persisting it when nothing is stored', async () => {
    const r = root()
    resolveTarget.mockResolvedValue({ version: '1.0.0', channel: 'stable' })
    await versionInstall(r, {})
    // Repo CLI version is `1.0.0-dev` → defaultChannel() === 'stable'.
    expect(resolveTarget).toHaveBeenCalledWith({ to: undefined, channel: 'stable' })
    // No versions.json written: the default must not become a stored preference.
    expect(existsSync(join(r, 'versions.json'))).toBe(false)
  })
})

describe('versionRollback', () => {
  it('reactivates the recorded previous version and returns it', async () => {
    const r = root()
    resolveTarget.mockResolvedValueOnce({ version: '1.0.0', channel: 'stable' })
    await versionInstall(r, {}) // activates 1.0.0
    mkdirSync(join(r, 'versions', '1.1.0'), { recursive: true })
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.1.0') // previous = 1.0.0
    await expect(versionRollback(r)).resolves.toBe('1.0.0')
    expect(currentVersion(r)).toBe('1.0.0')
    // The failed version becomes the new rollback target.
    expect(readMeta(r).previous).toBe('1.1.0')
  })

  it('refuses when no previous version is recorded', async () => {
    await expect(versionRollback(root())).rejects.toThrow(/no previous/)
  })
})

describe('versionReinstallLatest', () => {
  it('force-installs the channel latest and activates it', async () => {
    const r = root()
    writeMeta(r, { channel: 'rc', previous: null })
    resolveTarget.mockResolvedValue({ version: '2.0.0-rc.1', channel: 'rc' })
    await expect(versionReinstallLatest(r)).resolves.toBe('2.0.0-rc.1')
    expect(resolveTarget).toHaveBeenCalledWith({ channel: 'rc' })
    expect(installTarget.mock.calls[0]![3]).toEqual({ force: true })
    expect(currentVersion(r)).toBe('2.0.0-rc.1')
  })
})
