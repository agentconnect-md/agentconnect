// The coordinator session's outcomes (auto-session-mode.md §4.2–§4.5, §5.1): open a threaded task, hand a message to one, reply, or fall back.
import { z } from 'zod'
import type { TaskLinkFacts } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { SessionContext } from '../mcp/ops/context.js'
import { parseArgs, requiredString, ToolArgumentError } from '../mcp/ops/args.js'
import { taskTitleField, TASK_TITLE_MAX_CHARS } from '../mcp/ops/send-message-actions.js'
import { deriveTitle } from '../session/derive-title.js'
import { isNoResponseBody } from '../session/no-response.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { a2aCoordChannel } from '../cp/cp-collab-routes.js'
import { isSubsessionCoordinate, subsessionCoordinate } from '../session/subsession-coordinate.js'
import { coordinatorMessageId, type ReportAbout } from './coordinator-prompt.js'
import {
  answerThreadOf,
  CoordinatorTurns,
  inThread,
  platformMessageIdOf,
  replyThreadOf,
  threadless,
  wholeRoomThread,
  type DeliveredMessage
} from './coordinator-turns.js'

/** A threaded task whose session has been idle this long closes, and its threads become unowned (auto-session-mode.md §6.5). */
export const THREADED_TASK_IDLE_CLOSE_MS = 7 * 24 * 60 * 60_000

/** How long a message in a room keyed as one thread waits for a room a task is still attaching, which may be its own (§6.8). */
export const TASK_ROOM_ATTACH_WAIT_MS = 30_000

/** What the coordinator module needs from its daemon. */
export interface CoordinatorSessionsHost {
  store(): LocalStore
  now(): number
  /** Admit a message into the session its coordinates key; the turn runs on its own. */
  dispatch(agentId: string, msg: NormalizedMessage, integrationId?: string): void
  /** Post the agent's own text in a message's thread, answering the post's platform id where it has one; `taskLink` marks a webchat post as a link to that task (§10). */
  post(
    agentId: string,
    integrationId: string | undefined,
    msg: NormalizedMessage,
    text: string,
    taskLink?: TaskLinkFacts
  ): Promise<string | undefined>
  /** A coordinator's turn answered a report with a reply that landed in `thread` (§6.9.2). */
  reportAnswered(key: string, thread: string): void
  /** Show on a message that a turn is deciding it (🤔, §4.4); the returned call takes that back. */
  showTriaging(agentId: string, message: DeliveredMessage): () => void
  /** The console page of a session, by its outward id. */
  sessionLink(sessionId: string): string
  /** Tell the Control Plane which session owns each of these tasks now, which locks a task's visibility (§6.2). */
  reportTaskOwners(agentId: string, keys: readonly string[]): Promise<void>
  /** Where a person opens a platform thread, where its platform links one. */
  threadLink?(
    integrationId: string | undefined,
    at: { platform: string; channel: string; thread: string }
  ): string | undefined
  warn(message: string): void
}

const optionalBackground = z.string('argument message must be a string').optional()
const CALL = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      action: z.literal('delegateTask'),
      messageId: requiredString('messageId'),
      title: taskTitleField,
      message: optionalBackground
    }),
    z.strictObject({
      action: z.literal('messageTask'),
      messageId: requiredString('messageId'),
      taskId: requiredString('taskId'),
      message: optionalBackground
    }),
    z.strictObject({
      action: z.literal('replyToMessage'),
      messageId: requiredString('messageId'),
      message: z
        .string('replyToMessage needs a message: the reply text')
        .trim()
        .min(1, 'replyToMessage needs a message: the reply text')
    }),
    z.strictObject({
      action: z.literal('ignoreMessage'),
      messageId: requiredString('messageId'),
      reason: z.string('argument reason must be a string').nullish()
    })
  ],
  { error: 'argument action must be delegateTask, messageTask or replyToMessage' }
)

// The coordinator's background rides beside the original message, never in place of it (§5.1).
const BACKGROUND_HEAD = '(Background from the coordinator that handed you this message, not from its sender:'

