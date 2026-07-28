import { z } from 'zod'
import {
  MEMORY_PLUGIN_PROFILE,
  MEMORY_RECALL_DEFAULTS,
  MEMORY_RECALL_HARD_LIMITS,
  MemoryPluginManifest
} from '../memory-plugin.js'

/**
 * External-memory control-plane distribution (M-5A).
 *
 * The Control Plane owns installations and org connections. A daemon receives
 * a transport-specific private definition. Remote definitions carry a relay URL
 * and purpose-specific bearer grant; local definitions carry an operator
 * allowlist reference and daemon-private secret lease. Raw local commands never
 * cross this wire.
 */

export const MemoryRecallPolicy = z
  .object({
    mode: z.enum(['auto', 'tool-only']).default('auto'),
    topK: z.number().int().positive().max(MEMORY_RECALL_HARD_LIMITS.topK).default(MEMORY_RECALL_DEFAULTS.topK),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(MEMORY_RECALL_HARD_LIMITS.maxBytes)
      .default(MEMORY_RECALL_DEFAULTS.maxBytes),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MEMORY_RECALL_HARD_LIMITS.timeoutMs)
      .default(MEMORY_RECALL_DEFAULTS.timeoutMs)
  })
  .strict()
export type MemoryRecallPolicy = z.infer<typeof MemoryRecallPolicy>

export const MemoryCapturePolicy = z.object({ mode: z.enum(['turn', 'manual']).default('manual') }).strict()
export type MemoryCapturePolicy = z.infer<typeof MemoryCapturePolicy>

/**
 * Dreaming — periodic offline consolidation of the MANAGED store
 * (design: docs/designs/memory-dreaming.md). Valid only with
 * `provider: 'managed'`; the daemon stages a rebuilt store per dream and the
 * user (or the gated auto-adopt path) reviews and adopts it. Bounds mirror the
 * design: sessionWindow ≤ 100 mined transcripts, instructions ≤ 4096 chars.
 */
export const MemoryDreamingPolicy = z
  .object({
    enabled: z.boolean(),
    /** How many recent sessions to mine (default 20). */
    sessionWindow: z.number().int().min(1).max(100).optional(),
    /** Cron expression for scheduled dreams (same syntax as agent crons). A tick
     *  that lands while a dream is already in flight is skipped, not queued. */
    schedule: z.string().min(1).max(128).optional(),
    /** IANA zone the `schedule` is evaluated in (as on agent crons). Absent ⇒ the
     *  daemon host's local time. */
    timezone: z.string().min(1).max(64).optional(),
    /** Operator steering text applied through the whole dream pipeline. */
    instructions: z.string().max(4096).optional(),
    /** Also mine reusable procedures into candidate skills (never auto-installed). */
    mineSkills: z.boolean().optional(),
    /** Adopt the staged store automatically on completion. Admissible only on
     *  runtimes with a trusted extraction channel; the daemon enforces that.
     *  Absent defaults to true for effective managed-memory policies. */
    autoAdopt: z.boolean().optional()
  })
  .strict()
export type MemoryDreamingPolicy = z.infer<typeof MemoryDreamingPolicy>

/** Product default for managed memory with no explicit dreaming policy.
 *
 * The schedule is evaluated in the daemon host's timezone because no timezone
 * is set. Keeping this as an explicit policy lets a saved policy distinguish
 * manual-only dreaming (enabled with no schedule) from the default daily run.
 */
export const DEFAULT_MEMORY_DREAMING_POLICY = {
  enabled: true,
  schedule: '0 4 * * *',
  autoAdopt: true
} as const satisfies MemoryDreamingPolicy

const BuiltInMemoryBinding = z
  .object({
    provider: z.enum(['none', 'native', 'managed']),
    autoDistill: z.boolean().optional(),
    dreaming: MemoryDreamingPolicy.optional()
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.dreaming && binding.provider !== 'managed') {
      ctx.addIssue({
        code: 'custom',
        path: ['dreaming'],
        message: 'dreaming is only supported with the managed memory provider'
      })
    }
  })

export const ExternalMemoryBinding = z
  .object({
    provider: z.literal('external'),
    connectionId: z.string().uuid(),
    recall: MemoryRecallPolicy.default({ mode: 'auto', ...MEMORY_RECALL_DEFAULTS }),
    // The safe default never exports a full turn. Console users must explicitly
    // acknowledge the egress disclosure before selecting turn capture.
    capture: MemoryCapturePolicy.default({ mode: 'manual' })
  })
  .strict()
export type ExternalMemoryBinding = z.infer<typeof ExternalMemoryBinding>

/** Agent-facing provider selection. External bindings carry policy, never endpoints or secrets. */
export const AgentMemoryBinding = z.union([BuiltInMemoryBinding, ExternalMemoryBinding])
export type AgentMemoryBinding = z.infer<typeof AgentMemoryBinding>

/** Resolve the managed-memory dreaming policy used by the daemon.
 *
 * No memory binding means the managed provider, and no explicit dreaming policy
 * means the daily auto-adopting product default. Once a policy exists its absent
 * schedule remains meaningful (manual-only), while absent `autoAdopt` follows
 * the new default; an explicit false is the opt-out.
 */
