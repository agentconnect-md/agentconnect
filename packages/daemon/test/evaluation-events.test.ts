import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EVALUATION_RUN_SCHEMA_VERSION,
  EvaluationEventCollector,
  EvaluationEventEmitter,
  EvaluationRunManifestSchema,
  compositeEvaluationObserver,
  evaluationEventAttributes,
  writeEvaluationRunManifest
} from '../src/evaluation/index.js'

const tsxImport = createRequire(import.meta.url).resolve('tsx')

describe('evaluation event evidence', () => {
  it('adds a stable validated envelope and monotonic sequence', () => {
    const collector = new EvaluationEventCollector()
    const emitter = new EvaluationEventEmitter({
      observer: collector,
      runId: 'run-1',
      now: () => Date.parse('2026-07-21T00:00:00.000Z')
    })

    emitter.emit({ type: 'turn.started', agentId: 'agent-a', turnId: 'turn-1', data: { input: 'hello' } })
    emitter.emit({ type: 'turn.completed', agentId: 'agent-a', turnId: 'turn-1' })

    expect(collector.events()).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        eventId: 'run-1:1',
        sequence: 1,
        occurredAt: '2026-07-21T00:00:00.000Z',
        type: 'turn.started'
      }),
      expect.objectContaining({ eventId: 'run-1:2', sequence: 2, type: 'turn.completed' })
    ])
  })

  it('accepts metadata-only memory dream lifecycle evidence', () => {
    const collector = new EvaluationEventCollector()
    const emitter = new EvaluationEventEmitter({ observer: collector, runId: 'run-dream' })

    emitter.emit({
      type: 'memory.dream.completed',
      agentId: 'agent-a',
      sessionId: 'dream-session-1',
      data: {
        dreamId: 'drm-1',
        trigger: 'schedule',
        sourceSessionCount: 2,
        model: 'gpt-5.6',
        usage: { totalTokens: 120, costAmount: 0.012, costCurrency: 'USD' }
      }
    })

    expect(collector.events()[0]).toMatchObject({
      type: 'memory.dream.completed',
      sessionId: 'dream-session-1',
      data: { dreamId: 'drm-1', sourceSessionCount: 2, model: 'gpt-5.6' }
    })
  })

  it('contains observer errors without starving the other observers', () => {
    const delivered: string[] = []
    const onObserverError = vi.fn()
    const observer = compositeEvaluationObserver(
      { emit: () => void delivered.push('first') },
      {
        emit: () =>
          void (() => {
            throw new Error('observer failed')
          })()
      },
      { emit: () => void delivered.push('last') }
    )
    const emitter = new EvaluationEventEmitter({ observer, runId: 'run-2', onObserverError })

    expect(() => emitter.emit({ type: 'turn.accepted' })).not.toThrow()
    expect(delivered).toEqual(['first', 'last'])
    expect(onObserverError).toHaveBeenCalledOnce()
  })

  it('contains failures from the observer-error reporter itself', () => {
    const emitter = new EvaluationEventEmitter({
      observer: {
        emit: () =>
          void (() => {
            throw new Error('observer failed')
          })()
      },
      runId: 'run-observer-reporter',
      onObserverError: () => {
        throw new Error('error reporter failed')
      }
    })

    expect(() => emitter.emit({ type: 'turn.accepted' })).not.toThrow()
  })

  it('redacts configured and credential-shaped values before writing JSONL', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-eval-events-'))
    const path = join(root, 'events.jsonl')
    const collector = new EvaluationEventCollector([
      'TOP-SECRET-VALUE',
      JSON.stringify({ credentials: { accessKey: 'STRUCTURED-SECRET-7319' } })
    ])
    const emitter = new EvaluationEventEmitter({ observer: collector, runId: 'run-redaction' })

    emitter.emit({
      type: 'acp.update',
      data: {
        update: {
          output: 'TOP-SECRET-VALUE',
          token: 'sk_agent_abcdefghijklmnopqrstuvwxyz',
          structuredLeaf: 'STRUCTURED-SECRET-7319',
          awsKey: 'AKIAIOSFODNN7EXAMPLE'
        }
      }
    })
    collector.writeJsonl(path)

    const written = readFileSync(path, 'utf8')
    expect(written).toContain('[secret:redacted]')
    expect(written).toContain('[credential:redacted]')
    expect(written).not.toContain('TOP-SECRET-VALUE')
    expect(written).not.toContain('sk_agent_abcdefghijklmnopqrstuvwxyz')
    expect(written).not.toContain('STRUCTURED-SECRET-7319')
    expect(written).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps OTel attributes metadata-only and hashes tool-call correlation ids', () => {
    const collector = new EvaluationEventCollector()
    const emitter = new EvaluationEventEmitter({ observer: collector, runId: 'run-otel' })
    emitter.emit({
      type: 'acp.update',
      agentId: 'agent-a',
      sessionId: 'session-a',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-secret-7319',
          title: 'Run command containing PRIVATE-CONTENT-7319',
          rawInput: {
            tool: 'sendMessage',
            arguments: { message: 'PRIVATE-CONTENT-7319' }
          },
          rawOutput: 'PRIVATE-CONTENT-7319'
        }
      }
    })

    const attributes = evaluationEventAttributes(collector.events()[0]!)
    const encoded = JSON.stringify(attributes)
    expect(encoded).toContain('sendMessage')
    expect(encoded).toContain('sha256:')
    expect(encoded).not.toContain('call-secret-7319')
    expect(encoded).not.toContain('PRIVATE-CONTENT-7319')
  })

  it('starts a recording OTel provider when evaluation export is enabled', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OTEL_TRACES_EXPORTER: 'console',
      AGENTCONNECT_EVAL_TEST_PRIVATE_INPUT: 'PRIVATE-PROMPT-7319'
    }
    for (const name of [
      'OTEL_SDK_DISABLED',
      'OTEL_EXPERIMENTAL_CONFIG_FILE',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
    ]) {
      delete env[name]
    }
    const moduleUrl = new URL('../src/evaluation/telemetry.ts', import.meta.url).href
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        tsxImport,
        '--input-type=module',
        '--eval',
        `const { createEvaluationOtelObserver } = await import(${JSON.stringify(moduleUrl)});` +
          `const observer = createEvaluationOtelObserver('test-version');` +
          `observer.emit({schemaVersion:'agentconnect.eval/v1',runId:'run-recording',eventId:'event-1',sequence:1,occurredAt:'2026-07-21T00:00:00.000Z',type:'turn.started',data:{input:process.env.AGENTCONNECT_EVAL_TEST_PRIVATE_INPUT}});`
      ],
      { env, encoding: 'utf8' }
    )
    const traceIds = [...output.matchAll(/traceId: '([0-9a-f]{32})'/g)].map((match) => match[1])
    expect(traceIds.length).toBeGreaterThanOrEqual(2)
    expect(traceIds.every((traceId) => traceId !== '00000000000000000000000000000000')).toBe(true)
    expect(output).not.toContain('PRIVATE-PROMPT-7319')
  })

  it('fails closed instead of creating non-recording OTel evaluation spans', () => {
    const env = { ...process.env }
    for (const name of [
      'OTEL_SDK_DISABLED',
      'OTEL_EXPERIMENTAL_CONFIG_FILE',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_TRACES_EXPORTER',
      'OTEL_METRICS_EXPORTER'
    ]) {
      delete env[name]
    }
    const moduleUrl = new URL('../src/evaluation/telemetry.ts', import.meta.url).href
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        tsxImport,
        '--input-type=module',
        '--eval',
        `const { createEvaluationOtelObserver } = await import(${JSON.stringify(moduleUrl)});` +
          `try { createEvaluationOtelObserver('test-version'); console.log('unexpected-success'); }` +
          `catch (error) { console.log(error.message); }`
      ],
      { env, encoding: 'utf8' }
    )
    expect(output).toContain('no recording exporter is configured')
    expect(output).not.toContain('unexpected-success')
  })

  it('validates and writes a terminal run manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-eval-run-'))
    const path = join(root, 'run.json')
    const manifest = EvaluationRunManifestSchema.parse({
      schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
      runId: 'run-3',
      caseId: 'memory-cross-session-recall',
      treatment: { name: 'memory-on', memory: 'configured' },
      subject: { runtime: 'codex', model: 'gpt-5.5' },
      agentConnect: { commit: 'abc123', dirty: false },
      startedAt: '2026-07-21T00:00:00.000Z',
      finishedAt: '2026-07-21T00:00:01.000Z',
      status: 'passed',
      artifacts: { events: 'events.jsonl', trajectory: 'trajectory.json' }
    })

    writeEvaluationRunManifest(path, manifest)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'run-3', status: 'passed' })
  })
})
