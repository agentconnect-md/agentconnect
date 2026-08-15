import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Ack, AgentActivate, AgentDetach, MemoryConnectionSpec } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { HookService } from '../../src/hooks/hook.service.js'
import type { HttpBotOrchestrator } from '../../src/orchestrator/httpBot.js'
import type { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MOVE_CAPS = {
  platforms: ['slack'],
  runtimes: ['Claude Code'],
  acp: true,
  features: ['agent-move-v1']
}

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

class MoveControlSpy {
  failMemoryUpsertAfterApply = false
  failSourceDetach = false
  readonly calls: string[] = []
  readonly activations: AgentActivate[] = []
  /** Per-target detach/activate records — the staging fence is a (daemon, moveId) pair, so a test
   *  that asserts it was RELEASED has to compare the tokens, not just the call order. */
  readonly detaches: { daemonId: string; value: AgentDetach }[] = []
  readonly activateCalls: { daemonId: string; value: AgentActivate }[] = []

  async agentDetach(daemonId: string, value: AgentDetach): Promise<Ack> {
    this.calls.push(`detach:${daemonId}`)
    this.detaches.push({ daemonId, value })
    if (daemonId === SOURCE && this.failSourceDetach) throw new Error('source is unavailable')
    return { ok: true }
  }
  async agentActivate(daemonId: string, value: AgentActivate): Promise<Ack> {
    this.calls.push(`activate:${daemonId}`)
    this.activations.push(value)
    this.activateCalls.push({ daemonId, value })
    return { ok: true }
  }
  async memoryConnectionUpsert(daemonId: string, spec: MemoryConnectionSpec): Promise<void> {
    this.calls.push(`memory-upsert:${daemonId}:${spec.connectionId}`)
    if (this.failMemoryUpsertAfterApply) throw new Error('simulated lost memory upsert ACK')
  }
  async memoryConnectionRemove(daemonId: string, connectionId: string): Promise<void> {
    this.calls.push(`memory-remove:${daemonId}:${connectionId}`)
  }
}

const live: DaemonLiveness = {
  get: (id) => ([SOURCE, TARGET].includes(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

/** One install-wide pool member, live alongside the two machines. Org-less AND Pod-bound: that
 *  shape is what makes a row visible to every org's placement list. */
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const seedPoolMember = () =>
  prisma.daemon.create({
    data: {
      id: MEMBER,
      orgId: null,
      clusterIdentity: 'system:serviceaccount:ac-example:ac-cloud-daemon',
      clusterPodUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      maxAgents: 8,
      status: 'ready',
      capabilities: MOVE_CAPS
    }
  })
const poolLive: DaemonLiveness = {
  get: (id) =>
    [SOURCE, TARGET, MEMBER].includes(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined
}

async function seedMoveDaemons(): Promise<void> {
  await seedDaemon(prisma, SOURCE, { capabilities: MOVE_CAPS })
  await seedDaemon(prisma, TARGET, { capabilities: MOVE_CAPS })
}

describe('PUT /agents/:id/daemon', () => {
  it('cold-moves the full dependent bundle and repairs an idempotent retry', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const classicBot = randomUUID()
    const httpBot = randomUUID()
    const classicIntegration = randomUUID()
    const sharedIntegration = randomUUID()
    const cronId = randomUUID()
    await prisma.bot.createMany({
      data: [
        { id: classicBot, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'classic' },
        { id: httpBot, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'shared', shareable: true, transport: 'http' }
      ]
    })
    await prisma.botSecret.createMany({
      data: [
        { botId: classicBot, botToken: 'xoxb-classic', appToken: 'xapp-classic' },
        { botId: httpBot, botToken: 'xoxb-shared', appToken: 'xapp-shared' }
      ]
    })
    await prisma.integration.createMany({
      data: [
        {
          id: classicIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId,
          botId: classicBot,
          platform: 'slack',
          name: 'classic'
        },
        {
          id: sharedIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId,
          botId: httpBot,
          platform: 'slack',
          name: 'shared'
        }
      ]
    })
    await prisma.integrationChannel.create({
      data: { integrationId: classicIntegration, channelId: 'C123', trigger: 'any' }
    })
    await prisma.cronDef.create({
      data: {
        id: cronId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        schedule: '0 0 * * *',
        timezone: 'UTC',
        trigger: 'daily',
        enabled: true
      }
    })

    const control = new MoveControlSpy()
    const derived: string[] = []
    running = buildHttpApp(prisma, undefined, live, control as unknown as ControlSender, {
      hooks: { rebroadcastForAgent: async () => void derived.push('hooks') } as unknown as HookService,
      httpBot: {
        syncBot: async (id: string) => void derived.push(`http:${id}`)
      } as unknown as HttpBotOrchestrator,
      collabRoutes: { broadcast: async () => void derived.push('collab') } as unknown as CollabRoutesService
    })

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: TARGET }
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { daemonId: string; status: string }).daemonId).toBe(TARGET)
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.daemonId).toBe(TARGET)
    expect(control.calls).toEqual([`detach:${SOURCE}`, `detach:${TARGET}`, `activate:${TARGET}`])
    expect(control.activations).toHaveLength(1)
    expect(control.activations[0]?.agentId).toBe(agentId)
    expect(
      control.activations[0]?.integrations
        .flatMap((integration) => (integration.platform === 'slack' ? [integration.core!.mode] : []))
        .sort()
    ).toEqual(['direct', 'shared'])
    expect(control.activations[0]?.crons.map((cron) => cron.cronId)).toEqual([cronId])
    expect(derived).toEqual(['hooks', 'collab', `http:${httpBot}`])

    // A lost-response retry repairs the full target bundle and activates again,
    // and first arms the idempotent target staging gate.
    control.calls.length = 0
    const retry = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: TARGET }
    })
    expect(retry.statusCode).toBe(200)
    expect(control.calls[0]).toBe(`detach:${TARGET}`)
    expect(control.calls.at(-1)).toBe(`activate:${TARGET}`)
  })

  it('stages an external-memory registry before activation and removes the unused source copy', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, { RELAY_STALE_MS: 60_000 }, live, control as unknown as ControlSender)
    await running.deps.repos.relay.upsertByName('move-relay', 'wss://relay.example/rd', new Date())
    const installation = await running.deps.repos.memoryPluginInstallation.create({
      orgId: OrgId(DEFAULT_ORG_ID),
      pluginId: 'ai.example.move-memory',
      transport: 'streamable-http',
      endpoint: 'https://plugin.example/mcp',
      pinnedProfileMajor: 1,
      secretHeaders: [{ name: 'apiKey', header: 'Authorization', required: true }]
    })
    const connection = await running.deps.repos.externalMemoryConnection.create({
      orgId: OrgId(DEFAULT_ORG_ID),
      installationId: installation.id,
      config: { projectId: 'move' }
    })
    await running.deps.repos.externalMemoryConnectionSecret.put(OrgId(DEFAULT_ORG_ID), connection.id, {
      apiKey: 'secret'
    })
    await running.deps.repos.externalMemoryGrant.mintFor(OrgId(DEFAULT_ORG_ID), connection.id)
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        runtimeOverrides: {
          memory: {
            provider: 'external',
            connectionId: connection.id,
            recall: { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 },
            capture: { mode: 'manual' }
          }
        }
      }
    })
    // A request may time out after the target applied the private definition.
    // Treat that as potentially staged and revoke the unused target copy.
    control.failMemoryUpsertAfterApply = true
    const failed = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: TARGET }
    })
    expect(failed.statusCode).toBe(503)
    expect(control.calls).toEqual([
      `memory-upsert:${TARGET}:${connection.id}`,
      `memory-remove:${TARGET}:${connection.id}`
    ])
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.daemonId).toBe(SOURCE)

    control.failMemoryUpsertAfterApply = false
    control.calls.length = 0
    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: TARGET }
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(control.calls).toEqual([
      `memory-upsert:${TARGET}:${connection.id}`,
      `detach:${SOURCE}`,
      `detach:${TARGET}`,
      `activate:${TARGET}`,
      `memory-upsert:${TARGET}:${connection.id}`,
      `memory-remove:${SOURCE}:${connection.id}`
    ])
    expect(control.activations[0]?.spec.memory).toMatchObject({
      provider: 'external',
      connectionId: connection.id
    })
  })

  it('rejects an unready, unsupported, incompatible, or full target before detaching source', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()

    const attempt = async (liveness: DaemonLiveness) => {
      running = buildHttpApp(prisma, undefined, liveness, control as unknown as ControlSender)
      const res = await running.app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${agentId}/daemon`,
        payload: { daemonId: TARGET }
      })
      await running.close()
      running = undefined
      return res
    }

    expect(
      (
        await attempt({
          get: (id) => (id === SOURCE ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
        })
      ).statusCode
    ).toBe(409)

    await prisma.daemon.update({ where: { id: TARGET }, data: { capabilities: { ...MOVE_CAPS, features: [] } } })
    expect((await attempt(live)).json()).toMatchObject({ message: 'target daemon does not support agent moves' })

    await prisma.daemon.update({ where: { id: TARGET }, data: { capabilities: MOVE_CAPS } })
    await prisma.runtimeProfile.create({
      data: { daemonId: TARGET, runtime: 'codex', version: '1.0.0', models: [] }
    })
    expect((await attempt(live)).json()).toMatchObject({ message: 'target daemon does not support runtime claude' })
    await prisma.runtimeProfile.deleteMany({ where: { daemonId: TARGET } })

    await prisma.runtimeProfile.create({
      data: {
        daemonId: TARGET,
        runtime: 'claude',
        version: '1.0.0',
        models: ['supported'],
        mcpCapabilities: { http: false, sse: false }
      }
    })
    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: { model: 'missing' } } })
    expect((await attempt(live)).json()).toMatchObject({
      message: 'target daemon does not support model missing for runtime claude'
    })

    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: { mcpServers: ['missing'] } } })
    expect((await attempt(live)).json()).toMatchObject({ message: 'target daemon cannot attach MCP server missing' })

    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: { mcpServers: ['remote'] } } })
    await prisma.daemon.update({
      where: { id: TARGET },
      data: { mcpServers: [{ name: 'remote', transport: 'http' }] }
    })
    expect((await attempt(live)).json()).toMatchObject({
      message: 'target runtime claude does not support MCP http transport for remote'
    })

    await prisma.runtimeProfile.deleteMany({ where: { daemonId: TARGET } })
    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: {} } })

    await prisma.daemon.update({ where: { id: TARGET }, data: { load: { agents: 4, cpu: 0, mem: 0 }, maxAgents: 4 } })
    expect((await attempt(live)).json()).toMatchObject({ message: 'target daemon is at agent capacity' })
    expect(control.calls).toEqual([])
  })

  it('requires an explicit force reassign before continuing without a source detach ACK', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()
    let sourceReachable = true
    const sourceCanDisappear: DaemonLiveness = {
      get: (id) =>
        [SOURCE, TARGET].includes(id)
          ? { state: 'READY', reachable: id === TARGET || sourceReachable, sessionEpoch: 1 }
          : undefined
    }
    running = buildHttpApp(prisma, undefined, sourceCanDisappear, control as unknown as ControlSender)
    const attempt = (force = false) =>
      running!.app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${agentId}/daemon`,
        payload: { daemonId: TARGET, ...(force ? { force: true } : {}) }
      })

    const forcedWhileReady = await attempt(true)
    expect(forcedWhileReady.statusCode).toBe(409)
    expect(forcedWhileReady.json()).toMatchObject({ message: 'source daemon is ready; use a safe move' })

    sourceReachable = false
    const safe = await attempt()
    expect(safe.statusCode).toBe(409)
    expect(safe.json()).toMatchObject({ message: 'source daemon is not ready' })
    expect(control.calls).toEqual([])

    control.failSourceDetach = true
    const recovered = await attempt(true)
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect((recovered.json() as { daemonId: string }).daemonId).toBe(TARGET)
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.daemonId).toBe(TARGET)
    expect(control.calls).toEqual([`detach:${SOURCE}`, `detach:${TARGET}`, `activate:${TARGET}`])

    const retried = await attempt(true)
    expect(retried.statusCode, retried.body).toBe(200)
    expect((retried.json() as { daemonId: string }).daemonId).toBe(TARGET)
    expect(control.calls).toEqual([
      `detach:${SOURCE}`,
      `detach:${TARGET}`,
      `activate:${TARGET}`,
      `detach:${TARGET}`,
      `activate:${TARGET}`
    ])
  })

  it('places an unplaced runtime-less preset only after its runtime is set', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    // The general preset ships unplaced with deferred exec config
    // (preset-agents.md §3.2) — no daemon, no runtime.
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: null, runtime: null } })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, live, control as unknown as ControlSender)
    const place = () =>
      running!.app.inject({ method: 'PUT', url: `${ORG}/agents/${agentId}/daemon`, payload: { daemonId: TARGET } })

    // (The 409's wording is pinned by preset-agents.test.ts.)
    expect((await place()).statusCode).toBe(409)
    expect(control.calls).toEqual([])

    // The console places by committing the chosen runtime first (the spec PATCH
    // needs no daemon) and then the placement — the pairing the edit dialog sends
    // for an initial placement.
    const patched = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { runtime: 'claude' }
    })
    expect(patched.statusCode, patched.body).toBe(200)

    const placed = await place()
    expect(placed.statusCode, placed.body).toBe(200)
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.daemonId).toBe(TARGET)
    // No source daemon to drain: the target is staged and activated, nothing detaches
    // from a machine this agent never ran on.
    expect(control.calls).toEqual([`detach:${TARGET}`, `activate:${TARGET}`])
  })

  it('treats a cached (hydrated) model list as permissive for the move model gate', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: { model: 'missing' } } })
    await prisma.runtimeProfile.create({
      data: { daemonId: TARGET, runtime: 'claude', version: '1.0.0', models: ['supported'], modelsSource: 'probed' }
    })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, live, control as unknown as ControlSender)
    const move = () =>
      running!.app.inject({ method: 'PUT', url: `${ORG}/agents/${agentId}/daemon`, payload: { daemonId: TARGET } })

    // A live-probed list stays strict…
    expect((await move()).statusCode).toBe(409)

    // …but the same list hydrated from the daemon's last-good cache (a probe has
    // not confirmed it this process) is permissive, exactly like an empty one
    // (runtime-model-catalog.md §5) — the move must not strand on a stale list.
    await prisma.runtimeProfile.updateMany({ where: { daemonId: TARGET }, data: { modelsSource: 'cached' } })
    const res = await move()
    expect(res.statusCode, res.body).toBe(200)
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.daemonId).toBe(TARGET)
  })

  it('returns 409 for agent, integration, and cron writes while that agent is moving', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: SOURCE,
      createdByUserId: DEFAULT_OWNER_ID
    })
    const botId = randomUUID()
    const sharedBotId = randomUUID()
    await prisma.bot.create({
      data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'guarded' }
    })
    await prisma.bot.create({
      data: {
        id: sharedBotId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'shared-guarded',
        shareable: true,
        transport: 'http'
      }
    })
    await prisma.integration.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId,
        botId: sharedBotId,
        platform: 'slack',
        name: 'shared-guarded'
      }
    })
    const gate = new AgentMutationGate()
    const release = gate.tryBeginMove(agentId)!
    running = buildHttpApp(prisma, undefined, live, undefined, { agentMutations: gate })

    try {
      const responses = await Promise.all([
        running.app.inject({
          method: 'PATCH',
          url: `${ORG}/agents/${agentId}`,
          payload: { description: 'blocked' }
        }),
        running.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` }),
        running.app.inject({
          method: 'PUT',
          url: `${ORG}/agents/${agentId}/sharing`,
          payload: { visibility: 'org', sharedWith: [] }
        }),
        running.app.inject({
          method: 'PUT',
          url: `${ORG}/agents/${agentId}/call-policy`,
          payload: { callPolicy: 'all', allowedCallerAgentIds: [] }
        }),
        running.app.inject({
          method: 'POST',
          url: `${ORG}/integrations`,
          payload: { agentId, platform: 'slack', botId }
        }),
        running.app.inject({
          method: 'PUT',
          url: `${ORG}/crons/${randomUUID()}`,
          payload: { agentId, schedule: '0 0 * * *', trigger: 'daily', enabled: true }
        }),
        running.app.inject({
          method: 'PATCH',
          url: `${ORG}/bots/${sharedBotId}`,
          payload: { shareable: false }
        })
      ])
      expect(responses.map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409, 409, 409])
    } finally {
      release()
    }
  })

  it('blocks promoting a classic bot while an existing member agent is moving', async () => {
    await seedMoveDaemons()
    const movingAgentId = randomUUID()
    const joiningAgentId = randomUUID()
    await seedAgent(prisma, movingAgentId, { daemonId: SOURCE })
    await seedAgent(prisma, joiningAgentId, { daemonId: SOURCE })
    const botId = randomUUID()
    await prisma.bot.create({
      data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'classic-member' }
    })
    await prisma.integration.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId: movingAgentId,
        botId,
        platform: 'slack',
        name: 'classic-member'
      }
    })
    const gate = new AgentMutationGate()
    const release = gate.tryBeginMove(movingAgentId)!
    running = buildHttpApp(prisma, undefined, live, undefined, { agentMutations: gate })
    try {
      const res = await running.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { agentId: joiningAgentId, platform: 'slack', botId, shareable: true }
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ message: expect.stringContaining('move is in progress') })
      expect(await prisma.integration.count({ where: { botId } })).toBe(1)
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).shareable).toBe(false)
    } finally {
      release()
    }
  })

  it('re-reads agent placement after acquiring integration and cron mutation leases', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const botId = randomUUID()
    await prisma.bot.create({
      data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'race' }
    })

    const moveAfterFirstRead = (app: HttpApp) => {
      const original = app.deps.repos.agent.get.bind(app.deps.repos.agent)
      let first = true
      app.deps.repos.agent.get = async (orgId, id) => {
        const observed = await original(orgId, id)
        if (first && observed?.id === agentId) {
          first = false
          await prisma.agent.update({ where: { id: agentId }, data: { daemonId: TARGET } })
        }
        return observed
      }
    }

    running = buildHttpApp(prisma, undefined, live)
    moveAfterFirstRead(running)
    const integration = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { agentId, platform: 'slack', botId }
    })
    expect(integration.statusCode).toBe(409)
    expect(await prisma.integration.count({ where: { agentId } })).toBe(0)

    await running.close()
    running = undefined
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: SOURCE } })
    running = buildHttpApp(prisma, undefined, live)
    moveAfterFirstRead(running)
    const cronId = randomUUID()
    const cron = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: { agentId, schedule: '0 0 * * *', trigger: 'daily', enabled: true }
    })
    expect(cron.statusCode).toBe(409)
    expect(await prisma.cronDef.count({ where: { id: cronId } })).toBe(0)
  })
})

describe('PUT /agents/:id/daemon — the pool as a placement target', () => {
  // The pool is not a member id. Moving onto it commits kind `pool` and CLEARS `daemonId`; the
  // ledger then grants the agent's group to whichever member is live, which is what makes the
  // placement survive a rollout instead of naming a Pod that no longer exists.
  it('moves onto the pool: kind pool, no member id, and no synchronous activation', async () => {
    await seedMoveDaemons()
    await seedPoolMember()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, poolLive, control as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ placementKind: 'pool', daemonId: null })
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      placementKind: 'pool',
      daemonId: null,
      status: 'active'
    })
    // The source is quiesced; the pool member is NOT activated — install-on-grant does that when
    // the ledger picks a member, and naming one here would only pre-empt a choice that is not the
    // control plane's to make.
    expect(control.calls.filter((c) => c.startsWith('detach:'))).toContain(`detach:${SOURCE}`)
    expect(control.calls.some((c) => c.startsWith('activate:'))).toBe(false)
  })

  it('moves back off the pool onto a machine, quiescing the member that holds it', async () => {
    await seedMoveDaemons()
    await seedPoolMember()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    await prisma.agent.update({ where: { id: agentId }, data: { placementKind: 'pool', daemonId: null } })
    // The member currently holding its duty is the source to quiesce — placement names none.
    const groupId = randomUUID()
    await prisma.dutyGroup.create({
      data: {
        id: groupId,
        orgId: DEFAULT_ORG_ID,
        holder: MEMBER,
        term: 1n,
        expiresAt: new Date(Date.now() + 120_000)
      }
    })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID }
    })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, poolLive, control as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: TARGET }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ placementKind: 'daemon', daemonId: TARGET })
    expect(control.calls).toContain(`detach:${MEMBER}`)
    expect(control.calls).toContain(`activate:${TARGET}`)
  })

  it('refuses a pool target when no member is ready', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()
    // `live` knows only SOURCE and TARGET — there is no install-wide member at all.
    running = buildHttpApp(prisma, undefined, live, control as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('no cloud daemon member is ready')
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      placementKind: 'daemon',
      daemonId: SOURCE
    })
  })

  it('rejects a body that names both a pool placement and a member id', async () => {
    await seedMoveDaemons()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    running = buildHttpApp(prisma, undefined, live, new MoveControlSpy() as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool', daemonId: TARGET }
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('POST /agents — the pool as a create-time placement', () => {
  it('creates ON the pool: kind pool, no member id, active', async () => {
    // The console submits `placementKind: 'pool'`. Dropping it on the floor lands the agent as an
    // inactive daemon placement with no ref — unplaced — which reads to the user as "create
    // silently did nothing".
    await seedMoveDaemons()
    await seedPoolMember()
    running = buildHttpApp(prisma, undefined, poolLive, new MoveControlSpy() as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'pooled-create', runtime: 'Claude Code', placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ placementKind: 'pool', daemonId: null, status: 'active' })
    const row = await prisma.agent.findFirstOrThrow({ where: { name: 'pooled-create' } })
    expect(row).toMatchObject({ placementKind: 'pool', daemonId: null, status: 'active' })
  })

  it('refuses a pool create when no member is ready, instead of landing it unplaced', async () => {
    await seedMoveDaemons()
    running = buildHttpApp(prisma, undefined, live, new MoveControlSpy() as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'pooled-create', runtime: 'Claude Code', placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(409)
    expect(await prisma.agent.findFirst({ where: { name: 'pooled-create' } })).toBeNull()
  })
})

describe('PUT /agents/:id/daemon — converting a member-pinned agent to the pool', () => {
  // The transition that differs from every other move: the source is itself an eligible holder of
  // the NEW placement. Leaving it fenced would let the ledger grant it back the group it was
  // staged out of — and `installGrantedAgents` skips a move-staged agent, so it would hold the
  // lease, install nothing, and serve nothing, with no other member able to claim it.
  it('clears the source member’s staging fence so it is a usable holder again', async () => {
    await seedMoveDaemons()
    await seedPoolMember()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    // Pinned to the MEMBER, which is the shape today's pool agents actually have.
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: MEMBER } })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, poolLive, control as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ placementKind: 'pool', daemonId: null })
    // Detached to stop it serving as a PLACEMENT, then activated with the SAME token so the fence
    // it armed is released and its replica is current for a re-grant.
    const detach = control.detaches.find((d) => d.daemonId === MEMBER)
    const activate = control.activateCalls.find((a) => a.daemonId === MEMBER)
    expect(detach).toBeDefined()
    expect(activate).toBeDefined()
    expect(activate!.value.moveId).toBe(detach!.value.moveId)
    expect(control.calls.indexOf(`detach:${MEMBER}`)).toBeLessThan(control.calls.indexOf(`activate:${MEMBER}`))
  })

  it('leaves a LOCAL daemon fenced on the same conversion — it may not serve a pool agent', async () => {
    // The asymmetry, stated as a test: a local daemon is not an eligible holder, so the fence is
    // exactly right there and clearing it would invite the split brain a hard cutover prevents.
    await seedMoveDaemons()
    await seedPoolMember()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: SOURCE })
    const control = new MoveControlSpy()
    running = buildHttpApp(prisma, undefined, poolLive, control as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool' }
    })

    expect(res.statusCode).toBe(200)
    expect(control.calls).toContain(`detach:${SOURCE}`)
    expect(control.calls).not.toContain(`activate:${SOURCE}`)
  })
})
