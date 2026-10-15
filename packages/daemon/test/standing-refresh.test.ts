import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SessionManager } from '../src/session/session-manager.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import type { Agent } from '../src/agents/agent-schema.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// session-concept.md §2.3: a resumed session whose runtime keeps the standing context it started with gets the current one inline once.
const REFRESH_HEADING = '[Standing instructions updated]'
const MEMORY_CATALOG = '\n\nMemory catalog observed'
const KEY = sessionKey('slack', 'C1', '100.1', 'bot-a')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** The recorded digest leaves out the session's own id, which the turn that opens a session does not have yet. */
const digestOf = (text: string): string => sha256(text.replace(/^- Session: .*\n/m, ''))

/** One agent per test, so no other test's memory writes reach its standing context. */
function testAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-standing-root-'))
  const workspace = join(mkdtempSync(join(tmpdir(), 'ac-standing-ws-')), 'ws')
  const memory = createManagedMemoryProvider(() => localMemoryHome(new LocalMemoryFs(dir)))
  const described = (description: string) =>
    ({
      id: 'bot-a',
      name: 'bot-a',
      description,
      status: 'active',
      runtime: 'test-runtime',
      dir,
      env: {},
      workspace: { mode: 'from-scratch', path: workspace, gitBranch: 'main', pullOnNewSession: true, skills: [] },
      integrations: [],
      output: { mode: 'medium' },
      permissions: { policy: 'ask', autoApprove: [] },
      crons: []
    }) as unknown as Agent & { dir: string; env: Record<string, string> }
  return { memory, described }
}

/** A runtime process: `inline` takes standing context in the prompt, `instructions` natively when a thread starts, `claude` natively on every `session/load` too. */
function runtime(kind: 'inline' | 'instructions' | 'claude') {
  const live = new Set<string>()
  return {
    newSession: vi.fn(async () => {
      live.add('acp-1')
      return 'acp-1'
    }),
    loadSession: vi.fn(async (id: string) => {
      live.add(id)
    }),
    hasSession: (id: string) => live.has(id),
    loadSupported: () => true,
    ...(kind === 'inline' ? {} : { usesMetaSystemPrompt: () => true }),
    ...(kind === 'claude' ? { appliesSystemPromptOnLoad: () => true } : {})
  } as any
}

const msg = (ts: string, text: string): NormalizedMessage => ({
  msgId: `slack:C1:${ts}`,
  traceId: 't',
  source: 'user',
  platform: 'slack',
  channel: 'C1',
  thread: '100.1',
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [],
  isDm: false
})

const texts = (blocks: any[]): string[] => blocks.filter((b) => b.type === 'text').map((b) => b.text as string)
const refreshes = (blocks: any[]): string[] => texts(blocks).filter((t) => t.startsWith(REFRESH_HEADING))
/** The standing context a refresh block carries, below its heading line. */
const refreshed = (block: string): string => block.slice(block.indexOf('\n\n') + 2)

async function newStore() {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-standing-')), 'db.sqlite'))
}

/** A turn whose prompt the runtime answered: the daemon then records the standing context it carried inline. */
async function delivered(sm: SessionManager, ts: string, text: string) {
  const turn = await sm.handle('bot-a', msg(ts, text))
  if (turn.standingDigest !== undefined) await sm.standingDelivered(KEY, turn.standingDigest)
  return turn
}

