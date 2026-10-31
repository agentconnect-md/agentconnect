// The runtime matrix's coordinator probe: an injected coordinator prompt and tool surface, judged per channel message.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import { z } from 'zod'
import type { AcpHost } from '../../src/acp/acp-host.js'
import {
  coordinatorPrompt as shippedCoordinatorPrompt,
  coordinatorTools as shippedCoordinatorTools,
  renderCoordinatorBatch
} from '../../src/auto-session/coordinator-prompt.js'
import { NO_RESPONSE_SENTINEL } from '../../src/session/no-response.js'
import type { ToolDescriptor } from '../../src/tool-schema/descriptor.js'
import type { ProbeSupport, SendMessageVerdict } from './send-message-probe.js'

/** Synthetic identities every coordinator scenario shares. */
export const CO_IDS = {
  self: 'matrix-agent',
  selfBot: 'U0EXAMPLEBOT',
  peer: 'peer-agent',
  peerBot: 'U0EXAMPLEPEER',
  alice: 'U0EXAMPLE1',
  bob: 'U0EXAMPLE2',
  channel: 'C0EXAMPLE1',
  channelName: 'eng-platform',
  /** A member's private webchat conversation with the agent (auto-session-mode.md §10). */
  conversation: '0e7a1c52-5b2d-5d7e-9f3a-2c1b0d4e6f70',
  checkoutTask: 'task-checkout-flake'
} as const

/** One channel-root message a coordinator turn decides on; `id` is the platform message id it names in its calls. */
export interface ChannelMessage {
  id: string
  from: string
  mentionsYou: boolean
  text: string
  /** A report delivered to the coordinator rather than a channel message (auto-session-mode.md §3.4). */
  report?: boolean
}

/** An open task as `listTasks` reports it. */
export interface ProbeTask {
  taskId: string
  title: string
  threaded: boolean
  owner: string
  lastActive: string
  running: boolean
  summary: { scope: string; status: string; next: string }
  summaryUpdatedAt: string
}

const CHECKOUT_TASK: ProbeTask = {
  taskId: CO_IDS.checkoutTask,
  title: 'Flaky checkout e2e test',
  threaded: true,
  owner: `<@${CO_IDS.alice}>`,
  lastActive: '2026-10-29T09:40:00Z',
  running: false,
  summary: {
    scope: 'Investigating why the checkout.spec.ts end-to-end test times out intermittently on CI, and fixing it.',
    status: 'Fix is up as PR #4821 (raises the payment-iframe wait and stubs the slow tax call); waiting for review.',
    next: 'Merge after review, then watch main CI for a day.'
  },
  summaryUpdatedAt: '2026-10-29T09:40:00Z'
}

/** The coordinator's tool surface, as the daemon ships it. */
export function coordinatorTools(): ToolDescriptor[] {
  return shippedCoordinatorTools()
}

/** The coordinator session's standing instructions, as the daemon ships them, for the scenarios' channel or webchat conversation. */
export function coordinatorPrompt(webchat = false): string {
  if (webchat)
    return shippedCoordinatorPrompt({
      agentName: CO_IDS.self,
      platform: 'webchat',
      channelId: CO_IDS.conversation,
      peers: [],
      webchat: true
    })
  return shippedCoordinatorPrompt({
    agentName: CO_IDS.self,
    platform: 'Slack',
    channelId: CO_IDS.channel,
    channelName: CO_IDS.channelName,
    selfAddress: `<@${CO_IDS.selfBot}>`,
    peers: [
      {
        name: CO_IDS.peer,
        address: `<@${CO_IDS.peerBot}>`,
        description: 'owns billing, credentials, and infrastructure access'
      }
    ]
  })
}

/** One coordinator turn's input: the delivered channel-root messages, rendered as the daemon renders them. */
export function renderBatch(messages: ChannelMessage[], webchat = false): string {
  if (webchat) return renderCoordinatorBatch(messages, { channelId: CO_IDS.conversation, webchat: true })
  return renderCoordinatorBatch(
    messages.map((message) => ({ ...message, from: `<@${message.from}>` })),
    { channelId: CO_IDS.channel, channelName: CO_IDS.channelName }
  )
}

/** What one coordinator call decided, or why it is not a decision. */
export type CoOutcome =
  | { kind: 'delegate'; messageId: string; title: string }
  | { kind: 'route'; messageId: string; taskId: string }
  | { kind: 'reply'; messageId: string; text: string }

