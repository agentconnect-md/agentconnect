import { agentHostKey } from '../src/acp/host-key.js'
import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { scaffold } from './webchat-continuation-fixture.js'
import type { LocalStore } from '../src/store/local-store.js'
import { createRuntimeCommandsReader } from '../src/cp/runtime-commands-reader.js'
import { pendingTurnKey } from '../src/daemon/turn-types.js'
import {
  internalPassSlot,
  InternalPassSessions,
  isAvailableCommandsUpdate,
  normalizeAvailableCommands,
  RuntimeCommandsCache
} from '../src/runtimes/runtime-commands.js'

// One advertisement as claude-agent-acp emits it right after session/new: a workspace skill, a
// plugin skill, a built-in, and an argument hint.
const advertisement = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [
    { name: 'code-review', description: 'Review the current diff (project)', input: { hint: '[pr-number]' } },
    { name: 'superpowers:brainstorming', description: 'Explore intent before implementing (user)', input: null },
    { name: 'model', description: 'Set the model for this session' }
  ]
}

describe('runtime command advertisements', () => {
  it('recognizes only the ACP available-commands update', () => {
    expect(isAvailableCommandsUpdate(advertisement)).toBe(true)
    expect(isAvailableCommandsUpdate({ sessionUpdate: 'usage_update' })).toBe(false)
    expect(isAvailableCommandsUpdate(undefined)).toBe(false)
  })

  it('normalizes names, descriptions and argument hints, classifying skills at record time', () => {
    expect(normalizeAvailableCommands(advertisement)).toEqual([
      { name: 'code-review', description: 'Review the current diff', hint: '[pr-number]', skill: true },
      { name: 'superpowers:brainstorming', description: 'Explore intent before implementing', hint: null, skill: true },
      { name: 'model', description: 'Set the model for this session', hint: null, skill: false }
    ])
  })

  it('strips the scope marker from the stored description — adapter bookkeeping, not prose', () => {
    const [command] = normalizeAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'deploy', description: 'Ship the release. (project)', input: null }]
    })
    expect(command).toEqual({ name: 'deploy', description: 'Ship the release.', hint: null, skill: true })
  })

  it('keeps the skill bit when the description cap eats the claude marker', () => {
    // The `(user)` suffix sits past the 512-char display cap — classification reads the RAW text.
    const long = `${'x'.repeat(600)} (user)`
    const [command] = normalizeAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'agentconnect-setup', description: long, input: null }]
    })
    expect(command!.description.length).toBeLessThanOrEqual(512)
    expect(command!.description.endsWith('(user)')).toBe(false)
    expect(command!.skill).toBe(true)
  })

  it('drops unnamed and duplicate entries rather than surfacing them', () => {
    const commands = normalizeAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'deploy', description: 'first' },
        { name: '  ', description: 'unnamed' },
        { name: 'deploy', description: 'duplicate' },
        'not-an-object',
        { description: 'no name at all' }
      ]
    })
    expect(commands).toEqual([{ name: 'deploy', description: 'first', hint: null, skill: false }])
  })

  it('bounds a hostile advertisement so the reply still fits a control frame', () => {
    const commands = normalizeAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: Array.from({ length: 4096 }, (_, i) => ({
        name: `cmd-${i}`.padEnd(512, 'x'),
        description: 'd'.repeat(4096),
        input: { hint: 'h'.repeat(4096) }
      }))
    })
    expect(commands.length).toBeLessThan(4096)
    expect(Buffer.byteLength(JSON.stringify(commands))).toBeLessThanOrEqual(200 * 1024)
    for (const command of commands) {
      expect(command.name.length).toBeLessThanOrEqual(256)
      expect(command.description.length).toBeLessThanOrEqual(512)
      expect(command.hint?.length).toBeLessThanOrEqual(256)
    }
  })

  it('reports nothing until a session advertises, then replaces the whole list', () => {
    const cache = new RuntimeCommandsCache()
    expect(cache.get('a')).toEqual({ reported: false, commands: [] })

    cache.record('a', 'acp-1', advertisement, Date.parse('2026-08-20T00:00:00.000Z'))
    const first = cache.get('a')
    expect(first.reported).toBe(true)
    expect(first.sessionId).toBe('acp-1')
    expect(first.updatedAt).toBe('2026-08-20T00:00:00.000Z')
    expect(first.commands.map((c) => c.name)).toEqual(['code-review', 'superpowers:brainstorming', 'model'])

    // A later advertisement REPLACES rather than merges — the runtime always sends its whole list.
    cache.record(
      'a',
      'acp-2',
      { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'deploy', description: 'Ship' }] },
      Date.parse('2026-08-20T01:00:00.000Z')
    )
    expect(cache.get('a').commands.map((c) => c.name)).toEqual(['deploy'])
    expect(cache.get('a').sessionId).toBe('acp-2')
  })

  it('ignores an update that is not an advertisement, and forgets a removed agent', () => {
    const cache = new RuntimeCommandsCache()
    cache.record('a', 'acp-1', { sessionUpdate: 'usage_update', used: 1 }, 0)
    expect(cache.get('a').reported).toBe(false)

    cache.record('a', 'acp-1', advertisement, 0)
    expect(cache.get('a').reported).toBe(true)
    cache.forget('a')
    expect(cache.get('a')).toEqual({ reported: false, commands: [] })
  })

  it('answers for an agent this daemon runs, and reports nothing for one it does not', async () => {
    const cache = new RuntimeCommandsCache()
    cache.record('mine', 'acp-1', advertisement, 0)
    cache.record('moved', 'acp-2', advertisement, 0)
    const reader = createRuntimeCommandsReader(cache, (id) => id === 'mine')

    expect((await reader.list({ agentId: 'mine' })).commands).toHaveLength(3)
    expect(await reader.list({ agentId: 'moved' })).toEqual({ reported: false, commands: [] })
  })
})

