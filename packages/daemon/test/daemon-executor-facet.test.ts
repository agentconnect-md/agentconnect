import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
import { Daemon } from '../src/daemon.js'
import type { ExecutorFacet } from '../src/execution/executor-facet.js'

// The facet's own behaviour is `executor-facet.test.ts`; this is its wiring into the daemon: the config key, the registration facts, the heartbeat and the shutdown drain.
const AGENT_ID = 'bot-a'
const PREPARE = {
  agentId: '11111111-1111-4111-8111-111111111111',
  sessionKey: 'slack:C1:1700000000.000100:11111111-1111-4111-8111-111111111111',
  executorDaemonId: '33333333-3333-4333-8333-333333333333',
  launchId: '55555555-5555-4555-8555-555555555555',
  strategy: 'host'
}

function scaffold(sandbox?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-xd-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } },
      ...(sandbox ? { sandbox } : {})
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
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

async function started(sandbox?: Record<string, unknown>) {
  const root = scaffold(sandbox)
  const daemon = new Daemon({
    root,
    hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
  })
  await daemon.start()
  const internals = daemon as never as {
    executorFacet: ExecutorFacet
    cpClient?: { localAddress: () => string }
    cpClientDepsHost: (root: string, url: string, resolve: () => void) => Parameters<typeof buildCpClientDeps>[0]
  }
  // Exactly what registration and the heartbeat would send, read through the production wiring.
  const deps = buildCpClientDeps(internals.cpClientDepsHost(root, 'wss://cp.example.test', () => {}))
  return { daemon, internals, deps }
}

describe('daemon wiring of the executor facet', () => {
  it("is today's daemon by default: no executor facts, no hosted count, and a relayed prepare refused", async () => {
    const { daemon, deps } = await started()
    try {
      expect(deps.capabilities()).not.toHaveProperty('executor')
      expect(deps.hostedSessions?.()).toBeUndefined()
      expect(await deps.executorPrepare!(PREPARE)).toEqual({ status: 'refused', reason: 'facet_off' })
    } finally {
      await daemon.stop().catch(() => {})
    }
  })

  it.skipIf(process.platform === 'linux')(
    'stays dark off Linux even when shared: the host strategy cannot run there',
    async () => {
      const { daemon, deps } = await started({ share: true })
      try {
        expect(deps.capabilities()).not.toHaveProperty('executor')
        expect(await deps.executorPrepare!(PREPARE)).toEqual({ status: 'refused', reason: 'facet_off' })
      } finally {
        await daemon.stop().catch(() => {})
      }
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'registers its facts once shared, reports its hosted count, and closes its port on stop',
    async () => {
      const { daemon, internals, deps } = await started({ share: true })
      let port: number
      try {
        // No control connection in this test, so no address to publish until one is stood in for it.
        expect(deps.capabilities().executor).toEqual({
          enabled: true,
          strategies: { host: { available: true }, microsandbox: { available: false, reason: expect.any(String) } },
          capacity: 32
        })
        internals.cpClient = { localAddress: () => '192.0.2.10' }
        const endpoint = deps.capabilities().executor!.endpoint!
        internals.cpClient = undefined
        expect(endpoint.host).toBe('192.0.2.10')
        port = endpoint.port
        expect(deps.hostedSessions?.()).toBe(0)
      } finally {
        await daemon.stop().catch(() => {})
      }
      await expect(
        new Promise((resolve, reject) =>
          connect({ host: '127.0.0.1', port }).once('connect', resolve).once('error', reject)
        )
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    }
  )

  it('joins the existing shutdown drain with the budget its own turns get, then stops the facet', async () => {
    const { daemon, internals } = await started()
    const calls: string[] = []
    internals.executorFacet = {
      facts: () => undefined,
      hostedSessions: () => undefined,
      prepare: async () => ({ status: 'refused', reason: 'draining' }),
      release: async () => ({ status: 'unknown' }),
      reconcile: async () => {},
      drain: async (deadlineMs) => void calls.push(`drain ${deadlineMs}`),
      stop: async () => void calls.push('stop')
    }
    await daemon.stop()
    // `limits.shutdownDrainMs` by default; no new phase and no new wire value carries it.
    expect(calls).toEqual(['drain 25000', 'stop'])
  })
})
