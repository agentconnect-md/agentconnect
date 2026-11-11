// Approved proposals (assistant-mode.md §5.10): each runs once with normal permissions, in a thread of its follow-up's place or a sub-session of it (auto-session-mode.md §6.9.1), and a cut one is never re-run (§5.7 step 1).
import { renderedSessionMessageInput } from '../collab/session-message.js'
import { newSessionMessageId } from '../store/session-messages.js'
import type { Agent } from '../agents/agent-schema.js'
import {
  DEFAULT_MAX_CONCURRENT_SUBSESSIONS,
  SUBSESSION_START_GRACE_MS,
  type SubsessionTurnEnd
} from '../collab/coordinator.js'
import type { CallMeta } from '../daemon/turn-types.js'
import { sessionThreadOf, type NormalizedMessage } from '../messages/normalized.js'
import { isSubsessionCoordinate, taskCoordinate } from '../session/subsession-coordinate.js'
import type { AssistantDraft, AssistantDraftLedger } from '../store/assistant-drafts.js'
import type { AssistantPlace } from '../store/assistant-items.js'
import { followUpTaskKey, type CheckedTask, type CheckedTasks } from './checked-tasks.js'
import type { AssistantSubsessionIndex } from '../store/assistant-subsessions.js'
import { sessionKey } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import type { Decider, FollowUpTake, TaskStart } from './drafts.js'
import type { CheckParent } from './follow-up-checks.js'

/** Where a sub-session sits, for a report the daemon makes into its parent on its behalf. */
export interface TaskCaller {
  platform: string
  channel: string
  thread: string
  transportScope?: string | undefined
}

/** A turn message's sub-session coordinates. */
export const callerOfMessage = (msg: NormalizedMessage): TaskCaller => ({
  platform: msg.platform,
  channel: msg.channel,
  thread: sessionThreadOf(msg),
  ...(msg.transportScope !== undefined ? { transportScope: msg.transportScope } : {})
})

export interface AssistantTasksHost {
  now(): number
  log: { info(message: string): void; warn(message: string): void }
  ledger(): Pick<
    AssistantDraftLedger,
    | 'beginTask'
    | 'failTask'
    | 'settleTask'
    | 'settleTaskIn'
    | 'taskBySubsession'
    | 'executingTasks'
    | 'beginFollowUp'
    | 'settleFollowUp'
    | 'setTaskSession'
    | 'settleUnstarted'
    | 'get'
  >
  subsessions: Pick<
    AssistantSubsessionIndex,
    'openWithinLimitClaiming' | 'openClaiming' | 'finishClaiming' | 'finish' | 'get'
  >
  /** The follow-up or getting-to-know task a proposal acts on, by its task key. */
  items: Pick<CheckedTasks, 'get'>
  agent(agentId: string): Pick<Agent, 'name' | 'assistantMode'> | undefined
  /** This daemon holds the agent's duty. */
  servesAgent(agentId: string): boolean
  /** The long session of the item's place, which the task takes as its parent and reports into. */
  parentFor(agentId: string, place: AssistantPlace): Promise<CheckParent | undefined>
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId: string | undefined,
    callMeta: CallMeta,
    onAdmission: (result: { accepted: boolean; reason?: string }) => void
  ): Promise<unknown>
  /** A delegated sub-session's end: its own report stands, else the daemon's failure report goes (§5.7). */
  settleSubsession(end: SubsessionTurnEnd): Promise<void>
  /** One report into the place's current long session, else the recorded parent; true once admitted, at most once per `reportId`. */
  reportToParent(
    agentId: string,
    caller: TaskCaller,
    parentSessionId: string,
    text: string,
    reportId: string
  ): Promise<boolean>
  /** The card and the item take in how the task ended. */
  settled(draft: AssistantDraft): Promise<void>
  /** Where a task of this place may answer in a thread (auto-session-mode.md §6.9.1); undefined where it runs with none, as today. */
  homeFor?(draft: AssistantDraft, parent: CheckParent): Promise<TaskHome | undefined>
  /** One line as the agent in a thread a task holds; best effort. */
  say?(agentId: string, at: TaskCaller, text: string): Promise<void>
  /** Tell the Control Plane which session owns each of these tasks now (auto-session-mode.md §6.2). */
  reportTaskOwners?(agentId: string, keys: string[]): Promise<void>
  /** Take a follow-up of a place under the task key an approval minted (assistant-mode.md §5.12). */
  takeFollowUp?(input: {
    taskKey: string
    agentId: string
    origin: AssistantPlace
    caller: { sessionId: string; key: string }
    title: string
    doneWhen: string
    nextCheck?: number
    summary?: string
    asker: string
    /** The platform thread its reports reply in, as the offering turn's would (§5.10). */
    replyThread?: string
  }): Promise<CheckedTask>
  /** Watch a taken follow-up's object (assistant-mode.md §5.14); why it is not watched, or undefined when it is or will be. */
  watchFollowUp?(agentId: string, taskKey: string, url: string): Promise<string | undefined>
  draining(): boolean
}

