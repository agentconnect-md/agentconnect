import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentConnectProvider from '../providers/agentconnect.js'
import type { EvaluationCaseResult, EvaluationTreatment } from '../../packages/daemon/src/evaluation/index.js'

const treatment: EvaluationTreatment = {
  name: 'memory-only',
  memory: 'configured'
}

function result(overrides: Partial<EvaluationCaseResult> = {}): EvaluationCaseResult {
  return {
    runId: 'run-7319',
    status: 'passed',
    output: 'COBALT-HARBOR-7319',
    turns: [
      {
        turnId: 'turn-1',
        sessionId: 'session-1',
        output: 'COBALT-HARBOR-7319',
        events: [],
        usage: { used: 17 }
      }
    ],
    metrics: {
      latencyMs: 731,
      turns: 3,
      toolCalls: 1,
      totalTokens: 31,
      promptTokens: 20,
      completionTokens: 7,
      cachedTokens: 4
    },
    artifactDir: '/artifacts/run-7319',
    manifestPath: '/artifacts/run-7319/run.json',
    eventsPath: '/artifacts/run-7319/events.jsonl',
    trajectoryPath: '/artifacts/run-7319/trajectory.json',
    ...overrides
  }
}

describe('Promptfoo AgentConnect provider', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('drives the selected daemon treatment and returns score evidence metadata', async () => {
    // This assertion exercises the repository-state fallback, so make it
    // independent of ambient GitHub Actions commit metadata.
    vi.stubEnv('AGENTCONNECT_EVAL_COMMIT', '')
    vi.stubEnv('GITHUB_SHA', '')
    let selectedTreatment: EvaluationTreatment | undefined
    let selectedArtifactRoot: string | undefined
    let selectedAgentConnect: { commit?: string; dirty?: boolean } | undefined
    const provider = new AgentConnectProvider(
      {
        id: 'agentconnect-memory',
        config: { mode: 'daemon', subjectRoot: '/subject', artifactRoot: '/artifacts', treatment }
      },
      {
        repositoryState: () => ({ commit: 'repository-commit-7319', dirty: false }),
        daemonRunner: (options) => {
          selectedTreatment = options.treatment
          selectedArtifactRoot = options.artifactRoot
          selectedAgentConnect = options.agentConnect
          return { run: async () => result() }
        }
      }
    )

    const response = await provider.callApi(
      JSON.stringify({
        id: 'memory-cross-session-recall',
        turns: [{ agentId: 'root', text: 'recall it' }]
      })
    )

    expect(provider.id()).toBe('agentconnect-memory')
    expect(selectedTreatment).toEqual(treatment)
    expect(selectedArtifactRoot).toBe('/artifacts/runs')
    expect(selectedAgentConnect).toEqual({ commit: 'repository-commit-7319', dirty: false })
    expect(response).toMatchObject({
      output: 'COBALT-HARBOR-7319',
      tokenUsage: { prompt: 20, completion: 7, cached: 4, total: 31, numRequests: 3 },
      metadata: {
        caseId: 'memory-cross-session-recall',
        mode: 'daemon',
        treatment,
        runId: 'run-7319',
        status: 'passed',
        artifacts: { manifest: '/artifacts/run-7319/run.json' }
      }
    })
  })

  it('surfaces terminal trial status separately from invalid provider input', async () => {
    const provider = new AgentConnectProvider(
      {
        config: { mode: 'raw-acp', name: 'raw-acp', subjectRoot: '/subject', artifactRoot: '/artifacts' }
      },
      {
        rawRunner: () => ({
          run: async () =>
            result({
              status: 'agent_failed',
              error: { code: 'TURN_FAILED', message: 'runtime failed safely' }
            })
        })
      }
    )
    const failed = await provider.callApi(
      JSON.stringify({ id: 'core-simple-instruction', turns: [{ agentId: 'root', text: 'hello' }] })
    )
    const invalid = await provider.callApi('{broken')

    expect(failed).toMatchObject({
      error: 'agent_failed: runtime failed safely',
      metadata: { status: 'agent_failed', treatment: { name: 'raw-acp', memory: 'off' } }
    })
    expect(invalid).toMatchObject({ metadata: { status: 'invalid_case' } })
    expect(invalid.error).toBeTruthy()
  })

  it('does not double-count cached prompt tokens when deriving a missing total', async () => {
    const provider = new AgentConnectProvider(
      {
        config: { mode: 'daemon', subjectRoot: '/subject', artifactRoot: '/artifacts', treatment }
      },
      {
        daemonRunner: () => ({
          run: async () =>
            result({
              metrics: {
                latencyMs: 1,
                turns: 1,
                toolCalls: 0,
                promptTokens: 20,
                completionTokens: 7,
                cachedTokens: 4
              }
            })
        })
      }
    )

    const response = await provider.callApi(
      JSON.stringify({ id: 'cache-accounting', turns: [{ agentId: 'root', text: 'hello' }] })
    )
    expect(response.tokenUsage).toEqual({ prompt: 20, completion: 7, cached: 4, total: 27, numRequests: 1 })
  })

  it('classifies runner failures as infrastructure errors and redacts environment secrets', async () => {
    vi.stubEnv('AGENTCONNECT_EVAL_TEST_API_KEY', 'provider-secret-7319')
    const provider = new AgentConnectProvider(
      {
        config: { mode: 'daemon', subjectRoot: '/subject', artifactRoot: '/artifacts', treatment }
      },
      {
        daemonRunner: () => ({
          run: async () => {
            throw new Error('runner leaked provider-secret-7319')
          }
        })
      }
    )

    const response = await provider.callApi(
      JSON.stringify({ id: 'infra-error-case', turns: [{ agentId: 'root', text: 'hello' }] })
    )

    expect(response).toMatchObject({ metadata: { caseId: 'infra-error-case', status: 'infra_error' } })
    expect(response.error).not.toContain('provider-secret-7319')
  })
})