/** A message's turn body with the coordinator's background after what the model reads. */
function withBackground(
  msg: Pick<NormalizedMessage, 'text' | 'turnBody'>,
  background: string
): NonNullable<NormalizedMessage['turnBody']> {
  return { ...msg.turnBody, prompt: `${msg.turnBody?.prompt ?? msg.text}\n\n${BACKGROUND_HEAD} ${background})` }
}

/** The message a task receives: the original, keyed where the task's session is, with the coordinator's title and background. */
export function messageForTask(
  msg: NormalizedMessage,
  opts: { sessionThread?: string; title?: string; background?: string }
): NormalizedMessage {
  const { sessionThread: _coordinator, headless: _headless, ...original } = msg
  const background = opts.background?.trim()
  return {
    ...original,
    ...(opts.sessionThread !== undefined && opts.sessionThread !== msg.thread
      ? { sessionThread: opts.sessionThread }
      : {}),
    ...(opts.title ? { initialSessionTitle: opts.title } : {}),
    ...(background ? { turnBody: withBackground(msg, background) } : {})
  }
}

/** A room keyed as one thread, as a task holds a channel it made (§6.8). */
export interface TaskRoom {
  channel: string
  thread: string
}

/** The message a task holding a room receives when the coordinator moves one there (§6.8): the original, moved into the room and keyed on the task's session. */
export function messageForRoomTask(
  msg: NormalizedMessage,
  room: TaskRoom,
  session: TaskRoom,
  opts: { background?: string }
): NormalizedMessage {
  const { replyThread: _reply, threadUrl: _link, isGroupDm: _group, ...moved } = messageForTask(msg, opts)
  return {
    ...moved,
    channel: room.channel,
    thread: room.thread,
    isDm: false,
    ...(session.channel !== room.channel ? { sessionChannel: session.channel } : {}),
    ...(session.thread !== room.thread ? { sessionThread: session.thread } : {})
  }
}

/** The message a task on its own page receives (§10): the original, moved to the task's coordinate and out of its conversation's posts and threads. */
export function messageForPageTask(
  msg: NormalizedMessage,
  at: { channel: string; sessionThread: string },
  opts: { title?: string; background?: string }
): NormalizedMessage {
  const { transcriptPostId: _post, thread: _thread, ...moved } = messageForTask(msg, opts)
  return { ...moved, channel: at.channel, sessionThread: at.sessionThread }
}

/** A page task's background coordinate, read from its session key since the session may not exist yet; undefined for any other task. */
function pageTaskCoordinate(key: string, platform: string, agentId: string): string | undefined {
  const head = `${platform}:${a2aCoordChannel(agentId)}:`
  const tail = `:${agentId}`
  const coordinate = key.startsWith(head) && key.endsWith(tail) ? key.slice(head.length, -tail.length) : undefined
  return isSubsessionCoordinate(coordinate) ? coordinate : undefined
}

/** Wait for every promise to settle, or for `ms`, whichever comes first. */
async function settledWithin(promises: readonly Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  await Promise.race([Promise.allSettled(promises), expired])
  clearTimeout(timer)
}

/** The message a task is opened for, as `recall` and `listTasks` name it (assistant-mode.md §5.18 ④). */
const openedForOf = (message: DeliveredMessage) => ({
  place: `${message.msg.platform}:${message.msg.channel}`,
  messageId: message.id
})

// The wire's bound on a link card's title, so an over-long one never drops the post at the relay.
const TASK_LINK_TITLE_MAX = 300
// A link a title cannot break out of.
const linkText = (title: string): string => title.replace(/[[\]\\]/g, (char) => `\\${char}`)

/** A task title the daemon gives: the text's first line, cut to a task title's length. */
function taskTitleFrom(text: string | undefined, otherwise: string): string {
  const line = deriveTitle(text)?.replace(/\s+/g, ' ').trim() || otherwise
  const chars = [...line]
  return chars.length <= TASK_TITLE_MAX_CHARS ? line : `${chars.slice(0, TASK_TITLE_MAX_CHARS - 1).join('')}…`
}

