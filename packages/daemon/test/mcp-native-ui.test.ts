import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SETUP_URI,
  AGENT_TOOLS_URI,
  CODE_HOST_SETUP_URI,
  INTEGRATION_SETUP_URI,
  MCP_SETUP_URI,
  SKILL_SETUP_URI
} from '@agentconnect.md/protocol/mcp-app'
import { namesNativeUi, nativeUiChrome, nativeUiFromToolUpdate } from '../src/mcp/native-ui.js'
import { Daemon } from '../src/daemon.js'
import { LiveAppRegistry, reviveAppRow } from '../src/mcp/apps/cards.js'
import { AppSurface } from '../src/mcp/apps/surface.js'

const ui = {
  resourceUri: INTEGRATION_SETUP_URI,
  resourceVersion: 1,
  orgId: '11111111-1111-4111-8111-111111111111',
  intent: { mode: 'create', provider: 'github' }
}
// Shape captured from a real Codex ACP 1.11.0-agentconnect.1 HTTP MCP call.
const update = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'http-call-1',
  status: 'completed',
  rawInput: {
    server: 'agentconnect-admin',
    tool: 'configureIntegration',
    arguments: { mode: 'create', provider: 'github' }
  },
  rawOutput: { result: { content: [{ type: 'text', text: JSON.stringify(ui) }], structuredContent: ui }, error: null }
}

