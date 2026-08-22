import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stub the Slack socket so applying an integration never touches the network. Keep
// the REAL `consolidate` (the seam that reads agent.integrations to group sockets).
vi.mock('../../src/slack/connection.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/slack/connection.js')>()
  class FakeSlackConnection {
    appToken: string
    botToken: string
    botUserId = 'U_FAKE'
    botId = 'B_FAKE'
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    constructor(deps: { group: { appToken: string; botToken: string } }) {
      this.appToken = deps.group.appToken
      this.botToken = deps.group.botToken
    }
  }
  return { ...actual, SlackConnection: FakeSlackConnection }
})

import { Daemon } from '../../src/daemon.js'
import type { IntegrationSpec, RegisterOk } from '@agentconnect.md/protocol'
import { fakeSlackAppFactory } from '../fakes/slack-app.js'

function root1(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cpint-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  return root
}

function writeAgent(root: string, id: string) {
  const adir = join(root, 'agents', id)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id,
      name: id,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'ws') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
}

function makeDaemon(root: string) {
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: (agent) =>
      ({
        id: agent.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }) as never
  })
  return { daemon }
}

const seam = (d: Daemon) => d as unknown as { cpConfigApply: () => import('../../src/cp/config-apply.js').ConfigApply }
const apply = (d: Daemon) => seam(d).cpConfigApply()

const INTEGRATION: IntegrationSpec = {
  integrationId: '66666666-6666-4666-8666-666666666666',
  agentId: 'bot-a',
  platform: 'slack',
  // §6.4 final shape: envelope + platform-private config (no duplicated knobs).
  core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }], mutedChannels: [], gated: false },
  config: {
    botToken: 'xoxb-secret-abc',
    appToken: 'xapp-1-secret-def'
  }
}

describe('Daemon CP integration → memory-only effective config', () => {
  it('keeps the CP integration out of agent.json and opens a socket', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    apply(daemon).applyIntegrationUpsert(INTEGRATION)
    await daemon.reconcile()

    // The user's local file is never rewritten with CP credentials.
    const onDisk = JSON.parse(readFileSync(join(root, 'agents', 'bot-a', 'agent.json'), 'utf8'))
    expect(onDisk.integrations).toEqual([])

    // Loaded into the live agent set (consolidate / routing / tools all read this).
    const eff = (
      daemon as unknown as {
        agents: Map<string, { integrations: { id: string; config: { botToken: string } }[] }>
      }
    ).agents.get('bot-a')!
    expect(eff.integrations).toHaveLength(1)
    expect(eff.integrations[0]!.id).toBe(INTEGRATION.integrationId)
    expect(eff.integrations[0]!.config.botToken).toBe('xoxb-secret-abc')

    // A socket was opened + bound for the integration.
    const connByIntegration = (daemon as unknown as { connByIntegration: Map<string, unknown> }).connByIntegration
    expect(connByIntegration.has(INTEGRATION.integrationId)).toBe(true)

    expect((daemon as any).cpLocalState()).toMatchObject({
      agents: [{ agentId: 'bot-a', origin: 'unknown' }],
      integrations: [{ integrationId: INTEGRATION.integrationId, origin: 'cp' }]
    })

    await daemon.stop()
  })

  it('does not survive a restart without CP reconvergence', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    apply(daemon).applyIntegrationUpsert(INTEGRATION)
    await daemon.reconcile()
    await daemon.stop()

    // A new process must not recover CP credentials from the local file.
    const { daemon: reborn } = makeDaemon(root)
    await reborn.start()
    const eff = (reborn as unknown as { agents: Map<string, { integrations: { id: string }[] }> }).agents.get('bot-a')!
    expect(eff.integrations).toEqual([])
    const connByIntegration = (reborn as unknown as { connByIntegration: Map<string, unknown> }).connByIntegration
    expect(connByIntegration.has(INTEGRATION.integrationId)).toBe(false)
    await reborn.stop()
  })

  it('applyIntegrationRemove drops it from memory without rewriting agent.json', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    apply(daemon).applyIntegrationUpsert(INTEGRATION)
    await daemon.reconcile()
    expect(
      (daemon as unknown as { agents: Map<string, { integrations: unknown[] }> }).agents.get('bot-a')!.integrations
    ).toHaveLength(1)

    apply(daemon).applyIntegrationRemove(INTEGRATION.integrationId)
    await daemon.reconcile()
    expect(
      (daemon as unknown as { agents: Map<string, { integrations: unknown[] }> }).agents.get('bot-a')!.integrations
    ).toHaveLength(0)
    const onDisk = JSON.parse(readFileSync(join(root, 'agents', 'bot-a', 'agent.json'), 'utf8'))
    expect(onDisk.integrations).toEqual([])

    await daemon.stop()
  })

  it('register/ok integrations[] converges the daemon-scoped set in memory', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await apply(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      crons: [],
      leases: [],
      integrations: [INTEGRATION],
      drop: { assignments: [], crons: [] }
    } as unknown as RegisterOk)
    await daemon.reconcile()

    const eff = (daemon as unknown as { agents: Map<string, { integrations: { id: string }[] }> }).agents.get('bot-a')!
    expect(eff.integrations[0]!.id).toBe(INTEGRATION.integrationId)
    const onDisk = JSON.parse(readFileSync(join(root, 'agents', 'bot-a', 'agent.json'), 'utf8'))
    expect(onDisk.integrations).toEqual([])

    await daemon.stop()
  })

  it('register/ok drop.integrations removes a CP-owned replica missed while disconnected', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    apply(daemon).applyIntegrationUpsert(INTEGRATION)
    await daemon.reconcile()

    await apply(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      crons: [],
      leases: [],
      integrations: [],
      drop: { assignments: [], crons: [], agents: [], integrations: [INTEGRATION.integrationId] }
    } as unknown as RegisterOk)
    await daemon.reconcile()

    const onDisk = JSON.parse(readFileSync(join(root, 'agents', 'bot-a', 'agent.json'), 'utf8'))
    expect(onDisk.integrations).toEqual([])
    expect((daemon as any).connByIntegration.has(INTEGRATION.integrationId)).toBe(false)
    await daemon.stop()
  })
})