describe('standing context on a resumed session', () => {
  it('refreshes an inline runtime once, on the first prompt after a load, when the context changed', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const before = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('Old description.'),
      memory
    })
    const first = await delivered(before, '100.1', 'first')
    const opening = texts(first.blocks)[0]!
    expect(opening).toMatch(/^# Agent/)
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(opening))

    // A restart: a new process loads the session, and the agent's description has changed meanwhile.
    const host = runtime('inline')
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => described('New description.'),
      memory
    })
    const second = await delivered(after, '100.2', 'second')
    expect(host.loadSession).toHaveBeenCalledOnce()
    const blocks = refreshes(second.blocks)
    expect(blocks).toHaveLength(1)
    expect(texts(second.blocks)[0]).toBe(blocks[0])
    expect(blocks[0]).toContain('New description.')
    expect(blocks[0]).not.toContain('Old description.')
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(refreshed(blocks[0]!)))

    // The next prompt on the same process carries nothing more.
    const third = await delivered(after, '100.3', 'third')
    expect(host.loadSession).toHaveBeenCalledOnce()
    expect(refreshes(third.blocks)).toEqual([])
    expect(texts(third.blocks).some((t) => t.includes('# Agent'))).toBe(false)
    await store.close()
  })

  it('adds nothing after a load when the standing context is unchanged', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const agent = described('Same description.')
    const before = new SessionManager({ store, hostFor: async () => runtime('inline'), agentById: () => agent, memory })
    await delivered(before, '100.1', 'first')
    const recorded = (await store.getSession(KEY))?.standingDigest

    const host = runtime('inline')
    const after = new SessionManager({ store, hostFor: async () => host, agentById: () => agent, memory })
    const second = await delivered(after, '100.2', 'second')
    expect(host.loadSession).toHaveBeenCalledOnce()
    expect(second.standingDigest).toBeUndefined()
    expect(refreshes(second.blocks)).toEqual([])
    expect(texts(second.blocks).some((t) => t.includes('# Agent'))).toBe(false)
    expect((await store.getSession(KEY))?.standingDigest).toBe(recorded)
    await store.close()
  })

  it('treats a runtime whose native instructions apply only at thread start like an inline one', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const opener = runtime('instructions')
    const before = new SessionManager({
      store,
      hostFor: async () => opener,
      agentById: () => described('Old description.'),
      memory
    })
    // session/new delivered the instructions, so the digest is recorded with no prompt to wait for.
    const first = await before.handle('bot-a', msg('100.1', 'first'))
    expect(first.standingDigest).toBeUndefined()
    // The digest covers the standing context, not the memory catalog appended beside it.
    const instructions = opener.newSession.mock.calls[0][3] as string
    expect(instructions).toContain(MEMORY_CATALOG)
    expect(instructions).not.toContain('- Session:')
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(instructions.split(MEMORY_CATALOG)[0]!))

    // Nothing changed: a load re-sends the instructions natively and the prompt adds nothing.
    const unchanged = runtime('instructions')
    const same = new SessionManager({
      store,
      hostFor: async () => unchanged,
      agentById: () => described('Old description.'),
      memory
    })
    const second = await delivered(same, '100.2', 'second')
    expect(unchanged.loadSession).toHaveBeenCalledOnce()
    // The resumed copy names the session, which the opening could not; that alone is no change.
    const outward = (await store.getSession(KEY))?.sessionId
    expect(unchanged.loadSession.mock.calls[0][4]).toContain(`- Session: ${outward}`)
    expect(refreshes(second.blocks)).toEqual([])

    // Changed: the load still re-sends them, and the first prompt carries the current ones once.
    const host = runtime('instructions')
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => described('New description.'),
      memory
    })
    const third = await delivered(after, '100.3', 'third')
    expect(host.loadSession).toHaveBeenCalledOnce()
    expect(host.loadSession.mock.calls[0][4]).toContain('New description.')
    const blocks = refreshes(third.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('New description.')
    expect(blocks[0]).not.toContain(MEMORY_CATALOG)
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(refreshed(blocks[0]!)))
    expect(refreshes((await delivered(after, '100.4', 'fourth')).blocks)).toEqual([])
    await store.close()
  })

  it('adds no block where a load applies the instructions natively, and records what the load carried', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const before = new SessionManager({
      store,
      hostFor: async () => runtime('claude'),
      agentById: () => described('Old description.'),
      memory
    })
    await delivered(before, '100.1', 'first')
    const opened = (await store.getSession(KEY))?.standingDigest
    expect(opened).toEqual(expect.any(String))

    const host = runtime('claude')
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => described('New description.'),
      memory
    })
    const second = await after.handle('bot-a', msg('100.2', 'second'))
    expect(host.loadSession).toHaveBeenCalledOnce()
    const resumed = host.loadSession.mock.calls[0][4] as string
    expect(resumed).toContain('New description.')
    expect(second.standingDigest).toBeUndefined()
    expect(refreshes(second.blocks)).toEqual([])
    expect(texts(second.blocks).some((t) => t.includes('# Agent'))).toBe(false)
    const digest = (await store.getSession(KEY))?.standingDigest
    expect(digest).not.toBe(opened)
    expect(digest).toBe(digestOf(resumed.split(MEMORY_CATALOG)[0]!))
    await store.close()
  })

  it('leaves a warm session alone when its standing context changes while the runtime stays up', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    let description = 'Old description.'
    const host = runtime('inline')
    const sm = new SessionManager({ store, hostFor: async () => host, agentById: () => described(description), memory })
    await delivered(sm, '100.1', 'first')
    description = 'New description.'
    const second = await delivered(sm, '100.2', 'second')
    expect(host.loadSession).not.toHaveBeenCalled()
    expect(refreshes(second.blocks)).toEqual([])
    await store.close()
  })

  it('carries the refresh to the first prompt when the turn that loaded the session sent none', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const before = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('Old description.'),
      memory
    })
    await delivered(before, '100.1', 'first')

    const host = runtime('inline')
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => described('New description.'),
      memory
    })
    // A redelivered message the session already had loads it and prompts nothing.
    const redelivered = await after.handle('bot-a', msg('100.1', 'first'))
    expect(redelivered.skipped).toBe(true)
    expect(host.loadSession).toHaveBeenCalledOnce()
    const next = await delivered(after, '100.2', 'second')
    expect(refreshes(next.blocks)).toHaveLength(1)
    expect(refreshes(next.blocks)[0]).toContain('New description.')
    await store.close()
  })

  it('records an inline copy only once the runtime takes the prompt that carries it', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const sm = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('Same description.'),
      memory
    })
    const first = await sm.handle('bot-a', msg('100.1', 'first'))
    expect(first.standingDigest).toBe(digestOf(texts(first.blocks)[0]!))
    expect((await store.getSession(KEY))?.standingDigest).toBeNull()
    await sm.standingDelivered(KEY, first.standingDigest!)
    expect((await store.getSession(KEY))?.standingDigest).toBe(first.standingDigest)
    await store.close()
  })

  it('keeps a refresh due until a prompt carrying it is delivered', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const before = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('Old description.'),
      memory
    })
    await delivered(before, '100.1', 'first')
    const old = (await store.getSession(KEY))?.standingDigest

    const after = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('New description.'),
      memory
    })
    // The prepared turn never reaches the runtime: paused, cancelled, or its prompt rejected.
    const dropped = await after.handle('bot-a', msg('100.2', 'second'))
    expect(refreshes(dropped.blocks)).toHaveLength(1)
    expect((await store.getSession(KEY))?.standingDigest).toBe(old)

    const next = await delivered(after, '100.3', 'third')
    expect(refreshes(next.blocks)).toHaveLength(1)
    expect(refreshes(next.blocks)[0]).toContain('New description.')
    expect((await store.getSession(KEY))?.standingDigest).toBe(next.standingDigest)
    expect(refreshes((await delivered(after, '100.4', 'fourth')).blocks)).toEqual([])
    await store.close()
  })

  it('hands a new inline session its standing context on the next prompt when the opening never reached it', async () => {
    const store = await newStore()
    const { memory, described } = testAgent()
    const sm = new SessionManager({
      store,
      hostFor: async () => runtime('inline'),
      agentById: () => described('Same description.'),
      memory
    })
    const opening = await sm.handle('bot-a', msg('100.1', 'first'))
    expect(texts(opening.blocks)[0]).toMatch(/^# Agent/)
    const next = await delivered(sm, '100.2', 'second')
    expect(refreshes(next.blocks)).toHaveLength(1)
    expect(next.standingDigest).toBe(opening.standingDigest)
    expect(refreshes((await delivered(sm, '100.3', 'third')).blocks)).toEqual([])
    await store.close()
  })
})

