import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate
} from '@agentclientprotocol/sdk/unstable'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  claudeMcpRules,
  claudeToolName,
  McpApprovalGate,
  personRecords,
  runtimeReviewRecords,
  type GateRuntime
} from '../src/mcp/approval-gate.js'
import { ApprovalRecords, argumentsDigest } from '../src/mcp/approval-records.js'

// Every §7.3 row driven by the ACP shapes the live checks recorded (mcp-tool-permissions.md §12.1).

const AGENT = 'agent-1'
const SESSION = 'session-1'
const DECISIONS: McpToolDecisions = {
  allow: ['read_note'],
  approval: ['write_note'],
  ask: ['wire_transfer'],
  block: ['delete_all']
}

function gate(runtime: GateRuntime, mode: { current: string | undefined }, restricted = DECISIONS) {
  const records = new ApprovalRecords()
  const g = new McpApprovalGate({
    agentId: AGENT,
    runtime,
    records,
    restricted: () => new Map([['probe', restricted]]),
    modeOf: () => mode.current,
    log: { info: () => {}, warn: () => {} }
  })
  return { g, records }
}

const update = (value: Record<string, unknown>) => value as unknown as SessionUpdate

/** Claude's `tool_call` for an MCP tool: no arguments yet, the name in `_meta.claudeCode.toolName`. */
function claudeToolCall(id: string, tool: string) {
  const name = `mcp__probe__${tool}`
  return update({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    name,
    title: name,
    status: 'pending',
    kind: 'other',
    content: [],
    rawInput: {},
    _meta: { claudeCode: { toolName: name } }
  })
}

function claudeArgs(id: string, tool: string, rawInput: unknown) {
  return update({
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    rawInput,
    _meta: { claudeCode: { toolName: `mcp__probe__${tool}` } }
  })
}

function claudeRequest(id: string, tool: string, rawInput: unknown): RequestPermissionRequest {
  const name = `mcp__probe__${tool}`
  return {
    sessionId: SESSION,
    toolCall: {
      toolCallId: id,
      status: 'pending',
      rawInput,
      title: name,
      kind: 'other',
      content: [],
      _meta: { claudeCode: { toolName: name, mcpServer: { name: 'probe', source: 'dynamic' } } }
    },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' }
    ]
  } as RequestPermissionRequest
}

/** Codex's `tool_call` for an MCP tool, whose input names the server, the tool and the arguments. */
function codexToolCall(id: string, tool: string, args: unknown) {
  return update({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    kind: 'execute',
    title: `mcp.probe.${tool}`,
    status: 'in_progress',
    rawInput: { server: 'probe', tool, arguments: args },
    _meta: { is_mcp_tool_call: true }
  })
}

/** Codex's MCP approval: the call id and kind alone, no `rawInput`, and its session and always options. */
function codexRequest(id: string): RequestPermissionRequest {
  return {
    sessionId: SESSION,
    toolCall: { toolCallId: id, kind: 'execute', status: 'pending' },
    _meta: { is_mcp_tool_approval: true },
    options: [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }
    ]
  } as RequestPermissionRequest
}

function guardian(reviewId: string, target: string, tool: string, status: 'inProgress' | 'approved' | 'denied') {
  const action = { type: 'mcpToolCall', server: 'probe', toolName: tool, connectorId: null }
  return status === 'inProgress'
    ? update({
        sessionUpdate: 'tool_call',
        toolCallId: `guardian_assessment:${reviewId}`,
        kind: 'think',
        title: 'Guardian Review',
        status: 'in_progress',
        rawInput: { reviewId, targetItemId: target, review: { status: 'inProgress' }, action }
      })
    : update({
        sessionUpdate: 'tool_call_update',
        toolCallId: `guardian_assessment:${reviewId}`,
        status: 'completed',
        rawOutput: { reviewId, targetItemId: target, decisionSource: 'agent', review: { status }, action }
      })
}

const select = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: 'selected', optionId } })

