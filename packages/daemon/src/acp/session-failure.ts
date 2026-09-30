import { z } from 'zod'

// codex-acp's negotiated Air v1 extension carries terminal failures in session/prompt response metadata.
export const SESSION_FAILURE_CAPABILITIES = {
  jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } }
}

const failureMeta = z.object({
  jetbrains: z.object({
    air: z.object({
      version: z.literal(1),
      sessionFailure: z.object({
        severity: z.enum(['warning', 'error']),
        category: z.string(),
        title: z.string().min(1),
        actions: z.array(z.string())
      })
    })
  })
})

export class RuntimeSessionFailure extends Error {
  readonly category: string
  readonly actions: readonly string[]
  readonly retryable: boolean

  constructor(failure: { category: string; title: string; actions: readonly string[] }) {
    super(failure.title)
    this.name = 'RuntimeSessionFailure'
    this.category = failure.category
    this.actions = failure.actions
    this.retryable = failure.actions.includes('retry')
  }
}

export function sessionFailureFromMeta(meta: unknown): RuntimeSessionFailure | undefined {
  const parsed = failureMeta.safeParse(meta)
  if (!parsed.success) return undefined
  const failure = parsed.data.jetbrains.air.sessionFailure
  return failure.severity === 'error' ? new RuntimeSessionFailure(failure) : undefined
}
