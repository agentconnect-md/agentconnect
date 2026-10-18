import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SessionManager } from '../src/session/session-manager.js'
import { toolDefinitionsBlock, toolDigests, type SessionToolContext } from '../src/session/turn/tool-context.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { obj, type ToolDescriptor } from '../src/tool-schema/descriptor.js'
import type { Agent } from '../src/agents/agent-schema.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

// A runtime that keeps the tool definitions a session started with across a load is told the changed ones in the conversation.
const HEADING = '[Tool definitions updated]'
const KEY = sessionKey('slack', 'C1', '100.1', 'bot-a')

const track: ToolDescriptor = {
  name: 'trackThing',
  description: 'Track a thing.',
  inputSchema: obj({ title: { type: 'string' } }, ['title'])
}
const trackWithWatch: ToolDescriptor = {
  ...track,
  inputSchema: obj({ title: { type: 'string' }, watch: { type: 'string', description: 'A URL to watch.' } }, ['title'])
}
const list: ToolDescriptor = { name: 'listThings', description: 'List things.', inputSchema: obj({}) }
const retired: ToolDescriptor = { name: 'retiredThing', description: 'Gone soon.', inputSchema: obj({}) }

function testAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-tooldefs-root-'))
  const workspace = join(mkdtempSync(join(tmpdir(), 'ac-tooldefs-ws-')), 'ws')
  const memory = createManagedMemoryProvider(() => localMemoryHome(new LocalMemoryFs(dir)))
  const agent = {
    id: 'bot-a',
    name: 'bot-a',
    status: 'active',
    runtime: 'test-runtime',
    dir,
    env: {},
    workspace: { mode: 'from-scratch', path: workspace, gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent & { dir: string; env: Record<string, string> }
  return { memory, agent }
}

/** A runtime process that loads sessions; `attached` is the tool context its bridge serves a session, when it reports one. */
function runtime(attached?: string) {
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
    ...(attached !== undefined ? { sessionToolContext: () => attached } : {})
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

const notes = (blocks: any[]): string[] =>
  blocks.filter((b) => b.type === 'text' && String(b.text).startsWith(HEADING)).map((b) => b.text as string)
const context = (tools: ToolDescriptor[], fingerprint = 'tools'): SessionToolContext => ({
  fingerprint,
  tools,
  mcpServers: () => []
})

async function newStore() {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-tooldefs-')), 'db.sqlite'))
}

/** A turn whose prompt the runtime answered: the daemon then records the tool definitions it brought the model up to. */
async function delivered(sm: SessionManager, ts: string) {
  const turn = await sm.handle('bot-a', msg(ts, `message ${ts}`))
  if (turn.toolDigests !== undefined) await sm.toolsDelivered(KEY, turn.toolDigests)
  return turn
}

describe('toolDefinitionsBlock', () => {
  it('says nothing while the held definitions are current', () => {
    expect(toolDefinitionsBlock(toolDigests([track, list]), [list, track])).toBeUndefined()
  })

  it('restates only the changed tools, with their current schema, and names the removed ones', () => {
    const block = toolDefinitionsBlock(toolDigests([track, list, retired]), [trackWithWatch, list])!
    expect(block.startsWith(HEADING)).toBe(true)
    expect(block).toContain('"name":"trackThing"')
    expect(block).toContain('"watch"')
    expect(block).not.toContain('"name":"listThings"')
    expect(block).toContain('No longer available: retiredThing.')
  })

  it('restates every tool when what the session holds is unknown', () => {
    const block = toolDefinitionsBlock(null, [trackWithWatch, list])!
    expect(block).toContain('"name":"trackThing"')
    expect(block).toContain('"name":"listThings"')
    expect(block).not.toContain('No longer available')
  })
})

describe('tool definitions on a resumed session', () => {
  it('tells the model once, after a restart, the definitions that changed since it got them', async () => {
    const store = await newStore()
    const { memory, agent } = testAgent()
    const before = new SessionManager({
      store,
      hostFor: async () => runtime(),
      agentById: () => agent,
      memory,
      toolContextFor: () => context([track, list])
    })
    const first = await delivered(before, '100.1')
    expect(notes(first.blocks)).toEqual([])
    expect((await store.getSession(KEY))?.toolDigests).toBe(toolDigests([track, list]))

    // A restart: a new process loads the session, and the tool gained a parameter meanwhile.
    const host = runtime()
    const after = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => agent,
      memory,
      toolContextFor: () => context([trackWithWatch, list])
    })
    const second = await delivered(after, '100.2')
    expect(host.loadSession).toHaveBeenCalledOnce()
    const [note] = notes(second.blocks)
    expect(note).toContain('"watch"')
    expect(note).not.toContain('listThings')
    expect((await store.getSession(KEY))?.toolDigests).toBe(toolDigests([trackWithWatch, list]))

    const third = await delivered(after, '100.3')
    expect(notes(third.blocks)).toEqual([])
    expect(third.toolDigests).toBeUndefined()
    await store.close()
  })

  it('adds nothing after a restart when the definitions are unchanged', async () => {
    const store = await newStore()
    const { memory, agent } = testAgent()
    const deps = { store, agentById: () => agent, memory, toolContextFor: () => context([track, list]) }
    await delivered(new SessionManager({ ...deps, hostFor: async () => runtime() }), '100.1')
    const second = await delivered(new SessionManager({ ...deps, hostFor: async () => runtime() }), '100.2')
    expect(notes(second.blocks)).toEqual([])
    expect(second.toolDigests).toBeUndefined()
    await store.close()
  })

  it('restates every definition once to a session from before they were recorded', async () => {
    const store = await newStore()
    const { memory, agent } = testAgent()
    const deps = { store, agentById: () => agent, memory, toolContextFor: () => context([trackWithWatch, list]) }
    await delivered(new SessionManager({ ...deps, hostFor: async () => runtime() }), '100.1')
    await store.setSessionToolDigests(KEY, null)

    const after = new SessionManager({ ...deps, hostFor: async () => runtime() })
    const [note] = notes((await delivered(after, '100.2')).blocks)
    expect(note).toContain('"name":"trackThing"')
    expect(note).toContain('"name":"listThings"')
    expect(notes((await delivered(after, '100.3')).blocks)).toEqual([])
    await store.close()
  })

  it('repeats the note until a prompt carrying it is taken', async () => {
    const store = await newStore()
    const { memory, agent } = testAgent()
    let tools = [track]
    const sm = new SessionManager({
      store,
      hostFor: async () => runtime(),
      agentById: () => agent,
      memory,
      toolContextFor: () => context(tools)
    })
    await delivered(sm, '100.1')
    tools = [trackWithWatch]
    const rejected = await sm.handle('bot-a', msg('100.2', 'not taken'))
    expect(notes(rejected.blocks)).toHaveLength(1)
    expect(notes((await delivered(sm, '100.3')).blocks)).toHaveLength(1)
    expect(notes((await delivered(sm, '100.4')).blocks)).toEqual([])
    await store.close()
  })

  it('waits while the session’s bridge still serves the earlier tools', async () => {
    const store = await newStore()
    const { memory, agent } = testAgent()
    let tools = [track]
    let fingerprint = 'old'
    const host = runtime('old')
    const sm = new SessionManager({
      store,
      hostFor: async () => host,
      agentById: () => agent,
      memory,
      toolContextFor: () => context(tools, fingerprint),
      // Background work keeps the session from reloading with the new tools.
      sessionSdkQuiescent: () => false
    })
    await delivered(sm, '100.1')
    tools = [trackWithWatch]
    fingerprint = 'new'
    const deferred = await delivered(sm, '100.2')
    expect(notes(deferred.blocks)).toEqual([])
    expect((await store.getSession(KEY))?.toolDigests).toBe(toolDigests([track]))
    await store.close()
  })
})