describe('Claude manual modes ask a person', () => {
  it('offer once-only options, and record `person` for the card’s arguments before the answer returns', async () => {
    const { g, records } = gate('claude', { current: 'default' })
    g.observe(SESSION, claudeToolCall('toolu_1', 'write_note'))
    g.observe(SESSION, claudeArgs('toolu_1', 'write_note', { text: 'hello' }))
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once'])
      expect(params.toolCall.rawInput).toEqual({ text: 'hello' })
      return select('allow-once')
    })
    let atAnswer: unknown
    await g.permission(SESSION, claudeRequest('toolu_1', 'write_note', { text: 'hello' }), ask).then((answer) => {
      atAnswer = records.get(AGENT, 'toolu_1')
      expect(answer).toEqual(select('allow-once'))
    })
    expect(atAnswer).toMatchObject({
      provider: 'probe',
      tool: 'write_note',
      source: 'person',
      argsDigest: argumentsDigest({ text: 'hello' })
    })
    // The record is the card's: a later change of the arguments does not follow it.
    g.observe(SESSION, claudeArgs('toolu_1', 'write_note', { text: 'changed' }))
    expect(records.get(AGENT, 'toolu_1')?.argsDigest).toBe(argumentsDigest({ text: 'hello' }))
  })

  it('records nothing on a rejection, in dontAsk, or for a tool that is not approval-gated', async () => {
    const mode = { current: 'plan' as string | undefined }
    const { g, records } = gate('claude', mode)
    await g.permission(SESSION, claudeRequest('toolu_1', 'write_note', { text: 'a' }), async () => select('reject'))
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
    mode.current = 'dontAsk'
    await g.permission(SESSION, claudeRequest('toolu_2', 'write_note', { text: 'a' }), async () => select('allow-once'))
    expect(records.get(AGENT, 'toolu_2')).toBeUndefined()
    mode.current = 'default'
    const other = claudeRequest('toolu_3', 'read_note', {})
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params).toBe(other)
      return select('allow-once')
    })
    await g.permission(SESSION, other, ask)
    expect(ask).toHaveBeenCalledOnce()
    expect(records.get(AGENT, 'toolu_3')).toBeUndefined()
  })
})

describe('Claude Auto', () => {
  it('records the classifier’s proposal of a Needs approval call and follows its arguments to the last shown', () => {
    const { g, records } = gate('claude', { current: 'auto' })
    g.observe(SESSION, claudeToolCall('toolu_1', 'write_note'))
    expect(records.get(AGENT, 'toolu_1')).toMatchObject({ source: 'runtime-review', argsDigest: argumentsDigest({}) })
    g.observe(SESSION, claudeArgs('toolu_1', 'write_note', { amount_usd: 250 }))
    g.observe(SESSION, claudeArgs('toolu_1', 'write_note', { amount_usd: 250, memo: 'invoice' }))
    expect(records.get(AGENT, 'toolu_1')?.argsDigest).toBe(argumentsDigest({ memo: 'invoice', amount_usd: 250 }))
  })

  it('drops the record when the classifier refuses: a failed update, or an automode- non-execution', () => {
    const { g, records } = gate('claude', { current: 'auto' })
    g.observe(SESSION, claudeToolCall('toolu_1', 'write_note'))
    g.observe(SESSION, claudeArgs('toolu_1', 'write_note', { text: 'a' }))
    g.observe(
      SESSION,
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }],
        _meta: {
          claudeCode: { toolName: 'mcp__probe__write_note', toolResponse: { decisionReasonType: 'classifier' } }
        }
      })
    )
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
    g.observe(SESSION, claudeToolCall('toolu_2', 'write_note'))
    g.observe(
      SESSION,
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_2',
        rawOutput: 'Permission for this action was denied by the Claude Code auto mode classifier.',
        _meta: { claudeCode: { toolName: 'mcp__probe__write_note', nonExecutionKind: 'automode-blocked' } }
      })
    )
    expect(records.get(AGENT, 'toolu_2')).toBeUndefined()
    // Arguments after the refusal do not revive it.
    g.observe(SESSION, claudeArgs('toolu_2', 'write_note', { text: 'later' }))
    expect(records.get(AGENT, 'toolu_2')).toBeUndefined()
  })

  it('leaves an Always ask tool to a person, and follows a mid-session switch into Auto', async () => {
    const mode = { current: 'auto' as string | undefined }
    const { g, records } = gate('claude', mode)
    g.observe(SESSION, claudeToolCall('toolu_1', 'wire_transfer'))
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
    await g.permission(SESSION, claudeRequest('toolu_1', 'wire_transfer', { iban: 'x' }), async () =>
      select('allow-once')
    )
    expect(records.get(AGENT, 'toolu_1')).toMatchObject({ source: 'person' })
    mode.current = 'default'
    g.observe(SESSION, claudeToolCall('toolu_2', 'write_note'))
    expect(records.get(AGENT, 'toolu_2')).toBeUndefined()
    mode.current = 'auto'
    g.observe(SESSION, claudeToolCall('toolu_3', 'write_note'))
    expect(records.get(AGENT, 'toolu_3')).toMatchObject({ source: 'runtime-review' })
  })

  it('records nothing in Bypass until a person answers the card its ask rule forces', async () => {
    const { g, records } = gate('claude', { current: 'bypassPermissions' })
    g.observe(SESSION, claudeToolCall('toolu_1', 'write_note'))
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
    await g.permission(SESSION, claudeRequest('toolu_1', 'write_note', { text: 'a' }), async () => select('allow-once'))
    expect(records.get(AGENT, 'toolu_1')).toMatchObject({ source: 'person' })
  })
})

