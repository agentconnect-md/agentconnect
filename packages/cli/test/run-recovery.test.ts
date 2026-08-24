import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import {
  manualVersionHelp,
  recoveryOptions,
  runRecoveryFlow,
  shouldOfferRecovery,
  STARTUP_FAILURE_WINDOW_MS,
  type RecoveryDeps
} from '../src/run-recovery.js'
import { useVersion } from '../src/version-ops.js'
import { writeMeta } from '../src/version-store.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-recovery-'))
const install = (r: string, v: string) => mkdirSync(join(r, 'versions', v), { recursive: true })

const baseCtx = {
  stopRequested: false,
  supervised: false,
  devEntry: false,
  interactive: true,
  elapsedMs: 1_000
}
const failed = { code: 1, signal: null }

describe('shouldOfferRecovery', () => {
  it('offers on a quick nonzero exit of an interactive foreground run', () => {
    expect(shouldOfferRecovery(failed, baseCtx)).toBe(true)
  })
  it('never prompts when a stop was requested', () => {
    expect(shouldOfferRecovery(failed, { ...baseCtx, stopRequested: true })).toBe(false)
  })
  it('never prompts under a service supervisor (no operator at a terminal)', () => {
    expect(shouldOfferRecovery(failed, { ...baseCtx, supervised: true })).toBe(false)
  })
  it('never prompts in dev-entry mode (version store bypassed)', () => {
    expect(shouldOfferRecovery(failed, { ...baseCtx, devEntry: true })).toBe(false)
  })
  it('never prompts without a TTY', () => {
    expect(shouldOfferRecovery(failed, { ...baseCtx, interactive: false })).toBe(false)
  })
  it('ignores clean exits and signal deaths', () => {
    expect(shouldOfferRecovery({ code: 0, signal: null }, baseCtx)).toBe(false)
    expect(shouldOfferRecovery({ code: null, signal: 'SIGINT' }, baseCtx)).toBe(false)
  })
  it('treats a late crash as a runtime failure, not a startup one', () => {
    expect(shouldOfferRecovery(failed, { ...baseCtx, elapsedMs: STARTUP_FAILURE_WINDOW_MS + 1 })).toBe(false)
  })
})

describe('recoveryOptions', () => {
  it('offers rollback / re-download / manual when a previous version exists', () => {
    const opts = recoveryOptions({ previous: '1.0.0', channel: 'stable' })
    expect(opts.map((o) => o.action)).toEqual(['rollback', 'reinstall', 'manual'])
    expect(opts.map((o) => o.key)).toEqual(['1', '2', '3'])
    expect(opts[0]!.label).toContain('1.0.0')
    expect(opts[1]!.label).toContain('stable')
  })
  it('omits rollback when there is no previous version', () => {
    const opts = recoveryOptions({ previous: null, channel: 'rc' })
    expect(opts.map((o) => o.action)).toEqual(['reinstall', 'manual'])
    expect(opts.map((o) => o.key)).toEqual(['1', '2'])
  })
})

/** Deps with a scripted stdin and a captured output. */
function fakeDeps(lines: string[]): {
  deps: RecoveryDeps
  output: () => string
  rollback: ReturnType<typeof vi.fn>
  reinstall: ReturnType<typeof vi.fn>
} {
  const written: string[] = []
  const rollback = vi.fn(async () => '1.0.0')
  const reinstall = vi.fn(async () => '1.1.0')
  return {
    deps: {
      input: Readable.from(lines.map((l) => l + '\n')) as unknown as NodeJS.ReadableStream,
      out: { write: (s: string) => (written.push(s), true) } as unknown as NodeJS.WritableStream,
      rollback,
      reinstall
    },
    output: () => written.join(''),
    rollback,
    reinstall
  }
}

/** A root where 1.1.0 is current and 1.0.0 is the recorded previous. */
function rootWithHistory(): string {
  const r = root()
  install(r, '1.0.0')
  install(r, '1.1.0')
  useVersion(r, '1.0.0')
  useVersion(r, '1.1.0') // previous = 1.0.0
  return r
}

