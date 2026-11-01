// Who a live turn reads for (assistant-mode.md §5.5): its sender, every message folded into it, and a sub-session's opener.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RdChatEvent, RdMsgWebchat } from '@agentconnect.md/protocol'
import { NOBODY } from '../src/assistant/place-access.js'
import { Daemon } from '../src/daemon.js'
import type { MessageAgentReq, SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'bot-a'
const INT = 'int-bot-a'
const DM = 'D0ALICE'
const ALICE = { kind: 'member', platform: 'slack', integrationId: INT, userId: 'U0ALICE' }

function scaffold(integrations: unknown[], extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-askers-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // An ordinary session delegates only with the Auto switch off (auto-session-mode.md §5.1).
      features: { autoSessionMode: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations,
      output: { mode: 'low' },
      ...extra
    })
  )
  return root
}

/** A runtime whose every prompt hangs until released, so a turn stays live; it can take a steer. */
function hangingHost() {
  const releases: (() => void)[] = []
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${randomUUID()}`),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return 'end_turn'
    }),
    cancel: vi.fn(async () => releases.shift()?.()),
    stop: vi.fn(async () => {}),
    steeringSupported: vi.fn(() => true),
    steer: vi.fn(async () => 'injected')
  }
  return { host, releaseAll: () => releases.splice(0).forEach((release) => release()) }
}

describe('a Slack turn, the sub-sessions it opens, checks, tasks and schedules', () => {
  it("reads for the turn's sender, a sub-session's opener, an item's asker and a schedule's person", async () => {
    const root = scaffold(
      [
        {
          id: INT,
          platform: 'slack',
          core: { bindRules: [{ match: { kind: 'mention' } }], sessionModes: [{ channel: DM, mode: 'append' }] },
          config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
        }
      ],
      { assistantMode: { enabled: true } }
    )
    const rt = hangingHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => rt.host as any })
    await daemon.start()
    const d = daemon as any
    try {
      const placement = { agentId: AGENT, daemonId: 'local-daemon', name: AGENT }
      d.cpCollab.replace({
        generation: 0,
        channels: [{ orgId: 'org-a', platform: 'slack', channelId: DM, agents: [placement] }],
        agents: [{ ...placement, orgId: 'org-a' }]
      })
      const scope: string = d.transportScopeForIntegrationIds([INT])
      const coordinate: string = await d.store.resolveAppendCoordinate(AGENT, DM, scope, 1)
      const key = sessionKey('slack', DM, coordinate, AGENT, scope)
      const ctx: SessionContext = {
        agentId: AGENT,
        platform: 'slack',
        integrationId: INT,
        transportScope: scope,
        isDm: true,
        channel: DM,
        thread: coordinate,
        deliveryThread: '1700000000.000100',
        tools: []
      }
      expect(await d.readAskersFor(ctx)).toEqual(NOBODY)

      const msg: NormalizedMessage = {
        msgId: `slack:${DM}:1700000000.000101`,
        traceId: randomUUID(),
        source: 'user',
        platform: 'slack',
        channel: DM,
        thread: '1700000000.000101',
        sessionThread: coordinate,
        transportScope: scope,
        sender: { id: 'U0ALICE', isBot: false, name: 'Alice' },
        text: 'look into it in the background',
        mentionedBots: [],
        isDm: true
      }
      void d.dispatch(AGENT, msg, INT)
      await vi.waitFor(() => expect(d.activeGateEntries.get(key)?.msg.traceId).toBe(msg.traceId), WAIT)
      await vi.waitFor(async () => expect((await d.store.getSession(key))?.sessionId).toBeTruthy(), WAIT)
      expect(await d.readAskersFor(ctx)).toEqual({ people: [ALICE], nobody: false })

      const req: MessageAgentReq = {
        callerAgentId: AGENT,
        platform: 'slack',
        callerChannel: DM,
        callerThread: coordinate,
        callerTransportScope: scope,
        toAgentId: AGENT,
        text: 'write the release notes',
        channel: DM,
        thread: '1700000000.000100',
        postless: true
      }
      const opened = await d.collab.messageAgent(req)
      expect(opened).toMatchObject({ delivered: true, subsession: true })
      // The live entry can land before the session row does, so wait for both.
      const child = await vi.waitFor(async () => {
        expect(d.activeGateEntries.get(opened.targetSession)).toBeDefined()
        const rec = await d.store.getSession(opened.targetSession)
        expect(rec).toBeDefined()
        return rec
      }, WAIT)
      const childCtx: SessionContext = { ...ctx, thread: child.thread }
      // The delegation itself is the agent's message; the sub-session reads for Alice, who opened it.
      expect(d.activeGateEntries.get(opened.targetSession).msg.source).toBe('agent')
      expect(await d.readAskersFor(childCtx)).toEqual({ people: [ALICE], nobody: false })
      // Its own task reads for Alice too, though the task's turn was the agent's message (auto-session-mode.md §6.3).
      const nested = await d.collab.messageAgent({ ...req, callerThread: child.thread, text: 'check the changelog' })
      expect(nested).toMatchObject({ delivered: true, subsession: true })
      const grandchild = await vi.waitFor(async () => {
        const rec = await d.store.getSession(nested.targetSession)
        expect(rec).toBeDefined()
        return rec
      }, WAIT)
      expect(d.subsessionOpeners.get(nested.targetSession)).toEqual({ people: [ALICE], nobody: false })
      await vi.waitFor(
        async () =>
          expect(await d.readAskersFor({ ...ctx, thread: grandchild.thread })).toEqual({
            people: [ALICE],
            nobody: false
          }),
        WAIT
      )
      // A restart forgets the opener, and the sub-session then reads for nobody.
      d.subsessionOpeners.clear()
      expect(await d.readAskersFor(childCtx)).toEqual(NOBODY)

      // A follow-up's check and an approved proposal read as the person who confirmed the follow-up.
      const tenant = await d.tenantScopeForIntegration(d.integrationConfigById(INT))
      const origin = { platform: 'slack', channel: DM, transportScope: scope }
      const item = await d.store.assistantWatchTasks.open({
        agentId: AGENT,
        title: 'ship the release notes',
        origin,
        taskKey: sessionKey('slack', DM, 'subsession:check-r1', AGENT, scope),
        owner: { sessionId: 'sid-owner', key: sessionKey('slack', DM, 'append:1', AGENT, scope) },
        asker: `slack:${tenant}:U0ALICE`
      })
      const agentMsg = { ...msg, source: 'agent', sender: { id: AGENT, isBot: true } }
      for (const thread of ['subsession:check-r1', 'subsession:task-r1']) {
        d.activeGateEntries.set(sessionKey('slack', DM, thread, AGENT, scope), { msg: agentMsg, integrationId: INT })
      }
      vi.spyOn(d.store.assistantDrafts, 'taskBySubsession').mockResolvedValue({ proposal: { itemId: item.taskKey } })
      expect(await d.readAskersFor({ ...ctx, thread: 'subsession:check-r1' })).toEqual({
        people: [ALICE],
        nobody: false
      })
      expect(await d.readAskersFor({ ...ctx, thread: 'subsession:task-r1' })).toEqual({
        people: [ALICE],
        nobody: false
      })
      // A check a message started also reads as the people behind that message.
      const BOB = { kind: 'member', platform: 'slack', integrationId: INT, userId: 'U0BOB' }
      vi.spyOn(d.followUpChecks, 'askersFor').mockResolvedValue({ item, extra: { people: [BOB], nobody: false } })
      expect(await d.readAskersFor({ ...ctx, thread: 'subsession:check-r1' })).toEqual({
        people: [ALICE, BOB],
        nobody: false
      })
      vi.spyOn(d.followUpChecks, 'askersFor').mockResolvedValue({ extra: { people: [], nobody: false } })
      expect(await d.readAskersFor({ ...ctx, thread: 'subsession:check-r1' })).toEqual(NOBODY)

      // A schedule's run reads as the console user its row records, and as nobody without one.
      const cronId = randomUUID()
      const upsert = {
        cronId,
        agentId: AGENT,
        schedule: '0 9 * * 1-5',
        timezone: 'UTC',
        trigger: 'report',
        enabled: true
      }
      d.cpCrons.upsert({ ...upsert, askerUserId: 'user-editor' })
      const cronKey = sessionKey('slack', DM, 'cron-thread', AGENT, scope)
      d.activeGateEntries.set(cronKey, {
        msg: {
          ...msg,
          source: 'cron',
          sender: { id: AGENT, isBot: true },
          cronRun: { cronId, firedAt: '2026-10-12T09:00:00.000Z' }
        },
        integrationId: INT
      })
      const cronCtx = { ...ctx, thread: 'cron-thread' }
      expect(await d.readAskersFor(cronCtx)).toEqual({
        people: [{ kind: 'console', userId: 'user-editor' }],
        nobody: false
      })
      d.cpCrons.upsert(upsert)
      expect(await d.readAskersFor(cronCtx)).toEqual(NOBODY)
      // The stand-in live entries are not turns, so shutdown must not try to cancel them.
      for (const thread of ['subsession:check-r1', 'subsession:task-r1', 'cron-thread']) {
        d.activeGateEntries.delete(sessionKey('slack', DM, thread, AGENT, scope))
      }
    } finally {
      rt.releaseAll()
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a message steered into a live webchat turn', () => {
  it('joins the people the turn reads for before the runtime sees it', async () => {
    const CONV = '88888888-8888-4888-8888-888888888888'
    const root = scaffold([])
    const rt = hangingHost()
    const daemon = new Daemon({ root, hostFactory: () => rt.host as any })
    await daemon.start()
    const d = daemon as any
    d.cpClient = {
      emitUsageReport: vi.fn(),
      emitSessionActivity: vi.fn(),
      organizationScope: () => 'connection' as const,
      stop: vi.fn(async () => {})
    }
    d.relays = { stop: vi.fn(async () => {}), sendWebchatPost: vi.fn() }
    const rd = (payload: RdMsgWebchat['payload'], msgId: string): RdMsgWebchat => ({
      source: 'webchat',
      agentId: AGENT,
      sessionKey: CONV,
      msgId,
      chatId: CONV,
      payload
    })
    try {
      const events: RdChatEvent[] = []
      const turn = '77777777-7777-4777-8777-777777777777'
      await d.handleRelayMsg(
        rd(
          {
            op: 'turn',
            text: 'plan the launch',
            user: 'Owner',
            userId: 'user-owner',
            turnId: turn,
            post: { postId: turn, at: 1_000 }
          },
          'm-1'
        ),
        (event: RdChatEvent) => events.push(event)
      )
      await vi.waitFor(() => expect(rt.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      const [key] = [...d.activeGateEntries.keys()] as string[]
      expect(d.askersOfKey(key, undefined)).toEqual({
        people: [{ kind: 'console', userId: 'user-owner' }],
        nobody: false
      })

      let seenAtSteer: unknown
      rt.host.steer.mockImplementationOnce(async () => {
        seenAtSteer = d.askersOfKey(key, undefined)
        return 'injected'
      })
      const steer = '66666666-6666-4666-8666-666666666666'
      const ack = await d.handleRelayMsg(
        rd(
          {
            op: 'turn',
            text: 'use the staging database',
            user: 'Guest',
            userId: 'user-guest',
            turnId: steer,
            post: { postId: steer, at: 2_000 },
            steer: true
          },
          'm-2'
        ),
        () => {}
      )
      expect(ack).toMatchObject({ steered: true })
      const both = {
        people: [
          { kind: 'console', userId: 'user-owner' },
          { kind: 'console', userId: 'user-guest' }
        ],
        nobody: false
      }
      expect(seenAtSteer).toEqual(both)
      expect(d.askersOfKey(key, undefined)).toEqual(both)
    } finally {
      rt.releaseAll()
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