describe('Codex', () => {
  it('takes a workspace-write approval’s arguments from the call’s tool_call, and offers once-only options', async () => {
    const { g, records } = gate('codex', { current: 'workspace-write' })
    g.observe(SESSION, codexToolCall('exec-1', 'write_note', { text: 'hello-x8' }))
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params.options.map((o) => o.optionId)).toEqual(['allow_once', 'cancel'])
      expect(params.toolCall.rawInput).toEqual({ server: 'probe', tool: 'write_note', arguments: { text: 'hello-x8' } })
      return select('allow_once')
    })
    expect(await g.permission(SESSION, codexRequest('exec-1'), ask)).toEqual(select('allow_once'))
    expect(records.get(AGENT, 'exec-1')).toMatchObject({
      source: 'person',
      tool: 'write_note',
      argsDigest: argumentsDigest({ text: 'hello-x8' })
    })
  })

  it('rejects an approval whose call had no tool_call, without asking', async () => {
    const { g, records } = gate('codex', { current: 'workspace-write' })
    const ask = vi.fn(async () => select('allow_once'))
    expect(await g.permission(SESSION, codexRequest('exec-unknown'), ask)).toEqual(select('cancel'))
    expect(ask).not.toHaveBeenCalled()
    expect(records.get(AGENT, 'exec-unknown')).toBeUndefined()
  })

  it('refuses an answer naming an option the card did not offer', async () => {
    const { g, records } = gate('codex', { current: 'read-only' })
    g.observe(SESSION, codexToolCall('exec-1', 'write_note', { text: 'a' }))
    expect(await g.permission(SESSION, codexRequest('exec-1'), async () => select('allow_always'))).toEqual(
      select('cancel')
    )
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
  })

  it('records the Guardian’s approval of a Needs approval call in Auto review, and nothing for Always ask', () => {
    const { g, records } = gate('codex', { current: 'agent' })
    g.observe(SESSION, codexToolCall('exec-1', 'write_note', { text: 'hello-g3' }))
    g.observe(SESSION, guardian('r1', 'exec-1', 'write_note', 'inProgress'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
    g.observe(SESSION, guardian('r1', 'exec-1', 'write_note', 'approved'))
    expect(records.get(AGENT, 'exec-1')).toMatchObject({
      source: 'runtime-review',
      argsDigest: argumentsDigest({ text: 'hello-g3' })
    })
    g.observe(SESSION, codexToolCall('exec-2', 'wire_transfer', { iban: 'x' }))
    g.observe(SESSION, guardian('r2', 'exec-2', 'wire_transfer', 'inProgress'))
    g.observe(SESSION, guardian('r2', 'exec-2', 'wire_transfer', 'approved'))
    expect(records.get(AGENT, 'exec-2')).toBeUndefined()
    g.observe(SESSION, codexToolCall('exec-3', 'write_note', { text: 'no' }))
    g.observe(SESSION, guardian('r3', 'exec-3', 'write_note', 'inProgress'))
    g.observe(SESSION, guardian('r3', 'exec-3', 'write_note', 'denied'))
    expect(records.get(AGENT, 'exec-3')).toBeUndefined()
  })

  it('records nothing in Full access', async () => {
    const { g, records } = gate('codex', { current: 'agent-full-access' })
    g.observe(SESSION, codexToolCall('exec-1', 'write_note', { text: 'a' }))
    g.observe(SESSION, guardian('r1', 'exec-1', 'write_note', 'inProgress'))
    g.observe(SESSION, guardian('r1', 'exec-1', 'write_note', 'approved'))
    await g.permission(SESSION, codexRequest('exec-1'), async () => select('allow_once'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
  })
})

describe('any other runtime', () => {
  it('records nothing and leaves its requests alone', async () => {
    const { g, records } = gate('other', { current: undefined })
    g.observe(SESSION, claudeToolCall('toolu_1', 'write_note'))
    const request = claudeRequest('toolu_1', 'write_note', {})
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params).toBe(request)
      return select('allow-once')
    })
    await g.permission(SESSION, request, ask)
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
  })
})

