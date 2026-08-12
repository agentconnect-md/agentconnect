import { z } from 'zod'

// Fail-fast env parsing, mirroring the control-plane loadConfig pattern.
const EnvSchema = z.object({
  AC_ORG_NAMESPACE_PREFIX: z.string().min(1, 'AC_ORG_NAMESPACE_PREFIX must be a non-empty install-time constant'),
  AC_TOKENREVIEW_CLUSTERROLE: z
    .string()
    .min(1, "AC_TOKENREVIEW_CLUSTERROLE must name this install's tokenreview ClusterRole"),
  AC_MASTER_TEMPLATE_PREFIX: z.string().min(1).default('ac-runtime-'),
  AC_DAEMON_STORAGE_CLASS: z.string().trim().optional(),
  AC_DAEMON_STORAGE_SIZE: z.string().trim().min(1).default('10Gi'),
  AC_RESYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(600),
  AC_LEASE_NAME: z.string().min(1).default('agentconnect-operator'),
  AC_WATCH_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300)
})

export interface OperatorConfig {
  /** Install-time constant: every org namespace this install owns starts with it. */
  orgNamespacePrefix: string
  /** The install's release-prefixed tokenreview ClusterRole, bound per org envelope. */
  tokenreviewClusterRole: string
  /** Master SandboxTemplates in the control namespace are named `<prefix><tier>`. */
  masterTemplatePrefix: string
  /** StorageClass for the daemon state PVC; undefined leaves the claim on the cluster default. */
  daemonStorageClass?: string
  /** Requested size of the daemon state PVC. */
  daemonStorageSize: string
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
    tokenreviewClusterRole: parsed.data.AC_TOKENREVIEW_CLUSTERROLE,
    masterTemplatePrefix: parsed.data.AC_MASTER_TEMPLATE_PREFIX,
    // Blank reads as unset: an env rendered from an empty chart value must mean the default, not a class named ''.
    daemonStorageClass: parsed.data.AC_DAEMON_STORAGE_CLASS || undefined,
    daemonStorageSize: parsed.data.AC_DAEMON_STORAGE_SIZE,
    resyncIntervalMs: parsed.data.AC_RESYNC_INTERVAL_SECONDS * 1000,
    leaseName: parsed.data.AC_LEASE_NAME,
    watchTimeoutSeconds: parsed.data.AC_WATCH_TIMEOUT_SECONDS
  }
}
