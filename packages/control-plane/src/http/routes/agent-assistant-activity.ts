// An agent's Activity view (assistant-mode.md §1.7, §5.11), whose items and proposals are assistant mode's, and a webchat conversation's proposals (§5.10): bounded reads and edits proxied to the owning daemon, nothing kept here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  ACTIVITY_EVERY_AGENT_V1_FEATURE,
  ASSISTANT_ACTIVITY_DRAFTS_MAX,
  ASSISTANT_ACTIVITY_FEATURE,
  ASSISTANT_CONVERSATION_PROPOSALS_FEATURE,
  ASSISTANT_ACTIVITY_ITEMS_MAX,
  ASSISTANT_ACTIVITY_SUBSESSIONS_MAX,
  AssistantActivityDraft,
  AssistantActivityErrorReason,
  AssistantActivityItem,
  AssistantActivityItemDetail,
  AssistantActivitySubsessionState,
  ASSISTANT_DRAFT_DECISION_FEATURE,
  ASSISTANT_SUBSESSION_PANEL_FEATURE,
  ASSISTANT_TASK_HANDLE_FEATURE,
  AssistantDraftStatus,
  AssistantSubsessionCursor,
  AssistantActivityCheck,
  AssistantActivityFollowUp,
  AssistantActivityFollowUpStatus,
  AssistantActivityProposalFollowUp,
  AssistantActivityTaskKind,
  AgentPermissionOption,
  FOLLOW_UP_TASKS_V1_FEATURE,
  isSubsessionCoordinate,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult,
  type AssistantActivitySubsession,
  type AssistantActivityWriteReq,
  type AssistantActivityWriteResult
} from '@agentconnect.md/protocol'
import { canContinueSession, canEdit, canView, canViewSession } from '../../authorization/policy.js'
import { ProtocolError } from '../../domain/errors.js'
import { AgentId, SessionId, type DaemonId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import type { AgentRecord, SessionMetaRecord } from '../../persistence/ports.js'
import { ConnectionClosed } from '../../ws/registry.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { makeSessionAccessResolver } from '../session-access.js'

const IdParam = z.object({ id: z.string().uuid() })
const ItemParam = IdParam.extend({ itemId: z.string().min(1).max(512) })
const DraftParam = IdParam.extend({ draftId: z.string().min(1).max(512) })
const DraftDecisionBody = z.object({ decision: z.enum(['approve', 'discard']) })
/** The follow-up an approved follow-up form took, with its conversation where the caller may view it. */
const TakenFollowUpDto = z.object({
  id: z.string(),
  conversation: z
    .object({
      sessionId: z.string(),
      title: z.string().nullable(),
      platform: z.string().nullable(),
      channelName: z.string().nullable()
    })
    .nullable()
})
const DraftDecisionDto = z.object({
  /** `succeeded` posted, `denied` discarded, `failed` sent nothing, `outcome_unknown` may have posted and is never retried; an approved proposal answers `executing`, and an approved follow-up form `succeeded`. */
  status: AssistantDraftStatus,
  /** Why the post failed or is uncertain. */
  failure: z.string().nullable(),
  /** Present when an approved follow-up form took its follow-up. */
  followUp: TakenFollowUpDto.optional()
})

const ItemsPageDto = z.object({ items: z.array(AssistantActivityItem), truncated: z.boolean() })
/** A conversation an Activity row names, shown only to a caller who may view it. */
const ConversationDto = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  platform: z.string().nullable(),
  channelName: z.string().nullable()
})
const PermissionRequestDto = z.object({
  /** Decided like any approval request, through `decideAgentPermissionRequest`. */
  requestId: z.string(),
  /** What the background work asks to run. */
  tool: z.string(),
  createdAt: z.string(),
  /** When it is denied and the background work stops, unless someone answers first. */
  expiresAt: z.string(),
  /** The request's own options; absent when it takes a plain Allow or Deny. */
  options: z.array(AgentPermissionOption).optional(),
  /** The background work asking, when the caller may view it. */
  subsession: z.object({ sessionId: z.string(), title: z.string().nullable() }).nullable(),
  /** The conversation it belongs to, when the caller may view it. */
  parent: ConversationDto.nullable()
})
const DraftsPageDto = z.object({
  drafts: z.array(AssistantActivityDraft),
  truncated: z.boolean(),
  /** Background work's permission requests waiting on an answer, oldest first; empty from an agent version that does not list them. */
  permissionRequests: z.array(PermissionRequestDto)
})
/** A follow-up's own fields; `doneWhen` and `recentChecks` only where the row is `visible`. */
const FollowUpDto = z.object({
  /** Its own id where the row is visible, from an agent that ends a follow-up by it with `stopAssistantFollowUp`. */
  id: z.string().optional(),
  /** `paused` stopped after five failed checks in a row, until it is messaged. */
  status: AssistantActivityFollowUpStatus,
  /** The next scheduled check; null when it waits until it is messaged, or has ended. */
  nextCheck: z.string().nullable(),
  doneWhen: z.string().nullable(),
  /** Its newest finished checks, newest first: when, what it saw, whether its report reached the conversation, and what started it. */
  recentChecks: z.array(AssistantActivityCheck),
  /** A getting-to-know task of its conversation, which reads the place once and ends after one check. */
  gettingToKnow: z.boolean().optional(),
  /** The one pull request, merge request or issue whose events wake it, where the row is `visible`. */
  watch: AssistantActivityFollowUp.shape.watch
})
const SubsessionDto = z.object({
  /** The background work's session id, present only when the caller may open it. */
  sessionId: z.string().nullable(),
  /** Its title; a follow-up's label. */
  title: z.string().nullable(),
  /** `open` until it ends; a follow-up is `open` while waiting, checking or paused and `done` once done or stopped. */
  state: AssistantActivitySubsessionState,
  startedAt: z.string(),
  /** The caller may see this background work's conversation; otherwise only its state and start are shown. */
  visible: z.boolean(),
  /** The caller may stop its current turn, or end a follow-up: it is open and they may continue its session, or its conversation's while it has none. */
  canStop: z.boolean(),
  /** The conversation that opened it, when the caller may see it. */
  parent: ConversationDto.nullable(),
  /** Where it runs, from its own session, while its conversation has no session yet and the caller may view it (a getting-to-know task before it reports). */
  place: z.object({ platform: z.string().nullable(), channelName: z.string().nullable() }).optional(),
  /** Which kind of task it is; absent from an agent version that does not say. */
  kind: AssistantActivityTaskKind.optional(),
  /** Present on a follow-up (`kind: 'follow-up'`). */
  followUp: FollowUpDto.optional(),
  /** The task's own summary of its scope, status and next step, read from the agent's daemon and stored nowhere here; only where `visible`. */
  summary: z.string().optional(),
  /** When the task last wrote its summary. */
  summaryUpdatedAt: z.string().optional(),
  /** The start of the message the task was opened with, shown until it writes a summary; only where `visible`. */
  background: z.string().optional(),
  /** A platform thread is attached: people there talk to the task, and it reports nothing to the conversation that opened it. */
  threaded: z.boolean().optional()
})
const SubsessionsPageDto = z.object({
  subsessions: z.array(SubsessionDto),
  truncated: z.boolean(),
  /** Passed back as `cursor` for the next page of one conversation's background work; null on the last page and without `parentSessionId`. */
  nextCursor: z.string().nullable(),
  /** The agent keeps follow-ups, listed here, in place of items. */
  followUps: z.boolean().optional()
})
const SubsessionsQuery = z.object({
  /** Only the background work this conversation started, newest first. */
  parentSessionId: z.string().min(1).max(512).optional(),
  /** A previous page's `nextCursor`; only with `parentSessionId`. */
  cursor: AssistantSubsessionCursor.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ASSISTANT_ACTIVITY_SUBSESSIONS_MAX)
    .default(ASSISTANT_ACTIVITY_SUBSESSIONS_MAX)
})
const SubsessionParam = IdParam.extend({ sessionId: z.string().min(1).max(512) })
const FollowUpParam = IdParam.extend({ followUpId: z.string().min(1).max(512) })
const FollowUpStopBody = z.object({
  /** The conversation its row is listed under (`parent.sessionId`). */
  parentSessionId: z.string().min(1).max(512)
})
const SubsessionStopDto = z.object({
  /** `stopped` interrupted its current turn; `not_running` found none to interrupt. */
  result: z.enum(['stopped', 'not_running'])
})
const ACTIVITY = {
  feature: ASSISTANT_ACTIVITY_FEATURE,
  refusal: 'this agent version cannot show its activity; upgrade its daemon'
}
const SUBSESSION_PANEL = {
  feature: ASSISTANT_SUBSESSION_PANEL_FEATURE,
  refusal: 'this agent version cannot list or stop a conversation’s tasks; upgrade its daemon'
}
const TASK_HANDLE = {
  feature: ASSISTANT_TASK_HANDLE_FEATURE,
  refusal: 'this agent version cannot read one task or end a follow-up by its id; upgrade its daemon'
}
const ConversationParam = IdParam.extend({ sessionId: z.string().min(1).max(512) })
const ConversationProposalParam = ConversationParam.extend({ draftId: z.string().min(1).max(512) })
const ProposalDecisionBody = z.object({ decision: z.enum(['approve', 'deny']) })
const PROPOSAL_CHOICE = { approve: 'approve', deny: 'discard' } as const
/** A proposal waiting in one webchat conversation: the sentence its card would lead with, why, the work it asks to do and its follow-up. */
const ConversationProposalDto = z.object({
  /** Decided with `decideAssistantConversationProposal`. */
  id: z.string(),
  sentence: z.string(),
  why: z.string(),
  /** What the background session would carry out. */
  task: z.string(),
  itemId: z.string(),
  /** The follow-up's title as the agent last saw it; null once it is gone. */
  itemTitle: z.string().nullable(),
  /** The follow-up form: what approval takes in place of running `task`, which is then its title. */
  followUp: AssistantActivityProposalFollowUp.optional(),
  createdAt: z.string(),
  expiresAt: z.string()
})
const ConversationProposalsDto = z.object({ proposals: z.array(ConversationProposalDto), truncated: z.boolean() })
const ProposalDecisionDto = z.object({
  /** `executing` started its work, `succeeded` took a follow-up form's follow-up, `denied` dropped it, `failed` ran nothing. */
  status: AssistantDraftStatus,
  /** Why it could not run. */
  failure: z.string().nullable(),
  /** Present when an approved follow-up form took its follow-up. */
  followUp: TakenFollowUpDto.optional()
})
const CONVERSATION_PROPOSALS = {
  feature: ASSISTANT_CONVERSATION_PROPOSALS_FEATURE,
  refusal: 'this agent version cannot show a conversation’s proposals; upgrade its daemon'
}
const OkDto = z.object({ ok: z.literal(true) })

