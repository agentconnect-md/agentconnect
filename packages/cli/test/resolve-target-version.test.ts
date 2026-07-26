/**
 * `--to` can carry a Control-Plane-supplied string: the daemon spawns
 * `upgrade --to <version>` from a `daemon/upgrade` command. Constrain it to a plain
 * version token so a value shaped like an option can never be re-read as one by an
 * argv scan, whatever a future scan happens to look at.
 */
import { describe, it, expect, vi } from 'vitest'

// The accept path resolves against the registry (network); only the reject path is
// exercised here, and it throws before that call is ever reached.
vi.mock('../src/registry.js', () => ({
  resolveDaemonTarget: vi.fn(async () => ({ version: '1.2.3', tarball: 'https://example.test/x.tgz' })),
  downloadTarball: vi.fn(),
  verifyTarball: vi.fn()
}))

const { resolveTarget } = await import('../src/install.js')
const { resolveDaemonTarget } = await import('../src/registry.js')

describe('resolveTarget --to validation', () => {
  it('rejects a value shaped like an option, without consulting the registry', async () => {
    for (const to of ['--root=/tmp/pwn', '-x', '--to', '']) {
      await expect(resolveTarget({ to, channel: 'stable' })).rejects.toThrow(/invalid version/)
    }
    expect(resolveDaemonTarget).not.toHaveBeenCalled()
  })

  it('rejects values carrying path or shell metacharacters', async () => {
    for (const to of ['1.2.3/../..', '1.2.3;id', '1.2.3 --root /x', 'v1.2.3\n--root=/x']) {
      await expect(resolveTarget({ to, channel: 'stable' })).rejects.toThrow(/invalid version/)
    }
  })

  it('accepts the real version shapes, and an absent --to', async () => {
    for (const to of ['1.2.3', 'v1.2.3', '1.2.3-rc.1', '1.2.3+build.5']) {
      await expect(resolveTarget({ to, channel: 'stable' })).resolves.toBeTruthy()
    }
    await expect(resolveTarget({ channel: 'stable' })).resolves.toBeTruthy()
  })
})
