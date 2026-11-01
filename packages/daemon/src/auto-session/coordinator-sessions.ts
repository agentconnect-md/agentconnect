// The coordinator session's outcomes (auto-session-mode.md §4.2–§4.5, §5.1): open a threaded task, hand a message to one, reply, or fall back.
import { z } from 'zod'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { SessionContext } from '../mcp/ops/context.js'
import type { TaskPlace } from '../platforms/contract.js'
import { parseArgs, requiredString, ToolArgumentError } from '../mcp/ops/args.js'
import { taskTitleField, TASK_TITLE_MAX_CHARS } from '../mcp/ops/send-message-actions.js'
import { deriveTitle } from '../session/derive-title.js'
import { isNoResponsePrefix } from '../session/no-response.js'
import { sessionKey, type LocalStore } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { a2aCoordChannel } from '../cp/cp-collab-routes.js'
import { isSubsessionCoordinate, subsessionCoordinate } from '../session/subsession-coordinate.js'
import { coordinatorMessageId, type ReportAbout } from './coordinator-prompt.js'
import {
  answerThreadOf,
  CoordinatorTurns,
  platformMessageIdOf,
  replyThreadOf,
  threadless,
  wholeRoomThread,
  type DeliveredMessage
} from './coordinator-turns.js'

/** A threaded task whose session has been idle this long closes, and its threads become unowned (auto-session-mode.md §6.5). */
export const THREADED_TASK_IDLE_CLOSE_MS = 7 * 24 * 60 * 60_000

/** How long a task's place waits for the platform's copy of its message to carry the coordinator's title and background (§6.8). */
export const TASK_PLACE_OPENING_MS = 10 * 60_000
const MAX_PLACE_OPENINGS = 1000
/** How long a message in a room keyed as one thread waits for a place still being made, which may be its own (§6.8). */
export const TASK_PLACE_CREATION_WAIT_MS = 30_000

