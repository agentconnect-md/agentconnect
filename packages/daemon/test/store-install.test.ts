import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '@agentconnect.md/connection'
import { runtimeStoreDir } from '../src/paths.js'
import {
  INSTALL_RETRY_BASE_MS,
  INSTALL_RETRY_CAP_MS,
  InstallMemo,
  runtimeStagingDir,
  sweepRuntimeStaging
} from '../src/runtimes/store-install.js'

/** An install that fails with `error` until `heal()` is called, counting its attempts. */
function flaky(error: Error): { install: () => Promise<string>; heal(): void; readonly attempts: number } {
  let healed = false
  let attempts = 0
  return {
    install: async () => {
      attempts += 1
      if (!healed) throw error
      return 'installed'
    },
    heal: () => {
      healed = true
    },
    get attempts() {
      return attempts
    }
  }
}

describe('InstallMemo', () => {
  it('shares one in-flight install between concurrent callers and keeps a success', async () => {
    const memo = new InstallMemo<string>(new FakeClock())
    const fault = flaky(new Error('unused'))
    fault.heal()
    const [a, b] = await Promise.all([memo.run('pkg', fault.install), memo.run('pkg', fault.install)])
    expect([a, b]).toEqual(['installed', 'installed'])
    expect(await memo.run('pkg', fault.install)).toBe('installed')
    expect(fault.attempts).toBe(1)
  })

  it('answers with the last failure inside the backoff, then retries once it passes', async () => {
    const clock = new FakeClock()
    const memo = new InstallMemo<string>(clock)
    const enospc = new Error('npm install failed: npm warn tar TAR_ENTRY_ERROR ENOSPC: no space left on device')
    const fault = flaky(enospc)

    // Concurrent callers of a failing attempt still share it.
    const [a, b] = await Promise.allSettled([memo.run('pkg', fault.install), memo.run('pkg', fault.install)])
    expect([a, b].map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(fault.attempts).toBe(1)

    // A persistent fault costs nothing per call while the backoff runs.
    clock.advance(INSTALL_RETRY_BASE_MS - 1)
    await expect(memo.run('pkg', fault.install)).rejects.toBe(enospc)
    expect(fault.attempts).toBe(1)

    // The disk has room again: the next call after the backoff installs, and the success sticks.
    fault.heal()
    clock.advance(1)
    expect(await memo.run('pkg', fault.install)).toBe('installed')
    clock.advance(INSTALL_RETRY_CAP_MS)
    expect(await memo.run('pkg', fault.install)).toBe('installed')
    expect(fault.attempts).toBe(2)
  })

  it('doubles the wait after each consecutive failure, up to the cap', async () => {
    const clock = new FakeClock()
    const memo = new InstallMemo<string>(clock)
    const fault = flaky(new Error('registry unreachable'))
    await expect(memo.run('pkg', fault.install)).rejects.toThrow('registry unreachable')
    for (const wait of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      const attempts = fault.attempts
      clock.advance(wait - 1)
      await expect(memo.run('pkg', fault.install)).rejects.toThrow('registry unreachable')
      expect(fault.attempts).toBe(attempts)
      clock.advance(1)
      await expect(memo.run('pkg', fault.install)).rejects.toThrow('registry unreachable')
      expect(fault.attempts).toBe(attempts + 1)
    }
  })

  it('keeps each key to its own backoff', async () => {
    const clock = new FakeClock()
    const memo = new InstallMemo<string>(clock)
    const broken = flaky(new Error('broken'))
    const fine = flaky(new Error('unused'))
    fine.heal()
    await expect(memo.run('a', broken.install)).rejects.toThrow('broken')
    expect(await memo.run('b', fine.install)).toBe('installed')
  })
})

describe('sweepRuntimeStaging', () => {
  it('removes the staging trees a dead process left and nothing it installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-staging-'))
    const staging = runtimeStagingDir(root)
    mkdirSync(join(staging, 'node_modules'), { recursive: true })
    writeFileSync(join(staging, 'node_modules', 'partial'), 'x')
    const installed = join(runtimeStoreDir(root), 'codex-acp@1.0.0')
    mkdirSync(installed, { recursive: true })

    sweepRuntimeStaging(root)
    expect(existsSync(staging)).toBe(false)
    expect(readdirSync(runtimeStoreDir(root))).toEqual(['codex-acp@1.0.0'])
  })

  it('does nothing when the store does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-staging-'))
    expect(() => sweepRuntimeStaging(root)).not.toThrow()
  })
})