export function effectiveMemoryDreamingPolicy(
  binding: AgentMemoryBinding | undefined
): MemoryDreamingPolicy | undefined {
  if (binding && binding.provider !== 'managed') return undefined
  const policy = binding?.dreaming
  if (!policy) return { ...DEFAULT_MEMORY_DREAMING_POLICY }
  return policy.autoAdopt === undefined ? { ...policy, autoAdopt: true } : policy
}

/** Reviewed mapping from a logical secret field to the header the relay injects. */
export const MemoryPluginSecretHeaderPin = z
  .object({ name: z.string().min(1).max(128), header: z.string().min(1).max(128), required: z.boolean() })
  .strict()
export type MemoryPluginSecretHeaderPin = z.infer<typeof MemoryPluginSecretHeaderPin>

export const MemoryPluginPin = z
  .object({
    pluginId: z.string().min(1).max(255),
    profileMajor: z.literal(1),
    manifestDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    secretHeaders: z.array(MemoryPluginSecretHeaderPin).max(64).default([])
  })
  .strict()
export type MemoryPluginPin = z.infer<typeof MemoryPluginPin>

const MemoryConnectionSpecBase = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.number().int().positive(),
    config: z.record(z.string(), z.unknown()),
    secretKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
    pin: MemoryPluginPin
  })
  .strict()

const RemoteMemoryConnectionSpec = MemoryConnectionSpecBase.extend({
  transport: z.literal('streamable-http'),
  relayUrl: z.string().url(),
  grantKey: z.string().min(1).max(512)
}).strict()

/** Plaintext values cross only the authenticated daemon control channel and
 * remain in its private registry until they are injected into the allowlisted
 * plugin child. They never enter AgentSpec, agent.json, or the agent runtime. */
export const MemoryConnectionSecretLease = z
  .object({
    values: z.record(
      z.string().min(1).max(128),
      z
        .string()
        .min(1)
        .max(16 * 1024)
        .refine((value) => !value.includes('\0'), 'memory connection secret contains NUL')
    )
  })
  .strict()
  .superRefine((lease, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(lease.values)).byteLength > 64 * 1024) {
      ctx.addIssue({ code: 'custom', path: ['values'], message: 'memory connection secret lease exceeds 64 KiB' })
    }
  })

const StdioMemoryConnectionSpec = MemoryConnectionSpecBase.extend({
  transport: z.literal('stdio'),
  // This is a logical lookup key in the daemon operator's local allowlist, not
  // a path/command supplied by the tenant or Control Plane.
  commandRef: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'commandRef must be an allowlist key'),
  secretLease: MemoryConnectionSecretLease
})
  .strict()
  .superRefine((spec, ctx) => {
    const keys = Object.keys(spec.secretLease.values).sort()
    const declared = [...spec.secretKeys].sort()
    if (keys.length !== declared.length || keys.some((key, index) => key !== declared[index])) {
      ctx.addIssue({ code: 'custom', path: ['secretLease'], message: 'secret lease keys must match secretKeys' })
    }
  })

const TransportedMemoryConnectionSpec = z.discriminatedUnion('transport', [
  RemoteMemoryConnectionSpec,
  StdioMemoryConnectionSpec
])

/** One daemon-private connection definition. Both relay grants and local secret
 * leases are secret-bearing; callers must never log this frame or validation
 * payload. Local commands are resolved solely from the operator allowlist.
 *
 * M-5A remote frames predate the transport discriminator. Decode them as
 * Streamable HTTP so daemons can be upgraded before the Control Plane during a
 * rolling deployment; the encoder likewise keeps remote frames legacy-shaped
 * until the old daemon population is gone. */
export const MemoryConnectionSpec = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || 'transport' in input) return input
  if ('relayUrl' in input && 'grantKey' in input) return { ...input, transport: 'streamable-http' }
  return input
}, TransportedMemoryConnectionSpec)
export type MemoryConnectionSpec = z.infer<typeof MemoryConnectionSpec>

/** C→D live CRUD; reconnect baseline is `register/ok.memoryConnections`. */
export const MemoryConnectionUpsert = MemoryConnectionSpec
export type MemoryConnectionUpsert = z.infer<typeof MemoryConnectionUpsert>

export const MemoryConnectionRemove = z.object({ connectionId: z.string().uuid() }).strict()
export type MemoryConnectionRemove = z.infer<typeof MemoryConnectionRemove>

/** Stable, body-free probe fact for one connection revision. */
export const MemoryConnectionFact = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.number().int().positive(),
    pluginId: z.string().min(1).max(255),
    version: z.string().max(128).optional(),
    profile: z.literal(MEMORY_PLUGIN_PROFILE).optional(),
    manifestDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    capabilities: MemoryPluginManifest.shape.capabilities.optional(),
    declaredEgressHosts: z.array(z.string().min(1).max(255)).max(128).optional(),
    status: z.enum(['probing', 'ready', 'degraded', 'invalid']),
    reasonCode: z.string().min(1).max(128).optional()
  })
  .strict()
export type MemoryConnectionFact = z.infer<typeof MemoryConnectionFact>

/** D→C full snapshot. Re-emitted on reconnect and after every probe transition. */
export const MemoryConnectionFacts = z.object({ connections: z.array(MemoryConnectionFact).max(1_024) }).strict()
export type MemoryConnectionFacts = z.infer<typeof MemoryConnectionFacts>
