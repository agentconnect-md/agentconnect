// Assistant-mode self-delegation (assistant-mode.md §5.6): a postless self wake opens a background sub-session, for assistant-mode agents only.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionThreadUrlFor } from '../src/platforms/session-links.js'
import { sessionKey } from '../src/store/local-store.js'
import * as monotonic from '../src/store/monotonic-ts.js'
import { isSubsessionCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true, responsibleUserId: 'user-1' }

/** One Slack agent per entry; `C1` appends for every listed agent unless `append` is false. */
function scaffold(
  agents: {
    id: string
    assistantMode?: { enabled: boolean; responsibleUserId?: string }
    append?: boolean
    callPolicy?: 'all' | 'selected'
    outboundPolicy?: 'all' | 'selected'
  }[]
): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-selfdel-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const a of agents) {
    const adir = join(root, 'agents', a.id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: a.id,
        name: a.id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${a.id}`,
            platform: 'slack',
            core: {
              bindRules: [{ match: { kind: 'mention' } }],
              ...(a.append === false ? {} : { sessionModes: [{ channel: 'C1', mode: 'append' }] })
            },
            config: { botToken: `xoxb-${a.id}`, appToken: `xapp-${a.id}` }
          }
        ],
        output: { mode: 'low' },
        ...(a.assistantMode ? { assistantMode: a.assistantMode } : {}),
        ...(a.callPolicy ? { callPolicy: a.callPolicy, allowedCallerAgentIds: [] } : {}),
        ...(a.outboundPolicy ? { outboundPolicy: a.outboundPolicy, allowedTargetAgentIds: [] } : {})
      })
    )
  }
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

async function boot(root: string, opts: { spy?: boolean } = {}) {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost() as any })
  await daemon.start()
  const d = daemon as any
  const placements = [...d.agents.values()].map((agent: any) => ({
    agentId: agent.id,
    daemonId: 'local-daemon',
    name: agent.name,
    callPolicy: agent.callPolicy,
    allowedCallerAgentIds: agent.allowedCallerAgentIds,
    outboundPolicy: agent.outboundPolicy,
    allowedTargetAgentIds: agent.allowedTargetAgentIds
  }))
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: placements }],
    agents: placements.map((placement) => ({ ...placement, orgId: TEST_ORG }))
  })
  const calls: { agentId: string; msg: any; integrationId?: string; webchat?: any; callMeta?: any }[] = []
  if (opts.spy !== false) {
    d.dispatch = vi.fn(
      async (agentId: string, msg: any, integrationId?: string, webchat?: any, callMeta?: any, o?: any) => {
        calls.push({ agentId, msg, integrationId, webchat, callMeta })
        o?.onAdmission?.({ accepted: true })
        return 'acp-1'
      }
    )
  }
  const call = (req: MessageAgentReq) => d.collab.messageAgent(req) as Promise<any>
  return { daemon, d, calls, call }
}

const scopeOf = (d: any, integrationId: string): string => d.transportScopeForIntegrationIds([integrationId])

/** The caller in the middle of a turn of its append session in C1, which the delegation takes as its parent. */
async function seedCaller(d: any, agentId = 'bot-a') {
  const scope = scopeOf(d, `int-${agentId}`)
  const coordinate = await d.store.resolveAppendCoordinate(agentId, 'C1', scope, 1)
  const key = sessionKey('slack', 'C1', coordinate, agentId, scope)
  await d.store.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: coordinate,
    transportScope: scope,
    acpSessionId: 'acp-parent-1',
    sessionId: 'sid-parent-1',
    state: 'prompting',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

const delegation = (
  caller: { scope: string; coordinate: string },
  over: Partial<MessageAgentReq> = {}
): MessageAgentReq => ({
  callerAgentId: 'bot-a',
  platform: 'slack',
  callerChannel: 'C1',
  callerThread: caller.coordinate,
  callerTransportScope: caller.scope,
  toAgentId: 'bot-a',
  text: 'fix the flaky test and open a PR',
  channel: 'C1',
  thread: '100.1',
  postless: true,
  ...over
})

describe('self-delegation: an assistant-mode agent opens a sub-session', () => {
  it('opens a headless sub-session on its own coordinate, never the caller’s or the append session', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const spy = vi.spyOn(monotonic, 'monotonicTs').mockReturnValue('999000111')

    expect(d.collab.wakeRejectionReason(delegation(caller))).toBeNull()
    const res = await call(delegation(caller))
    spy.mockRestore()

    const child = sessionKey('slack', 'C1', subsessionCoordinate('999000111'), 'bot-a', caller.scope)
    expect(res).toEqual({ delivered: true, targetSession: child, subsession: true })
    expect(child).not.toBe(caller.key)
    expect(await d.store.currentAppendCoordinate('bot-a', 'C1', caller.scope)).toBe(caller.coordinate)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe('bot-a')
    expect(calls[0]!.webchat).toBeUndefined()
    expect(calls[0]!.msg).toMatchObject({
      channel: 'C1',
      thread: 'subsession:999000111',
      transportScope: caller.scope,
      headless: true,
      sender: { id: 'bot-a', isBot: true },
      text: 'From your own main conversation, as a background sub-session: fix the flaky test and open a PR'
    })
    expect(calls[0]!.msg.sessionThread).toBeUndefined()
    expect(isSubsessionCoordinate(calls[0]!.msg.thread)).toBe(true)
    await daemon.stop()
  })

  it('reports back without being asked to, and records the parent in the persistent index', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const res = await call(delegation(caller))

    expect(calls[0]!.callMeta).toMatchObject({
      callFrom: 'bot-a',
      hopCount: 0,
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: caller.coordinate },
      needsReply: true
    })
    expect(d.collab.childSessionLinks.get(res.targetSession)).toMatchObject({
      parentSessionId: 'sid-parent-1',
      agentId: 'bot-a',
      replyRequested: true,
      replyState: 'awaiting'
    })
    expect(await d.store.assistantSubsessions.get('bot-a', res.targetSession)).toMatchObject({
      childSessionKey: res.targetSession,
      parentSessionId: 'sid-parent-1',
      parentSessionKey: caller.key,
      state: 'open'
    })
    await daemon.stop()
  })

  it('inherits the parent’s audience through the agent-to-agent path', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const externalOrigin = { provider: 'slack', resourceKind: 'conversation', resourceKey: 'T0EXAMPLE:C1' }
    const origin = vi.spyOn(d, 'externalOriginForSession').mockResolvedValue(externalOrigin)

    // A caller session with no capture-gate row reads as excluded, so the child is sealed.
    await call(delegation(caller))
    await d.store.setLocalCaptureGate('bot-a', caller.key, false)
    await call(delegation(caller))

    expect(origin).toHaveBeenCalledWith('bot-a', caller.key)
    expect(calls[0]!.callMeta).toMatchObject({ originSessionId: 'sid-parent-1', parentPrivate: true, externalOrigin })
    expect(calls[1]!.callMeta).not.toHaveProperty('parentPrivate')
    for (const { callMeta } of calls) expect(callMeta).not.toHaveProperty('platformOrigin')
    expect(calls[0]!.msg.thread).not.toBe(calls[1]!.msg.thread)
    await daemon.stop()
  })

  it('skips the call policies and the directory edge, but still applies coordinate integrity', async () => {
    const root = scaffold([{ id: 'bot-a', assistantMode: ON, callPolicy: 'selected', outboundPolicy: 'selected' }])
    const { daemon, d, calls, call } = await boot(root)
    const caller = await seedCaller(d)
    const admits = vi.spyOn(d.cpCollab, 'admits').mockReturnValue(false)

    expect(d.collab.wakeRejectionReason(delegation(caller))).toBeNull()
    expect(await call(delegation(caller))).toMatchObject({ delivered: true, subsession: true })
    // A chat channel the directory does not know is refused, as for any wake.
    const ghost = delegation(caller, { channel: 'C_GHOST' })
    expect(d.collab.wakeRejectionReason(ghost)).toBe('not_allowed')
    expect(await call(ghost)).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(1)
    admits.mockRestore()
    await daemon.stop()
  })

  it('is never a reply: a parent woken by its own report delegates without inheriting correlation', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    d.activeTurnCallMeta.set(caller.key, { callFrom: 'bot-a', correlationId: 'corr-1', hopCount: 3, deliveryId: 'd0' })

    await call(delegation(caller))

    expect(calls[0]!.callMeta.hopCount).toBe(4)
    expect(calls[0]!.callMeta).not.toHaveProperty('correlationId')
    // The hop cap still bounds the chain.
    d.activeTurnCallMeta.set(caller.key, { callFrom: 'bot-a', hopCount: MAX_AGENT_CALL_HOPS - 1, deliveryId: 'd1' })
    expect(d.collab.wakeRejectionReason(delegation(caller))).toBe('hop_limit')
    expect(await call(delegation(caller))).toMatchObject({ delivered: false, reason: 'hop_limit' })
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })
})

describe('self-delegation: what stays refused', () => {
  it('refuses a sub-session’s own delegation in the preflight and at admission', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const opened = await call(delegation(caller))
    const nested = delegation(caller, { callerThread: subsessionCoordinate('999000111') })
    await d.store.upsertSession({
      key: sessionKey('slack', 'C1', nested.callerThread, 'bot-a', caller.scope),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: nested.callerThread,
      transportScope: caller.scope,
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    expect(d.collab.wakeRejectionReason(nested)).toBe('subsession_nesting')
    const res = await call(nested)
    expect(res).toMatchObject({ delivered: false, reason: 'subsession_nesting' })
    expect(res.message).toMatch(/cannot open another sub-session/)
    expect(calls).toHaveLength(1)
    expect(opened.subsession).toBe(true)
    await daemon.stop()
  })

  it('refuses a delegation with no parent session to inherit from', async () => {
    const { daemon, d, calls, call } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const scope = scopeOf(d, 'int-bot-a')
    const res = await call(delegation({ scope, coordinate: 'append:1' }))
    expect(res).toMatchObject({ delivered: false, reason: 'no_parent_session' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it.each([
    ['assistant mode off', { enabled: false }],
    ['no assistant mode', undefined]
  ])('still refuses a postless self wake as self with %s', async (_label, assistantMode) => {
    const { daemon, d, calls, call } = await boot(
      scaffold([{ id: 'bot-a', ...(assistantMode ? { assistantMode } : {}) }])
    )
    const caller = await seedCaller(d)
    const req = delegation(caller)
    expect(d.collab.wakeRejectionReason(req)).toBe('self')
    expect(await call(req)).toEqual({
      delivered: false,
      targetSession: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      reason: 'self'
    })
    expect(calls).toHaveLength(0)
    expect(await d.store.assistantSubsessions.get('bot-a', caller.key)).toBeUndefined()
    await daemon.stop()
  })

  it('leaves an assistant-mode agent’s channel-root self wake and its peer wakes as they were', async () => {
    const root = scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }])
    const { daemon, d, calls, call } = await boot(root)
    const caller = await seedCaller(d)

    const channelRoot = await call(
      delegation(caller, {
        postless: undefined,
        thread: '200.2',
        transcriptTs: '200.2',
        agentCallDeliveryId: 'paired-self-1'
      })
    )
    // Pinned as today: the paired channel-root self wake lands on the caller's own append session.
    expect(channelRoot).toEqual({ delivered: true, targetSession: caller.key })
    const peer = await call(delegation(caller, { toAgentId: 'bot-b' }))
    const peerScope = scopeOf(d, 'int-bot-b')
    expect(peer).toEqual({
      delivered: true,
      targetSession: sessionKey(
        'slack',
        'C1',
        await d.store.currentAppendCoordinate('bot-b', 'C1', peerScope),
        'bot-b',
        peerScope
      )
    })
    expect(calls.map((c) => c.callMeta.needsReply)).toEqual([undefined, undefined])
    expect(calls.map((c) => isSubsessionCoordinate(c.msg.thread))).toEqual([false, false])
    expect(d.collab.childSessionLinks.get(peer.targetSession)?.replyRequested).toBe(false)
    expect(await d.store.assistantSubsessions.get('bot-a', caller.key)).toBeUndefined()
    await daemon.stop()
  })
})

describe('self-delegation: through the sendMessage tool', () => {
  const ctx = (caller: { scope: string; coordinate: string }, thread = caller.coordinate) => ({
    agentId: 'bot-a',
    platform: 'slack',
    integrationId: 'int-bot-a',
    transportScope: caller.scope,
    isDm: false,
    channel: 'C1',
    thread,
    deliveryThread: '100.1',
    tools: [],
    integrations: [{ id: 'int-bot-a', platform: 'slack' }]
  })

  it('tells the caller the sub-session started and that it reports back, and refuses one from inside it', async () => {
    const { daemon, d, calls } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const postMessage = vi.fn(async () => '100.250000')
    d.connByIntegration.set('int-bot-a', { postMessage })
    const deps = { ...d.mcp.deps, canRun: () => true }

    const started = (await executeTool(
      ctx(caller),
      'sendMessage',
      { toAgent: 'bot-a', message: 'fix it' },
      deps
    )) as any
    expect(started).toMatchObject({
      ok: true,
      wake: { delivered: true, subsession: true },
      reply: { requested: true, state: 'awaiting' },
      nextAction: 'finish-turn-and-wait'
    })
    expect(started.childSessionId).toBe(started.wake.targetSession)
    expect(started.message).toMatch(/Sub-session started in the background/)
    expect(started.post).toBeUndefined()

    const inside = ctx(caller, subsessionCoordinate('1'))
    const nested = (await executeTool(inside, 'sendMessage', { toAgent: 'bot-a', message: 'and this' }, deps)) as any
    expect(nested.wake).toMatchObject({ delivered: false, reason: 'subsession_nesting' })
    expect(nested.childSessionId).toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })
})

describe('self-delegation: through the turn engine', () => {
  it('runs the sub-session as a lineage child that reports back into its parent, never posting', async () => {
    const { daemon, d } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: false })
    const caller = await seedCaller(d)
    const postMessage = vi.fn(async () => '100.250000')
    d.connByIntegration.set('int-bot-a', { postMessage })
    const real = d.dispatch.bind(d)
    const dispatched: { msg: NormalizedMessage; callMeta?: any }[] = []
    d.dispatch = (
      agentId: string,
      msg: NormalizedMessage,
      integrationId?: string,
      webchat?: any,
      callMeta?: any,
      ...rest: any[]
    ) => {
      dispatched.push({ msg, callMeta })
      return real(agentId, msg, integrationId, webchat, callMeta, ...rest)
    }

    const res = await d.collab.messageAgent(delegation(caller))
    // The child's turn ends without a report of its own, so the daemon infers one into the parent.
    await vi.waitFor(() => expect(dispatched.some((c) => c.msg.parentReport === true)).toBe(true), WAIT)

    const child = await d.store.getSession(res.targetSession)
    expect(child).toMatchObject({
      agentId: 'bot-a',
      channel: 'C1',
      thread: dispatched[0]!.msg.thread,
      originSessionId: 'sid-parent-1',
      needsParentReply: 1
    })
    expect(await d.store.getSessionClassificationByKey(res.targetSession)).not.toHaveProperty('directDestination')
    const report = dispatched.find((c) => c.msg.parentReport === true)!
    expect(report.msg).toMatchObject({ channel: 'C1', sessionThread: caller.coordinate, source: 'agent' })
    expect(report.callMeta).toMatchObject({ callFrom: 'bot-a', originSessionId: child.sessionId })
    // Neither the sub-session nor the resumed parent, whose runtime said nothing, posted anywhere.
    expect(postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })
})

describe('a sub-session never speaks on the platform', () => {
  it('stamps every turn dispatched into a sub-session headless, and no other', async () => {
    const { daemon, d } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON, append: false }]), { spy: false })
    const scope = scopeOf(d, 'int-bot-a')
    const message = (thread: string): NormalizedMessage => ({
      msgId: `bgtask:C1:${thread}`,
      traceId: `bgtask:${thread}`,
      transcriptTs: monotonic.monotonicTs(),
      source: 'agent',
      platform: 'slack',
      channel: 'C1',
      thread,
      transportScope: scope,
      sender: { id: 'background-task:t1', isBot: true },
      text: '[background task finished] build',
      mentionedBots: [],
      isDm: false
    })
    const sub = message(subsessionCoordinate('999000111'))
    const plain = message('100.1')
    const turns = [d.dispatch('bot-a', sub, 'int-bot-a'), d.dispatch('bot-a', plain, 'int-bot-a')]
    // Stamped before anything is persisted or admitted.
    expect(sub.headless).toBe(true)
    expect(plain).not.toHaveProperty('headless')
    await Promise.allSettled(turns)
    await daemon.stop()
  })

  it('links no platform thread for a sub-session', async () => {
    const connection = { workspaceUrl: 'https://example.slack.test/' }
    expect(
      sessionThreadUrlFor({ platform: 'slack', channel: 'C1', thread: subsessionCoordinate('1') }, connection)
    ).toBeUndefined()
    expect(sessionThreadUrlFor({ platform: 'slack', channel: 'C1', thread: '100.1' }, connection)).toMatch(/C1/)
  })
})
