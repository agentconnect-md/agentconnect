// The runtime matrix's `sendMessage` probe: real descriptors and validation, no effects, shape-independent verdicts.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import type { McpServer } from '@agentclientprotocol/sdk'
import { IntegrationSchema } from '../../src/agents/agent-schema.js'
import type { AcpHost } from '../../src/acp/acp-host.js'
import { SUBSESSION_NOT_FOUND, SUBSESSION_NOT_FOUND_MESSAGE } from '../../src/collab/coordinator.js'
import { executeTool, type OpsDeps } from '../../src/mcp/ops.js'
import { ToolArgumentError } from '../../src/mcp/ops/args.js'
import { describeToolArgumentFailure } from '../../src/mcp/ops/argument-error.js'
import type { SessionContext } from '../../src/mcp/ops/context.js'
import { SUBSESSION_CONTINUED } from '../../src/mcp/ops/send-message-actions.js'
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
  channel: 'C0EXAMPLE1',
  thread: '1700000000.000100',
  session: '5f0c2a9e-0000-4000-8000-00000000a000',
  workChannel: 'C0EXAMPLE2',
  workChannelName: 'build-alerts',
  updateChannel: 'C0EXAMPLE3',
  updateThread: '1700000000.000200',
  origin: '5f0c2a9e-0000-4000-8000-00000000a001',
  child: '5f0c2a9e-0000-4000-8000-00000000a002'
} as const

const SLACK_INTEGRATION = 'int-slack-example'
const TELEGRAM_INTEGRATION = 'int-telegram-example'

/** The real tool list for an agent with Slack and Telegram integrations in a Slack session. */
export function probeTools(): ToolDescriptor[] {
  return toolsForIntegrations(
    [
      IntegrationSchema.parse({ id: SLACK_INTEGRATION, platform: 'slack' }),
      IntegrationSchema.parse({ id: TELEGRAM_INTEGRATION, platform: 'telegram' })
    ],
    { currentPlatform: 'slack' }
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
  | { kind: 'agent-call'; agent: string; needsReply: boolean; channel?: string; sessionId?: string }
  | { kind: 'subsession-create' }
  | { kind: 'subsession-continue'; sessionId: string }
  | { kind: 'origin-reply'; sessionId: string }
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
        return {
          kind: 'agent-call',
          agent,
          needsReply,
          ...(channel ? { channel } : {}),
          ...(sessionId ? { sessionId } : {})
        }
      }
      case 'messageSubsession':
        return sessionId ? { kind: 'subsession-continue', sessionId } : { kind: 'subsession-create' }
      case 'replyToSession':
        return sessionId ? { kind: 'origin-reply', sessionId } : { kind: 'unknown', reason: 'reply without sessionId' }
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
    if (agent === selfId && channel === undefined) return { kind: 'subsession-create' }
    return { kind: 'agent-call', agent, needsReply, ...(channel ? { channel } : {}) }
  }
  return postOp(args)
}

