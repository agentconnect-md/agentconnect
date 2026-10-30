// The coordinator session's outcomes (auto-session-mode.md §4.2–§4.5, §5.1): open a threaded task, hand a message to one, reply, or fall back.
import { z } from 'zod'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { SessionContext } from '../mcp/ops/context.js'
import { parseArgs, requiredString, ToolArgumentError } from '../mcp/ops/args.js'
import { taskTitleField, TASK_TITLE_MAX_CHARS } from '../mcp/ops/send-message-actions.js'
import { deriveTitle } from '../session/derive-title.js'
import { isNoResponsePrefix } from '../session/no-response.js'
import { sessionKey, type LocalStore } from '../store/local-store.js'
import { coordinatorMessageId } from './coordinator-prompt.js'
import { CoordinatorTurns, platformMessageIdOf, replyThreadOf, type DeliveredMessage } from './coordinator-turns.js'

/** A threaded task whose session has been idle this long closes, and its threads become unowned (auto-session-mode.md §6.5). */
export const THREADED_TASK_IDLE_CLOSE_MS = 7 * 24 * 60 * 60_000

/** What the coordinator module needs from its daemon. */
export interface CoordinatorSessionsHost {
  store(): LocalStore
  now(): number
  /** Admit a message into the session its coordinates key; the turn runs on its own. */
  dispatch(agentId: string, msg: NormalizedMessage, integrationId?: string): void
  /** Post the agent's own text in a message's thread. */
  post(agentId: string, integrationId: string | undefined, msg: NormalizedMessage, text: string): Promise<void>
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
    ...(background
      ? {
          turnBody: {
            ...msg.turnBody,
            prompt: `${msg.turnBody?.prompt ?? msg.text}\n\n${BACKGROUND_HEAD} ${background})`
          }
        }
      : {})
  }
}

/** A fallback task's title: the message's first line, cut to a task title's length. */
function fallbackTitle(msg: NormalizedMessage): string {
  const line = deriveTitle(msg.text)?.replace(/\s+/g, ' ').trim() || 'Message'
  const chars = [...line]
  return chars.length <= TASK_TITLE_MAX_CHARS ? line : `${chars.slice(0, TASK_TITLE_MAX_CHARS - 1).join('')}…`
}

/** The coordinator sessions of every `auto` conversation on this daemon, with their live turns. */
export class CoordinatorSessions {
  readonly turns = new CoordinatorTurns()

  constructor(private readonly host: CoordinatorSessionsHost) {}

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
      switch (call.action) {
        case 'delegateTask': {
          const taskId = await this.openTask(key, ctx.agentId, held.message, call.title, call.message)
          this.turns.settle(key, call.messageId, 'delegate')
          return { ok: true, taskId, title: call.title, note: "Task opened; it answers in the message's thread." }
        }
        case 'messageTask': {
          const taskId = await this.handTo(key, ctx.agentId, call.taskId, held.message, call.message)
          this.turns.settle(key, call.messageId, 'route')
          return { ok: true, taskId, attachedThread: call.messageId }
        }
        case 'replyToMessage': {
          await this.host.post(ctx.agentId, held.message.integrationId, held.message.msg, call.message)
          this.turns.settle(key, call.messageId, 'reply')
          return { ok: true, posted: { channel: ctx.channel, thread: call.messageId } }
        }
      }
    } catch (err) {
      this.turns.release(key, call.messageId)
      throw err
    }
  }

  /** Open a threaded task for a message (§5.1): its session is the message's thread, which it holds from now on. */
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
    this.host.dispatch(
      agentId,
      messageForTask(msg, { title, ...(background ? { background } : {}) }),
      message.integrationId
    )
    return taskKey
  }

  /** Hand a message to one of the coordinator's threaded tasks and attach its thread (§5.1, §6.4). */
  private async handTo(
    coordinatorKey: string,
    agentId: string,
    taskId: string,
    message: DeliveredMessage,
    background?: string
  ): Promise<string> {
    const { msg } = message
    const store = this.host.store()
    const index = store.assistantSubsessions
    const row =
      (await index.get(agentId, taskId)) ??
      (await store.getSessionByOutwardIdOnly(taskId, agentId).then((s) => (s ? index.get(agentId, s.key) : undefined)))
    if (!row || row.kind === 'follow-up' || row.parentSessionKey !== coordinatorKey)
      throw new Error(`sendMessage: ${taskId} is not one of your open tasks; listTasks lists them`)
    const threads = await index.threadsOf(agentId, row.childSessionKey)
    if (threads.length === 0)
      throw new Error(
        `sendMessage: task ${taskId} works in the background and cannot take a channel message; open a task for the ` +
          'message with action "delegateTask" instead'
      )
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
    return row.childSessionKey
  }

  /** Dispatch a message to a threaded task: the task keeps its own session, the message's thread stays where it answers (§6.4). */
  private async deliverToTask(
    agentId: string,
    taskKey: string,
    message: DeliveredMessage,
    background?: string
  ): Promise<void> {
    const store = this.host.store()
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
    else await this.openTask(key, agentId, message, fallbackTitle(msg))
  }

  /** End a coordinator turn: a one-message turn's text is its reply, and a mention left without an outcome goes to a task (§4.3, §4.5). */
  async settleTurn(key: string, agentId: string, ended: 'answered' | 'failed' | 'stopped'): Promise<void> {
    const settled = this.turns.end(key, isNoResponsePrefix)
    // A stopped turn was stopped on purpose: nothing it left undecided is acted on.
    if (!settled || ended === 'stopped') return
    if (ended === 'answered' && settled.reply !== undefined) {
      const [message] = settled.undecided
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

/** The delivered-message entry for one admitted coordinator message. */
export function deliveredMessage(msg: NormalizedMessage, integrationId?: string): DeliveredMessage {
  return {
    id: coordinatorMessageId(platformMessageIdOf(msg)),
    msg,
    ...(integrationId !== undefined ? { integrationId } : {}),
    mentionsYou: msg.trigger === 'mention'
  }
}
