import { z } from 'zod'

/**
 * Canonical, backend-neutral contract for an AgentConnect external-memory plugin.
 *
 * This is deliberately NOT a daemon↔CP frame group. Both the daemon's private MCP
 * client and first/third-party plugin implementations import these schemas so the
 * `agentconnect.memory/v1` profile has one executable source of truth. The model
 * never sees the plugin's raw MCP tools; AgentConnect core translates them into a
 * stable product surface.
 */

export const MEMORY_PLUGIN_PROFILE = 'agentconnect.memory/v1' as const
export const MEMORY_PLUGIN_PROFILE_MAJOR = 1 as const

export const MEMORY_PLUGIN_TOOL = {
  manifest: 'agentconnect_memory_manifest',
  recall: 'agentconnect_memory_recall',
  capture: 'agentconnect_memory_capture',
  health: 'agentconnect_memory_health',
  operationStatus: 'agentconnect_memory_operation_status',
  list: 'agentconnect_memory_list',
  get: 'agentconnect_memory_get',
  create: 'agentconnect_memory_create',
  update: 'agentconnect_memory_update',
  delete: 'agentconnect_memory_delete',
  history: 'agentconnect_memory_history'
} as const

export type MemoryPluginToolName = (typeof MEMORY_PLUGIN_TOOL)[keyof typeof MEMORY_PLUGIN_TOOL]

export const MEMORY_RECALL_DEFAULTS = {
  topK: 5,
  maxBytes: 8 * 1024,
  // The budget covers the complete daemon -> relay -> plugin -> embedder
  // round trip. A healthy remote Mem0 search can spend ~1s at the relay alone,
  // so 1s races successful responses instead of representing a useful SLA.
  timeoutMs: 3_000
} as const

// Recall runs before every activation and fails open, so the default budget
// stays bounded while leaving transport headroom around the common warm path.
// The ceiling is deliberately generous:
// a local/self-hosted provider (e.g. Mem0 OSS) can need several seconds on a
// cold first search — embedding-model load plus vector search — and an operator
// must be able to configure a budget that a healthy cold start fits inside
// rather than being forced to degrade it. This is the single source of truth
// for the recall-timeout ceiling shared by the connection policy schema and,
// by contract, the control-plane validation and console input.
export const MEMORY_RECALL_HARD_LIMITS = {
  topK: 20,
  maxBytes: 32 * 1024,
  timeoutMs: 10_000
} as const

export const MemoryScopeKind = z.enum(['agent', 'user', 'session', 'shared'])
export type MemoryScopeKind = z.infer<typeof MemoryScopeKind>

/** The plugin-facing scope. `key` is always derived by daemon core, never tool input. */
export const CanonicalMemoryScope = z
  .object({
    kind: MemoryScopeKind,
    key: z.string().min(1).max(512)
  })
  .strict()
export type CanonicalMemoryScope = z.infer<typeof CanonicalMemoryScope>

export const MemoryRecordProvenance = z
  .object({
    pluginId: z.string().min(1).max(255),
    backendId: z.string().min(1).max(512).optional()
  })
  .strict()

/** The one record shape AgentConnect core understands, regardless of backend. */
export const CanonicalMemoryRecord = z.object({
  id: z.string().min(1).max(512),
  text: z.string().min(1),
  score: z.number().finite().optional(),
  scope: CanonicalMemoryScope,
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  provenance: MemoryRecordProvenance.optional(),
  /** Backend version/ETag for optimistic concurrency on update. */
  version: z.string().min(1).max(512).optional()
})
export type CanonicalMemoryRecord = z.infer<typeof CanonicalMemoryRecord>

export const CaptureReceipt = z.object({
  state: z.enum(['completed', 'accepted', 'failed', 'ambiguous']),
  backendOperationId: z.string().min(1).max(512).optional()
})
export type CaptureReceipt = z.infer<typeof CaptureReceipt>

/** Every operation carries a core-created request, connection, and trusted scope. */
export const MemoryPluginCallContext = z
  .object({
    requestId: z.string().min(1).max(512),
    connection: z
      .object({
        id: z.string().min(1).max(512),
        config: z.record(z.string(), z.unknown())
      })
      .strict(),
    scope: CanonicalMemoryScope
  })
  .strict()
