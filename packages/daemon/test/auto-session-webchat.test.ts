// auto-session-mode.md §10, webchat-threads.md §4: a member's private coordinator conversation in webchat, and the tasks it opens on its threads.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinatorConversationId, type RdChatEvent, type RdMsgWebchat } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { sessionHostKey } from '../src/acp/host-key.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import { isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { checkCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { WAIT } from './wait-support.js'
import { createSessionReader } from '../src/cp/session-reader.js'

const AGENT = 'bot-a'
const ORG = 'org-1'
const OWNER = 'user-1'
const CONV = coordinatorConversationId(ORG, OWNER, AGENT)

function scaffold(features: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-coordinator-webchat-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features,
      runtimes: {
        claude: { command: 'node', args: ['unused'] },
        codex: { command: 'node', args: ['unused'] },
        gemini: { command: 'node', args: ['unused'] }
      }
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
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

type Say = (text: string) => void

async function boot(
  prompt: (sessionId: string, text: string, say: Say) => Promise<unknown>,
  features: Record<string, unknown> = { autoSessionMode: true }
) {
  let sessions = 0
  let onUpdate: (sessionId: string, update: unknown) => void = () => {}
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++sessions}`),
    prompt: vi.fn(async (sessionId: string, blocks: { type: string; text?: string }[]) => {
      await prompt(sessionId, blocks.map((block) => block.text ?? '').join('\n'), (text) =>
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      )
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn()
  }
  const root = scaffold(features)
  // The runtime of each host the daemon starts, in order.
  const hostRuntimes: string[] = []
  const daemon = new Daemon({
    root,
    hostFactory: (agent, update) => {
      hostRuntimes.push((agent as { runtime: string }).runtime)
      onUpdate = update
      return host as never
    }
  })
  await daemon.start()
  const d = daemon as any
  d.orgForAgent = () => ORG
  const posts: { text: string; initiator?: string; taskLink?: unknown; thread?: string }[] = []
  d.relays = {
    stop: vi.fn(async () => {}),
    sendWebchatPost: vi.fn(
      (post: { post: { text: string; taskLink?: unknown; thread?: string }; initiator?: string }) =>
        posts.push({
          text: post.post.text,
          ...(post.initiator ? { initiator: post.initiator } : {}),
          ...(post.post.taskLink ? { taskLink: post.post.taskLink } : {}),
          ...(post.post.thread ? { thread: post.post.thread } : {})
        })
    )
  }
  let turns = 0
  /** One browser turn by `user`, onto a session the Control Plane verified when `targetSessionId` is set; resolves once its stream is done. */
  /** One browser turn's frame and its ack, in the thread under `thread` when one is named. */
  const turn = async (text: string, user = OWNER, chatId = CONV, targetSessionId?: string, thread?: string) => {
    const n = ++turns
    const turnId = `7777777${n}-7777-4777-8777-777777777777`
    const postId = `5555555${n}-5555-4555-8555-555555555555`
    const events: RdChatEvent[] = []
    const msg: RdMsgWebchat = {
      source: 'webchat',
      agentId: AGENT,
      sessionKey: chatId,
      msgId: `m-${n}`,
      chatId,
      ...(targetSessionId ? { targetSessionId } : {}),
      payload: {
        op: 'turn',
        text,
        user,
        userId: user,
        turnId,
        post: { postId, at: 1_000 + n },
        ...(thread ? { thread } : {})
      }
    }
    const ack = await d.handleRelayMsg(msg, (event: RdChatEvent) => events.push(event))
    return { ack, events, postId }
  }
  const send = async (text: string, user = OWNER, chatId = CONV, targetSessionId?: string, thread?: string) => {
    const { ack, events, postId } = await turn(text, user, chatId, targetSessionId, thread)
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const streamed = events
      .flatMap((event) =>
        event.kind === 'output' && event.output.event?.kind === 'message' ? [event.output.event.text] : []
      )
      .join('')
    return { messageId: `msg-${postId}`, postId, streamed, events }
  }
  const coordinator = async (): Promise<{ key: string; ctx: SessionContext }> => {
    const coordinate = await d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')
    return {
      key: sessionKey('webchat', CONV, coordinate, AGENT),
      ctx: {
        agentId: AGENT,
        platform: 'webchat',
        channel: CONV,
        thread: coordinate,
        isDm: true,
        tools: coordinatorSessionTools([])
      } as SessionContext
    }
  }
  /** Write `patch` into the agent's agent.json and converge, as a spec from the Control Plane does. */
  const updateAgent = async (patch: Record<string, unknown>) => {
    const path = join(root, 'agents', AGENT, 'agent.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }))
    await daemon.reconcile()
  }
  return { daemon, d, host, posts, turn, send, coordinator, hostRuntimes, updateAgent }
}

describe("a member's coordinator conversation in webchat (auto-session-mode.md §10)", () => {
  it('runs every message on the coordinator, addressed to it, and streams a one-message reply once', async () => {
    const prompts: string[] = []
    const { daemon, d, host, posts, send } = await boot(async (_id, text, say) => {
      prompts.push(text)
      say('You are welcome.')
    })
    const { messageId, streamed, postId } = await send('thanks!')
    expect(prompts[0]).toContain(`<message id="${messageId}" from="${OWNER}" mentions-you="yes">\nthanks!\n</message>`)
    expect(streamed).toBe('You are welcome.')
    // The browser's own turn commits the reply; the coordinator posts nothing beside it.
    expect(posts).toEqual([{ text: 'You are welcome.' }])
    const coordinate = await d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')
    expect(isCoordinatorCoordinate(coordinate)).toBe(true)
    expect(await d.store.getSession(sessionKey('webchat', CONV, coordinate, AGENT))).toBeDefined()
    expect(await d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeUndefined()
    // Authorization belongs to the Control Plane; another admitted sender keeps this coordinator and their own identity.
    const member = 'user-2'
    await send('hello from a member', member)
    await send('a reply from a member', member, CONV, undefined, postId)
    expect(prompts[1]).toContain(`from="${member}" mentions-you="yes">\nhello from a member`)
    expect(prompts[2]).toContain(`from="${member}" mentions-you="yes" thread="${messageId}">\na reply from a member`)
    expect(host.newSession).toHaveBeenCalledTimes(1)
    expect(await d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')).toBe(coordinate)
    expect(await d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeUndefined()
    await daemon.stop()
  })

  it("sets its coordinator's model for itself, as a task's thread sets the task", async () => {
    const { daemon, d, host, send, coordinator } = await boot(async (_id, _text, say) => say('ok'))
    d.agents.get(AGENT).chatActions = 'settings'
    const setSessionModel = vi.fn(async () => true)
    // The live session takes the change at once; the next turn keeps it.
    Object.assign(host, { setSessionModel, hasSession: () => true })
    await send('hello')
    const set: RdMsgWebchat = {
      source: 'webchat',
      agentId: AGENT,
      sessionKey: CONV,
      msgId: 'm-set',
      chatId: CONV,
      payload: { op: 'set_model', model: 'model-small', callerRole: 'owner' }
    }
    expect(await d.handleRelayMsg(set, () => {})).toMatchObject({ accepted: true })
    const { key } = await coordinator()
    expect(await d.store.getModelOverride(key)).toBe('model-small')
    expect(await d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeUndefined()
    await send('again')
    expect(setSessionModel).toHaveBeenCalledWith(expect.any(String), 'model-small')
    await daemon.stop()
  })

  it('starts a provider-bound host on the coordinator model, whose credential its provider decides', async () => {
    const { daemon, d, host, send, coordinator } = await boot(async (_id, _text, say) => say('ok'))
    d.agents.get(AGENT).coordinatorModel = { runtime: 'claude', model: 'model-small' }
    Object.assign(host, { setSessionModel: vi.fn(async () => true) })
    vi.spyOn(d.modelSessions, 'enabled', 'get').mockReturnValue(true)
    const ensure = vi.spyOn(d.modelSessions, 'ensure').mockImplementation(async (_agent: unknown, key: unknown) => ({
      host,
      hostKey: sessionHostKey(AGENT, key as string),
      stop: async () => {},
      waitForCleanup: async () => {}
    }))
    await send('hello')
    const { key } = await coordinator()
    expect(ensure).toHaveBeenCalledWith(expect.anything(), key, 'model-small')
    await daemon.stop()
  })

  it('moves a running coordinator to the runtime its setting names at its next turn, and back', async () => {
    const { daemon, d, host, send, coordinator, hostRuntimes } = await boot(async (_id, _text, say) => say('ok'))
    Object.assign(host, { setSessionModel: vi.fn(async () => true) })
    await send('hello')
    expect(hostRuntimes).toEqual(['claude'])
    d.agents.get(AGENT).coordinatorModel = { runtime: 'codex', model: 'model-small' }
    await send('again')
    expect(hostRuntimes.at(-1)).toBe('codex')
    const { key } = await coordinator()
    // Never pinned, so a setting back on the agent's runtime moves it back too.
    expect((await d.store.getSession(key))?.decisionModel ?? null).toBeNull()
    d.agents.get(AGENT).coordinatorModel = { runtime: 'claude', model: 'model-small' }
    const before = hostRuntimes.length
    await send('and back')
    expect(d.hostKeyFor(AGENT, key)).toBe(d.hostKeyFor(AGENT))
    expect(hostRuntimes.length).toBe(before)
    await daemon.stop()
  })

  it('relaunches its own host on the new runtime when the host key stays the same', async () => {
    const { daemon, d, host, send, coordinator, hostRuntimes } = await boot(async (_id, _text, say) => say('ok'))
    Object.assign(host, { setSessionModel: vi.fn(async () => true) })
    d.agents.get(AGENT).coordinatorModel = { runtime: 'codex', model: 'model-small' }
    await send('hello')
    const { key } = await coordinator()
    const own = d.hostKeyFor(AGENT, key)
    expect(hostRuntimes.at(-1)).toBe('codex')
    d.agents.get(AGENT).coordinatorModel = { runtime: 'gemini', model: 'model-small' }
    await send('again')
    expect(d.hostKeyFor(AGENT, key)).toBe(own)
    expect(hostRuntimes.at(-1)).toBe('gemini')
    await daemon.stop()
  })

  it("drops what a coordinator chat set for itself when the agent's coordinator setting changes, and only then", async () => {
    const { daemon, d, host, send, coordinator, updateAgent } = await boot(async (_id, _text, say) => say('ok'))
    Object.assign(host, { setSessionModel: vi.fn(async () => true), hasSession: () => true })
    await updateAgent({ chatActions: 'settings' })
    await send('hello')
    const set: RdMsgWebchat = {
      source: 'webchat',
      agentId: AGENT,
      sessionKey: CONV,
      msgId: 'm-set',
      chatId: CONV,
      payload: { op: 'set_model', model: 'model-small', callerRole: 'owner' }
    }
    expect(await d.handleRelayMsg(set, () => {})).toMatchObject({ accepted: true })
    const { key } = await coordinator()
    await updateAgent({ description: 'be terse' })
    expect(await d.store.getModelOverride(key)).toBe('model-small')
    await updateAgent({ coordinatorModel: { runtime: 'claude', model: 'model-large' } })
    expect(await d.store.getModelOverride(key)).toBeUndefined()
    await daemon.stop()
  })

  it('refuses whatever its runtime would ask, without asking anyone', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const { daemon, d, send } = await boot(async (_id, _text, say) => {
      await held
      say('ok')
    })
    const turn = send('hello')
    await vi.waitFor(
      () => expect([...d.pending.values()].some((p: any) => isCoordinatorCoordinate(p.plan.sessionThread))).toBe(true),
      WAIT
    )
    const p = [...d.pending.values()].find((turn: any) => isCoordinatorCoordinate(turn.plan.sessionThread)) as any
    const answer = await d.permissions.onAcpPermission(p.hostKey, p.acpSessionId, {
      sessionId: p.acpSessionId,
      toolCall: { toolCallId: 'tc-1', title: 'touch probe.txt', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    release()
    await turn
    await daemon.stop()
  })

  // webchat-threads.md §5.1: each post is recorded in its physical thread, and a thread must name a root of the conversation.
  it('records a root in its own thread and a reply in its root’s, and refuses a thread that names no root', async () => {
    const prompts: string[] = []
    const { daemon, d, turn, send } = await boot(async (_id, text, say) => {
      prompts.push(text)
      say('ok')
    })
    const channel = transcriptChannelKey(CONV)
    const root = await send('first')
    expect(await d.store.threadForPlatformMessage(channel, root.postId)).toBe(root.postId)
    const reply = await send('second', OWNER, CONV, undefined, root.postId)
    expect(await d.store.threadForPlatformMessage(channel, reply.postId)).toBe(root.postId)
    // The coordinator is told where the reply sits.
    expect(prompts[1]).toContain(`thread="msg-${root.postId}"`)
    expect(prompts[0]).not.toContain('thread="')
    for (const thread of [reply.postId, '66666666-6666-4666-8666-666666666666']) {
      const refused = await turn('third', OWNER, CONV, undefined, thread)
      expect(refused.ack).toMatchObject({ accepted: false, reason: 'unknown_thread' })
      expect(await d.store.threadForPlatformMessage(channel, refused.postId)).toBeUndefined()
    }
    expect(prompts).toHaveLength(2)
    await daemon.stop()
  })

  it('refuses a thread in an ordinary conversation and on a continued session that holds none', async () => {
    const { daemon, d, turn, send } = await boot(async (_id, _text, say) => say('ok'))
    const root = await send('hello', 'user-2')
    expect(await d.store.threadForPlatformMessage(transcriptChannelKey(CONV), root.postId)).toBe(`webchat:${CONV}`)
    expect((await turn('again', 'user-2', CONV, undefined, root.postId)).ack).toMatchObject({
      accepted: false,
      reason: 'unknown_thread'
    })
    const session = await d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))
    const continued = await turn('more', OWNER, '99999999-9999-4999-8999-999999999999', session.sessionId, root.postId)
    expect(continued.ack).toMatchObject({ accepted: false, reason: 'unknown_thread' })
    await daemon.stop()
  })

  it("keeps someone else's conversation, and every conversation with the switch off, an ordinary one", async () => {
    const plain = await boot(async (_id, _text, say) => say('hi'), { autoSessionMode: false })
    await plain.send('hello')
    expect(await plain.d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeDefined()
    await plain.daemon.stop()
    const other = await boot(async (_id, _text, say) => say('hi'))
    await other.send('hello', 'user-2')
    expect(await other.d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')).toBeUndefined()
    expect(await other.d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeDefined()
    await other.daemon.stop()
    // auto-session-mode.md §3.6: the member's own conversation is an ordinary one with the coordinator off.
    const off = await boot(async (_id, _text, say) => say('hi'))
    off.d.agents.get(AGENT).coordinatorDisabled = true
    await off.send('hello')
    expect(await off.d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')).toBeUndefined()
    expect(await off.d.store.getSession(sessionKey('webchat', CONV, `webchat:${CONV}`, AGENT))).toBeDefined()
    await off.daemon.stop()
  })

  it.each(['workspace', 'runtime'] as const)(
    'reports a task %s failure in its thread and permits retry',
    async (stage) => {
      let failing = true
      let taskKey = ''
      const booted = await boot(async (_id, text, say) => {
        const messageId = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
        if (messageId) {
          taskKey ||= sessionKey('webchat', CONV, messageId.slice(4), AGENT)
          const { ctx } = await booted.coordinator()
          await booted.d.coordinators.decide(ctx, { action: 'delegateTask', messageId, title: 'Check repository' })
          say('AC_NO_RESPONSE')
        } else {
          if (stage === 'runtime' && failing) {
            say('Checking.')
            throw new Error('Provider rejected the request')
          }
          say('Recovered.')
        }
      })
      const { d, posts, send, daemon } = booted
      const prepare = d.prepareAgentWorkspace.bind(d)
      const preparation = vi.spyOn(d, 'prepareAgentWorkspace').mockImplementation((...args) => {
        if (stage === 'workspace' && failing && (args[2] as { sessionKey?: string })?.sessionKey === taskKey)
          throw new Error(
            "git clone failed: Cloning into '/home/agent/workspace'...\n" +
              "fatal: unable to access 'https://example-user:example-credential@git.example.test/example-repo.git': The requested URL returned error: 403"
          )
        return prepare(...args)
      })
      try {
        const first = await send('check repository access')
        const index = d.store.assistantSubsessions
        expect(await index.get(AGENT, taskKey)).toMatchObject({ state: 'failed' })
        expect(posts).toEqual([
          ...(stage === 'runtime' ? [{ text: 'Checking.', initiator: 'agent', thread: first.postId }] : []),
          {
            text: expect.stringContaining(stage === 'workspace' ? '403' : 'Provider rejected the request'),
            initiator: 'agent',
            thread: first.postId
          }
        ])
        const failure = posts.at(-1)!.text
        expect(failure).not.toMatch(/example-credential|git\.example\.test|\/home\/agent/)
        const { key } = await booted.coordinator()
        const reader = createSessionReader(d.store)
        const thread = await reader.thread({
          agentId: AGENT,
          sessionId: await d.store.ensureOutwardSessionId(key, AGENT),
          rootId: first.postId,
          limit: 50
        })
        expect(thread.messages.filter((message) => message.text === failure)).toHaveLength(1)
        if (stage === 'workspace') {
          expect(await d.store.getSession(taskKey)).toBeUndefined()
          expect(thread.summary?.task).toBeUndefined()
          expect(await index.threadsOf(AGENT, taskKey)).toEqual([])
        } else {
          expect(thread.summary?.task).toMatchObject({ state: 'failed' })
          expect(await index.threadsOf(AGENT, taskKey)).toHaveLength(1)
        }

        failing = false
        await send('try again', OWNER, CONV, undefined, first.postId)
        expect(posts.at(-1)).toMatchObject({ text: 'Recovered.', thread: first.postId })
        expect(await index.get(AGENT, taskKey)).toMatchObject({ state: 'done' })
        expect(await index.threadsOf(AGENT, taskKey)).toHaveLength(1)
      } finally {
        preparation.mockRestore()
        await daemon.stop()
      }
    }
  )

  // webchat-threads.md §4: a task opens on the message's thread and answers there, as a Slack coordinator's does.
  it("opens a task on the message's thread, which answers there, takes the thread's replies, and is handed and fallen back to", async () => {
    const live: { d?: any } = {}
    const coordinatorPrompts: string[] = []
    const taskPrompts: string[] = []
    let taskId = ''
    // What the coordinator does with each message, by its text.
    const script: Record<string, (messageId: string) => Record<string, unknown> | undefined> = {
      'fix the retry': (messageId) => ({ action: 'delegateTask', messageId, title: 'Fix the retry' }),
      'also handle 429': (messageId) => ({ action: 'messageTask', messageId, taskId }),
      'how is it going?': (messageId) => ({ action: 'replyToMessage', messageId, message: 'Still on it.' }),
      'what next?': () => undefined
    }
    const booted = await boot(async (_id, text, say) => {
      const id = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
      if (id === undefined) {
        taskPrompts.push(text)
        say(`task answer ${taskPrompts.length}`)
        return
      }
      coordinatorPrompts.push(text)
      const body = /mentions-you="yes"(?: thread="[^"]+")?>\n([^\n]*)\n/.exec(text)?.[1] ?? ''
      const call = script[body]?.(id)
      if (call) {
        const { ctx } = await booted.coordinator()
        const receipt = (await live.d.coordinators.decide(ctx, call)) as { taskId?: string; posted?: unknown }
        receipts.push(receipt)
        if (receipt.taskId) taskId = receipt.taskId
        if (receipt.posted) replies.push(receipt.posted)
      }
      say('AC_NO_RESPONSE')
    })
    const replies: unknown[] = []
    const receipts: unknown[] = []
    const { d, posts, send } = booted
    live.d = d
    const index = d.store.assistantSubsessions
    const channel = transcriptChannelKey(CONV)

    const first = await send('fix the retry')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(1), WAIT)
    await vi.waitFor(() => expect(posts).toHaveLength(1), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const { key: coordinatorKey } = await booted.coordinator()
    // The task is keyed on the root's thread in the conversation, as a Slack threaded task is (§5.2).
    expect(taskId).toBe(sessionKey('webchat', CONV, first.postId, AGENT))
    expect(await index.get(AGENT, taskId)).toMatchObject({
      parentSessionKey: coordinatorKey,
      title: 'Fix the retry',
      state: 'done'
    })
    expect(await index.threadsOf(AGENT, taskId)).toMatchObject([{ channel: CONV, thread: first.postId }])
    expect(taskPrompts[0]).toContain('fix the retry')
    expect(taskPrompts[0]).toContain('The coordinator of this channel opened you for a message in this thread')
    expect(taskPrompts[0]).not.toContain('console conversation opened you')
    expect((await d.store.getSession(taskId))?.originSessionId).toBe(
      await d.store.ensureOutwardSessionId(coordinatorKey, AGENT)
    )
    expect(first.streamed).toBe('')
    // No link card: the task's answer is its post in the root's thread, recorded there.
    expect(posts).toEqual([{ text: 'task answer 1', initiator: 'agent', thread: first.postId }])
    const inRoot = await d.store.transcriptPage(channel, first.postId, null, 50, AGENT)
    expect(inRoot.rows.map((row: { text: string }) => row.text).sort()).toEqual(['fix the retry', 'task answer 1'])
    expect(coordinatorPrompts).toHaveLength(1)
    expect(coordinatorPrompts[0]).toContain(
      'The task answers in its own thread: a message at the conversation root joins'
    )

    // A reply in the thread the task holds goes to the task, never the coordinator, and streams in that thread.
    const reply = await send('use jitter too', OWNER, CONV, undefined, first.postId)
    expect(reply.streamed).toBe('task answer 2')
    expect(taskPrompts[1]).toContain('use jitter too')
    expect(coordinatorPrompts).toHaveLength(1)
    const frames = reply.events.map((event) => (event.kind === 'output' ? event.output.thread : event.done.thread))
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((thread) => thread === first.postId)).toBe(true)
    expect(posts.at(-1)).toEqual({ text: 'task answer 2', thread: first.postId })

    // A root handed to the task joins the task's thread, where the task answers; its own thread is not attached and no link card is posted.
    const second = await send('also handle 429')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(3), WAIT)
    await vi.waitFor(() => expect(posts.at(-1)?.text).toBe('task answer 3'), WAIT)
    expect(taskPrompts[2]).toContain('also handle 429')
    expect(receipts.at(-1)).toEqual({ ok: true, taskId, joinedThread: `msg-${first.postId}` })
    expect((await index.threadsOf(AGENT, taskId)).map((one: { thread: string }) => one.thread)).toEqual([first.postId])
    expect(posts.at(-1)).toEqual({ text: 'task answer 3', initiator: 'agent', thread: first.postId })
    expect(posts.some((post) => post.taskLink !== undefined)).toBe(false)
    // The person's row stays at the root, marked as handed into the task's thread, where the answer is recorded.
    const handedRows = await d.store.transcriptPage(channel, second.postId, null, 50, AGENT)
    expect(handedRows.rows.map((row: { text: string; handedTo?: string }) => [row.text, row.handedTo])).toEqual([
      ['also handle 429', first.postId]
    ])
    const inTaskThread = await d.store.transcriptPage(channel, first.postId, null, 50, AGENT)
    expect(inTaskThread.rows.map((row: { text: string }) => row.text)).toContain('task answer 3')

    // A reply by call is the coordinator's own post in the message's thread.
    const asked = await send('how is it going?')
    expect(posts.at(-1)).toEqual({ text: 'Still on it.', initiator: 'agent', thread: asked.postId })
    expect(replies.at(-1)).toEqual({ channel: CONV, thread: asked.messageId })
    const answered = await d.store.transcriptPage(channel, asked.postId, null, 50, AGENT)
    expect(answered.rows.map((row: { text: string }) => row.text)).toContain('Still on it.')
    // It is a message of that thread, so the coordinator page shows it there and not in its timeline (§6.1, §8).
    expect(answered.rows.find((row: { text: string }) => row.text === 'Still on it.')?.body).toBe(
      JSON.stringify({ threadPost: true })
    )
    const coordinatorId = await d.store.ensureOutwardSessionId(coordinatorKey, AGENT)
    const reader = createSessionReader(d.store)
    const timeline = await reader.history({ agentId: AGENT, sessionId: coordinatorId, limit: 50, view: 'roots' })
    expect(timeline.messages.map((m) => m.text)).toContain('how is it going?')
    expect(timeline.messages.map((m) => m.text)).not.toContain('Still on it.')
    const inThread = await reader.thread({ agentId: AGENT, sessionId: coordinatorId, rootId: asked.postId, limit: 50 })
    expect(inThread.messages.map((m) => m.text)).toEqual(['how is it going?', 'Still on it.'])
    expect(timeline.threads?.find((t) => t.rootId === first.postId)).toMatchObject({
      task: { title: 'Fix the retry' },
      replies: 5,
      lastReply: { excerpt: 'task answer 3' }
    })
    // The handed root stays in the timeline with no footer of its own, and reads as a reply in the task's thread.
    const handed = timeline.messages.find((m) => m.text === 'also handle 429')
    expect(handed).toMatchObject({ handedTo: first.postId })
    expect(handed?.thread).toBeUndefined()
    expect(timeline.threads?.some((t) => t.rootId === second.postId)).toBe(false)
    const taskThread = await reader.thread({
      agentId: AGENT,
      sessionId: coordinatorId,
      rootId: first.postId,
      limit: 50
    })
    expect(taskThread.messages.map((m) => [m.text, m.handedTo])).toEqual([
      ['fix the retry', undefined],
      ['task answer 1', undefined],
      ['use jitter too', undefined],
      ['task answer 2', undefined],
      ['also handle 429', first.postId],
      ['task answer 3', undefined]
    ])
    expect(taskThread.summary).toMatchObject({ replies: 5, lastReply: { excerpt: 'task answer 3' } })

    // Every message is addressed to the agent, so one left undecided opens a task on its own thread.
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const third = await send('what next?')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(4), WAIT)
    const fallback = sessionKey('webchat', CONV, third.postId, AGENT)
    expect(await index.get(AGENT, fallback)).toMatchObject({ title: 'what next?', parentSessionKey: coordinatorKey })
    await vi.waitFor(
      () => expect(posts.at(-1)).toEqual({ text: 'task answer 4', initiator: 'agent', thread: third.postId }),
      WAIT
    )
    expect(coordinatorPrompts).toHaveLength(4)
    await booted.daemon.stop()
  })

  // webchat-threads.md §6.3: another member of a published coordinator writes in a thread a task holds, through the task's session.
  it("lets another member write in a task's threads through its session, and in no other thread", async () => {
    const live: { d?: any } = {}
    const coordinatorPrompts: string[] = []
    const taskPrompts: string[] = []
    let taskId = ''
    const script: Record<string, (messageId: string) => Record<string, unknown>> = {
      'fix the retry': (messageId) => ({ action: 'delegateTask', messageId, title: 'Fix the retry' }),
      'also handle 429': (messageId) => ({ action: 'messageTask', messageId, taskId }),
      'how is it going?': (messageId) => ({ action: 'replyToMessage', messageId, message: 'Still on it.' }),
      'any news?': (messageId) => ({ action: 'replyToMessage', messageId, message: 'Not yet.' })
    }
    const booted = await boot(async (_id, text, say) => {
      const id = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
      if (id === undefined) {
        taskPrompts.push(text)
        say(`task answer ${taskPrompts.length}`)
        return
      }
      coordinatorPrompts.push(text)
      const body = /mentions-you="yes"(?: thread="[^"]+")?>\n([^\n]*)\n/.exec(text)?.[1] ?? ''
      const call = script[body]?.(id)
      if (call) {
        const { ctx } = await booted.coordinator()
        const receipt = (await live.d.coordinators.decide(ctx, call)) as { taskId?: string }
        if (receipt.taskId) taskId = receipt.taskId
      }
      say('AC_NO_RESPONSE')
    })
    const { d, posts, turn, send } = booted
    live.d = d
    const channel = transcriptChannelKey(CONV)
    const settle = () => vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const first = await send('fix the retry')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(1), WAIT)
    await settle()
    // A message in an unowned thread handed to the task attaches that thread to it.
    const second = await send('how is it going?')
    await settle()
    await send('also handle 429', OWNER, CONV, undefined, second.postId)
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(2), WAIT)
    await settle()
    const unowned = await send('any news?')
    await settle()
    const asked = coordinatorPrompts.length
    const task = (await d.store.getSession(taskId)).sessionId
    // The member writes from the task's page on a conversation of their own, which the Control Plane verified.
    const MEMBER = 'user-2'
    const PAGE = '99999999-9999-4999-8999-999999999999'
    const postCount = posts.length

    // Without a thread the message is a reply in the thread the task was opened on, and the task answers it.
    const onTask = await send('add a test', MEMBER, PAGE, task)
    expect(onTask.streamed).toBe('task answer 3')
    expect(taskPrompts[2]).toContain('add a test')
    expect(await d.store.threadForPlatformMessage(channel, onTask.postId)).toBe(first.postId)
    const inFirst = await d.store.transcriptPage(channel, first.postId, null, 50, AGENT)
    expect(inFirst.rows.map((row: { text: string }) => row.text)).toEqual(
      expect.arrayContaining(['add a test', 'task answer 3'])
    )
    // Its stream is the member's own page, which has no threads; nothing is posted to the owner's conversation.
    expect(
      onTask.events.every((event) => (event.kind === 'output' ? event.output.thread : event.done.thread) === undefined)
    ).toBe(true)
    expect(posts.slice(postCount).every((post) => post.thread === undefined && post.initiator === undefined)).toBe(true)

    // Another thread the task holds takes the reply there, on the same session.
    const inSecond = await send('and 503', MEMBER, PAGE, task, second.postId)
    expect(inSecond.streamed).toBe('task answer 4')
    expect(await d.store.threadForPlatformMessage(channel, inSecond.postId)).toBe(second.postId)
    expect((await d.store.getSession(taskId)).sessionId).toBe(task)

    // A thread no task holds reaches the coordinator, which is the owner's alone; a closed task holds none.
    const refused = await turn('me too', MEMBER, PAGE, task, unowned.postId)
    expect(refused.ack).toMatchObject({ accepted: false, reason: 'unknown_thread' })
    expect(await d.store.threadForPlatformMessage(channel, refused.postId)).toBeUndefined()
    expect(await d.store.assistantSubsessions.closeTask(AGENT, taskId)).toBe(true)
    expect((await turn('still there?', MEMBER, PAGE, task)).ack).toMatchObject({ accepted: false, reason: 'not_found' })
    expect(taskPrompts).toHaveLength(4)
    expect(coordinatorPrompts).toHaveLength(asked)
    await booted.daemon.stop()
  })

  // webchat-threads.md §4: a task opened on a thread reads what was said there before it.
  it('opens a task on a thread with the thread so far, the coordinator’s answers included', async () => {
    const live: { d?: any } = {}
    const taskPrompts: string[] = []
    const booted = await boot(async (_id, text, say) => {
      const id = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
      if (id === undefined) {
        taskPrompts.push(text)
        say('on it')
        return
      }
      const body = /mentions-you="yes"(?: thread="[^"]+")?>\n([^\n]*)\n/.exec(text)?.[1] ?? ''
      const call =
        body === 'is the retry flaky?'
          ? { action: 'replyToMessage', messageId: id, message: 'It failed twice this week.' }
          : { action: 'delegateTask', messageId: id, title: 'Fix the retry' }
      const { ctx } = await booted.coordinator()
      await live.d.coordinators.decide(ctx, call)
      say('AC_NO_RESPONSE')
    })
    const { d, send } = booted
    live.d = d
    const root = await send('is the retry flaky?')
    await send('then fix it please', OWNER, CONV, undefined, root.postId)
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(1), WAIT)
    const index = d.store.assistantSubsessions
    expect(
      await index.taskOfThread(AGENT, { platform: 'webchat', channel: CONV, transportScope: '', thread: root.postId })
    ).toBe(sessionKey('webchat', CONV, root.postId, AGENT))
    expect(taskPrompts[0]).toContain('is the retry flaky?')
    expect(taskPrompts[0]).toContain('It failed twice this week.')
    expect(taskPrompts[0]).toContain('then fix it please')
    await booted.daemon.stop()
  })

  // webchat-threads.md §10: a page task opened before threads keeps its page and link cards until it closes.
  it('moves a message handed to a legacy page task onto its page and links it in the message’s thread', async () => {
    const live: { d?: any } = {}
    const taskPrompts: string[] = []
    let pageTask = ''
    const booted = await boot(async (_id, text, say) => {
      const id = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
      if (id === undefined) {
        taskPrompts.push(text)
        say('page answer')
        return
      }
      const body = /mentions-you="yes"(?: thread="[^"]+")?>\n([^\n]*)\n/.exec(text)?.[1] ?? ''
      const { ctx } = await booted.coordinator()
      await live.d.coordinators.decide(
        ctx,
        body === 'also handle 429'
          ? { action: 'messageTask', messageId: id, taskId: pageTask }
          : { action: 'replyToMessage', messageId: id, message: 'Hi.' }
      )
      say('AC_NO_RESPONSE')
    })
    const { d, posts, send } = booted
    live.d = d
    await send('hello')
    const { key: coordinatorKey } = await booted.coordinator()
    const index = d.store.assistantSubsessions
    const now = Date.now()
    pageTask = sessionKey('webchat', `a2a:${AGENT}`, subsessionCoordinate('1700000000000001'), AGENT)
    await index.open({
      agentId: AGENT,
      childSessionKey: pageTask,
      parentSessionId: await d.store.ensureOutwardSessionId(coordinatorKey, AGENT, now),
      parentSessionKey: coordinatorKey,
      title: 'Fix the retry',
      background: 'fix the retry',
      openedFor: { place: `webchat:${CONV}`, messageId: 'msg-legacy' },
      now
    })
    await index.attachThread({
      agentId: AGENT,
      childSessionKey: pageTask,
      platform: 'webchat',
      channel: CONV,
      transportScope: '',
      thread: '44444444-4444-4444-8444-444444444444',
      sinceRound: 1,
      now
    })
    const handed = await send('also handle 429')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(1), WAIT)
    expect(taskPrompts[0]).toContain('also handle 429')
    expect(taskPrompts[0]).toContain("The coordinator of a person's console conversation opened you")
    const sessionId = await d.store.ensureOutwardSessionId(pageTask, AGENT)
    expect(posts.at(-1)).toEqual({
      text: `Passed to [Fix the retry](${d.sessionLink(sessionId)})`,
      initiator: 'agent',
      taskLink: { sessionId, title: 'Fix the retry', how: 'handed' },
      thread: handed.postId
    })
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    // Its answer stays on its page: nothing of it is posted in the conversation.
    expect(posts.some((post) => post.text === 'page answer')).toBe(false)
    await booted.daemon.stop()
  })

  // auto-session-mode.md §6.9.1: an approved proposal has no card here, so its root is the agent's own post.
  it('gives an approved proposal a root in the conversation, answers in its thread, and takes the thread’s replies', async () => {
    const taskPrompts: string[] = []
    const live: { d?: any } = {}
    const booted = await boot(async (_id, text, say) => {
      const id = /<message id="(msg-[^"]+)"/.exec(text)?.[1]
      if (id === undefined) {
        taskPrompts.push(text)
        say(`task answer ${taskPrompts.length}`)
        return
      }
      // The coordinator answers its member itself, so no task opens for the greeting.
      const { ctx } = await booted.coordinator()
      await live.d.coordinators.decide(ctx, { action: 'replyToMessage', messageId: id, message: 'Hi.' })
      say('AC_NO_RESPONSE')
    })
    const { d, posts, send } = booted
    live.d = d
    const index = d.store.assistantSubsessions
    // A proposal comes from a follow-up's check, which only an assistant-mode agent runs.
    await booted.updateAgent({ assistantMode: { enabled: true } })
    // The conversation's coordinator exists once its member wrote there.
    await send('hello')
    const { key: coordinatorKey } = await booted.coordinator()
    const coordinatorSession = await d.store.ensureOutwardSessionId(coordinatorKey, AGENT)
    const origin = { platform: 'webchat', channel: CONV }
    const followUp = await d.followUpChecks.take({
      agentId: AGENT,
      origin,
      caller: { sessionId: coordinatorSession, key: coordinatorKey },
      title: 'The nightly check',
      doneWhen: 'Each finding has an owner.',
      asker: `user:${OWNER}`
    })
    const sentence = 'I want to check the nightly findings because nobody owns them.'
    const draft = await d.store.assistantDrafts.createTask({
      agentId: AGENT,
      target: { platform: 'webchat', integrationId: '', channel: CONV, thread: null },
      task: 'Check each finding and name an owner.',
      sentence,
      why: 'Three reports in a row.',
      itemId: followUp.taskKey,
      itemVersion: followUp.version,
      source: {
        platform: 'webchat',
        integrationId: '',
        channel: CONV,
        thread: checkCoordinate('1'),
        transportScope: null,
        sessionKey: sessionKey('webchat', CONV, checkCoordinate('1'), AGENT),
        sessionId: 'sid-check-1',
        place: false
      }
    })
    posts.length = 0
    const sent = d.relays.sendWebchatPost.mock.calls.length
    const decision = await d.drafts.decideFromConsole({
      agentId: AGENT,
      draftId: draft.id,
      choice: 'approve',
      decider: { userId: OWNER, name: 'Grace' }
    })
    expect(decision).toMatchObject({ result: 'decided', status: 'executing', failure: null })
    await vi.waitFor(() => expect(posts).toHaveLength(2), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)

    // The root is one post of the agent at the conversation's root; its id names the thread the task holds.
    const rootId: string = d.relays.sendWebchatPost.mock.calls[sent][0].post.postId
    expect(posts[0]).toEqual({ text: `**${sentence}**\n\nApproved by Grace.`, initiator: 'agent' })
    expect(posts[1]).toEqual({ text: 'task answer 1', initiator: 'agent', thread: rootId })
    const taskKey = sessionKey('webchat', CONV, rootId, AGENT)
    expect(await index.threadsOf(AGENT, taskKey)).toMatchObject([{ channel: CONV, thread: rootId }])
    expect(await index.get(AGENT, taskKey)).toMatchObject({ parentSessionKey: coordinatorKey, state: 'done' })
    expect(await d.store.assistantDrafts.get(draft.id)).toMatchObject({ status: 'succeeded', subsessionKey: taskKey })
    expect(taskPrompts[0]).toContain('[approved proposal]')
    expect(taskPrompts[0]).toContain('Your reply posts in this thread')
    // Its people read the work that was approved, never the framed prompt.
    const inThread = await d.store.transcriptPage(transcriptChannelKey(CONV), rootId, null, 50, AGENT)
    const shown = inThread.rows.map((row: { text: string }) => row.text).join('\n')
    expect(shown).toContain('Check each finding and name an owner.')
    expect(shown).not.toContain('[approved proposal]')

    // A reply in the thread is the task's next turn, not the coordinator's and not a new task's.
    await send('and the third one?', OWNER, CONV, undefined, rootId)
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(2), WAIT)
    expect(taskPrompts[1]).toContain('and the third one?')
    expect(posts.at(-1)).toMatchObject({ text: 'task answer 2', thread: rootId })
    expect((await index.list(AGENT, 10, { delegationsOnly: true })).map((row: any) => row.childSessionKey)).toEqual([
      taskKey
    ])
    await booted.daemon.stop()
  })
})
