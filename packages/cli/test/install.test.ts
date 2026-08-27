import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repairDaemonBundleModes } from '../src/install.js'

describe('repairDaemonBundleModes', () => {
  it.skipIf(process.platform === 'win32')('restores executable mode on npm-normalized seccomp helpers', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentconnect-daemon-modes-'))
    for (const arch of ['x64', 'arm64']) {
      const dir = join(root, 'dist', 'vendor', 'seccomp', arch)
      const helper = join(dir, 'apply-seccomp')
      mkdirSync(dir, { recursive: true })
      writeFileSync(helper, 'helper')
      chmodSync(helper, 0o644)
    }

    repairDaemonBundleModes(root)

    for (const arch of ['x64', 'arm64']) {
      const helper = join(root, 'dist', 'vendor', 'seccomp', arch, 'apply-seccomp')
      expect(statSync(helper).mode & 0o777).toBe(0o755)
    }
  })

  it('allows bundles without the optional Linux helpers', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentconnect-daemon-modes-'))
    expect(() => repairDaemonBundleModes(root)).not.toThrow()
  })
})
