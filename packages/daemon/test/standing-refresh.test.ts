import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SessionManager } from '../src/session/session-manager.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import type { Agent } from '../src/agents/agent-schema.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

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
    const first = await before.handle('bot-a', msg('100.1', 'first'))
    const opening = texts(first.blocks)[0]!
    expect(opening).toMatch(/^# Agent/)
    // A new session records what its first prompt carried.
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(opening))

    // A restart: a new process loads the session, and the agent's description has changed meanwhile.
    const host = runtime('inline')
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => described('New description.'),
      memory
    })
    const second = await after.handle('bot-a', msg('100.2', 'second'))
    expect(host.loadSession).toHaveBeenCalledOnce()
    const blocks = refreshes(second.blocks)
    expect(blocks).toHaveLength(1)
    expect(texts(second.blocks)[0]).toBe(blocks[0])
    expect(blocks[0]).toContain('New description.')
    expect(blocks[0]).not.toContain('Old description.')
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(refreshed(blocks[0]!)))

    // The next prompt on the same process carries nothing more.
    const third = await after.handle('bot-a', msg('100.3', 'third'))
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
    await before.handle('bot-a', msg('100.1', 'first'))
    const recorded = (await store.getSession(KEY))?.standingDigest

    const host = runtime('inline')
    const after = new SessionManager({ store, hostFor: async () => host, agentById: () => agent, memory })
    const second = await after.handle('bot-a', msg('100.2', 'second'))
    expect(host.loadSession).toHaveBeenCalledOnce()
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
    await before.handle('bot-a', msg('100.1', 'first'))
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
    const second = await same.handle('bot-a', msg('100.2', 'second'))
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
    const third = await after.handle('bot-a', msg('100.3', 'third'))
    expect(host.loadSession).toHaveBeenCalledOnce()
    expect(host.loadSession.mock.calls[0][4]).toContain('New description.')
    const blocks = refreshes(third.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('New description.')
    expect(blocks[0]).not.toContain(MEMORY_CATALOG)
    expect((await store.getSession(KEY))?.standingDigest).toBe(digestOf(refreshed(blocks[0]!)))
    expect(refreshes((await after.handle('bot-a', msg('100.4', 'fourth'))).blocks)).toEqual([])
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
    await before.handle('bot-a', msg('100.1', 'first'))
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
    await sm.handle('bot-a', msg('100.1', 'first'))
    description = 'New description.'
    const second = await sm.handle('bot-a', msg('100.2', 'second'))
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
    await before.handle('bot-a', msg('100.1', 'first'))

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
    const next = await after.handle('bot-a', msg('100.2', 'second'))
    expect(refreshes(next.blocks)).toHaveLength(1)
    expect(refreshes(next.blocks)[0]).toContain('New description.')
    await store.close()
  })
})
