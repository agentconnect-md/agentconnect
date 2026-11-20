// Email through the daemon (email-integration.md §4, §5.5, §5.6, §8): the strict verdicts a relayed mail gets, its record and its session's classification.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMAIL_MEMBERS_V1_FEATURE, EMAIL_V1_FEATURE, type WireEmailAdapterExt } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'

const AGENT = 'mail-bot'
const INTEGRATION = 'int-email'
const BOT = '8f0a1c62-9a0f-4c6e-8b2b-7d3f5a1c0002'
const ADDRESS = 'helper@mail.example.test'
const ALICE = 'alice@corp.example.test'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-email-ingress-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      displayName: 'Mail Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'email',
          core: { mode: 'shared', bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'mention' } }] },
          config: { address: ADDRESS, egress: 'relay', botId: BOT }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

async function boot(members: ((addresses: string[]) => { address: string; consoleUserId: string }[]) | undefined) {
  const daemon = new Daemon({ root: scaffold(), hostFactory: () => fakeHost() as any })
  await daemon.start()
  await (daemon as any).connections.reconcileEmailConnections()
  ;(daemon as any).cpClient = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === 'supportsServerFeature')
        return (feature: string) => feature === EMAIL_MEMBERS_V1_FEATURE && !!members
      if (prop === 'emailMembers')
        return async ({ addresses }: { addresses: string[] }) => ({ members: members!(addresses) })
      return () => undefined
    }
  })
  const turns: Promise<unknown>[] = []
  const realDispatch = (daemon as any).dispatch.bind(daemon)
  ;(daemon as any).dispatch = (...args: unknown[]) => {
    const settled = realDispatch(...args)
    turns.push(Promise.resolve(settled).catch(() => undefined))
    return settled
  }
  return { daemon, store: (daemon as any).store, settled: async () => void (await Promise.all(turns)) }
}

function delivery(ext: Partial<WireEmailAdapterExt> = {}) {
  const email: WireEmailAdapterExt = {
    from: { address: ALICE, name: 'Alice' },
    to: [{ address: ADDRESS }],
    cc: [],
    subject: 'Numbers',
    messageId: 'm1@corp.example.test',
    references: [],
    attachments: [],
    ticket: 'e1.bTE.1700000000000.bWFj',
    ...ext
  }
  const msgId = `email:${ADDRESS}:${email.messageId}`
  return {
    source: 'im' as const,
    agentId: AGENT,
    botId: BOT,
    integrationId: INTEGRATION,
    sessionKey: `dm:${ALICE}`,
    msgId,
    payload: {
      msgId,
      traceId: msgId,
      source: 'user' as const,
      platform: 'email',
      channel: `dm:${ALICE}`,
      thread: email.messageId,
      sender: { id: ALICE, isBot: false, name: 'Alice' },
      text: 'Can you sum these?',
      mentionedBots: [],
      isDm: true,
      trigger: 'dm' as const,
      adapterExt: { email }
    }
  }
}

const im = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayIm(msg)
const allow = (addresses: string[]) =>
  addresses.filter((a) => a === ALICE).map((address) => ({ address, consoleUserId: 'user-alice' }))

describe('a relayed mail through the daemon', () => {
  it('advertises the platform and its feature', async () => {
    const { daemon } = await boot(allow)
    expect((daemon as any).registrationPlatforms()).toContain('email')
    expect((daemon as any).platformModules.registrationFeatures()).toContain(EMAIL_V1_FEATURE)
    await daemon.stop()
  })

  it('admits a member’s mail, records what the agent reads, indexes it, and classifies its session', async () => {
    const { daemon, store, settled } = await boot(allow)
    const ack = await im(daemon, delivery())
    expect(ack).toEqual({ msgId: `email:${ADDRESS}:m1@corp.example.test`, accepted: true, routeAdmission: 'admitted' })
    await settled()
    const indexed = await store.emailMessages.get(ADDRESS, 'm1@corp.example.test')
    expect(indexed).toMatchObject({
      thread: 'm1@corp.example.test',
      conversation: `dm:${ALICE}`,
      direction: 'received'
    })
    const scope = (daemon as any).transportScopeForIntegrationIds([INTEGRATION])
    const rows = await store.admittedTextRowsByTs(AGENT, transcriptChannelKey(`dm:${ALICE}`, scope), [indexed.ts])
    expect(rows[0].text).toBe(`From: Alice <${ALICE}>\nTo: ${ADDRESS}\nSubject: Numbers\n\nCan you sum these?`)
    const session = (await store.listSessions(AGENT)).find((s: { platform: string }) => s.platform === 'email')
    expect(session).toMatchObject({ conversationKind: 'dm', triggeredBy: ALICE, channel: `dm:${ALICE}` })
    expect(session.tenantScope).toBe('mail.example.test')
    // A redelivery is settled from its receipt and runs no second turn.
    expect((await im(daemon, delivery())).routeAdmission).toBe('admitted')
    await daemon.stop()
  })

  it('rejects a sender who is not a member for good, and has a mail retried while the question cannot be asked', async () => {
    const refused = await boot(() => [])
    expect(await im(refused.daemon, delivery())).toMatchObject({
      routeAdmission: 'rejected',
      recoverable: false,
      reason: 'rejected'
    })
    expect(await refused.store.emailMessages.get(ADDRESS, 'm1@corp.example.test')).toBeUndefined()
    await refused.daemon.stop()
    const offline = await boot(undefined)
    expect(await im(offline.daemon, delivery())).toMatchObject({ routeAdmission: 'rejected', recoverable: true })
    await offline.daemon.stop()
  })
})
