import type { ShimCapability } from './protocol.js'

/** What an agent's own channel may do. Deliberately not every capability: `probe` asks an image
 *  what it ships and has no business on a channel serving a tenant's workspace. */
export const RUNTIME_GRANTS: ShimCapability[] = ['acp', 'materialize', 'exec', 'read', 'tunnel', 'automerge', 'skills']

/** A runtime probe runs an ACP runtime through the same driver, and must not thereby receive an
 *  agent's workspace and tunnel authority. */
export const PROBE_GRANTS: ShimCapability[] = ['probe', 'acp']
