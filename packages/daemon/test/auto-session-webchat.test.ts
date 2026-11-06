// auto-session-mode.md §10, webchat-threads.md §4: a member's private coordinator conversation in webchat, and the tasks it opens on its threads.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinatorConversationId, type RdChatEvent, type RdMsgWebchat } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { sessionHostKey } from '../src/acp/host-key.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import { isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
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
  const daemon = new Daemon({
    root: scaffold(features),
    hostFactory: (_agent, update) => {
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
  return { daemon, d, host, posts, turn, send, coordinator }
}

describe("a member's coordinator conversation in webchat (auto-session-mode.md §10)", () => {
  it('runs every message on the coordinator, addressed to it, and streams a one-message reply once', async () => {
    const prompts: string[] = []
    const { daemon, d, posts, send } = await boot(async (_id, text, say) => {
      prompts.push(text)
      say('You are welcome.')
    })
    const { messageId, streamed } = await send('thanks!')
    expect(prompts[0]).toContain(`<message id="${messageId}" from="${OWNER}" mentions-you="yes">\nthanks!\n</message>`)
    expect(streamed).toBe('You are welcome.')
    // The browser's own turn commits the reply; the coordinator posts nothing beside it.
    expect(posts).toEqual([{ text: 'You are welcome.' }])
    const coordinate = await d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')
    expect(isCoordinatorCoordinate(coordinate)).toBe(true)
    expect(await d.store.getSession(sessionKey('webchat', CONV, coordinate, AGENT))).toBeDefined()
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
  })

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
        if (receipt.taskId) taskId = receipt.taskId
        if (receipt.posted) replies.push(receipt.posted)
      }
      say('AC_NO_RESPONSE')
    })
    const replies: unknown[] = []
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
    expect(coordinatorPrompts[0]).toContain("The task answers in the message's thread.")

    // A reply in the thread the task holds goes to the task, never the coordinator, and streams in that thread.
    const reply = await send('use jitter too', OWNER, CONV, undefined, first.postId)
    expect(reply.streamed).toBe('task answer 2')
    expect(taskPrompts[1]).toContain('use jitter too')
    expect(coordinatorPrompts).toHaveLength(1)
    const frames = reply.events.map((event) => (event.kind === 'output' ? event.output.thread : event.done.thread))
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((thread) => thread === first.postId)).toBe(true)
    expect(posts.at(-1)).toEqual({ text: 'task answer 2', thread: first.postId })

    // A root handed to the task attaches its thread, where the task answers; no link card is posted.
    const second = await send('also handle 429')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(3), WAIT)
    await vi.waitFor(() => expect(posts.at(-1)?.text).toBe('task answer 3'), WAIT)
    expect(taskPrompts[2]).toContain('also handle 429')
    expect((await index.threadsOf(AGENT, taskId)).map((one: { thread: string }) => one.thread)).toEqual([
      first.postId,
      second.postId
    ])
    expect(posts.at(-1)).toEqual({ text: 'task answer 3', initiator: 'agent', thread: second.postId })
    expect(posts.some((post) => post.taskLink !== undefined)).toBe(false)

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
      lastReply: { excerpt: 'task answer 2' }
    })

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
      'how is it going?': (messageId) => ({ action: 'replyToMessage', messageId, message: 'Still on it.' })
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
    const second = await send('also handle 429')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(2), WAIT)
    await settle()
    const unowned = await send('how is it going?')
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
})