/** A thread of its place an approved task may hold (auto-session-mode.md §6.9.1). */
export interface TaskHome {
  /** The proposal's own card, when it sits at the place's top level: its thread is the home. */
  card?: string
  /** The card became the task's root: record it in the place's conversation, which holds no row for a card. */
  cardRooted?(by: { name: string | null }): Promise<void>
  /** Post the root a task with no card to hold starts under; undefined when it did not post or may not have. */
  postRoot(by: { name: string | null }): Promise<string | undefined>
  /** The place is one person's own conversation with the agent, as a member's webchat coordinator is. */
  isDm?: boolean
}

/** A follow-up a proposal may still act on: open, or a getting-to-know task, which ends after its one check by design (§5.13). */
const actsOn = (item: Pick<CheckedTask, 'status' | 'gettingToKnow'>): boolean =>
  item.status === 'active' || item.status === 'waiting' || item.gettingToKnow !== null

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The approved proposal's first message: what was approved, by whom, and the follow-up it serves; `home` says its reply posts in the thread it holds. */
export function taskPrompt(
  draft: AssistantDraft,
  item: CheckedTask,
  by: { name: string | null },
  home = false
): string {
  const proposal = draft.proposal!
  const origin =
    item.gettingToKnow !== null
      ? 'You proposed this after reading this place’s recent messages'
      : 'A check of one of your follow-ups proposed this'
  const where = home
    ? 'approved it. Carry it out now, with your normal tools and permissions. Your reply posts in this thread, where ' +
      'the people of the conversation read it and may answer you.'
    : 'approved it. Carry it out now in this background session, with your normal tools and permissions. Nothing ' +
      'you write here is posted anywhere.'
  return [
    `[approved proposal] ${origin}, and ${by.name ?? 'an approver'} ${where}`,
    '',
    `Work: ${draft.text.trim()}`,
    `Why: ${proposal.why.trim() === '' ? 'not given' : proposal.why.trim()}`,
    `Proposed as: ${oneLine(proposal.sentence)}`,
    '',
    item.gettingToKnow !== null
      ? `Follow-up (getting to know, ended): ${oneLine(item.title)}`
      : `Follow-up (${item.status === 'active' || item.status === 'waiting' ? 'open' : 'ended'}): ${oneLine(item.title)}`,
    `Done when: ${item.doneWhen === null ? 'not set' : oneLine(item.doneWhen)}`,
    `Background: ${item.background.trim() === '' ? 'none' : item.background.trim()}`,
    `Last check: ${item.summary.trim() === '' ? 'none yet' : item.summary.trim()}`,
    '',
    `The follow-up was at version ${proposal.itemVersion} when this was proposed and is at version ${item.version} ` +
      'now. Check the current state first, and do not act if the work no longer applies; say so in your report ' +
      'instead. Do exactly this work, nothing more. Write your report in the language the people in the ' +
      'follow-up’s conversation use; without a message of theirs to go by, use the language of its title and summary.'
  ].join('\n')
}

/** Starts approved tasks and settles them; a cut one is reported as uncertain and never runs again. */
export class AssistantTasks {
  /** Sub-sessions this process started and has not seen end, which a recovery sweep must leave alone. */
  private readonly running = new Set<string>()
  /** Approved tasks this process is posting a root for, which a recovery sweep must leave alone. */
  private readonly rooting = new Set<string>()

