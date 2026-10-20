// The runtime matrix's `sendMessage` probe: real descriptors and validation, no effects, shape-independent verdicts.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import type { McpServer } from '@agentclientprotocol/sdk'
import { IntegrationSchema } from '../../src/agents/agent-schema.js'
import type { AcpHost } from '../../src/acp/acp-host.js'
import {
  MESSAGE_NOT_FOUND,
  PEER_SESSION_NOT_FOUND,
  PEER_SESSION_NOT_FOUND_MESSAGE,
  TASK_NOT_FOUND,
  TASK_NOT_FOUND_MESSAGE
} from '../../src/collab/coordinator.js'
import { renderSessionMessage } from '../../src/collab/session-message.js'
import { executeTool, type OpsDeps } from '../../src/mcp/ops.js'
import { ToolArgumentError } from '../../src/mcp/ops/args.js'
import { describeToolArgumentFailure } from '../../src/mcp/ops/argument-error.js'
import type { SessionContext } from '../../src/mcp/ops/context.js'
import { TASK_STARTED } from '../../src/mcp/ops/messaging.js'
import { PEER_SESSION_CALLED, TASK_MESSAGED } from '../../src/mcp/ops/send-message-actions.js'
import { toolsForIntegrations } from '../../src/mcp/tools.js'
import { buildStandingContext } from '../../src/session/turn/standing-context.js'
import type { ToolDescriptor } from '../../src/tool-schema/descriptor.js'

/** Synthetic identities every scenario's standing context and expectations share. */
export const IDS = {
  self: 'matrix-agent',
  peer: 'peer-agent',
  human: 'U0EXAMPLE1',
  sender: 'U0EXAMPLE2',
  slackBot: 'U0EXAMPLEBOT',
  /** The peer agent's own Slack bot user, which a person may @-mention to mean that agent. */
  peerBot: 'U0EXAMPLEPEER',
  /** The console conversation a webchat scenario runs in. */
  webchat: '5f0c2a9e-0000-4000-8000-00000000a005',
  channel: 'C0EXAMPLE1',
  thread: '1700000000.000100',
  session: '5f0c2a9e-0000-4000-8000-00000000a000',
  workChannel: 'C0EXAMPLE2',
  workChannelName: 'build-alerts',
  updateChannel: 'C0EXAMPLE3',
  updateThread: '1700000000.000200',
  origin: '5f0c2a9e-0000-4000-8000-00000000a001',
  /** The peer session that sent it, by its key, as the daemon's reply receipt names it. */
  peerSessionKey: 'slack:C0EXAMPLE4:1700000000.000400:peer-agent',
  /** The id of the peer's message the origin-reply scenario answers. */
  message: 'msg-5f0c2a9e00004000800000000000a004',
  child: '5f0c2a9e-0000-4000-8000-00000000a002',
  task: 'slack:C0EXAMPLE1:subsession:5f0c2a9e-0000-4000-8000-00000000a003:matrix-agent'
} as const

const SLACK_INTEGRATION = 'int-slack-example'
const TELEGRAM_INTEGRATION = 'int-telegram-example'

/** The session platform a scenario runs on: a Slack thread, or a console webchat with no bot of its own. */
export type ProbePlatform = 'slack' | 'webchat'

/** The real tool list for an agent with Slack and Telegram integrations, in a session on `platform`. */
export function probeTools(platform: ProbePlatform = 'slack'): ToolDescriptor[] {
  return toolsForIntegrations(
    [
      IntegrationSchema.parse({ id: SLACK_INTEGRATION, platform: 'slack' }),
      IntegrationSchema.parse({ id: TELEGRAM_INTEGRATION, platform: 'telegram' })
    ],
    { currentPlatform: platform }
  )
}

/** Whether the served `sendMessage` takes the post-refactor `action` discriminator. */
export function toolShape(tools: ToolDescriptor[]): 'action' | 'legacy' {
  const send = tools.find((tool) => tool.name === 'sendMessage')
  const properties = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties && 'action' in properties ? 'action' : 'legacy'
}

/** What a `sendMessage` call means, whichever argument shape spelled it. */
export type SemanticOp =
  | { kind: 'agent-call'; agent: string; needsReply: boolean; channel?: string; platform?: string; sessionId?: string }
  | { kind: 'task-start' }
  | { kind: 'task-message'; taskId: string }
  | { kind: 'origin-reply'; messageId?: string; sessionId?: string }
  | { kind: 'post-dm'; user: string }
  | { kind: 'post-channel'; channel: string; users?: string[] }
  | { kind: 'post-thread'; channel: string; thread: string }
  | { kind: 'unknown'; reason: string }

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const userId = (value: string): string => /^<@([^>]+)>$/.exec(value)?.[1] ?? value

function agentTarget(value: unknown): { agent?: string; needsReply: boolean } {
  let target = value
  if (typeof target === 'string' && target.trim().startsWith('{')) {
    try {
      target = JSON.parse(target) as unknown
    } catch {
      return { needsReply: false }
    }
  }
  if (typeof target === 'string') return { agent: str(target), needsReply: false }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const { agentId, needsReply } = target as { agentId?: unknown; needsReply?: unknown }
    return { agent: str(agentId), needsReply: needsReply === true || String(needsReply).toLowerCase() === 'true' }
  }
  return { needsReply: false }
}