/** The coordinator sessions of every `auto` conversation on this daemon, with their live turns. */
export class CoordinatorSessions {
  readonly turns = new CoordinatorTurns()
  /** Rooms being made per agent, until the task making each holds it, which the platform's copy of its message waits for (§6.8). */
  private readonly roomsInFlight = new Map<string, Set<Promise<void>>>()

  constructor(private readonly host: CoordinatorSessionsHost) {}

  /** Open a coordinator turn on its batch, each channel message marked as being decided until the turn ends, whatever its outcome (§4.3, §4.4); a report is no platform message to mark. */
  beginTurn(key: string, agentId: string, messages: DeliveredMessage[]): void {
    const clears = messages
      .filter((message) => !message.report)
      .map((message) => this.host.showTriaging(agentId, message))
    this.turns.begin(key, messages, () => {
      for (const clear of clears) clear()
    })
  }

  /** The coordinator's `sendMessage` or `ignoreMessage`: one outcome for one delivered message. */
  async decide(ctx: SessionContext, args: Record<string, unknown>): Promise<unknown> {
    const tool = args.action === 'ignoreMessage' ? 'ignoreMessage' : 'sendMessage'
    let call: z.output<typeof CALL>
    try {
      call = parseArgs(CALL, args)
    } catch (err) {
      if (err instanceof ToolArgumentError) throw new Error(`${tool}: ${err.issues.join('; ')}`)
      throw err
    }
    const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
    const held = this.turns.reserve(key, call.messageId)
    if ('error' in held) throw new Error(`${tool}: ${held.error}`)
    try {
      if (call.action === 'ignoreMessage') {
        this.turns.settle(key, call.messageId, 'ignore')
        // A mention may not be ignored (§4.1): nothing is posted for it, and a task answers it when the turn ends (§4.5).
        return held.message.mentionsYou
          ? { ok: true, ignored: call.messageId, note: 'It mentions you, so a task will answer it instead.' }
          : { ok: true, ignored: call.messageId }
      }
      if (held.message.report && call.action !== 'replyToMessage')
        throw new Error(
          `sendMessage: ${call.messageId} is a report, not a channel message: answer it with action "replyToMessage", or ` +
            'leave it with ignoreMessage; no task was opened or messaged'
        )
      // The coordinator reads only an attachment's name (§5.1); a report is exempt because no task can take one.
      if (call.action === 'replyToMessage' && !held.message.report && held.message.msg.attachments?.length)
        throw new Error(
          `sendMessage: ${call.messageId} has an attachment you cannot see: hand it to a task with action ` +
            '"delegateTask" or "messageTask", which receives the file itself; nothing was posted'
        )
      switch (call.action) {
        case 'delegateTask': {
          const owner = await this.taskOwner(ctx.agentId, ctx, key)
          const taskKey = await this.openTask(owner, ctx.agentId, held.message, call.title, call.message)
          this.turns.settle(key, call.messageId, 'delegate')
          const note = threadless(held.message.msg)
            ? 'Task opened; it answers on its own page, which the conversation now links to.'
            : "Task opened; it answers in the message's thread."
          return { ok: true, taskId: taskKey, title: call.title, note }
        }
        case 'messageTask': {
          const owners = new Set([key, await this.taskOwner(ctx.agentId, ctx, key)])
          const handed = await this.handTo(owners, ctx.agentId, call.taskId, held.message, call.message)
          this.turns.settle(key, call.messageId, 'route')
          if (handed.moved)
            return {
              ok: true,
              taskId: handed.taskKey,
              note: "The message moved to the task's own channel, which its thread now links to."
            }
          return handed.joined !== undefined
            ? { ok: true, taskId: handed.taskKey, joinedThread: coordinatorMessageId(handed.joined) }
            : { ok: true, taskId: handed.taskKey, attachedThread: call.messageId }
        }
        case 'replyToMessage': {
          const thread = await this.answer(key, ctx.agentId, held.message, call.message)
          this.turns.settle(key, call.messageId, 'reply')
          return {
            ok: true,
            posted: { channel: ctx.channel, ...(thread ? { thread: coordinatorMessageId(thread) } : { at: 'root' }) }
          }
        }
      }
    } catch (err) {
      this.turns.release(key, call.messageId)
      throw err
    }
  }

