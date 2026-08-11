import { z } from 'zod'

// Fail-fast env parsing, mirroring the control-plane loadConfig pattern.
const EnvSchema = z.object({
  AC_ORG_NAMESPACE_PREFIX: z.string().min(1, 'AC_ORG_NAMESPACE_PREFIX must be a non-empty install-time constant'),
  AC_RESYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(600),
  AC_LEASE_NAME: z.string().min(1).default('agentconnect-operator'),
  AC_WATCH_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300)
})

export interface OperatorConfig {
  /** Install-time constant: every org namespace this install owns starts with it. */
  orgNamespacePrefix: string
  /** Bounded full-resync interval — the drift-convergence backstop for envelope objects. */
  resyncIntervalMs: number
  leaseName: string
  watchTimeoutSeconds: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`invalid operator configuration: ${details}`)
  }
  return {
    orgNamespacePrefix: parsed.data.AC_ORG_NAMESPACE_PREFIX,
    resyncIntervalMs: parsed.data.AC_RESYNC_INTERVAL_SECONDS * 1000,
    leaseName: parsed.data.AC_LEASE_NAME,
    watchTimeoutSeconds: parsed.data.AC_WATCH_TIMEOUT_SECONDS
  }
}