// claude-agent-acp 0.112.0 and codex-acp 2.12.0 as the daemon's AIR client sees them, recorded 2026-11-25 and scrubbed.
const AIR_SERVER = 'approval-check-wiki'
const AIR_DECISIONS: McpToolDecisions = {
  allow: ['ask_question'],
  approval: ['read_wiki_structure'],
  ask: [],
  block: []
}
const AIR_NAME = `mcp__${AIR_SERVER}__read_wiki_structure`
const AIR_TITLE = `${AIR_SERVER}: read_wiki_structure`
const AIR_ARGS = { repoName: 'example-org/example-repo' }

function airGate(runtime: GateRuntime, mode: string, clock = { now: 0 }) {
  const records = new ApprovalRecords()
  const warn = vi.fn()
  const g = new McpApprovalGate({
    agentId: AGENT,
    runtime,
    records,
    restricted: () => new Map([[AIR_SERVER, AIR_DECISIONS]]),
    modeOf: () => mode,
    log: { info: () => {}, warn },
    now: () => clock.now
  })
  return { g, records, warn }
}

/** Claude's AIR `tool_call`: no `rawInput` until the input is complete, and the title is display text. */
const claudeAirToolCall = (id: string) =>
  update({
    _meta: {
      claudeCode: { toolName: AIR_NAME },
      jetbrains: { air: { version: 1, mcp: { server: AIR_SERVER, tool: 'read_wiki_structure' } } },
      is_mcp_tool_call: true
    },
    toolCallId: id,
    sessionUpdate: 'tool_call',
    name: AIR_NAME,
    status: 'pending',
    title: AIR_TITLE,
    kind: 'other',
    content: []
  })

const claudeAirArgs = (id: string) => update({ toolCallId: id, sessionUpdate: 'tool_call_update', rawInput: AIR_ARGS })

/** Claude's AIR permission request: the server in `_meta.claudeCode.mcpServer`, but no tool name. */
function claudeAirRequest(id: string, title = AIR_TITLE): RequestPermissionRequest {
  return {
    toolCall: {
      toolCallId: id,
      title,
      rawInput: AIR_ARGS,
      _meta: { claudeCode: { mcpServer: { name: AIR_SERVER, source: 'dynamic' } } }
    },
    _meta: { jetbrains: { air: { version: 1, permission: { version: 1, title } } } },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      {
        optionId: 'allow-with-updates',
        name: "Yes, and don't ask again for Read Wiki Structure commands",
        kind: 'allow_always'
      },
      { optionId: 'reject', name: 'No', kind: 'reject_once' }
    ],
    sessionId: SESSION
  } as RequestPermissionRequest
}

const codexAirToolCall = (id: string, tool = 'read_wiki_structure') =>
  update({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    kind: 'execute',
    title: `mcp.${AIR_SERVER}.${tool}`,
    status: 'in_progress',
    rawInput: { server: AIR_SERVER, tool, arguments: AIR_ARGS },
    _meta: { is_mcp_tool_call: true }
  })

/** Codex's AIR Guardian review: the action alone, no review id, target or verdict object; `completed` means approved. */
function codexAirGuardian(
  reviewId: string,
  status: 'in_progress' | 'completed' | 'failed',
  tool = 'read_wiki_structure'
) {
  const action = {
    type: 'mcpToolCall',
    server: AIR_SERVER,
    toolName: tool,
    connectorId: null,
    connectorName: null,
    toolTitle: null
  }
  const shown = { type: 'content', content: { type: 'text', text: `Action: MCP ${tool} on ${AIR_SERVER}` } }
  return status === 'in_progress'
    ? update({
        sessionUpdate: 'tool_call',
        toolCallId: `guardian_assessment:${reviewId}`,
        kind: 'think',
        title: 'Guardian Review',
        status,
        content: [shown, { type: 'content', content: { type: 'text', text: 'Status: In progress' } }],
        rawInput: { action }
      })
    : update({
        sessionUpdate: 'tool_call_update',
        toolCallId: `guardian_assessment:${reviewId}`,
        status,
        content: [
          shown,
          {
            type: 'content',
            content: { type: 'text', text: status === 'completed' ? 'Status: Approved' : 'Status: Denied' }
          }
        ]
      })
}

