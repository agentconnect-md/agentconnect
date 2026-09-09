// The `control-plane` memory home: the shim client over the daemon's CP connection (memory-evolution.md §3.2.1), which
// `resolveMemoryHomePorts` selects as `live` for a managed binding whose `home` is `control-plane`, gated at activation.
import { AGENT_MEMORY_STORE_V1_FEATURE, type MemoryFsReply, type MemoryStoreReq } from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import { MemoryHomeUnavailableError, memoryRelSegments, type MemoryFs } from '../memory/fs.js'
import { MemoryFsClient, type MemoryFsRequester } from '../shim/memory-fs-channel.js'

/** The slice of the CP connection this home rides: the legal-state gate, feature negotiation, the one request pair. */
export interface CpMemoryStoreLink {
  connected(): boolean
  supportsServerFeature(feature: string): boolean
  memoryStore(req: MemoryStoreReq): Promise<MemoryFsReply>
}

/** The agent's tree itself: the wire's `MemoryFsRoot` refuses an empty string, so `.` is the relative root. */
export const CP_MEMORY_TREE_ROOT = '.'

/** Compose a tree-relative root below another (`.` + `channels` → `channels`, `channels` + `c1` → `channels/c1`). */
export function joinTreeRoot(root: string, rel: string): string {
  return [...memoryRelSegments(root), ...memoryRelSegments(rel)].join('/') || CP_MEMORY_TREE_ROOT
}

/** The CP connection as one agent's requester: each op rides `memory/store` as `{ agentId, op }`. */
export function cpMemoryFsRequester(link: CpMemoryStoreLink, agentId: string): MemoryFsRequester {
  const home = `agent "${agentId}" keeps its memory in the Control Plane, which`
  return async (op) => {
    if (!link.connected()) throw new MemoryHomeUnavailableError('connection', `${home} is unreachable`)
    if (!link.supportsServerFeature(AGENT_MEMORY_STORE_V1_FEATURE)) {
      throw new MemoryHomeUnavailableError('feature', `${home} does not serve the memory store`)
    }
    try {
      return await link.memoryStore({ agentId, op })
    } catch (err) {
      if (err instanceof WireError && err.code === 'SCOPE_DENIED') {
        throw new MemoryHomeUnavailableError('scope-denied', `${home} refused this member: ${err.message}`)
      }
      // A retryable wire error is the connection failing to carry the op (drop, no ack); the CP's own answers are final.
      if (err instanceof WireError && err.retryable) {
        throw new MemoryHomeUnavailableError('connection', `${home} dropped the request: ${err.message}`)
      }
      throw err
    }
  }
}

// The port over the CP. `root` is relative to the agent's tree — the CP resolves the tree, and no pod path ever
// leaves this side — and `key` is the same in every daemon process for one agent and root.
export class CpMemoryFs extends MemoryFsClient {
  constructor(
    private readonly link: CpMemoryStoreLink,
    private readonly agentId: string,
    root: string = CP_MEMORY_TREE_ROOT
  ) {
    const tree = joinTreeRoot(CP_MEMORY_TREE_ROOT, root)
    super(cpMemoryFsRequester(link, agentId), tree, `control-plane:${agentId}:${tree}`)
  }

  subdir(rel: string): MemoryFs {
    return new CpMemoryFs(this.link, this.agentId, joinTreeRoot(this.root, rel))
  }
}