const outcomeArgs = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('delegateTask'),
    messageId: z.string().min(1),
    title: z.string().trim().min(1, 'delegateTask needs a title'),
    message: z.string().optional()
  }),
  z.strictObject({
    action: z.literal('messageTask'),
    messageId: z.string().min(1),
    taskId: z.string().min(1),
    message: z.string().optional()
  }),
  z.strictObject({
    action: z.literal('replyToMessage'),
    messageId: z.string().min(1),
    message: z.string().trim().min(1, 'replyToMessage needs a message')
  })
])

/** What a scenario's turn may name: the delivered messages, the reports among them, and the open tasks. */
export interface CoScope {
  messages: string[]
  reports?: string[]
  tasks: ProbeTask[]
}

/** Check one `sendMessage` call against the turn: its outcome, or the error text the model reads. */
export function decide(
  args: Record<string, unknown>,
  scope: CoScope,
  decided: ReadonlySet<string>
): { outcome: CoOutcome } | { error: string } {
  const parsed = outcomeArgs.safeParse(args)
  if (!parsed.success) return { error: `sendMessage: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` }
  const call = parsed.data
  if (!scope.messages.includes(call.messageId))
    return { error: `sendMessage: messageId ${call.messageId} is not a message delivered in this turn` }
  if (decided.has(call.messageId))
    return { error: `sendMessage: message ${call.messageId} already has an outcome; each message takes one` }
  if (scope.reports?.includes(call.messageId) && call.action !== 'replyToMessage')
    return {
      error: `sendMessage: ${call.messageId} is a report, not a channel message: answer it with action "replyToMessage", or leave it`
    }
  switch (call.action) {
    case 'delegateTask':
      return { outcome: { kind: 'delegate', messageId: call.messageId, title: call.title } }
    case 'messageTask':
      return scope.tasks.some((task) => task.taskId === call.taskId)
        ? { outcome: { kind: 'route', messageId: call.messageId, taskId: call.taskId } }
        : { error: `sendMessage: ${call.taskId} is not one of your open tasks; listTasks lists them` }
    case 'replyToMessage':
      return { outcome: { kind: 'reply', messageId: call.messageId, text: call.message } }
  }
}

function receipt(outcome: CoOutcome): unknown {
  switch (outcome.kind) {
    case 'delegate':
      return { ok: true, taskId: `task-${outcome.messageId}`, thread: outcome.messageId, title: outcome.title }
    case 'route':
      return { ok: true, taskId: outcome.taskId, attachedThread: outcome.messageId }
    case 'reply':
      return { ok: true, posted: { channel: CO_IDS.channel, thread: outcome.messageId } }
  }
}

export interface CoRecordedCall {
  tool: string
  args: Record<string, unknown>
  outcome?: CoOutcome
  error?: string
}

export interface CoordinatorFixture {
  server: Server
  descriptor: (key: string, scope: CoScope) => McpServer
  calls: (key: string) => CoRecordedCall[]
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }
const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true as const } : {})
})

function callTool(
  name: string,
  args: Record<string, unknown>,
  scope: CoScope,
  previous: CoRecordedCall[]
): { result: ToolResult; call: CoRecordedCall } {
  if (name === 'listTasks') return { result: text({ tasks: scope.tasks }), call: { tool: name, args } }
  if (name !== 'sendMessage') {
    const error = `${name} is not available to the coordinator`
    return { result: text(error, true), call: { tool: name, args, error } }
  }
  const decided = new Set(previous.flatMap((call) => (call.outcome ? [call.outcome.messageId] : [])))
  const verdict = decide(args, scope, decided)
  if ('error' in verdict) return { result: text(verdict.error, true), call: { tool: name, args, error: verdict.error } }
  return { result: text(receipt(verdict.outcome)), call: { tool: name, args, outcome: verdict.outcome } }
}

