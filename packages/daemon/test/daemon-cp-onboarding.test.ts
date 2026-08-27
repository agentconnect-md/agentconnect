import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Capture what daemonId (if any) the daemon echoes into the auth frame by
// intercepting the CpClient constructor. start() is a no-op so nothing dials.
const { cpClientCtor } = vi.hoisted(() => ({ cpClientCtor: vi.fn() }))
vi.mock('../src/cp/client.js', () => ({
  CpClient: class {
    constructor(opts: unknown) {
      cpClientCtor(opts)
    }
    start() {}
    stop() {}
  }
}))

import { Daemon } from '../src/daemon.js'

/** Scaffold a root whose config.json has the CP enabled with url+key, plus a
 *  stale, locally-persisted daemonId (as a prior flagless `run` would leave). */
function scaffoldOnboarding(daemonId?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-onboard-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      ...(daemonId ? { daemonId } : {}),
      controlPlane: { enabled: true, url: 'wss://cp.example/daemon/ws', key: 'ac_daemon_tokabc' },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('Daemon CP key onboarding (auth-frame daemonId)', () => {
  beforeEach(() => cpClientCtor.mockClear())

  it("does NOT echo a config-persisted daemonId — defers to the key's daemon (from auth/ok)", async () => {
    const root = scaffoldOnboarding('stale-local-uuid')
    const daemon = new Daemon({ root })
    await daemon.start()
    expect(cpClientCtor).toHaveBeenCalledTimes(1)
    const opts = cpClientCtor.mock.calls[0]![0] as { daemonId?: string }
    expect(opts.daemonId).toBeUndefined()
    await daemon.stop()
  })

  it("echoes an explicit --daemon-id (it must match the key's daemon)", async () => {
    const root = scaffoldOnboarding('stale-local-uuid')
    const daemon = new Daemon({ root, overrides: { daemonId: 'explicit-id' } })
    await daemon.start()
    const opts = cpClientCtor.mock.calls[0]![0] as { daemonId?: string }
    expect(opts.daemonId).toBe('explicit-id')
    await daemon.stop()
  })
})