export type MemoryPluginCallContext = z.infer<typeof MemoryPluginCallContext>

export const MemoryPluginOperation = z.enum([
  'recall',
  'capture',
  'list',
  'get',
  'create',
  'update',
  'delete',
  'history'
])
export type MemoryPluginOperation = z.infer<typeof MemoryPluginOperation>

/** Exact machine-readable text tokens for MCP tool results with `isError:true`.
 * MCP validates structuredContent against the success output schema even on an
 * error result, so profile errors use an exact token and never a free-form
 * plugin/upstream message. */
export const MEMORY_PLUGIN_ERROR_TOKEN = {
  conflict: 'agentconnect.memory.error/conflict'
} as const

const unique = <T>(xs: T[]): boolean => new Set(xs).size === xs.length

/** The result of the required manifest tool (`structuredContent` directly). */
export const MemoryPluginManifest = z.object({
  profile: z.literal(MEMORY_PLUGIN_PROFILE),
  plugin: z.object({
    id: z
      .string()
      .max(255)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/, 'plugin id must be reverse-DNS-like'),
    version: z
      .string()
      .max(128)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'plugin version must be semver')
  }),
  connection: z.object({
    // A deliberately bounded JSON-Schema subset is enforced by daemon core during
    // conformance; this field remains JSON here so the console can render it later.
    configSchema: z.record(z.string(), z.unknown()),
    secretFields: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            required: z.boolean(),
            transportHeader: z.string().min(1).max(128).optional()
          })
          .strict()
      )
      .max(64)
      .refine((fields) => unique(fields.map((field) => field.name)), 'secret field names must be unique')
  }),
  capabilities: z
    .object({
      scopes: z.array(MemoryScopeKind).min(1).max(4).refine(unique, 'scope capabilities must be unique'),
      operations: z.array(MemoryPluginOperation).min(2).max(8).refine(unique, 'operation capabilities must be unique'),
      asyncCapture: z.boolean(),
      idempotency: z.enum(['operation-id', 'none'])
    })
    .strict(),
  limits: z
    .object({
      maxQueryBytes: z.number().int().positive(),
      maxRecordBytes: z.number().int().positive(),
      maxBatchItems: z.number().int().positive()
    })
    .strict(),
  declaredEgressHosts: z
    .array(z.string().min(1).max(253))
    .max(128)
    .refine(unique, 'egress hosts must be unique')
    .optional()
})
export type MemoryPluginManifest = z.infer<typeof MemoryPluginManifest>

export const MemoryPluginRecallInput = z
  .object({
    context: MemoryPluginCallContext,
    query: z.string().min(1),
    topK: z.number().int().positive().max(MEMORY_RECALL_HARD_LIMITS.topK),
    maxBytes: z.number().int().positive().max(MEMORY_RECALL_HARD_LIMITS.maxBytes)
  })
  .strict()
export type MemoryPluginRecallInput = z.infer<typeof MemoryPluginRecallInput>

export const MemoryPluginRecallOutput = z.object({ records: z.array(CanonicalMemoryRecord) }).strict()
export type MemoryPluginRecallOutput = z.infer<typeof MemoryPluginRecallOutput>

