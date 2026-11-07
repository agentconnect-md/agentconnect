import type { HookKind as WireHookKind } from '@agentconnect.md/protocol'
import { $Enums } from '../generated/prisma/client.js'
import type { HookKind } from './ports.js'

// Read off the database enum itself: a code host without hooks has no value there, so a query must never name it.
const STORED_HOOK_KINDS: ReadonlySet<string> = new Set(Object.values($Enums.HookKind))

/** Whether a wire hook kind is one a row can store; a query on any other kind matches nothing. */
export function isStoredHookKind(kind: WireHookKind): kind is HookKind {
  return STORED_HOOK_KINDS.has(kind)
}
