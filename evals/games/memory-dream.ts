/**
 * Memory-dream evaluation (memory-dreaming.md §5, verify phase) — ONE agent in
 * ONE public Slack room of the Collaboration Arena.
 *
 * A person states a fact the agent saves to shared memory, corrects it in a
 * later thread without asking for a save, the agent dreams, and a fresh thread
 * asks for the value. Only a dream that verified the old note against the
 * correction answers the new value; without dreaming the store still says the
 * old one, so the final reply is the whole measurement.
 *
 * The room is public on purpose: dreams mine only the sessions whose
 * conversation uses the shared memory layer, and a channel qualifies only when
 * the platform confirms its audience is the organization (product-conventions
 * "Memory layers"). The webchat turns the add-on suite drives keep a person
 * layer and are never dreamed, which is why this case is a game and not a case
 * of `cases/addons.yaml`.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DaemonEvaluationHarness,
  environmentSecrets,
  type DaemonEvaluationDreamResult,
  type DaemonEvaluationHarnessOptions
} from '../../packages/daemon/src/evaluation/index.js'
import { prepareGameSubject, type GameSubjectSpec } from './subject.js'
import { compileTopology } from './topology.js'
import type { GameTopologyManifest } from './types.js'
import { ArenaWorld } from './world.js'

/** The fact under test: saved wrong, corrected in conversation, expected right after the dream. */
export const MEMORY_DREAM_FACT = { topic: 'staging-db', wrong: '5432', right: '6543' } as const

export const MEMORY_DREAM_UNAVAILABLE = 'MEMORY-UNAVAILABLE'

export interface MemoryDreamOptions {
  seed: number
  artifactDir: string
  /** Who plays: scripted hosts (the engine gate) or a real-runtime subject template. */
  subject?: GameSubjectSpec
  /** Scripted ACP hosts for the scripted subject. */
  hostFactory?: DaemonEvaluationHarnessOptions['hostFactory']
  timeoutMs?: number
  keepSubject?: boolean
}

export interface MemoryDreamStep {
  name: 'save' | 'correct' | 'recall'
  status: string
  output: string
}

export interface MemoryDreamResult {
  status: 'passed' | 'agent_failed' | 'infra_error'
  /** The agent's reply to the recall thread — the observable outcome. */
  output: string
  steps: MemoryDreamStep[]
  dream?: DaemonEvaluationDreamResult
  error?: string
  paths: { events: string; worldEvents: string }
}

/** The three things the person says, each in a fresh top-level thread. */
export const MEMORY_DREAM_PROMPTS = {
  save: `For everyone here: the staging database port is ${MEMORY_DREAM_FACT.wrong}. Save that with the writeMemory tool on server \`agentconnect\` as topic \`${MEMORY_DREAM_FACT.topic}\`, then confirm in one line. If that tool is unavailable or refused, reply exactly ${MEMORY_DREAM_UNAVAILABLE}.`,
  correct: `Correction: the staging database port is ${MEMORY_DREAM_FACT.right}, not ${MEMORY_DREAM_FACT.wrong}. Just acknowledge in one line. Do not call any tool and do not save anything.`,
  recall: `Read your memory with the readMemory tool on server \`agentconnect\`: open MEMORY.md, then the \`${MEMORY_DREAM_FACT.topic}\` topic, and reply with only the staging database port number. If memory is unavailable, reply exactly ${MEMORY_DREAM_UNAVAILABLE}.`
} as const

const DEFAULT_TIMEOUT_MS = 15 * 60_000

