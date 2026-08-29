import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'

// The commit-message pass (webchat-side-panels.md §5.1) against a stub ACP host — the same seam the
// dream tests use. What is asserted here is the SESSION LIFECYCLE, which is the part a real adapter
// would only make slower to check: a fresh session per press on the WARM host, discarded after; no
// MCP tools; the read-only gate; and that none of it reaches a store row or the transcript.

const AGENT = 'bot-a'
const roots: string[] = []

// What claude-agent-acp advertises for the pass's empty temp cwd: user and plugin skills survive a
// cwd change, the agent's project skills do not.
const ADVERTISEMENT = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'superpowers:brainstorming', description: 'Explore intent (user)' }]
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-commitmsg-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'arbitrary-acp',
      builtin: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

interface HostStub {
  newSession: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  discardSession: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  setSessionPermissionMode: ReturnType<typeof vi.fn>
  usesMetaSystemPrompt: () => boolean
  permissionModeOptions: () => { modes: string[] } | null
}

/** One warm host stub whose `prompt` streams `chunks` through the daemon's real `onAcpUpdate`. */
function stubHost(
  daemon: Daemon,
  opts: {
    trusted?: boolean
    modes?: string[]
    modeAccepted?: boolean
    chunks?: string[]
    stopReason?: string
    /** A runtime that answers only when it is canceled — i.e. one that honours `session/cancel`. */
    awaitCancel?: boolean
    /** A runtime that advertises its slash commands the way a real adapter does — see below. */
    advertise?: boolean
  } = {}
): { host: HostStub; factory: ReturnType<typeof vi.fn> } {
  let seq = 0
  let canceled!: () => void
  const host: HostStub = {
    usesMetaSystemPrompt: () => opts.trusted ?? false,
    permissionModeOptions: () => ({ modes: opts.modes ?? ['read-only'] }),
    setSessionPermissionMode: vi.fn(async () => {
      // A real `session/set_mode` is a round-trip, not a microtask. Deferring it by a macrotask is
      // what lets the advertisement below overtake anything registered after this await.
      if (opts.advertise) await new Promise((resolve) => setTimeout(resolve, 0))
      return opts.modeAccepted ?? true
    }),
    newSession: vi.fn(async () => {
      const id = `sess-${++seq}`
      // claude-agent-acp advertises its commands on a timer right after the session/new response —
      // outside any turn, and before the pass registers its collector.
      if (opts.advertise) {
        setTimeout(() => {
          ;(daemon as never as { onAcpUpdate(a: string, s: string, u: unknown): void }).onAcpUpdate(
            AGENT,
            id,
            ADVERTISEMENT
          )
        }, 0)
      }
      return id
    }),
    prompt: vi.fn(async (sessionId: string) => {
      for (const text of opts.chunks ?? []) {
        // Exactly the path a real adapter takes, so the collector interception is what is under test.
        ;(daemon as never as { onAcpUpdate(a: string, s: string, u: unknown): void }).onAcpUpdate(AGENT, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text }
        })
      }
      if (opts.awaitCancel) await new Promise<void>((resolve) => (canceled = resolve))
      return { stopReason: opts.stopReason ?? 'end_turn' }
    }),
    discardSession: vi.fn(),
    cancel: vi.fn(async () => canceled?.()),
    hasSession: () => true,
    start: async () => {},
    stop: async () => {},
    modelOptions: () => null
  } as never as HostStub
  return { host, factory: vi.fn(() => host as never) }
}

