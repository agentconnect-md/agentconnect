import type { AgentMemoryBinding, CaptureReceipt, ExternalMemoryBinding, MemoryEntry } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../../config/config-schema.js'
import type { ToolDescriptor } from '../../mcp/tool-descriptor.js'
import { MEMORY_TOOLS } from '../tools.js'
import type { MemoryFs, MemoryWriteSource } from '../store.js'
import {
  MemoryProviderUnavailableError,
  type MemoryAdminSurface,
  type MemoryExtractor,
  type MemoryProvider,
  type MemoryProviderKind,
  type MemoryRecord,
  type MemoryNeighborsResult,
  type MemoryReadResult,
  type MemoryScope,
  type MemoryWriteResult,
  type RecallPolicy,
  type RecallRequest,
  type TurnRecord
} from '../types.js'
import { ManagedMemoryProvider } from './managed.js'
import { NativeMemoryProvider } from './native.js'
import { NoMemoryProvider } from './none.js'
import {
  ExternalMemoryProvider,
  type ExternalMemoryRuntimeDeps,
  type PreparedExternalMemoryCapture
} from './external.js'

/** The daemon-side resolvers the dispatcher routes on. */
export interface MemoryProviderDeps {
  /** The port over the agent's MANAGED memory tree — the daemon's one placement decision. */
  memoryFsFor: (agentId: string) => MemoryFs | undefined
  /** The agent's LOCAL root: the runtime's own (native) memory is redirected under it. */
  agentDirByAgent: (agentId: string) => string | undefined
  runtimeFor: (agentId: string) => RuntimeDef | undefined
  providerKindFor: (agentId: string) => MemoryProviderKind
  autoDistillFor?: (agentId: string) => boolean
  extract?: MemoryExtractor
  externalBindingFor?: (agentId: string) => ExternalMemoryBinding | undefined
  externalDeps?: ExternalMemoryRuntimeDeps
}

/**
 * `DispatchingMemoryProvider` — the daemon's single `MemoryProvider`. Routes every
 * scope-bearing call to the agent's configured concrete provider (managed | native),
 * built lazily and cached (both are stateless facades over the resolvers). `external`
 * throws `MemoryProviderUnavailableError` when first needed.
 *
 * `runtimeEnv` is NOT the dispatch path (it has no scope); it throws here to make the
 * misuse obvious — the spawn path uses `memoryProviderFor` directly.
 */
export class DispatchingMemoryProvider implements MemoryProvider {
  readonly kind = 'managed' as const // nominal; real kind is per-agent

  private managed: ManagedMemoryProvider
  private native: NativeMemoryProvider
  private none: NoMemoryProvider

  private readonly providerKindFor: (agentId: string) => MemoryProviderKind
  private readonly externalBindingFor: (agentId: string) => ExternalMemoryBinding | undefined
  private readonly externalDeps: ExternalMemoryRuntimeDeps | undefined

  constructor(deps: MemoryProviderDeps) {
    this.providerKindFor = deps.providerKindFor
    this.externalBindingFor = deps.externalBindingFor ?? (() => undefined)
    this.externalDeps = deps.externalDeps
    this.managed = new ManagedMemoryProvider(deps.memoryFsFor, deps.autoDistillFor ?? (() => false), deps.extract)
    this.native = new NativeMemoryProvider(deps.agentDirByAgent, deps.runtimeFor)
    this.none = new NoMemoryProvider()
  }

  private forAgent(agentId: string): MemoryProvider {
    const kind = this.providerKindFor(agentId)
    if (kind === 'managed') return this.managed
    if (kind === 'native') return this.native
    if (kind === 'none') return this.none
    const binding = this.externalBindingFor(agentId)
    if (!binding || !this.externalDeps) {
      throw new MemoryProviderUnavailableError('external memory runtime is not available')
    }
    return new ExternalMemoryProvider(binding, this.externalDeps)
  }

  private forBinding(agentId: string, binding: AgentMemoryBinding | undefined): MemoryProvider {
    if (!binding || binding.provider === 'managed') return this.managed
    if (binding.provider === 'native') return this.native
    if (binding.provider === 'none') return this.none
    if (!this.externalDeps) throw new MemoryProviderUnavailableError('external memory runtime is not available')
    if (binding.provider === 'external') return new ExternalMemoryProvider(binding, this.externalDeps)
    throw new MemoryProviderUnavailableError(`memory provider for agent ${agentId} is unsupported`)
  }

  runtimeEnv(_runtime: RuntimeDef): Record<string, string> {
    throw new Error('DispatchingMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  ensure(scope: MemoryScope, agentName: string): Promise<void> {
    return this.forAgent(scope.agentId).ensure(scope, agentName)
  }
  standingContextAtSessionStart(scope: MemoryScope): Promise<string> {
    return this.forAgent(scope.agentId).standingContextAtSessionStart(scope)
  }
  recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    return this.forAgent(scope.agentId).recallForTurn(scope, req)
  }
  recallPolicy(scope: MemoryScope): RecallPolicy {
    return this.forAgent(scope.agentId).recallPolicy(scope)
  }
  recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<CaptureReceipt | void> {
    return this.forAgent(scope.agentId).recordTurn(scope, turn)
  }
  /** Post-delivery work is routed through the binding captured at turn start, so
   * a concurrent provider/connection switch can never retarget an old turn. */
  recordTurnForBinding(
    scope: MemoryScope,
    turn: TurnRecord,
    binding: AgentMemoryBinding | undefined,
    target?: PreparedExternalMemoryCapture
  ): Promise<CaptureReceipt | void> {
    const provider = this.forBinding(scope.agentId, binding)
    return provider instanceof ExternalMemoryProvider
      ? provider.recordTurnWithTarget(scope, turn, target)
      : provider.recordTurn(scope, turn)
  }
  /** Capture the exact external definition before a turn starts. */
  captureTargetForBinding(binding: AgentMemoryBinding | undefined): PreparedExternalMemoryCapture | undefined {
    if (binding?.provider !== 'external' || binding.capture.mode !== 'turn' || !this.externalDeps) return undefined
    return new ExternalMemoryProvider(binding, this.externalDeps).prepareCaptureTarget()
  }
  list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.forAgent(scope.agentId).list(scope)
  }
  read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    return this.forAgent(scope.agentId).read(scope, path)
  }

  /** Delegate the memory graph too — without this the tool layer only ever sees the
   *  dispatcher, so `readMemory` would silently never return links or backlinks. */
  async neighbors(scope: MemoryScope, path: string): Promise<MemoryNeighborsResult> {
    const provider = this.forAgent(scope.agentId)
    return (await provider.neighbors?.(scope, path)) ?? { links: [], backlinks: [] }
  }
  write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    return this.forAgent(scope.agentId).write(scope, path, content, ifMatch, source)
  }

  /** The memory tools to inject for a specific agent (the daemon calls this in
   *  `mcpServersFor` — native contributes none). Scope-carrying, unlike the
   *  interface's scopeless `tools()`. */
  toolsForAgent(agentId: string): ToolDescriptor[] {
    return this.forAgent(agentId).toolsForAgent(agentId)
  }

  adminSurfaceForAgent(agentId: string): MemoryAdminSurface {
    return this.forAgent(agentId).adminSurface()
  }

  adminSurface(): null {
    // A dispatcher has no implicit agent scope. Callers that know the agent must
    // use adminSurfaceForAgent(); failing closed prevents an external provider
    // from being accidentally projected as the managed file surface.
    return null
  }

  /** Interface `tools()` has no scope; the daemon uses `toolsForAgent`. Return the
   *  managed set as a safe default (never the live injection path). */
  tools(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }
}