type Failure = { status: 400 | 404 | 409 | 503; error: string; message: string; code: string }

const send = (reply: FastifyReply, f: Failure) =>
  reply.code(f.status).send({ error: f.error, statusCode: f.status, message: f.message, code: f.code })
const notFound = (message: string): Failure => ({ status: 404, error: 'Not Found', message, code: 'NOT_FOUND' })
const MODE_OFF: Failure = {
  status: 409,
  error: 'Conflict',
  message: 'the agent is not in assistant mode',
  code: 'ASSISTANT_MODE_OFF'
}
/** A daemon with `follow-up-tasks-v1` keeps follow-ups, listed with its tasks, in place of items (assistant-mode.md §5.12). */
const ITEMS_REPLACED: Failure = {
  status: 409,
  error: 'Conflict',
  message: 'this agent keeps follow-ups in place of items; they are listed with its tasks',
  code: 'FOLLOW_UP_TASKS'
}

/** A daemon refusal or an unreachable daemon as a status the console can act on; null ⇒ rethrow. */
export function assistantActivityFailure(err: unknown): Failure | null {
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    const reason = AssistantActivityErrorReason.safeParse(err.details?.reason)
    if (reason.success && reason.data === 'assistant-mode-off') return MODE_OFF
    if (reason.success && reason.data === 'unknown-agent') return notFound('agent not found on its daemon')
    if (reason.success && reason.data === 'bad-cursor')
      return { status: 400, error: 'Bad Request', message: 'the page cursor is not valid', code: 'BAD_CURSOR' }
  }
  if (
    err instanceof NoConnection ||
    err instanceof ConnectionClosed ||
    (err instanceof Error && err.message === 'connection closed')
  )
    return { status: 503, error: 'Service Unavailable', message: 'owning daemon is offline', code: 'DAEMON_OFFLINE' }
  if (err instanceof ProtocolError)
    return {
      status: 503,
      error: 'Service Unavailable',
      message: `daemon rejected the request: ${err.message}`,
      code: 'DAEMON_REJECTED'
    }
  return null
}