async function withDaemon(
  opts: Parameters<typeof stubHost>[1],
  body: (daemon: Daemon, host: HostStub, factory: ReturnType<typeof vi.fn>) => Promise<void>
): Promise<void> {
  const root = scaffold()
  // The stub needs the daemon (its `prompt` streams through the real `onAcpUpdate`) and the daemon
  // needs the stub, so the factory closes over a holder filled in right after construction.
  const holder: { stub?: { host: HostStub; factory: ReturnType<typeof vi.fn> } } = {}
  const daemon = new Daemon({ root, hostFactory: (() => holder.stub!.host) as never })
  const stub = stubHost(daemon, opts)
  holder.stub = stub
  await daemon.start()
  try {
    await body(daemon, stub.host, stub.factory)
  } finally {
    await daemon.stop().catch(() => {})
    // The pass's throwaway cwd lives under the OS temp dir for the agent's whole host lifetime (the
    // same shape distillation uses), so a test reclaims it rather than leaving one per run behind.
    for (const dir of (daemon as never as { commitMessageDirs: Map<string, string> }).commitMessageDirs.values()) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function pass(daemon: Daemon, signal = new AbortController().signal) {
  const inner = daemon as never as {
    runCommitMessagePass(
      id: string,
      systemPrompt: string,
      prompt: string,
      signal: AbortSignal
    ): Promise<{ output: string; stopReason: string }>
  }
  return inner.runCommitMessagePass(AGENT, 'SYSTEM-POLICY', 'DIFF-PROMPT', signal)
}

describe('runCommitMessagePass — a fresh isolated session on the warm host', () => {
  it('opens a fresh tool-free session per press, collects the answer, and discards the session', async () => {
    await withDaemon({ chunks: ['feat(dock): ', 'draft a message'] }, async (daemon, host) => {
      const inner = daemon as never as Record<string, any>

      const first = await pass(daemon)
      expect(first).toEqual({ output: 'feat(dock): draft a message', stopReason: 'end_turn' })

      // No MCP tools at all, and a cwd that is NOT the workspace (a repo cwd would load the
      // repository's own agent instructions into a utility call).
      expect(host.newSession).toHaveBeenCalledTimes(1)
      const [cwd, servers] = host.newSession.mock.calls[0]!
      expect(servers).toEqual([])
      expect(cwd).not.toBe(inner.agents.get(AGENT).workspace.path)
      expect(cwd).toContain('agentconnect-commit-message-')
      expect(host.discardSession).toHaveBeenCalledWith('sess-1')

      // A second press gets a FRESH session (never a cached context) on the SAME warm host.
      const second = await pass(daemon)
      expect(second.output).toBe('feat(dock): draft a message')
      expect(host.newSession).toHaveBeenCalledTimes(2)
      expect(host.newSession.mock.calls[1]![0]).toBe(cwd)
      expect(host.discardSession).toHaveBeenCalledWith('sess-2')
      expect(inner.hosts.get(AGENT)).toBeDefined()
    })
  })

  it('leaves no session row, no transcript and no live collector behind', async () => {
    await withDaemon({ chunks: ['fix: quiet'] }, async (daemon) => {
      const inner = daemon as never as Record<string, any>
      await pass(daemon)
      // The whole point of the collector: the turn never becomes a session, so nothing is delivered,
      // recorded or billed to a session row.
      expect(await inner.store.getSessionByAcpIdForAgent(AGENT, 'sess-1')).toBeUndefined()
      expect(inner.memoryExtractionCollectors.size).toBe(0)
      // …but the tombstone stays until the host stops, because an adapter can still emit late.
      // The key shape is daemon-private (`pendingTurnKey`), so match on its contents.
      expect([...inner.memoryExtractionQuarantines.keys()]).toEqual([JSON.stringify([AGENT, 'sess-1'])])
      // A second press replaces it rather than adding one, so presses cannot accumulate entries.
      await pass(daemon)
      expect([...inner.memoryExtractionQuarantines.keys()]).toEqual([JSON.stringify([AGENT, 'sess-2'])])
    })
  })

  it('keeps its throwaway cwd out of the command list the console reports for the agent', async () => {
    // The pass's session belongs to the agent's warm host, so host ownership alone would take this
    // advertisement and truncate the agent's `/` picker to the skills a temp dir has (#1310 review).
    await withDaemon({ advertise: true, chunks: ['fix: quiet'] }, async (daemon, host) => {
      const inner = daemon as never as Record<string, any>
      await pass(daemon)
      expect(host.newSession).toHaveBeenCalledTimes(1)
      expect(inner.runtimeCommands.get(AGENT)).toEqual({ reported: false, commands: [] })
      // …and the pass leaves no entry behind, because the session it registered is discarded.
      expect(inner.internalPassSessions.size).toBe(0)

      // An ordinary chat session on that same host still reports.
      await inner.onAcpUpdate(AGENT, 'chat-1', ADVERTISEMENT)
      expect(inner.runtimeCommands.get(AGENT).sessionId).toBe('chat-1')
    })
  })

  it('rides _meta.systemPrompt on a runtime that has it, and prepends the policy on one that does not', async () => {
    await withDaemon({ trusted: true, chunks: ['fix: trusted'] }, async (daemon, host) => {
      await pass(daemon)
      expect(host.newSession.mock.calls[0]![3]).toBe('SYSTEM-POLICY')
      expect(host.prompt.mock.calls[0]![1]).toEqual([{ type: 'text', text: 'DIFF-PROMPT' }])
    })
    await withDaemon({ trusted: false, chunks: ['fix: inline'] }, async (daemon, host) => {
      await pass(daemon)
      expect(host.newSession.mock.calls[0]![3]).toBeUndefined()
      expect(host.prompt.mock.calls[0]![1]).toEqual([{ type: 'text', text: 'SYSTEM-POLICY\n\nDIFF-PROMPT' }])
    })
  })

  it('fails closed when the runtime has no non-mutating mode, before any prompt', async () => {
    await withDaemon({ modes: ['default', 'accept-edits'] }, async (daemon, host) => {
      await expect(pass(daemon)).rejects.toThrow('read-only/plan mode')
      expect(host.newSession).not.toHaveBeenCalled()
      expect(host.prompt).not.toHaveBeenCalled()
    })
  })

  it('fails closed when the mode switch is rejected, and still discards the session', async () => {
    await withDaemon({ modeAccepted: false }, async (daemon, host) => {
      await expect(pass(daemon)).rejects.toThrow('read-only/plan mode')
      expect(host.prompt).not.toHaveBeenCalled()
      expect(host.discardSession).toHaveBeenCalledWith('sess-1')
    })
  })

  it('drives the runtime cancel path when the caller budget aborts mid-prompt', async () => {
    // The in-flight case: the caller's budget fires while the runtime is still thinking, so the abort
    // has to reach `session/cancel` — nothing else would end the turn.
    await withDaemon({ awaitCancel: true, stopReason: 'cancelled' }, async (daemon, host) => {
      const abort = new AbortController()
      const pending = pass(daemon, abort.signal)
      // Abort only once the prompt is actually in flight; earlier and the pre-dispatch guard wins.
      while (host.prompt.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve))
      abort.abort()
      const result = await pending
      expect(host.cancel).toHaveBeenCalledWith('sess-1')
      expect(result).toEqual({ output: '', stopReason: 'cancelled' })
      expect(host.discardSession).toHaveBeenCalledWith('sess-1')
    })
  })

  it('never dispatches an already-canceled press, and refuses an unknown agent', async () => {
    await withDaemon({ chunks: ['fix: x'] }, async (daemon, host) => {
      const canceled = new AbortController()
      canceled.abort()
      await expect(pass(daemon, canceled.signal)).rejects.toThrow('canceled before dispatch')
      expect(host.prompt).not.toHaveBeenCalled()

      const inner = daemon as never as Record<string, any>
      await expect(inner.runCommitMessagePass('ghost', 's', 'p', new AbortController().signal)).rejects.toThrow(
        'unknown agent'
      )
    })
  })
})