function postOp(args: Record<string, unknown>): SemanticOp {
  const channel = str(args.channel)
  const users = (Array.isArray(args.toUser) ? args.toUser : [args.toUser]).map(str).filter((u) => u !== undefined)
  if (users.length > 0 && channel === undefined) return { kind: 'post-dm', user: userId(users[0]!) }
  if (channel === undefined) return { kind: 'unknown', reason: 'post without toUser or channel' }
  const thread = str(args.thread)
  if (thread !== undefined && users.length === 0) return { kind: 'post-thread', channel, thread }
  return { kind: 'post-channel', channel, ...(users.length > 0 ? { users: users.map(userId) } : {}) }
}

/** Map one recorded call, legacy target-inferred or `action`-tagged, to its semantic operation. */
export function classifySendMessage(args: Record<string, unknown>, selfId: string): SemanticOp {
  const action = args.action
  const sessionId = str(args.sessionId)
  if (action !== undefined) {
    switch (action) {
      case 'callAgent': {
        const { agent, needsReply } = agentTarget(args.toAgent)
        if (agent === undefined) return { kind: 'unknown', reason: 'callAgent without toAgent' }
        const channel = str(args.channel)
        const platform = str(args.platform)
        return {
          kind: 'agent-call',
          agent,
          needsReply,
          ...(channel ? { channel } : {}),
          ...(platform ? { platform } : {}),
          ...(sessionId ? { sessionId } : {})
        }
      }
      case 'delegateTask':
        return { kind: 'task-start' }
      case 'messageTask': {
        const taskId = str(args.taskId)
        return taskId ? { kind: 'task-message', taskId } : { kind: 'unknown', reason: 'messageTask without taskId' }
      }
      case 'replyToSession': {
        // A reply names the message it answers; a session-addressed one is the baseline's spelling.
        const messageId = str(args.messageId)
        if (messageId) return { kind: 'origin-reply', messageId }
        return sessionId ? { kind: 'origin-reply', sessionId } : { kind: 'unknown', reason: 'reply without messageId' }
      }
      case 'postMessage':
        return postOp(args)
      default:
        return { kind: 'unknown', reason: `action ${JSON.stringify(action)}` }
    }
  }
  if (sessionId !== undefined) return { kind: 'origin-reply', sessionId }
  if (args.toAgent !== undefined && args.toAgent !== null) {
    const { agent, needsReply } = agentTarget(args.toAgent)
    if (agent === undefined) return { kind: 'unknown', reason: 'malformed toAgent' }
    const channel = str(args.channel)
    if (agent === selfId && channel === undefined) return { kind: 'task-start' }
    return { kind: 'agent-call', agent, needsReply, ...(channel ? { channel } : {}) }
  }
  return postOp(args)
}

/** One-line rendering of an operation for tables and notes. */
export function describeOp(op: SemanticOp): string {
  switch (op.kind) {
    case 'agent-call':
      return `agent-call(${op.agent}${op.needsReply ? ',needsReply' : ''}${op.channel ? `,channel=${op.channel}` : ''}${op.platform ? `,platform=${op.platform}` : ''}${op.sessionId ? `,session=${op.sessionId}` : ''})`
    case 'task-start':
      return 'task-start'
    case 'task-message':
      return `task-message(${op.taskId})`
    case 'origin-reply':
      return `origin-reply(${op.messageId ?? op.sessionId})`
    case 'post-dm':
      return `post-dm(${op.user})`
    case 'post-channel':
      return `post-channel(${op.channel}${op.users ? `,users=${op.users.join('+')}` : ''})`
    case 'post-thread':
      return `post-thread(${op.channel},${op.thread})`
    case 'unknown':
      return `unknown(${op.reason})`
  }
}

/** What a scenario's caller may address by id: the message it may answer, the task it already started, and a peer's session it may join. */
export interface ProbeScope {
  /** The session's platform; absent ⇒ Slack. */
  platform?: ProbePlatform
  message?: string
  task?: string
  peerSession?: string
}

/** Thrown by every fixture dependency: the call passed every check the daemon makes before an effect. */
class ReachedEffect extends Error {}

/** The daemon's side-effect-free pre-checks, answered as an org whose peer is reachable and whose peer bot is `IDS.peerBot`. */
const PRE_CHECKS: Partial<OpsDeps> = {
  preflightWake: () => null,
  agentsForPlatformUser: ({ platform, userId }) => (platform === 'slack' && userId === IDS.peerBot ? [IDS.peer] : [])
}

/** Deps whose first use ends the call, except the pre-checks, which are own keys so `writeDeps`'s spread keeps them. */
const EFFECT_BOUNDARY = new Proxy({ ...PRE_CHECKS } as OpsDeps, {
  get: (target, key) =>
    key in target
      ? target[key as keyof OpsDeps]
      : key === 'canRun' ||
          key === 'evaluationTool' ||
          key === 'appTool' ||
          key === 'computerTool' ||
          key === 'log' ||
          key === 'then'
        ? undefined
        : () => {
            throw new ReachedEffect(String(key))
          }
})