describe('direct HTTP native UI result', () => {
  it('reads the original ACP result without a proxy or resource read', () => {
    expect(nativeUiFromToolUpdate(update)).toEqual(ui)
    expect(
      nativeUiFromToolUpdate({ ...update, rawOutput: { result: { content: update.rawOutput.result.content } } })
    ).toEqual(ui)
    expect(nativeUiFromToolUpdate({ ...update, rawOutput: update.rawOutput.result })).toEqual(ui)
  })

  it.each([{ rawOutput: JSON.stringify(ui) }, { rawOutput: [{ type: 'text', text: JSON.stringify(ui) }] }])(
    'reads Claude ACP raw content without a result envelope',
    ({ rawOutput }) => {
      expect(nativeUiFromToolUpdate({ ...update, rawOutput })).toEqual(ui)
      expect(nativeUiFromToolUpdate({ ...update, rawOutput, status: 'failed' })).toBeUndefined()
    }
  )

  it.each([
    { ...update, status: 'failed' },
    { ...update, status: 'in_progress' },
    { ...update, sessionUpdate: 'agent_message_chunk' },
    { ...update, rawOutput: 'ui://agentconnect/integration-setup' },
    { ...update, rawOutput: [{ type: 'text', text: JSON.stringify({ ...ui, resourceVersion: 2 }) }] },
    { ...update, rawOutput: [{ type: 'text', text: ' '.repeat(160 * 1024) + JSON.stringify(ui) }] },
    { ...update, rawOutput: { output: 'ui://agentconnect/integration-setup', isError: false } },
    { ...update, rawOutput: { output: JSON.stringify(ui), isError: true } },
    { ...update, rawOutput: { ...update.rawOutput, error: { message: 'cancelled' } } },
    { ...update, rawOutput: { result: { ...update.rawOutput.result, isError: true } } },
    { ...update, rawOutput: { content: [{ type: 'text', text: 'ui://agentconnect/integration-setup' }] } },
    { ...update, rawOutput: { structuredContent: { ...ui, html: '<script>bad</script>' } } },
    { ...update, rawOutput: { structuredContent: { ...ui, resourceVersion: 2 } } }
  ])('ignores failed, incomplete, or invalid results', (event) => {
    expect(nativeUiFromToolUpdate(event)).toBeUndefined()
  })

  // ACP's own `content`, captured from the dsh-acp call whose Console dialog never opened.
  it('reads the intent from ACP’s specified content channel, whatever the adapter put in rawOutput', () => {
    const content = [{ type: 'content', content: { type: 'text', text: JSON.stringify(ui) } }]
    for (const rawOutput of [undefined, { output: 'Added integration.', isError: false }, { result: {} }]) {
      expect(nativeUiFromToolUpdate({ ...update, content, rawOutput })).toEqual(ui)
    }
    // The channel is read, not trusted blindly: a failed or still-running call carries no card.
    expect(nativeUiFromToolUpdate({ ...update, content, status: 'failed' })).toBeUndefined()
    expect(nativeUiFromToolUpdate({ ...update, content, rawOutput: { output: '', isError: true } })).toBeUndefined()
    // A non-text block is not a candidate, and neither is ordinary tool prose.
    for (const bad of [
      [{ type: 'diff', path: '/a', oldText: null, newText: JSON.stringify(ui) }],
      [{ type: 'content', content: { type: 'text', text: 'Added the integration.' } }]
    ]) {
      expect(nativeUiFromToolUpdate({ ...update, content: bad, rawOutput: undefined })).toBeUndefined()
    }
  })

  // Shape captured from dsh-acp, which flattens the whole CallToolResult into one `output` string.
  it('reads a flattened `output` result, whose structured content the runtime dropped', () => {
    expect(nativeUiFromToolUpdate({ ...update, rawOutput: { output: JSON.stringify(ui), isError: false } })).toEqual(ui)
    // The same shape carrying a write tool's own record, well past a single line's worth of text.
    const nativeUi = {
      ...ui,
      resourceUri: AGENT_SETUP_URI,
      intent: { agentId: '22222222-2222-4222-8222-222222222222', created: true }
    }
    const body = { id: nativeUi.intent.agentId, name: 'my-agent', description: 'x'.repeat(8192), nativeUi }
    expect(nativeUiFromToolUpdate({ ...update, rawOutput: { output: JSON.stringify(body), isError: false } })).toEqual(
      nativeUi
    )
  })

  it('recognizes a result that meant to open a surface, so a miss can be explained', () => {
    expect(namesNativeUi(update)).toBe(true)
    // The unreadable shapes this projection used to drop in silence.
    expect(namesNativeUi({ ...update, rawOutput: { output: JSON.stringify({ ...ui, resourceVersion: 9 }) } })).toBe(
      true
    )
    expect(namesNativeUi({ ...update, rawOutput: { structuredContent: { ...ui, resourceVersion: 2 } } })).toBe(true)
    expect(namesNativeUi({ ...update, rawOutput: { structuredContent: { id: 'a', nativeUi: ui } } })).toBe(true)
    expect(namesNativeUi({ ...update, rawOutput: { output: 'listed 3 agents' } })).toBe(false)
    // A tool that merely READ a file naming the surface is not one that meant to open it — and it
    // reports that text through the very candidates scanned here, so the URI alone cannot be the signal.
    const mention = `export const INTEGRATION_SETUP_URI = '${INTEGRATION_SETUP_URI}'`
    const read = {
      ...update,
      rawOutput: undefined,
      content: [{ type: 'content', content: { type: 'text', text: mention } }]
    }
    expect(namesNativeUi(read)).toBe(false)
    expect(namesNativeUi({ ...update, rawOutput: { output: mention } })).toBe(false)
    expect(namesNativeUi({ rawInput: { tool: 'configureIntegration' } })).toBe(false)
  })

  it('treats an intent as presentation data regardless of the tool display name', () => {
    expect(nativeUiFromToolUpdate({ ...update, rawInput: { server: 'other', tool: 'other' } })).toEqual(ui)
  })

  it('reads the code-host surface and titles the card from the resource, not the arguments', () => {
    const codeHost = { ...ui, resourceUri: CODE_HOST_SETUP_URI, intent: { provider: 'gitlab' } }
    const event = { ...update, rawOutput: { structuredContent: codeHost } }
    expect(nativeUiFromToolUpdate(event)).toEqual(codeHost)
    expect(nativeUiChrome(nativeUiFromToolUpdate(event)!)).toEqual({
      title: 'Code host connections',
      toolName: 'manageCodeHosts'
    })
    expect(nativeUiChrome(nativeUiFromToolUpdate(update)!)).toEqual({
      title: 'Add integration',
      toolName: 'configureIntegration'
    })
    // The intent's own vocabulary is still closed: a provider the surface has no card for is not one.
    expect(
      nativeUiFromToolUpdate({
        ...event,
        rawOutput: { structuredContent: { ...codeHost, intent: { provider: 'svn' } } }
      })
    ).toBeUndefined()
  })

  it('titles the agent, skill, MCP and roster surfaces from the resource too', () => {
    const agentId = '22222222-2222-4222-8222-222222222222'
    for (const [intent, chrome] of [
      [
        { ...ui, resourceUri: AGENT_SETUP_URI, intent: { agentId } },
        { title: 'Edit agent', toolName: 'configureAgent' }
      ],
      [
        { ...ui, resourceUri: AGENT_SETUP_URI, intent: { agentId, created: true } },
        { title: 'Agent created', toolName: 'createAgent' }
      ],
      [
        { ...ui, resourceUri: SKILL_SETUP_URI, intent: { source: 'registry', query: 'postgres' } },
        { title: 'Install skill', toolName: 'installSkill' }
      ],
      [
        { ...ui, resourceUri: MCP_SETUP_URI, intent: {} },
        { title: 'Add MCP server', toolName: 'installMcpServer' }
      ],
      [
        { ...ui, resourceUri: AGENT_TOOLS_URI, intent: { agentId } },
        { title: 'Tools & skills', toolName: 'manageAgentTools' }
      ],
      [
        { ...ui, resourceUri: AGENT_TOOLS_URI, intent: { agentId, focus: 'skills' } },
        { title: 'Skills', toolName: 'manageAgentTools' }
      ]
    ] as const) {
      const event = { ...update, rawOutput: { structuredContent: intent } }
      expect(nativeUiFromToolUpdate(event)).toEqual(intent)
      expect(nativeUiChrome(nativeUiFromToolUpdate(event)!)).toEqual(chrome)
    }
    // A url or an html payload is not part of any intent's vocabulary.
    for (const bad of [
      { ...ui, resourceUri: AGENT_SETUP_URI, intent: { agentId: 'not-a-uuid' } },
      { ...ui, resourceUri: MCP_SETUP_URI, intent: { url: 'https://example.test' } },
      { ...ui, resourceUri: SKILL_SETUP_URI, intent: { source: 'npm' } }
    ]) {
      expect(nativeUiFromToolUpdate({ ...update, rawOutput: { structuredContent: bad } })).toBeUndefined()
    }
  })

  it('finds a write tool’s card beside its own answer, in structured content or in text', () => {
    const nativeUi = {
      ...ui,
      resourceUri: AGENT_SETUP_URI,
      intent: { agentId: '22222222-2222-4222-8222-222222222222', created: true }
    }
    const body = { id: nativeUi.intent.agentId, name: 'my-agent', nativeUi }
    expect(nativeUiFromToolUpdate({ ...update, rawOutput: { structuredContent: body } })).toEqual(nativeUi)
    expect(
      nativeUiFromToolUpdate({ ...update, rawOutput: { content: [{ type: 'text', text: JSON.stringify(body) }] } })
    ).toEqual(nativeUi)
    // Only the agreed key carries one — an arbitrary nested object is still ordinary tool output.
    expect(
      nativeUiFromToolUpdate({ ...update, rawOutput: { structuredContent: { id: body.id, extra: { nativeUi } } } })
    ).toBeUndefined()
  })

  it('accepts the default organization identifier as well as UUID organizations', () => {
    const intent = { ...ui, orgId: 'org_default00000000000000000' }
    expect(nativeUiFromToolUpdate({ ...update, rawOutput: { structuredContent: intent } })).toEqual(intent)
  })
})

