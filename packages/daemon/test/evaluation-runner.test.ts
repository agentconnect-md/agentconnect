import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { detectSandbox } from '../src/acp/sandbox.js'
import {
  AtifTrajectorySchema,
  EvaluationEventEmitter,
  EvaluationRunManifestSchema,
  EvaluationRunner,
  RawAcpEvaluationRunner
} from '../src/evaluation/index.js'

const AGENT_ID = 'runner-agent'
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scriptable-acp-agent.mjs')

function subjectTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-evaluation-subject-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: true, key: 'template-control-secret' },
      runtimes: {
        test: {
          command: 'node',
          args: ['unused', '--api-key', 'ARGUMENT-SECRET-7319'],
          env: [{ name: 'OPENAI_API_KEY', value: 'RUNTIME-SECRET-7319' }]
        }
      }
    })
  )
  const agentDir = join(root, 'agents', AGENT_ID)
  mkdirSync(join(agentDir, 'memory'), { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: 'Runner Agent',
      status: 'active',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: '/must/not/be-used' },
      integrations: [],
      output: { mode: 'medium' },
      memory: { provider: 'managed' }
    })
  )
  writeFileSync(join(agentDir, 'memory', 'MEMORY.md'), '# Seed memory\n')
  return root
}

describe('EvaluationRunner', () => {
  it('isolates a full-daemon treatment and writes validated event, ATIF, and manifest artifacts', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-'))
    let preparedRoot = ''
    let preparedAgent: Record<string, any> | undefined
    let preparedWorkspaceExists = false
    let onUpdate!: (sessionId: string, update: unknown) => void
    let session = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `runner-session-${++session}`),
      hasSession: vi.fn(() => true),
      usesMetaSystemPrompt: vi.fn(() => true),
      acpAgentInfo: vi.fn(() => ({ name: 'scripted-acp', version: '9.9.9' })),
      acpProtocolVersion: vi.fn(() => 1),
      modelOptions: vi.fn(() => ({ current: 'test-model', models: ['test-model'] })),
      prompt: vi.fn(async (sessionId: string, blocks: Array<{ type: string; text?: string }>) => {
        const prompt = blocks.map((block) => block.text ?? '').join('\n')
        onUpdate(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'unmatched-secret-probe',
          status: 'completed',
          rawOutput: { detail: 'RUNTIME-SECRET-7319', cli: 'ARGUMENT-SECRET-7319' }
        })
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `answer:${prompt.includes('recall') ? 'recall' : 'seed'}` }
        })
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 7,
            inputTokens: 3,
            outputTokens: 2,
            cachedReadTokens: 1,
            cachedWriteTokens: 1
          }
        }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot,
      treatment: { name: 'memory-off', memory: 'off' },
      agentConnect: { commit: 'abc123', dirty: false },
      daemonFactory: ({ root, evaluation }) => {
        preparedRoot = root
        preparedAgent = JSON.parse(readFileSync(join(root, 'agents', AGENT_ID, 'agent.json'), 'utf8'))
        preparedWorkspaceExists = existsSync(preparedAgent!.workspace.path)
        return new Daemon({
          root,
          evaluation,
          hostFactory: (_agent, callback) => {
            onUpdate = callback
            return host as any
          }
        })
      }
    })

    const result = await runner.run({
      id: 'cross-session-memory',
      rootAgentId: AGENT_ID,
      turns: [
        { agentId: AGENT_ID, conversationId: 'seed-session', text: 'seed a fact' },
        { agentId: AGENT_ID, conversationId: 'recall-session', text: 'recall the fact' }
      ]
    })

    expect(result.status).toBe('passed')
    expect(result.output).toBe('answer:recall')
    expect(result.turns).toHaveLength(2)
    expect(preparedAgent).toMatchObject({
      memory: { provider: 'none' },
      integrations: [],
      crons: [],
      mcpServers: [],
      workspace: { mode: 'from-scratch' }
    })
    expect(preparedAgent?.workspace.path).toContain(preparedRoot)
    expect(preparedWorkspaceExists).toBe(true)
    expect(existsSync(preparedRoot)).toBe(false)

    const manifest = EvaluationRunManifestSchema.parse(JSON.parse(readFileSync(result.manifestPath, 'utf8')))
    expect(manifest).toMatchObject({
      caseId: 'cross-session-memory',
      treatment: { name: 'memory-off', memory: 'off' },
      status: 'passed',
      agentConnect: { commit: 'abc123', dirty: false },
      subject: {
        model: 'test-model',
        runtimeVersion: '9.9.9',
        provider: 'scripted-acp',
        acpVersion: 1,
        settings: { outputMode: 'medium' }
      },
      metrics: { turns: 2, totalTokens: 14, promptTokens: 10, completionTokens: 4, cachedTokens: 2 }
    })
    expect(
      AtifTrajectorySchema.parse(JSON.parse(readFileSync(result.trajectoryPath, 'utf8'))).steps.length
    ).toBeGreaterThan(0)
    const events = readFileSync(result.eventsPath, 'utf8')
    expect(events).not.toContain('template-control-secret')
    expect(events).not.toContain('RUNTIME-SECRET-7319')
    expect(events).not.toContain('ARGUMENT-SECRET-7319')
    expect(events).toContain('[secret:redacted]')
    expect(events.trim().split('\n').length).toBeGreaterThan(0)
  })

  it('records a raw ACP baseline with AgentConnect context and add-ons absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-raw-subject-'))
    const scenarioPath = join(root, 'scenario.json')
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        prompt: {
          echoConfigOptions: true,
          requestPermission: {
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          },
          updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '$INPUT' } }]
        },
        configOptions: [
          {
            id: 'approvals_reviewer',
            category: '_approvals_reviewer',
            type: 'select',
            currentValue: 'user',
            options: [
              { value: 'user', name: 'User' },
              { value: 'auto_review', name: 'Auto-review' }
            ]
          }
        ]
      })
    )
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: {
          'codex-acp': {
            command: process.execPath,
            args: [FIXTURE],
            env: [{ name: 'AC_SCENARIO', value: scenarioPath }]
          }
        }
      })
    )
    const agentDir = join(root, 'agents', AGENT_ID)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: AGENT_ID,
        name: 'Runner Agent',
        status: 'active',
        runtime: 'codex-acp',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' },
        approvalsReviewer: 'auto_review'
      })
    )
    const runner = new RawAcpEvaluationRunner({
      subjectRoot: root,
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-raw-artifacts-')),
      agentConnect: { commit: 'raw123', dirty: false }
    })
    const result = await runner.run({
      id: 'core-neutrality',
      turns: [{ agentId: AGENT_ID, text: 'hello' }]
    })

    if (!detectSandbox()) {
      expect(result.status).toBe('infra_error')
      expect(result.error?.message).toMatch(/sandbox/i)
      return
    }
    expect(result.status).toBe('passed')
    expect(result.output).toContain('"category":"_approvals_reviewer"')
    expect(result.output).toContain('"currentValue":"auto_review"')
    expect(result.output).toContain('perm:{"outcome":"selected","optionId":"allow"}')
    expect(result.output).toContain('echo:hello')
    const manifest = EvaluationRunManifestSchema.parse(JSON.parse(readFileSync(result.manifestPath, 'utf8')))
    expect(manifest).toMatchObject({
      treatment: { name: 'raw-acp', memory: 'off' },
      subject: { settings: { execution: 'raw-acp', approvalsReviewer: 'auto_review' } }
    })
    const events = readFileSync(result.eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.type)).toEqual([
      'turn.accepted',
      'turn.started',
      'permission.requested',
      'permission.auto_allowed',
      'permission.resolved',
      'acp.update',
      'acp.update',
      'acp.update',
      'turn.completed'
    ])
    expect(JSON.stringify(events)).not.toContain('# Agent')
    expect(JSON.stringify(events)).not.toContain('# Collaborating with other agents')
  })

  it('redacts infrastructure errors and removes the disposable subject root', async () => {
    const secret = 'RUNNER-SECRET-7319'
    let preparedRoot = ''
    let stopped = false
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'daemon-core', memory: 'off' },
      secrets: [secret],
      daemonFactory: ({ root }) => {
        preparedRoot = root
        return {
          start: async () => {
            throw new Error(`runtime rejected ${secret}`)
          },
          stop: async () => {
            stopped = true
          }
        } as unknown as Daemon
      }
    })

    const result = await runner.run({
      id: 'infra-redaction',
      turns: [{ agentId: AGENT_ID, text: 'hello' }]
    })

    expect(result).toMatchObject({
      status: 'infra_error',
      error: { message: 'runtime rejected [secret:redacted]' }
    })
    expect(existsSync(preparedRoot)).toBe(false)
    expect(stopped).toBe(true)
    expect(readFileSync(result.manifestPath, 'utf8')).not.toContain(secret)
  })

  it('rejects path-traversing agent ids before constructing a daemon', async () => {
    const daemonFactory = vi.fn()
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'daemon-core', memory: 'off' },
      daemonFactory
    })

    const result = await runner.run({
      id: 'unsafe-agent-id',
      turns: [{ agentId: '../outside', text: 'must not escape the disposable root' }]
    })

    expect(result).toMatchObject({
      status: 'invalid_case',
      error: { message: expect.stringContaining('not a safe path segment') }
    })
    expect(daemonFactory).not.toHaveBeenCalled()
  })

  it('keeps dot-segment case names inside the configured artifact root', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-'))
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot,
      treatment: { name: '..', memory: 'off' },
      daemonFactory: vi.fn()
    })

    const result = await runner.run({
      id: '..',
      turns: [{ agentId: '../outside', text: 'must not escape either root' }]
    })
    const artifactRelative = relative(artifactRoot, result.artifactDir)

    expect(result.status).toBe('invalid_case')
    expect(artifactRelative).not.toMatch(/^\.\.(?:[/\\]|$)/)
    expect(isAbsolute(artifactRelative)).toBe(false)
    expect(artifactRelative.split(/[/\\]/).slice(0, 2)).toEqual(['evaluation', 'evaluation'])
  })

  it('bounds the full-daemon case deadline and still writes artifacts', async () => {
    let stopped = false
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'daemon-core', memory: 'off' },
      daemonFactory: () =>
        ({
          start: async () => {},
          runEvaluationTurn: () => new Promise<never>(() => {}),
          waitForEvaluationIdle: async () => {},
          stop: async () => {
            stopped = true
          }
        }) as unknown as Daemon
    })

    const result = await runner.run({
      id: 'bounded-timeout',
      timeoutMs: 100,
      turns: [{ agentId: AGENT_ID, text: 'never completes' }]
    })

    expect(result).toMatchObject({
      status: 'infra_error',
      error: { code: 'EVALUATION_TIMEOUT', message: 'turn 1 exceeded the evaluation case deadline' }
    })
    expect(stopped).toBe(true)
    expect(existsSync(result.manifestPath)).toBe(true)
  })

  it('bounds full-daemon startup and classifies the timeout as infrastructure', async () => {
    let stopped = false
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'daemon-core', memory: 'off' },
      daemonFactory: () =>
        ({
          start: () => new Promise<never>(() => {}),
          stop: async () => {
            stopped = true
          }
        }) as unknown as Daemon
    })

    const result = await runner.run({
      id: 'bounded-startup-timeout',
      timeoutMs: 10,
      turns: [{ agentId: AGENT_ID, text: 'never starts' }]
    })

    expect(result).toMatchObject({
      status: 'infra_error',
      error: { code: 'EVALUATION_TIMEOUT', message: 'daemon startup exceeded the evaluation case deadline' }
    })
    expect(stopped).toBe(true)
  })

  it('rejects external memory without an isolated connection fixture', async () => {
    const subjectRoot = subjectTemplate()
    const agentPath = join(subjectRoot, 'agents', AGENT_ID, 'agent.json')
    const agent = JSON.parse(readFileSync(agentPath, 'utf8'))
    agent.memory = { provider: 'external', connectionId: 'connection-1' }
    writeFileSync(agentPath, JSON.stringify(agent))
    const daemonFactory = vi.fn()
    const runner = new EvaluationRunner({
      subjectRoot,
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'memory-only', memory: 'configured' },
      daemonFactory
    })

    const result = await runner.run({
      id: 'unsupported-external-memory',
      turns: [{ agentId: AGENT_ID, text: 'recall' }]
    })

    expect(result).toMatchObject({
      status: 'invalid_case',
      error: { message: expect.stringContaining('requires a separately isolated connection fixture') }
    })
    expect(daemonFactory).not.toHaveBeenCalled()
  })

  it('rejects a memory-configured cell whose subject explicitly disables memory', async () => {
    const subjectRoot = subjectTemplate()
    const agentPath = join(subjectRoot, 'agents', AGENT_ID, 'agent.json')
    const agent = JSON.parse(readFileSync(agentPath, 'utf8'))
    agent.memory = { provider: 'none' }
    writeFileSync(agentPath, JSON.stringify(agent))
    const daemonFactory = vi.fn()
    const runner = new EvaluationRunner({
      subjectRoot,
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'memory-only', memory: 'configured' },
      daemonFactory
    })

    const result = await runner.run({
      id: 'misconfigured-memory-treatment',
      turns: [{ agentId: AGENT_ID, text: 'recall' }]
    })

    expect(result).toMatchObject({
      status: 'invalid_case',
      error: { message: expect.stringContaining('disables memory in a memory-configured treatment') }
    })
    expect(daemonFactory).not.toHaveBeenCalled()
  })

  it('classifies observed provider and memory failures as infrastructure', async () => {
    for (const event of [
      { type: 'turn.failed' as const, data: { code: 'provider_quota_exhausted' } },
      { type: 'memory.recall.failed' as const, data: { errorName: 'MemoryPluginProtocolError' } }
    ]) {
      const runner = new EvaluationRunner({
        subjectRoot: subjectTemplate(),
        artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
        treatment: { name: 'memory-only', memory: 'configured' },
        daemonFactory: ({ evaluation }) => {
          const emitter = new EvaluationEventEmitter({ observer: evaluation.observer, runId: evaluation.runId })
          return {
            start: async () => {},
            runEvaluationTurn: async () => {
              emitter.emit({
                type: 'turn.started',
                agentId: AGENT_ID,
                sessionId: 'root-session',
                turnId: 'root-turn',
                data: { input: 'recall' }
              })
              emitter.emit({
                type: event.type,
                agentId: AGENT_ID,
                sessionId: 'root-session',
                turnId: 'root-turn',
                data: event.data
              })
              return {
                turnId: 'root-turn',
                sessionId: 'root-session',
                output: '',
                events: []
              }
            },
            waitForEvaluationIdle: async () => {},
            stop: async () => {}
          } as unknown as Daemon
        }
      })

      const result = await runner.run({
        id: `observed-infra-${event.type}`,
        turns: [{ agentId: AGENT_ID, text: 'recall' }]
      })
      expect(result).toMatchObject({ status: 'infra_error', error: { code: 'OBSERVED_INFRA_FAILURE' } })
    }
  })

  it('fails the evaluation, but not the product turn, when semantic observation is incomplete', async () => {
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'daemon-core', memory: 'off' },
      daemonFactory: ({ evaluation }) =>
        ({
          start: async () => {
            evaluation.onObserverError?.(new Error('observer export failed'))
          },
          runEvaluationTurn: async () => ({
            turnId: 'completed-turn',
            sessionId: 'completed-session',
            output: 'the product turn still completed',
            events: []
          }),
          waitForEvaluationIdle: async () => {},
          stop: async () => {}
        }) as unknown as Daemon
    })

    const result = await runner.run({
      id: 'observer-health-failure',
      turns: [{ agentId: AGENT_ID, text: 'complete normally' }]
    })

    expect(result).toMatchObject({
      status: 'infra_error',
      output: 'the product turn still completed',
      error: { code: 'EVALUATION_OBSERVER_ERROR', message: 'evaluation observer rejected semantic evidence' }
    })
  })

  it('fails the trial when an asynchronous collaboration turn fails', async () => {
    const runner = new EvaluationRunner({
      subjectRoot: subjectTemplate(),
      artifactRoot: mkdtempSync(join(tmpdir(), 'ac-evaluation-artifacts-')),
      treatment: { name: 'collaboration-only', memory: 'off' },
      daemonFactory: ({ evaluation }) => {
        const emitter = new EvaluationEventEmitter({ observer: evaluation.observer, runId: evaluation.runId })
        return {
          start: async () => {},
          runEvaluationTurn: async () => {
            emitter.emit({
              type: 'turn.started',
              agentId: AGENT_ID,
              sessionId: 'root-session',
              turnId: 'root-turn',
              data: { input: 'delegate' }
            })
            emitter.emit({
              type: 'turn.completed',
              agentId: AGENT_ID,
              sessionId: 'root-session',
              turnId: 'root-turn',
              data: { output: 'delegated' }
            })
            return {
              turnId: 'root-turn',
              sessionId: 'root-session',
              output: 'delegated',
              events: []
            }
          },
          waitForEvaluationIdle: async () => {
            emitter.emit({
              type: 'turn.started',
              agentId: 'fixture-agent',
              sessionId: 'fixture-session',
              turnId: 'fixture-turn',
              data: { input: 'work' }
            })
            emitter.emit({
              type: 'turn.failed',
              agentId: 'fixture-agent',
              sessionId: 'fixture-session',
              turnId: 'fixture-turn',
              data: { code: 'ACP_FAILED' }
            })
          },
          stop: async () => {}
        } as unknown as Daemon
      }
    })

    const result = await runner.run({
      id: 'async-collaboration-failure',
      turns: [{ agentId: AGENT_ID, text: 'delegate' }]
    })

    expect(result).toMatchObject({
      status: 'agent_failed',
      error: {
        code: 'OBSERVED_TURN_FAILURE',
        message: 'turn.failed for agent fixture-agent (ACP_FAILED)'
      }
    })
  })
})