// A handler reached a dependency that `writeDeps`'s spread dropped from the proxy: also the effect boundary.
const reachedEffect = (error: unknown): boolean =>
  error instanceof ReachedEffect ||
  (error instanceof TypeError && /is not a function|Cannot read properties of undefined/.test(error.message)) ||
  (error instanceof Error && /^sendMessage: messaging a task is not available/.test(error.message))

/** The real `executeTool` pipeline up to its first dependency: the rejection text a model reads, or none. */
async function daemonRejection(
  args: Record<string, unknown>,
  tools: ToolDescriptor[],
  platform: ProbePlatform
): Promise<string | undefined> {
  try {
    await executeTool(probeContext(tools, platform), 'sendMessage', args, EFFECT_BOUNDARY)
    return undefined
  } catch (error) {
    if (reachedEffect(error)) return undefined
    if (!(error instanceof ToolArgumentError)) return (error as Error).message
    const advertised = tools.find((tool) => tool.name === 'sendMessage')
    return describeToolArgumentFailure({
      tool: 'sendMessage',
      issues: error.issues,
      receivedKeys: Object.keys(args),
      ...(advertised ? { advertised } : {}),
      tools
    })
  }
}

/** A `sendMessage` call checked by the daemon's own pipeline: the error text the model would read, or none. */
export async function validateSendMessage(
  args: Record<string, unknown>,
  tools: ToolDescriptor[],
  scope: ProbeScope = {}
): Promise<string | undefined> {
  return await daemonRejection(args, tools, scope.platform ?? 'slack')
}

/** A plausible delivery receipt for a validated call; nothing is posted, woken, or injected. */
function receipt(op: SemanticOp, scope: ProbeScope): unknown {
  const ts = '1700000001.000300'
  const childSessionId = IDS.child
  const taskId = IDS.task
  switch (op.kind) {
    case 'origin-reply':
      // The daemon's reply receipt, or its refusal of an id that names no message this session received.
      return op.messageId !== undefined && op.messageId === scope.message
        ? { delivered: true, targetSession: IDS.peerSessionKey, inReplyTo: op.messageId }
        : { delivered: false, inReplyTo: op.messageId ?? '', reason: MESSAGE_NOT_FOUND }
    case 'task-start':
      return {
        ok: true,
        wake: { delivered: true, targetSession: taskId, subsession: true },
        taskId,
        reply: { requested: true, state: 'awaiting' },
        nextAction: 'finish-turn-and-wait',
        message: TASK_STARTED
      }
    case 'task-message':
      // The daemon's own `messageTask` receipt, or its refusal of an id that is not a task of this session.
      return op.taskId === scope.task
        ? {
            ok: true,
            wake: { delivered: true, targetSession: op.taskId, subsession: true },
            taskId: op.taskId,
            reply: { requested: true, state: 'awaiting' },
            nextAction: 'finish-turn-and-wait',
            message: TASK_MESSAGED
          }
        : {
            ok: true,
            wake: {
              delivered: false,
              targetSession: op.taskId,
              reason: TASK_NOT_FOUND,
              message: TASK_NOT_FOUND_MESSAGE
            }
          }
    case 'agent-call':
      // The daemon's own answer to an existing-session call: its receipt in scope, else its refusal.
      if (op.sessionId !== undefined) {
        return op.sessionId === scope.peerSession
          ? {
              ok: true,
              wake: { delivered: true, targetSession: op.sessionId },
              childSessionId: op.sessionId,
              ...(op.needsReply
                ? {
                    reply: { requested: true, state: 'awaiting' },
                    nextAction: 'finish-turn-and-wait',
                    message: PEER_SESSION_CALLED
                  }
                : {})
            }
          : {
              ok: true,
              wake: {
                delivered: false,
                targetSession: op.sessionId,
                reason: PEER_SESSION_NOT_FOUND,
                message: PEER_SESSION_NOT_FOUND_MESSAGE
              }
            }
      }
      return {
        ok: true,
        wake: { delivered: true, targetSession: childSessionId },
        ...(op.channel
          ? {
              post: {
                platform: op.platform ?? 'slack',
                integrationId: op.platform === 'telegram' ? TELEGRAM_INTEGRATION : SLACK_INTEGRATION,
                channel: op.channel,
                thread: null,
                ts
              }
            }
          : {}),
        childSessionId,
        ...(op.needsReply
          ? {
              reply: { requested: true, state: 'awaiting' },
              nextAction: 'finish-turn-and-wait',
              message:
                'Message delivered. The agent will reply by waking this session in a later turn. End this turn and wait; do not retry or ask it to repeat the work.'
            }
          : {})
      }
    case 'post-dm':
      return {
        ok: true,
        post: { platform: 'slack', integrationId: SLACK_INTEGRATION, channel: 'D0EXAMPLE1', thread: null, ts }
      }
    case 'post-channel':
      return {
        ok: true,
        post: { platform: 'slack', integrationId: SLACK_INTEGRATION, channel: op.channel, thread: null, ts }
      }
    case 'post-thread':
      return {
        ok: true,
        post: { platform: 'slack', integrationId: SLACK_INTEGRATION, channel: op.channel, thread: op.thread, ts }
      }
    case 'unknown':
      return { ok: true }
  }
}

