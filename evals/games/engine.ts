/**
 * The Collaboration Arena engine for the same-room counting milestone
 * (docs/designs/collaboration-arena.md §8/§14 step 3).
 *
 * Composes a compiled topology, an Arena world, and the counting referee into
 * one runnable game against a REAL daemon: virtual connections installed into
 * the production connection maps, real-path ingress, real routing/gating, real
 * SessionManager + serial gate, scripted ACP hosts. Deterministic mode is
 * environment-deterministic (§8.1); with scripted hosts the OUTCOME is the
 * reproducible CI gate of the engine itself. Within a wave, "first valid
 * arrival wins" still follows runtime turn scheduling — the world records
 * every admission and `sequence`-stamped effect so any run is explainable.
 */
import { CollaborationGameRunner, type CollaborationGameResult } from '../../packages/daemon/src/evaluation/index.js'
import { CountingGame } from './counting.js'
import { CrossRoomCountingGame } from './cross-room-counting.js'
import { callDaemonTool, daemonMcpBinding, type DaemonMcpBinding } from './mcp-client.js'
import { prepareGameSubject, prepareScriptedSubject, type GameSubjectSpec } from './subject.js'
import { compileTopology } from './topology.js'
import type { GameTopologyManifest } from './types.js'
import { assignWerewolfRoles, WerewolfGame } from './werewolf.js'
import { ArenaWorld } from './world.js'

export { prepareScriptedSubject as scaffoldSubject }

export interface CountingGameRunOptions {
  seed?: number
  target?: number
  /** Agent aliases in the counting room (default four). */
  agents?: string[]
  artifactDir: string
  maxSteps?: number
  timeoutMs?: number
  /** Who plays (§8.1): scripted hosts (default; the reproducible engine gate)
   *  or a real-runtime subject template — the identical game either way. */
  subject?: GameSubjectSpec
  /** Preserve the disposable subject root for debugging. */
  keepSubject?: boolean
}

export function countingManifest(options: { seed: number; agents: string[] }): GameTopologyManifest {
  return {
    game: 'same-room-counting',
    seed: options.seed,
    agents: options.agents.map((alias) => ({ id: alias })),
    rooms: [{ id: 'counting-room', platform: 'slack', members: options.agents }]
  }
}

/**
 * Scripted counting policy: parse the referee's latest "Next expected number"
 * from the prompt and reply with exactly that number — every member proposes
 * every round, exercising collisions, atomic acceptance, and the
 * no-consecutive-scorer rule deterministically.
 */
export function scriptedCountingHostFactory(): (
  agent: { id: string },
  onUpdate: (sessionId: string, update: unknown) => void
) => unknown {
  return (agent, onUpdate) => {
    let sessions = 0
    return {
      start: async () => {},
      newSession: async () => `scripted-${agent.id.slice(0, 8)}-${(sessions += 1)}`,
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-counting', models: ['scripted-counting'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        const matches = [...text.matchAll(/Next expected number:\s*(\d+)/g)]
        const candidate = matches.at(-1)?.[1]
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: candidate ?? 'waiting' }
        })
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }
}

export function crossRoomManifest(options: { seed: number }): GameTopologyManifest {
  return {
    game: 'cross-room-counting',
    seed: options.seed,
    agents: [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'bridge-x' }, { id: 'agent-c' }, { id: 'agent-d' }],
    rooms: [
      { id: 'discord-origin', platform: 'discord', members: ['agent-a', 'agent-b', 'bridge-x'] },
      { id: 'slack-support', platform: 'slack', members: ['bridge-x', 'agent-c', 'agent-d'] }
    ]
  }
}

const ORDER_PATTERN =
  /ORDER assignee=(\S+): call sendMessage exactly once with platform=(\S+) integrationId=(\S+) channel=(\S+) thread=(\S+) and message "([^"]+)"/g

/**
 * Scripted cross-room policy: counting members propose the latest expected
 * number; the assignee of a referee ORDER executes a REAL `sendMessage`
 * through the daemon's MCP control socket with the binding it received at
 * `session/new` — the same trusted path a real runtime's bridge subprocess
 * uses, so §7.2 authorization and §10.2 addressing are exercised for real.
 */
