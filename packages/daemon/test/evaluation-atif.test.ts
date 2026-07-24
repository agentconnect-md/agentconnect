import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATIF_SCHEMA_VERSION,
  AtifTrajectorySchema,
  EvaluationEventCollector,
  EvaluationEventEmitter,
  evaluationEventsToAtif,
  writeAtifTrajectory
} from '../src/evaluation/index.js'

describe('ATIF v1.7 evaluation trajectory', () => {
  it('maps multi-agent turns, tool calls/results, and semantic events to a valid trajectory', () => {
    const collector = new EvaluationEventCollector()
    let now = Date.parse('2026-07-21T00:00:00.000Z')
    const emitter = new EvaluationEventEmitter({ observer: collector, runId: 'run-atif', now: () => now++ })

    emitter.emit({
      type: 'turn.started',
      agentId: 'main',
      turnId: 'turn-main',
      data: { input: 'Ask the specialist' }
    })
    emitter.emit({
      type: 'acp.update',
      agentId: 'main',
      turnId: 'turn-main',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Send to specialist',
          rawInput: { server: 'agentconnect', tool: 'sendMessage', arguments: { to: { toAgent: 'worker' } } }
        }
      }
    })
    emitter.emit({
      type: 'acp.update',
      agentId: 'main',
      turnId: 'turn-main',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput: { delivered: true }
        }
      }
    })
    emitter.emit({
      type: 'collaboration.delivery.admitted',
      agentId: 'main',
      turnId: 'turn-main',
      data: { toAgentId: 'worker', deliveryId: 'delivery-1' }
    })
    emitter.emit({
      type: 'turn.started',
      agentId: 'worker',
      turnId: 'turn-worker',
      data: { input: 'Provide the specialist answer' }
    })
    emitter.emit({
      type: 'acp.update',
      agentId: 'worker',
      turnId: 'turn-worker',
      data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '4' } } }
    })
    emitter.emit({
      type: 'acp.update',
      agentId: 'worker',
      turnId: 'turn-worker',
      data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '2' } } }
    })
    emitter.emit({
      type: 'turn.completed',
      agentId: 'worker',
      turnId: 'turn-worker',
      data: {
        output: '42',
        usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 1 }
      }
    })

    const trajectory = evaluationEventsToAtif(collector.events(), {
      runId: 'run-atif',
      rootAgentId: 'main',
      defaultAgentVersion: '1.0.0',
      agents: {
        main: { name: 'main-agent', version: '1.0.0', modelName: 'gpt-5.5' },
        worker: { name: 'worker-agent', version: '1.0.0', modelName: 'gpt-5.5' }
      }
    })

    expect(trajectory.schema_version).toBe(ATIF_SCHEMA_VERSION)
    expect(trajectory.steps.map((step) => step.step_id)).toEqual([1, 2, 3])
    expect(trajectory.steps[1]).toMatchObject({
      source: 'agent',
      tool_calls: [{ tool_call_id: 'call-1', function_name: 'sendMessage' }],
      observation: { results: [{ source_call_id: 'call-1' }] }
    })
    expect(trajectory.subagent_trajectories).toHaveLength(1)
    expect(trajectory.subagent_trajectories?.[0]).toMatchObject({
      trajectory_id: 'run-atif:worker',
      agent: { name: 'worker-agent' },
      steps: [
        { source: 'user', message: 'Provide the specialist answer' },
        {
          source: 'agent',
          message: '42',
          llm_call_count: 1,
          metrics: { prompt_tokens: 9, completion_tokens: 2, cached_tokens: 3 }
        }
      ],
      final_metrics: {
        total_prompt_tokens: 9,
        total_completion_tokens: 2,
        total_cached_tokens: 3,
        total_steps: 2
      }
    })
    expect(() => AtifTrajectorySchema.parse(trajectory)).not.toThrow()
  })

  it('rejects non-sequential steps and invalid observation references', () => {
    expect(() =>
      AtifTrajectorySchema.parse({
        schema_version: ATIF_SCHEMA_VERSION,
        agent: { name: 'agent', version: '1' },
        steps: [
          {
            step_id: 2,
            source: 'agent',
            message: '',
            tool_calls: [{ tool_call_id: 'call-1', function_name: 'tool', arguments: {} }],
            observation: { results: [{ source_call_id: 'other', content: 'bad' }] }
          }
        ]
      })
    ).toThrow()
  })

  it('requires a step and emits an explicit synthetic terminal step when no events were observed', () => {
    expect(() =>
      AtifTrajectorySchema.parse({
        schema_version: ATIF_SCHEMA_VERSION,
        agent: { name: 'agent', version: '1' },
        steps: []
      })
    ).toThrow()

    const trajectory = evaluationEventsToAtif([], {
      runId: 'run-before-events',
      rootAgentId: 'agent',
      defaultAgentVersion: '1'
    })
    expect(trajectory.steps).toEqual([
      {
        step_id: 1,
        source: 'system',
        message: 'No semantic events were recorded before the evaluation ended.',
        extra: { agentconnect_synthetic_terminal_step: true }
      }
    ])
    expect(trajectory.final_metrics).toEqual({ total_steps: 1 })
  })

  it('writes a schema-valid JSON artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-eval-atif-'))
    const path = join(root, 'trajectory.json')
    const trajectory = AtifTrajectorySchema.parse({
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: 'run-write',
      trajectory_id: 'run-write:agent',
      agent: { name: 'agent', version: '1' },
      steps: [{ step_id: 1, source: 'user', message: 'hello' }],
      final_metrics: { total_steps: 1 }
    })

    writeAtifTrajectory(path, trajectory)
    expect(AtifTrajectorySchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(trajectory)
  })

  it('redacts explicit secrets from ATIF metadata and content before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-eval-atif-redacted-'))
    const path = join(root, 'trajectory.json')
    const secret = 'ATIF-SECRET-7319'
    const trajectory = AtifTrajectorySchema.parse({
      schema_version: ATIF_SCHEMA_VERSION,
      agent: { name: `agent-${secret}`, version: '1' },
      steps: [{ step_id: 1, source: 'user', message: `do not leak ${secret}` }]
    })

    writeAtifTrajectory(path, trajectory, [secret])

    const written = readFileSync(path, 'utf8')
    expect(written).not.toContain(secret)
    expect(written).toContain('[secret:redacted]')
    expect(() => AtifTrajectorySchema.parse(JSON.parse(written))).not.toThrow()
  })
})
