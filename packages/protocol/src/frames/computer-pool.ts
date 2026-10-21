import { z } from 'zod'

// Managed computers in the Kubernetes pool (computer-use.md §15.1): allocation on the daemon wire, claims on pool members.

/** How a managed computer relates to agents; a self-hosted computer has none. */
export const COMPUTER_ALLOCATIONS = ['ephemeral', 'per-agent', 'manual'] as const
export type ComputerAllocation = (typeof COMPUTER_ALLOCATIONS)[number]

/** The allocation modes an agent may pick for itself; `manual` computers are granted through policy instead. */
export const COMPUTER_MANAGED_MODES = ['ephemeral', 'per-agent'] as const
export type ComputerManagedMode = (typeof COMPUTER_MANAGED_MODES)[number]

/** The longest a session is told to wait before it asks again. */
export const COMPUTER_POOL_RETRY_MAX_MS = 30_000

// D→C REQ on the daemon wire, behind `computer-pool-v1`: the session's managed computer, allocated or woken on demand.
export const ComputerPoolAcquire = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  // A granted Computer to wake before first use; absent asks for the agent's own managed computer.
  computerId: z.string().uuid().optional()
})
export type ComputerPoolAcquire = z.infer<typeof ComputerPoolAcquire>

/** Why no managed computer can be had; each is definite, so the session stops asking. */
export const COMPUTER_POOL_REFUSALS = ['not_configured', 'no_pool', 'denied', 'volume_missing', 'failed'] as const
export type ComputerPoolRefusal = (typeof COMPUTER_POOL_REFUSALS)[number]

/** Where a pending managed computer is on its way to ready. */
export const COMPUTER_POOL_PENDING_PHASES = ['provisioning', 'registering', 'waking', 'connecting'] as const
export type ComputerPoolPendingPhase = (typeof COMPUTER_POOL_PENDING_PHASES)[number]

// C→D REP: ready to use, still coming up (ask again after `retryAfterMs`), or refused.
export const ComputerPoolAcquireResult = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    computerId: z.string().uuid(),
    // Absent for a self-hosted Computer, which the pool neither starts nor stops.
    allocation: z.enum(COMPUTER_ALLOCATIONS).optional()
  }),
  z.object({
    state: z.literal('pending'),
    computerId: z.string().uuid().optional(),
    phase: z.enum(COMPUTER_POOL_PENDING_PHASES),
    retryAfterMs: z.number().int().min(100).max(COMPUTER_POOL_RETRY_MAX_MS)
  }),
  z.object({
    state: z.literal('failed'),
    code: z.enum(COMPUTER_POOL_REFUSALS),
    message: z.string().max(500)
  })
])
export type ComputerPoolAcquireResult = z.infer<typeof ComputerPoolAcquireResult>

/** The one-time registration a fresh desktop pod spends; NEVER log it. */
export const ComputerPoolRegistration = z.object({
  token: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(200)
})
export type ComputerPoolRegistration = z.infer<typeof ComputerPoolRegistration>

// C→D REQ to a pool member, behind `computer-pool-member-v1`: drive one desktop claim, delete it, or list them.
export const ComputerPoolOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('ensure'),
    computerId: z.string().uuid(),
    allocation: z.enum(COMPUTER_ALLOCATIONS),
    // false suspends the pod and keeps its volume; true creates or resumes it.
    running: z.boolean(),
    // false never creates a claim, so a wake finds a lost volume instead of starting an empty one.
    create: z.boolean(),
    // Pushed to the pod once it is up and unregistered.
    registration: ComputerPoolRegistration.optional()
  }),
  z.object({ op: z.literal('delete'), computerId: z.string().uuid() }),
  z.object({ op: z.literal('list') })
])
export type ComputerPoolOp = z.infer<typeof ComputerPoolOp>

/** What a pool member saw of one desktop. */
export const ComputerPoolClaimState = z.object({
  computerId: z.string().uuid(),
  // missing: no claim (never made, or deleted with its volume); deleted: this call deleted it.
  claim: z.enum(['present', 'missing', 'deleted']),
  // starting: claimed but no ready pod yet; failed: the pod cannot start. Absent in a `list`, which reads claims only.
  pod: z.enum(['none', 'starting', 'running', 'suspended', 'failed']).optional(),
  // The pod's own answer once running: whether it holds a key, and for which Computer.
  registered: z.boolean().optional(),
  registeredComputerId: z.string().uuid().optional(),
  createdAt: z.string().datetime().optional(),
  detail: z.string().max(500).optional()
})
export type ComputerPoolClaimState = z.infer<typeof ComputerPoolClaimState>

export const COMPUTER_POOL_LIST_MAX = 2000

// D→C REP to `computer-pool/op`: the claim's state after the call, or every desktop claim for `list`.
export const ComputerPoolOpResult = z.object({
  ok: z.boolean(),
  state: ComputerPoolClaimState.optional(),
  claims: z.array(ComputerPoolClaimState).max(COMPUTER_POOL_LIST_MAX).optional(),
  error: z.string().max(500).optional()
})
export type ComputerPoolOpResult = z.infer<typeof ComputerPoolOpResult>