export function scriptedCrossRoomHostFactory(): (
  agent: { id: string; name?: string },
  onUpdate: (sessionId: string, update: unknown) => void
) => unknown {
  return (agent, onUpdate) => {
    let sessions = 0
    const bindings = new Map<string, DaemonMcpBinding>()
    const chunk = (sessionId: string, text: string) =>
      onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: unknown) => {
        const sessionId = `scripted-${agent.id.slice(0, 8)}-${(sessions += 1)}`
        const binding = daemonMcpBinding(mcpServers)
        if (binding) bindings.set(sessionId, binding)
        return sessionId
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-cross-room', models: ['scripted-cross-room'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        const order = [...text.matchAll(ORDER_PATTERN)].at(-1)
        if (order && order[1] === agent.name) {
          const binding = bindings.get(sessionId)
          if (!binding) {
            chunk(sessionId, 'order failed: session has no daemon tools')
            return { stopReason: 'end_turn' }
          }
          const result = await callDaemonTool(binding, 'sendMessage', {
            platform: order[2]!,
            integrationId: order[3]!,
            channel: order[4]!,
            thread: order[5]!,
            message: order[6]!
          })
          chunk(sessionId, result.ok ? 'order executed' : `order failed: ${result.error ?? 'unknown error'}`)
          return { stopReason: 'end_turn' }
        }
        const matches = [...text.matchAll(/Next expected number:\s*(\d+)/g)]
        const candidate = matches.at(-1)?.[1]
        chunk(sessionId, candidate ?? 'waiting')
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }
}

// ── Werewolf (§14 step 6) ───────────────────────────────────────────────────

export const WEREWOLF_PLAYERS = [
  'player-1',
  'player-2',
  'player-3',
  'player-4',
  'player-5',
  'player-6',
  'player-7'
] as const

export function werewolfDmRoomAlias(playerAlias: string): string {
  return `dm-${playerAlias}`
}

/** The public room, each player's private referee DM, and a REAL private wolf
 *  den whose membership follows the seeded role assignment. */
export function werewolfManifest(options: { seed: number }): GameTopologyManifest {
  const players = [...WEREWOLF_PLAYERS]
  const roles = assignWerewolfRoles(players, options.seed)
  const wolves = players.filter((alias) => roles.get(alias) === 'werewolf')
  return {
    game: 'werewolf',
    seed: options.seed,
    agents: players.map((alias) => ({ id: alias })),
    rooms: [
      { id: 'village-square', platform: 'slack', members: players },
      { id: 'wolf-den', platform: 'slack', members: wolves, isPrivate: true },
      ...players.map((alias) => ({
        id: werewolfDmRoomAlias(alias),
        platform: 'slack' as const,
        members: [alias],
        dm: true
      }))
    ]
  }
}

/**
 * Scripted werewolf policy — deterministic role-following (no strategy):
 * role/partner learned from the private referee message; night actions and day
 * votes go through the REAL §6 evaluation tools over the daemon MCP socket;
 * public speech stays natural language and never repeats private content.
 */
