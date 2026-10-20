import { describe, expect, it, vi } from 'vitest'
import type { ComputerApprovals, ComputerLeaseAcquireResult } from '@agentconnect.md/protocol'
import { ComputerChannelError, type ComputerMcpConnection } from '../../src/computer/data-plane.js'
import {
  COMPUTER_TOOLS,
  COMPUTER_TOOL_ARGS,
  ComputerTools,
  approvalsNeeded,
  computerApprovalTitle,
  computerToolsOffered,
  describeComputerAction,
  type ComputerApprovalAnswer,
  type ComputerApprovalAsk,
  type ComputerToolsDeps
} from '../../src/computer/tools.js'
import { showsMcpImages } from '../../src/runtimes/mcp-image-content.js'
import { executeTool, type OpsDeps, type SessionContext } from '../../src/mcp/ops.js'

const AGENT = '00000000-0000-4000-8000-0000000000bb'
const C1 = '00000000-0000-4000-8000-000000000001'
const C2 = '00000000-0000-4000-8000-000000000002'
const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const IMAGE = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }

const ctx = (tools = COMPUTER_TOOLS): SessionContext => ({
  agentId: AGENT,
  platform: 'webchat',
  isDm: true,
  channel: 'c',
  thread: 't',
  deliveryThread: 't',
  tools: [...tools]
})

type CallTool = (params: { name: string; arguments?: Record<string, unknown> }, attempt: number) => Promise<unknown>

// The approval policy most tests run under: nothing asks, so they exercise forwarding alone.
const NO_APPROVALS: ComputerApprovals = { firstInputPerSession: false, launchApp: 'never-ask', submitLikeKeys: false }

function setup(
  options: {
    now?: () => number
    granted?: string[]
    lease?: ComputerLeaseAcquireResult
    callTool?: CallTool
    connectError?: (attempt: number) => Error | undefined
    approvals?: ComputerApprovals | null
    approve?: (ask: ComputerApprovalAsk) => Promise<ComputerApprovalAnswer>
  } = {}
) {
  const asks: ComputerApprovalAsk[] = []
  const metas: unknown[] = []
  const approvals = options.approvals === undefined ? NO_APPROVALS : options.approvals
  const granted = options.granted ?? [C1]
  const calls: Array<{ computer: string; name: string; args: Record<string, unknown> }> = []
  const connects: string[] = []
  const closes: string[] = []
  const closedAttempts: number[] = []
  const callTool = options.callTool ?? (async () => ({ content: [{ type: 'text', text: '{}' }, IMAGE] }))
  const leases = {
    computerLeaseAcquire: vi.fn(
      async (): Promise<ComputerLeaseAcquireResult> =>
        options.lease ?? {
          granted: true,
          lease: {
            leaseId: '00000000-0000-4000-8000-0000000000ee',
            computerId: C1,
            holder: { sessionId: 'out-1', agentId: AGENT },
            acquiredAt: new Date(T0).toISOString(),
            expiresAt: new Date(T0 + 1_800_000).toISOString()
          }
        }
    ),
    computerLeaseRelease: vi.fn(async () => undefined)
  }
  const deps: ComputerToolsDeps = {
    grants: { computerChannelGrant: vi.fn() },
    leases,
    computersFor: () => granted,
    orgFor: () => 'org_1',
    sessionIdFor: async () => 'out-1',
    now: options.now ?? (() => T0),
    approver: {
      ask: async (_ctx, ask) => {
        asks.push(ask)
        return options.approve ? await options.approve(ask) : 'allow_once'
      }
    },
    connect: async (opts) => {
      const computer = opts.target.computerId
      connects.push(computer)
      const attempt = connects.length
      expect(opts.target).toEqual({ computerId: computer, agentId: AGENT, sessionId: 'out-1', orgId: 'org_1' })
      const failed = options.connectError?.(attempt)
      if (failed) throw failed
      const conn = {
        client: {
          callTool: async (params: { name: string; arguments?: Record<string, unknown>; _meta?: unknown }) => {
            calls.push({ computer, name: params.name, args: params.arguments ?? {} })
            metas.push(params._meta)
            return await callTool(params, attempt)
          }
        },
        channel: {
          grant: async () => ({
            granted: true,
            name: 'Desk',
            ownerUserId: 'user_owner',
            ...(approvals ? { approvals } : {})
          })
        },
        close: async () => {
          closes.push(computer)
          closedAttempts.push(attempt)
        }
      }
      return conn as unknown as ComputerMcpConnection
    }
  }
  return { tools: new ComputerTools(deps), calls, connects, closes, closedAttempts, leases, asks, metas }
}

