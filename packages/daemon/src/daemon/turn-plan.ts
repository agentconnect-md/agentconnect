/**
 * The pure decision layer of one dispatched turn (design §6.9): every choice
 * `dispatchOne` makes from the agent snapshot, the inbound message and the
 * registries, before it touches a host, a store row or a connection.
 *
 * Purity is the point. Anything that reads live daemon state (the sticky output
 * mode, whether the host is already running, the compound mention addresses)
 * enters as a pre-awaited input field rather than a call from inside the planner,
 * so the whole plan is a total function of its input and can be unit-tested
 * without booting a daemon.
 */
import { hasReachedAgentCallHopLimit, originKindOf } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { slackStatusOptions } from '../platforms/slack/turn-output.js'
import { turnChromeFor } from '../platforms/turn-chrome.js'
import { TurnOutputRegistry, type TurnOutputContext, type TurnOutputSurface } from '../platforms/turn-output.js'
import { batchPublishesItems } from '../codehost/hook-admission.js'
import { transcriptChannelKey } from '../store/local-store.js'
import { AGENT_CALL_HOP_LIMIT_NOTICE } from './constants.js'
import { loopGuardScope } from './loop-guard-scope.js'
import { noneSuppressedApprovalSurface } from './tool-classification.js'
import type { DaemonConverger, DaemonRenderAction, Pending, QueueEntry, SessionDeliveryBinding } from './turn-types.js'

export type OutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

type DaemonTurnOutputRegistry = TurnOutputRegistry<Pending, DaemonRenderAction, DaemonConverger, NormalizedMessage>
type DaemonTurnOutputSurface = TurnOutputSurface<Pending, DaemonRenderAction, DaemonConverger, NormalizedMessage>

export interface TurnPlanInput {
  entry: QueueEntry
  agent: Pick<Agent, 'name' | 'displayName' | 'iconUrl' | 'output'>
  /** Logical session key for this turn. */
  sessionKey: string
  /** Stable evaluation turn id, minted before the plan so the harness closures can use it. */
  evaluationTurnId: string
  /** Pre-awaited `store.getOutputModeOverride(sessionKey)`; undefined ⇒ agent default. */
  stickyOutputMode: OutputMode | undefined
  /** `hostStarts.has(agentId) || modelSessions.hasStartedHost(key)`, read cold. */
  hostAlreadyRunning: boolean
  /** `!k8sPlane.runsInSandbox(agentId)` on a cluster daemon: this turn must first bring a
   *  Sandbox pod up and bind its shim, which is up to a minute and a half of silence. */
  clusterPodBootstrap: boolean
  /** `daemon.compoundMentionAddresses(agentId, msg)`. */
  protectedAddresses: readonly string[]
  /** Pre-computed `isCodexRuntime(agentId)` — it reads the runtime command config, not just the name. */
  codexUsageIsPerPrompt: boolean
  features: { turnFinalContextRefresh: boolean }
  turnSurfaces: DaemonTurnOutputRegistry
}

export interface TurnPlan {
  readonly sessionKey: string
  readonly agentId: string
  readonly agentName: string
  readonly iconUrl?: string
  readonly platform: string
  readonly isDm: boolean
  readonly channel: string
  readonly thread?: string
  readonly statusThread: string
  readonly transcriptChannel: string
  readonly integrationId?: string
  readonly requesterId: string

  readonly initializeOnly: boolean
  readonly evaluationTurnId: string

  readonly mode: OutputMode
  readonly showFooter: boolean
  readonly showStatusBar: boolean
  readonly attributionFooterEnabled: boolean
  readonly approvalSurfaceSuppressed: boolean

  /** True when this turn takes the null-connection seam: headless, non-continuation webchat, or `none`. */
  readonly suppressReplyConn: boolean
  readonly startupActivityLabel: 'is thinking…' | 'is starting up…' | 'is allocating a sandbox pod…'
  readonly hostAlreadyRunning: boolean
  /** This turn waits on a cluster sandbox pod — see {@link TurnPlanInput.clusterPodBootstrap}. */
  readonly clusterPodBootstrap: boolean

  readonly turnSurface: DaemonTurnOutputSurface
  readonly turnCtx: TurnOutputContext<NormalizedMessage>
  readonly statusOptions: ReturnType<typeof slackStatusOptions>
  readonly protectedAddresses: readonly string[]

  readonly stageAnswer: boolean
  readonly webchatRefresh: boolean
  readonly loopGuardScope: string
  readonly sourceHopCount: number
  readonly hopLimitNotice?: string
  readonly directAgentCall: boolean
  readonly codexUsageIsPerPrompt: boolean

  readonly githubTurnEligible: boolean
  readonly githubReplyBatchActive: boolean
  readonly deliveryBinding: SessionDeliveryBinding
}

