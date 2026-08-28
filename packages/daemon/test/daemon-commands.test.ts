import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SLACK_STATUS_ACTION,
  decodeSharedSlackStatusTarget,
  decodeSlackStatusOverflowValue,
  type RdMsgIm,
  type RdMsgPlatformAction
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { LocalStore, sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { statePath } from '../src/paths.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

const AGENT_IDENTITY = {
  displayName: 'Review Bot',
  iconUrl: 'https://console.example.test/icons/bot-a'
}
const STATUS_BAR_POST_OPTIONS = {
  username: AGENT_IDENTITY.displayName,
  icon_url: AGENT_IDENTITY.iconUrl,
  chrome: true,
  chromeOwnerAgentId: 'bot-a'
}
const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`
const SESSION_KEY = sessionKey('slack', 'C1', 'T1', 'bot-a', TRANSPORT_SCOPE)
const SHARED_TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0b').digest('hex').slice(0, 24)}`
const SHARED_SESSION_KEY = sessionKey('slack', 'C1', 'T1', 'bot-a', SHARED_TRANSPORT_SCOPE)
const LOOP_SCOPE = `slack:C1:dm:${TRANSPORT_SCOPE}`

function hasPending(daemon: Daemon, acpSessionId: string): boolean {
  return [...(daemon as any).pending.values()].some(
    (pending: any) => pending.plan.agentId === 'bot-a' && pending.acpSessionId === acpSessionId
  )
}

function scaffold(identity?: { displayName?: string; iconUrl?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cmd-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  // No integrations at boot → start() opens no real Slack socket; we attach a
  // routable DM rule + a fake connection by hand afterwards.
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      ...(identity?.displayName ? { displayName: identity.displayName } : {}),
      ...(identity?.iconUrl ? { iconUrl: identity.iconUrl } : {}),
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** A fake ACP host whose first prompt blocks until release() is called. */
function blockingHost() {
  let release!: () => void
  const firstBlocked = new Promise<void>((r) => {
    release = r
  })
  let calls = 0
  const prompts: string[] = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      prompts.push(blocks.map((b) => b.text).join('|'))
      if (++calls === 1) await firstBlocked
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return { host, prompts, release: () => release() }
}

/** Make bot-a routable for DMs + explicit @mention and wire a fake reply connection. */
function makeRoutable(daemon: Daemon) {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p', botUserId: 'UBOTA' }
    }
  ]
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn<(channel: string, text: string, threadTs?: string, options?: unknown) => Promise<void>>(
      async () => {}
    ),
    getChannelInfo: vi.fn(async (id: string) => ({ id })),
    getUserProfile: vi.fn(async (id: string) => ({ id }))
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

const dm = (ts: string, text: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  transportScope: TRANSPORT_SCOPE,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

describe('Daemon in-conversation commands', () => {
  it('!resume explicitly resets a durable loop guard; anonymous events cannot reset it', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const scope = LOOP_SCOPE
    await (daemon as any).store.tripLoopGuard(scope, 1, 'test_loop')

    await (daemon as any).onInboundOutcome({ ...dm('100', '!resume'), sender: { id: 'unknown', isBot: false } })
    expect(await (daemon as any).store.isLoopGuardOpen(scope)).toBe(true)
    expect(conn.postMessage).not.toHaveBeenCalled()

    await (daemon as any).onInboundOutcome(dm('200', '!resume'))
    expect(await (daemon as any).store.isLoopGuardOpen(scope)).toBe(false)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Resumed'), 'T1')
    expect(blocked.prompts).toHaveLength(0) // the control command never becomes a prompt
    await daemon.stop()
  })

  it('lets an authorized human recover a top-level loop latch from its ownerless warning thread', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    integration.core.bindRules = [{ match: { kind: 'mention' } }]
    const scope = 'slack:C-top:top-level'
    await (daemon as any).store.tripLoopGuard(scope, 1, 'automatic_turn_burst')
    expect(await (daemon as any).store.listSessions()).toHaveLength(0)

    const resume = (senderId: string) => ({
      msgId: `slack:C-top:resume-${senderId}`,
      traceId: `resume-${senderId}`,
      source: 'user' as const,
      platform: 'slack' as const,
      channel: 'C-top',
      // The rejected ninth top-level event posted its warning under this root,
      // but that event never created a session/thread owner.
      thread: '9',
      sender: { id: senderId, isBot: false },
      text: '!resume',
      mentionedBots: [] as string[],
      isDm: false,
      trigger: 'mention' as const
    })

    await (daemon as any).onInboundOutcome(resume('U1'))
    expect(await (daemon as any).store.isLoopGuardOpen(scope)).toBe(false)
    expect(conn.postMessage).toHaveBeenCalledWith('C-top', expect.stringContaining('Resumed'), '9')
    expect(blocked.prompts).toHaveLength(0)
    await daemon.stop()
  })

  it('shared-bot rd/msg(im) only lets a human reset the loop guard', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const scope = LOOP_SCOPE
    await (daemon as any).store.tripLoopGuard(scope, 1, 'test_loop')

    const relayResume = (msgId: string, sender: { id: string; isBot: boolean }): RdMsgIm => ({
      source: 'im',
      agentId: 'bot-a',
      sessionKey: scope,
      msgId,
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'C1',
      payload: { ...dm(msgId, '!resume'), sender }
    })

    // A bot-authored event cannot issue control commands.
    expect(await (daemon as any).handleRelayMsg(relayResume('relay-bot', { id: 'U1', isBot: true }), () => {})).toEqual(
      {
        msgId: 'relay-bot',
        accepted: false,
        reason: 'unauthorized'
      }
    )
    expect(await (daemon as any).store.isLoopGuardOpen(scope)).toBe(true)

    expect(
      await (daemon as any).handleRelayMsg(relayResume('relay-human', { id: 'U1', isBot: false }), () => {})
    ).toEqual({
      msgId: 'relay-human',
      accepted: true
    })
    expect(await (daemon as any).store.isLoopGuardOpen(scope)).toBe(false)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Resumed'), 'T1')
    expect(blocked.prompts).toHaveLength(0)
    await daemon.stop()
  })

  it('passes shared-bot rd/msg(im) through Slack name resolution before dispatch', async () => {
    const daemon = new Daemon()
    const conn = {}
    const noteMessage = vi.fn()
    const dispatch = vi.fn(async () => {})
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).connByIntegration.set('int-a', conn)
    ;(daemon as any).nameResolver = { noteMessage }
    ;(daemon as any).commands.isSessionMuted = () => false
    ;(daemon as any).dispatch = dispatch
    const payload = dm('relay-names', 'hello')
    const msg: RdMsgIm = {
      source: 'im',
      agentId: 'bot-a',
      sessionKey: 'slack:C1:dm',
      msgId: 'relay-names',
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'C1',
      payload
    }

    expect(await (daemon as any).handleRelayMsg(msg, () => {})).toEqual({ msgId: 'relay-names', accepted: true })
    expect(noteMessage).toHaveBeenCalledWith(conn, payload)
    expect(dispatch).toHaveBeenCalledWith('bot-a', payload, 'int-a')
  })

  it('stamps trigger=mention on relay im when the message mentions the integration bot', async () => {
    // Relay arbitration never populates the wire `trigger`; the daemon recomputes it
    // from the mention list + this integration's own bot identity (see handleRelayIm).
    const daemon = new Daemon()
    const dispatch = vi.fn(async () => {})
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).connByIntegration.set('int-a', { botUserId: 'U-SELF' })
    ;(daemon as any).commands.isSessionMuted = () => false
    ;(daemon as any).dispatch = dispatch
    const { trigger: _t, ...bare } = dm('relay-mention', '<@U-SELF> hello')
    const msg: RdMsgIm = {
      source: 'im',
      agentId: 'bot-a',
      sessionKey: 'slack:C1:dm',
      msgId: 'relay-mention',
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'C1',
      payload: { ...bare, mentionedBots: ['U-OTHER', 'U-SELF'] } as any
    }
    expect(await (daemon as any).handleRelayMsg(msg, () => {})).toEqual({ msgId: 'relay-mention', accepted: true })
    expect(dispatch).toHaveBeenCalledWith('bot-a', expect.objectContaining({ trigger: 'mention' }), 'int-a')
  })

  it('leaves trigger unset on relay im when the mention list does not name this bot', async () => {
    const daemon = new Daemon()
    const dispatch = vi.fn(async () => {})
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).connByIntegration.set('int-a', { botUserId: 'U-SELF' })
    ;(daemon as any).commands.isSessionMuted = () => false
    ;(daemon as any).dispatch = dispatch
    const { trigger: _t, ...bare } = dm('relay-no-mention', 'hello')
    const msg: RdMsgIm = {
      source: 'im',
      agentId: 'bot-a',
      sessionKey: 'slack:C1:dm',
      msgId: 'relay-no-mention',
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'C1',
      payload: { ...bare, mentionedBots: ['U-OTHER'] } as any
    }
    await (daemon as any).handleRelayMsg(msg, () => {})
    expect(dispatch).toHaveBeenCalledWith('bot-a', expect.not.objectContaining({ trigger: expect.anything() }), 'int-a')
  })

  it('an explicit mention un-mutes a !stop-muted relay session; anything else stays dropped', async () => {
    // Without the recomputed trigger the mute check can never see 'mention' on the
    // relay path — a !stop-muted agent in a shared channel would be dead forever.
    const daemon = new Daemon()
    const dispatch = vi.fn(async () => {})
    const setSessionMuted = vi.fn()
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).connByIntegration.set('int-a', { botUserId: 'U-SELF' })
    ;(daemon as any).commands.isSessionMuted = () => true
    ;(daemon as any).commands.setSessionMuted = setSessionMuted
    ;(daemon as any).recordUnrouted = vi.fn()
    ;(daemon as any).dispatch = dispatch
    const frame = (msgId: string, mentionedBots: string[]): RdMsgIm => {
      const { trigger: _t, ...bare } = dm(msgId, 'wake up')
      return {
        source: 'im',
        agentId: 'bot-a',
        sessionKey: 'slack:C1:dm',
        msgId,
        botId: '11111111-1111-4111-8111-111111111111',
        integrationId: 'int-a',
        chatId: 'C1',
        payload: { ...bare, mentionedBots } as any
      }
    }
    await (daemon as any).handleRelayMsg(frame('muted-plain', []), () => {})
    expect(dispatch).not.toHaveBeenCalled()
    await (daemon as any).handleRelayMsg(frame('muted-mention', ['U-SELF']), () => {})
    expect(setSessionMuted).toHaveBeenCalledWith(expect.any(String), false)
    expect(dispatch).toHaveBeenCalledWith('bot-a', expect.objectContaining({ trigger: 'mention' }), 'int-a')
  })

  it('dedups shared-bot retries per bot while dispatching the same Slack message for two bots', async () => {
    const daemon = new Daemon()
    const dispatch = vi.fn(async () => {})
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).agents.set('bot-b', {})
    ;(daemon as any).commands.isSessionMuted = () => false
    ;(daemon as any).dispatch = dispatch
    const frame = (agentId: string, botId: string, integrationId: string): RdMsgIm => ({
      source: 'im',
      agentId,
      sessionKey: 'C1/1700000000.000100',
      msgId: 'slack:C1:1700000000.000100',
      botId,
      integrationId,
      chatId: 'C1',
      payload: dm('1700000000.000100', 'hello both bots')
    })
    const botA = frame('bot-a', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const botB = frame('bot-b', '22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    expect(await (daemon as any).handleRelayMsg(botA, () => {})).toEqual({
      msgId: botA.msgId,
      accepted: true
    })
    expect(await (daemon as any).handleRelayMsg(botA, () => {})).toEqual({
      msgId: botA.msgId,
      accepted: true
    })
    expect(await (daemon as any).handleRelayMsg(botB, () => {})).toEqual({
      msgId: botB.msgId,
      accepted: true
    })

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenNthCalledWith(1, 'bot-a', botA.payload, botA.integrationId)
    expect(dispatch).toHaveBeenNthCalledWith(2, 'bot-b', botB.payload, botB.integrationId)
  })

  it('discovers an unroutable gated Feishu callback before the last-hop gate drops it', async () => {
    const daemon = new Daemon()
    const discover = vi.fn()
    const notice = vi.fn()
    const dispatch = vi.fn(async () => {})
    ;(daemon as any).agents.set('bot-a', {})
    ;(daemon as any).discoverConversations = discover
    ;(daemon as any).gatedAdmission = () => false
    ;(daemon as any).maybeGatedNotice = notice
    ;(daemon as any).dispatch = dispatch
    const payload = {
      ...dm('relay-feishu-gated', '@Agent hello'),
      platform: 'feishu' as const,
      channel: 'oc_1',
      thread: 'om_1',
      mentionedBots: ['ou_bot'],
      isDm: false
    }
    const msg: RdMsgIm = {
      source: 'im',
      agentId: 'bot-a',
      sessionKey: 'oc_1/om_1',
      msgId: 'relay-feishu-gated',
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'oc_1',
      payload
    }

    expect(await (daemon as any).handleRelayMsg(msg, () => {})).toEqual({
      msgId: 'relay-feishu-gated',
      accepted: true
    })
    expect(discover).toHaveBeenCalledWith(payload, ['int-a'])
    expect(notice).toHaveBeenCalledWith(payload, ['int-a'])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('shared-bot rd/msg(im) honors a !stop thread mute: implicit traffic drops, an @mention un-mutes', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    // The session the HTTP bot's inbound keys to (sessionKey(platform, channel, thread, agent)).
    const muteKey = SESSION_KEY
    await (daemon as any).store.setSessionMuted(muteKey, true)

    const relayIm = (msgId: string, text: string, trigger: 'dm' | 'mention'): RdMsgIm => ({
      source: 'im',
      agentId: 'bot-a',
      sessionKey: muteKey,
      msgId,
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-a',
      chatId: 'C1',
      payload: { ...dm(msgId, text), trigger }
    })

    // Implicit thread traffic while muted: accepted (consumed) but the agent is NOT woken.
    expect(await (daemon as any).handleRelayMsg(relayIm('m-implicit', 'still there?', 'dm'), () => {})).toEqual({
      msgId: 'm-implicit',
      accepted: true
    })
    expect(blocked.prompts).toHaveLength(0)
    expect(await (daemon as any).store.isSessionMuted(muteKey)).toBe(true)

    // An explicit @mention clears the mute and dispatches.
    expect(await (daemon as any).handleRelayMsg(relayIm('m-mention', 'hey again', 'mention'), () => {})).toEqual({
      msgId: 'm-mention',
      accepted: true
    })
    await vi.waitFor(() => expect(blocked.prompts).toHaveLength(1), WAIT)
    expect(await (daemon as any).store.isSessionMuted(muteKey)).toBe(false)
    blocked.release()
    await daemon.stop()
  })

  it('!queue buffers a message and dispatches it once the turn goes idle', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    // first message starts a turn whose prompt blocks
    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    // queue a follow-up while the turn is in flight
    await (daemon as any).onInboundOutcome(dm('200', '!queue do it'))
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(SESSION_KEY)).toHaveLength(1), WAIT)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Queued'), 'T1')
    expect(blocked.prompts).toHaveLength(1) // the 2nd message is queued, not dispatched yet
    expect(blocked.prompts[0]).toContain('hello') // (prefixed by the injected memory block)

    // let the first turn finish → the queued message is released
    blocked.release()
    await turn
    await vi.waitFor(() => expect(blocked.prompts.length).toBe(2), WAIT)
    expect(blocked.prompts[1]).toContain('do it')
    await vi.waitFor(() => expect((daemon as any).serialQueue.has(SESSION_KEY)).toBe(false), WAIT)

    await daemon.stop()
  })

  it('!queue runs immediately when the agent is idle', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    // no in-flight turn for this thread → dispatch right away
    await (daemon as any).onInboundOutcome(dm('100', '!queue start now'))
    await vi.waitFor(() => expect(blocked.prompts.length).toBe(1), WAIT)
    expect(blocked.prompts[0]).toContain('start now')
    expect((daemon as any).serialQueue.size).toBe(0)

    blocked.release()
    await daemon.stop()
  })

  it('!queue rejects once the per-session cap (10) is reached', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    for (let i = 0; i < 10; i++) await (daemon as any).onInboundOutcome(dm(`${200 + i}`, `!queue m${i}`))
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(SESSION_KEY)).toHaveLength(10), WAIT)
    await (daemon as any).onInboundOutcome(dm('999', '!queue overflow')) // 11th → rejected
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(SESSION_KEY)).toHaveLength(10), WAIT)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('full'), 'T1')

    blocked.release()
    await turn
    await daemon.stop()
  })

  it('!stop cancels the in-flight turn', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    await (daemon as any).onInboundOutcome(dm('200', '!stop'))
    expect(blocked.host.cancel).toHaveBeenCalledWith('acp-1')
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Stopped'), 'T1')

    blocked.release()
    await turn
    await daemon.stop()
  })

  it('!stop latches mute for a cold head before its session row exists', async () => {
    let releaseSession!: () => void
    const sessionBlocked = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        await sessionBlocked
        return 'acp-cold-stop'
      }),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const root = scaffold()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any })
    await daemon.start()
    makeRoutable(daemon)
    const key = SESSION_KEY

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'cold'), 'int-a')
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalled(), WAIT)
    expect(await (daemon as any).store.getSession(key)).toBeUndefined()
    await (daemon as any).onInboundOutcome(dm('200', '!stop'))
    expect(await (daemon as any).commands.isSessionMuted(key)).toBe(true)
    // The mute already exists outside the sessions table, so a daemon restart at
    // this exact cold point cannot forget the stop.
    const reopened = await LocalStore.open(statePath(root))
    expect(await reopened.getSession(key)).toBeUndefined()
    expect(await reopened.isSessionMuted(key)).toBe(true)
    await reopened.close()

    releaseSession()
    await expect(turn).resolves.toBeNull()
    expect(await (daemon as any).store.isSessionMuted(key)).toBe(true)
    await (daemon as any).onInboundOutcome(dm('300', 'must remain muted'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('!stop targets an exact cold thread instead of the channel latest session', async () => {
    let releaseSession!: () => void
    const sessionBlocked = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        await sessionBlocked
        return 'acp-cold-t2'
      }),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const oldKey = SESSION_KEY
    const coldKey = sessionKey('slack', 'C1', 'T2', 'bot-a', TRANSPORT_SCOPE)
    await (daemon as any).store.upsertSession({
      key: oldKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope: TRANSPORT_SCOPE,
      acpSessionId: 'acp-old',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const cold = { ...dm('100', 'cold T2'), thread: 'T2' }
    const turn = (daemon as any).dispatch('bot-a', cold, 'int-a')
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalled(), WAIT)
    expect(await (daemon as any).store.getSession(coldKey)).toBeUndefined()

    await (daemon as any).onInboundOutcome({ ...dm('200', '!stop'), thread: 'T2' })
    expect(await (daemon as any).commands.isSessionMuted(coldKey)).toBe(true)
    expect(await (daemon as any).commands.isSessionMuted(oldKey)).toBe(false)

    releaseSession()
    await expect(turn).resolves.toBeNull()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  // Slack renders the native Stop from the moment the turn sets `processing`, which is BEFORE
  // session/new answers and the row is written. connection.test.ts covers the event wiring; this
  // is the resolve → cancel half it drives, in that cold window.
  it('the native Slack Stop cancels a cold turn whose session row does not exist yet', async () => {
    let releaseSession!: () => void
    const sessionBlocked = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        await sessionBlocked
        return 'acp-cold'
      }),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalled(), WAIT)
    expect(await (daemon as any).store.getSession(SESSION_KEY)).toBeUndefined()

    // The fallback resolve a stop with no displayed owner uses (newest first; cold gate keys included).
    const keys = await (daemon as any).commands.slackThreadSessions({ channel: 'C1', thread: 'T1' }, ['int-a'])
    expect(keys).toEqual([SESSION_KEY])
    for (const key of keys)
      await (daemon as any).commands.handleStatusAction({ kind: 'cancel', sessionKey: key, actor: { userId: 'U1' } })

    releaseSession()
    await expect(turn).resolves.toBeNull()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('!cancel interrupts the in-flight turn WITHOUT muting the thread', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    await (daemon as any).onInboundOutcome(dm('200', '!cancel'))
    expect(blocked.host.cancel).toHaveBeenCalledWith('acp-1')
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Cancelled'), 'T1')
    // unlike !stop, the session is NOT muted — follow-ups keep dispatching.
    const store = (daemon as any).store
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(false)

    blocked.release()
    await turn
    await daemon.stop()
  })

  it('!cancel with no in-flight turn just reports (no mute)', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).onInboundOutcome({ ...dm('400', '!cancel'), thread: 'T9' })
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'Nothing is running to cancel.', 'T9')
    expect(await (daemon as any).store.isSessionMuted('slack:C1:T9:bot-a')).toBe(false)
    await daemon.stop()
  })

  it('!stop drops queued messages so they do not run after cancellation', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    await (daemon as any).onInboundOutcome(dm('200', '!queue later')) // buffered behind the turn
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(SESSION_KEY)).toHaveLength(1), WAIT)
    await (daemon as any).onInboundOutcome(dm('300', '!stop')) // clears the queue + cancels
    await vi.waitFor(() => expect((daemon as any).serialQueue.has(SESSION_KEY)).toBe(false), WAIT)

    blocked.release()
    await turn
    // give any erroneous flush a chance to fire, then assert it did not
    await new Promise((r) => setTimeout(r, 20))
    expect(blocked.prompts).toHaveLength(1) // the follow-up was dropped, not dispatched (memory prefixes the 'hello' turn)
    expect(blocked.prompts[0]).toContain('hello')

    await daemon.stop()
  })

  it('!stop mutes the thread: follow-ups are dropped (but transcribed) until an explicit @mention', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const store = (daemon as any).store

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    await (daemon as any).onInboundOutcome(dm('200', '!stop'))
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(true)
    blocked.release()
    await turn

    // un-mentioned follow-up in the muted thread → not dispatched, but recorded for §8.5 catch-up
    await (daemon as any).onInboundOutcome(dm('300', 'humans talking amongst themselves'))
    await new Promise((r) => setTimeout(r, 20))
    expect(blocked.prompts).toHaveLength(1) // the follow-up was dropped, not dispatched (memory prefixes the 'hello' turn)
    expect(blocked.prompts[0]).toContain('hello')
    expect(
      (await store.transcriptSince(transcriptChannelKey('C1', TRANSPORT_SCOPE), 'T1', null)).some(
        (r: any) => r.text === 'humans talking amongst themselves'
      )
    ).toBe(true)

    // explicit @mention clears the mute and dispatches (with the missed context replayed)
    await (daemon as any).onInboundOutcome({ ...dm('400', '<@UBOTA> resume please'), mentionedBots: ['UBOTA'] })
    await vi.waitFor(() => expect(blocked.prompts.length).toBe(2), WAIT)
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(false)
    expect(blocked.prompts[1]).toContain('humans talking amongst themselves')

    // thread affinity works again after the un-mute
    await (daemon as any).onInboundOutcome(dm('500', 'carry on'))
    await vi.waitFor(() => expect(blocked.prompts.length).toBe(3), WAIT)

    await daemon.stop()
  })

  it('a channel command in a thread it does not own is NOT answered via the channel-latest fallback', async () => {
    // Multi-agent channel leak: agent bot-a owns thread T1. A bare `!stop` (no @mention,
    // not a DM) typed in a DIFFERENT thread must not resolve to bot-a via the channel's
    // latest session — otherwise every idle agent in the channel replies "Nothing is
    // running" to a command meant for whoever owns that thread.
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const store = (daemon as any).store

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(false)

    // channel message (not a DM, no mention) in a thread bot-a does not own → routeRules
    // misses, and the guarded channel-latest fallback declines to cross into T-other.
    const channelStop = {
      ...dm('200', '!stop'),
      isDm: false,
      mentionedBots: [] as string[],
      thread: 'T-other',
      trigger: undefined
    }
    await (daemon as any).onInboundOutcome(channelStop)
    await new Promise((r) => setTimeout(r, 20))
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(false)

    // A top-level channel command (no thread) still reaches the channel's active session.
    await (daemon as any).onInboundOutcome({ ...channelStop, msgId: 'slack:C1:300', thread: undefined })
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Nothing is running'), 'slack:C1:300')

    await daemon.stop()
  })

  it('!stop with no in-flight turn still mutes an open thread; without a session it just reports', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const store = (daemon as any).store

    // open a session in T1, let its turn finish, then stand the agent down
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await (daemon as any).onInboundOutcome(dm('200', '!stop'))
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(true)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Muted'), 'T1')

    // follow-up in the muted thread does not start a turn
    await (daemon as any).onInboundOutcome(dm('300', 'follow up'))
    await new Promise((r) => setTimeout(r, 20))
    expect(host.prompt).toHaveBeenCalledTimes(1)

    // a bare !stop from a thread with no session of its own now targets the channel's
    // latest session (T1): reports it's idle + (re)mutes T1, but still replies in T9.
    await (daemon as any).onInboundOutcome({ ...dm('400', '!stop'), thread: 'T9' })
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Nothing is running'), 'T9')
    expect(await store.isSessionMuted(SESSION_KEY)).toBe(true)

    await daemon.stop()
  })

  it('!status replies with the session status line; reports when no session exists', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    // open a session in T1, then query it
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await (daemon as any).onInboundOutcome(dm('200', '!status'))
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining(':bar_chart:'), 'T1')

    // another thread in the SAME channel with no session of its own → falls back to the
    // channel's latest session (still reports the status line, not "nothing here")
    await (daemon as any).onInboundOutcome({ ...dm('400', '!status'), thread: 'T9' })
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining(':bar_chart:'), 'T9')

    // a channel with no session at all → a "nothing here" note
    await (daemon as any).onInboundOutcome({
      ...dm('500', '!status'),
      channel: 'C2',
      thread: 'T2',
      msgId: 'slack:C2:500'
    })
    expect(conn.postMessage).toHaveBeenCalledWith('C2', expect.stringContaining('No active session'), 'T2')

    await daemon.stop()
  })

  it('!fast on|off records the sticky override; bare /fast prints usage', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const store = (daemon as any).store
    const key = SESSION_KEY

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

    await (daemon as any).onInboundOutcome(dm('200', '!fast on'))
    expect(await store.getFastModeOverride(key)).toBe(true)
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Fast mode on'), 'T1')

    await (daemon as any).onInboundOutcome(dm('300', '!fast off'))
    expect(await store.getFastModeOverride(key)).toBe(false)

    await (daemon as any).onInboundOutcome(dm('400', '!fast'))
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Usage:'), 'T1')

    await daemon.stop()
  })

  it('/models · /effort · /permission list the choices and apply a selection', async () => {
    const host = selectHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const store = (daemon as any).store
    const key = SESSION_KEY

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

    // bare /models lists the options, marking the current one
    await (daemon as any).onInboundOutcome(dm('200', '/models'))
    const listed = conn.postMessage.mock.calls.at(-1)![1] as string
    expect(listed).toContain('opus')
    expect(listed).toContain('sonnet')
    expect(listed).toContain('✓ (current)')

    // select by 1-based index → sticky override recorded + applied live
    await (daemon as any).onInboundOutcome(dm('210', '/models 2'))
    expect(await store.getModelOverride(key)).toBe('sonnet')
    expect(host.setSessionModel).toHaveBeenCalledWith('acp-1', 'sonnet')
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Model set to sonnet'), 'T1')

    // select by name (case-insensitive substring)
    await (daemon as any).onInboundOutcome(dm('220', '/effort HIGH'))
    expect(await store.getEffortOverride(key)).toBe('high')

    await (daemon as any).onInboundOutcome(dm('230', '/permission plan'))
    expect(await store.getPermissionModeOverride(key)).toBe('plan')

    // an unknown value is rejected with the option list, no override written
    await (daemon as any).onInboundOutcome(dm('240', '/models haiku'))
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Unknown model'), 'T1')
    expect(await store.getModelOverride(key)).toBe('sonnet')

    // a bare command from a DIFFERENT thread still targets the channel's latest session
    // (T1) — the override lands on T1's key, and the reply goes to the sender's thread.
    await (daemon as any).onInboundOutcome({ ...dm('250', '/models 1'), thread: 'T9' })
    expect(await store.getModelOverride(key)).toBe('opus')
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Model set to opus'), 'T9')

    await daemon.stop()
  })

  it('/permission shows Codex desktop-app labels and resolves a choice typed as its label', async () => {
    const host = {
      ...selectHost(),
      permissionModeOptions: vi.fn(() => ({
        current: 'agent',
        modes: ['read-only', 'agent', 'agent-full-access']
      })),
      approvalsReviewerOptions: vi.fn(() => ({
        current: 'user',
        reviewers: ['user', 'auto_review']
      })),
      setSessionApprovalsReviewer: vi.fn(async () => true)
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const store = (daemon as any).store
    const key = SESSION_KEY

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

    // Default-off agents expose no runtime controls to conversation users.
    await (daemon as any).onInboundOutcome(dm('160', '/models 2'))
    await (daemon as any).onInboundOutcome(dm('170', '/effort high'))
    await (daemon as any).onInboundOutcome(dm('180', '!fast on'))
    await (daemon as any).onInboundOutcome(dm('190', '/permission'))
    expect(conn.postMessage.mock.calls.at(-1)![1]).toContain('Agent editor')
    expect(await store.getModelOverride(key)).toBeUndefined()
    expect(await store.getEffortOverride(key)).toBeUndefined()
    expect(await store.getFastModeOverride(key)).toBeUndefined()
    expect(await store.getPermissionModeOverride(key)).toBeUndefined()

    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true

    // bare /permission lists Codex's own preset names (not the raw wire ids); the
    // default `agent` reads as "Ask for approval", matching Codex's own UI.
    await (daemon as any).onInboundOutcome(dm('200', '/permission'))
    const listed = conn.postMessage.mock.calls.at(-1)![1] as string
    expect(listed).toContain('Read Only')
    expect(listed).toContain('Ask for approval')
    expect(listed).toContain('Auto')
    expect(listed).toContain('Full Access')
    expect(listed).not.toContain('agent-full-access')

    // choose by label ("full access") → resolves to the raw wire id, applied live
    await (daemon as any).onInboundOutcome(dm('210', '/permission full access'))
    expect(await store.getPermissionModeOverride(key)).toBe('agent-full-access')
    await vi.waitFor(() => {
      expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-1', 'agent-full-access')
    }, WAIT)
    expect(conn.postMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('Permission mode set to Full Access'),
      'T1'
    )

    // the default preset resolves from its Codex label too ("ask for approval" → agent)
    await (daemon as any).onInboundOutcome(dm('220', '/permission ask for approval'))
    expect(await store.getPermissionModeOverride(key)).toBe('agent')
    await vi.waitFor(() => {
      expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-1', 'agent')
    }, WAIT)
    host.setSessionPermissionMode.mockClear()
    host.setSessionApprovalsReviewer.mockClear()

    // Auto is one session preset in every chat surface, but reaches ACP as two
    // independent config selections.
    await (daemon as any).onInboundOutcome(dm('230', '/permission auto'))
    expect(await store.getPermissionModeOverride(key)).toBe('agent:auto-review')
    await vi.waitFor(() => {
      expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-1', 'agent')
      expect(host.setSessionApprovalsReviewer).toHaveBeenCalledWith('acp-1', 'auto_review')
    }, WAIT)

    await daemon.stop()
  })

  it('a command from a non-routable thread is ignored (no dispatch, no crash)', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    // no integration attached → routeRules resolves nothing
    await (daemon as any).onInboundOutcome(dm('100', '!stop'))
    await new Promise((r) => setTimeout(r, 20))
    expect(blocked.prompts).toEqual([])
    await daemon.stop()
  })
})