/** The trusted session the fixture validates calls and serves guides as: a Slack thread, or a console webchat. */
function probeContext(tools: ToolDescriptor[], platform: ProbePlatform = 'slack'): SessionContext {
  const where =
    platform === 'webchat'
      ? { channel: IDS.webchat, thread: `webchat:${IDS.webchat}` }
      : { integrationId: SLACK_INTEGRATION, channel: IDS.channel, thread: IDS.thread }
  return {
    agentId: IDS.self,
    platform,
    isDm: false,
    ...where,
    deliveryThread: where.thread,
    tools,
    integrations: [
      { id: SLACK_INTEGRATION, platform: 'slack' },
      { id: TELEGRAM_INTEGRATION, platform: 'telegram' }
    ],
    agentName: IDS.self
  }
}

export interface RecordedCall {
  tool: string
  args: Record<string, unknown>
  /** The argument error, or a delivery refusal, the model read for this call. */
  error?: string
}

export interface SendMessageFixture {
  server: Server
  /** The MCP server descriptor for one scenario run; its calls are recorded under `key` and judged against `scope`. */
  descriptor: (key: string, scope?: ProbeScope) => McpServer
  calls: (key: string) => RecordedCall[]
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }
const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true as const } : {})
})

async function callTool(
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown>,
  scope: ProbeScope
): Promise<{ result: ToolResult; error?: string }> {
  if (name === 'sendMessage') {
    const error = await validateSendMessage(args, tools, scope)
    if (error !== undefined) return { result: text(error, true), error }
    const op = classifySendMessage(args, IDS.self)
    const result = receipt(op, scope)
    if (op.kind === 'origin-reply' && (op.messageId === undefined || op.messageId !== scope.message))
      return { result: text(result), error: 'message not found' }
    if (op.kind === 'task-message' && op.taskId !== scope.task) return { result: text(result), error: 'task not found' }
    if (op.kind === 'agent-call' && op.sessionId !== undefined && op.sessionId !== scope.peerSession)
      return { result: text(result), error: 'peer session not found' }
    return { result: text(result) }
  }
  if (name === 'getToolGuide') {
    try {
      return {
        result: text(
          await executeTool(probeContext(tools, scope.platform), name, args, {
            gatewayFor: () => undefined
          } as unknown as OpsDeps)
        )
      }
    } catch (error) {
      return { result: text((error as Error).message, true), error: (error as Error).message }
    }
  }
  return { result: text('Nothing to report in this environment.') }
}

