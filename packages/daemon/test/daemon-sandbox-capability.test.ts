import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RegisterReq } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'

const AGENT_ID = 'bot-a'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-sandbox-cap-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'arbitrary-acp',
      builtin: true,
      runInSandbox: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** Boots a daemon and reports what it would tell the CP about its sandbox, under `mutate`'s state. */
async function sandboxReport(mutate: (daemon: Record<string, any>) => void): Promise<{
  features: string[]
  unavailable: string | undefined
}> {
  const daemon = new Daemon({
    root: scaffold(),
    hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
  })
  await daemon.start()
  const anyDaemon = daemon as never as Record<string, any>
  mutate(anyDaemon)
  const report = { features: anyDaemon.registrationFeatures(), unavailable: anyDaemon.sandboxUnavailableReason() }
  await daemon.stop().catch(() => {})
  return report
}

describe('the sandbox a daemon reports', () => {
  it('still claims the capability when a configured microsandbox failed, and says why', async () => {
    const report = await sandboxReport((daemon) => {
      daemon.cfg.sandbox.backend = 'microsandbox'
      daemon.microsandbox = undefined
      daemon.microsandboxFailure = 'cannot open /dev/kvm'
    })
    // Reporting no capability would read as "this host runs agents unconfined" — the opposite of the truth.
    expect(report.features).toContain('sandbox')
    expect(report.unavailable).toBe('cannot open /dev/kvm')
  })

  it('names the state even when the failure text was lost', async () => {
    const report = await sandboxReport((daemon) => {
      daemon.cfg.sandbox.backend = 'microsandbox'
      daemon.microsandbox = undefined
      daemon.microsandboxFailure = undefined
    })
    expect(report.features).toContain('sandbox')
    expect(report.unavailable).toBe('microsandbox is not initialized')
  })

  it('reports a healthy microsandbox with no reason attached', async () => {
    const report = await sandboxReport((daemon) => {
      daemon.cfg.sandbox.backend = 'microsandbox'
      daemon.microsandbox = { stopAll: vi.fn(async () => {}) }
    })
    expect(report.features).toContain('sandbox')
    expect(report.unavailable).toBeUndefined()
  })

  it('publishes a bounded summary, so a huge failure cannot strand the whole daemon', async () => {
    // `msb pull` may hand back a megabyte of stderr; the register frame caps this field, and a
    // rejected registration would take down the daemon's unsandboxed agents too.
    const stderr = `boom ${'x'.repeat(4000)}`
    const report = await sandboxReport((daemon) => {
      daemon.cfg.sandbox.backend = 'microsandbox'
      daemon.microsandbox = undefined
      daemon.microsandboxFailure = `Error: ${stderr}\n    at Object.run (/opt/daemon/dist/index.js:1:1)`
    })
    expect(report.unavailable!.length).toBeLessThanOrEqual(500)
    expect(report.unavailable).toContain('boom')
    expect(report.unavailable!.endsWith('…')).toBe(true)
    // Stack frames are log material, not console material.
    expect(report.unavailable).not.toContain('at Object.run')

    const decoded = RegisterReq.safeParse({
      host: 'example-host',
      capabilities: {
        platforms: [],
        runtimes: [],
        acp: true,
        features: report.features,
        sandboxUnavailable: report.unavailable
      },
      maxAgents: 1,
      localState: { assignments: [], crons: [], leases: [] }
    })
    expect(decoded.success).toBe(true)
  })

  it('claims nothing on a host whose SRT backend has no mechanism', async () => {
    const report = await sandboxReport((daemon) => {
      daemon.sandboxMechanism = undefined
    })
    expect(report.features).not.toContain('sandbox')
    expect(report.unavailable).toBeUndefined()
  })
})
