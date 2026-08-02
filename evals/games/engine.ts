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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationGameRunner, type CollaborationGameResult } from '../../packages/daemon/src/evaluation/index.js'
import { CountingGame } from './counting.js'
import { compileTopology } from './topology.js'
import type { CompiledTopology, GameTopologyManifest } from './types.js'
import { ArenaWorld } from './world.js'

export interface CountingGameRunOptions {
  seed?: number
  target?: number
  /** Agent aliases in the counting room (default four). */
  agents?: string[]
  artifactDir: string
  maxSteps?: number
  timeoutMs?: number
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

/** Disposable subject root: one scripted-runtime agent per compiled agent id.
 *  Integrations stay EMPTY on disk — the evaluation environment (§5) is the
 *  only authority that projects the virtual integrations in. */
export function scaffoldSubject(topology: CompiledTopology): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { scripted: { command: 'node', args: ['unused'] } }
    })
  )
  for (const agent of topology.agents) {
    const agentDir = join(root, 'agents', agent.agentId)
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(agentDir, 'workspace'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          id: agent.agentId,
          name: agent.alias,
          status: 'active',
          runtime: 'scripted',
          workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
          integrations: [],
          output: { mode: 'low', showFooter: false, showStatusBar: false }
        },
        null,
        2
      )
    )
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
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
  const topology = compileTopology(countingManifest({ seed, agents }))
  const world = new ArenaWorld(topology)
  const game = new CountingGame({
    world,
    roomAlias: 'counting-room',
    ...(options.target !== undefined ? { target: options.target } : {})
  })
  const subject = scaffoldSubject(topology)
  try {
    const runner = new CollaborationGameRunner({
      root: subject.root,
      world: game,
      artifactDir: options.artifactDir,
      game: 'same-room-counting',
      seed,
      mode: 'deterministic',
      subjectKind: 'scripted',
      hostFactory: scriptedCountingHostFactory() as never,
      capabilityProfile: { memory: 'off', collaboration: 'configured' },
      limits: {
        maxSteps: options.maxSteps ?? (options.target ?? 12) * 3 + 4,
        timeoutMs: options.timeoutMs ?? 120_000
      },
      agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias }))
    })
    return await runner.run()
  } finally {
    if (!options.keepSubject) subject.cleanup()
  }
}