const CONVERSATION = '11111111-1111-4111-8111-111111111111'

/** A daemon home with one agent on an inline runtime the host factory stands in for. */
function daemonRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-standing-daemon-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { stub: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      description: 'New description.',
      status: 'active',
      runtime: 'stub',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('a daemon delivering a resumed session’s standing context', () => {
  it('records it only after the runtime answers the prompt, and re-sends it when the first turn is cancelled first', async () => {
    let releaseModel!: () => void
    const modelHeld = new Promise<void>((resolve) => (releaseModel = resolve))
    const live = new Set<string>()
    const prompts: { blocks: any[]; digest: string | null | undefined }[] = []
    const holder: { daemon?: Daemon } = {}
    let key = ''
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-new'),
      hasSession: vi.fn((id: string) => live.has(id)),
      loadSupported: vi.fn(() => true),
      loadSession: vi.fn(async (id: string) => {
        live.add(id)
      }),
      modelOptions: vi.fn(() => null),
      setSessionModel: vi.fn(async () => {
        await modelHeld
        return true
      }),
      prompt: vi.fn(async (_sessionId: string, blocks: any[]) => {
        prompts.push({ blocks, digest: (await (holder.daemon as any).store.getSession(key))?.standingDigest })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: daemonRoot(),
      hostFactory: () => host as any
    })
    holder.daemon = daemon
    const sink = { output: () => {}, done: () => {} }
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').chatActions = 'settings'
    const transport = (daemon as any).webchatTransport
    const store = (daemon as any).store
    try {
      // A session from before the upgrade: its runtime holds standing context the daemon never recorded.
      key = transport.webchatSessionKey(CONVERSATION, 'bot-a')
      await store.upsertSession({
        key,
        agentId: 'bot-a',
        platform: 'webchat',
        channel: CONVERSATION,
        thread: `webchat:${CONVERSATION}`,
        acpSessionId: 'acp-old',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      await store.setModelOverride(key, 'held-model')

      // The first turn loads the session, then is cancelled before its prompt goes out.
      await transport.dispatchWebchatTurn('bot-a', CONVERSATION, 'first', { id: 'alice', name: 'alice' }, sink)
      await vi.waitFor(() => expect(host.setSessionModel).toHaveBeenCalled(), WAIT)
      await transport.handleWebchatCancel(CONVERSATION)
      releaseModel()
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
      expect(host.loadSession).toHaveBeenCalledOnce()
      expect(host.prompt).not.toHaveBeenCalled()
      expect((await store.getSession(key))?.standingDigest).toBeNull()

      // The next turn carries the refresh, and its digest lands only once the runtime has answered.
      await transport.dispatchWebchatTurn('bot-a', CONVERSATION, 'second', { id: 'alice', name: 'alice' }, sink)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledOnce(), WAIT)
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
      const refresh = refreshes(prompts[0]!.blocks)
      expect(refresh).toHaveLength(1)
      expect(refresh[0]).toContain('New description.')
      expect(prompts[0]!.digest).toBeNull()
      expect((await store.getSession(key))?.standingDigest).toBe(digestOf(refreshed(refresh[0]!)))

      await transport.dispatchWebchatTurn('bot-a', CONVERSATION, 'third', { id: 'alice', name: 'alice' }, sink)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      expect(refreshes(prompts[1]!.blocks)).toEqual([])
    } finally {
      releaseModel()
      await daemon.stop()
    }
  })
})