const parse = (result: { mcpContent: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.mcpContent.find((block) => block.type === 'text')!.text!) as Record<string, unknown>

describe('computerToolsOffered', () => {
  const on = { enabled: true, computers: [C1] }
  it('offers the tools only when enabled, with a Computer, a serving CP and an image-capable runtime', () => {
    expect(computerToolsOffered({ computerUse: on, controlPlaneServes: true, runtimeShowsImages: true })).toBe(true)
    expect(computerToolsOffered({ computerUse: undefined, controlPlaneServes: true, runtimeShowsImages: true })).toBe(
      false
    )
    expect(
      computerToolsOffered({
        computerUse: { enabled: false, computers: [C1] },
        controlPlaneServes: true,
        runtimeShowsImages: true
      })
    ).toBe(false)
    expect(
      computerToolsOffered({
        computerUse: { enabled: true, computers: [] },
        controlPlaneServes: true,
        runtimeShowsImages: true
      })
    ).toBe(false)
    expect(computerToolsOffered({ computerUse: on, controlPlaneServes: false, runtimeShowsImages: true })).toBe(false)
    expect(computerToolsOffered({ computerUse: on, controlPlaneServes: true, runtimeShowsImages: false })).toBe(false)
  })

  it('knows which runtimes show the model MCP images, and lets a runtime definition say so', () => {
    expect(showsMcpImages('claude-acp')).toBe(true)
    expect(showsMcpImages('codex-acp')).toBe(true)
    expect(showsMcpImages('openclaw')).toBe(false)
    expect(showsMcpImages('my-runtime', { mcpImageContent: true })).toBe(true)
    expect(showsMcpImages('claude-acp', { mcpImageContent: false })).toBe(false)
  })

  it('advertises an argument schema for every tool it validates', () => {
    expect(COMPUTER_TOOLS.map((tool) => tool.name).sort()).toEqual([...COMPUTER_TOOL_ARGS.keys()].sort())
    for (const tool of COMPUTER_TOOLS) {
      if (tool.name === 'computer_list') continue
      expect(tool.inputSchema).toMatchObject({ properties: { computer: { type: 'string' } } })
    }
  })
})

describe('ComputerTools', () => {
  it('ignores tools that are not its own and refuses a computer tool the session was not offered', async () => {
    const { tools, calls } = setup()
    expect(await tools.call(ctx(), 'sendMessage', {})).toBeUndefined()
    await expect(tools.call(ctx([]), 'computer_screenshot', {})).rejects.toThrow('unknown tool: computer_screenshot')
    expect(calls).toEqual([])
  })

  it('forwards a screenshot to the only granted Computer with its image content, without a lease', async () => {
    const { tools, calls, leases } = setup()
    const handled = await tools.call(ctx(), 'computer_screenshot', {})
    expect(handled?.result.mcpContent).toEqual([{ type: 'text', text: '{}' }, IMAGE])
    expect(handled?.result.mcpIsError).toBeUndefined()
    expect(calls).toEqual([{ computer: C1, name: 'computer_screenshot', args: {} }])
    expect(leases.computerLeaseAcquire).not.toHaveBeenCalled()
  })

  it('takes the control lease before an input and forwards it without the `computer` argument', async () => {
    const { tools, calls, leases } = setup({ granted: [C1, C2] })
    await tools.call(ctx(), 'computer_click', { computer: C1, x: 10, y: 20 })
    expect(leases.computerLeaseAcquire).toHaveBeenCalledWith(
      { computerId: C1, agentId: AGENT, sessionId: 'out-1', requestedAt: new Date(T0).toISOString() },
      'org_1'
    )
    expect(calls).toEqual([{ computer: C1, name: 'computer_click', args: { x: 10, y: 20 } }])
    // The held Computer is now the default target, though two are granted.
    await tools.call(ctx(), 'computer_screenshot', {})
    expect(calls[1]).toEqual({ computer: C1, name: 'computer_screenshot', args: {} })
  })

  it('fails with computer_ambiguous before any input when several Computers are granted and none is held', async () => {
    const { tools, calls, leases } = setup({ granted: [C1, C2] })
    const handled = await tools.call(ctx(), 'computer_type', { text: 'hello' })
    expect(handled?.result.mcpIsError).toBe(true)
    expect(parse(handled!.result)).toMatchObject({ error: 'computer_ambiguous', candidates: [C1, C2] })
    expect(calls).toEqual([])
    expect(leases.computerLeaseAcquire).not.toHaveBeenCalled()
  })

  it('refuses a Computer the agent was not granted', async () => {
    const { tools, calls } = setup()
    const handled = await tools.call(ctx(), 'computer_screenshot', { computer: C2 })
    expect(parse(handled!.result)).toMatchObject({ error: 'denied' })
    expect(calls).toEqual([])
  })

  it("returns the CP's lease refusal as a definite error naming the holder, and sends nothing", async () => {
    const { tools, calls } = setup({
      lease: {
        granted: false,
        code: 'computer_busy',
        message: 'computer is controlled by Ops',
        holder: { sessionId: 'other', agentId: AGENT, agentName: 'Ops' }
      }
    })
    const handled = await tools.call(ctx(), 'computer_key', { keys: ['ctrl', 'l'] })
    expect(handled?.result.mcpIsError).toBe(true)
    expect(parse(handled!.result)).toMatchObject({ error: 'computer_busy', holder: 'Ops', holderSessionId: 'other' })
    expect(calls).toEqual([])
  })

  it('rejects invalid arguments before acquiring or forwarding', async () => {
    const { tools, calls, leases } = setup()
    const handled = await tools.call(ctx(), 'computer_click', { x: -1, y: 'a' })
    expect(parse(handled!.result)).toMatchObject({ error: 'invalid_argument' })
    expect(calls).toEqual([])
    expect(leases.computerLeaseAcquire).not.toHaveBeenCalled()
  })

  it('reports an input whose outcome is unknown as uncertain with a fresh screenshot, never replaying it', async () => {
    const { tools, calls, connects, closes } = setup({
      callTool: async (params) => {
        if (params.name === 'computer_click') throw new Error('request timed out')
        return { content: [IMAGE] }
      }
    })
    const handled = await tools.call(ctx(), 'computer_click', { x: 1, y: 2 })
    expect(handled?.result.mcpIsError).toBe(true)
    expect(parse(handled!.result)).toMatchObject({ error: 'uncertain' })
    expect(handled?.result.mcpContent).toContainEqual(IMAGE)
    expect(calls.map((call) => call.name)).toEqual(['computer_click', 'computer_screenshot'])
    // The failed connection was replaced, not reused.
    expect(connects).toEqual([C1, C1])
    expect(closes).toEqual([C1])
  })

  it('reports a channel refusal as a definite unavailable error, not uncertain', async () => {
    const { tools, calls } = setup({
      callTool: async () => {
        throw new ComputerChannelError('not_attached', 'no relay has this computer attached; it may be offline')
      }
    })
    const handled = await tools.call(ctx(), 'computer_click', { x: 1, y: 2 })
    expect(parse(handled!.result)).toMatchObject({ error: 'unavailable' })
    expect(calls.map((call) => call.name)).toEqual(['computer_click'])
  })

  it('reports a connection that fails before the input is sent as a definite unavailable error', async () => {
    const { tools, calls, connects } = setup({ connectError: () => new Error('relay answered initialize with 502') })
    const handled = await tools.call(ctx(), 'computer_click', { x: 1, y: 2 })
    expect(handled?.result.mcpIsError).toBe(true)
    expect(parse(handled!.result)).toMatchObject({ error: 'unavailable' })
    expect(parse(handled!.result).message).toContain('relay answered initialize with 502')
    expect(calls).toEqual([])
    expect(connects).toEqual([C1])
  })

  it('drops only the connection a failed call used, never a newer one', async () => {
    const gates: Array<(error?: Error) => void> = []
    const { tools, connects, closedAttempts } = setup({
      callTool: async (params, attempt) => {
        if (attempt > 2 || params.name !== 'computer_wait') return { content: [IMAGE] }
        await new Promise<void>((resolve, reject) => gates.push((error) => (error ? reject(error) : resolve())))
        return { content: [IMAGE] }
      }
    })
    const first = tools.call(ctx(), 'computer_wait', { ms: 0 })
    const second = tools.call(ctx(), 'computer_wait', { ms: 0 })
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1]!(new Error('lost'))
    await expect(second).rejects.toThrow('lost')
    const third = tools.call(ctx(), 'computer_wait', { ms: 0 })
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    gates[0]!(new Error('lost too'))
    await expect(first).rejects.toThrow('lost too')
    gates[2]!()
    await third
    // The second connection survives the first call's late failure and is reused.
    await tools.call(ctx(), 'computer_screenshot', {})
    expect(connects).toEqual([C1, C1])
    expect(closedAttempts).toEqual([1, 1])
    await tools.close()
    expect(closedAttempts).toEqual([1, 1, 2])
  })

  it('passes a desktop error through as an error result', async () => {
    const busy = { content: [{ type: 'text', text: '{"error":"human_active","message":"someone is using it"}' }] }
    const { tools } = setup({ callTool: async () => ({ ...busy, isError: true }) })
    const handled = await tools.call(ctx(), 'computer_scroll', { x: 1, y: 2, direction: 'down' })
    expect(handled?.result).toEqual({ mcpContent: busy.content, mcpIsError: true })
  })

  it('lists every granted Computer, marking one it cannot reach unavailable', async () => {
    const { tools } = setup({
      granted: [C1, C2],
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify([{ os: 'linux', status: 'online' }]) }] })
    })
    const original = tools['linked'].bind(tools)
    vi.spyOn(tools as unknown as { linked: typeof original }, 'linked').mockImplementation(async (state, computer) => {
      if (computer === C2) throw new ComputerChannelError('unavailable', 'the computer is offline')
      return await original(state, computer)
    })
    const handled = await tools.call(ctx(), 'computer_list', {})
    expect(JSON.parse((handled!.result.mcpContent[0] as { text: string }).text)).toEqual([
      { computer: C1, os: 'linux', status: 'online', heldBySession: false },
      { computer: C2, status: 'unavailable', error: 'the computer is offline', heldBySession: false }
    ])
  })

  it('releases on the desktop and the CP, and forgets the held target', async () => {
    const { tools, calls, leases } = setup({
      granted: [C1, C2],
      callTool: async (params) => ({
        content: [{ type: 'text', text: params.name === 'computer_release' ? '{"released":true}' : '{}' }]
      })
    })
    await tools.call(ctx(), 'computer_acquire', { computer: C2 })
    expect(calls.map((call) => call.name)).toEqual(['computer_acquire'])
    const handled = await tools.call(ctx(), 'computer_release', {})
    expect(parse(handled!.result)).toEqual({ computer: C2, released: true, desktop: true })
    expect(leases.computerLeaseRelease).toHaveBeenCalledWith(
      { computerId: C2, agentId: AGENT, sessionId: 'out-1' },
      'org_1'
    )
    const after = await tools.call(ctx(), 'computer_screenshot', {})
    expect(parse(after!.result)).toMatchObject({ error: 'computer_ambiguous' })
  })

  it('closes an idle connection on its timer, without another computer call', async () => {
    vi.useFakeTimers()
    try {
      let now = T0
      const { tools, closes } = setup({ now: () => now })
      await tools.call(ctx(), 'computer_screenshot', {})
      now += 11 * 60_000
      await vi.advanceTimersByTimeAsync(60_000)
      expect(closes).toEqual([C1])
      await tools.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is reached through executeTool and closes its connections on shutdown', async () => {
    const { tools, closes } = setup()
    const deps = { computerTool: (c, name, args) => tools.call(c, name, args) } as Partial<OpsDeps> as OpsDeps
    const result = await executeTool(ctx(), 'computer_screenshot', {}, deps)
    expect(result).toEqual({ mcpContent: [{ type: 'text', text: '{}' }, IMAGE] })
    await tools.close()
    expect(closes).toEqual([C1])
  })
})