/** The coordinator's HTTP MCP fixture: one recorded call log and scope per path. */
export function coordinatorFixture(tools: ToolDescriptor[] = coordinatorTools()): Promise<CoordinatorFixture> {
  const log = new Map<string, CoRecordedCall[]>()
  const scopes = new Map<string, CoScope>()
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
        const raw = rpc.params?.arguments
        const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        const calls = log.get(key) ?? []
        const { result, call } = callTool(
          String(rpc.params?.name ?? ''),
          args,
          scopes.get(key) ?? { messages: [], tasks: [] },
          calls
        )
        calls.push(call)
        log.set(key, calls)
        reply(result)
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
        descriptor: (key, scope) => {
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

/** The outcome a message should get; `alternatives` are acceptable but weaker, and score DEGRADED. */
export interface Expectation {
  kind: 'delegate' | 'route' | 'reply' | 'ignore' | 'any'
  taskId?: string
  /** A reply must contain this, case-insensitively. */
  mentions?: string
  alternatives?: Array<'delegate' | 'route' | 'reply'>
}

export type CoScenarioId =
  | 'new-work'
  | 'route-to-task'
  | 'status-reply'
  | 'greeting'
  | 'ignore-chatter'
  | 'ignore-peer'
  | 'mention-vague'
  | 'no-self-work'
  | 'batch-mixed'
  | 'batch-route-and-new'
  | 'report-reply'
  | 'webchat-new-work'
  | 'webchat-status'
  | 'webchat-route'

export interface CoordinatorScenario {
  id: CoScenarioId
  messages: ChannelMessage[]
  tasks: ProbeTask[]
  expect: Record<string, Expectation>
  /** A member's webchat conversation: the person reads every text the turn writes (auto-session-mode.md §10). */
  webchat?: true
}

/** A webchat message: one person, always addressed to the agent. */
const webMsg = (id: string, body: string): ChannelMessage => ({
  id,
  from: 'Alice Example',
  mentionsYou: true,
  text: body
})

const msg = (id: string, from: string, mentionsYou: boolean, body: string): ChannelMessage => ({
  id,
  from,
  mentionsYou,
  text: mentionsYou ? `<@${CO_IDS.selfBot}> ${body}` : body
})

export const CO_SCENARIOS: CoordinatorScenario[] = [
  {
    id: 'new-work',
    tasks: [],
    messages: [
      msg(
        'msg-1700000100.000100',
        CO_IDS.alice,
        true,
        'staging deploys have been failing since this morning, the api pod sits in ImagePullBackOff. Can you dig into it?'
      )
    ],
    expect: { 'msg-1700000100.000100': { kind: 'delegate' } }
  },
  {
    id: 'route-to-task',
    tasks: [CHECKOUT_TASK],
    messages: [
      msg(
        'msg-1700000200.000100',
        CO_IDS.bob,
        false,
        'checkout e2e timed out on main again just now: https://ci.example.test/runs/8812'
      )
    ],
    expect: { 'msg-1700000200.000100': { kind: 'route', taskId: CO_IDS.checkoutTask } }
  },
  {
    id: 'status-reply',
    tasks: [CHECKOUT_TASK],
    messages: [msg('msg-1700000300.000100', CO_IDS.bob, true, 'where are we on the flaky checkout test?')],
    expect: { 'msg-1700000300.000100': { kind: 'reply', mentions: '4821', alternatives: ['route'] } }
  },
  {
    id: 'greeting',
    tasks: [],
    messages: [msg('msg-1700000400.000100', CO_IDS.alice, true, 'good morning!')],
    expect: { 'msg-1700000400.000100': { kind: 'reply' } }
  },
  {
    id: 'ignore-chatter',
    tasks: [CHECKOUT_TASK],
    messages: [msg('msg-1700000500.000100', CO_IDS.alice, false, `<@${CO_IDS.bob}> lunch at 12:30 today?`)],
    expect: { 'msg-1700000500.000100': { kind: 'ignore' } }
  },
  {
    id: 'ignore-peer',
    tasks: [],
    messages: [
      msg(
        'msg-1700000600.000100',
        CO_IDS.bob,
        false,
        `<@${CO_IDS.peerBot}> can you rotate the staging database credentials before the audit?`
      )
    ],
    expect: { 'msg-1700000600.000100': { kind: 'ignore' } }
  },
  {
    id: 'mention-vague',
    tasks: [],
    messages: [msg('msg-1700000700.000100', CO_IDS.alice, true, 'thoughts?')],
    expect: { 'msg-1700000700.000100': { kind: 'any' } }
  },
  {
    id: 'no-self-work',
    tasks: [],
    messages: [msg('msg-1700000800.000100', CO_IDS.alice, true, "please fix the typo 'recieve' in README.md")],
    expect: { 'msg-1700000800.000100': { kind: 'delegate' } }
  },
  {
    id: 'batch-mixed',
    tasks: [CHECKOUT_TASK],
    messages: [
      msg('msg-1700000900.000100', CO_IDS.bob, false, 'morning all'),
      msg(
        'msg-1700000900.000200',
        CO_IDS.alice,
        true,
        'can you add retry with backoff to the webhook sender in services/notify? it drops events on 502s'
      ),
      msg(
        'msg-1700000900.000300',
        CO_IDS.bob,
        false,
        `<@${CO_IDS.peerBot}> please check the billing dashboard numbers`
      ),
      msg('msg-1700000900.000400', CO_IDS.bob, true, "thanks for yesterday's fix btw!")
    ],
    expect: {
      'msg-1700000900.000100': { kind: 'ignore' },
      'msg-1700000900.000200': { kind: 'delegate' },
      'msg-1700000900.000300': { kind: 'ignore' },
      'msg-1700000900.000400': { kind: 'reply' }
    }
  },
  {
    id: 'batch-route-and-new',
    tasks: [CHECKOUT_TASK],
    messages: [
      msg('msg-1700001000.000100', CO_IDS.bob, false, 'checkout e2e flaked again: https://ci.example.test/runs/8813'),
      msg(
        'msg-1700001000.000200',
        CO_IDS.alice,
        true,
        'separate thing: the disk usage alert for db-2 is firing, can you check what is filling it up?'
      )
    ],
    expect: {
      'msg-1700001000.000100': { kind: 'route', taskId: CO_IDS.checkoutTask },
      'msg-1700001000.000200': { kind: 'delegate' }
    }
  },
  {
    // auto-session-mode.md §3.4: a follow-up's report is told to the people it concerns, never handed to a task.
    id: 'report-reply',
    tasks: [CHECKOUT_TASK],
    messages: [
      {
        id: 'msg-1700001100.000100',
        from: CO_IDS.self,
        mentionsYou: false,
        report: true,
        text:
          `[follow-up] "Watch PR #4821" checked: PR #4821 merged and the checkout e2e test passed on main ten times ` +
          `in a row. <@${CO_IDS.alice}> asked to hear when it lands. Answer your people in their language.`
      }
    ],
    expect: { 'msg-1700001100.000100': { kind: 'reply', mentions: '4821' } }
  },
  {
    id: 'webchat-new-work',
    webchat: true,
    tasks: [],
    messages: [
      webMsg(
        'msg-6f1d2c3b-0a9e-4c7d-8b5a-1e2f3a4b5c6d',
        'can you add retry with backoff to the webhook sender in services/notify? it drops events on 502s'
      )
    ],
    expect: { 'msg-6f1d2c3b-0a9e-4c7d-8b5a-1e2f3a4b5c6d': { kind: 'delegate' } }
  },
  {
    id: 'webchat-status',
    webchat: true,
    tasks: [CHECKOUT_TASK],
    messages: [webMsg('msg-7a2e3d4c-1b0f-4d8e-9c6b-2f3a4b5c6d7e', 'where are we on the flaky checkout test?')],
    expect: { 'msg-7a2e3d4c-1b0f-4d8e-9c6b-2f3a4b5c6d7e': { kind: 'reply', mentions: '4821', alternatives: ['route'] } }
  },
  {
    id: 'webchat-route',
    webchat: true,
    tasks: [CHECKOUT_TASK],
    messages: [
      webMsg(
        'msg-8b3f4e5d-2c1a-4e9f-8d7c-3a4b5c6d7e8f',
        'checkout e2e timed out on main again just now: https://ci.example.test/runs/8812'
      )
    ],
    expect: { 'msg-8b3f4e5d-2c1a-4e9f-8d7c-3a4b5c6d7e8f': { kind: 'route', taskId: CO_IDS.checkoutTask } }
  }
]

/** A single-message turn's final text counts as a reply to it, unless it is the silence sentinel. */
const textReply = (finalText: string): string | undefined => {
  const trimmed = finalText.trim()
  return trimmed === '' || trimmed.startsWith(NO_RESPONSE_SENTINEL) ? undefined : trimmed
}

/** PASS when every message got its expected outcome and no call was refused; DEGRADED on an alternative or a refusal; FAIL otherwise. */
export function judgeCoordinator(
  scenario: CoordinatorScenario,
  calls: CoRecordedCall[],
  finalText: string
): { verdict: SendMessageVerdict; notes: string[] } {
  const outcomes = new Map<string, CoOutcome>()
  for (const call of calls) if (call.outcome) outcomes.set(call.outcome.messageId, call.outcome)
  const notes: string[] = []
  let degraded = false
  let failed = false
  for (const message of scenario.messages) {
    const expected = scenario.expect[message.id]!
    let outcome = outcomes.get(message.id)
    const spoken = scenario.messages.length === 1 ? textReply(finalText) : undefined
    if (!outcome && spoken !== undefined) outcome = { kind: 'reply', messageId: message.id, text: spoken }
    const got = outcome?.kind ?? 'ignore'
    if (expected.kind === 'any' ? got !== 'ignore' : got === expected.kind) {
      if (outcome?.kind === 'route' && expected.taskId && outcome.taskId !== expected.taskId) {
        failed = true
        notes.push(`${message.id}: routed to ${outcome.taskId}, expected ${expected.taskId}`)
      } else if (
        outcome?.kind === 'reply' &&
        expected.mentions &&
        !outcome.text.toLowerCase().includes(expected.mentions.toLowerCase())
      ) {
        degraded = true
        notes.push(`${message.id}: reply lacks "${expected.mentions}"`)
      }
    } else if (got !== 'ignore' && expected.alternatives?.includes(got)) {
      degraded = true
      notes.push(`${message.id}: ${got}, preferred ${expected.kind}`)
    } else {
      failed = true
      notes.push(`${message.id}: ${got}, expected ${expected.kind}`)
    }
  }
  // A webchat person reads the text a turn writes beside a call, which a channel never posts.
  const chatter = textReply(finalText)
  if (scenario.webchat && chatter !== undefined && outcomes.size > 0) {
    degraded = true
    notes.push(`text shown beside a call: ${JSON.stringify(chatter.slice(0, 80))}`)
  }
  const refused = calls.filter((call) => call.error !== undefined)
  if (refused.length > 0) {
    degraded = true
    notes.push(
      `${refused.length} refused call(s): ${refused
        .map((call) => call.error)
        .join(' | ')
        .slice(0, 300)}`
    )
  }
  return { verdict: failed ? 'FAIL' : degraded ? 'DEGRADED' : 'PASS', notes }
}

export interface CoordinatorRun {
  runtime: string
  scenario: CoScenarioId
  rep: number
  verdict: SendMessageVerdict
  comparable: true
  outcomes: string[]
  /** Every runtime tool call's title, in order, so a native tool the coordinator should not use shows up. */
  toolCalls: string[]
  counts: { sendMessage: number; listTasks: number; refused: number; acpToolCalls: number }
  ms: number
  tokens?: unknown
  notes: string[]
}

export const describeOutcome = (outcome: CoOutcome): string =>
  outcome.kind === 'delegate'
    ? `delegate(${outcome.messageId},"${outcome.title}")`
    : outcome.kind === 'route'
      ? `route(${outcome.messageId}->${outcome.taskId})`
      : `reply(${outcome.messageId},${JSON.stringify(outcome.text.slice(0, 60))})`

/** Run every selected scenario `reps` times, each in a fresh coordinator session on an already-started host. */
export async function runCoordinatorScenarios(input: {
  runtime: string
  host: AcpHost
  cwd: string
  fixture: CoordinatorFixture
  scenarios: CoordinatorScenario[]
  reps: number
  updates: Array<{ sessionId: string; update: any }>
  support: ProbeSupport
  onRun?: (run: CoordinatorRun) => void
}): Promise<CoordinatorRun[]> {
  const { runtime, host, cwd, fixture, support } = input
  const usesMeta = host.usesMetaSystemPrompt()
  const runs: CoordinatorRun[] = []
  for (let rep = 1; rep <= input.reps; rep++) {
    for (const scenario of input.scenarios) {
      const key = `${runtime}/co/${scenario.id}/${rep}`
      const prompt = coordinatorPrompt(scenario.webchat === true)
      const scope: CoScope = {
        messages: scenario.messages.map((message) => message.id),
        reports: scenario.messages.filter((message) => message.report).map((message) => message.id),
        tasks: scenario.tasks
      }
      const started = Date.now()
      let sessionId: string | undefined
      let tokens: unknown
      let failure: unknown
      try {
        sessionId = await support.withTimeout(
          host.newSession(cwd, [fixture.descriptor(key, scope)], undefined, usesMeta ? prompt : undefined),
          `${runtime}/coordinator ${scenario.id} session`
        )
        const blocks = [
          ...(usesMeta ? [] : [{ type: 'text' as const, text: prompt }]),
          { type: 'text' as const, text: renderBatch(scenario.messages, scenario.webchat === true) }
        ]
        tokens = (await support.withTimeout(host.prompt(sessionId, blocks), `${runtime}/coordinator ${scenario.id}`))
          .usage
      } catch (error) {
        failure = error
      }
      const ms = Date.now() - started
      const calls = fixture.calls(key)
      const sessionUpdates = input.updates.filter((entry) => entry.sessionId === sessionId)
      const finalText = sessionUpdates
        .filter(
          (entry) => entry.update?.sessionUpdate === 'agent_message_chunk' && entry.update?.content?.type === 'text'
        )
        .map((entry) => String(entry.update.content.text))
        .join('')
      const notes: string[] = []
      let verdict: SendMessageVerdict
      if (failure !== undefined && support.providerUnavailable(failure)) {
        verdict = 'UNAVAILABLE'
        notes.push(support.errorReason(failure))
      } else {
        const judged = judgeCoordinator(scenario, calls, finalText)
        verdict = failure !== undefined ? 'FAIL' : judged.verdict
        notes.push(...judged.notes)
        if (failure !== undefined) notes.push(`turn error: ${support.errorReason(failure)}`)
      }
      const run: CoordinatorRun = {
        runtime,
        scenario: scenario.id,
        rep,
        verdict,
        comparable: true,
        outcomes: calls.flatMap((call) => (call.outcome ? [describeOutcome(call.outcome)] : [])),
        toolCalls: sessionUpdates
          .filter((entry) => entry.update?.sessionUpdate === 'tool_call')
          .map((entry) => String(entry.update.title ?? entry.update.kind ?? 'tool')),
        counts: {
          sendMessage: calls.filter((call) => call.tool === 'sendMessage').length,
          listTasks: calls.filter((call) => call.tool === 'listTasks').length,
          refused: calls.filter((call) => call.error !== undefined).length,
          acpToolCalls: sessionUpdates.filter((entry) => entry.update?.sessionUpdate === 'tool_call').length
        },
        ms,
        ...(tokens !== undefined ? { tokens } : {}),
        notes: [...notes, ...(finalText.trim() ? [`final=${JSON.stringify(finalText.trim().slice(0, 160))}`] : [])]
      }
      runs.push(run)
      input.onRun?.(run)
      if (sessionId && host.deleteSupported()) {
        await support
          .withTimeout(host.deleteSession(sessionId), `${runtime}/coordinator ${scenario.id} delete`)
          .catch(() => {})
      }
    }
  }
  return runs
}

/** Every run of a runtime that never got a session. */
export function unreachableCoordinatorRuns(
  runtime: string,
  scenarios: CoordinatorScenario[],
  reps: number,
  verdict: 'UNAVAILABLE' | 'FAIL',
  note: string
): CoordinatorRun[] {
  return Array.from({ length: reps }, (_, index) =>
    scenarios.map((scenario) => ({
      runtime,
      scenario: scenario.id,
      rep: index + 1,
      verdict,
      comparable: true as const,
      outcomes: [],
      toolCalls: [],
      counts: { sendMessage: 0, listTasks: 0, refused: 0, acpToolCalls: 0 },
      ms: 0,
      notes: [note]
    }))
  ).flat()
}

/** Scenarios selected by `AC_RUNTIME_MATRIX_COORDINATOR_SCENARIOS` (comma list), else all. */
export function selectedCoordinatorScenarios(filter: string | undefined): CoordinatorScenario[] {
  const wanted = new Set(
    (filter ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  )
  const unknown = [...wanted].filter((id) => !CO_SCENARIOS.some((scenario) => scenario.id === id))
  if (unknown.length > 0) throw new Error(`unknown coordinator scenario(s): ${unknown.join(', ')}`)
  return wanted.size === 0 ? CO_SCENARIOS : CO_SCENARIOS.filter((scenario) => wanted.has(scenario.id))
}
