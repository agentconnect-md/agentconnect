// `assistant/follow-up-watch` and `assistant/follow-up-wake` over the real daemon WS edge and real Postgres, with the code host stubbed.
import { describe, expect, it } from 'vitest'
import {
  FOLLOW_UP_WAKE_FEATURE,
  FOLLOW_UP_WATCH_FEATURE,
  isFrame,
  type RcFollowUpWatch
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FollowUpWatchService, STATE_QUIET_MS } from '../../src/codehost/follow-up-watch.service.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgAgentRepo, PgFollowUpWatchRepo, PgLaunchRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd11'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd12'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11'
const TARGET = {
  provider: 'github' as const,
  host: 'github.com',
  repoPath: 'example-org/example-repo',
  subject: 'pull' as const,
  number: 12
}

function harness() {
  const h = buildWsHarness(prisma)
  const relayed: RcFollowUpWatch[] = []
  const service = new FollowUpWatchService({
    clock: h.clock,
    watches: new PgFollowUpWatchRepo(prisma),
    agents: new PgAgentRepo(prisma),
    providers: [
      {
        provider: 'github',
        resolve: async (_agent, target) => ({
          installationId: 99n,
          bindingId: '',
          host: 'github.com',
          repoId: 456n,
          repoPath: target.repoPath,
          subject: target.subject,
          number: target.number
        }),
        covers: async () => true,
        relayWatch: (object, watched) => ({
          provider: 'github',
          installationId: String(object.installationId),
          repoId: String(object.repoId),
          subject: object.subject,
          number: object.number,
          watched
        })
      }
    ],
    opener: async () => null,
    placement: h.placement,
    daemon: (daemonId) => h.deps.connReg.get(daemonId),
    send: (daemonId, request, orgId) =>
      new ControlSender(h.deps.connReg, new PgLaunchRepo(prisma)).followUpWake(daemonId, orgId, request),
    broadcast: (watch) => relayed.push(watch),
    log: { debug: () => {}, warn: () => {} }
  })
  h.deps.followUpWatch = service
  return { h, service, relayed }
}

async function ready(h: WsHarness, daemonId: string, features: string[]) {
  const token = await h.mintToken(daemonId)
  const stub = new InMemoryDaemonStub()
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return { stub, serverFeatures: ok.payload.serverFeatures ?? [] }
}

async function answerTo(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const reply = stub.sent.find((f) => f.corr === id && f.type === 'assistant/follow-up-watch/result')
  const error = stub.sent.find((f) => f.corr === id && f.type === 'error')
  return {
    reply: reply && isFrame('assistant/follow-up-watch/result')(reply) ? reply.payload : undefined,
    error: error && isFrame('error')(error) ? error.payload : undefined
  }
}

describe('assistant/follow-up-watch over the daemon WS edge', () => {
  it('takes a watch from a serving daemon and delivers its wake there', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { h, service, relayed } = harness()
    const { stub, serverFeatures } = await ready(h, DAEMON, [FOLLOW_UP_WAKE_FEATURE])
    expect(serverFeatures).toContain(FOLLOW_UP_WATCH_FEATURE)

    const { reply, error } = await answerTo(
      stub,
      stub.inject('assistant/follow-up-watch', {
        agentId: AGENT,
        mode: 'set',
        watches: [{ followUpId: 'item-1', target: TARGET }]
      })
    )
    expect(error).toBeUndefined()
    expect(reply).toEqual({
      results: [
        {
          followUpId: 'item-1',
          watched: { provider: 'github', repoPath: TARGET.repoPath, subject: 'pull', number: 12, repoId: '456' }
        }
      ]
    })
    expect(relayed).toEqual([expect.objectContaining({ repoId: '456', number: 12, watched: true })])

    await service.receive({
      object: {
        orgId: OrgId(DEFAULT_ORG_ID),
        provider: 'github',
        bindingId: '',
        repoId: 456n,
        subject: 'pull',
        number: 12
      },
      deliveryKey: 'delivery-1',
      kind: 'merged',
      feedback: false
    })
    h.clock.advance(STATE_QUIET_MS)
    service.start()
    h.clock.advance(0)
    const wake = await stub.expectFrame('assistant/follow-up-wake')
    expect(wake.payload).toMatchObject({ agentId: AGENT, followUpId: 'item-1', wakeId: 1, kinds: ['merged'] })
    stub.reply(wake.id, 'assistant/follow-up-wake/result', { accepted: true })
    await service.settle()
    service.stop()
    expect(await prisma.followUpWatch.findFirst({ where: { agentId: AGENT } })).toMatchObject({
      pendingKinds: [],
      lastWakeKinds: ['merged']
    })
  })

  it('refuses a daemon that does not advertise follow-up wakes', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { h } = harness()
    const { stub } = await ready(h, DAEMON, [])
    const { reply, error } = await answerTo(
      stub,
      stub.inject('assistant/follow-up-watch', {
        agentId: AGENT,
        mode: 'set',
        watches: [{ followUpId: 'item-1', target: TARGET }]
      })
    )
    expect(reply).toBeUndefined()
    expect(error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
  })

  it('refuses a daemon that does not serve the agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { h } = harness()
    const { stub } = await ready(h, OTHER_DAEMON, [FOLLOW_UP_WAKE_FEATURE])
    const { error } = await answerTo(
      stub,
      stub.inject('assistant/follow-up-watch', {
        agentId: AGENT,
        mode: 'set',
        watches: [{ followUpId: 'item-1', target: TARGET }]
      })
    )
    expect(error).toMatchObject({ code: 'SCOPE_DENIED' })
    expect(await prisma.followUpWatch.count()).toBe(0)
  })
})