export async function runMemoryDream(options: MemoryDreamOptions): Promise<MemoryDreamResult> {
  const manifest: GameTopologyManifest = {
    game: 'memory-dream',
    seed: options.seed,
    agents: [{ id: 'subject' }],
    rooms: [{ id: 'ops-room', platform: 'slack', members: ['subject'] }]
  }
  const topology = compileTopology(manifest)
  const room = topology.rooms[0]!
  const agent = topology.agents[0]!
  const integration = topology.integrations.find((candidate) => candidate.agentId === agent.agentId)!
  const operator = { id: 'operator', userId: 'UOPERATOR001' }
  const world = new ArenaWorld(topology, [
    {
      id: operator.id,
      accounts: [{ integrationId: integration.integrationId, userId: operator.userId, channels: [room.channel] }]
    }
  ])
  const subject = prepareGameSubject(topology, options.subject ?? { kind: 'scripted' }, {
    agent: {
      memory: {
        provider: 'managed',
        autoDistill: false,
        dreaming: { enabled: true, autoAdopt: true, mineSkills: false }
      }
    }
  })
  mkdirSync(options.artifactDir, { recursive: true, mode: 0o700 })
  const paths = {
    events: join(options.artifactDir, 'events.jsonl'),
    worldEvents: join(options.artifactDir, 'world-events.jsonl')
  }
  const runId = randomUUID()
  const deadlineMs = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const secrets = [...new Set([...subject.secrets, ...environmentSecrets()])]
  const harness = new DaemonEvaluationHarness({
    root: subject.root,
    environment: world.buildEnvironment({ bindMatch: 'mention' }),
    runId,
    capabilityProfile: { memory: 'configured' },
    secrets,
    ...(options.hostFactory ? { hostFactory: options.hostFactory, dreamOperationPolicy: 'test-only' as const } : {})
  })

  const steps: MemoryDreamStep[] = []
  let dream: DaemonEvaluationDreamResult | undefined
  let status: MemoryDreamResult['status'] = 'passed'
  let error: string | undefined

  const remaining = (label: string): number => {
    const left = deadlineMs - Date.now()
    if (left <= 0) throw new Error(`memory-dream timed out before ${label}`)
    return left
  }
  const within = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`memory-dream timed out during ${label}`)), remaining(label))
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // One person's message at the top of the room, mentioning the agent: a fresh thread, so a fresh session.
  const say = async (name: MemoryDreamStep['name'], text: string): Promise<MemoryDreamStep> => {
    const messageId = world.mintMessageId('slack')
    world.registerRoomMessage(room.channel, messageId)
    const body = `<@${integration.botUserId}> ${text}`
    world.recordThreadMessage(room.channel, messageId, {
      ts: messageId,
      text: body,
      sender: operator.userId,
      isBot: false
    })
    world.appendEvent({ type: 'person.message', origin: 'referee', roomId: room.alias, step: name, messageId, text })
    const handle = await harness.inject({
      integrationId: integration.integrationId,
      payload: {
        channel: room.channel,
        messageId,
        text: body,
        sender: { id: operator.userId, name: operator.id },
        mentions: [integration.botUserId]
      }
    })
    const admission = await within(`${name} admission`, () => handle.admission)
    if (!admission.admitted) throw new Error(`the ${name} message was not admitted (${admission.reason})`)
    const completion = await within(`${name} completion`, () => handle.completion)
    const output = world
      .drainOutboundEffects()
      .filter(
        (effect) =>
          effect.status === 'delivered' &&
          effect.agentId === agent.agentId &&
          (effect.kind === 'reply' || effect.kind === 'finalize')
      )
      .map((effect) => effect.text.trim())
      .filter(Boolean)
      .at(-1)
    const step: MemoryDreamStep = { name, status: completion.status, output: output ?? '' }
    steps.push(step)
    world.appendEvent({ type: 'agent.reply', origin: 'agent_effect', roomId: room.alias, step: name, ...step })
    if (completion.status !== 'completed') throw new Error(`the ${name} turn ended ${completion.status}`)
    return step
  }

  try {
    await within('daemon startup', () => harness.start())
    await say('save', MEMORY_DREAM_PROMPTS.save)
    await say('correct', MEMORY_DREAM_PROMPTS.correct)
    await within('idle before the dream', () => harness.waitUntilIdle(remaining('idle before the dream')))
    dream = await within('dream', () => harness.dream({ agentId: agent.agentId, timeoutMs: remaining('dream') }))
    world.appendEvent({ type: 'dream', origin: 'referee', ...dream })
    if (dream.status === 'unavailable') throw new Error('the subject cannot dream: memory is off or not managed')
    if (dream.status !== 'adopted') {
      status = 'agent_failed'
      error = `the dream ended ${dream.status}${dream.error ? ` (${dream.error})` : ''}`
    }
    await say('recall', MEMORY_DREAM_PROMPTS.recall)
    await within('idle after recall', () => harness.waitUntilIdle(remaining('idle after recall')))
  } catch (err) {
    status = 'infra_error'
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await harness.stop()
    } catch (err) {
      status = 'infra_error'
      error ??= err instanceof Error ? err.message : String(err)
    }
    try {
      harness.eventCollector().writeJsonl(paths.events)
      writeFileSync(
        paths.worldEvents,
        `${world
          .events()
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
        {
          mode: 0o600
        }
      )
    } catch (err) {
      status = 'infra_error'
      error ??= err instanceof Error ? err.message : String(err)
    }
    if (!options.keepSubject) subject.cleanup()
  }
  const output = steps.find((step) => step.name === 'recall')?.output ?? ''
  return { status, output, steps, ...(dream ? { dream } : {}), ...(error ? { error } : {}), paths }
}