/** A fake ACP host whose prompts complete immediately. */
function quietHost() {
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: vi.fn(() => false),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}

/** A quiet host that also advertises model / effort / permission selectors (a warm
 *  session), for the /models · /effort · /permission commands. */
function selectHost() {
  return {
    ...quietHost(),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => ({ current: 'opus', models: ['opus', 'sonnet'] })),
    effortOptions: vi.fn(() => ({ current: 'medium', efforts: ['low', 'medium', 'high'] })),
    permissionModeOptions: vi.fn(() => ({ current: 'default', modes: ['default', 'plan', 'acceptEdits'] })),
    fastModeOption: vi.fn(() => null),
    setSessionModel: vi.fn(async () => true),
    setSessionEffort: vi.fn(async () => true),
    setSessionPermissionMode: vi.fn(async () => true)
  }
}

describe('Daemon managed-agent bot ingress', () => {
  it('ignores managed agent bot messages in mention and every-message paths but admits an external bot mention', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    // This test mutates the in-memory fixture directly; it does not need the agent
    // directory watcher that start() opens for production hot reload.
    await (daemon as any).watcher?.close()
    ;(daemon as any).watcher = undefined
    const conn = makeRoutable(daemon) as any
    conn.postBlocks = vi.fn(async () => 'reply-ts')
    conn.updateBlocks = vi.fn(async () => {})
    conn.getThreadReplies = vi.fn(async () => [])
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    integration.core.bindRules = [{ match: { kind: 'mention' } }, { channel: 'C1', match: { kind: 'auto' } }]
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        {
          orgId: 'org-1',
          platform: 'slack',
          channelId: 'C1',
          agents: [
            {
              agentId: 'managed-peer',
              daemonId: 'daemon-peer',
              integrationId: 'integration-peer',
              botAppId: 'AMANAGED',
              callPolicy: 'all',
              allowedCallerAgentIds: []
            }
          ]
        }
      ]
    })
    const botMessage = (ts: string, appId: string, mentionedBots: string[]) => ({
      ...dm(ts, mentionedBots.length > 0 ? '<@UBOTA> wake up' : 'every-message traffic'),
      isDm: false,
      sender: { id: `U-${appId}`, isBot: true, appId },
      mentionedBots,
      trigger: mentionedBots.length > 0 ? ('mention' as const) : ('auto' as const)
    })

    await (daemon as any).onInboundOutcome(botMessage('managed-mention', 'AMANAGED', ['UBOTA']))
    await (daemon as any).onInboundOutcome(botMessage('managed-auto', 'AMANAGED', []))
    await (daemon as any).onInboundOutcome(botMessage('external-auto', 'AEXTERNAL', []))
    expect(host.prompt).not.toHaveBeenCalled()

    const relayManaged = botMessage('relay-managed', 'AMANAGED', ['UBOTA'])
    const relayAck = await (daemon as any).handleRelayMsg(
      {
        source: 'im',
        agentId: 'bot-a',
        sessionKey: SESSION_KEY,
        msgId: relayManaged.msgId,
        botId: 'shared-bot',
        integrationId: 'int-a',
        chatId: 'C1',
        payload: relayManaged
      } satisfies RdMsgIm,
      () => {}
    )
    expect(relayAck).toEqual({ msgId: relayManaged.msgId, accepted: true })
    expect(host.prompt).not.toHaveBeenCalled()

    await (daemon as any).onInboundOutcome(botMessage('external-mention', 'AEXTERNAL', ['UBOTA']))
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    await daemon.stop()
  })
})

