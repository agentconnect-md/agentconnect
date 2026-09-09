import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MAX_MEMORY_FILE_BYTES } from '../memory/store.js'
import {
  MemoryFsAppendReplySchema,
  AGENT_MEMORY_STORE_V1_FEATURE,
  type MemoryFsReply,
  type MemoryStoreReq,
  MEMORY_TRANSACTION_V1_FEATURE,
  MEMORY_CAPTURE_FENCE_V1_FEATURE,
  type MemoryTransactionReq,
  type MemoryTransactionResult
} from '@agentconnect.md/protocol'
// The `control-plane` memory home: the shim client over the daemon's CP connection (memory-evolution.md §3.2.1), which
// `resolveMemoryHomePorts` selects as `live` for a managed binding whose `home` is `control-plane`, gated at activation.
import { WireError } from '@agentconnect.md/connection'
import { MemoryTooLargeError, MemoryHomeUnavailableError, memoryRelSegments, type MemoryFs } from '../memory/fs.js'
import { MemoryFsClient, settleMemoryFs, type MemoryFsRequester } from '../shim/memory-fs-channel.js'

/** The slice of the CP connection this home rides: the legal-state gate, feature negotiation, the one request pair. */
export interface CpMemoryStoreLink {
  connected(): boolean
  supportsServerFeature(feature: string): boolean
  memoryTransaction?(req: MemoryTransactionReq): Promise<MemoryTransactionResult>
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

  get stageTransactionFile(): MemoryFs['stageTransactionFile'] {
    if (!this.atomicTransaction) return undefined
    return async (root, content) => {
      if (!this.atomicTransaction)
        throw new MemoryHomeUnavailableError('feature', 'the memory home no longer supports transactions')
      const bytes = Buffer.from(content)
      if (bytes.length > MAX_MEMORY_FILE_BYTES)
        throw new MemoryTooLargeError('memory transaction file exceeds its byte limit')
      const requester = cpMemoryFsRequester(this.link, this.agentId)
      const tree = joinTreeRoot(this.root, root)
      const temp = `.agentconnect-memory-${randomUUID()}.tmp`
      try {
        let offset = 0
        do {
          const chunk = bytes.subarray(offset, offset + 32768)
          await settleMemoryFs(
            requester,
            {
              op: 'memory-append',
              root: tree,
              rel: temp,
              content: chunk.toString('base64'),
              encoding: 'base64',
              create: offset === 0
            },
            MemoryFsAppendReplySchema
          )
          offset += chunk.length
        } while (offset < bytes.length)
        return { temp, revision: createHash('sha256').update(bytes).digest('hex') }
      } catch (error) {
        await settleMemoryFs(requester, { op: 'memory-rm', root: tree, rel: temp }, z.null()).catch(() => {})
        throw error
      }
    }
  }

  get captureStatus(): MemoryFs['captureStatus'] {
    if (!this.atomicTransaction || !this.link.supportsServerFeature(MEMORY_CAPTURE_FENCE_V1_FEATURE)) return undefined
    return async (root, sourceTurnId) => {
      const transact = this.atomicTransaction
      if (!transact || !this.link.supportsServerFeature(MEMORY_CAPTURE_FENCE_V1_FEATURE))
        throw new MemoryHomeUnavailableError('feature', 'the memory home no longer supports capture fences')
      let result: MemoryTransactionResult
      try {
        result = await transact({ operation: 'capture-status', root, sourceTurnId })
      } catch (error) {
        // This read has no ambiguous write outcome; classify transport failures for the durable capture outbox.
        if (error instanceof WireError && (error.retryable || error.code === 'SCOPE_DENIED'))
          throw new MemoryHomeUnavailableError(
            error.code === 'SCOPE_DENIED' ? 'scope-denied' : 'connection',
            'memory capture status is unavailable'
          )
        throw error
      }
      if (result.operation !== 'capture-status')
        throw new MemoryHomeUnavailableError('connection', 'memory capture status could not be established')
      return { suppressed: result.suppressed }
    }
  }

  get atomicTransaction(): MemoryFs['atomicTransaction'] {
    if (!this.link.memoryTransaction || !this.link.supportsServerFeature(MEMORY_TRANSACTION_V1_FEATURE))
      return undefined
    return async (request) => {
      if (!this.link.connected())
        throw new MemoryHomeUnavailableError('connection', 'the memory transaction home is unreachable')
      if (!this.link.memoryTransaction || !this.link.supportsServerFeature(MEMORY_TRANSACTION_V1_FEATURE))
        throw new MemoryHomeUnavailableError('feature', 'the memory home no longer supports transactions')
      if (request.operation === 'capture-status' && !this.link.supportsServerFeature(MEMORY_CAPTURE_FENCE_V1_FEATURE))
        throw new MemoryHomeUnavailableError('feature', 'the memory home no longer supports capture fences')
      return this.link.memoryTransaction({
        ...request,
        agentId: this.agentId,
        root: joinTreeRoot(this.root, request.root)
      })
    }
  }

  subdir(rel: string): MemoryFs {
    return new CpMemoryFs(this.link, this.agentId, joinTreeRoot(this.root, rel))
  }
}