export function scriptedWerewolfHostFactory(): (
  agent: { id: string; name?: string },
  onUpdate: (sessionId: string, update: unknown) => void
) => unknown {
  return (agent, onUpdate) => {
    let sessions = 0
    const bindings = new Map<string, DaemonMcpBinding>()
    const state: { role?: string; partner?: string; knownWolf?: string } = {}
    const chunk = (sessionId: string, text: string) =>
      onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    const listAfter = (text: string, label: string): string[] => {
      const match = new RegExp(`${label}:\\s*([^.\\n]+)`).exec(text)
      return match
        ? match[1]!
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : []
    }
    const act = async (sessionId: string, tool: string, target: string): Promise<string> => {
      const binding = bindings.get(sessionId)
      if (!binding) return 'no daemon tools in this session'
      const result = await callDaemonTool(binding, tool, { target })
      return result.ok ? `${tool} done` : `${tool} failed: ${result.error ?? 'unknown error'}`
    }
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: unknown) => {
        const sessionId = `scripted-${agent.id.slice(0, 8)}-${(sessions += 1)}`
        const binding = daemonMcpBinding(mcpServers)
        if (binding) bindings.set(sessionId, binding)
        return sessionId
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-werewolf', models: ['scripted-werewolf'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        const role = /Your role: (\w+)/.exec(text)
        if (role) {
          state.role = role[1]
          const partner = /Your fellow wolf: (\S+?)\.?(?:\s|$)/.exec(text)
          if (partner && partner[1] !== 'none') state.partner = partner[1]
          chunk(sessionId, 'acknowledged')
          return { stopReason: 'end_turn' }
        }
        const inspection = /Inspection result: (\S+) is (a werewolf|not a werewolf)/.exec(text)
        if (inspection) {
          if (inspection[2] === 'a werewolf') state.knownWolf = inspection[1]
          chunk(sessionId, 'noted')
          return { stopReason: 'end_turn' }
        }
        if (/NIGHT \d+/.test(text)) {
          if (state.role === 'werewolf') {
            const targets = listAfter(text, 'Targets')
            chunk(sessionId, targets[0] ? await act(sessionId, 'kill', targets[0]) : 'no targets')
          } else if (state.role === 'seer') {
            const living = listAfter(text, 'Living').filter((alias) => alias !== agent.name)
            chunk(sessionId, living[0] ? await act(sessionId, 'inspect', living[0]) : 'no one to inspect')
          } else if (state.role === 'doctor') {
            const living = listAfter(text, 'Living')
            chunk(sessionId, living[0] ? await act(sessionId, 'protect', living[0]) : 'no one to protect')
          } else {
            chunk(sessionId, 'sleeping')
          }
          return { stopReason: 'end_turn' }
        }
        if (/DAY \d+/.test(text)) {
          const living = listAfter(text, 'Living players')
          const candidates = living.filter((alias) => alias !== agent.name)
          const target =
            state.knownWolf && living.includes(state.knownWolf)
              ? state.knownWolf
              : state.role === 'werewolf'
                ? candidates.find((alias) => alias !== state.partner)
                : candidates[0]
          if (!target) {
            chunk(sessionId, 'abstaining')
            return { stopReason: 'end_turn' }
          }
          const outcome = await act(sessionId, 'vote', target)
          chunk(sessionId, `I suspect ${target}. (${outcome})`)
          return { stopReason: 'end_turn' }
        }
        chunk(sessionId, 'waiting')
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }
}

export interface WerewolfGameRunOptions {
  seed?: number
  artifactDir: string
  maxRounds?: number
  maxSteps?: number
  timeoutMs?: number
  subject?: GameSubjectSpec
  keepSubject?: boolean
}

export async function runWerewolf(options: WerewolfGameRunOptions): Promise<CollaborationGameResult> {
  const seed = options.seed ?? 42
  const subjectSpec: GameSubjectSpec = options.subject ?? { kind: 'scripted' }
  const topology = compileTopology(werewolfManifest({ seed }))
  const world = new ArenaWorld(topology)
  const game = new WerewolfGame({
    world,
    publicRoomAlias: 'village-square',
    wolfDenAlias: 'wolf-den',
    dmRoomAliasFor: werewolfDmRoomAlias,
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {})
  })
  const subject = prepareGameSubject(topology, subjectSpec)
  try {
    const runner = new CollaborationGameRunner({
      root: subject.root,
      world: game,
      artifactDir: options.artifactDir,
      game: 'werewolf',
      seed,
      mode: 'deterministic',
      subjectKind: subjectSpec.kind,
      ...(subjectSpec.kind === 'scripted' ? { hostFactory: scriptedWerewolfHostFactory() as never } : {}),
      capabilityProfile: { memory: 'off', collaboration: 'configured' },
      limits: {
        maxSteps: options.maxSteps ?? 60,
        timeoutMs: options.timeoutMs ?? (subjectSpec.kind === 'scripted' ? 240_000 : 30 * 60_000)
      },
      agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias })),
      // Real subjects carry template credentials; every artifact writer redacts them.
      secrets: subject.secrets
    })
    return await runner.run()
  } finally {
    if (!options.keepSubject) subject.cleanup()
  }
}