  /** Post the coordinator's own words where a delivered message is answered, by a call or by the turn's text; the thread they belong to (§4.2). */
  private async answer(
    key: string,
    agentId: string,
    message: DeliveredMessage,
    text: string
  ): Promise<string | undefined> {
    const posted = await this.host.post(agentId, message.integrationId, message.msg, text)
    const thread = answerThreadOf(message.msg)
    // A reply at the root opens the thread its own id names; one in a thread stays in that thread.
    const landed = thread ?? posted
    if (message.report && landed !== undefined) this.host.reportAnswered(key, landed)
    return thread
  }

  /** The person's message a place-tool call acts for (§5.4): a channel message of the live turn, never a report. */
  messageFor(ctx: SessionContext, messageId: unknown): { msg: NormalizedMessage } | { error: string } {
    if (typeof messageId !== 'string' || messageId.trim() === '')
      return { error: 'needs messageId: the id of the delivered channel message whose sender asked for this' }
    const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
    const message = this.turns.find(key, messageId)
    if (!message) return { error: `messageId ${messageId} is not a channel message delivered in this turn` }
    if (message.report) return { error: `${messageId} is a report; this acts only for a person's channel message` }
    return { msg: message.msg }
  }

  /** The coordinator that owns the conversation's tasks: the current one, for which a turn still running on a retired one acts (§8). */
  async taskOwner(
    agentId: string,
    at: { platform: string; channel: string; transportScope?: string | null },
    callerKey: string
  ): Promise<string> {
    const current = await this.host
      .store()
      .currentAppendCoordinate(agentId, at.channel, at.transportScope, 'coordinator')
    return current === undefined ? callerKey : sessionKey(at.platform, at.channel, current, agentId, at.transportScope)
  }

  /** Open a threaded task for a message (§5.1): its session is the message's thread, which it holds from now on (§6.4). */
  async openTask(
    coordinatorKey: string,
    agentId: string,
    message: DeliveredMessage,
    title: string,
    background?: string
  ): Promise<string> {
    const { msg } = message
    const store = this.host.store()
    const index = store.assistantSubsessions
    const thread = replyThreadOf(msg)
    const at = { platform: msg.platform, channel: msg.channel, transportScope: msg.transportScope ?? null, thread }
    const owner = await index.taskOfThread(agentId, at)
    if (owner !== undefined)
      throw new Error(
        `sendMessage: the thread of ${message.id} already belongs to task ${owner}; hand the message to it with action ` +
          `"messageTask" and that taskId`
      )
    if (threadless(msg)) return await this.openPageTask(coordinatorKey, agentId, message, title, background)
    const taskKey = sessionKey(msg.platform, msg.channel, thread, agentId, msg.transportScope)
    const now = this.host.now()
    const parentSessionId = await store.ensureOutwardSessionId(coordinatorKey, agentId, now)
    const opened = await index.open({
      agentId,
      childSessionKey: taskKey,
      parentSessionId,
      parentSessionKey: coordinatorKey,
      title,
      background: background?.trim() || msg.text,
      openedFor: openedForOf(message),
      replyThread: thread,
      now
    })
    if (!opened && (await index.get(agentId, taskKey))?.parentSessionKey !== coordinatorKey)
      throw new Error(`sendMessage: the thread of ${message.id} already has a session of its own; nothing was opened`)
    await index.attachThread({
      agentId,
      childSessionKey: taskKey,
      ...at,
      transportScope: at.transportScope ?? '',
      sinceRound: 1,
      now
    })
    // A thread whose session already ran becomes a task now; a new session reports its owner with its first turn.
    await this.host.reportTaskOwners(agentId, [taskKey])
    // On the task's thread, which a top-level message whose platform gives it none (a console message's copy) lacks.
    this.host.dispatch(
      agentId,
      messageForTask({ ...msg, thread }, { title, ...(background ? { background } : {}) }),
      message.integrationId
    )
    return taskKey
  }