function harness() {
  const output = vi.fn()
  const p = {
    plan: { sessionKey: 'session', transcriptChannel: 'conversation', statusThread: 'thread', agentId: 'agent' },
    webchat: { conversationId: 'conversation', turnId: 'turn', index: 0, sink: { output, done: vi.fn() } }
  }
  const daemon = Object.create(Daemon.prototype) as any
  daemon.clock = { now: () => 1000 }
  daemon.liveApps = new LiveAppRegistry()
  daemon.appSurface = new AppSurface({ turnFor: () => p, log: () => ({ warn: vi.fn(), debug: vi.fn() }) as any })
  const rows = new Map<string, any>()
  daemon.store = {
    upsertApp: vi.fn(async (row: any) => {
      rows.set(row.appId, row)
    }),
    getAppCard: vi.fn(async (appId: string) => rows.get(appId)),
    getSession: vi.fn(async () => ({ key: 'session' }))
  }
  daemon.log = { debug: vi.fn(), warn: vi.fn() }
  daemon.orgForAgent = vi.fn(() => ui.orgId)
  daemon.appsHost = { call: vi.fn(), resolveViewTool: vi.fn(), readResource: vi.fn() }
  daemon.webchatTransport = {
    webchatSessionKey: () => 'session',
    dispatchWebchatTurn: vi.fn(async () => ({ accepted: true, turnId: 'completion' }))
  }
  daemon.projectNativeIntegration(p, update)
  return { daemon, p, output }
}