export const MemoryPluginTurnObservation = z
  .object({
    turnId: z.string().min(1).max(512),
    input: z.string(),
    output: z.string(),
    sessionId: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryPluginTurnObservation = z.infer<typeof MemoryPluginTurnObservation>

export const MemoryPluginCaptureInput = z
  .object({
    context: MemoryPluginCallContext,
    operationId: z.string().min(1).max(512),
    turn: MemoryPluginTurnObservation
  })
  .strict()
export type MemoryPluginCaptureInput = z.infer<typeof MemoryPluginCaptureInput>

export const MemoryPluginCaptureOutput = CaptureReceipt.strict()
export type MemoryPluginCaptureOutput = z.infer<typeof MemoryPluginCaptureOutput>

export const MemoryPluginHealthInput = z.object({ context: MemoryPluginCallContext }).strict()
export type MemoryPluginHealthInput = z.infer<typeof MemoryPluginHealthInput>
export const MemoryPluginHealthOutput = z
  .object({
    status: z.enum(['ready', 'degraded', 'invalid']),
    /** Stable, non-secret diagnostic code. Never an upstream response body. */
    reasonCode: z.string().min(1).max(128).optional()
  })
  .strict()
export type MemoryPluginHealthOutput = z.infer<typeof MemoryPluginHealthOutput>

export const MemoryPluginOperationStatusInput = z
  .object({
    context: MemoryPluginCallContext,
    operationId: z.string().min(1).max(512),
    backendOperationId: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryPluginOperationStatusInput = z.infer<typeof MemoryPluginOperationStatusInput>
export const MemoryPluginOperationStatusOutput = CaptureReceipt.strict()
export type MemoryPluginOperationStatusOutput = z.infer<typeof MemoryPluginOperationStatusOutput>

const OptionalCursor = z.string().min(1).max(2048).optional()

export const MemoryPluginListInput = z
  .object({
    context: MemoryPluginCallContext,
    cursor: OptionalCursor,
    limit: z.number().int().positive().max(100).default(50)
  })
  .strict()
export type MemoryPluginListInput = z.infer<typeof MemoryPluginListInput>
export const MemoryPluginListOutput = z
  .object({ records: z.array(CanonicalMemoryRecord), nextCursor: OptionalCursor })
  .strict()
export type MemoryPluginListOutput = z.infer<typeof MemoryPluginListOutput>

export const MemoryPluginGetInput = z
  .object({ context: MemoryPluginCallContext, id: z.string().min(1).max(512) })
  .strict()
export type MemoryPluginGetInput = z.infer<typeof MemoryPluginGetInput>
export const MemoryPluginGetOutput = z.object({ record: CanonicalMemoryRecord.nullable() }).strict()
export type MemoryPluginGetOutput = z.infer<typeof MemoryPluginGetOutput>

export const MemoryPluginCreateInput = z
  .object({
    context: MemoryPluginCallContext,
    operationId: z.string().min(1).max(512),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
export type MemoryPluginCreateInput = z.infer<typeof MemoryPluginCreateInput>
export const MemoryPluginCreateOutput = z.object({ record: CanonicalMemoryRecord }).strict()
export type MemoryPluginCreateOutput = z.infer<typeof MemoryPluginCreateOutput>

export const MemoryPluginUpdateInput = z
  .object({
    context: MemoryPluginCallContext,
    operationId: z.string().min(1).max(512),
    id: z.string().min(1).max(512),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    version: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryPluginUpdateInput = z.infer<typeof MemoryPluginUpdateInput>
export const MemoryPluginUpdateOutput = z.object({ record: CanonicalMemoryRecord }).strict()
export type MemoryPluginUpdateOutput = z.infer<typeof MemoryPluginUpdateOutput>

export const MemoryPluginDeleteInput = z
  .object({
    context: MemoryPluginCallContext,
    operationId: z.string().min(1).max(512),
    id: z.string().min(1).max(512),
    version: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryPluginDeleteInput = z.infer<typeof MemoryPluginDeleteInput>
export const MemoryPluginDeleteOutput = z.object({ deleted: z.boolean() }).strict()
export type MemoryPluginDeleteOutput = z.infer<typeof MemoryPluginDeleteOutput>

export const MemoryPluginHistoryInput = z
  .object({
    context: MemoryPluginCallContext,
    id: z.string().min(1).max(512),
    cursor: OptionalCursor,
    limit: z.number().int().positive().max(100).default(50)
  })
  .strict()
export type MemoryPluginHistoryInput = z.infer<typeof MemoryPluginHistoryInput>
export const MemoryPluginHistoryEvent = z
  .object({
    id: z.string().min(1).max(512),
    event: z.enum(['create', 'update', 'delete']),
    at: z.string().datetime(),
    record: CanonicalMemoryRecord.optional()
  })
  .strict()
export type MemoryPluginHistoryEvent = z.infer<typeof MemoryPluginHistoryEvent>
export const MemoryPluginHistoryOutput = z
  .object({ events: z.array(MemoryPluginHistoryEvent), nextCursor: OptionalCursor })
  .strict()
export type MemoryPluginHistoryOutput = z.infer<typeof MemoryPluginHistoryOutput>
