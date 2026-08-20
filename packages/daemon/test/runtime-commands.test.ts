import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { createRuntimeCommandsReader } from '../src/cp/runtime-commands-reader.js'
import {
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

  it('normalizes names, descriptions and argument hints', () => {
    expect(normalizeAvailableCommands(advertisement)).toEqual([
      { name: 'code-review', description: 'Review the current diff (project)', hint: '[pr-number]' },
      { name: 'superpowers:brainstorming', description: 'Explore intent before implementing (user)', hint: null },
      { name: 'model', description: 'Set the model for this session', hint: null }
    ])
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
    expect(commands).toEqual([{ name: 'deploy', description: 'first', hint: null }])
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
      hosts: Map<string, { hasSession(id: string): boolean }>
      onAcpUpdate(agentId: string, sessionId: string, update: unknown): Promise<void>
      runtimeCommands: RuntimeCommandsCache
    }
    host.hosts.set('agent-1', { hasSession: (id) => id === 'own-session' })

    await host.onAcpUpdate('agent-1', 'dream-session', advertisement)
    expect(host.runtimeCommands.get('agent-1')).toEqual({ reported: false, commands: [] })

    await host.onAcpUpdate('agent-1', 'own-session', advertisement)
    const reported = host.runtimeCommands.get('agent-1')
    expect(reported.reported).toBe(true)
    expect(reported.sessionId).toBe('own-session')
    expect(reported.commands.map((c) => c.name)).toEqual(['code-review', 'superpowers:brainstorming', 'model'])
  })
})