/** The matrix's HTTP MCP fixture serving the real AgentConnect tools, one recorded call log per path. */
export function sendMessageFixture(tools: ToolDescriptor[]): Promise<SendMessageFixture> {
  // A webchat session is served the tools the daemon gives one; every other scenario gets `tools`.
  const webchatTools = probeTools('webchat')
  const toolsFor = (scope: ProbeScope) => (scope.platform === 'webchat' ? webchatTools : tools)
  const log = new Map<string, RecordedCall[]>()
  const scopes = new Map<string, ProbeScope>()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let rpc: { id?: string | number; method?: string; params?: { name?: string; arguments?: unknown } }
      try {
        rpc = JSON.parse(body) as typeof rpc
      } catch {
        res.writeHead(400).end()
        return
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const key = decodeURIComponent((req.url ?? '').replace(/^\/mcp\/?/, ''))
      const reply = (result: unknown) =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      if (rpc.method === 'initialize') {
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentconnect', version: '1' }
        })
      } else if (rpc.method === 'tools/list') {
        reply({ tools: toolsFor(scopes.get(key) ?? {}) })
      } else if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name ?? '')
        const raw = rpc.params?.arguments
        const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        const scope = scopes.get(key) ?? {}
        void callTool(toolsFor(scope), name, args, scope).then(({ result, error }) => {
          const calls = log.get(key) ?? []
          calls.push({ tool: name, args, ...(error !== undefined ? { error } : {}) })
          log.set(key, calls)
          reply(result)
        })
      } else {
        reply({})
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        descriptor: (key, scope = {}) => {
          scopes.set(key, scope)
          return {
            type: 'http',
            name: 'agentconnect',
            url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(key)}`,
            headers: []
          }
        },
        calls: (key) => log.get(key) ?? []
      })
    })
  })
}

export type ScenarioId =
  | 'ask-peer-for-result'
  | 'background-self-work'
  | 'visible-work-in-channel'
  | 'dm-person'
  | 'thread-update'
  | 'origin-reply'
  | 'negative-current-thread'
  | 'tool-visibility'
  | 'message-task'
  | 'peer-by-bot-mention'
  | 'peer-in-slack-from-webchat'

export interface SendMessageScenario {
  id: ScenarioId
  prompt: string
  /** The expected operation; absent ⇒ no `sendMessage` call is correct. */
  expect?: (op: SemanticOp) => boolean
  expected: string
  /** Woken by a peer's message, `IDS.message`, that waits on the result. */
  origin?: boolean
  /** Already owns the background task `IDS.task`. */
  task?: boolean
  /** The session's platform; absent ⇒ a Slack thread. */
  platform?: ProbePlatform
  /** Recorded only; never fails the cell. */
  informational?: boolean
  /** Only meaningful against the `action` tool shape; excluded from old/new comparisons. */
  newOnly?: boolean
}

const isChannel = (value: string | undefined, id: string, name?: string): boolean =>
  value === id || (name !== undefined && (value === name || value === `#${name}`))

const humanMessage = (body: string) =>
  `[Slack message from <@${IDS.sender}> in channel ${IDS.channel}, thread ${IDS.thread}]\n${body}`
const webchatMessage = (body: string) => `[Webchat message from a console user in conversation ${IDS.webchat}]\n${body}`

export const SCENARIOS: SendMessageScenario[] = [
  {
    id: 'ask-peer-for-result',
    prompt: humanMessage(
      `Can you ask the ${IDS.peer} agent what the current error budget for the payments service is? Tell me its answer once you have it.`
    ),
    expect: (op) => op.kind === 'agent-call' && op.agent === IDS.peer && op.needsReply,
    expected: `agent-call(${IDS.peer},needsReply)`
  },
  {
    id: 'background-self-work',
    prompt: humanMessage(
      'Please migrate every integration test in this repository to the new fixtures and open a PR. It will take a while, so run it in the background and let me know here when it is done.'
    ),
    // The action shape spells it `delegateTask`; the legacy shape's postless self-call maps to the same operation.
    expect: (op) => op.kind === 'task-start',
    expected: 'task-start (delegateTask)'
  },
  {
    id: 'visible-work-in-channel',
    prompt: humanMessage(
      `Start investigating the failing nightly build yourself in channel ${IDS.workChannel} (#${IDS.workChannelName}): open a new visible conversation there and work on it in that conversation so the build team can follow along and chime in.`
    ),
    expect: (op) =>
      op.kind === 'agent-call' &&
      op.agent === IDS.self &&
      op.sessionId === undefined &&
      isChannel(op.channel, IDS.workChannel, IDS.workChannelName),
    expected: `agent-call(${IDS.self},channel=${IDS.workChannel})`
  },
  {
    id: 'dm-person',
    prompt: humanMessage(`Send a direct message to <@${IDS.human}> telling them the deploy window moved to 3pm today.`),
    expect: (op) => op.kind === 'post-dm' && op.user === IDS.human,
    expected: `post-dm(${IDS.human})`
  },
  {
    id: 'thread-update',
    prompt: humanMessage(
      `Post a status update in the existing thread ${IDS.updateThread} in channel ${IDS.updateChannel} saying the hotfix is deployed to production.`
    ),
    expect: (op) =>
      op.kind === 'post-thread' && isChannel(op.channel, IDS.updateChannel) && op.thread === IDS.updateThread,
    expected: `post-thread(${IDS.updateChannel},${IDS.updateThread})`
  },
  {
    id: 'origin-reply',
    origin: true,
    // The daemon's own rendering of a peer's message that waits on a reply; the request text is the baseline's.
    prompt: renderSessionMessage(
      {
        messageId: IDS.message,
        kind: 'call',
        sourceAgentId: IDS.peer,
        // What the daemon's agentDisplayLabel gives a peer without a display name.
        sourceLabel: IDS.peer,
        sourceSessionId: IDS.origin,
        replyRequested: true
      },
      'Please check whether the release checklist is complete and report the result back to me. ' +
        '(You already checked: all 12 checklist items are done, so the checklist is complete.)'
    ),
    // Answering that message by id; the baseline's session-addressed reply to the same sender still counts.
    expect: (op) =>
      op.kind === 'origin-reply' &&
      (op.messageId === IDS.message || (op.messageId === undefined && op.sessionId === IDS.origin)),
    expected: `origin-reply(${IDS.message})`
  },
  {
    id: 'negative-current-thread',
    prompt: humanMessage('Please confirm right here in this thread that you received this message, in one short line.'),
    expected: 'no sendMessage call'
  },
  {
    id: 'tool-visibility',
    informational: true,
    prompt: humanMessage(
      'Do you have a tool named sendMessage (from the agentconnect MCP server)? Do not invoke it; if only its name is loaded, ' +
        'you may load its definition first (for example with a tool search). Answer YES or NO on the first line. If YES, quote its description verbatim: the first 40 characters on a line starting FIRST: and the last 40 characters on a line starting LAST:.'
    ),
    expected: 'sendMessage visible with an untruncated description'
  },
  {
    id: 'message-task',
    newOnly: true,
    task: true,
    prompt: humanMessage(
      `Your background task ${IDS.task}, which you started earlier for the flaky-test investigation, should also cover the Windows failures. Send it that extra instruction.`
    ),
    expect: (op) => op.kind === 'task-message' && op.taskId === IDS.task,
    expected: `task-message(${IDS.task})`
  },
  {
    // A person names the peer by its Slack bot; posting that mention starts nothing, so only a call gets the answer.
    id: 'peer-by-bot-mention',
    prompt: humanMessage(
      `Post a message in channel ${IDS.workChannel} that @-mentions <@${IDS.peerBot}>, says hello, and asks it to ` +
        'compute 5 * 6. Wait for its result and tell me here.'
    ),
    expect: (op) =>
      op.kind === 'agent-call' &&
      op.agent === IDS.peer &&
      op.needsReply &&
      isChannel(op.channel, IDS.workChannel, IDS.workChannelName),
    expected: `agent-call(${IDS.peer},needsReply,channel=${IDS.workChannel})`
  },
  {
    // A webchat session has no bot of its own, so a Slack channel call must name its platform.
    id: 'peer-in-slack-from-webchat',
    newOnly: true,
    platform: 'webchat',
    prompt: webchatMessage(
      `In the Slack channel ${IDS.workChannel} (#${IDS.workChannelName}), ask the ${IDS.peer} agent to compute ` +
        '5 * 6 where the team can see it, and tell me its answer once it replies.'
    ),
    expect: (op) =>
      op.kind === 'agent-call' &&
      op.agent === IDS.peer &&
      op.needsReply &&
      op.platform === 'slack' &&
      isChannel(op.channel, IDS.workChannel, IDS.workChannelName),
    expected: `agent-call(${IDS.peer},needsReply,channel=${IDS.workChannel},platform=slack)`
  }
]

/** The standing context the daemon would give this scenario's session, from its real builder. */
export function standingContext(scenario: SendMessageScenario, usesMeta: boolean): string {
  const webchat = scenario.platform === 'webchat'
  return buildStandingContext({
    agentName: IDS.self,
    agentId: IDS.self,
    platform: webchat ? 'webchat' : 'slack',
    channel: webchat ? IDS.webchat : IDS.channel,
    ...(webchat ? {} : { slackSelfId: IDS.slackBot }),
    thread: webchat ? `webchat:${IDS.webchat}` : IDS.thread,
    sessionId: IDS.session,
    originSessionId: scenario.origin ? IDS.origin : null,
    envSecretNames: [],
    fileSecrets: [],
    memoryIndex: '',
    usesMeta,
    platformStanding:
      `# Known identities\n- Peer agent: ${IDS.peer} (its Slack bot is <@${IDS.peerBot}>)\n- Human team member: <@${IDS.human}>\n` +
      `- Channel #${IDS.workChannelName}: ${IDS.workChannel}\n- Channel ${IDS.updateChannel} has an existing thread rooted at ${IDS.updateThread}`
  }).sessionContext
}

export type SendMessageVerdict = 'PASS' | 'DEGRADED' | 'FAIL' | 'UNAVAILABLE' | 'INFO' | 'SKIPPED'

export interface SendMessageRun {
  runtime: string
  scenario: ScenarioId
  rep: number
  verdict: SendMessageVerdict
  /** False for a new-only scenario, which old/new comparisons and the matrix cell leave out. */
  comparable: boolean
  ops: Array<{ op: string; valid: boolean; error?: string }>
  counts: { sendMessage: number; getToolGuide: number; otherMcp: number; acpToolCalls: number }
  ms: number
  tokens?: unknown
  notes: string[]
}

/** PASS on a valid, correct first call; DEGRADED when only the last call is; FAIL otherwise. */
export function judge(
  scenario: SendMessageScenario,
  calls: RecordedCall[]
): { verdict: SendMessageVerdict; notes: string[] } {
  const sends = calls.filter((call) => call.tool === 'sendMessage')
  if (!scenario.expect) {
    return sends.length === 0
      ? { verdict: 'PASS', notes: [] }
      : { verdict: 'FAIL', notes: [`${sends.length} sendMessage call(s) where none was expected`] }
  }
  if (sends.length === 0) return { verdict: 'FAIL', notes: ['no sendMessage call'] }
  const correct = (call: RecordedCall) =>
    call.error === undefined && scenario.expect!(classifySendMessage(call.args, IDS.self))
  if (correct(sends[0]!)) {
    const extra = sends.slice(1).filter((call) => call.error === undefined)
    return { verdict: 'PASS', notes: extra.length > 0 ? [`${extra.length} further valid sendMessage call(s)`] : [] }
  }
  if (correct(sends.at(-1)!)) return { verdict: 'DEGRADED', notes: [`corrected after ${sends.length - 1} call(s)`] }
  return { verdict: 'FAIL', notes: [`expected ${scenario.expected}`] }
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Compare the model's quoted description edges with the served description. */
export function judgeVisibility(reply: string, description: string | undefined): string[] {
  // A runtime may narrate before answering, so YES counts at a line or sentence start.
  const hasTool = /(?:^|[.!?:]\s*)\W*yes\b/im.test(reply.trim())
  if (!description) return [`hasTool=${hasTool}`, 'sendMessage not served']
  const quoted = (label: string) => collapse(new RegExp(`^\\W*${label}:\\s*(.*)$`, 'im').exec(reply)?.[1] ?? '')
  const edge = (quote: string, expected: string) => {
    const probe = collapse(expected).slice(5, 30)
    return quote !== '' && collapse(quote.replace(/^["'`]|["'`]$/g, '')).includes(probe)
  }
  const first = edge(quoted('FIRST'), description.slice(0, 40))
  const last = edge(quoted('LAST'), description.slice(-40))
  return [
    `hasTool=${hasTool}`,
    `firstMatch=${first}`,
    `lastMatch=${last}`,
    `reply=${JSON.stringify(reply.slice(0, 300))}`
  ]
}

export interface ProbeSupport {
  withTimeout: <T>(promise: Promise<T>, label: string) => Promise<T>
  providerUnavailable: (error: unknown) => boolean
  errorReason: (error: unknown) => string
}

/** Run every selected scenario `reps` times, each in a fresh session on an already-started host. */
export async function runSendMessageScenarios(input: {
  runtime: string
  host: AcpHost
  cwd: string
  fixture: SendMessageFixture
  tools: ToolDescriptor[]
  scenarios: SendMessageScenario[]
  reps: number
  updates: Array<{ sessionId: string; update: any }>
  support: ProbeSupport
  /** Called after every run so a report survives a later timeout. */
  onRun?: (run: SendMessageRun) => void
}): Promise<SendMessageRun[]> {
  const { runtime, host, cwd, fixture, tools, support } = input
  const shape = toolShape(tools)
  const description = tools.find((tool) => tool.name === 'sendMessage')?.description
  const usesMeta = host.usesMetaSystemPrompt()
  const runs: SendMessageRun[] = []
  for (let rep = 1; rep <= input.reps; rep++) {
    for (const scenario of input.scenarios) {
      const base = { runtime, scenario: scenario.id, rep, comparable: scenario.newOnly !== true }
      if (scenario.newOnly && shape !== 'action') {
        runs.push({ ...base, verdict: 'SKIPPED', ops: [], counts: zeroCounts(), ms: 0, notes: ['new-only scenario'] })
        continue
      }
      const key = `${runtime}/${scenario.id}/${rep}`
      const scope: ProbeScope = {
        ...(scenario.platform ? { platform: scenario.platform } : {}),
        ...(scenario.origin ? { message: IDS.message } : {}),
        ...(scenario.task ? { task: IDS.task } : {})
      }
      const standing = standingContext(scenario, usesMeta)
      const started = Date.now()
      let sessionId: string | undefined
      let tokens: unknown
      const notes: string[] = []
      let failure: unknown
      try {
        sessionId = await support.withTimeout(
          host.newSession(cwd, [fixture.descriptor(key, scope)], undefined, usesMeta ? standing : undefined),
          `${runtime}/sendMessage ${scenario.id} session`
        )
        const blocks = [
          ...(usesMeta ? [] : [{ type: 'text' as const, text: standing }]),
          { type: 'text' as const, text: scenario.prompt }
        ]
        const result = await support.withTimeout(
          host.prompt(sessionId, blocks),
          `${runtime}/sendMessage ${scenario.id}`
        )
        tokens = result.usage
      } catch (error) {
        failure = error
      }
      const ms = Date.now() - started
      const calls = fixture.calls(key)
      const sessionUpdates = input.updates.filter((entry) => entry.sessionId === sessionId)
      const acpToolCalls = sessionUpdates.filter((entry) => entry.update?.sessionUpdate === 'tool_call').length
      const counts = {
        sendMessage: calls.filter((call) => call.tool === 'sendMessage').length,
        getToolGuide: calls.filter((call) => call.tool === 'getToolGuide').length,
        otherMcp: calls.filter((call) => call.tool !== 'sendMessage' && call.tool !== 'getToolGuide').length,
        acpToolCalls
      }
      const ops = calls
        .filter((call) => call.tool === 'sendMessage')
        .map((call) => ({
          op: describeOp(classifySendMessage(call.args, IDS.self)),
          valid: call.error === undefined,
          ...(call.error !== undefined ? { error: call.error.slice(0, 300) } : {})
        }))
      let verdict: SendMessageVerdict
      if (failure !== undefined && support.providerUnavailable(failure)) {
        verdict = 'UNAVAILABLE'
        notes.push(support.errorReason(failure))
      } else if (scenario.informational) {
        verdict = 'INFO'
        const reply = sessionUpdates
          .filter(
            (entry) => entry.update?.sessionUpdate === 'agent_message_chunk' && entry.update?.content?.type === 'text'
          )
          .map((entry) => String(entry.update.content.text))
          .join('')
        notes.push(...judgeVisibility(reply, description))
        if (failure !== undefined) notes.push(`turn error: ${support.errorReason(failure)}`)
      } else {
        const judged = judge(scenario, calls)
        verdict = failure !== undefined ? 'FAIL' : judged.verdict
        notes.push(...judged.notes)
        if (failure !== undefined) notes.push(`turn error: ${support.errorReason(failure)}`)
      }
      const run: SendMessageRun = {
        ...base,
        verdict,
        ops,
        counts,
        ms,
        ...(tokens !== undefined ? { tokens } : {}),
        notes
      }
      runs.push(run)
      input.onRun?.(run)
      if (sessionId && host.deleteSupported()) {
        await support
          .withTimeout(host.deleteSession(sessionId), `${runtime}/sendMessage ${scenario.id} delete`)
          .catch(() => {})
      }
    }
  }
  return runs
}

function zeroCounts(): SendMessageRun['counts'] {
  return { sendMessage: 0, getToolGuide: 0, otherMcp: 0, acpToolCalls: 0 }
}

/** Every run of a runtime that never got a session: provider unavailable or a hard failure. */
export function unreachableRuns(
  runtime: string,
  scenarios: SendMessageScenario[],
  reps: number,
  verdict: 'UNAVAILABLE' | 'FAIL',
  note: string
): SendMessageRun[] {
  return Array.from({ length: reps }, (_, index) =>
    scenarios.map((scenario) => ({
      runtime,
      scenario: scenario.id,
      rep: index + 1,
      comparable: scenario.newOnly !== true,
      verdict: scenario.informational && verdict === 'FAIL' ? ('INFO' as const) : verdict,
      ops: [],
      counts: zeroCounts(),
      ms: 0,
      notes: [note]
    }))
  ).flat()
}

/** The runtime-level matrix cell over comparable scored runs: ✗ on any FAIL, · on any DEGRADED, U when nothing ran. */
export function aggregate(runs: SendMessageRun[]): {
  status: 'ok' | 'degrade' | 'unavailable' | 'fail'
  detail: string
} {
  const scored = runs.filter((run) => run.comparable && run.verdict !== 'INFO' && run.verdict !== 'SKIPPED')
  const newOnly = runs.filter((run) => !run.comparable && run.verdict !== 'SKIPPED')
  const count = (verdict: SendMessageVerdict) => scored.filter((run) => run.verdict === verdict).length
  const extra =
    newOnly.length > 0
      ? ` new-only: ${newOnly.map((run) => `${run.scenario}#${run.rep}=${run.verdict}`).join(' ')}`
      : ''
  const detail = `pass=${count('PASS')} degraded=${count('DEGRADED')} fail=${count('FAIL')} unavailable=${count('UNAVAILABLE')}${extra}`
  if (count('FAIL') > 0) return { status: 'fail', detail }
  if (count('DEGRADED') > 0) return { status: 'degrade', detail }
  if (scored.length > 0 && count('UNAVAILABLE') === scored.length) return { status: 'unavailable', detail }
  return { status: 'ok', detail }
}

const VERDICT_CELL: Record<SendMessageVerdict, string> = {
  PASS: '✓',
  DEGRADED: '·',
  FAIL: '✗',
  UNAVAILABLE: 'U',
  INFO: 'i',
  SKIPPED: '-'
}

/** Per-scenario grid: one row per runtime and repetition. */
export function scenarioGrid(runs: SendMessageRun[], scenarios: SendMessageScenario[]): string {
  const rows = [...new Set(runs.map((run) => `${run.runtime}#${run.rep}`))]
  const idWidth = Math.max(9, ...rows.map((row) => row.length))
  const head = 'runtime#r'.padEnd(idWidth) + ' | ' + scenarios.map((scenario) => scenario.id).join(' ')
  const lines = rows.map((row) => {
    const cells = scenarios.map((scenario) => {
      const run = runs.find((entry) => `${entry.runtime}#${entry.rep}` === row && entry.scenario === scenario.id)
      return (run ? VERDICT_CELL[run.verdict] : ' ')
        .padStart(Math.ceil(scenario.id.length / 2))
        .padEnd(scenario.id.length)
    })
    return row.padEnd(idWidth) + ' | ' + cells.join(' ')
  })
  return [
    head,
    '-'.repeat(head.length),
    ...lines,
    '',
    'legend: ✓ pass · degraded ✗ fail U unavailable i informational - skipped'
  ].join('\n')
}

/** The machine-readable report a baseline or comparison is captured from. */
export function sendMessageReport(tools: ToolDescriptor[], runs: SendMessageRun[]): Record<string, unknown> {
  const send = tools.find((tool) => tool.name === 'sendMessage')
  let gitHead = 'unknown'
  let gitDirty: boolean | undefined
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    gitDirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== ''
  } catch {
    // Not a checkout: the report still records the runs.
  }
  return {
    gitHead,
    ...(gitDirty !== undefined ? { gitDirty } : {}),
    descriptor: {
      shape: toolShape(tools),
      sendMessageDescriptionChars: send?.description.length ?? 0,
      sendMessageSchemaChars: send ? JSON.stringify(send.inputSchema).length : 0,
      toolNames: tools.map((tool) => tool.name)
    },
    runs
  }
}

/** Scenarios selected by `AC_RUNTIME_MATRIX_SENDMESSAGE_SCENARIOS` (comma list), else all. */
export function selectedScenarios(filter: string | undefined): SendMessageScenario[] {
  const wanted = new Set(
    (filter ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  )
  const unknown = [...wanted].filter((id) => !SCENARIOS.some((scenario) => scenario.id === id))
  if (unknown.length > 0) throw new Error(`unknown sendMessage scenario(s): ${unknown.join(', ')}`)
  return wanted.size === 0 ? SCENARIOS : SCENARIOS.filter((scenario) => wanted.has(scenario.id))
}