describe('Claude 0.112 as an AIR client', () => {
  it('names the tool from the call’s own tool_call, offers once-only options, and records `person`', async () => {
    const { g, records } = airGate('claude', 'default')
    g.observe(SESSION, claudeAirToolCall('toolu_air1'))
    g.observe(SESSION, claudeAirArgs('toolu_air1'))
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once'])
      return select('allow-once')
    })
    expect(await g.permission(SESSION, claudeAirRequest('toolu_air1'), ask)).toEqual(select('allow-once'))
    expect(records.get(AGENT, 'toolu_air1')).toMatchObject({
      provider: AIR_SERVER,
      tool: 'read_wiki_structure',
      source: 'person',
      argsDigest: argumentsDigest(AIR_ARGS)
    })
  })

  it('records nothing from a title alone, but still withholds the always options of a restricted server', async () => {
    const { g, records, warn } = airGate('claude', 'default')
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once'])
      return select('allow-once')
    })
    expect(await g.permission(SESSION, claudeAirRequest('toolu_unseen'), ask)).toEqual(select('allow-once'))
    expect(records.get(AGENT, 'toolu_unseen')).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('leaves an allowed tool’s card alone', async () => {
    const { g, records } = airGate('claude', 'default')
    const name = `mcp__${AIR_SERVER}__ask_question`
    g.observe(SESSION, update({ ...claudeAirToolCall('toolu_allow'), name, _meta: { claudeCode: { toolName: name } } }))
    const request = claudeAirRequest('toolu_allow', `${AIR_SERVER}: ask_question`)
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params).toBe(request)
      return select('allow-once')
    })
    await g.permission(SESSION, request, ask)
    expect(records.get(AGENT, 'toolu_allow')).toBeUndefined()
  })

  it('records Auto’s proposal from the tool_call and follows the complete input', () => {
    const { g, records } = airGate('claude', 'auto')
    g.observe(SESSION, claudeAirToolCall('toolu_air2'))
    expect(records.get(AGENT, 'toolu_air2')).toMatchObject({ source: 'runtime-review', tool: 'read_wiki_structure' })
    g.observe(SESSION, claudeAirArgs('toolu_air2'))
    g.observe(SESSION, update({ toolCallId: 'toolu_air2', sessionUpdate: 'tool_call_update', status: 'completed' }))
    expect(records.get(AGENT, 'toolu_air2')?.argsDigest).toBe(argumentsDigest(AIR_ARGS))
  })
})

describe('Claude 0.109 cards that offer always options', () => {
  it('withholds allow_always and reject_always, and refuses an answer naming one', async () => {
    const { g, records } = gate('claude', { current: 'default' })
    const request = claudeRequest('toolu_1', 'write_note', { text: 'a' })
    request.options = [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Yes, always', kind: 'allow_always' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
      { optionId: 'reject-always', name: 'No, never', kind: 'reject_always' }
    ]
    const ask = vi.fn(async (params: RequestPermissionRequest) => {
      expect(params.options.map((o) => o.optionId)).toEqual(['allow-once', 'reject'])
      return select('allow-always')
    })
    expect(await g.permission(SESSION, request, ask)).toEqual(select('reject'))
    expect(records.get(AGENT, 'toolu_1')).toBeUndefined()
  })
})