/** One-line rendering of an operation for tables and notes. */
export function describeOp(op: SemanticOp): string {
  switch (op.kind) {
    case 'agent-call':
      return `agent-call(${op.agent}${op.needsReply ? ',needsReply' : ''}${op.channel ? `,channel=${op.channel}` : ''}${op.sessionId ? `,session=${op.sessionId}` : ''})`
    case 'subsession-create':
      return 'subsession-create'
    case 'subsession-continue':
      return `subsession-continue(${op.sessionId})`
    case 'origin-reply':
      return `origin-reply(${op.sessionId})`
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

/** The sessions a scenario's caller may address by id: its origin, and the direct child it already started. */
export interface ProbeScope {
  origin?: string
  child?: string
}

/** Thrown by every fixture dependency: the call passed every check the daemon makes before an effect. */
class ReachedEffect extends Error {}

/** Deps whose first use ends the call; hooks that run before validation stay absent so they cannot pre-empt it. */
const EFFECT_BOUNDARY = new Proxy({} as OpsDeps, {
  get: (_target, key) =>
    key === 'canRun' || key === 'evaluationTool' || key === 'appTool' || key === 'log' || key === 'then'
      ? undefined
      : () => {
          throw new ReachedEffect(String(key))
        }
})

// A handler reached a dependency that `writeDeps`'s spread dropped from the proxy: also the effect boundary.
const reachedEffect = (error: unknown): boolean =>
  error instanceof ReachedEffect ||
  (error instanceof TypeError && /is not a function|Cannot read properties of undefined/.test(error.message)) ||
  (error instanceof Error && /^sendMessage: continuing a sub-session is not available/.test(error.message))

/** The real `executeTool` pipeline up to its first dependency: the rejection text a model reads, or none. */
async function daemonRejection(args: Record<string, unknown>, tools: ToolDescriptor[]): Promise<string | undefined> {
  try {
    await executeTool(probeContext(tools), 'sendMessage', args, EFFECT_BOUNDARY)
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

/** Peer-session authority (§9) the daemon would check against trusted state; it refuses the shape first today, so this never fires. */
export function sessionRejection(op: SemanticOp, _scope: ProbeScope): string | undefined {
  if (op.kind === 'agent-call' && op.sessionId !== undefined) {
    return `sendMessage: session "${op.sessionId}" is not an existing session of agent "${op.agent}". Nothing was sent.`
  }
  return undefined
}

/** A `sendMessage` call checked by the daemon's own pipeline plus the trusted checks it cannot make here: the error text the model would read, or none. */
export async function validateSendMessage(
  args: Record<string, unknown>,
  tools: ToolDescriptor[],
  scope: ProbeScope = {}
): Promise<string | undefined> {
  return (await daemonRejection(args, tools)) ?? sessionRejection(classifySendMessage(args, IDS.self), scope)
}

/** A plausible delivery receipt for a validated call; nothing is posted, woken, or injected. */
function receipt(op: SemanticOp, scope: ProbeScope): unknown {
  const ts = '1700000001.000300'
  const childSessionId = IDS.child
  switch (op.kind) {
    case 'origin-reply':
      // The real origin reply refuses an id that is not the caller's origin with a result, not an error.
      return op.sessionId === scope.origin
        ? { delivered: true, targetSession: op.sessionId }
        : { delivered: false, reason: 'not_authorized' }
    case 'subsession-create':
      return {
        ok: true,
        wake: { delivered: true, targetSession: childSessionId, subsession: true },
        childSessionId,
        reply: { requested: true, state: 'awaiting' },
        nextAction: 'finish-turn-and-wait',
        message:
          'Sub-session started in the background. Tell the people here it has started and end this turn; it reports back into this conversation when it finishes or fails. Do not do the work here as well.'
      }
    case 'subsession-continue':
      // The daemon's own continuation receipt, or its refusal of an id that is not this session's child.
      return op.sessionId === scope.child
        ? {
            ok: true,
            wake: { delivered: true, targetSession: op.sessionId, subsession: true },
            childSessionId: op.sessionId,
            reply: { requested: true, state: 'awaiting' },
            nextAction: 'finish-turn-and-wait',
            message: SUBSESSION_CONTINUED
          }
        : {
            ok: true,
            wake: {
              delivered: false,
              targetSession: op.sessionId,
              reason: SUBSESSION_NOT_FOUND,
              message: SUBSESSION_NOT_FOUND_MESSAGE
            }
          }
    case 'agent-call':
      return {
        ok: true,
        wake: { delivered: true, targetSession: childSessionId },
        ...(op.channel
          ? { post: { platform: 'slack', integrationId: SLACK_INTEGRATION, channel: op.channel, thread: null, ts } }
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

/** The trusted Slack session the fixture executes read-only guide calls as. */
function probeContext(tools: ToolDescriptor[]): SessionContext {
  return {
    agentId: IDS.self,
    platform: 'slack',
    integrationId: SLACK_INTEGRATION,
    isDm: false,
    channel: IDS.channel,
    thread: IDS.thread,
    deliveryThread: IDS.thread,
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
    if (op.kind === 'origin-reply' && op.sessionId !== scope.origin)
      return { result: text(result), error: 'origin reply not authorized' }
    if (op.kind === 'subsession-continue' && op.sessionId !== scope.child)
      return { result: text(result), error: 'sub-session not found' }
    return { result: text(result) }
  }
  if (name === 'getToolGuide') {
    try {
      return {
        result: text(
          await executeTool(probeContext(tools), name, args, { gatewayFor: () => undefined } as unknown as OpsDeps)
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
        reply({ tools })
      } else if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name ?? '')
        const raw = rpc.params?.arguments
        const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        void callTool(tools, name, args, scopes.get(key) ?? {}).then(({ result, error }) => {
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
  | 'continue-subsession'

export interface SendMessageScenario {
  id: ScenarioId
  prompt: string
  /** The expected operation; absent ⇒ no `sendMessage` call is correct. */
  expect?: (op: SemanticOp) => boolean
  expected: string
  /** Woken by a parent session that waits on the result. */
  origin?: boolean
  /** Already owns the background sub-session `IDS.child`. */
  child?: boolean
  /** Recorded only; never fails the cell. */
  informational?: boolean
  /** Only meaningful against the `action` tool shape; excluded from old/new comparisons. */
  newOnly?: boolean
}

const isChannel = (value: string | undefined, id: string, name?: string): boolean =>
  value === id || (name !== undefined && (value === name || value === `#${name}`))

const humanMessage = (body: string) =>
  `[Slack message from <@${IDS.sender}> in channel ${IDS.channel}, thread ${IDS.thread}]\n${body}`

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
    expect: (op) => op.kind === 'subsession-create',
    expected: 'subsession-create'
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
    prompt:
      `[Message from agent ${IDS.peer}, delivered from session ${IDS.origin}]\n` +
      'Please check whether the release checklist is complete and report the result back to me. ' +
      '(You already checked: all 12 checklist items are done, so the checklist is complete.)',
    expect: (op) => op.kind === 'origin-reply' && op.sessionId === IDS.origin,
    expected: `origin-reply(${IDS.origin})`
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
    id: 'continue-subsession',
    newOnly: true,
    child: true,
    prompt: humanMessage(
      `Your background sub-session ${IDS.child}, which you started earlier for the flaky-test investigation, should also cover the Windows failures. Send it that extra instruction.`
    ),
    expect: (op) => op.kind === 'subsession-continue' && op.sessionId === IDS.child,
    expected: `subsession-continue(${IDS.child})`
  }
]

/** The standing context the daemon would give this scenario's session, from its real builder. */
export function standingContext(scenario: SendMessageScenario, usesMeta: boolean): string {
  return buildStandingContext({
    agentName: IDS.self,
    agentId: IDS.self,
    platform: 'slack',
    channel: IDS.channel,
    slackSelfId: IDS.slackBot,
    thread: IDS.thread,
    sessionId: IDS.session,
    parentSessionId: scenario.origin ? IDS.origin : null,
    envSecretNames: [],
    fileSecrets: [],
    needsReplyToParent: scenario.origin === true,
    memoryIndex: '',
    usesMeta,
    platformStanding:
      `# Known identities\n- Peer agent: ${IDS.peer}\n- Human team member: <@${IDS.human}>\n` +
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
        ...(scenario.origin ? { origin: IDS.origin } : {}),
        ...(scenario.child ? { child: IDS.child } : {})
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