describe('Daemon transcript recording (§8.5 unrouted)', () => {
  it('records an unrouted mention into a live thread', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const store = (daemon as any).store

    // open a session in thread T1 via a routable DM
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect(await store.openSessionAgents('C1', 'T1', TRANSPORT_SCOPE)).toContain('bot-a')

    // A mention of an unknown bot must not fall back to this thread owner.
    await (daemon as any).onInboundOutcome({
      msgId: 'slack:C1:200',
      traceId: '200',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope: TRANSPORT_SCOPE,
      sender: { id: 'B999', isBot: true },
      text: 'beep from another bot',
      mentionedBots: ['UOTHER'],
      isDm: false
    })
    const rows = await store.transcriptSince(transcriptChannelKey('C1', TRANSPORT_SCOPE), 'T1', null)
    expect(rows.some((r: any) => r.text === 'beep from another bot' && r.sender === 'B999')).toBe(true)

    await daemon.stop()
  })

  it('backfill relabels the agent’s own bot frames to agentId and folds in attachment mentions', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon) as any
    conn.botUserId = 'UBOT'
    conn.botId = 'BBOT'
    conn.getThreadReplies = vi.fn(async () => [
      { sender: 'U2', ts: '100.1', text: 'human asks', isBot: false, attachments: [] },
      // the agent's own prior reply, tagged with the bot's Slack user id
      { sender: 'UBOT', ts: '100.2', text: 'bot replied', isBot: true, attachments: [] },
      // a human message that shared a file (empty text is common for file_share)
      {
        sender: 'U2',
        ts: '100.3',
        text: '',
        isBot: false,
        attachments: [{ id: 'F1', name: 'shot.png', mimeType: 'image/png', sourceUrl: 'u' }]
      }
    ])

    const out = await (daemon as any).fetchThreadHistory('bot-a', 'C1', 'T1')
    expect(out).toEqual([
      { sender: 'U2', ts: '100.1', text: 'human asks' },
      { sender: 'bot-a', ts: '100.2', text: 'bot replied', trustedAgentBot: true }, // own bot frame → agentId
      { sender: 'U2', ts: '100.3', text: '[attached: shot.png (image/png)]' } // mention synthesized
    ])

    await daemon.stop()
  })

  it('keeps a shared Slack image on its transcript row so the console can replay it', async () => {
    // Slack hands out an auth-gated file URL, so the row can only carry the image if the
    // daemon fetches it — without that the console showed just `[attached: …]`. The fetch
    // is independent of the agent's image capability (quietHost advertises none).
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon) as any
    const bytes = Buffer.from('PNGBYTES')
    conn.downloadFile = vi.fn(async () => bytes)

    await (daemon as any).dispatch(
      'bot-a',
      {
        ...dm('100', 'look at this'),
        attachments: [{ id: 'F1', name: 'shot.png', mimeType: 'image/png', size: bytes.length, sourceUrl: 'u' }]
      },
      'int-a'
    )

    const rows = await (daemon as any).store.transcriptSince(transcriptChannelKey('C1', TRANSPORT_SCOPE), 'T1', null)
    const row = rows.find((r: any) => r.sender === 'U1')
    expect(row.text).toBe('look at this\n[attached: shot.png (image/png)]')
    expect(JSON.parse(row.attachmentsJson)).toEqual([
      { name: 'shot.png', mimeType: 'image/png', data: bytes.toString('base64') }
    ])
    expect(conn.downloadFile).toHaveBeenCalledOnce() // one fetch serves transcript + prompt

    await daemon.stop()
  })

  it('backfill preserves a remote agent author carried by an HTTP Slack bot', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon) as any
    conn.botUserId = 'USHARED'
    conn.botId = 'BSHARED'
    conn.getThreadReplies = vi.fn(async () => [
      {
        sender: 'BSHARED',
        agentAuthorId: 'remote-agent-a',
        ts: '100.2',
        text: '@remote-agent-a → @bot-a: review this',
        isBot: true,
        attachments: []
      }
    ])

    await expect((daemon as any).fetchThreadHistory('bot-a', 'C1', 'T1')).resolves.toEqual([
      {
        sender: 'remote-agent-a',
        ts: '100.2',
        text: '@remote-agent-a → @bot-a: review this',
        trustedAgentBot: true
      }
    ])

    await daemon.stop()
  })

  it('backfill ignores AgentConnect metadata from an unrelated Slack app', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon) as any
    conn.botUserId = 'UOWN'
    conn.botId = 'BOWN'
    conn.getThreadReplies = vi.fn(async () => [
      {
        sender: 'BOTHER',
        agentAuthorId: 'bot-a',
        appId: 'AOTHER',
        ts: '100.2',
        text: 'unrelated app payload',
        isBot: true,
        chrome: false,
        attachments: []
      },
      {
        sender: 'BOTHER',
        appId: 'AOTHER',
        ts: '100.3',
        text: 'unrelated chrome marker',
        isBot: true,
        chrome: true,
        attachments: []
      }
    ])

    await expect((daemon as any).fetchThreadHistory('bot-a', 'C1', 'T1')).resolves.toEqual([
      { sender: 'BOTHER', ts: '100.2', text: 'unrelated app payload' },
      { sender: 'BOTHER', ts: '100.3', text: 'unrelated chrome marker' }
    ])

    await daemon.stop()
  })

  it('records an unrouted message while a long turn is in flight even if the session looks idle-stale', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const store = (daemon as any).store

    // start a turn that blocks (simulating a long-running turn)
    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    // age the session record so the recency window alone would exclude it
    const rec = await store.getSession(SESSION_KEY)
    await store.upsertSession({ ...rec, updatedAt: rec.updatedAt - 60 * 60 * 1000 })
    expect(await store.activeSessionCountSince('C1', 'T1', Date.now() - 900_000, TRANSPORT_SCOPE)).toBe(0)

    // An unrouted peer mention arrives mid-turn → still recorded (in-flight keeps it active).
    await (daemon as any).onInboundOutcome({
      msgId: 'slack:C1:200',
      traceId: '200',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope: TRANSPORT_SCOPE,
      sender: { id: 'B999', isBot: true },
      text: 'mid-turn peer message',
      mentionedBots: ['UOTHER'],
      isDm: false
    })
    expect(
      (await store.transcriptSince(transcriptChannelKey('C1', TRANSPORT_SCOPE), 'T1', null)).some(
        (r: any) => r.text === 'mid-turn peer message'
      )
    ).toBe(true)

    blocked.release()
    await turn
    await daemon.stop()
  })

  it('does not record an unrouted message when no session is open in its thread', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const store = (daemon as any).store

    await (daemon as any).onInboundOutcome({
      msgId: 'slack:C9:500',
      traceId: '500',
      source: 'user',
      platform: 'slack',
      channel: 'C9',
      thread: 'T9',
      sender: { id: 'B777', isBot: true },
      text: 'orphan chatter',
      mentionedBots: [],
      isDm: false
    })
    expect(await store.transcriptSince('C9', 'T9', null)).toEqual([])

    await daemon.stop()
  })
})