describe('Codex 2.12 Auto review as an AIR client', () => {
  it('links the Guardian review to the call that just started, and records its approval with the call’s arguments', () => {
    const { g, records } = airGate('codex', 'agent')
    g.observe(SESSION, codexAirToolCall('exec-1'))
    g.observe(SESSION, codexAirGuardian('r1', 'in_progress'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
    g.observe(SESSION, codexAirGuardian('r1', 'completed'))
    expect(records.get(AGENT, 'exec-1')).toMatchObject({
      provider: AIR_SERVER,
      tool: 'read_wiki_structure',
      source: 'runtime-review',
      argsDigest: argumentsDigest(AIR_ARGS)
    })
  })

  it('records nothing for a denied review, or one not in Auto review', () => {
    const { g, records } = airGate('codex', 'agent')
    g.observe(SESSION, codexAirToolCall('exec-1'))
    g.observe(SESSION, codexAirGuardian('r1', 'in_progress'))
    g.observe(SESSION, codexAirGuardian('r1', 'failed'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
    const full = airGate('codex', 'agent-full-access')
    full.g.observe(SESSION, codexAirToolCall('exec-2'))
    full.g.observe(SESSION, codexAirGuardian('r2', 'in_progress'))
    full.g.observe(SESSION, codexAirGuardian('r2', 'completed'))
    expect(full.records.get(AGENT, 'exec-2')).toBeUndefined()
  })

  it('links nothing when two open calls match, the call already finished, or it started too long ago', () => {
    const { g, records, warn } = airGate('codex', 'agent')
    g.observe(SESSION, codexAirToolCall('exec-1'))
    g.observe(SESSION, codexAirToolCall('exec-2'))
    g.observe(SESSION, codexAirGuardian('r1', 'in_progress'))
    g.observe(SESSION, codexAirGuardian('r1', 'completed'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
    expect(records.get(AGENT, 'exec-2')).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()

    const done = airGate('codex', 'agent')
    done.g.observe(SESSION, codexAirToolCall('exec-3'))
    done.g.observe(SESSION, update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-3', status: 'completed' }))
    done.g.observe(SESSION, codexAirGuardian('r3', 'in_progress'))
    done.g.observe(SESSION, codexAirGuardian('r3', 'completed'))
    expect(done.records.get(AGENT, 'exec-3')).toBeUndefined()

    const clock = { now: 0 }
    const late = airGate('codex', 'agent', clock)
    late.g.observe(SESSION, codexAirToolCall('exec-4'))
    clock.now = 5_001
    late.g.observe(SESSION, codexAirGuardian('r4', 'in_progress'))
    late.g.observe(SESSION, codexAirGuardian('r4', 'completed'))
    expect(late.records.get(AGENT, 'exec-4')).toBeUndefined()
  })

  it('lets each review claim one call, so a second review of the same tool takes the next call', () => {
    const { g, records } = airGate('codex', 'agent')
    g.observe(SESSION, codexAirToolCall('exec-1'))
    g.observe(SESSION, codexAirGuardian('r1', 'in_progress'))
    g.observe(SESSION, codexAirToolCall('exec-2'))
    g.observe(SESSION, codexAirGuardian('r2', 'in_progress'))
    g.observe(SESSION, codexAirGuardian('r2', 'completed'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
    expect(records.get(AGENT, 'exec-2')).toMatchObject({ source: 'runtime-review' })
  })

  it('ignores a review of another tool', () => {
    const { g, records } = airGate('codex', 'agent')
    g.observe(SESSION, codexAirToolCall('exec-1'))
    g.observe(SESSION, codexAirGuardian('r1', 'in_progress', 'ask_question'))
    g.observe(SESSION, codexAirGuardian('r1', 'completed', 'ask_question'))
    expect(records.get(AGENT, 'exec-1')).toBeUndefined()
  })
})

describe('the §7.3 table', () => {
  it('names which rows record a person or the runtime’s review', () => {
    expect(personRecords('claude', 'default', 'ask')).toBe(true)
    expect(personRecords('claude', 'dontAsk', 'approval')).toBe(false)
    expect(personRecords('codex', 'workspace-write', 'ask')).toBe(true)
    expect(personRecords('codex', 'agent', 'ask')).toBe(false)
    expect(personRecords('codex', 'agent-full-access', 'approval')).toBe(false)
    expect(personRecords('other', 'default', 'approval')).toBe(false)
    expect(runtimeReviewRecords('claude', 'auto', 'approval')).toBe(true)
    expect(runtimeReviewRecords('claude', 'auto', 'ask')).toBe(false)
    expect(runtimeReviewRecords('codex', 'agent', 'approval')).toBe(true)
    expect(runtimeReviewRecords('codex', 'agent-full-access', 'approval')).toBe(false)
  })

  it('gives Claude allow and deny rules, and an ask rule only where its mode would not ask', () => {
    const restricted = new Map([['probe server', DECISIONS]])
    expect(claudeToolName('probe server', 'write.note')).toBe('mcp__probe_server__write_note')
    expect(claudeMcpRules(restricted, 'bypassPermissions')).toEqual({
      allow: ['mcp__probe_server__read_note'],
      ask: ['mcp__probe_server__write_note', 'mcp__probe_server__wire_transfer'],
      deny: ['mcp__probe_server__delete_all']
    })
    for (const mode of ['default', 'auto', 'acceptEdits'])
      expect(claudeMcpRules(restricted, mode)).toEqual({
        allow: ['mcp__probe_server__read_note'],
        ask: ['mcp__probe_server__wire_transfer'],
        deny: ['mcp__probe_server__delete_all']
      })
    expect(claudeMcpRules(restricted, undefined).ask).toContain('mcp__probe_server__write_note')
    expect(claudeMcpRules(new Map(), 'default')).toEqual({})
  })
})