/** Decide everything this turn can decide before it runs. Total over its input. */
export function buildTurnPlan(input: TurnPlanInput): TurnPlan {
  const { entry, agent, turnSurfaces } = input
  const { agentId, msg, integrationId, webchat, callMeta, githubReply, hookContext } = entry
  const agentName = agent.displayName?.trim() || agent.name
  const iconUrl = agent.iconUrl
  // Output verbosity for THIS turn: the sticky per-session override (status-bar picker)
  // wins over the agent default. Resolved BEFORE the reply connection because `none` is a
  // session-only mode — the converger records the reply into the transcript (via `recordOnly`
  // posts) but delivers nothing to the IM, so it takes the same null-connection seam.
  const mode: OutputMode = input.stickyOutputMode ?? agent.output.mode
  // Footer visibility is an agent-level delivery choice, snapshotted for this turn alongside
  // output mode. Turning it off removes attribution and session-link chrome on every platform.
  const showFooter = agent.output.showFooter
  // A headless cron fire has no platform target, and webchat streams through the relay reply
  // sink instead — both leave the connection unset so every apply/status action no-ops.
  // `none` joins them: only the converger's `recordOnly` bodies land in the transcript.
  // A continuation turn keeps its platform connection: webchat is an additional sink (§5.2).
  const suppressReplyConn = msg.headless || (webchat !== undefined && !webchat.continuation) || mode === 'none'
  // §7.3: the platform's own production rules and its opaque per-turn state both come
  // from its output surface. The converger itself is built per turn at the call site.
  const turnSurface = turnSurfaces.for(msg.platform)
  const turnCtx: TurnOutputContext<NormalizedMessage> = {
    mode,
    isDm: msg.isDm,
    showFooter,
    message: msg,
    // send-message-routing-rework.md §5.3: compound shared-bot addresses this conversation
    // can contain, so the splitter never cuts `<@U_SHARED> reviewer` in half.
    protectedAddresses: input.protectedAddresses
  }
  const sourceHopCount = callMeta?.hopCount ?? 0
  const githubReplyBatch = hookContext?.githubReviewBatch
  return {
    sessionKey: input.sessionKey,
    agentId,
    agentName,
    ...(iconUrl ? { iconUrl } : {}),
    platform: msg.platform,
    isDm: msg.isDm,
    channel: msg.channel,
    ...(msg.thread !== undefined ? { thread: msg.thread } : {}),
    statusThread: msg.thread ?? msg.msgId,
    transcriptChannel: transcriptChannelKey(msg.channel, msg.transportScope),
    ...(integrationId !== undefined ? { integrationId } : {}),
    requesterId: msg.sender.id,
    initializeOnly: callMeta?.initializeOnly === true,
    evaluationTurnId: input.evaluationTurnId,
    mode,
    showFooter,
    showStatusBar: agent.output.showStatusBar,
    attributionFooterEnabled: showFooter && turnChromeFor(msg.platform).attributionFooter === true,
    // True only when `none` removed THIS turn's chat-input permission card surface. Frozen for
    // the turn so a mid-turn mode flip cannot desync policy from the cleared connection.
    approvalSurfaceSuppressed: noneSuppressedApprovalSurface(mode, {
      platform: msg.platform,
      webchat,
      headless: msg.headless
    }),
    suppressReplyConn,
    // Cold/warm is captured BEFORE sessions.handle(), which boots the host via hostFor().
    // A pod that is not up yet outranks both: it is the wait the user is actually about to sit through.
    startupActivityLabel: input.clusterPodBootstrap
      ? 'is allocating a sandbox pod…'
      : input.hostAlreadyRunning
        ? 'is thinking…'
        : 'is starting up…',
    hostAlreadyRunning: input.hostAlreadyRunning,
    clusterPodBootstrap: input.clusterPodBootstrap,
    turnSurface,
    turnCtx,
    statusOptions: slackStatusOptions(msg.platform, agentName, iconUrl),
    protectedAddresses: input.protectedAddresses,
    stageAnswer:
      input.features.turnFinalContextRefresh && !webchat && !githubReply && originKindOf(msg.platform) === 'chat',
    webchatRefresh: input.features.turnFinalContextRefresh && !!webchat && msg.platform === 'webchat',
    loopGuardScope: loopGuardScope(msg),
    sourceHopCount,
    ...(callMeta && hasReachedAgentCallHopLimit(sourceHopCount + 1)
      ? { hopLimitNotice: AGENT_CALL_HOP_LIMIT_NOTICE }
      : {}),
    // CallMeta is the trusted distinction between a real A2A delivery and a synthetic
    // `source: agent` wake; a webchat roster continuation is a post, not an address.
    directAgentCall: callMeta !== undefined && callMeta.conversationContinuation !== true,
    codexUsageIsPerPrompt: input.codexUsageIsPerPrompt,
    githubTurnEligible:
      githubReply !== undefined && entry.posterPublishState !== 'in_flight' && entry.posterPublishState !== 'settled',
    // Only a provider whose sealed batch publishes each item itself opens the batched-reply tool.
    githubReplyBatchActive:
      !!(githubReplyBatch?.sealed && githubReplyBatch.items.length > 1) && batchPublishesItems(hookContext),
    deliveryBinding: {
      agentId,
      platform: msg.platform,
      ...(integrationId !== undefined ? { integrationId } : {}),
      isDm: msg.isDm
    }
  }
}