describe('Slack interactive status bar', () => {
  const statusActions = (blocks?: any[]) =>
    blocks
      ?.find((block) => block.type === 'section')
      ?.accessory?.options.map((option: any) => decodeSlackStatusOverflowValue(option.value)?.action)

  /** A blocking host that also advertises a model selector (drives the status bar). */
  function modelHost() {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      modelOptions: vi.fn(() => ({ current: 'opus-4.8', models: ['opus-4.8', 'sonnet-5'] })),
      hasSession: vi.fn(() => true),
      setSessionModel: vi.fn(async () => true),
      prompt: vi.fn(async () => {
        if (++calls === 1) await gate
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    return { host, release: () => release() }
  }

  /** Routable bot-a with its status bar enabled and a fake connection that captures Block Kit posts/edits. */
  function routableWithBlocks(daemon: Daemon) {
    ;(daemon as any).agents.get('bot-a').output.showStatusBar = true
    makeRoutable(daemon)
    let n = 0
    const conn = {
      workspaceId: vi.fn(() => 'T1'),
      setStatus: vi.fn(async () => {}),
      postMessage: vi.fn<(channel: string, text: string, threadTs?: string, options?: unknown) => Promise<string>>(
        async () => `m${++n}`
      ),
      updateMessage: vi.fn<(channel: string, ts: string, text: string, chrome?: boolean) => Promise<void>>(
        async () => {}
      ),
      postBlocks: vi.fn<
        (channel: string, blocks: unknown[], text: string, threadTs?: string, options?: unknown) => Promise<string>
      >(async () => `sb${++n}`),
      updateBlocks: vi.fn<
        (channel: string, ts: string, blocks: unknown[], text?: string, chrome?: boolean) => Promise<void>
      >(async () => {}),
      deleteMessage: vi.fn(async () => true),
      postContext: vi.fn(async () => {})
    }
    ;(daemon as any).connByIntegration.set('int-a', conn)
    return conn
  }

  it('posts one session status line and updates it on later turns', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(AGENT_IDENTITY),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)

    // Turn 1: the status bar posts up front (before the blocked prompt returns).
    const t1 = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    expect(host.prompt).toHaveBeenCalledTimes(1) // posted before the reply completes
    // The status line uses the selected agent identity even in DMs, and remains marked as
    // chrome so a peer daemon's thread backfill skips it.
    expect(conn.postBlocks.mock.calls[0]?.[4]).toEqual(STATUS_BAR_POST_OPTIONS)
    expect(statusActions(conn.postBlocks.mock.calls[0]![1] as any[])).toEqual(['manage', 'cancel'])
    release()
    await t1
    const settledStatus = [...conn.updateBlocks.mock.calls]
      .reverse()
      .find((call) => statusActions(call[2] as any[]) !== undefined)
    expect(statusActions(settledStatus?.[2] as any[])).toEqual(['manage'])

    // Turn 2: update the existing status line instead of posting another one.
    await (daemon as any).dispatch('bot-a', dm('200', 'again'), 'int-a')
    expect(conn.postBlocks).toHaveBeenCalledTimes(1)
    expect(conn.updateBlocks).toHaveBeenCalledWith(
      'C1',
      'sb1',
      expect.any(Array),
      expect.stringContaining('opus-4.8'),
      true,
      undefined,
      'bot-a'
    )
    // The in-thread message is one section row: status + View Session + overflow.
    const blocks = conn.postBlocks.mock.calls[0]![1] as { type: string; text?: { text: string }; accessory?: any }[]
    const section = blocks.find((b) => b.type === 'section')!
    expect(blocks).toHaveLength(1)
    expect(section.text!.text).toContain('opus-4.8')
    // The deep link names the session outwardly (session-concept.md §1.1), not the runtime's id.
    const outward = (await (daemon as any).store.getSessionByAcpId('acp-1'))!.sessionId
    expect(outward).not.toBe('acp-1')
    expect(section.text!.text).toContain(`<http://localhost:3000/sessions/${outward}?source=slack|View Session>`)
    expect(section.accessory.action_id).toBe('ac_more')
    await daemon.stop()
  })

  it('removes the persisted session status line after the Agent disables it', async () => {
    // Exercise the hidden branch without starting the daemon's unrelated file watchers.
    // Config/default replication is covered separately; this proves the Slack cleanup
    // action deletes the remembered row and dedupes later usage/turn-end refreshes.
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    const conn = {
      deleteMessage: vi.fn(async () => true),
      getThreadReplies: vi.fn(async () => [{ ts: 'legacy', text: ':bar_chart: legacy', isBot: true }])
    }
    const getStatusBarTs = vi.fn()
    const clearStatusBarTs = vi.fn()
    ;(daemon as any).store = { getStatusBarTs, clearStatusBarTs }
    const pending: any = {
      plan: { platform: 'slack', showStatusBar: false, sessionKey: SESSION_KEY, channel: 'C1' },
      chrome: { statusBarTs: 'sb1' },
      conn,
      signals: { applyChain: Promise.resolve() }
    }

    ;(daemon as any).emitStatusBar(pending)
    await pending.signals.applyChain
    expect(conn.deleteMessage).toHaveBeenCalledWith('C1', 'sb1')
    expect(pending.chrome.statusBarTs).toBeUndefined()
    expect(clearStatusBarTs).toHaveBeenCalledWith(SESSION_KEY)

    ;(daemon as any).emitStatusBar(pending)
    await pending.signals.applyChain
    expect(conn.deleteMessage).toHaveBeenCalledTimes(1)

    // Never adopt an unowned legacy row for deletion: a shared Slack thread may contain
    // another Agent's status bar.
    const unowned = { ...pending, chrome: {}, signals: { applyChain: Promise.resolve() } }
    ;(daemon as any).emitStatusBar(unowned)
    await unowned.signals.applyChain
    expect(conn.getThreadReplies).not.toHaveBeenCalled()
    expect(conn.deleteMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps the session status bar pinned above cards that need human input', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(AGENT_IDENTITY),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)

    // Turn is blocked mid-prompt: the session status bar (sb1) posts up front.
    const t1 = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const p = [...(daemon as any).pending.values()][0]
    expect(p.chrome.statusBarTs).toBe('sb1')

    // A permission / elicitation card is posted mid-turn (its handler calls this). Other
    // live output re-anchors below the card, but the session header must remain at sb1.
    ;(daemon as any).reanchorInPlaceChrome(p)
    await p.signals.applyChain
    p.chrome.lastStatusBar = undefined // mimic a usage update that changes the visible header
    ;(daemon as any).emitStatusBar(p)
    await vi.waitFor(
      () =>
        expect(conn.updateBlocks).toHaveBeenCalledWith(
          'C1',
          'sb1',
          expect.any(Array),
          expect.any(String),
          true,
          undefined,
          'bot-a'
        ),
      WAIT
    )
    expect(p.chrome.statusBarTs).toBe('sb1')
    expect(await (daemon as any).store.getStatusBarTs(p.plan.sessionKey)).toBe('sb1')
    expect(conn.postBlocks).toHaveBeenCalledTimes(1)
    expect(conn.deleteMessage).not.toHaveBeenCalled()

    release()
    await t1
    await daemon.stop()
  })

  it('posts shareable channel status with agent identity and one compact overflow', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(AGENT_IDENTITY),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    integration.core.mode = 'shared'
    integration.config.shareable = true // multi-agent ⇒ the overflow offers Switch agent
    delete integration.config.appToken

    // Use a real shared channel shape to prove status chrome uses the selected agent
    // identity just like native loading states and ordinary replies.
    const channelMessage = {
      ...dm('100', 'hi'),
      transportScope: SHARED_TRANSPORT_SCOPE,
      isDm: false,
      trigger: 'mention' as const,
      mentionedBots: ['UBOTA']
    }
    const turn = (daemon as any).dispatch('bot-a', channelMessage, 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const call = conn.postBlocks.mock.calls[0]!
    const blocks = call[1] as {
      type: string
      block_id?: string
      text?: { text: string }
      accessory?: any
      elements?: any[]
    }[]
    const [section] = blocks

    expect(blocks.map((b) => b.type)).toEqual(['section'])
    expect(section!.text!.text).toContain('View Session')
    expect(section!.text!.text).not.toContain('Agent:')
    expect(section!.accessory).toMatchObject({
      type: 'overflow',
      action_id: SLACK_STATUS_ACTION.more
    })
    const choices = section!.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)
    expect(choices).toEqual(['switch-agent', 'manage', 'cancel'])
    expect(decodeSharedSlackStatusTarget(section!.block_id!)).toEqual({
      v: 1,
      agentId: 'bot-a',
      integrationId: 'int-a',
      sessionKey: SHARED_SESSION_KEY
    })
    expect(call[4]).toEqual(STATUS_BAR_POST_OPTIONS)

    release()
    await turn
    await daemon.stop()
  })

  it('drops Switch agent for a non-shareable HTTP bot while keeping agent identity + relay routing', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(AGENT_IDENTITY),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    // A single-agent http bot: relay-routed (mode 'shared') but NOT shareable, so the
    // in-thread overflow must omit Switch agent (nothing to switch to).
    integration.core.mode = 'shared'
    integration.config.shareable = false
    delete integration.config.appToken

    const channelMessage = {
      ...dm('100', 'hi'),
      transportScope: SHARED_TRANSPORT_SCOPE,
      isDm: false,
      trigger: 'mention' as const,
      mentionedBots: ['UBOTA']
    }
    const turn = (daemon as any).dispatch('bot-a', channelMessage, 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const call = conn.postBlocks.mock.calls[0]!
    const blocks = call[1] as { type: string; block_id?: string; accessory?: any }[]
    const [section] = blocks

    const choices = section!.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)
    expect(choices).toEqual(['manage', 'cancel']) // no 'switch-agent'
    // Overflow still routes through the relay (the block_id is the encoded session target),
    // so Session options / Cancel run keep working for a single-agent http bot.
    expect(decodeSharedSlackStatusTarget(section!.block_id!)).toEqual({
      v: 1,
      agentId: 'bot-a',
      integrationId: 'int-a',
      sessionKey: SHARED_SESSION_KEY
    })
    // Agent identity is preserved in HTTP mode, and the message remains marked as chrome.
    expect(call[4]).toEqual(STATUS_BAR_POST_OPTIONS)

    release()
    await turn
    await daemon.stop()
  })

  it('§6.6: a platform_action envelope decodes per-platform and NAKs unsupported items', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blockingHost().host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    integration.core.mode = 'shared'
    delete integration.config.appToken
    const sharedTransportScope = `slack:${createHash('sha256').update('slack\0b').digest('hex').slice(0, 24)}`
    const KEY = sessionKey('slack', 'C1', 'T1', 'bot-a', sharedTransportScope)
    const openStatusModal = vi.fn<(triggerId: string, sessionKey?: string, privateMetadata?: string) => Promise<void>>(
      async () => {}
    )
    ;(daemon as any).connByIntegration.set('int-a', { openStatusModal })
    await (daemon as any).store.upsertSession({
      key: KEY,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope: sharedTransportScope,
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const envelope = (over: Record<string, unknown> = {}) => ({
      source: 'platform_action' as const,
      platformId: 'slack',
      agentId: 'bot-a',
      sessionKey: KEY,
      msgId: 'pa-1',
      botId: 'shared-bot',
      integrationId: 'int-a',
      payload: { kind: 'open-config', triggerId: 'trig-1' },
      ...over
    })
    // The envelope routes into the SAME per-platform decode path as the legacy member.
    expect(await (daemon as any).handleRelayMsg(envelope(), () => {})).toEqual({ msgId: 'pa-1', accepted: true })
    expect(openStatusModal).toHaveBeenCalledTimes(1)
    // An undecodable payload NAKs the ITEM, never the socket.
    expect(
      await (daemon as any).handleRelayMsg(envelope({ msgId: 'pa-2', payload: { kind: 'not-a-thing' } }), () => {})
    ).toEqual({ msgId: 'pa-2', accepted: false, reason: 'unsupported_action' })
    // A platform id this build has no decoder for NAKs the same way.
    expect(
      await (daemon as any).handleRelayMsg(envelope({ msgId: 'pa-3', platformId: 'teams-x', payload: {} }), () => {})
    ).toEqual({ msgId: 'pa-3', accepted: false, reason: 'unsupported_action' })
    await daemon.stop()
  })

  it('handles shared session interactions only for the exact local integration and session owner', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blockingHost().host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const integration = (daemon as any).agents.get('bot-a').integrations[0]
    integration.core.mode = 'shared'
    delete integration.config.appToken

    const sharedTransportScope = `slack:${createHash('sha256').update('slack\0b').digest('hex').slice(0, 24)}`
    const KEY = sessionKey('slack', 'C1', 'T1', 'bot-a', sharedTransportScope)
    const FOREIGN_KEY = sessionKey('slack', 'C1', 'T2', 'bot-a', sharedTransportScope)
    const openStatusModal = vi.fn<(triggerId: string, sessionKey?: string, privateMetadata?: string) => Promise<void>>(
      async () => {}
    )
    const updateBlocks = vi.fn(async () => true)
    const agentSessionStopped = vi.fn(async () => {})
    ;(daemon as any).connByIntegration.set('int-a', { openStatusModal, updateBlocks, agentSessionStopped })
    await (daemon as any).store.upsertSession({
      key: KEY,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope: sharedTransportScope,
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await (daemon as any).store.upsertSession({
      key: FOREIGN_KEY,
      agentId: 'someone-else',
      platform: 'slack',
      channel: 'C1',
      thread: 'T2',
      transportScope: sharedTransportScope,
      acpSessionId: 'acp-2',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const action = (over: Partial<RdMsgPlatformAction> = {}): RdMsgPlatformAction => ({
      source: 'platform_action',
      platformId: 'slack',
      agentId: 'bot-a',
      sessionKey: KEY,
      msgId: 'action-ok',
      botId: 'shared-bot',
      integrationId: 'int-a',
      payload: { kind: 'open-config', triggerId: 'trig-1' },
      ...over
    })

    expect(await (daemon as any).handleRelayMsg(action(), () => {})).toEqual({ msgId: 'action-ok', accepted: true })
    expect(openStatusModal).toHaveBeenCalledTimes(1)
    expect(
      await (daemon as any).handleRelayMsg(
        action({
          sessionKey: 'C1/T1',
          msgId: 'action-shortcut',
          userId: 'U1',
          payload: {
            kind: 'open-config-for-thread',
            triggerId: 'trig-shortcut',
            channelId: 'C1',
            threadTs: 'T1'
          }
        }),
        () => {}
      )
    ).toEqual({ msgId: 'action-shortcut', accepted: true })
    expect(openStatusModal).toHaveBeenCalledTimes(2)
    const [, shortcutSessionKey, shortcutMetadata] = openStatusModal.mock.calls[1]!
    expect(shortcutSessionKey).toBe(KEY)
    expect(decodeSharedSlackStatusTarget(shortcutMetadata!)).toEqual({
      v: 1,
      agentId: 'bot-a',
      integrationId: 'int-a',
      sessionKey: KEY
    })

    // The relay-forwarded native Stop is conversation-addressed like the shortcut above: the
    // connection resolves the session itself, so the frame's sessionKey is not the target.
    expect(
      await (daemon as any).handleRelayMsg(
        action({
          sessionKey: 'C1/T1',
          msgId: 'action-stop',
          userId: 'U1',
          payload: { kind: 'agent-session-stopped', channelId: 'C1', threadTs: 'T1' }
        }),
        () => {}
      )
    ).toEqual({ msgId: 'action-stop', accepted: true })
    expect(agentSessionStopped).toHaveBeenCalledWith('C1', 'T1', 'U1')

    const permissionResolved = vi.fn()
    const permissionRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    await (daemon as any).store.createPermissionRequest({
      id: permissionRequestId,
      agentId: 'bot-a',
      sessionId: 'acp-1',
      createdAt: Date.now(),
      requesterId: 'U1',
      requesterName: 'Test User',
      command: 'Bash: pnpm test',
      status: 'pending',
      resolvedAt: null
    })
    ;(daemon as any).permissions.pendingChatPermissions.set(permissionRequestId, {
      agentId: 'bot-a',
      sessionId: 'acp-1',
      params: { options: [{ optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' }] },
      evaluationParams: {},
      conn: { updateBlocks },
      channel: 'C1',
      ts: 'card-1',
      resolve: permissionResolved
    })
    expect(
      await (daemon as any).handleRelayMsg(
        action({
          msgId: 'action-permission',
          payload: { kind: 'permission-choice', requestId: permissionRequestId, optionId: 'allow_once' }
        }),
        () => {}
      )
    ).toEqual({ msgId: 'action-permission', accepted: true })
    expect(permissionResolved).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow_once' } })

    const elicitationResolved = vi.fn()
    ;(daemon as any).permissions.pendingElicits.set('elicit-1', {
      agentId: 'bot-a',
      sessionId: 'acp-1',
      params: { message: 'Pick one' },
      propName: 'language',
      kind: 'enum',
      approval: false,
      conn: { updateBlocks },
      channel: 'C1',
      ts: 'card-2',
      resolve: elicitationResolved
    })
    expect(
      await (daemon as any).handleRelayMsg(
        action({
          msgId: 'action-elicit',
          payload: { kind: 'elicitation-choice', requestId: 'elicit-1', value: 'TypeScript' }
        }),
        () => {}
      )
    ).toEqual({ msgId: 'action-elicit', accepted: true })
    expect(elicitationResolved).toHaveBeenCalledWith({
      action: 'accept',
      content: { language: 'TypeScript' }
    })
    const [triggerId, openedSessionKey, privateMetadata] = openStatusModal.mock.calls[0]!
    expect(triggerId).toBe('trig-1')
    expect(openedSessionKey).toBe(KEY)
    expect(decodeSharedSlackStatusTarget(privateMetadata!)).toEqual({
      v: 1,
      agentId: 'bot-a',
      integrationId: 'int-a',
      sessionKey: KEY
    })

    // HTTP interactions may be redelivered. A replayed receipt must
    // not consume the same trigger_id by opening a second modal.
    expect(await (daemon as any).handleRelayMsg(action(), () => {})).toEqual({ msgId: 'action-ok', accepted: true })
    expect(openStatusModal).toHaveBeenCalledTimes(2)

    const rejected = [
      action({ sessionKey: 'slack:C1:missing:bot-a', msgId: 'action-missing' }),
      action({ sessionKey: FOREIGN_KEY, msgId: 'action-foreign' }),
      action({ integrationId: 'int-other', msgId: 'action-integration-mismatch' })
    ]
    for (const msg of rejected) {
      expect(await (daemon as any).handleRelayMsg(msg, () => {})).toMatchObject({
        msgId: msg.msgId,
        accepted: false,
        reason: 'not_found'
      })
    }
    expect(openStatusModal).toHaveBeenCalledTimes(2)

    await daemon.stop()
  })

  it('handles shared Feishu card actions only through the exact local integration', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blockingHost().host as any
    })
    await daemon.start()
    const agent = (daemon as any).agents.get('bot-a')
    agent.integrations = [
      {
        id: 'int-a',
        platform: 'feishu',
        core: { mode: 'shared', bindRules: [] },
        config: { appId: 'cli_http_app', appSecret: 'secret', region: 'lark' }
      }
    ]
    const response = { toast: { type: 'info' as const, content: 'Cancellation requested.' } }
    const handleCardAction = vi.fn(() => response)
    ;(daemon as any).fsConnByIntegration.set('int-a', { handleCardAction })

    const action: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: 'feishu',
      agentId: 'bot-a',
      sessionKey: 'feishu-action:om_card',
      msgId: 'feishu-action:one',
      botId: 'shared-bot',
      integrationId: 'int-a',
      payload: {
        context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
        operator: { open_id: 'ou_human' },
        action: { tag: 'overflow', option: 'cancel', value: { action: 'agentconnect_reply' } }
      }
    }

    expect(await (daemon as any).handleRelayMsg(action, () => {})).toEqual({
      msgId: action.msgId,
      accepted: true,
      // §6.6: the generic opaque slot is the one answer (named slot retired).
      response
    })
    expect(handleCardAction).toHaveBeenCalledWith(action.payload)
    expect(
      await (daemon as any).handleRelayMsg(
        { ...action, msgId: 'feishu-action:wrong', integrationId: 'int-other' },
        () => {}
      )
    ).toMatchObject({ accepted: false, reason: 'not_found' })

    await daemon.stop()
  })

  it('adopts the first existing status line in a Slack thread', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    ;(conn as any).botId = 'B1'
    ;(conn as any).getThreadReplies = vi.fn(async () => [
      { sender: 'U1', ts: 'T1', text: 'hi', isBot: false, attachments: [] },
      {
        sender: 'B1',
        ts: '111.1',
        text: ':bar_chart: *old* - ctx 1.0k',
        isBot: true,
        chrome: true,
        chromeOwnerAgentId: 'bot-a',
        attachments: []
      },
      {
        sender: 'B1',
        ts: '222.2',
        text: ':bar_chart: *newer*',
        isBot: true,
        chrome: true,
        chromeOwnerAgentId: 'bot-a',
        attachments: []
      }
    ])

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(
      () =>
        expect(conn.updateBlocks).toHaveBeenCalledWith(
          'C1',
          '111.1',
          expect.any(Array),
          expect.stringContaining('opus-4.8'),
          true,
          undefined,
          'bot-a'
        ),
      WAIT
    )
    expect(conn.postBlocks).not.toHaveBeenCalled()
    expect(await (daemon as any).store.getStatusBarTs(SESSION_KEY)).toBe('111.1')

    release()
    await turn
    await daemon.stop()
  })

  it('never adopts a status line another Slack app authored — posts its own instead', async () => {
    // A shared multi-agent thread: each agent runs its own Slack app, and Slack only
    // lets a bot chat.update its own messages. Adopting the sibling's bar would fail
    // with cant_update_message on every usage tick (and show the wrong session's data).
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    ;(conn as any).botId = 'B-MINE'
    ;(conn as any).getThreadReplies = vi.fn(async () => [
      { sender: 'U1', ts: 'T1', text: 'hi', isBot: false, attachments: [] },
      {
        sender: 'B-OTHER',
        ts: '111.1',
        text: ':bar_chart: *sibling* - ctx 9k',
        isBot: true,
        chrome: true,
        chromeOwnerAgentId: 'bot-a',
        attachments: []
      }
    ])

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalled(), WAIT)
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === '111.1')).toBe(false)
    expect(await (daemon as any).store.getStatusBarTs(SESSION_KEY)).not.toBe('111.1')

    release()
    await turn
    await daemon.stop()
  })

  it('never adopts a sibling Agent status line when both share one Slack app', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    ;(conn as any).botId = 'B-SHARED'
    ;(conn as any).getThreadReplies = vi.fn(async () => [
      {
        sender: 'B-SHARED',
        ts: '111.1',
        text: ':bar_chart: *sibling* - ctx 9k',
        isBot: true,
        chrome: true,
        chromeOwnerAgentId: 'bot-b',
        attachments: []
      }
    ])

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalled(), WAIT)
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === '111.1')).toBe(false)
    expect(conn.postBlocks.mock.calls[0]?.[4]).toMatchObject({
      chrome: true,
      chromeOwnerAgentId: 'bot-a'
    })
    expect(await (daemon as any).store.getStatusBarTs(SESSION_KEY)).not.toBe('111.1')

    release()
    await turn
    await daemon.stop()
  })

  it('drops a persisted status-bar ts when Slack rejects the update, and reposts', async () => {
    // Heals rows poisoned by the pre-provenance adoption path: a foreign ts persisted
    // on the session keeps failing chat.update forever — after an explicit false the
    // ts must be discarded so a later status emit posts a fresh, editable bar.
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)

    // Turn 1: bar posted normally and its ts persisted.
    const turn1 = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    release()
    await turn1
    const posted = await (daemon as any).store.getStatusBarTs(SESSION_KEY)
    expect(posted).toBeTruthy()

    // Turn 2: Slack rejects every edit of that ts (cant_update_message).
    ;(conn.updateBlocks as any).mockResolvedValue(false)
    const second = modelHost()
    ;(daemon as any).opts.hostFactory = () => second.host as any
    const turn2 = (daemon as any).dispatch('bot-a', dm('101', 'hi again'), 'int-a')
    await vi.waitFor(
      () =>
        expect(conn.updateBlocks).toHaveBeenCalledWith(
          'C1',
          posted,
          expect.anything(),
          expect.anything(),
          true,
          undefined,
          'bot-a'
        ),
      WAIT
    )
    // The dead ts is dropped and a later emit in the same turn posts a fresh bar.
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(2), WAIT)
    await vi.waitFor(async () => expect(await (daemon as any).store.getStatusBarTs(SESSION_KEY)).not.toBe(posted), WAIT)

    second.release()
    await turn2
    await daemon.stop()
  })

  it('fetchThreadHistory skips daemon chrome (metadata-marked + status-bar text) but keeps conversation', async () => {
    const { host } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)
    ;(conn as any).botId = 'B-X'
    ;(conn as any).getThreadReplies = vi.fn(async () => [
      { sender: 'U1', ts: '1.1', text: 'human msg', isBot: false, chrome: false, attachments: [] },
      {
        sender: 'B-X',
        ts: '2.2',
        text: 'a peer reply',
        isBot: true,
        agentAuthorId: 'bot-x',
        chrome: false,
        attachments: []
      },
      { sender: 'B-X', ts: '3.3', text: 'tool progress', isBot: true, chrome: true, attachments: [] },
      { sender: 'B-X', ts: '4.4', text: ':bar_chart: *opus* - ctx 1.0k', isBot: true, chrome: false, attachments: [] }
    ])

    const history = await (daemon as any).fetchThreadHistory('bot-a', 'C1', 'T1')

    // The metadata-marked chrome ('tool progress') and the status-bar-shaped text are dropped;
    // the human message and the peer's real reply survive.
    expect(history.map((h: any) => h.text)).toEqual(['human msg', 'a peer reply'])
    await daemon.stop()
  })

  it('posts the status bar at turn START even before the model is known (no modelOptions)', async () => {
    // blockingHost advertises no modelOptions → the model/usage is unknown at turn start.
    // The bar must still appear as soon as the turn begins (overflow + View), filling in
    // the model later via chat.update — regression for "no status bar until first message".
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = routableWithBlocks(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    // Posted while the first prompt is STILL blocked — i.e. before any reply arrives.
    await vi.waitFor(() => expect(conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const blocks = conn.postBlocks.mock.calls[0]![1] as { type: string; accessory?: any }[]
    expect(blocks.find((b) => b.type === 'section')!.accessory.action_id).toBe('ac_more')

    blocked.release()
    await turn
    await daemon.stop()
  })

  it('the Configure modal (statusInfoForKey) carries the CP-provided View-session link', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(AGENT_IDENTITY),
      hostFactory: () => host as any
    })
    await daemon.start()
    routableWithBlocks(daemon)
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    // Simulate the CP sending its console origin on auth/ok (no local webAppUrl config).
    ;(daemon as any).cpWebAppUrl = 'https://console.example.com'

    const t1 = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)
    // The connection queries statusInfoForKey to build the modal; it resolves the deep link.
    const data = await (daemon as any).statusInfoForKey(SESSION_KEY)
    const outward = (await (daemon as any).store.getSessionByAcpId('acp-1'))!.sessionId
    expect(data.link).toBe(`https://console.example.com/sessions/${outward}?source=slack`)
    expect(data.info.models).toEqual(['opus-4.8', 'sonnet-5'])
    expect(data.identity).toMatchObject({
      name: AGENT_IDENTITY.displayName,
      agentUrl: 'https://console.example.com/agents/bot-a',
      iconUrl: AGENT_IDENTITY.iconUrl
    })
    expect(data.identity.sessionTitle).toBeUndefined()
    await (daemon as any).store.setSessionTitle(SESSION_KEY, 'Fix login flow')
    expect((await (daemon as any).statusInfoForKey(SESSION_KEY)).identity.sessionTitle).toBe('Fix login flow')
    expect(data.cancellable).toBe(true)
    release()
    await t1
    expect((await (daemon as any).statusInfoForKey(SESSION_KEY)).cancellable).toBe(false)
    await daemon.stop()
  })

  it('uses the local Web App default when neither local nor CP configuration provides an origin', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    ;(daemon as any).cfg = {}
    expect((daemon as any).sessionLink('acp-1')).toBe('http://localhost:3000/sessions/acp-1')
    expect((daemon as any).sessionLink('acp-1', 'slack')).toBe('http://localhost:3000/sessions/acp-1?source=slack')
    expect((daemon as any).sessionLink('acp-1', 'github')).toBe('http://localhost:3000/sessions/acp-1?source=github')
    expect((daemon as any).sessionLink('acp-1', 'lark')).toBe('http://localhost:3000/sessions/acp-1?source=lark')
    expect((daemon as any).sessionLink('acp-1', 'feishu')).toBe('http://localhost:3000/sessions/acp-1?source=feishu')
    expect((daemon as any).agentLink('bot-a')).toBe('http://localhost:3000/agents/bot-a')
  })

  it('uses the Feishu integration region as the session-link source hint', async () => {
    const daemon = new Daemon()
    ;(daemon as any).cfg = {}
    ;(daemon as any).agents.set('bot-a', {
      integrations: [
        {
          id: 'int-lark',
          platform: 'feishu',
          core: { mode: 'shared', bindRules: [] },
          config: { appId: 'cli_lark', appSecret: 'secret', region: 'lark' }
        }
      ]
    })

    const source = (daemon as any).sessionLinkSource('feishu', 'int-lark')
    expect(source).toBe('lark')
    expect((daemon as any).sessionLink('acp-1', source)).toBe('http://localhost:3000/sessions/acp-1?source=lark')
  })

  it('falls back to the probed runtime models when the persisted session is cold', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    routableWithBlocks(daemon)

    const key = SESSION_KEY
    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)
    release()
    await turn

    // An idle-reaped adapter no longer owns the persisted ACP id, while the
    // daemon-wide probe result still carries the runtime's model choices.
    host.hasSession.mockReturnValue(false)
    ;(host.modelOptions as any).mockReturnValue(null)
    ;(daemon as any).runtimeFacts.models.set('claude', ['default', 'opus[1m]', 'sonnet', 'haiku'])

    const fallback = (await (daemon as any).statusInfoForKey(key)).info
    expect(fallback.model).toBe('default')
    expect(fallback.models).toEqual(['default', 'opus[1m]', 'sonnet', 'haiku'])

    await (daemon as any).store.setModelOverride(key, 'opus[1m]')
    const info = (await (daemon as any).statusInfoForKey(key)).info
    expect(info.model).toBe('opus[1m]')
    expect(info.models).toEqual(['default', 'opus[1m]', 'sonnet', 'haiku'])
    await daemon.stop()
  })

  it('handleStatusAction routes set-model / cancel by session key', async () => {
    const { host, release } = modelHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = routableWithBlocks(daemon)
    const store = (daemon as any).store
    const key = SESSION_KEY

    const t1 = (daemon as any).dispatch('bot-a', dm('100', 'hi'), 'int-a')
    await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true), WAIT)

    // set-model: sticky override persisted + applied live to the running session.
    await (daemon as any).commands.handleStatusAction({ kind: 'set-model', sessionKey: key, model: 'sonnet-5' })
    expect(await store.getModelOverride(key)).toBe('sonnet-5')
    expect(host.setSessionModel).toHaveBeenCalledWith('acp-1', 'sonnet-5')

    // cancel: interrupts the in-flight turn WITHOUT muting.
    await (daemon as any).commands.handleStatusAction({ kind: 'cancel', sessionKey: key })
    expect(host.cancel).toHaveBeenCalledWith('acp-1')
    expect(await store.isSessionMuted(key)).toBe(false)
    await vi.waitFor(() => {
      const settledStatus = [...conn.updateBlocks.mock.calls]
        .reverse()
        .find((call) => statusActions(call[2] as any[]) !== undefined)
      expect(statusActions(settledStatus?.[2] as any[])).toEqual(['manage'])
    }, WAIT)

    release()
    await t1
    await daemon.stop()
  })
})

