// auto-session-mode.md §10: a member's private coordinator conversation in webchat, and the tasks it opens on their own pages.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinatorConversationId, type RdChatEvent, type RdMsgWebchat } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import { isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { isSubsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { sessionKey } from '../src/store/local-store.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { WAIT } from './wait-support.js'

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
  const posts: { text: string; initiator?: string }[] = []
  d.relays = {
    stop: vi.fn(async () => {}),
    sendWebchatPost: vi.fn((post: { post: { text: string }; initiator?: string }) =>
      posts.push({ text: post.post.text, ...(post.initiator ? { initiator: post.initiator } : {}) })
    )
  }
  let turns = 0
  /** One browser turn by `user`, onto a session the Control Plane verified when `targetSessionId` is set; resolves once its stream is done. */
  const send = async (text: string, user = OWNER, chatId = CONV, targetSessionId?: string) => {
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
      payload: { op: 'turn', text, user, userId: user, turnId, post: { postId, at: 1_000 + n } }
    }
    const ack = await d.handleRelayMsg(msg, (event: RdChatEvent) => events.push(event))
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const streamed = events
      .flatMap((event) =>
        event.kind === 'output' && event.output.event?.kind === 'message' ? [event.output.event.text] : []
      )
      .join('')
    return { messageId: `msg-${postId}`, postId, streamed }
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
  return { daemon, d, host, posts, send, coordinator }
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

  it('opens a task on its own page, links it, moves a later message to it, and falls back for a message left undecided', async () => {
    const live: { d?: any } = {}
    const coordinatorPrompts: string[] = []
    const taskPrompts: string[] = []
    let taskId = ''
    // What the coordinator does with each message, by its text.
    const script: Record<string, (messageId: string) => Record<string, unknown> | undefined> = {
      'fix the retry': (messageId) => ({ action: 'delegateTask', messageId, title: 'Fix the [retry]' }),
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
      const body = /mentions-you="yes">\n([^\n]*)\n/.exec(text)?.[1] ?? ''
      const call = script[body]?.(id)
      if (call) {
        const { ctx } = await booted.coordinator()
        const receipt = (await live.d.coordinators.decide(ctx, call)) as { taskId?: string }
        if (receipt.taskId) taskId = receipt.taskId
      }
      say('AC_NO_RESPONSE')
    })
    const { d, posts, send } = booted
    live.d = d
    const index = d.store.assistantSubsessions

    const first = await send('fix the retry')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(1), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const { key: coordinatorKey } = await booted.coordinator()
    // The task is a background coordinate off the conversation, whose thread is the message's own id.
    expect(taskId.startsWith(`webchat:a2a:${AGENT}:subsession:`)).toBe(true)
    expect(isSubsessionCoordinate(taskId.slice(`webchat:a2a:${AGENT}:`.length))).toBe(true)
    expect(await index.get(AGENT, taskId)).toMatchObject({
      parentSessionKey: coordinatorKey,
      title: 'Fix the [retry]',
      state: 'done'
    })
    expect(await index.threadsOf(AGENT, taskId)).toMatchObject([{ channel: CONV, thread: first.postId }])
    expect(taskPrompts[0]).toContain('fix the retry')
    expect(taskPrompts[0]).toContain("The coordinator of a person's console conversation opened you")
    expect(taskPrompts[0]).not.toContain('Reporting back to the session that started this task')
    const task = await d.store.getSession(taskId)
    expect(task?.originSessionId).toBe(await d.store.ensureOutwardSessionId(coordinatorKey, AGENT))
    expect(first.streamed).toBe('')
    // The link is the coordinator's one post; the task's answer is on its page, never in this conversation.
    expect(posts).toEqual([
      { text: `Started a task: [Fix the \\[retry\\]](${d.sessionLink(task.sessionId)})`, initiator: 'agent' }
    ])
    // The task answered on its page; nothing reached the coordinator, which is not woken by its end.
    expect(coordinatorPrompts).toHaveLength(1)

    const second = await send('also handle 429')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(2), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    expect(taskPrompts[1]).toContain('also handle 429')
    expect((await index.threadsOf(AGENT, taskId)).map((one: { thread: string }) => one.thread)).toEqual([
      first.postId,
      second.postId
    ])
    expect(posts.at(-1)).toEqual({
      text: `Passed to [Fix the \\[retry\\]](${d.sessionLink(task.sessionId)})`,
      initiator: 'agent'
    })
    expect(await index.get(AGENT, taskId)).toMatchObject({ state: 'done', round: 2 })
    expect((await index.get(AGENT, taskId))?.endReport).toBeUndefined()

    // A reply by call is the coordinator's own post in the conversation, shown live.
    await send('how is it going?')
    expect(posts.at(-1)).toEqual({ text: 'Still on it.', initiator: 'agent' })

    // The task's page is its conversation: a person's message there runs on the task, which still reports nothing.
    const page = await send('one more case', OWNER, '99999999-9999-4999-8999-999999999999', task.sessionId)
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(3), WAIT)
    expect(taskPrompts[2]).toContain('one more case')
    expect(page.streamed).toBe('task answer 3')
    expect(await index.get(AGENT, taskId)).toMatchObject({ state: 'done', round: 3 })
    expect((await index.get(AGENT, taskId))?.endReport).toBeUndefined()

    // The minute sweep leaves a member's coordinator conversation and its tasks alone.
    await d.leaveAutoConversations()
    expect(await d.store.currentAppendCoordinate(AGENT, CONV, null, 'coordinator')).toBe(
      (await booted.coordinator()).ctx.thread
    )
    expect(await index.threadsOf(AGENT, taskId)).toHaveLength(2)

    // Every message is addressed to the agent, so one left undecided opens a task of its own.
    const third = await send('what next?')
    await vi.waitFor(() => expect(taskPrompts).toHaveLength(4), WAIT)
    const fallback = await index.taskOfThread(AGENT, {
      platform: 'webchat',
      channel: CONV,
      transportScope: '',
      thread: third.postId
    })
    expect(fallback).not.toBe(taskId)
    expect(await index.get(AGENT, fallback)).toMatchObject({ title: 'what next?', parentSessionKey: coordinatorKey })
    expect(posts.at(-1)?.text).toMatch(/^Started a task: \[what next\?\]\(/)
    expect(coordinatorPrompts).toHaveLength(4)
    await booted.daemon.stop()
  })
})
