import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { MEMORY_DREAM_PROMPTS, runMemoryDream } from '../games/memory-dream.js'
import MemoryDreamProvider, { parseMemoryDreamCase } from '../providers/memory-dream.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-memory-dream-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** A scripted host: acknowledges every room message, and answers the dream with an empty review queue in read-only mode. */
function scriptedHostFactory(seen: string[]) {
  return (_agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
    let sessions = 0
    return {
      start: async () => {},
      newSession: async () => `scripted-${(sessions += 1)}`,
      hasSession: () => true,
      usesMetaSystemPrompt: () => true,
      modelOptions: () => ({ current: 'scripted', models: ['scripted'] }),
      permissionModeOptions: () => ({ modes: ['read-only'] }),
      setSessionPermissionMode: async () => true,
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        seen.push(text)
        const reply = text.includes('session transcripts')
          ? '{"agentSkills":[],"organizationKnowledge":[],"organizationSkills":[],"revisions":[]}'
          : text.includes('staging database port number')
            ? '5432'
            : 'noted.'
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
        return { stopReason: 'end_turn' }
      },
      discardSession: () => {},
      cancel: async () => {},
      stop: async () => {}
    } as any
  }
}

describe('memory-dream game — scripted engine gate', () => {
  it('mines the public room threads into a dream and reads the recall reply from the room', async () => {
    const seen: string[] = []
    const result = await runMemoryDream({
      seed: 7,
      artifactDir: join(scratch(), 'run'),
      hostFactory: scriptedHostFactory(seen),
      timeoutMs: 90_000
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.steps.map((step) => step.name)).toEqual(['save', 'correct', 'recall'])
    for (const step of result.steps) expect(step.status).toBe('completed')
    // The reply came back through the virtual room, not a webchat sink.
    expect(result.output).toBe('5432')
    // A public, confirmed-internal room's threads use the shared layer, so the dream mined both earlier threads.
    expect(result.dream?.status).toBe('adopted')
    expect(result.dream?.sessionIds).toHaveLength(2)
    // The dream saw the person's correction as transcript evidence.
    const dreamPrompt = seen.find((text) => text.includes('session transcripts'))
    expect(dreamPrompt).toBeDefined()
    expect(seen.some((text) => text.includes(MEMORY_DREAM_PROMPTS.correct))).toBe(true)
    for (const path of [result.paths.events, result.paths.worldEvents]) expect(existsSync(path)).toBe(true)
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(worldEvents.filter((event) => event.type === 'person.message')).toHaveLength(3)
    expect(worldEvents.find((event) => event.type === 'dream')).toMatchObject({ status: 'adopted' })
  }, 120_000)
})

describe('memory-dream provider', () => {
  it('parses a case and refuses malformed ones', () => {
    expect(parseMemoryDreamCase({ kind: 'memory-dream', id: 'x', seed: 3 })).toEqual({
      kind: 'memory-dream',
      id: 'x',
      seed: 3
    })
    expect(() => parseMemoryDreamCase({ kind: 'game', id: 'x' })).toThrow(/kind/)
    expect(() => parseMemoryDreamCase({ kind: 'memory-dream', id: 'x', seed: -1 })).toThrow(/seed/)
  })

  it('runs the game against the configured template and returns the recall reply as output', async () => {
    const run = vi.fn(async () => ({
      status: 'passed' as const,
      output: '6543',
      steps: [{ name: 'recall' as const, status: 'completed', output: '6543' }],
      dream: { dreamId: 'd1', status: 'adopted' as const, sessionIds: ['s1', 's2'] },
      paths: { events: '/tmp/e', worldEvents: '/tmp/w' }
    }))
    const provider = new MemoryDreamProvider(
      { config: { subjectRoot: '/subject', templateAgentId: 'root', artifactRoot: scratch() } },
      { run }
    )
    const response = await provider.callApi(JSON.stringify({ kind: 'memory-dream', id: 'case-1', seed: 5 }))
    expect(response.output).toBe('6543')
    expect(response.error).toBeUndefined()
    expect(response.metadata).toMatchObject({ caseId: 'case-1', status: 'passed', dream: { minedSessions: 2 } })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: 5,
        subject: { kind: 'real', subjectRoot: '/subject', templateAgentIds: ['root'] }
      })
    )
  })

  it('reports a missing subject as an infrastructure error, never as an agent result', async () => {
    const provider = new MemoryDreamProvider({ config: {} }, { run: vi.fn() })
    const saved = { root: process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT, agent: process.env.AGENTCONNECT_EVAL_ROOT_AGENT }
    delete process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT
    delete process.env.AGENTCONNECT_EVAL_ROOT_AGENT
    try {
      const response = await provider.callApi(JSON.stringify({ kind: 'memory-dream', id: 'case-2', seed: 1 }))
      expect(response.error).toMatch(/AGENTCONNECT_EVAL_SUBJECT_ROOT/)
      expect(response.metadata).toMatchObject({ status: 'infra_error' })
    } finally {
      if (saved.root !== undefined) process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT = saved.root
      if (saved.agent !== undefined) process.env.AGENTCONNECT_EVAL_ROOT_AGENT = saved.agent
    }
  })
})