export interface CrossRoomGameRunOptions {
  seed?: number
  boundary?: number
  target?: number
  artifactDir: string
  maxSteps?: number
  timeoutMs?: number
  subject?: GameSubjectSpec
  keepSubject?: boolean
}

export async function runCrossRoomCounting(options: CrossRoomGameRunOptions): Promise<CollaborationGameResult> {
  const seed = options.seed ?? 42
  const subjectSpec: GameSubjectSpec = options.subject ?? { kind: 'scripted' }
  const topology = compileTopology(crossRoomManifest({ seed }))
  const world = new ArenaWorld(topology)
  const game = new CrossRoomCountingGame({
    world,
    originRoomAlias: 'discord-origin',
    destinationRoomAlias: 'slack-support',
    bridgeAlias: 'bridge-x',
    ...(options.boundary !== undefined ? { boundary: options.boundary } : {}),
    ...(options.target !== undefined ? { target: options.target } : {})
  })
  const subject = prepareGameSubject(topology, subjectSpec)
  try {
    const runner = new CollaborationGameRunner({
      root: subject.root,
      world: game,
      artifactDir: options.artifactDir,
      game: 'cross-room-counting',
      seed,
      mode: 'deterministic',
      subjectKind: subjectSpec.kind,
      ...(subjectSpec.kind === 'scripted' ? { hostFactory: scriptedCrossRoomHostFactory() as never } : {}),
      capabilityProfile: { memory: 'off', collaboration: 'configured' },
      limits: {
        maxSteps: options.maxSteps ?? (options.target ?? 12) * 3 + 10,
        timeoutMs: options.timeoutMs ?? (subjectSpec.kind === 'scripted' ? 180_000 : 20 * 60_000)
      },
      agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias })),
      // Real subjects carry template credentials; every artifact writer redacts them.
      secrets: subject.secrets
    })
    return await runner.run()
  } finally {
    if (!options.keepSubject) subject.cleanup()
  }
}

export async function runSameRoomCounting(options: CountingGameRunOptions): Promise<CollaborationGameResult> {
  const seed = options.seed ?? 42
  const agents = options.agents ?? ['agent-a', 'agent-b', 'agent-c', 'agent-d']
  const subjectSpec: GameSubjectSpec = options.subject ?? { kind: 'scripted' }
  const topology = compileTopology(countingManifest({ seed, agents }))
  const world = new ArenaWorld(topology)
  const game = new CountingGame({
    world,
    roomAlias: 'counting-room',
    ...(options.target !== undefined ? { target: options.target } : {})
  })
  const subject = prepareGameSubject(topology, subjectSpec)
  try {
    const runner = new CollaborationGameRunner({
      root: subject.root,
      world: game,
      artifactDir: options.artifactDir,
      game: 'same-room-counting',
      seed,
      mode: 'deterministic',
      subjectKind: subjectSpec.kind,
      // Real subjects launch their template's actual ACP runtimes — no host
      // seam. Repeated trials and pass^k aggregation are Promptfoo's job (§12).
      ...(subjectSpec.kind === 'scripted' ? { hostFactory: scriptedCountingHostFactory() as never } : {}),
      capabilityProfile: { memory: 'off', collaboration: 'configured' },
      limits: {
        maxSteps: options.maxSteps ?? (options.target ?? 12) * 3 + 4,
        timeoutMs: options.timeoutMs ?? (subjectSpec.kind === 'scripted' ? 120_000 : 15 * 60_000)
      },
      agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias })),
      // Real subjects carry template credentials; every artifact writer redacts them.
      secrets: subject.secrets
    })
    return await runner.run()
  } finally {
    if (!options.keepSubject) subject.cleanup()
  }
}