/** A decision that reached the daemon but went unanswered may have posted; anything else maps as any Activity request. */
export function assistantDraftDecisionFailure(err: unknown): Failure | null {
  const lost =
    err instanceof ConnectionClosed ||
    (err instanceof Error && err.message === 'connection closed') ||
    (err instanceof ProtocolError && err.code === 'INTERNAL')
  if (lost)
    return {
      status: 503,
      error: 'Service Unavailable',
      message: 'the decision was sent but not confirmed; read the drafts again to see where it stands',
      code: 'DECISION_UNCONFIRMED'
    }
  return assistantActivityFailure(err)
}

const DRAFT_REFUSED: Record<'expired' | 'already-decided' | 'busy', Failure> = {
  expired: {
    status: 409,
    error: 'Conflict',
    message: 'the draft expired; nothing was posted',
    code: 'DRAFT_EXPIRED'
  },
  'already-decided': {
    status: 409,
    error: 'Conflict',
    message: 'the draft was already decided',
    code: 'DRAFT_ALREADY_DECIDED'
  },
  busy: {
    status: 409,
    error: 'Conflict',
    message: 'the agent already runs as many tasks as it may; the proposal is still waiting',
    code: 'SUBSESSION_LIMIT'
  }
}

/** The same refusals for a proposal, worded for work that never ran. */
const PROPOSAL_REFUSED: Record<'expired' | 'already-decided', Failure> = {
  expired: { ...DRAFT_REFUSED.expired, message: 'the proposal expired; nothing was run' },
  'already-decided': { ...DRAFT_REFUSED['already-decided'], message: 'the proposal was already decided' }
}