describe('runRecoveryFlow', () => {
  it('rollback choice switches and respawns', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['1'])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('respawn')
    expect(f.rollback).toHaveBeenCalledWith(r)
    expect(f.output()).toContain('retrying with daemon 1.0.0')
  })

  it('re-download choice reinstalls and respawns', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['2'])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('respawn')
    expect(f.reinstall).toHaveBeenCalledWith(r)
  })

  it('manual choice prints the version commands and exits', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['3'])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('exit')
    expect(f.output()).toContain(manualVersionHelp(r))
    expect(f.rollback).not.toHaveBeenCalled()
    expect(f.reinstall).not.toHaveBeenCalled()
  })

  it('empty answer (or EOF) declines recovery', async () => {
    const r = rootWithHistory()
    const f = fakeDeps([''])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('exit')
    const eof = fakeDeps([])
    await expect(runRecoveryFlow(r, failed, eof.deps)).resolves.toBe('exit')
  })

  it('re-offers the menu after an unknown answer', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['x', '1'])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('respawn')
  })

  it('a failed action re-offers the menu instead of crashing the prompt', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['2', '1'])
    f.reinstall.mockRejectedValueOnce(new Error('registry unreachable'))
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('respawn')
    expect(f.output()).toContain('reinstall failed: registry unreachable')
    expect(f.rollback).toHaveBeenCalledWith(r)
  })

  it('an already-aborted stop signal skips the prompt entirely', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['1'])
    const stop = new AbortController()
    stop.abort()
    await expect(runRecoveryFlow(r, failed, { ...f.deps, signal: stop.signal })).resolves.toBe('exit')
    expect(f.output()).toBe('')
    expect(f.rollback).not.toHaveBeenCalled()
  })

  it('a stop arriving while the menu is idle aborts the prompt', async () => {
    const r = rootWithHistory()
    const f = fakeDeps([])
    const idle = new PassThrough() // stays open: nobody is answering
    const stop = new AbortController()
    const flow = runRecoveryFlow(r, failed, { ...f.deps, input: idle, signal: stop.signal })
    stop.abort()
    await expect(flow).resolves.toBe('exit')
    expect(f.rollback).not.toHaveBeenCalled()
    expect(f.reinstall).not.toHaveBeenCalled()
  })

  it('a stop arriving while an action runs vetoes its respawn', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['1'])
    const stop = new AbortController()
    f.rollback.mockImplementationOnce(async () => {
      stop.abort() // the stop lands mid-rollback…
      return '1.0.0'
    })
    // …so even though the switch succeeded, the shell must not respawn past it.
    await expect(runRecoveryFlow(r, failed, { ...f.deps, signal: stop.signal })).resolves.toBe('exit')
    expect(f.output()).not.toContain('retrying')
  })

  it('a stop finishes the flow immediately even while the action never settles', async () => {
    const r = rootWithHistory()
    const f = fakeDeps(['2'])
    const stop = new AbortController()
    let started = (): void => {}
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    // A reinstall stuck on the version lock or in a non-abortable registry
    // fetch: the promise never settles, yet the stop must not be swallowed.
    f.reinstall.mockImplementationOnce(() => {
      started()
      return new Promise<never>(() => {})
    })
    const flow = runRecoveryFlow(r, failed, { ...f.deps, signal: stop.signal })
    await actionStarted
    stop.abort()
    await expect(flow).resolves.toBe('exit')
    expect(f.output()).not.toContain('retrying')
  })

  it('hides rollback when previous is missing from the store', async () => {
    const r = root()
    install(r, '1.1.0')
    useVersion(r, '1.1.0')
    writeMeta(r, { channel: 'stable', previous: '1.0.0' }) // recorded but pruned/uninstalled
    const f = fakeDeps([''])
    await expect(runRecoveryFlow(r, failed, f.deps)).resolves.toBe('exit')
    expect(f.output()).not.toContain('previous version')
    expect(f.output()).toContain('re-download the latest stable version')
  })
})
