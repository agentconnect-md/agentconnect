import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, WireError } from '@agentconnect.md/connection'
import { LIFECYCLE_DEFERRED_REASON } from '@agentconnect.md/protocol'
import {
  AUTO_UPGRADE_IDLE_WAIT_MS,
  AUTO_UPGRADE_QUIET_MS,
  AUTO_UPGRADE_RETRY_BASE_MS,
  AutoUpgrader,
  compareSemver,
  rolloutDelayMs,
  type AutoUpgradeHost,
  type CliRunResult
} from '../src/lifecycle/auto-upgrader.js'
import {
  readAutoUpgradeState,
  readTrialMarker,
  trialMarkerPath,
  writeTrialMarker
} from '../src/lifecycle/auto-upgrade-store.js'
import type { Quiescence } from '../src/lifecycle/quiescence.js'

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const roots: string[] = []
const rc = (version: string) => ({ channel: 'rc', version })
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(over: { version?: string; root?: string } = {}) {
  const root = over.root ?? mkdtempSync(join(tmpdir(), 'agentconnect-auto-upgrade-'))
  roots.push(root)
  // Far from zero so the quiet period has already elapsed unless a test says otherwise.
  const clock = new FakeClock(10 * AUTO_UPGRADE_QUIET_MS)
  let lastActivity = 0
  const listeners = new Set<() => void>()
  const live = { busy: undefined as string | undefined }
  const quiescence: Quiescence = {
    busyReason: () => live.busy,
    quietForMs: () => clock.now() - lastActivity,
    onChange: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  const activity = (busy: string | undefined) => {
    live.busy = busy
    lastActivity = clock.now()
    for (const l of listeners) l()
  }
  const cli = vi.fn(async (_args: string[]): Promise<CliRunResult> => ({ ok: true, stderr: '' }))
  const lifecycle = {
    reserve: vi.fn((_v: string) => ({ accepted: true as const, root, cliEntry: '/cli.js' })),
    release: vi.fn(),
    install: vi.fn(async (_e: string, _v: string, _r: string) => true),
    exit: vi.fn((_op?: string) => {})
  }
  const cp = {
    handshaking: vi.fn(() => false),
    canBeginLifecycle: vi.fn(() => true),
    beginLifecycle: vi.fn(async () => ({ operationId: 'op-1' })),
    reportProgress: vi.fn(async () => {})
  }
  let eligible = true
  const host: AutoUpgradeHost = {
    log: () => silent,
    clock: () => clock,
    root: () => root,
    daemonId: () => 'daemon-1',
    version: () => over.version ?? '1.0.0',
    eligible: () => eligible,
    quiescence: () => quiescence,
    runCli: cli,
    lifecycle: () => lifecycle,
    cp: () => cp,
    exitForRollback: vi.fn(),
    random: () => 0
  }
  const upgrader = new AutoUpgrader(host)
  upgrader.start()
  return {
    root,
    clock,
    upgrader,
    cli,
    lifecycle,
    cp,
    host,
    activity,
    setEligible: (v: boolean) => (eligible = v),
    installs: () => cli.mock.calls.filter(([a]) => a[0] === 'version' && a[1] === 'install').map(([a]) => a[2])
  }
}

describe('compareSemver', () => {
  it('orders releases, prereleases and numeric identifiers', () => {
    expect(compareSemver('1.41.0', '1.40.2')).toBeGreaterThan(0)
    expect(compareSemver('1.41.0-rc.10', '1.41.0-rc.9')).toBeGreaterThan(0)
    expect(compareSemver('1.41.0', '1.41.0-rc.1')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0-dev', '2.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('latest', '1.0.0')).toBeUndefined()
  })
})

describe('AutoUpgrader', () => {
  it('never acts while the switch is off, nor when the daemon is not eligible', async () => {
    const h = harness()
    h.upgrader.setRelease(rc('1.1.0'))
    await h.upgrader.evaluate()
    expect(h.cli).not.toHaveBeenCalled()
    expect(h.upgrader.candidate()).toBe('1.1.0')

    h.setEligible(false)
    h.upgrader.setEnabled(true)
    await h.upgrader.evaluate()
    expect(h.cli).not.toHaveBeenCalled()
    expect(h.lifecycle.reserve).not.toHaveBeenCalled()
  })

  it('stages, reserves, prepares and exits when idle', async () => {
    const h = harness()
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.installs()).toEqual(['1.1.0'])
    expect(h.cp.beginLifecycle).toHaveBeenCalledWith({
      op: 'upgrade',
      trigger: 'auto',
      fromVersion: '1.0.0',
      targetVersion: '1.1.0'
    })
    expect(h.lifecycle.install).toHaveBeenCalledWith('/cli.js', '1.1.0', h.root)
    expect(h.cp.reportProgress).toHaveBeenCalledWith({ operationId: 'op-1', phase: 'preparing' })
    expect(h.lifecycle.exit).toHaveBeenCalledWith('op-1')
    expect(h.lifecycle.release).not.toHaveBeenCalled()
    expect(readTrialMarker(h.root)).toMatchObject({ from: '1.0.0', to: '1.1.0', operationId: 'op-1', failures: 0 })
  })

  it('stays put while busy and inside the quiet period, then upgrades once quiet', async () => {
    const h = harness()
    h.activity('1 turn(s) in flight')
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    // Staging happens while serving; the switch waits.
    expect(h.installs()).toEqual(['1.1.0'])
    expect(h.lifecycle.reserve).not.toHaveBeenCalled()

    h.activity(undefined) // the turn ended: the quiet period starts now
    await h.upgrader.evaluate()
    expect(h.lifecycle.reserve).not.toHaveBeenCalled()
    h.clock.advance(AUTO_UPGRADE_QUIET_MS - 1)
    await h.upgrader.evaluate()
    expect(h.lifecycle.reserve).not.toHaveBeenCalled()

    h.clock.advance(1)
    await h.upgrader.evaluate()
    await flush()
    expect(h.lifecycle.exit).toHaveBeenCalledTimes(1)
  })

  it('waits out the rollout spread on a stable channel', async () => {
    const h = harness()
    const delay = rolloutDelayMs('daemon-1', '1.1.0', 'latest')
    expect(delay).toBeGreaterThan(0)
    expect(rolloutDelayMs('daemon-1', '1.1.0', 'rc')).toBe(0)
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': { channel: 'latest', version: '1.1.0' } })
    await h.upgrader.evaluate()
    h.clock.advance(delay - 1)
    await h.upgrader.evaluate()
    expect(h.cli).not.toHaveBeenCalled()
    h.clock.advance(1)
    await h.upgrader.evaluate()
    await flush()
    expect(h.installs()).toEqual(['1.1.0'])
    expect(h.lifecycle.exit).toHaveBeenCalled()
  })

  it('drops a staged candidate when the announcement moves back, and never downgrades', async () => {
    const h = harness()
    h.activity('busy')
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.installs()).toEqual(['1.1.0'])

    h.upgrader.setRelease(rc('1.0.0'))
    expect(h.upgrader.candidate()).toBeUndefined()
    h.upgrader.setRelease(rc('0.9.0'))
    h.activity(undefined)
    h.clock.advance(AUTO_UPGRADE_QUIET_MS)
    await h.upgrader.evaluate()
    expect(h.lifecycle.reserve).not.toHaveBeenCalled()
    expect(h.installs()).toEqual(['1.1.0'])
  })

  it('reverts current and reports busy when the post-prepare idle wait lapses', async () => {
    const h = harness()
    // New work arrives while `agentconnect upgrade` prepares.
    h.lifecycle.install.mockImplementation(async () => {
      h.activity('1 turn(s) in flight')
      return true
    })
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    const run = h.upgrader.evaluate()
    await flush()
    expect(h.lifecycle.exit).not.toHaveBeenCalled()
    expect(existsSync(trialMarkerPath(h.root))).toBe(true)

    h.clock.advance(AUTO_UPGRADE_IDLE_WAIT_MS)
    await run
    expect(h.cli).toHaveBeenCalledWith(['version', 'use', '1.0.0'])
    expect(existsSync(trialMarkerPath(h.root))).toBe(false)
    expect(h.cp.reportProgress).toHaveBeenCalledWith({
      operationId: 'op-1',
      phase: 'failed',
      reason: LIFECYCLE_DEFERRED_REASON
    })
    expect(h.lifecycle.release).toHaveBeenCalledTimes(1)
    expect(h.lifecycle.exit).not.toHaveBeenCalled()
    // The staged version is kept for the next idle window.
    expect(h.upgrader.candidate()).toBe('1.1.0')
  })

  it('exits once the daemon goes quiet inside the idle wait', async () => {
    const h = harness()
    h.lifecycle.install.mockImplementation(async () => {
      h.activity('1 turn(s) in flight')
      return true
    })
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    const run = h.upgrader.evaluate()
    await flush()
    h.activity(undefined)
    h.clock.advance(AUTO_UPGRADE_QUIET_MS)
    await run
    expect(h.lifecycle.exit).toHaveBeenCalledWith('op-1')
    expect(h.cli).not.toHaveBeenCalledWith(['version', 'use', '1.0.0'])
  })

  it('skips an engine-incompatible version and does not download it again', async () => {
    const h = harness()
    h.cli.mockResolvedValueOnce({
      ok: false,
      stderr:
        'agentconnect version install: daemon 1.1.0 requires Node >=26 but this CLI runs on 24.12.0 — upgrade Node first\n'
    })
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.upgrader.skipped()).toEqual([expect.objectContaining({ version: '1.1.0', reason: 'engines' })])
    expect(h.upgrader.candidate()).toBeUndefined()
    h.upgrader.setRelease(rc('1.1.0'))
    await h.upgrader.evaluate()
    expect(h.installs()).toEqual(['1.1.0'])
    // A newer announcement supersedes the skip.
    h.upgrader.setRelease(rc('1.2.0'))
    await h.upgrader.evaluate()
    await flush()
    expect(h.installs()).toEqual(['1.1.0', '1.2.0'])
  })

  it('retries a failed stage with backoff', async () => {
    const h = harness()
    h.cli.mockResolvedValueOnce({ ok: false, stderr: 'network down' })
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.installs()).toEqual(['1.1.0'])
    h.clock.advance(AUTO_UPGRADE_RETRY_BASE_MS - 1)
    await h.upgrader.evaluate()
    expect(h.installs()).toEqual(['1.1.0'])
    h.clock.advance(1)
    await h.upgrader.evaluate()
    await flush()
    expect(h.installs()).toEqual(['1.1.0', '1.1.0'])
  })

  it('backs off on a CP conflict and proceeds without a record when the CP lacks the frame', async () => {
    const h = harness()
    h.cp.beginLifecycle.mockRejectedValueOnce(new WireError('CONFLICT', 'pending operation'))
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.lifecycle.install).not.toHaveBeenCalled()
    expect(h.lifecycle.release).toHaveBeenCalledTimes(1)
    expect(existsSync(trialMarkerPath(h.root))).toBe(false)

    h.cp.canBeginLifecycle.mockReturnValue(false)
    h.clock.advance(AUTO_UPGRADE_RETRY_BASE_MS)
    await h.upgrader.evaluate()
    await flush()
    expect(h.lifecycle.exit).toHaveBeenCalledWith(undefined)
    expect(readTrialMarker(h.root)?.operationId).toBeUndefined()
  })

  it('skips a rolled-back version at start and reports the rollback on READY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentconnect-auto-upgrade-'))
    writeTrialMarker(root, {
      from: '1.0.0',
      to: '1.1.0',
      operationId: 'op-9',
      startedAt: '2026-01-01T00:00:00.000Z',
      failures: 3,
      rolledBack: { reason: 'crashed on start', at: '2026-01-01T00:01:00.000Z' }
    })
    const h = harness({ root })
    expect(h.upgrader.skipped()).toEqual([expect.objectContaining({ version: '1.1.0', reason: 'crashed on start' })])
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    await h.upgrader.evaluate()
    expect(h.cli).not.toHaveBeenCalled()

    await h.upgrader.onCpReady()
    expect(h.cp.reportProgress).toHaveBeenCalledWith({
      operationId: 'op-9',
      phase: 'failed',
      reason: 'rolled back: crashed on start'
    })
    expect(existsSync(trialMarkerPath(root))).toBe(false)
    expect(readAutoUpgradeState(root).skipped.map((s) => s.version)).toEqual(['1.1.0'])
  })

  it('deletes the trial marker on the new version reaching READY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentconnect-auto-upgrade-'))
    writeTrialMarker(root, { from: '1.0.0', to: '1.1.0', startedAt: '2026-01-01T00:00:00.000Z', failures: 1 })
    const h = harness({ root, version: '1.1.0' })
    await h.upgrader.onCpReady()
    expect(existsSync(trialMarkerPath(root))).toBe(false)
    expect(h.cp.reportProgress).not.toHaveBeenCalled()
  })

  it('rolls back after two non-retryable register rejections, never for an unreachable CP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentconnect-auto-upgrade-'))
    writeTrialMarker(root, { from: '1.0.0', to: '1.1.0', startedAt: '2026-01-01T00:00:00.000Z', failures: 0 })
    const h = harness({ root, version: '1.1.0' })
    h.upgrader.onRegisterRejected(new WireError('INTERNAL', 'connection closed', true))
    h.upgrader.onRegisterRejected(new WireError('INTERNAL', 'connection closed', true))
    h.upgrader.onRegisterRejected(new WireError('PROTOCOL_STATE', 'no', false))
    await flush()
    expect(h.cli).not.toHaveBeenCalled()

    h.upgrader.onRegisterRejected(new WireError('PROTOCOL_STATE', 'no', false))
    await flush()
    expect(h.cli).toHaveBeenCalledWith(['version', 'use', '1.0.0'])
    expect(readTrialMarker(root)?.rolledBack?.reason).toBe('register rejected: PROTOCOL_STATE')
    expect(h.upgrader.skipped().map((s) => s.version)).toEqual(['1.1.0'])
    expect(h.host.exitForRollback).toHaveBeenCalledTimes(1)
  })

  it('persists the switch and the announced target across a restart', async () => {
    const h = harness()
    h.activity('busy')
    h.upgrader.applyRegisterOk({ autoUpgrade: true, release: rc('1.1.0') })
    h.upgrader.stop()
    const again = harness({ root: h.root })
    expect(again.upgrader.active()).toBe(true)
    expect(again.upgrader.candidate()).toBe('1.1.0')
    // A register/ok from an older CP leaves both untouched.
    again.upgrader.applyRegisterOk({})
    expect(again.upgrader.active()).toBe(true)
    expect(again.upgrader.candidate()).toBe('1.1.0')
  })

  it('aborts the idle wait and reverts when the switch is turned off', async () => {
    const h = harness()
    h.lifecycle.install.mockImplementation(async () => {
      h.activity('busy')
      return true
    })
    h.upgrader.applyConfigKeys({ 'upgrade.auto': true, 'upgrade.latest': rc('1.1.0') })
    const run = h.upgrader.evaluate()
    await flush()
    h.upgrader.applyConfigKeys({ 'upgrade.auto': false })
    await run
    expect(h.cli).toHaveBeenCalledWith(['version', 'use', '1.0.0'])
    expect(h.cp.reportProgress).toHaveBeenCalledWith({
      operationId: 'op-1',
      phase: 'failed',
      reason: 'auto-upgrade turned off'
    })
    expect(h.lifecycle.exit).not.toHaveBeenCalled()
  })
})