describe('Slack shared-bot thread displacement', () => {
  // A shared bot's thread runs ONE agent at a time: admitting a turn for a NEW message routed
  // to another session cancels the sibling's in-flight turn. Same-message siblings (one
  // fan-out, several recipients) coexist untouched. The displaced turn is marked so its
  // teardown leaves the status slot to its successor, whose admission-time `processing`
  // is then the slot's last write — no detached re-assert exists to race it.
  const conn = () => ({ setStatus: vi.fn() })
  const sibling = (over: Record<string, unknown> = {}) => ({
    conn: over.conn,
    entry: { msg: { msgId: (over.msgId as string) ?? 'm1' } } as Record<string, unknown>,
    plan: {
      platform: 'slack',
      sessionKey: 'slack:C1:T1:bot-b',
      channel: 'C1',
      statusThread: 'T1',
      ...(over.plan as Record<string, unknown>)
    }
  })
  const incoming = (c: unknown, over: Record<string, unknown> = {}) => ({
    conn: c,
    platform: 'slack',
    sessionKey: 'slack:C1:T1:bot-a',
    channel: 'C1',
    statusThread: 'T1',
    msgId: 'm2',
    ...over
  })

  const displaced = async (admitted: any, siblings: any[]) => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    const cancel = vi.fn(async () => true)
    ;(daemon as any).commands.cancelSessionByKey = cancel
    for (const [i, entry] of siblings.entries()) (daemon as any).pending.set(`sibling-${i}`, entry)
    await (daemon as any).cancelDisplacedSlackTurns(admitted)
    return cancel
  }

  it('cancels the sibling a NEW message displaces and hands it the status slot', async () => {
    const c = conn()
    const previous = sibling({ conn: c })
    const cancel = await displaced(incoming(c), [previous])
    expect(cancel).toHaveBeenCalledExactlyOnceWith('slack:C1:T1:bot-b')
    // Marked: the displaced turn's teardown must not settle the slot — the successor's
    // admission `processing` is already the last write, so nothing re-asserts here.
    expect(previous.entry.displacedByNewerTurn).toBe(true)
    expect(c.setStatus).not.toHaveBeenCalled()
  })

  it('leaves same-message fan-out siblings alone (one delivery, several recipients)', async () => {
    const c = conn()
    const peer = sibling({ conn: c })
    const cancel = await displaced(incoming(c, { msgId: 'm1' }), [peer])
    expect(cancel).not.toHaveBeenCalled()
    expect(peer.entry.displacedByNewerTurn).toBeUndefined()
    expect(c.setStatus).not.toHaveBeenCalled()
  })

  it('touches nothing across connections, conversations, platforms, or its own session', async () => {
    const c = conn()
    const siblings = [
      sibling({ conn: c, msgId: 'm3', plan: { sessionKey: 'slack:C1:T1:bot-a' } }), // its own session
      sibling({ conn: conn() }), // another bot
      sibling({ conn: c, plan: { sessionKey: 'slack:C1:T9:bot-b', statusThread: 'T9' } }), // another thread
      sibling({ conn: c, plan: { sessionKey: 'webchat:C1:T1:bot-b', platform: 'webchat' } }) // another platform
    ]
    const cancel = await displaced(incoming(c), siblings)
    expect(cancel).not.toHaveBeenCalled()
    expect(siblings.some((sib) => sib.entry.displacedByNewerTurn)).toBe(false)
    expect(c.setStatus).not.toHaveBeenCalled()
  })
})

