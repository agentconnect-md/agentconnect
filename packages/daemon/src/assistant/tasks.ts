// Approved proposals (assistant-mode.md §5.10): each runs once in a normal-permission sub-session of its follow-up's place, and a cut one is never re-run (§5.7 step 1).
import { randomUUID } from 'node:crypto'
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
import { taskCoordinate } from '../session/subsession-coordinate.js'
import type { AssistantDraft, AssistantDraftLedger } from '../store/assistant-drafts.js'
import type { AssistantItem, AssistantItemLedger } from '../store/assistant-items.js'
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
  >
  subsessions: Pick<AssistantSubsessionIndex, 'openWithinLimitClaiming' | 'finishClaiming' | 'get'>
  items: Pick<AssistantItemLedger, 'get'>
  agent(agentId: string): Pick<Agent, 'name' | 'assistantMode'> | undefined
  /** This daemon holds the agent's duty. */
  servesAgent(agentId: string): boolean
  /** The long session of the item's place, which the task takes as its parent and reports into. */
  parentFor(agentId: string, place: AssistantItem['origin']): Promise<CheckParent | undefined>
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
  /** Take a follow-up of a place under the id an approval minted (assistant-mode.md §5.12). */
  takeFollowUp?(input: {
    id: string
    agentId: string
    origin: AssistantItem['origin']
    caller: { sessionId: string; key: string }
    title: string
    doneWhen: string
    nextCheck?: number
    summary?: string
    asker: string
  }): Promise<AssistantItem>
  /** Watch a taken follow-up's object (assistant-mode.md §5.14); why it is not watched, or undefined when it is or will be. */
  watchFollowUp?(agentId: string, itemId: string, url: string): Promise<string | undefined>
  draining(): boolean
}

/** A follow-up a proposal may still act on: open, or a first look, which ends after its one check by design (§5.13). */
const actsOn = (item: Pick<AssistantItem, 'status' | 'firstLook'>): boolean =>
  item.status === 'active' || item.status === 'waiting' || item.firstLook !== null

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The approved proposal's first message: what was approved, by whom, and the follow-up it serves. */
export function taskPrompt(draft: AssistantDraft, item: AssistantItem, by: { name: string | null }): string {
  const proposal = draft.proposal!
  const origin =
    item.firstLook !== null
      ? 'You proposed this after reading this place’s recent messages'
      : 'A check of one of your follow-ups proposed this'
  return [
    `[approved proposal] ${origin}, and ${by.name ?? 'an approver'} ` +
      'approved it. Carry it out now in this background session, with your normal tools and permissions. Nothing ' +
      'you write here is posted anywhere.',
    '',
    `Work: ${draft.text.trim()}`,
    `Why: ${proposal.why.trim() === '' ? 'not given' : proposal.why.trim()}`,
    `Proposed as: ${oneLine(proposal.sentence)}`,
    '',
    item.firstLook !== null
      ? `Follow-up (ended after reading the place once): ${oneLine(item.title)}`
      : `Follow-up (${item.status === 'active' || item.status === 'waiting' ? 'open' : 'ended'}): ${oneLine(item.title)}`,
    `Done when: ${item.doneWhen === null ? 'not set' : oneLine(item.doneWhen)}`,
    `Summary: ${item.summary.trim() === '' ? 'none' : item.summary.trim()}`,
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

  constructor(private readonly host: AssistantTasksHost) {}

  /** Approval: the sub-session's index row and `executing` with its key in one transaction, then the dispatch. */
  async start(draft: AssistantDraft, by: { id: string | null; name: string | null }): Promise<TaskStart> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    const proposal = draft.proposal
    const fail = async (reason: string): Promise<TaskStart> =>
      (await ledger.failTask(draft.id, by, reason, now)) ? { kind: 'failed', reason } : { kind: 'lost' }
    if (!proposal) return await fail('the proposal has no follow-up')
    // Left waiting: the duty holder runs it, and a click that reached another daemon is tried again there.
    if (!this.host.servesAgent(draft.agentId) || this.host.draining())
      return { kind: 'busy', reason: 'the agent is not running here right now; approve again in a moment' }
    const item = await this.host.items.get(draft.agentId, proposal.itemId)
    if (!item) return await fail('its follow-up is gone')
    if (!actsOn(item)) return await fail('its follow-up has ended')
    const parent = await this.host.parentFor(draft.agentId, item.origin)
    if (!parent) return await fail('the conversation its follow-up belongs to has no ongoing session to report to')
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
    return { kind: 'started' }
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
    const item = await this.host.items.get(draft.agentId, proposal.itemId)
    if (!item) return await fail('its follow-up is gone')
    if (!actsOn(item)) return await fail('its follow-up has ended')
    const parent = await this.host.parentFor(draft.agentId, item.origin)
    if (!parent) return await fail('the conversation its follow-up belongs to has no ongoing session to report to')
    const itemId = randomUUID()
    if (!(await ledger.beginFollowUp(draft.id, by, itemId, now))) return { kind: 'lost' }
    try {
      await this.host.takeFollowUp({
        id: itemId,
        agentId: draft.agentId,
        origin: item.origin,
        caller: { sessionId: parent.sessionId, key: parent.key },
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
      ? await this.host.watchFollowUp?.(draft.agentId, itemId, form.watch).catch(() => undefined)
      : undefined
    await ledger.settleFollowUp(draft.id, 'succeeded', unwatched ?? null, this.host.now())
    this.host.log.info(`assistant proposal ${draft.id}: took follow-up ${itemId}`)
    return { kind: 'taken', itemId, parentSessionId: parent.sessionId }
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
      if (draft?.status === 'executing' && row?.state === 'open')
        await this.reportCut(agentId, key, draft, row.parentSessionId, caller)
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
    const item = await this.host.items.get(agentId, proposal.itemId)
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
      if (!draft.subsessionKey || this.running.has(draft.subsessionKey)) continue
      await this.cut(draft.agentId, draft.subsessionKey, undefined)
    }
  }
}

function endReason(end: SubsessionTurnEnd): string {
  if (end.outcome === 'completed') return 'it ended without reporting back'
  if (end.outcome === 'refused') return `it did not start: ${end.reason ?? 'refused'}`
  if (end.outcome === 'failed') return 'it failed'
  return `it was stopped (${end.reason ?? 'interrupted'})`
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