describe('native UI projection and completion', () => {
  it('preserves the intent across disconnect and restores a native-only completion handler', async () => {
    const { daemon, p, output } = harness()
    const card = daemon.liveApps.liveIn('conversation')[0]
    daemon.expireAppCards({ conversationId: 'conversation' })
    expect(daemon.liveApps.liveIn('conversation')).toHaveLength(0)
    const stored = await daemon.store.getAppCard(card.appId)
    expect(JSON.parse(stored.body)).toMatchObject({ nativeUi: ui, server: '' })
    expect(JSON.parse(stored.body).outcome).toBeUndefined()
    expect(await daemon.reviveAppCard(card.appId, 'other-conversation', p.webchat)).toBeUndefined()
    await daemon.handleAppRpc(
      'conversation',
      card.appId,
      'tools',
      { method: 'tools/call', name: 'whoami' },
      {},
      p.webchat
    )
    expect(output.mock.calls.at(-1)?.[0].event).toMatchObject({ kind: 'app_rpc_result', outcome: { ok: false } })
    expect(daemon.appsHost.resolveViewTool).not.toHaveBeenCalled()
    await daemon.handleAppRpc(
      'conversation',
      card.appId,
      'save',
      { method: 'ui/message', text: 'Created GitHub subscription.' },
      {},
      p.webchat
    )
    expect(daemon.webchatTransport.dispatchWebchatTurn).toHaveBeenCalledTimes(1)
    const completed = JSON.parse((await daemon.store.getAppCard(card.appId)).body)
    expect(completed).toMatchObject({ nativeUi: ui, outcome: 'completed' })
    expect(await daemon.reviveAppCard(card.appId, 'conversation', p.webchat)).toBeUndefined()
  })

  it.each(['closed', 'completed', 'superseded', 'expired'])(
    'does not revive a native card settled as %s',
    async (outcome) => {
      const { daemon, p } = harness()
      const card = daemon.liveApps.liveIn('conversation')[0]
      daemon.settleAppCard(card, outcome)
      expect(await daemon.reviveAppCard(card.appId, 'conversation', p.webchat)).toBeUndefined()
    }
  )

  it('refuses revival after the owning session was purged while disconnected', async () => {
    const { daemon, p } = harness()
    const card = daemon.liveApps.liveIn('conversation')[0]
    daemon.expireAppCards({ conversationId: 'conversation' })
    daemon.store.getSession.mockResolvedValue(undefined)
    expect(await daemon.reviveAppCard(card.appId, 'conversation', p.webchat)).toBeUndefined()
  })

  it('still expires a live native card when its session ends', async () => {
    const { daemon } = harness()
    const card = daemon.liveApps.liveIn('conversation')[0]
    daemon.expireAppCards({ sessionKey: 'session' })
    expect(JSON.parse((await daemon.store.getAppCard(card.appId)).body)).toMatchObject({
      nativeUi: ui,
      outcome: 'expired'
    })
  })

  it('opens once from a completed result, without a connection or MCP capability', () => {
    const { daemon, p, output } = harness()
    daemon.projectNativeIntegration(p, update)
    expect(output).toHaveBeenCalledTimes(1)
    expect(output.mock.calls[0]?.[0].event).toMatchObject({ kind: 'app', nativeUi: ui })
    const card = daemon.liveApps.liveIn('conversation')[0]
    expect(card).toMatchObject({ native: true, server: '', agentId: 'agent' })
    expect(daemon.appsHost.call).not.toHaveBeenCalled()
    expect(reviveAppRow(card.appId, 'conversation', { ...card.row, body: JSON.stringify(card.row) })).toMatchObject({
      nativeUi: ui,
      server: ''
    })
  })

  it('does not project into a non-webchat or continuation turn', () => {
    const { daemon, p, output } = harness()
    output.mockClear()
    daemon.projectNativeIntegration({ ...p, webchat: undefined }, { ...update, toolCallId: 'other' })
    daemon.projectNativeIntegration(
      { ...p, webchat: { ...p.webchat, continuation: true } },
      { ...update, toolCallId: 'other' }
    )
    expect(output).not.toHaveBeenCalled()
  })

  it('refuses tool/resource RPCs and accepts a completion as an ordinary user message', async () => {
    const { daemon, p, output } = harness()
    const card = daemon.liveApps.liveIn('conversation')[0]
    for (const rpc of [
      { method: 'tools/call', name: 'whoami' },
      { method: 'resources/read', uri: INTEGRATION_SETUP_URI }
    ]) {
      await daemon.handleAppRpc('conversation', card.appId, 'call', rpc, {}, p.webchat)
      expect(output.mock.calls.at(-1)?.[0].event).toMatchObject({ kind: 'app_rpc_result', outcome: { ok: false } })
    }
    expect(daemon.appsHost.resolveViewTool).not.toHaveBeenCalled()
    expect(daemon.appsHost.readResource).not.toHaveBeenCalled()
    await daemon.handleAppRpc(
      'conversation',
      card.appId,
      'save',
      { method: 'ui/message', text: 'Created GitHub subscription.' },
      {},
      p.webchat
    )
    expect(daemon.webchatTransport.dispatchWebchatTurn).toHaveBeenCalledTimes(1)
    expect(output.mock.calls.at(-1)?.[0].event).toMatchObject({ kind: 'app_resolved', outcome: 'completed' })
    expect(daemon.liveApps.liveIn('conversation')).toHaveLength(0)
  })
})