export function agentAssistantActivityRoutes(deps: HttpDeps) {
  return async function agentAssistantActivityRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const access = makeSessionAccessResolver(deps)

    // The agent's own session rows only, so a daemon can never name another agent's conversation, and which of them the caller may view.
    const sessionsOf = async (req: FastifyRequest, agentId: string, ids: string[]) => {
      const rows = (
        await Promise.all([...new Set(ids)].map((id) => deps.repos.session.get(orgOf(req), SessionId(id))))
      ).filter((row): row is SessionMetaRecord => row !== null && row.agentId === agentId)
      const audience = await access.forSessions(req, rows)
      const viewable = new Map(
        rows
          .filter((row) => canViewSession(row, ctxOf(req), audience.identitySet, audience.externalAccess))
          .map((row) => [String(row.id), row])
      )
      return { rows, audience, viewable }
    }
    const conversationOf = (row: SessionMetaRecord | undefined) =>
      row ? { sessionId: String(row.id), title: row.title, platform: row.platform, channelName: row.channelName } : null
    // The follow-up an approval took, naming its conversation only to a caller who may view it.
    const takenOf = async (req: FastifyRequest, agentId: string, taken: { id: string; parentSessionId: string }) => {
      const { viewable } = await sessionsOf(req, agentId, [taken.parentSessionId])
      return { id: taken.id, conversation: conversationOf(viewable.get(taken.parentSessionId)) }
    }
    // The console user acting, stamped here from the session, never taken from the request.
    const actorOf = async (req: FastifyRequest) => {
      const { userId } = ctxOf(req)
      const profile = await deps.repos.user.getProfile(userId).catch(() => null)
      const name = profile?.displayName ?? profile?.email ?? null
      return { userId, name: name === null ? null : [...name].slice(0, 256).join('') }
    }

    // A webchat conversation of this agent the caller may view, whose proposals whoever may continue it or edits the agent decides; the reply is sent on refusal.
    const admitConversation = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord
    ): Promise<SessionMetaRecord | null> => {
      const row = await deps.repos.session.get(orgOf(req), SessionId((req.params as { sessionId: string }).sessionId))
      // Background work's page is read-only and not a conversation of its own.
      if (!row || row.agentId !== agent.id || row.platform !== 'webchat' || isSubsessionCoordinate(row.thread)) {
        await send(reply, notFound('conversation not found'))
        return null
      }
      const ctx = ctxOf(req)
      const audience = await access.forSessions(req, [row])
      if (!canViewSession(row, ctx, audience.identitySet, audience.externalAccess)) {
        await send(reply, notFound('conversation not found'))
        return null
      }
      // The same authority the composer and stopping background work need, or the agent's editors'.
      if (!canEdit(agent, ctx) && !canContinueSession(row, ctx, audience.identitySet, audience.externalAccess)) {
        await reply.code(403).send({
          error: 'Forbidden',
          statusCode: 403,
          message: 'not authorized to decide this conversation’s proposals'
        })
        return null
      }
      return row
    }

    // Visible agent → editor (when asked) → assistant mode, or a section every agent has on a daemon serving it → serving daemon with the feature; the reply is sent on refusal.
    const admit = async (
      req: FastifyRequest,
      reply: FastifyReply,
      editorOnly: boolean,
      need: { feature: string; refusal: string } = ACTIVITY,
      everyAgent = false
    ): Promise<{
      agent: AgentRecord
      daemonId: DaemonId
      assistant: boolean
      followUps: boolean
      taskHandle: boolean
    } | null> => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId((req.params as { id: string }).id))
      if (!agent || !canView(agent, ctxOf(req))) {
        await send(reply, notFound('agent not found'))
        return null
      }
      if (editorOnly) {
        if (denyViewerWrite(req, reply)) return null
        if (!canEdit(agent, ctxOf(req))) {
          await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
          return null
        }
      }
      const assistant = agent.assistantMode?.enabled === true
      if (!assistant && !everyAgent) {
        await send(reply, MODE_OFF)
        return null
      }
      const daemonId = await deps.placementResolver.servingDaemon(agent)
      if (!daemonId) {
        await send(reply, {
          status: 503,
          error: 'Service Unavailable',
          message: 'agent has no live daemon',
          code: 'DAEMON_OFFLINE'
        })
        return null
      }
      const daemon = await deps.registry.getAvailable(orgOf(req), daemonId)
      // An older daemon serves Activity to assistant mode alone, so it is never asked for any other agent.
      if (!assistant && !daemon?.capabilities.features.includes(ACTIVITY_EVERY_AGENT_V1_FEATURE)) {
        await send(reply, MODE_OFF)
        return null
      }
      if (!daemon?.capabilities.features.includes(need.feature)) {
        await reply.code(409).send({
          error: 'Conflict',
          statusCode: 409,
          message: need.refusal,
          code: 'DAEMON_FEATURE_MISSING'
        })
        return null
      }
      return {
        agent,
        daemonId,
        assistant,
        followUps: daemon.capabilities.features.includes(FOLLOW_UP_TASKS_V1_FEATURE),
        taskHandle: daemon.capabilities.features.includes(ASSISTANT_TASK_HANDLE_FEATURE)
      }
    }

    // One task as the caller sees it: its session, label and details only where they may view it, and whether they may stop it.
    const taskDto = (
      req: FastifyRequest,
      s: AssistantActivitySubsession,
      { rows, audience, viewable }: Awaited<ReturnType<typeof sessionsOf>>,
      endsById: boolean
    ) => {
      const child = s.sessionId ? viewable.get(s.sessionId) : undefined
      const parent = viewable.get(s.parentSessionId)
      // Background work takes its owning session's audience; until its own row exists the owner decides.
      const ownRow = !!s.sessionId && rows.some((row) => String(row.id) === s.sessionId)
      const visible = ownRow ? !!child : !!parent
      const followUp = s.followUp
      // The same authority the console composer's own stop needs on that session.
      const mayContinue = (row: SessionMetaRecord) =>
        canContinueSession(row, ctxOf(req), audience.identitySet, audience.externalAccess)
      // A follow-up with no session yet is ended by its id, under its conversation's rule.
      const byId = endsById && !ownRow && !!followUp?.id && parent !== undefined
      return {
        sessionId: child ? String(child.id) : null,
        // A follow-up's label, like a session's title, only where its conversation may be seen; a task's own before its session exists.
        title: followUp ? (visible ? followUp.title : null) : (child?.title ?? (visible ? (s.title ?? null) : null)),
        state: s.state,
        startedAt: s.createdAt,
        visible,
        canStop: s.state === 'open' && (child ? mayContinue(child) : byId && mayContinue(parent)),
        parent: conversationOf(parent),
        // A getting-to-know task runs before its place's long session exists, so its own row names the place; never its title.
        ...(!parent && child ? { place: { platform: child.platform, channelName: child.channelName } } : {}),
        ...(s.kind ? { kind: s.kind } : {}),
        ...(s.threaded ? { threaded: true } : {}),
        // Conversation content, passed through from the daemon only to a caller who may view the task (auto-session-mode.md §6.7).
        ...(visible && s.summary ? { summary: s.summary } : {}),
        ...(visible && s.summary && s.summaryUpdatedAt ? { summaryUpdatedAt: s.summaryUpdatedAt } : {}),
        ...(visible && s.background ? { background: s.background } : {}),
        ...(followUp
          ? {
              followUp: {
                ...(visible && followUp.id ? { id: followUp.id } : {}),
                status: followUp.status,
                nextCheck: followUp.nextCheck,
                doneWhen: visible ? followUp.doneWhen : null,
                recentChecks: visible ? followUp.recentChecks : [],
                ...(followUp.gettingToKnow ? { gettingToKnow: true } : {}),
                // What it watches, like its title, only where its conversation may be seen.
                ...(visible && followUp.watch ? { watch: followUp.watch } : {})
              }
            }
          : {})
      }
    }

    // The item routes, for a daemon that still keeps items; one with follow-ups is refused before any daemon I/O.
    const admitItems = async (req: FastifyRequest, reply: FastifyReply, editorOnly: boolean) => {
      const admitted = await admit(req, reply, editorOnly)
      if (!admitted?.followUps) return admitted
      await send(reply, ITEMS_REPLACED)
      return null
    }

    const readSection = async <O extends AssistantActivityReadReq['operation']>(
      reply: FastifyReply,
      daemonId: string,
      req: Extract<AssistantActivityReadReq, { operation: O }>
    ): Promise<Extract<AssistantActivityReadResult, { operation: O }> | null> => {
      try {
        return (await deps.control.assistantActivityRead(daemonId, req)) as Extract<
          AssistantActivityReadResult,
          { operation: O }
        >
      } catch (err) {
        const failure = assistantActivityFailure(err)
        if (!failure) throw err
        await send(reply, failure)
        return null
      }
    }

    const writeEdit = async <O extends AssistantActivityWriteReq['operation']>(
      reply: FastifyReply,
      daemonId: string,
      req: Extract<AssistantActivityWriteReq, { operation: O }>,
      failureOf: (err: unknown) => Failure | null = assistantActivityFailure
    ): Promise<Extract<AssistantActivityWriteResult, { operation: O }> | null> => {
      try {
        return (await deps.control.assistantActivityWrite(daemonId, req)) as Extract<
          AssistantActivityWriteResult,
          { operation: O }
        >
      } catch (err) {
        const failure = failureOf(err)
        if (!failure) throw err
        await send(reply, failure)
        return null
      }
    }

    r.get(
      '/agents/:id/assistant/items',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an assistant-mode agent’s items',
          description: `Reads the items in the agent’s ledger from its daemon: \`section=open\` (the default) lists active and waiting items, \`closed\` lists done and dropped ones, most recently updated first, at most ${ASSISTANT_ACTIVITY_ITEMS_MAX}. Each item carries its title, status, what counts as done, when the agent noted it should check next, where it was asked and the places its followers follow it from — never who follows it or what was said. Anyone who can view the agent may read it; nothing is stored by this call. An agent whose daemon keeps follow-ups in place of items is refused with 409 \`FOLLOW_UP_TASKS\`; its follow-ups are listed with its tasks.`,
          operationId: 'listAssistantItems',
          params: IdParam,
          querystring: z.object({
            section: z.enum(['open', 'closed']).default('open'),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(ASSISTANT_ACTIVITY_ITEMS_MAX)
              .default(ASSISTANT_ACTIVITY_ITEMS_MAX)
          }),
          response: { 200: ItemsPageDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admitItems(req, reply, false)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'items',
          section: req.query.section,
          limit: req.query.limit
        })
        return page ? { items: page.items, truncated: page.truncated } : reply
      }
    )

    r.get(
      '/agents/:id/assistant/items/:itemId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get an assistant-mode agent’s item',
          description:
            'Reads one ledger item with its team-visible summary and its newest observations, newest first. Anyone who can view the agent may read it. An agent whose daemon keeps follow-ups in place of items is refused with 409 `FOLLOW_UP_TASKS`.',
          operationId: 'getAssistantItem',
          params: ItemParam,
          response: { 200: AssistantActivityItemDetail, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admitItems(req, reply, false)
        if (!admitted) return reply
        const answer = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'item',
          itemId: req.params.itemId
        })
        if (!answer) return reply
        return answer.item ?? send(reply, notFound('item not found'))
      }
    )

    r.delete(
      '/agents/:id/assistant/items/:itemId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Delete an assistant-mode agent’s item',
          description:
            'Removes one item from the agent’s ledger; the agent stops following it and its followers are no longer reported to. Only callers who can edit the agent may delete an item. An agent whose daemon keeps follow-ups in place of items is refused with 409 `FOLLOW_UP_TASKS`; a follow-up is ended with `stopAssistantSubsession` instead.',
          operationId: 'deleteAssistantItem',
          params: ItemParam,
          response: { 200: OkDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admitItems(req, reply, true)
        if (!admitted) return reply
        const answer = await writeEdit(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'delete-item',
          itemId: req.params.itemId
        })
        if (!answer) return reply
        return answer.found ? { ok: true as const } : send(reply, notFound('item not found'))
      }
    )

    r.get(
      '/agents/:id/assistant/subsessions',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s tasks',
          description: `Lists the tasks the agent started (its delegated tasks, follow-ups and approved proposals), running first and then the most recent, at most \`limit\` (${ASSISTANT_ACTIVITY_SUBSESSIONS_MAX} by default and at most). With \`parentSessionId\` it lists only what that conversation started, newest first, a page at a time: pass a page’s \`nextCursor\` back as \`cursor\` for the next one; the conversation must be one the caller may view, and the agent’s daemon must support it (409 \`DAEMON_FEATURE_MISSING\` otherwise). Anyone who can view the agent sees each one’s state and start; its title, its session and the conversation that started it are included only where the caller may view that conversation, and \`canStop\` says whether the caller may stop its current turn. An agent outside assistant mode is answered only when its daemon lists every agent’s tasks, and 409 \`ASSISTANT_MODE_OFF\` otherwise. From an agent whose daemon keeps follow-ups, each row names its \`kind\` and the page says \`followUps: true\`; a follow-up carries its status (waiting, checking, paused after five failed checks, done or stopped) and next check, and, where the caller may view its conversation, what counts as done, its newest checks with what started each (its time, a message, or events on what it watches), the pull request, merge request or issue it watches with that watch's state, and, from a daemon that ends one by it, its \`id\` for \`stopAssistantFollowUp\`: until its first check runs it has no session, and \`canStop\` follows its conversation. A follow-up is listed under its place’s current long session. A task carries \`threaded\` when a platform thread is attached and, where the caller may view it, its own \`summary\` with \`summaryUpdatedAt\` and the \`background\` it was opened with, from a daemon that keeps them; each call reads them from the daemon again. Nothing is stored by this call.`,
          operationId: 'listAssistantSubsessions',
          params: IdParam,
          querystring: SubsessionsQuery,
          response: { 200: SubsessionsPageDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const { parentSessionId, cursor, limit } = req.query
        if (cursor !== undefined && parentSessionId === undefined) {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'cursor pages a parentSessionId listing only' })
        }
        const admitted = await admit(
          req,
          reply,
          false,
          parentSessionId === undefined ? ACTIVITY : SUBSESSION_PANEL,
          true
        )
        if (!admitted) return reply
        let parentRow: SessionMetaRecord | null = null
        if (parentSessionId !== undefined) {
          // Only a conversation of this agent the caller may view, so a filter never confirms one they cannot see.
          parentRow = await deps.repos.session.get(orgOf(req), SessionId(parentSessionId))
          const audience = parentRow ? await access.forSessions(req, [parentRow]) : null
          if (
            !parentRow ||
            parentRow.agentId !== admitted.agent.id ||
            !audience ||
            !canViewSession(parentRow, ctxOf(req), audience.identitySet, audience.externalAccess)
          ) {
            return send(reply, notFound('conversation not found'))
          }
        }
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'subsessions',
          limit,
          ...(parentRow ? { parent: { sessionId: String(parentRow.id), ...(cursor ? { cursor } : {}) } } : {})
        })
        if (!page) return reply
        // A daemon answers for the conversation asked about only; anything else is dropped rather than shown.
        const listed = parentRow
          ? page.subsessions.filter((s) => s.parentSessionId === String(parentRow.id))
          : page.subsessions
        const seen = await sessionsOf(
          req,
          admitted.agent.id,
          listed.flatMap((s) => [s.parentSessionId, ...(s.sessionId ? [s.sessionId] : [])])
        )
        return {
          subsessions: listed.map((s) => taskDto(req, s, seen, admitted.taskHandle)),
          truncated: page.truncated,
          nextCursor: parentRow ? (page.nextCursor ?? null) : null,
          ...(admitted.followUps ? { followUps: true } : {})
        }
      }
    )

    r.post(
      '/agents/:id/assistant/subsessions/:sessionId/stop',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Stop an agent’s task',
          description:
            'Interrupts the current turn of one task the agent started (a delegated task or an approved proposal), exactly as a stop from the conversation composer would: nothing is muted, it reports back that it ended, and nothing it already did is undone; a process its runtime started in the background may keep running. The answer is `stopped`, or `not_running` when it had no turn to interrupt. Stopping a follow-up ends it, not just its check: no further checks run, and it answers `not_running` once it had already ended. Only callers who may continue that task’s session may stop it, and they are named in its transcript. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot stop tasks, and 409 `ASSISTANT_MODE_OFF` for an agent outside assistant mode whose daemon serves only assistant mode’s.',
          operationId: 'stopAssistantSubsession',
          params: SubsessionParam,
          response: { 200: SubsessionStopDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false, SUBSESSION_PANEL, true)
        if (!admitted) return reply
        const row = await deps.repos.session.get(orgOf(req), SessionId(req.params.sessionId))
        // Background work of this agent only: its coordinate is the one the daemon mints for it.
        if (!row || row.agentId !== admitted.agent.id || !isSubsessionCoordinate(row.thread)) {
          return send(reply, notFound('task not found'))
        }
        const ctx = ctxOf(req)
        const audience = await access.forSessions(req, [row])
        if (!canViewSession(row, ctx, audience.identitySet, audience.externalAccess)) {
          return send(reply, notFound('task not found'))
        }
        if (!canContinueSession(row, ctx, audience.identitySet, audience.externalAccess)) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'not authorized to stop this task' })
        }
        const answer = await writeEdit(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'stop-subsession',
          sessionId: String(row.id),
          actor: await actorOf(req)
        })
        if (!answer) return reply
        if (answer.result === 'not-found') return send(reply, notFound('task not found'))
        return { result: answer.result === 'stopped' ? ('stopped' as const) : ('not_running' as const) }
      }
    )

    r.get(
      '/agents/:id/assistant/subsessions/:sessionId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get one of an agent’s tasks',
          description:
            'Reads one task the agent started (a delegated task, a coordinator’s threaded task, a follow-up or an approved proposal) by its own session id, as `listAssistantSubsessions` lists it: its state, start, title, the conversation it belongs to where the caller may view it, and `canStop`; a follow-up also carries its status, next check, what counts as done and its newest checks. Only a session of this agent the caller may view is read, and one its daemon does not hold as a task answers 404. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot read one task, and 409 `ASSISTANT_MODE_OFF` for an agent outside assistant mode whose daemon serves only assistant mode’s. Nothing is stored by this call.',
          operationId: 'getAssistantSubsession',
          params: SubsessionParam,
          response: { 200: SubsessionDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false, TASK_HANDLE, true)
        if (!admitted) return reply
        const row = await deps.repos.session.get(orgOf(req), SessionId(req.params.sessionId))
        // A session of this agent the caller may view, as its own page needs; a threaded task lives on a platform thread (auto-session-mode.md §11).
        if (!row || row.agentId !== admitted.agent.id) {
          return send(reply, notFound('task not found'))
        }
        const audience = await access.forSessions(req, [row])
        if (!canViewSession(row, ctxOf(req), audience.identitySet, audience.externalAccess)) {
          return send(reply, notFound('task not found'))
        }
        const answer = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'task',
          sessionId: String(row.id)
        })
        if (!answer) return reply
        // A daemon answers for the task asked about only.
        const task = answer.task
        if (!task || task.sessionId !== String(row.id)) return send(reply, notFound('task not found'))
        const seen = await sessionsOf(req, admitted.agent.id, [task.parentSessionId, String(row.id)])
        return taskDto(req, task, seen, admitted.taskHandle)
      }
    )

    r.post(
      '/agents/:id/assistant/follow-ups/:followUpId/stop',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'End an agent’s follow-up',
          description:
            'Ends one follow-up by its id (`followUp.id` on a `listAssistantSubsessions` row), as `stopAssistantSubsession` does, including one whose first check has not run and so has no session yet: no further checks run, and a running check is stopped. `parentSessionId` is the conversation its row is listed under; only callers who may continue that conversation may end it. The answer is `stopped`, or `not_running` when it had already ended; a follow-up that conversation does not hold answers 404. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot end a follow-up by its id, and 409 `ASSISTANT_MODE_OFF` for an agent outside assistant mode whose daemon serves only assistant mode’s.',
          operationId: 'stopAssistantFollowUp',
          params: FollowUpParam,
          body: FollowUpStopBody,
          response: { 200: SubsessionStopDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false, TASK_HANDLE, true)
        if (!admitted) return reply
        const parent = await deps.repos.session.get(orgOf(req), SessionId(req.body.parentSessionId))
        // A conversation of this agent the caller may view; the daemon ends the follow-up only while its row names it.
        if (!parent || parent.agentId !== admitted.agent.id || isSubsessionCoordinate(parent.thread)) {
          return send(reply, notFound('follow-up not found'))
        }
        const ctx = ctxOf(req)
        const audience = await access.forSessions(req, [parent])
        if (!canViewSession(parent, ctx, audience.identitySet, audience.externalAccess)) {
          return send(reply, notFound('follow-up not found'))
        }
        if (!canContinueSession(parent, ctx, audience.identitySet, audience.externalAccess)) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'not authorized to end this follow-up' })
        }
        const answer = await writeEdit(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'stop-follow-up',
          followUpId: req.params.followUpId,
          parentSessionId: String(parent.id),
          actor: await actorOf(req)
        })
        if (!answer) return reply
        if (answer.result === 'not-found') return send(reply, notFound('follow-up not found'))
        return { result: answer.result === 'stopped' ? ('stopped' as const) : ('not_running' as const) }
      }
    )

    r.get(
      '/agents/:id/assistant/drafts',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s pending drafts',
          description: `Lists the posts and proposals waiting for an internal member’s approval, the soonest to lapse first, at most ${ASSISTANT_ACTIVITY_DRAFTS_MAX}: where each would post, its exact text, who is asked to approve it and when it expires. A proposal (\`kind: task\`) is what a check of an assistant-mode agent’s follow-up, or its conversation after getting to know a place, asks to do: its sentence, its reason and its follow-up (\`itemId\`, \`itemTitle\`), with the work it asks to do as its text; once approved it runs in the conversation its follow-up belongs to. A proposal with \`followUp\` runs nothing: approving it takes that follow-up of the conversation, with the approver as the one it follows up for. \`permissionRequests\` lists the runtime permission requests tasks are waiting on, oldest first: what each asks to run, when it is denied and its task stops unless someone answers, and its options; the task and its conversation are named only where the caller may view them. Decide one with \`decideAgentPermissionRequest\`. An agent outside assistant mode is answered, without proposals, only when its daemon serves every agent’s Activity, and 409 \`ASSISTANT_MODE_OFF\` otherwise. This read changes nothing. Only callers who can edit the agent may read it.`,
          operationId: 'listAssistantDrafts',
          params: IdParam,
          response: { 200: DraftsPageDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, true, ACTIVITY, true)
        if (!admitted) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'drafts',
          limit: ASSISTANT_ACTIVITY_DRAFTS_MAX,
          // Proposals are assistant mode's: one left from before it was switched off is not offered.
          proposals: admitted.assistant,
          permissions: true
        })
        if (!page) return reply
        // An older daemon answers without them: there is nothing to list.
        const waiting = page.permissions ?? []
        const { viewable } = await sessionsOf(
          req,
          admitted.agent.id,
          waiting.flatMap((p) => [p.sessionId, p.parentSessionId])
        )
        return {
          drafts: page.drafts,
          truncated: page.truncated,
          permissionRequests: waiting.map((p) => {
            const child = viewable.get(p.sessionId)
            return {
              requestId: p.requestId,
              tool: p.tool,
              createdAt: p.createdAt,
              expiresAt: p.expiresAt,
              ...(p.options ? { options: p.options } : {}),
              subsession: child ? { sessionId: String(child.id), title: child.title } : null,
              parent: conversationOf(viewable.get(p.parentSessionId))
            }
          })
        }
      }
    )

    r.post(
      '/agents/:id/assistant/drafts/:draftId/decision',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Decide an agent’s pending draft',
          description:
            'Approves or discards one post waiting for approval, exactly as its card would: `approve` posts the text unchanged, once; `discard` drops it. The answer is the outcome: `succeeded`, `denied`, `failed` (nothing was sent), or `outcome_unknown` (it may have posted and is never retried). A proposal is approved or denied the same way: approval starts it as a task and answers `executing`, and while the agent already runs as many tasks as it may, approval is refused with 409 `SUBSESSION_LIMIT` and the proposal keeps waiting. Approving a proposal with `followUp` takes that follow-up instead, with the caller as the one it follows up for, and answers `succeeded` with the follow-up taken and its conversation where the caller may view it; it counts against no limit. The card is rewritten to the decision. A draft that expired or was already decided is refused with 409 and posts nothing. An agent outside assistant mode is answered only when its daemon serves every agent’s Activity, and 409 `ASSISTANT_MODE_OFF` otherwise. Only callers who can edit the agent may decide, and they are recorded as the decider.',
          operationId: 'decideAssistantDraft',
          params: DraftParam,
          body: DraftDecisionBody,
          response: { 200: DraftDecisionDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(
          req,
          reply,
          true,
          {
            feature: ASSISTANT_DRAFT_DECISION_FEATURE,
            refusal: 'this agent version cannot decide drafts from the console; upgrade its daemon'
          },
          true
        )
        if (!admitted) return reply
        const answer = await writeEdit(
          reply,
          admitted.daemonId,
          {
            agentId: admitted.agent.id,
            operation: 'decide-draft',
            draftId: req.params.draftId,
            choice: req.body.decision,
            decider: await actorOf(req)
          },
          assistantDraftDecisionFailure
        )
        if (!answer) return reply
        if (answer.result === 'not-found') return send(reply, notFound('draft not found'))
        if (answer.result === 'busy')
          return send(reply, { ...DRAFT_REFUSED.busy, ...(answer.failure ? { message: answer.failure } : {}) })
        if (answer.result !== 'decided' || !answer.status) {
          return send(reply, DRAFT_REFUSED[answer.result === 'expired' ? 'expired' : 'already-decided'])
        }
        return {
          status: answer.status,
          failure: answer.failure,
          ...(answer.followUp ? { followUp: await takenOf(req, admitted.agent.id, answer.followUp) } : {})
        }
      }
    )

    r.get(
      '/agents/:id/assistant/conversations/:sessionId/proposals',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List a webchat conversation’s pending proposals',
          description: `Lists what the agent’s scheduled checks propose to do for follow-ups of one webchat conversation, still waiting for approval, the soonest to lapse first, at most ${ASSISTANT_ACTIVITY_DRAFTS_MAX}: each proposal’s sentence, its reason, the work a background session would carry out (or, with \`followUp\`, the follow-up approval takes), its follow-up and when it expires. Only callers who may continue that conversation, or who can edit the agent, may read it; the conversation must be one the caller may view. Answers 409 \`DAEMON_FEATURE_MISSING\` when the agent’s daemon cannot narrow its proposals to one conversation. Nothing is stored by this call.`,
          operationId: 'listAssistantConversationProposals',
          params: ConversationParam,
          response: { 200: ConversationProposalsDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false, CONVERSATION_PROPOSALS)
        if (!admitted) return reply
        const row = await admitConversation(req, reply, admitted.agent)
        if (!row) return reply
        const page = await readSection(reply, admitted.daemonId, {
          agentId: admitted.agent.id,
          operation: 'drafts',
          limit: ASSISTANT_ACTIVITY_DRAFTS_MAX,
          proposals: true,
          conversation: { sessionId: String(row.id) }
        })
        if (!page) return reply
        // A daemon answers for the conversation asked about only; anything else is dropped rather than shown.
        const proposals = page.drafts.flatMap((d) =>
          d.kind === 'task' && d.proposal && d.target.platform === 'webchat' && d.target.channel === row.channel
            ? [
                {
                  id: d.id,
                  sentence: d.proposal.sentence,
                  why: d.proposal.why,
                  task: d.text,
                  itemId: d.proposal.itemId,
                  itemTitle: d.proposal.itemTitle,
                  ...(d.proposal.followUp ? { followUp: d.proposal.followUp } : {}),
                  createdAt: d.createdAt,
                  expiresAt: d.expiresAt
                }
              ]
            : []
        )
        return { proposals, truncated: page.truncated }
      }
    )

    r.post(
      '/agents/:id/assistant/conversations/:sessionId/proposals/:draftId/decision',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Decide a webchat conversation’s pending proposal',
          description:
            'Approves or denies one proposal waiting in a webchat conversation, exactly as Activity would: `approve` starts it as a task of that conversation and answers `executing` (a proposal with `followUp` takes that follow-up, with the caller as the one it follows up for, and answers `succeeded` with it), `deny` drops it and runs nothing. While the agent already runs as many tasks as it may, approval is refused with 409 `SUBSESSION_LIMIT` and the proposal keeps waiting. Whichever surface answers first decides it: one that expired or was already decided is refused with 409 and runs nothing, and a proposal of another conversation answers 404. Only callers who may continue that conversation, or who can edit the agent, may decide, and they are recorded as the decider. Answers 409 `DAEMON_FEATURE_MISSING` when the agent’s daemon cannot bind a decision to one conversation.',
          operationId: 'decideAssistantConversationProposal',
          params: ConversationProposalParam,
          body: ProposalDecisionBody,
          response: { 200: ProposalDecisionDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, false, CONVERSATION_PROPOSALS)
        if (!admitted) return reply
        const row = await admitConversation(req, reply, admitted.agent)
        if (!row) return reply
        const answer = await writeEdit(
          reply,
          admitted.daemonId,
          {
            agentId: admitted.agent.id,
            operation: 'decide-draft',
            draftId: req.params.draftId,
            choice: PROPOSAL_CHOICE[req.body.decision],
            decider: await actorOf(req),
            conversation: { sessionId: String(row.id) }
          },
          assistantDraftDecisionFailure
        )
        if (!answer) return reply
        if (answer.result === 'not-found') return send(reply, notFound('proposal not found'))
        if (answer.result === 'busy')
          return send(reply, { ...DRAFT_REFUSED.busy, ...(answer.failure ? { message: answer.failure } : {}) })
        if (answer.result !== 'decided' || !answer.status) {
          return send(reply, PROPOSAL_REFUSED[answer.result === 'expired' ? 'expired' : 'already-decided'])
        }
        return {
          status: answer.status,
          failure: answer.failure,
          ...(answer.followUp ? { followUp: await takenOf(req, admitted.agent.id, answer.followUp) } : {})
        }
      }
    )
  }
}
