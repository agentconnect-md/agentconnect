import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { expandSecretVariants } from '../session/secret-mask.js'
import { EvaluationEventSchema, type EvaluationEvent, type EvaluationObserver } from './events.js'

export const EVALUATION_RUN_SCHEMA_VERSION = 'agentconnect.eval-run/v1' as const

export const EvaluationRunStatusSchema = z.enum([
  'passed',
  'agent_failed',
  'safety_failed',
  'infra_error',
  'grader_error',
  'invalid_case'
])

export type EvaluationRunStatus = z.infer<typeof EvaluationRunStatusSchema>

export const EvaluationRunManifestSchema = z.object({
  schemaVersion: z.literal(EVALUATION_RUN_SCHEMA_VERSION),
  runId: z.string().min(1),
  caseId: z.string().min(1),
  treatment: z.object({
    name: z.string().min(1),
    memory: z.enum(['off', 'configured']),
    collaboration: z.enum(['off', 'configured'])
  }),
  subject: z.object({
    runtime: z.string().min(1),
    runtimeVersion: z.string().optional(),
    acpVersion: z.number().int().positive().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  }),
  agentConnect: z.object({
    commit: z.string().min(1),
    dirty: z.boolean()
  }),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  status: EvaluationRunStatusSchema,
  metrics: z
    .object({
      latencyMs: z.number().nonnegative().optional(),
      turns: z.number().int().nonnegative().optional(),
      toolCalls: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      promptTokens: z.number().int().nonnegative().optional(),
      completionTokens: z.number().int().nonnegative().optional(),
      cachedTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional()
    })
    .optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1)
    })
    .optional(),
  artifacts: z.object({
    events: z.string().min(1),
    trajectory: z.string().min(1)
  }),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export type EvaluationRunManifest = z.infer<typeof EvaluationRunManifestSchema>

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk_(?:agent|machine)_[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi
]

function evaluationSecretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 4).flatMap(expandSecretVariants))].sort(
    (a, b) => b.length - a.length
  )
}

function redactWithExplicitSecrets(value: unknown, explicit: readonly string[]): unknown {
  const seen = new WeakSet<object>()

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      let redacted = current
      for (const secret of explicit) redacted = redacted.split(secret).join('[secret:redacted]')
      for (const pattern of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, '[credential:redacted]')
      return redacted
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return '[circular]'
    seen.add(current)
    if (Array.isArray(current)) return current.map(visit)
    return Object.fromEntries(Object.entries(current).map(([key, nested]) => [key, visit(nested)]))
  }

  return visit(value)
}

export function redactEvaluationValue(value: unknown, secrets: readonly string[] = []): unknown {
  return redactWithExplicitSecrets(value, evaluationSecretVariants(secrets))
}

/** Collects validated, redacted events in sequence order. */
export class EvaluationEventCollector implements EvaluationObserver {
  private readonly collected: EvaluationEvent[] = []
  private readonly failures: Error[] = []
  private readonly explicitSecrets: string[]

  constructor(secrets: readonly string[] = []) {
    this.explicitSecrets = evaluationSecretVariants(secrets)
  }

  emit(event: EvaluationEvent): void {
    try {
      const redacted = redactWithExplicitSecrets(event, this.explicitSecrets)
      this.collected.push(EvaluationEventSchema.parse(redacted))
    } catch (error) {
      this.failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  events(): readonly EvaluationEvent[] {
    return [...this.collected].sort((a, b) => a.sequence - b.sequence)
  }

  errors(): readonly Error[] {
    return [...this.failures]
  }

  assertValid(): void {
    if (this.failures.length === 0) return
    throw new AggregateError(this.failures, 'evaluation observer rejected one or more events')
  }

  writeJsonl(path: string): void {
    this.assertValid()
    const body = this.events()
      .map((event) => JSON.stringify(event))
      .join('\n')
    atomicWrite(path, body ? `${body}\n` : '')
  }
}

export function writeEvaluationRunManifest(
  path: string,
  manifest: EvaluationRunManifest,
  secrets: readonly string[] = []
): void {
  const validated = EvaluationRunManifestSchema.parse(redactEvaluationValue(manifest, secrets))
  atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`)
}

export function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The write may have failed before creation or rename may already have won.
    }
    throw error
  }
}
