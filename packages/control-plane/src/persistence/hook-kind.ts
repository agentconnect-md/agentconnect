import type { HookKind as WireHookKind } from '@agentconnect.md/protocol'
import { $Enums } from '../generated/prisma/client.js'
import type { HookKind } from './ports.js'

// The Prisma enum names a value the database stores under another spelling: `azure_devops` is `azure-devops`.
const DB_SPELLING: Readonly<Partial<Record<HookKind, $Enums.HookKind>>> = { 'azure-devops': 'azure_devops' }

// Read off the database enum itself, in the wire spelling: a query must never name a kind no row can store.
const STORED_HOOK_KINDS: ReadonlySet<string> = new Set(
  Object.values($Enums.HookKind).map((kind) => fromDbHookKind(kind))
)

/** Whether a wire hook kind is one a row can store; a query on any other kind matches nothing. */
export function isStoredHookKind(kind: WireHookKind): kind is HookKind {
  return STORED_HOOK_KINDS.has(kind)
}

/** The Prisma client's spelling of a stored hook kind. */
export function toDbHookKind(kind: HookKind): $Enums.HookKind {
  return DB_SPELLING[kind] ?? (kind as $Enums.HookKind)
}

/** A stored hook kind in the wire spelling, from the Prisma client or a raw query alike. */
export function fromDbHookKind(kind: string): HookKind {
  return (kind === 'azure_devops' ? 'azure-devops' : kind) as HookKind
}