  /** A room a session made for its work (§6.8): a task opened for a message holds it as one more thread, and a message there waits while it is attached; any other session's room stays its own. */
  async makeRoom<T>(
    agentId: string,
    taskKey: string,
    make: () => Promise<{ result: T; room?: TaskRoom & { platform: string; transportScope?: string | null } }>,
    reportThread?: string
  ): Promise<T> {
    const index = this.host.store().assistantSubsessions
    const row = await index.get(agentId, taskKey)
    // A thread session adopted into `auto` was opened for no message, and holds no room (§3.5).
    if (row?.openedFor === undefined || row.mode === 'watch') return (await make()).result
    return await this.whileRoomAttaches(agentId, async () => {
      const { result, room } = await make()
      if (room) {
        const held = await index.attachThread({
          agentId,
          childSessionKey: taskKey,
          ...room,
          transportScope: room.transportScope ?? '',
          sinceRound: row.round ?? 1,
          ...(reportThread !== undefined ? { reportThread } : {}),
          now: this.host.now()
        })
        if (!held && (await index.taskOfThread(agentId, room)) !== taskKey)
          this.host.warn(`coordinator: task ${taskKey} made ${room.channel}, which another task already holds`)
      }
      return result
    })
  }

  /** Run a room's making until its task holds it, as one a message in a room keyed as one thread waits for. */
  private async whileRoomAttaches<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    let attached!: () => void
    const kept = new Promise<void>((resolve) => (attached = resolve))
    const inFlight = this.roomsInFlight.get(agentId) ?? new Set<Promise<void>>()
    this.roomsInFlight.set(agentId, inFlight)
    inFlight.add(kept)
    try {
      return await run()
    } finally {
      attached()
      inFlight.delete(kept)
      if (inFlight.size === 0) this.roomsInFlight.delete(agentId)
    }
  }

  /** A message in a room keyed as one thread waits for the rooms its agent's tasks are still attaching, at most 30 seconds, since it may be the platform's copy into one (§6.8). */
  async roomsAttached(agentId: string): Promise<void> {
    const inFlight = this.roomsInFlight.get(agentId)
    if (inFlight?.size) await settledWithin([...inFlight], TASK_ROOM_ATTACH_WAIT_MS)
  }

  /** A task for a message of a conversation without threads (§10): a background coordinate whose page is its conversation, holding the message's id as its thread so it never reports. */
  private async openPageTask(
    coordinatorKey: string,
    agentId: string,
    message: DeliveredMessage,
    title: string,
    background?: string
  ): Promise<string> {
    const { msg } = message
    const store = this.host.store()
    const index = store.assistantSubsessions
    // Off the conversation's own channel, as a background task of it is, so the task is never the conversation's session.
    const at = { channel: a2aCoordChannel(agentId), sessionThread: subsessionCoordinate(monotonicTs()) }
    const taskKey = sessionKey(msg.platform, at.channel, at.sessionThread, agentId)
    const now = this.host.now()
    const parentSessionId = await store.ensureOutwardSessionId(coordinatorKey, agentId, now)
    await index.open({
      agentId,
      childSessionKey: taskKey,
      parentSessionId,
      parentSessionKey: coordinatorKey,
      title,
      background: background?.trim() || msg.text,
      openedFor: openedForOf(message),
      now
    })
    await index.attachThread({
      agentId,
      childSessionKey: taskKey,
      platform: msg.platform,
      channel: msg.channel,
      transportScope: msg.transportScope ?? '',
      thread: replyThreadOf(msg),
      sinceRound: 1,
      now
    })
    this.host.dispatch(
      agentId,
      messageForPageTask(msg, at, { title, ...(background ? { background } : {}) }),
      message.integrationId
    )
    await this.postTaskLink(agentId, message, taskKey, title, 'opened')
    return taskKey
  }

  /** The link a message gets to the task it went to where that task answers elsewhere: its page (§10) or its place (§6.8). */
  private async postTaskLink(
    agentId: string,
    message: DeliveredMessage,
    taskKey: string,
    title: string | undefined,
    how: 'opened' | 'handed',
    url?: string
  ): Promise<void> {
    const sessionId = url
      ? undefined
      : await this.host.store().ensureOutwardSessionId(taskKey, agentId, this.host.now())
    const target = url ?? this.host.sessionLink(sessionId!)
    const name = title?.trim() || 'the task'
    const link = `[${linkText(name)}](${target})`
    await this.host
      .post(
        agentId,
        message.integrationId,
        message.msg,
        how === 'opened' ? `Started a task: ${link}` : `Passed to ${link}`,
        // A task on its own page is a card the console opens beside the conversation; a platform room stays a link.
        sessionId ? { sessionId, title: name.slice(0, TASK_LINK_TITLE_MAX), how } : undefined
      )
      .catch((err: unknown) =>
        this.host.warn(`coordinator: linking ${message.id} to ${taskKey} failed (${String(err)})`)
      )
  }

  /** Hand a message to one of the coordinator's threaded tasks and attach its thread (§5.1, §6.4), join a webchat root to the task's thread, or move it into the task's place (§6.8). */
  private async handTo(
    owners: ReadonlySet<string>,
    agentId: string,
    taskId: string,
    message: DeliveredMessage,
    background?: string
  ): Promise<{ taskKey: string; moved: boolean; joined?: string }> {
    const { msg } = message
    const store = this.host.store()
    const index = store.assistantSubsessions
    // A taskId is the task's key or a unique prefix of it, as listTasks and the board show it (assistant-mode.md §5.18 ④).
    const key = await index.resolve(agentId, taskId)
    const row =
      (key !== undefined ? await index.get(agentId, key) : undefined) ??
      (await store.getSessionByOutwardIdOnly(taskId, agentId).then((s) => (s ? index.get(agentId, s.key) : undefined)))
    // A message without a thread moves only to a task on its own page (§10).
    if (
      !row ||
      row.mode === 'watch' ||
      !owners.has(row.parentSessionKey) ||
      (threadless(msg) && pageTaskCoordinate(row.childSessionKey, msg.platform, agentId) === undefined)
    )
      throw new Error(`sendMessage: ${taskId} is not one of your open tasks; listTasks lists them`)
    const threads = await index.threadsOf(agentId, row.childSessionKey)
    if (threads.length === 0)
      throw new Error(
        `sendMessage: task ${taskId} works in the background and cannot take a channel message; open a task for the ` +
          'message with action "delegateTask" instead'
      )
    const room = threadless(msg) ? undefined : this.roomOf(threads, msg)
    if (room) {
      // Its thread stays the coordinator's: the task answers in the channel it holds, which the thread links to.
      const session = await this.sessionOf(row.childSessionKey, threads)
      const moved = messageForRoomTask(msg, room, session, background ? { background } : {})
      this.host.dispatch(agentId, moved, message.integrationId)
      await this.postTaskLink(agentId, message, row.childSessionKey, row.title, 'handed', this.roomLink(message, room))
      return { taskKey: row.childSessionKey, moved: true }
    }
    const thread = replyThreadOf(msg)
    const at = { platform: msg.platform, channel: msg.channel, transportScope: msg.transportScope ?? null, thread }
    const owner = await index.taskOfThread(agentId, at)
    if (owner !== undefined && owner !== row.childSessionKey)
      throw new Error(
        `sendMessage: the thread of ${message.id} already belongs to task ${owner}; hand the message there`
      )
    const joined =
      owner === undefined ? await this.joinedThreadOf(agentId, row.childSessionKey, threads, msg) : undefined
    if (joined !== undefined) {
      // A webchat root joins the task's thread and stays at the root, marked as handed there (webchat-threads.md §5.1).
      await store.markTranscriptHanded(
        { transcriptChannel: transcriptChannelKey(msg.channel, msg.transportScope), agentId },
        msg.transcriptPostId!,
        joined
      )
      await this.deliverToTask(agentId, row.childSessionKey, message, background, joined)
      return { taskKey: row.childSessionKey, moved: false, joined }
    }
    if (owner === undefined)
      await index.attachThread({
        agentId,
        childSessionKey: row.childSessionKey,
        ...at,
        transportScope: at.transportScope ?? '',
        sinceRound: (row.round ?? 1) + 1,
        now: this.host.now()
      })
    await this.deliverToTask(agentId, row.childSessionKey, message, background)
    return { taskKey: row.childSessionKey, moved: false }
  }

  /** The thread a webchat root handed to a task joins: the task's thread in the message's conversation, never a legacy page task's. */
  private async joinedThreadOf(
    agentId: string,
    taskKey: string,
    threads: readonly TaskRoom[],
    msg: NormalizedMessage
  ): Promise<string | undefined> {
    if (msg.platform !== 'webchat' || threadless(msg) || inThread(msg) || msg.transcriptPostId === undefined) return
    if (pageTaskCoordinate(taskKey, msg.platform, agentId) !== undefined) return
    const session = await this.sessionOf(taskKey, threads)
    const here = threads.filter((at) => at.channel === msg.channel)
    const thread = (here.find((at) => at.thread === session.thread) ?? here[0])?.thread
    return thread !== undefined && thread !== replyThreadOf(msg) ? thread : undefined
  }

  /** The newest room a task holds in a conversation other than the message's, where a message moves (§6.8). */
  private roomOf(threads: readonly TaskRoom[], msg: NormalizedMessage): TaskRoom | undefined {
    const rooms = threads.filter((at) => at.channel !== msg.channel && wholeRoomThread(at))
    const room = rooms[rooms.length - 1]
    return room && { channel: room.channel, thread: room.thread }
  }

  /** Where a task's session lives: its row's coordinate, else the first thread it held. */
  private async sessionOf(taskKey: string, threads: readonly TaskRoom[]): Promise<TaskRoom> {
    const session = await this.host.store().getSession(taskKey)
    return session ? { channel: session.channel, thread: session.thread } : threads[0]!
  }

  private roomLink(message: DeliveredMessage, room: TaskRoom): string | undefined {
    return this.host.threadLink?.(message.integrationId, { platform: message.msg.platform, ...room })
  }

  /** Dispatch a message to a threaded task: the task keeps its own session and answers in `answerIn`, else the message's thread (§6.4). */
  private async deliverToTask(
    agentId: string,
    taskKey: string,
    message: DeliveredMessage,
    background?: string,
    answerIn?: string
  ): Promise<void> {
    const store = this.host.store()
    // A legacy page task's message moves into its conversation, which the coordinator links to, threaded or not (§10).
    const page = pageTaskCoordinate(taskKey, message.msg.platform, agentId)
    if (page === undefined && threadless(message.msg))
      throw new Error(`sendMessage: ${taskKey} has no page this message can move to`)
    if (page !== undefined) {
      this.host.dispatch(
        agentId,
        messageForPageTask(
          message.msg,
          { channel: a2aCoordChannel(agentId), sessionThread: page },
          background ? { background } : {}
        ),
        message.integrationId
      )
      const title = (await store.assistantSubsessions.get(agentId, taskKey))?.title
      await this.postTaskLink(agentId, message, taskKey, title, 'handed')
      return
    }
    const sessionThread =
      (await store.getSession(taskKey))?.thread ??
      (await store.assistantSubsessions.threadsOf(agentId, taskKey))[0]?.thread
    this.host.dispatch(
      agentId,
      messageForTask(
        { ...message.msg, thread: answerIn ?? replyThreadOf(message.msg) },
        {
          ...(sessionThread ? { sessionThread } : {}),
          ...(background ? { background } : {})
        }
      ),
      message.integrationId
    )
  }

  /** A mention left without an outcome reaches the task its thread now belongs to, else opens one (§4.5). */
  private async fallBack(key: string, agentId: string, message: DeliveredMessage): Promise<void> {
    const { msg } = message
    const at = { platform: msg.platform, channel: msg.channel, transportScope: msg.transportScope ?? null }
    const owner = await this.host
      .store()
      .assistantSubsessions.taskOfThread(agentId, { ...at, thread: replyThreadOf(msg) })
    if (owner !== undefined) await this.deliverToTask(agentId, owner, message)
    // A fallback task opens in the message's thread, as Per thread would answer it, and may hold a channel it makes (§4.5).
    else
      await this.openTask(await this.taskOwner(agentId, msg, key), agentId, message, taskTitleFrom(msg.text, 'Message'))
  }

  /** Into `auto` (§3.5): the conversation's thread sessions active within a task's idle lifetime become the new coordinator's threaded tasks, titled from their first message; how many. */
  async adoptThreadSessions(
    agentId: string,
    coordinatorKey: string,
    at: { platform: string; channel: string; transportScope?: string | null }
  ): Promise<number> {
    const store = this.host.store()
    const index = store.assistantSubsessions
    const now = this.host.now()
    const sessions = await index.unownedThreadSessions(agentId, at, now - THREADED_TASK_IDLE_CLOSE_MS)
    if (sessions.length === 0) return 0
    const parentSessionId = await store.ensureOutwardSessionId(coordinatorKey, agentId, now)
    const adopted: string[] = []
    for (const session of sessions) {
      const opened = await index.adoptThreadSession({
        agentId,
        childSessionKey: session.key,
        parentSessionId,
        parentSessionKey: coordinatorKey,
        title: taskTitleFrom(session.title, 'Conversation'),
        ...at,
        thread: session.thread,
        running: session.running,
        now
      })
      if (opened) adopted.push(session.key)
    }
    await this.host.reportTaskOwners(agentId, adopted)
    return adopted.length
  }

  /** A coordinator's `!new`: the session succeeding it takes over its threaded tasks, which keep their threads (§8). */
  async handOver(agentId: string, fromKey: string, toKey: string): Promise<void> {
    const store = this.host.store()
    const sessionId = await store.ensureOutwardSessionId(toKey, agentId, this.host.now())
    const moved = await store.assistantSubsessions.adoptThreaded(agentId, fromKey, { sessionId, key: toKey })
    await this.host.reportTaskOwners(agentId, moved)
  }

  /** Post a coordinator turn's final text as its own reply to the message no call decided (§4.3); once a turn, before it settles. */
  async speak(key: string, agentId: string): Promise<void> {
    const spoken = this.turns.takeSpoken(key, isNoResponseBody)
    if (!spoken) return
    const { to, text } = spoken
    // A reply a browser streamed is committed with its turn.
    if (!to.streamed) {
      // The coordinator reads only an attachment's name (§5.1), so a task answers a person's file.
      if (to.msg.attachments?.length) return
      try {
        await this.answer(key, agentId, to, text)
      } catch (err) {
        this.host.warn(`coordinator ${key}: reply to ${to.id} failed (${String(err)})`)
        return
      }
    }
    this.turns.settle(key, to.id, 'reply')
  }

  /** End a coordinator turn: its final text answers the message no call decided, and a mention left unanswered goes to a task (§4.3, §4.5). */
  async settleTurn(key: string, agentId: string, ended: 'answered' | 'failed' | 'stopped'): Promise<void> {
    if (ended === 'answered') await this.speak(key, agentId)
    const settled = this.turns.end(key)
    // A stopped turn was stopped on purpose: nothing it left undecided is acted on.
    if (!settled || ended === 'stopped') return
    for (const message of settled.undecided) {
      if (!message.mentionsYou) continue
      await this.fallBack(key, agentId, message).catch((err: unknown) =>
        this.host.warn(`coordinator ${key}: fallback for ${message.id} failed (${String(err)})`)
      )
    }
  }
}

/** The delivered-message entry for one admitted coordinator message; anything but a channel message is a report (§3.4). */
export function deliveredMessage(
  msg: NormalizedMessage,
  integrationId?: string,
  streamed = false,
  about?: ReportAbout
): DeliveredMessage {
  const report = msg.source !== 'user'
  return {
    id: coordinatorMessageId(platformMessageIdOf(msg)),
    msg,
    ...(integrationId !== undefined ? { integrationId } : {}),
    mentionsYou: !report && msg.trigger === 'mention',
    ...(report ? { report: true as const } : {}),
    ...(report && about ? { about } : {}),
    ...(streamed ? { streamed: true as const } : {})
  }
}
