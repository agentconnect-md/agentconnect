// The CP's rules for a managed binding's `home` (memory-evolution.md §3.2.1, §6): resolved on create, one way on
// update (`daemon` → `control-plane` flags a migration), back only by force, and mandated on the install-wide pool.
import type {
  AgentMemoryBinding,
  ExternalMemoryBinding,
  ManagedMemoryBinding,
  ManagedMemoryHome,
  RuntimeMemoryBinding
} from '@agentconnect.md/protocol'

/** A binding as a client submits it: `home` optional with NO default (absent ⇒ keep), `homeMigration` never accepted. */
export type ManagedMemoryBindingInput = Omit<ManagedMemoryBinding, 'home' | 'homeMigration'> & {
  home?: ManagedMemoryHome
}
export type MemoryBindingInput = ManagedMemoryBindingInput | RuntimeMemoryBinding | ExternalMemoryBinding

/** The home a stored binding means: no binding is the managed default, and a binding older than the field is `daemon`. */
export function managedMemoryHomeOf(memory: AgentMemoryBinding | null | undefined): ManagedMemoryHome | null {
  if (memory && memory.provider !== 'managed') return null
  return (memory as { home?: ManagedMemoryHome } | null | undefined)?.home ?? 'daemon'
}

/** Whether the agent's memory is served by the Control Plane — the only binding the store family answers for. */
export function memoryHomedInControlPlane(memory: AgentMemoryBinding | null | undefined): boolean {
  return managedMemoryHomeOf(memory) === 'control-plane'
}

export const POOL_REFUSES_DAEMON_HOME =
  'the managed pool keeps agent memory in the Control Plane; set memory.home to control-plane or leave it unset'
export const REVERSE_NEEDS_FORCE =
  'moving memory back from the Control Plane to the daemon keeps nothing; send force: true to confirm'
export const POOL_MOVE_NEEDS_CP_HOME =
  'this agent keeps its memory on the daemon; switch memory.home to control-plane before placing it on the managed pool'

export type MemoryBindingRefusal = { refused: 'pool-daemon-home' | 'reverse-needs-force'; message: string }

/** The binding to store for a new agent, or why it is refused. `onPool` ⇒ the placement is the install-wide pool. */
export function resolveMemoryBindingOnCreate(
  input: MemoryBindingInput | undefined,
  onPool: boolean
): { memory: AgentMemoryBinding | undefined } | MemoryBindingRefusal {
  if (input === undefined) {
    return { memory: onPool ? { provider: 'managed', home: 'control-plane' } : undefined }
  }
  if (input.provider !== 'managed') return { memory: input }
  if (onPool) {
    if (input.home === 'daemon') return { refused: 'pool-daemon-home', message: POOL_REFUSES_DAEMON_HOME }
    return { memory: { ...input, home: 'control-plane' } }
  }
  return { memory: { ...input, home: input.home ?? 'daemon' } }
}

export type MemoryBindingUpdate =
  | { kind: 'unchanged' }
  // `dropHome` is the forced return: every row of the agent's CP tree and change log goes with the write.
  | { kind: 'write'; memory: AgentMemoryBinding | null; dropHome: boolean }
  | ({ kind: 'refused' } & MemoryBindingRefusal)

/** The binding to store for an edit. A patch of `null` is the managed default; an absent `home` keeps the current one. */
export function resolveMemoryBindingOnUpdate(
  current: AgentMemoryBinding | null,
  patch: MemoryBindingInput | null | undefined,
  onPool: boolean,
  force: boolean
): MemoryBindingUpdate {
  if (patch === undefined) return { kind: 'unchanged' }
  // A provider without a managed tree drops `home` with the binding; its rows, if any, stay where they are (§6).
  if (patch !== null && patch.provider !== 'managed') return { kind: 'write', memory: patch, dropHome: false }
  const currentHome = managedMemoryHomeOf(current)
  const base: Omit<ManagedMemoryBinding, 'home' | 'homeMigration'> = patch ?? { provider: 'managed' }
  const requested = patch?.home
  // Switching back to managed resolves as on create and never migrates; so does the managed default on the pool.
  if (currentHome === null) {
    const resolved = resolveMemoryBindingOnCreate(patch ?? undefined, onPool)
    if ('refused' in resolved) return { kind: 'refused', ...resolved }
    return { kind: 'write', memory: resolved.memory ?? null, dropHome: false }
  }
  const target = requested ?? currentHome
  if (onPool && target === 'daemon') {
    return { kind: 'refused', refused: 'pool-daemon-home', message: POOL_REFUSES_DAEMON_HOME }
  }
  if (target === currentHome) {
    const pending = current?.provider === 'managed' && current.homeMigration === 'pending'
    if (patch === null && target === 'daemon') return { kind: 'write', memory: null, dropHome: false }
    return {
      kind: 'write',
      memory: { ...base, home: target, ...(pending ? { homeMigration: 'pending' as const } : {}) },
      dropHome: false
    }
  }
  if (target === 'control-plane') {
    return { kind: 'write', memory: { ...base, home: 'control-plane', homeMigration: 'pending' }, dropHome: false }
  }
  if (!force) return { kind: 'refused', refused: 'reverse-needs-force', message: REVERSE_NEEDS_FORCE }
  return { kind: 'write', memory: patch === null ? null : { ...base, home: 'daemon' }, dropHome: true }
}