describe('Slack status-slot settlement', () => {
  // Slack keeps ONE agent-session status slot per (app, channel, thread) while fan-out runs
  // several sibling turns against it. When a turn leaves the slot, settlement re-asserts the
  // newest surviving sibling's `processing` (the row keeps naming who is still working, and a
  // pending "Stopping…" resolves into it); only an empty thread transitions to `active`.
  const settle = (pendings: any[], exclude?: string) => {
    const c = { setStatus: vi.fn() }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    for (const [i, over] of pendings.entries())
      (daemon as any).pending.set(`p-${i}`, {
        conn: c,
        outputSuppressed: over.outputSuppressed,
        plan: {
          platform: 'slack',
          channel: 'C1',
          statusThread: 'T1',
          sessionKey: over.key,
          statusOptions: { username: over.name, sessionKey: over.key },
          ...(over.plan as Record<string, unknown>)
        }
      })
    ;(daemon as any).settleSlackSlot(c, 'C1', 'T1', exclude)
    return c.setStatus
  }

  it("re-asserts the newest surviving sibling's processing under its own identity", () => {
    const setStatus = settle(
      [
        { key: 'k-a', name: 'Agent A' },
        { key: 'k-b', name: 'Agent B' }
      ],
      'k-b'
    )
    expect(setStatus).toHaveBeenCalledExactlyOnceWith('C1', 'T1', 'is thinking…', {
      username: 'Agent A',
      sessionKey: 'k-a'
    })
  })

  it('clears only when no live sibling remains — suppressed and excluded turns do not count', () => {
    const setStatus = settle(
      [
        { key: 'k-a', outputSuppressed: 'cancel' },
        { key: 'k-b' },
        { key: 'k-c', plan: { statusThread: 'T9' } } // another thread
      ],
      'k-b'
    )
    expect(setStatus).toHaveBeenCalledExactlyOnceWith('C1', 'T1', '', undefined)
  })
})