describe('the daemon records only its own host’s advertisement', () => {
  // A dream or distillation host is a separate AcpHost over its own cwd, and it advertises right
  // after ITS session/new — before its extraction collector is registered, so the collector guard
  // alone would let that list through and describe the agent with commands it does not have.
  it('ignores a session the agent’s host does not own, and takes one it does', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const host = daemon as unknown as {
      hosts: Map<string, { hasSession(id: string): boolean; isLoadingSession(id: string): boolean }>
      onAcpUpdate(agentId: string, sessionId: string, update: unknown): Promise<void>
      runtimeCommands: RuntimeCommandsCache
    }
    host.hosts.set('agent-1', {
      hasSession: (id) => id === 'own-session',
      isLoadingSession: (id) => id === 'resuming-session'
    })

    await host.onAcpUpdate('agent-1', 'dream-session', advertisement)
    expect(host.runtimeCommands.get('agent-1')).toEqual({ reported: false, commands: [] })

    await host.onAcpUpdate('agent-1', 'own-session', advertisement)
    const reported = host.runtimeCommands.get('agent-1')
    expect(reported.reported).toBe(true)
    expect(reported.sessionId).toBe('own-session')
    expect(reported.commands.map((c) => c.name)).toEqual(['code-review', 'superpowers:brainstorming', 'model'])
  })

  // Production ordering, not a hand-driven one: the fake runtime advertises from INSIDE
  // `newSession()`, in the window where the host has the id but has not returned it — the daemon
  // has no row and, before the binding moved to the raw response, nothing to resolve through.
  it('names an advertisement the runtime makes from inside session creation', async () => {
    const root = scaffold(['agent-1'])
    const advertise: { run: () => Promise<void> } = { run: async () => {} }
    const acpSessionId = 'fresh-acp'
    const hostFactory = (): unknown => {
      // Ownership follows the real host: false until `newSession()` has announced and made the
      // session live, so an advertisement in that window would be DROPPED, not merely misnamed.
      let live = false
      const host = {
        start: async () => {},
        stop: async () => {},
        hasSession: (id: string) => live && id === acpSessionId,
        isLoadingSession: () => false,
        newSession: async (
          _cwd: string,
          _servers: unknown,
          _effort: unknown,
          _append: unknown,
          _dirs: unknown,
          announce?: (id: string) => void
        ) => {
          announce?.(acpSessionId)
          live = true
          // Where `applySessionConfig()`'s awaited round trips would be.
          await advertise.run()
          return acpSessionId
        },
        prompt: async () => ({ stopReason: 'end_turn' })
      }
      return host
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: null,
      hostFactory: hostFactory as never
    })
    const inner = daemon as unknown as {
      onAcpUpdate(agentId: string, sessionId: string, update: unknown): Promise<void>
      runtimeCommands: RuntimeCommandsCache
      store: LocalStore
    }
    advertise.run = async () => {
      // No row yet — this is precisely the reported window.
      expect(await inner.store.getSessionByAcpId(acpSessionId)).toBeUndefined()
      await inner.onAcpUpdate('agent-1', acpSessionId, advertisement)
    }
    await daemon.start()

    await (daemon as any).dispatch('agent-1', {
      msgId: 'slack:C1:100.1',
      traceId: 't1',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: true
    })

    const recorded = inner.runtimeCommands.get('agent-1').sessionId
    expect(recorded).not.toBe(acpSessionId)
    expect(recorded).toBe((await inner.store.getSessionByAcpId(acpSessionId))!.sessionId)
    await daemon.stop()
  })

  // claude-agent-acp advertises AFTER the session/load response, so `live` already holds the session
  // by then — but that is one adapter's ordering, and the guard must not depend on it. A session the
  // host is still loading is this host's session.
  it('takes an advertisement that arrives while a session/load is still in flight', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const host = daemon as unknown as {
      hosts: Map<string, { hasSession(id: string): boolean; isLoadingSession(id: string): boolean }>
      onAcpUpdate(agentId: string, sessionId: string, update: unknown): Promise<void>
      runtimeCommands: RuntimeCommandsCache
    }
    host.hosts.set('agent-1', { hasSession: () => false, isLoadingSession: (id) => id === 'resuming' })

    await host.onAcpUpdate('agent-1', 'resuming', advertisement)
    expect(host.runtimeCommands.get('agent-1').sessionId).toBe('resuming')
  })

  // Distillation and the commit-message wand open their session on the agent's OWN host over a
  // throwaway temp dir, so ownership says yes and only the daemon's own registry can tell that list
  // (user + plugin skills, no project skills) from a real one.
  it('ignores the temp-dir advertisement from a session it opened for a pass of its own', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const inner = daemon as unknown as {
      hosts: Map<string, { hasSession(id: string): boolean; isLoadingSession(id: string): boolean }>
      internalPassSessions: InternalPassSessions
      onAcpUpdate(agentId: string, sessionId: string, update: unknown): Promise<void>
      runtimeCommands: RuntimeCommandsCache
    }
    inner.hosts.set('agent-1', { hasSession: () => true, isLoadingSession: () => false })
    const passKey = pendingTurnKey(agentHostKey('agent-1'), 'commit-session')
    inner.internalPassSessions.add(internalPassSlot.commit('agent-1', 'commit-session'), passKey)

    await inner.onAcpUpdate('agent-1', 'commit-session', advertisement)
    expect(inner.runtimeCommands.get('agent-1')).toEqual({ reported: false, commands: [] })

    // Per session, not per host: the agent's ordinary chat session on that same host still reports.
    await inner.onAcpUpdate('agent-1', 'chat-session', advertisement)
    expect(inner.runtimeCommands.get('agent-1').sessionId).toBe('chat-session')
  })
})