describe('computer approvals', () => {
  const ASK_ALL: ComputerApprovals = { firstInputPerSession: true, launchApp: 'always', submitLikeKeys: true }

  it('asks for the first input of a session, app launches and submit-like keys, not for moves or scrolls', () => {
    expect(approvalsNeeded('computer_click', { x: 1, y: 1 }, ASK_ALL)).toEqual(['first_input'])
    expect(approvalsNeeded('computer_move', { x: 1, y: 1 }, ASK_ALL)).toEqual([])
    expect(approvalsNeeded('computer_scroll', { x: 1, y: 1, direction: 'down' }, ASK_ALL)).toEqual([])
    expect(approvalsNeeded('computer_launch', { app: 'firefox' }, ASK_ALL)).toEqual(['first_input', 'launch_app'])
    const typed = { input: true, session: new Set<never>() }
    expect(approvalsNeeded('computer_key', { keys: ['Return'] }, ASK_ALL, typed)).toEqual(['submit'])
    expect(approvalsNeeded('computer_key', { keys: ['ctrl', 'enter'] }, ASK_ALL, typed)).toEqual(['submit'])
    expect(approvalsNeeded('computer_type', { text: 'hi\n' }, ASK_ALL, typed)).toEqual(['submit'])
    expect(approvalsNeeded('computer_type', { text: 'hi' }, ASK_ALL, typed)).toEqual([])
    expect(approvalsNeeded('computer_launch', { app: 'x' }, { ...ASK_ALL, launchApp: 'never-ask' }, typed)).toEqual([])
  })

  it('describes an action without the text it types', () => {
    expect(describeComputerAction('computer_type', { text: 'p4ss\n' })).toBe('type 5 characters, including Enter')
    expect(describeComputerAction('computer_click', { x: 3, y: 4, count: 2, button: 'right' })).toBe(
      'right double-click at (3, 4)'
    )
    const title = computerApprovalTitle({
      computerId: C1,
      computerName: 'Desk',
      tool: 'computer_type',
      action: describeComputerAction('computer_type', { text: 'p4ss\n' }),
      reasons: ['first_input', 'submit']
    })
    expect(title).toBe(
      'Computer use on “Desk”: type 5 characters, including Enter (first input this session; presses Enter)'
    )
    expect(title).not.toContain('p4ss')
  })

  it('asks once for the first input, names the owner, and tells the desktop how each call was approved', async () => {
    const { tools, asks, metas, leases } = setup({ approvals: ASK_ALL })
    await tools.call(ctx(), 'computer_click', { x: 10, y: 20 })
    expect(asks).toEqual([
      {
        computerId: C1,
        computerName: 'Desk',
        ownerUserId: 'user_owner',
        tool: 'computer_click',
        action: 'click at (10, 20)',
        reasons: ['first_input']
      }
    ])
    await tools.call(ctx(), 'computer_click', { x: 11, y: 20 })
    await tools.call(ctx(), 'computer_screenshot', {})
    expect(asks).toHaveLength(1)
    expect(metas).toEqual([
      { 'md.agentconnect/approval': 'allowed' },
      { 'md.agentconnect/approval': 'allowed_session' },
      undefined
    ])
    expect(leases.computerLeaseAcquire).toHaveBeenCalledTimes(2)
  })

  it('refuses a denied input with approval_denied before taking the lease, and asks again next time', async () => {
    const { tools, asks, calls, leases } = setup({ approvals: ASK_ALL, approve: async () => 'deny' })
    const handled = await tools.call(ctx(), 'computer_type', { text: 'secret' })
    expect(handled?.result.mcpIsError).toBe(true)
    expect(parse(handled!.result)).toMatchObject({ error: 'approval_denied', computer: C1 })
    expect(calls).toEqual([])
    expect(leases.computerLeaseAcquire).not.toHaveBeenCalled()
    await tools.call(ctx(), 'computer_type', { text: 'secret' })
    expect(asks).toHaveLength(2)
  })

  it('remembers "allow for this session" per reason, and asks for every launch under `always` otherwise', async () => {
    const answers: ComputerApprovalAnswer[] = ['allow_once', 'allow_once', 'allow_session']
    const { tools, asks } = setup({ approvals: ASK_ALL, approve: async () => answers.shift() ?? 'deny' })
    await tools.call(ctx(), 'computer_launch', { app: 'firefox' })
    await tools.call(ctx(), 'computer_launch', { app: 'firefox' })
    expect(asks.map((ask) => ask.reasons)).toEqual([['first_input', 'launch_app'], ['launch_app']])
    await tools.call(ctx(), 'computer_key', { keys: ['return'] })
    await tools.call(ctx(), 'computer_key', { keys: ['return'] })
    expect(asks.map((ask) => ask.reasons)).toEqual([['first_input', 'launch_app'], ['launch_app'], ['submit']])
  })

  it('shares one answer between parallel inputs', async () => {
    let answer!: (value: ComputerApprovalAnswer) => void
    const { tools, asks } = setup({
      approvals: ASK_ALL,
      approve: () => new Promise<ComputerApprovalAnswer>((resolve) => (answer = resolve))
    })
    const first = tools.call(ctx(), 'computer_click', { x: 1, y: 1 })
    const second = tools.call(ctx(), 'computer_click', { x: 2, y: 2 })
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    answer('allow_once')
    await Promise.all([first, second])
    expect(asks).toHaveLength(1)
  })

  it('asks for everything when the Control Plane sends no policy', async () => {
    const { tools, asks } = setup({ approvals: null })
    await tools.call(ctx(), 'computer_key', { keys: ['return'] })
    expect(asks[0]?.reasons).toEqual(['first_input', 'submit'])
  })
})