  constructor(private readonly host: AssistantTasksHost) {}

  /** Approval: the sub-session's index row and `executing` with its key in one transaction, then the dispatch. */
  async start(draft: AssistantDraft, by: { id: string | null; name: string | null }): Promise<TaskStart> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    const proposal = draft.proposal
    const fail = async (reason: string): Promise<TaskStart> =>
      (await ledger.failTask(draft.id, by, reason, now)) ? { kind: 'failed', reason } : { kind: 'lost' }
    if (!proposal) return await fail('the proposal has no follow-up')
    if (proposal.itemId === null) return await fail('an offered follow-up runs no task')
    // Left waiting: the duty holder runs it, and a click that reached another daemon is tried again there.
    if (!this.host.servesAgent(draft.agentId) || this.host.draining())
      return { kind: 'busy', reason: 'the agent is not running here right now; approve again in a moment' }
    const item = await this.host.items.get(draft.agentId, proposal.itemId)
    if (!item) return await fail('its follow-up is gone')
    if (!actsOn(item)) return await fail('its follow-up has ended')
    const parent = await this.host.parentFor(draft.agentId, item.origin)
    if (!parent) return await fail('the conversation its follow-up belongs to has no ongoing session to report to')
    const home = await this.host.homeFor?.(draft, parent).catch((err: unknown) => {
      this.host.log.warn(`assistant task ${draft.id}: no thread for it: ${(err as Error).message}`)
      return undefined
    })
    if (home) return await this.startAtHome(draft, by, item, parent, home, now)
    const deliveryId = monotonicTs()
    const thread = taskCoordinate(deliveryId)
    const key = sessionKey(parent.platform, parent.channel, thread, draft.agentId, parent.transportScope)
    const agent = this.host.agent(draft.agentId)
    const limit = agent?.assistantMode?.limits?.maxConcurrentSubsessions ?? DEFAULT_MAX_CONCURRENT_SUBSESSIONS
    this.running.add(key)
    const claimed = await this.host.subsessions
      .openWithinLimitClaiming(
        {
          agentId: draft.agentId,
          childSessionKey: key,
          parentSessionId: parent.sessionId,
          parentSessionKey: parent.key,
          now
        },
        { limit, startedSince: now - SUBSESSION_START_GRACE_MS },
        (tx) => ledger.beginTask(draft.id, by, key, now, tx)
      )
      .catch((err: unknown) => {
        this.running.delete(key)
        throw err
      })
    if (claimed !== 'opened') {
      this.running.delete(key)
      if (claimed === 'refused') return { kind: 'lost' }
      return {
        kind: 'busy',
        reason:
          `${agent?.name ?? 'The agent'} already has ${limit} task${limit === 1 ? '' : 's'} running, the most it runs at once. ` +
          'Approve again once one of them finishes; this proposal is still waiting.'
      }
    }
    this.runInBackground(draft, by, item, parent, key, deliveryId)
    return { kind: 'started' }
  }

  /** A task with a home (auto-session-mode.md §6.9.1): on its card's thread in the approval's own transaction, else the decision is won first and a root posts. */
  private async startAtHome(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    item: CheckedTask,
    parent: CheckParent,
    home: TaskHome,
    now: number
  ): Promise<TaskStart> {
    const ledger = this.host.ledger()
    if (home.card !== undefined) {
      const opened = await this.openAt(draft, parent, home.card, now, (tx, key) =>
        ledger.beginTask(draft.id, by, key, now, tx)
      )
      if (opened.kind === 'refused') return { kind: 'lost' }
      if (opened.kind === 'opened') {
        await home.cardRooted?.(by).catch((err: unknown) => {
          this.host.log.warn(`assistant task ${draft.id}: its card's root was not recorded: ${(err as Error).message}`)
        })
        this.runAtHome(draft, by, item, parent, home.card, opened.key, home.isDm === true)
        return { kind: 'started' }
      }
      // A task took the card's thread before the approval: it starts under a root of its own.
    }
    if (!(await ledger.beginTask(draft.id, by, null, now))) return { kind: 'lost' }
    this.rooting.add(draft.id)
    try {
      const root = await home.postRoot(by).catch((err: unknown) => {
        this.host.log.warn(`assistant task ${draft.id}: its root did not post: ${(err as Error).message}`)
        return undefined
      })
      if (root !== undefined) {
        const opened = await this.openAt(draft, parent, root, now, (tx, key) =>
          ledger.setTaskSession(draft.id, key, tx)
        )
        if (opened.kind === 'opened') {
          this.runAtHome(draft, by, item, parent, root, opened.key, home.isDm === true)
          return { kind: 'started' }
        }
        // Another path gave it a session meanwhile, so nothing more starts here.
        if (opened.kind === 'refused') return { kind: 'started' }
      }
      await this.startWithoutHome(draft, by, item, parent)
      return { kind: 'started' }
    } finally {
      this.rooting.delete(draft.id)
    }
  }

  /** Index a task on a thread of its place, holding that thread, with `claim` in the same transaction. */
  private async openAt(
    draft: AssistantDraft,
    parent: CheckParent,
    thread: string,
    now: number,
    claim: (tx: Parameters<Parameters<AssistantSubsessionIndex['openClaiming']>[2]>[0], key: string) => Promise<boolean>
  ): Promise<{ kind: 'opened' | 'held' | 'refused'; key: string }> {
    const key = sessionKey(parent.platform, parent.channel, thread, draft.agentId, parent.transportScope)
    this.running.add(key)
    try {
      const kind = await this.host.subsessions.openClaiming(
        {
          agentId: draft.agentId,
          childSessionKey: key,
          parentSessionId: parent.sessionId,
          parentSessionKey: parent.key,
          title: oneLine(draft.proposal?.sentence ?? draft.text).slice(0, 80),
          background: draft.text,
          replyThread: thread,
          now
        },
        {
          platform: parent.platform,
          channel: parent.channel,
          ...(parent.transportScope ? { transportScope: parent.transportScope } : {}),
          thread
        },
        (tx) => claim(tx, key)
      )
      if (kind !== 'opened') this.running.delete(key)
      return { kind, key }
    } catch (err) {
      this.running.delete(key)
      throw err
    }
  }

  /** An approved task whose root never posted, or whose thread was taken, runs with no home, outside the cap its approval already passed. */
  private async startWithoutHome(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    item: CheckedTask,
    parent: CheckParent
  ): Promise<void> {
    const deliveryId = monotonicTs()
    const key = sessionKey(
      parent.platform,
      parent.channel,
      taskCoordinate(deliveryId),
      draft.agentId,
      parent.transportScope
    )
    this.running.add(key)
    const opened = await this.host.subsessions
      .openClaiming(
        {
          agentId: draft.agentId,
          childSessionKey: key,
          parentSessionId: parent.sessionId,
          parentSessionKey: parent.key,
          now: this.host.now()
        },
        undefined,
        (tx) => this.host.ledger().setTaskSession(draft.id, key, tx)
      )
      .catch((err: unknown) => {
        this.host.log.warn(`assistant task ${draft.id}: could not start with no thread: ${(err as Error).message}`)
        return 'refused' as const
      })
    if (opened !== 'opened') {
      this.running.delete(key)
      return
    }
    this.runInBackground(draft, by, item, parent, key, deliveryId)
  }

  /** The first turn of a task with a home: the approved work, as a message in the thread it holds, where its reply posts. */
  private runAtHome(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    item: CheckedTask,
    parent: CheckParent,
    thread: string,
    key: string,
    isDm: boolean
  ): void {
    const deliveryId = monotonicTs()
    const messageId = newSessionMessageId()
    const msg: NormalizedMessage = {
      msgId: `task:${parent.channel}:${deliveryId}`,
      traceId: deliveryId,
      transcriptTs: deliveryId,
      source: 'agent',
      platform: parent.platform as NormalizedMessage['platform'],
      channel: parent.channel,
      thread,
      ...(parent.transportScope ? { transportScope: parent.transportScope } : {}),
      sender: { id: draft.agentId, isBot: true },
      ...renderedSessionMessageInput(
        {
          messageId,
          kind: 'call',
          sourceAgentId: draft.agentId,
          sourceSessionId: parent.sessionId,
          replyRequested: false
        },
        taskPrompt(draft, item, by, true),
        // Its people read the thread: they see the work that was approved, and the rest is the model's.
        { text: draft.text.trim() }
      ),
      mentionedBots: [],
      isDm,
      initialSessionTitle: oneLine(draft.proposal?.sentence ?? draft.text).slice(0, 80)
    }
    // Its root is a message of the place, so the turn binds the place's audience as a person's reply in that thread would.
    const callMeta: CallMeta = {
      callFrom: draft.agentId,
      hopCount: 0,
      deliveryId,
      originSessionId: parent.sessionId,
      messageId,
      messageKind: 'call',
      platformOrigin: true,
      approvedProposal: draft.id
    }
    this.host.log.info(`assistant task ${draft.id}: runs in ${key}, in a thread of its place`)
    void this.host.reportTaskOwners?.(draft.agentId, [key]).catch(() => undefined)
    const never = (reason: string | undefined) =>
      void this.homeTurnEnded({ agentId: draft.agentId, key, outcome: 'refused', reason, replayed: false })
    let admitted = false
    void this.host
      .dispatch(draft.agentId, msg, parent.integrationId, callMeta, (result) => {
        admitted = true
        if (!result.accepted) never(result.reason)
      })
      .catch((err: unknown) => {
        // An admitted turn that failed is settled by the turn engine; one that never got that far is settled here.
        if (admitted) return
        this.host.log.warn(`assistant task ${draft.id}: dispatch failed: ${(err as Error).message}`)
        never('it could not be dispatched')
      })
  }

  /** The first turn of a task with a home ended (auto-session-mode.md §6.9.1): its record settles from the turn, with no report; a cut kept for replay waits for {@link cut}. */
  async homeTurnEnded(end: {
    agentId: string
    key: string
    outcome: 'completed' | 'interrupted' | 'failed' | 'refused'
    reason?: string | undefined
    replayed: boolean
  }): Promise<void> {
    const { agentId, key } = end
    this.running.delete(key)
    if (end.replayed) return
    try {
      // A turn that never ran leaves its row open, which nothing else would settle.
      if (end.outcome === 'refused') await this.host.subsessions.finish(agentId, key, 'failed')
      const settled = await this.host
        .ledger()
        .settleTask(
          agentId,
          key,
          end.outcome === 'completed' ? 'succeeded' : 'failed',
          end.outcome === 'completed' ? null : homeEndReason(end),
          this.host.now()
        )
      if (settled) await this.host.settled(settled)
    } catch (err) {
      this.host.log.warn(`assistant task ${key}: could not settle: ${(err as Error).message}`)
    }
  }

  /** The run of a task with no home: a sub-session of its place that owes its parent one report. */
  private runInBackground(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    item: CheckedTask,
    parent: CheckParent,
    key: string,
    deliveryId: string
  ): void {
    const proposal = draft.proposal!
    const thread = taskCoordinate(deliveryId)
    // send-message-guide.md §9.3: its input is a session message from the session that started it, answerable by id.
    const messageId = newSessionMessageId()
    const msg: NormalizedMessage = {
      msgId: `task:${parent.channel}:${deliveryId}`,
      traceId: deliveryId,
      transcriptTs: deliveryId,
      source: 'agent',
      platform: parent.platform as NormalizedMessage['platform'],
      channel: parent.channel,
      thread,
      ...(parent.transportScope ? { transportScope: parent.transportScope } : {}),
      sender: { id: draft.agentId, isBot: true },
      ...renderedSessionMessageInput(
        {
          messageId,
          kind: 'call',
          sourceAgentId: draft.agentId,
          sourceSessionId: parent.sessionId,
          replyRequested: true
        },
        taskPrompt(draft, item, by)
      ),
      mentionedBots: [],
      isDm: false,
      headless: true,
      initialSessionTitle: `Approved proposal: ${oneLine(proposal.sentence).slice(0, 80)}`
    }
    // A delegated sub-session's lineage: it owes its parent one report, and the daemon sends one if it does not.
    const callMeta: CallMeta = {
      callFrom: draft.agentId,
      hopCount: 0,
      deliveryId,
      originSessionId: parent.sessionId,
      messageId,
      messageKind: 'call',
      originCoords: {
        platform: parent.platform as NonNullable<CallMeta['originCoords']>['platform'],
        channel: parent.channel,
        thread: parent.thread
      },
      needsReply: true,
      ...parent.inherited
    }
    this.host.log.info(`assistant task ${draft.id}: runs in ${key}`)
    let admitted = false
    void this.host
      .dispatch(draft.agentId, msg, parent.integrationId, callMeta, (result) => {
        admitted = true
        if (!result.accepted)
          void this.ended({
            agentId: draft.agentId,
            key,
            msg,
            outcome: 'refused',
            reason: result.reason,
            replayed: false
          })
      })
      .catch((err: unknown) => {
        // An admitted turn that failed is settled by the turn engine; one that never got that far is settled here.
        if (admitted) return
        this.host.log.warn(`assistant task ${draft.id}: dispatch failed: ${(err as Error).message}`)
        void this.ended({ agentId: draft.agentId, key, msg, outcome: 'failed', replayed: false })
      })
  }

  /** Approval of a follow-up form (assistant-mode.md §5.13): the record names the follow-up it takes, then the follow-up is taken; no task runs and no limit counts. */
  async takeFollowUp(draft: AssistantDraft, by: Decider): Promise<FollowUpTake> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    const proposal = draft.proposal
    const form = proposal?.followUp
    const fail = async (reason: string): Promise<FollowUpTake> =>
      (await ledger.failTask(draft.id, by, reason, now)) ? { kind: 'failed', reason } : { kind: 'lost' }
    if (!proposal || !form || !this.host.takeFollowUp) return await fail('the proposal has no follow-up to take')
    if (!by.asker) return await fail('the approver could not be identified')
    // Left waiting: the duty holder takes it, and a click that reached another daemon is tried again there.
    if (!this.host.servesAgent(draft.agentId) || this.host.draining())
      return { kind: 'busy', reason: 'the agent is not running here right now; approve again in a moment' }
    // An offer from an ordinary turn acts on no task: its record names the conversation and the session that offered it.
    const offered = proposal.itemId === null ? offerOf(draft) : undefined
    const item = proposal.itemId === null ? undefined : await this.host.items.get(draft.agentId, proposal.itemId)
    if (!offered && !item) return await fail('its follow-up is gone')
    if (item && !actsOn(item)) return await fail('its follow-up has ended')
    const origin = item?.origin ?? offered!.origin
    const parent = (await this.host.parentFor(draft.agentId, origin)) ?? offered?.caller
    if (!parent) return await fail('the conversation its follow-up belongs to has no ongoing session to report to')
    const taskKey = followUpTaskKey(draft.agentId, origin)
    if (!(await ledger.beginFollowUp(draft.id, by, taskKey, now))) return { kind: 'lost' }
    try {
      await this.host.takeFollowUp({
        taskKey,
        agentId: draft.agentId,
        origin,
        caller: offered?.caller ?? { sessionId: parent.sessionId, key: parent.key },
        ...(offered?.replyThread ? { replyThread: offered.replyThread } : {}),
        title: form.title,
        doneWhen: form.doneWhen,
        ...(form.nextCheck !== null ? { nextCheck: form.nextCheck } : {}),
        ...(proposal.why.trim() !== '' ? { summary: proposal.why } : {}),
        asker: by.asker
      })
    } catch (err) {
      const reason = `the follow-up could not be taken: ${(err as Error).message}`
      await ledger.settleFollowUp(draft.id, 'failed', reason, this.host.now())
      return { kind: 'failed', reason }
    }
    // The approver confirmed the follow-up, not the watch: a refused one is said on the card, kept in the record's failure field.
    const unwatched = form.watch
      ? await this.host.watchFollowUp?.(draft.agentId, taskKey, form.watch).catch(() => undefined)
      : undefined
    await ledger.settleFollowUp(draft.id, 'succeeded', unwatched ?? null, this.host.now())
    this.host.log.info(`assistant proposal ${draft.id}: took follow-up ${taskKey}`)
    return { kind: 'taken', taskKey, parentSessionId: parent.sessionId }
  }

  /** A task's turn ended: reported back is `succeeded`, ended without a report `failed`; a cut kept for replay waits for {@link cut}. */
  async ended(end: SubsessionTurnEnd): Promise<void> {
    const { agentId, key } = end
    try {
      if (end.replayed) {
        this.running.delete(key)
        return
      }
      await this.host.settleSubsession(end)
      const row = await this.host.subsessions.get(agentId, key)
      // Still open: a background task owes it a wake, whose turn settles it.
      if (row?.state === 'open') return
      this.running.delete(key)
      const reported = row?.state === 'done'
      const settled = await this.host
        .ledger()
        .settleTask(agentId, key, reported ? 'succeeded' : 'failed', reported ? null : endReason(end), this.host.now())
      if (settled) await this.host.settled(settled)
    } catch (err) {
      this.host.log.warn(`assistant task ${key}: could not settle: ${(err as Error).message}`)
    }
  }

  /** A task the inbox kept for replay is never re-run: one that already reported or was reported ended settles as such, else it may or may not have gone through and its place is told once. */
  async cut(agentId: string, key: string, caller: TaskCaller | undefined): Promise<void> {
    try {
      // Left executing while the daemon drains, so whoever recovers it next tells its place.
      if (this.host.draining()) return
      const ledger = this.host.ledger()
      // An open sub-session of an executing task is what the claim below cuts: its place is told first, so a crash in between re-reports instead of losing it.
      const draft = await ledger.taskBySubsession(agentId, key)
      const row = await this.host.subsessions.get(agentId, key)
      if (draft?.status === 'executing' && row?.state === 'open') {
        const at = caller ?? callerOf(draft, key)
        // A task with a home says so in its thread, where a failed turn of any threaded task shows; one without tells its place.
        if (at && !isSubsessionCoordinate(at.thread) && this.host.say)
          await this.host
            .say(
              agentId,
              at,
              'Not sure this went through, please check: this work was cut short by a restart before it finished. It ' +
                'may have partly run, and it will not be run again.'
            )
            .catch((err: unknown) =>
              this.host.log.warn(
                `assistant task ${key}: its uncertain-outcome notice failed: ${(err as Error).message}`
              )
            )
        else await this.reportCut(agentId, key, draft, row.parentSessionId, caller)
      }
      const now = this.host.now()
      // The sub-session's durable end and the record's settlement in one transaction, so a racing end settles it once.
      const ended = await this.host.subsessions.finishClaiming(agentId, key, (tx, how) =>
        ledger.settleTaskIn(
          tx,
          agentId,
          key,
          how === 'done' ? 'succeeded' : how === 'failed' ? 'failed' : 'outcome_unknown',
          how === 'done'
            ? null
            : how === 'failed'
              ? 'it ended without reporting back'
              : 'cut short by a restart or handover',
          now
        )
      )
      this.running.delete(key)
      const settled = ended ? await ledger.taskBySubsession(agentId, key) : undefined
      if (!settled) return
      await this.host.settled(settled)
    } catch (err) {
      this.host.log.warn(`assistant task ${key}: could not record the cut: ${(err as Error).message}`)
    }
  }

  /** The one "please check" report of a cut task, which its place gets once however often it is sent. */
  private async reportCut(
    agentId: string,
    key: string,
    draft: AssistantDraft,
    parentSessionId: string,
    caller: TaskCaller | undefined
  ): Promise<void> {
    const proposal = draft.proposal
    const at = caller ?? callerOf(draft, key)
    if (!at || !proposal) return
    const item = proposal.itemId === null ? undefined : await this.host.items.get(agentId, proposal.itemId)
    const delivered = await this.host
      .reportToParent(
        agentId,
        at,
        parentSessionId,
        `[approved proposal cut short] Not sure this went through, please check: the approved proposal "${oneLine(proposal.sentence)}"` +
          (item ? ` for follow-up "${oneLine(item.title)}"` : '') +
          ' was cut short by a restart or handover before it reported back. It may have partly run, and it will ' +
          'not be run again. Tell the people here to check.',
        `task:${draft.id}`
      )
      .catch((err: unknown) => {
        this.host.log.warn(`assistant task ${key}: its uncertain-outcome report failed: ${(err as Error).message}`)
        return false
      })
    if (!delivered) this.host.log.warn(`assistant task ${key}: its uncertain-outcome report was not delivered`)
  }

  /** Executing tasks of these agents that nothing here runs were cut before they reported (§5.7 step 1). */
  async recover(agentIds: readonly string[]): Promise<void> {
    const served = agentIds.filter((agentId) => this.host.servesAgent(agentId))
    for (const draft of await this.host.ledger().executingTasks(served)) {
      if (!draft.subsessionKey) {
        if (!this.rooting.has(draft.id)) await this.startUnrooted(draft)
        continue
      }
      if (this.running.has(draft.subsessionKey)) continue
      await this.cut(draft.agentId, draft.subsessionKey, undefined)
    }
  }

  /** An approval won before its root posted and cut there has started no work (auto-session-mode.md §6.9.1): it runs now, with no home. */
  private async startUnrooted(draft: AssistantDraft): Promise<void> {
    if (this.host.draining()) return
    try {
      const proposal = draft.proposal
      const item = proposal?.itemId ? await this.host.items.get(draft.agentId, proposal.itemId) : undefined
      const parent = item ? await this.host.parentFor(draft.agentId, item.origin) : undefined
      if (!item || !parent) {
        const ledger = this.host.ledger()
        const failure = item ? 'its conversation has no ongoing session to report to' : 'its follow-up is gone'
        if (await ledger.settleUnstarted(draft.id, failure, this.host.now())) {
          const settled = await ledger.get(draft.id)
          if (settled) await this.host.settled(settled)
        }
        return
      }
      this.rooting.add(draft.id)
      try {
        await this.startWithoutHome(draft, { id: draft.decidedBy, name: draft.decidedByName }, item, parent)
      } finally {
        this.rooting.delete(draft.id)
      }
    } catch (err) {
      this.host.log.warn(
        `assistant task ${draft.id}: could not start after its root was cut: ${(err as Error).message}`
      )
    }
  }
}