/** What the coordinator module needs from its daemon. */
export interface CoordinatorSessionsHost {
  store(): LocalStore
  now(): number
  /** Admit a message into the session its coordinates key; the turn runs on its own. */
  dispatch(agentId: string, msg: NormalizedMessage, integrationId?: string): void
  /** Post the agent's own text in a message's thread. */
  post(agentId: string, integrationId: string | undefined, msg: NormalizedMessage, text: string): Promise<void>
  /** Show on a message that a turn is deciding it (🤔, §4.4); the returned call takes that back. */
  showTriaging(agentId: string, message: DeliveredMessage): () => void
  /** The console page of a session, by its outward id. */
  sessionLink(sessionId: string): string
  /** Tell the Control Plane which session owns each of these tasks now, which locks a task's visibility (§6.2). */
  reportTaskOwners(agentId: string, keys: readonly string[]): Promise<void>
  /** A conversation of its own for a task opened for this message, where its platform makes one (§6.8); undefined keeps the task in the thread. */
  openTaskPlace?(
    agentId: string,
    integrationId: string | undefined,
    msg: NormalizedMessage,
    title: string
  ): Promise<TaskPlace | undefined>
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

/** The message a task in a conversation of its own receives (§6.8): the original, moved into that room, its thread there left behind. */
export function messageForPlaceTask(
  msg: NormalizedMessage,
  place: TaskPlace,
  opts: { background?: string }
): NormalizedMessage {
  const { replyThread: _reply, threadUrl: _link, isGroupDm: _group, ...moved } = messageForTask(msg, opts)
  return { ...moved, channel: place.channel, thread: place.thread, isDm: false }
}

/** The message a task on its own page receives (§10): the original, moved to the task's coordinate and out of its conversation's posts. */
export function messageForPageTask(
  msg: NormalizedMessage,
  at: { channel: string; sessionThread: string },
  opts: { title?: string; background?: string }
): NormalizedMessage {
  const { transcriptPostId: _post, ...moved } = messageForTask(msg, opts)
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
  /** Tasks whose place has not yet brought them their message, by session key, with what that message carries and who sent it (§6.8). */
  private readonly placeOpenings = new Map<
    string,
    { title: string; background?: string; sender: string; until: number }
  >()
  /** Places being made per agent, until their task is indexed and its opening kept, which the platform's copy waits for (§6.8). */
  private readonly placesInFlight = new Map<string, Set<Promise<void>>>()
  /** Messages the coordinator moved into a place itself, which never take the place's opening. */
  private readonly movedMessages = new WeakSet<NormalizedMessage>()

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

  /** The coordinator's `sendMessage`: one outcome for one delivered message. */
  async decide(ctx: SessionContext, args: Record<string, unknown>): Promise<unknown> {
    let call: z.output<typeof CALL>
    try {
      call = parseArgs(CALL, args)
    } catch (err) {
      if (err instanceof ToolArgumentError) throw new Error(`sendMessage: ${err.issues.join('; ')}`)
      throw err
    }
    const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
    const held = this.turns.reserve(key, call.messageId)
    if ('error' in held) throw new Error(`sendMessage: ${held.error}`)
    try {
      if (held.message.report && call.action !== 'replyToMessage')
        throw new Error(
          `sendMessage: ${call.messageId} is a report, not a channel message: answer it with action "replyToMessage", or ` +
            'leave it; no task was opened or messaged'
        )
      switch (call.action) {
        case 'delegateTask': {
          const owner = await this.taskOwner(ctx.agentId, ctx, key)
          const opened = await this.openTask(owner, ctx.agentId, held.message, call.title, call.message, {
            place: true
          })
          this.turns.settle(key, call.messageId, 'delegate')
          const note = threadless(held.message.msg)
            ? 'Task opened; it answers on its own page, which the conversation now links to.'
            : opened.placed
              ? "Task opened in a conversation of its own, which the message's thread now links to; it answers there."
              : "Task opened; it answers in the message's thread."
          return { ok: true, taskId: opened.taskKey, title: call.title, note }
        }
        case 'messageTask': {
          const owners = new Set([key, await this.taskOwner(ctx.agentId, ctx, key)])
          const handed = await this.handTo(owners, ctx.agentId, call.taskId, held.message, call.message)
          this.turns.settle(key, call.messageId, 'route')
          return handed.moved
            ? {
                ok: true,
                taskId: handed.taskKey,
                note: "The message moved to the task's own conversation, which its thread now links to."
              }
            : { ok: true, taskId: handed.taskKey, attachedThread: call.messageId }
        }
        case 'replyToMessage': {
          await this.host.post(ctx.agentId, held.message.integrationId, held.message.msg, call.message)
          this.turns.settle(key, call.messageId, 'reply')
          const thread = answerThreadOf(held.message.msg)
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

  /** Open a threaded task for a message (§5.1): its session is the message's thread, which it holds from now on, or with `place` a conversation of its own where the platform makes one (§6.8). */
  async openTask(
    coordinatorKey: string,
    agentId: string,
    message: DeliveredMessage,
    title: string,
    background?: string,
    opts: { place?: boolean } = {}
  ): Promise<{ taskKey: string; placed: boolean }> {
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
    if (threadless(msg))
      return { taskKey: await this.openPageTask(coordinatorKey, agentId, message, title, background), placed: false }
    if (opts.place) {
      const placed = await this.whilePlaceOpens(agentId, async (ready) => {
        const place = await this.placeFor(agentId, message, title)
        return place && (await this.openPlaceTask(coordinatorKey, agentId, message, place, title, background, ready))
      })
      if (placed !== undefined) return { taskKey: placed, placed: true }
    }
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
    this.host.dispatch(
      agentId,
      messageForTask(msg, { title, ...(background ? { background } : {}) }),
      message.integrationId
    )
    return { taskKey, placed: false }
  }

  /** Run a place's making, from its creation until `ready` says its task and opening are kept, as one the platform's copy may wait for. */
  private async whilePlaceOpens<T>(agentId: string, run: (ready: () => void) => Promise<T>): Promise<T> {
    let ready!: () => void
    const kept = new Promise<void>((resolve) => (ready = resolve))
    const inFlight = this.placesInFlight.get(agentId) ?? new Set<Promise<void>>()
    this.placesInFlight.set(agentId, inFlight)
    inFlight.add(kept)
    try {
      return await run(ready)
    } finally {
      ready()
      inFlight.delete(kept)
      if (inFlight.size === 0) this.placesInFlight.delete(agentId)
    }
  }

  /** The conversation of its own a platform gives a task for this message; none, a refusal or a failure keeps the task in the thread (§6.8). */
  private async placeFor(agentId: string, message: DeliveredMessage, title: string): Promise<TaskPlace | undefined> {
    if (!this.host.openTaskPlace) return undefined
    try {
      return await this.host.openTaskPlace(agentId, message.integrationId, message.msg, title)
    } catch (err) {
      this.host.warn(
        `coordinator: the task for ${message.id} stays in its thread; no place of its own (${String(err)})`
      )
      return undefined
    }
  }

  /** A task in a conversation of its own (§6.8): its session is the place's, which it holds as its thread, and the message's thread links there. */
  private async openPlaceTask(
    coordinatorKey: string,
    agentId: string,
    message: DeliveredMessage,
    place: TaskPlace,
    title: string,
    background: string | undefined,
    ready: () => void
  ): Promise<string> {
    const { msg } = message
    const store = this.host.store()
    const index = store.assistantSubsessions
    const at = { platform: msg.platform, ...place, transportScope: msg.transportScope ?? '' }
    // A creation the platform answered with a place it made before finds the task already there.
    const holder = await index.taskOfThread(agentId, at)
    if (holder !== undefined) return holder
    const taskKey = sessionKey(msg.platform, place.channel, place.thread, agentId, msg.transportScope)
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
      replyThread: place.thread,
      now
    })
    if (!opened && (await index.get(agentId, taskKey))?.parentSessionKey !== coordinatorKey)
      throw new Error(
        `sendMessage: the place made for ${message.id} already has a session of its own; nothing was opened`
      )
    await index.attachThread({ agentId, childSessionKey: taskKey, ...at, sinceRound: 1, now })
    // The platform brings the message into its place itself, and that copy opens the task: nothing is dispatched here.
    this.rememberOpening(taskKey, msg.sender.id, title, background)
    ready()
    await this.host.reportTaskOwners(agentId, [taskKey])
    await this.postTaskLink(agentId, message, taskKey, title, 'opened', this.placeLink(message, place))
    return taskKey
  }

  private placeLink(message: DeliveredMessage, place: TaskPlace): string | undefined {
    return this.host.threadLink?.(message.integrationId, { platform: message.msg.platform, ...place })
  }

  private rememberOpening(taskKey: string, sender: string, title: string, background?: string): void {
    const trimmed = background?.trim()
    this.placeOpenings.delete(taskKey)
    if (this.placeOpenings.size >= MAX_PLACE_OPENINGS)
      this.placeOpenings.delete(this.placeOpenings.keys().next().value!)
    this.placeOpenings.set(taskKey, {
      title,
      ...(trimmed ? { background: trimmed } : {}),
      sender,
      until: this.host.now() + TASK_PLACE_OPENING_MS
    })
  }

  /** The platform's copy of a message reaching the task opened for it in its place: it waits for a place still being made, then takes the coordinator's title and background, once (§6.8). */
  async placeOpening(agentId: string, key: string, msg: NormalizedMessage): Promise<void> {
    if (msg.source !== 'user' || !wholeRoomThread(msg) || this.movedMessages.has(msg)) return
    const inFlight = this.placesInFlight.get(agentId)
    if (inFlight?.size) await settledWithin([...inFlight], TASK_PLACE_CREATION_WAIT_MS)
    const opening = this.placeOpenings.get(key)
    // Only the copy of the message the place was made for, which its own sender posts there, takes it.
    if (!opening || opening.sender !== msg.sender.id) return
    this.placeOpenings.delete(key)
    if (opening.until < this.host.now()) return
    msg.initialSessionTitle = opening.title
    if (opening.background) msg.turnBody = withBackground(msg, opening.background)
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
    const target =
      url ?? this.host.sessionLink(await this.host.store().ensureOutwardSessionId(taskKey, agentId, this.host.now()))
    const link = `[${linkText(title?.trim() || 'the task')}](${target})`
    await this.host
      .post(
        agentId,
        message.integrationId,
        message.msg,
        how === 'opened' ? `Started a task: ${link}` : `Passed to ${link}`
      )
      .catch((err: unknown) =>
        this.host.warn(`coordinator: linking ${message.id} to ${taskKey} failed (${String(err)})`)
      )
  }

  /** Hand a message to one of the coordinator's threaded tasks and attach its thread (§5.1, §6.4), or move it into the task's place (§6.8). */
  private async handTo(
    owners: ReadonlySet<string>,
    agentId: string,
    taskId: string,
    message: DeliveredMessage,
    background?: string
  ): Promise<{ taskKey: string; moved: boolean }> {
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
    const place = threadless(msg) ? undefined : await this.placeOf(row.childSessionKey, threads, msg)
    if (place) {
      // Its thread stays the coordinator's: the task answers in its place, which the thread links to.
      const moved = messageForPlaceTask(msg, place, background ? { background } : {})
      this.movedMessages.add(moved)
      this.host.dispatch(agentId, moved, message.integrationId)
      await this.postTaskLink(
        agentId,
        message,
        row.childSessionKey,
        row.title,
        'handed',
        this.placeLink(message, place)
      )
      return { taskKey: row.childSessionKey, moved: true }
    }
    const thread = replyThreadOf(msg)
    const at = { platform: msg.platform, channel: msg.channel, transportScope: msg.transportScope ?? null, thread }
    const owner = await index.taskOfThread(agentId, at)
    if (owner !== undefined && owner !== row.childSessionKey)
      throw new Error(
        `sendMessage: the thread of ${message.id} already belongs to task ${owner}; hand the message there`
      )
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

  /** A task's place, when it works in a conversation other than the message's (§6.8). */
  private async placeOf(
    taskKey: string,
    threads: readonly { channel: string; thread: string }[],
    msg: NormalizedMessage
  ): Promise<TaskPlace | undefined> {
    const session = await this.host.store().getSession(taskKey)
    const home = session ? { channel: session.channel, thread: session.thread } : threads[0]!
    return home.channel === msg.channel ? undefined : { channel: home.channel, thread: home.thread }
  }

  /** Dispatch a message to a threaded task: the task keeps its own session, the message's thread stays where it answers (§6.4). */
  private async deliverToTask(
    agentId: string,
    taskKey: string,
    message: DeliveredMessage,
    background?: string
  ): Promise<void> {
    const store = this.host.store()
    if (threadless(message.msg)) {
      // A page task's message moves into its conversation, which the coordinator links to (§10).
      const sessionThread = pageTaskCoordinate(taskKey, message.msg.platform, agentId)
      if (sessionThread === undefined) throw new Error(`sendMessage: ${taskKey} has no page this message can move to`)
      this.host.dispatch(
        agentId,
        messageForPageTask(
          message.msg,
          { channel: a2aCoordChannel(agentId), sessionThread },
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
      messageForTask(message.msg, {
        ...(sessionThread ? { sessionThread } : {}),
        ...(background ? { background } : {})
      }),
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
    // A fallback task stays in the message's thread, as Per thread would answer it (§4.5).
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

  /** End a coordinator turn: a one-message turn's text is its reply, and a mention left without an outcome goes to a task (§4.3, §4.5). */
  async settleTurn(key: string, agentId: string, ended: 'answered' | 'failed' | 'stopped'): Promise<void> {
    const settled = this.turns.end(key, isNoResponsePrefix)
    // A stopped turn was stopped on purpose: nothing it left undecided is acted on.
    if (!settled || ended === 'stopped') return
    if (ended === 'answered' && settled.reply !== undefined) {
      const [message] = settled.undecided
      // A reply a browser already streamed is committed with its turn.
      if (message!.streamed) return
      await this.host
        .post(agentId, message!.integrationId, message!.msg, settled.reply)
        .catch((err: unknown) => this.host.warn(`coordinator ${key}: reply to ${message!.id} failed (${String(err)})`))
      return
    }
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
