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
import { prepareGameSubject, prepareScriptedSubject, type GameSubjectSpec } from './subject.js'
import { compileTopology } from './topology.js'
import type { GameTopologyManifest } from './types.js'
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