function homeEndReason(end: { outcome: string; reason?: string | undefined }): string {
  if (end.outcome === 'refused') return `it did not start: ${end.reason ?? 'refused'}`
  if (end.outcome === 'failed') return 'it failed'
  return `it was stopped (${end.reason ?? 'interrupted'})`
}

function endReason(end: SubsessionTurnEnd): string {
  if (end.outcome === 'completed') return 'it ended without reporting back'
  if (end.outcome === 'refused') return `it did not start: ${end.reason ?? 'refused'}`
  if (end.outcome === 'failed') return 'it failed'
  return `it was stopped (${end.reason ?? 'interrupted'})`
}

/** An offer's conversation, the session that offered it, and the thread that session's reply landed in (§5.10); undefined without its session. */
function offerOf(
  draft: AssistantDraft
): { origin: AssistantPlace; caller: { sessionId: string; key: string }; replyThread: string | undefined } | undefined {
  const source = draft.source
  if (!source?.sessionId || !source.sessionKey) return undefined
  const origin = {
    platform: draft.target.platform,
    channel: draft.target.channel,
    transportScope: source.transportScope
  }
  return {
    origin,
    caller: { sessionId: source.sessionId, key: source.sessionKey },
    replyThread: draft.target.thread ?? undefined
  }
}

/** The task sub-session's coordinates, from its key and the place it shares with the follow-up that proposed it. */
function callerOf(draft: AssistantDraft, key: string): TaskCaller | undefined {
  const source = draft.source
  if (!source) return undefined
  const prefix = `${source.platform}:${source.channel}:`
  const suffix = `:${draft.agentId}${source.transportScope ? `:${source.transportScope}` : ''}`
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined
  const thread = key.slice(prefix.length, key.length - suffix.length)
  if (sessionKey(source.platform, source.channel, thread, draft.agentId, source.transportScope) !== key)
    return undefined
  return {
    platform: source.platform,
    channel: source.channel,
    thread,
    ...(source.transportScope ? { transportScope: source.transportScope } : {})
  }
}
