// Which sessions a running daemon offers the computer_* tools and their guidance (computer-use.md §5.2).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { COMPUTER_CHANNEL_FEATURE, COMPUTER_LEASE_FEATURE, agentComputerUseOf } from '@agentconnect.md/protocol'
import { COMPUTER_TOOLS, COMPUTER_USE_GUIDANCE } from '../src/computer/tools.js'
import { Daemon } from '../src/daemon.js'
import { checkCoordinate, gettingToKnowCoordinate, researchCoordinate } from '../src/session/subsession-coordinate.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const COMPUTER_NAMES = COMPUTER_TOOLS.map((tool) => tool.name)

function scaffold(runtimes: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-computer-d-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: Object.fromEntries(runtimes.map((id) => [id, { command: 'node', args: ['unused'] }]))
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: runtimes[0],
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(features: readonly string[], runtimes = ['claude-acp', 'openclaw']) {
  const hostFactory = () =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }) as never
  const daemon = new Daemon({ root: scaffold(runtimes), hostFactory })
  await daemon.start()
  const d = daemon as any
  const answers: Record<string | symbol, unknown> = {
    supportsServerFeature: (feature: string) => features.includes(feature)
  }
  d.cpClient = new Proxy(answers, { get: (target, name) => (name in target ? target[name] : () => undefined) })
  const agent = d.agents.get('bot-a')
  agent.computerUse = { enabled: true, computers: [COMPUTER] }
  const context = (thread = 'append:1') => {
    const result = d.sessions.deps.toolContextFor({
      agent,
      platform: 'webchat',
      channel: 'c1',
      thread,
      deliveryThread: thread,
      integrationId: undefined,
      isDm: true,
      sessionKey: `webchat:c1:${thread}:bot-a`
    }) as { tools?: Array<{ name: string }>; instructions?: string }
    const names = (result.tools ?? []).map((tool) => tool.name)
    return { names, computers: names.filter((name) => name.startsWith('computer_')), instructions: result.instructions }
  }
  return { daemon, agent, context }
}

const BOTH = [COMPUTER_LEASE_FEATURE, COMPUTER_CHANNEL_FEATURE]

describe('toolContextFor and computer use', () => {
  it('offers the tools and the guidance to an ordinary session of an enabled agent', async () => {
    const { daemon, context } = await boot(BOTH)
    try {
      const ordinary = context()
      expect(ordinary.computers).toEqual(COMPUTER_NAMES)
      expect(ordinary.instructions).toContain(COMPUTER_USE_GUIDANCE)
    } finally {
      await daemon.stop()
    }
  })

  it('offers neither to a check, research or getting-to-know session', async () => {
    const { daemon, context } = await boot(BOTH)
    try {
      for (const thread of [checkCoordinate('7'), researchCoordinate('7'), gettingToKnowCoordinate('7')]) {
        const narrowed = context(thread)
        expect(narrowed.computers, thread).toEqual([])
        expect(narrowed.instructions ?? '', thread).not.toContain('# Computer use')
      }
    } finally {
      await daemon.stop()
    }
  })

  it('offers neither when the Control Plane lacks a computer feature, the agent turned it off, or the runtime cannot show images', async () => {
    for (const features of [[COMPUTER_LEASE_FEATURE], [COMPUTER_CHANNEL_FEATURE], []]) {
      const { daemon, context } = await boot(features)
      try {
        const missing = context()
        expect(missing.computers, features.join()).toEqual([])
        expect(missing.instructions ?? '').not.toContain('# Computer use')
      } finally {
        await daemon.stop()
      }
    }
    const { daemon, agent, context } = await boot(BOTH)
    try {
      agent.computerUse = { enabled: false, computers: [COMPUTER] }
      expect(context().computers).toEqual([])
      agent.computerUse = { enabled: true, computers: [COMPUTER] }
      agent.runtime = 'openclaw'
      const imageless = context()
      expect(imageless.computers).toEqual([])
      expect(imageless.instructions ?? '').not.toContain('# Computer use')
    } finally {
      await daemon.stop()
    }
  })

  it('follows the Computer list the Control Plane derives from each Computer’s agent access', async () => {
    const { daemon, agent, context } = await boot(BOTH)
    try {
      // Access given on the Computer arrives as the derived spec value; the agent itself sets nothing.
      agent.computerUse = agentComputerUseOf(undefined, [COMPUTER]) ?? undefined
      expect(context().computers).toEqual(COMPUTER_NAMES)
      // The last Computer taken away ships null, which clears it.
      agent.computerUse = agentComputerUseOf(undefined, []) ?? undefined
      expect(context().computers).toEqual([])
      expect(context().instructions ?? '').not.toContain('# Computer use')
    } finally {
      await daemon.stop()
    }
  })

  it('offers neither once the MCP tool server is unreachable', async () => {
    const { daemon, context } = await boot(BOTH)
    try {
      ;(daemon as any).mcpToolServerReachable = () => false
      const unreachable = context()
      expect(unreachable.names).toEqual([])
      expect(unreachable.instructions ?? '').not.toContain('# Computer use')
    } finally {
      await daemon.stop()
    }
  })
})

describe('computer-use approvals on the daemon (computer-use.md §4.2)', () => {
  const ask = {
    computerId: COMPUTER,
    computerName: 'Desk',
    ownerUserId: 'user_owner',
    tool: 'computer_type',
    action: 'type 6 characters',
    reasons: ['first_input' as const]
  }
  const sessionContext = {
    agentId: 'bot-a',
    platform: 'webchat',
    isDm: true,
    channel: 'c1',
    thread: 'append:1',
    deliveryThread: 'append:1',
    tools: []
  }

  it('refuses an approval no live turn can answer', async () => {
    const { daemon } = await boot(BOTH)
    try {
      expect(await (daemon as any).askComputerApproval(sessionContext, ask)).toBe('deny')
    } finally {
      await daemon.stop()
    }
  })

  it("asks on the session's live turn with the Computer's owner and reads back the person's choice", async () => {
    const { daemon } = await boot(BOTH)
    const d = daemon as any
    try {
      const live = { plan: { sessionKey: 'webchat:c1:append:1:bot-a' }, acpSessionId: 'acp-9', hostKey: 'bot-a' }
      d.pending.set('k', live)
      const asked = vi.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'allow_session' } }))
      d.permissions.askComputerApproval = asked
      expect(await d.askComputerApproval(sessionContext, ask)).toBe('allow_session')
      const [turn, params, owner] = asked.mock.calls[0] as unknown as [unknown, any, string]
      expect(turn).toBe(live)
      expect(owner).toBe('user_owner')
      expect(params.sessionId).toBe('acp-9')
      expect(params.toolCall.title).toBe('Computer use on “Desk”: type 6 characters (first input this session)')
      expect(params.options.map((option: { kind: string }) => option.kind)).toEqual([
        'allow_once',
        'allow_always',
        'reject_once'
      ])
      asked.mockResolvedValueOnce({ outcome: { outcome: 'cancelled' } } as never)
      expect(await d.askComputerApproval(sessionContext, ask)).toBe('deny')
    } finally {
      d.pending.delete('k')
      await daemon.stop()
    }
  })
})