describe('the sessions the daemon opened for its own passes', () => {
  it('retires a slot’s previous session, so the registry cannot grow with uptime', () => {
    const sessions = new InternalPassSessions()
    // Distillation's session is cached per memory scope and has no discard site, so the next
    // session for that scope is what retires it.
    sessions.add(internalPassSlot.distill('a'), 'key-1')
    expect(sessions.has('key-1')).toBe(true)
    sessions.add(internalPassSlot.distill('a'), 'key-2')
    expect(sessions.has('key-1')).toBe(false)
    expect(sessions.has('key-2')).toBe(true)

    // A dream keeps its own slot alongside, and re-adding a session is idempotent.
    sessions.add(internalPassSlot.dream('a'), 'key-3')
    sessions.add(internalPassSlot.dream('a'), 'key-3')
    expect(sessions.size).toBe(2)

    sessions.delete('key-2')
    sessions.delete('key-2')
    expect(sessions.has('key-2')).toBe(false)
    expect(sessions.has('key-3')).toBe(true)
    expect(sessions.size).toBe(1)
  })

  // Nothing serializes the wand daemon-side: the console disables its own button while a press is in
  // flight, but two tabs or two repo panels on one agent do overlap. Retiring the first press while
  // its session is still live would re-open the gap for exactly that press's advertisement.
  it('keeps both of two overlapping commit presses excluded', () => {
    const sessions = new InternalPassSessions()
    sessions.add(internalPassSlot.commit('a', 'sess-1'), 'key-1')
    sessions.add(internalPassSlot.commit('a', 'sess-2'), 'key-2')
    expect(sessions.has('key-1')).toBe(true)
    expect(sessions.has('key-2')).toBe(true)

    // Each press deletes its own entry when it discards its session, so nothing accumulates.
    sessions.delete('key-1')
    sessions.delete('key-2')
    expect(sessions.size).toBe(0)
  })
})
