import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import type {
  McpInvocationMint,
  McpInvocationMinted,
  WebchatMcpDelegationRevoke,
  WebchatMcpDelegationRevoked
} from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import { buildMcpServers, type McpStdioServer } from './inject.js'
import { decodeFrames, encodeFrame, type IpcAttachReq, type IpcRequest, type IpcResponse } from './ipc.js'
import type {
  DelegatedIsolationDenialReason,
  DelegatedMcpMetrics,
  DelegatedMcpRequestStage
} from './delegated-metrics.js'

const PRIVATE_SOCKET_NAME = 'mcp.sock'
const ADMIN_SERVER_NAME = 'agentconnect-admin'
const ADMIN_UNAVAILABLE_ERROR = 'AgentConnect admin tools are temporarily unavailable. Retry shortly.'
const UNKNOWN_TOKEN_ERROR = 'unknown or expired session token'
const DEFAULT_POST_DEADLINE_MS = 125_000
const DEFAULT_RECOVERY_ATTEMPTS = 3
const DEFAULT_RECOVERY_POLL_MS = 250

export const PRIVATE_MCP_MAX_FRAME_BYTES = 256 * 1024
export const PRIVATE_MCP_MAX_PIPELINED_REQUESTS = 8
export const PRIVATE_MCP_MAX_PENDING_REQUESTS = 8
export const PRIVATE_MCP_MAX_CONNECTIONS_PER_BINDING = 8
export const PRIVATE_MCP_MAX_PENDING_REQUESTS_PER_BINDING = 32
export const MAX_CONVERSATION_FENCES = 32_768
export const MAX_SEEN_CELL_IDS = 262_144
const MAX_BINDING_IDENTIFIER_BYTES = 256
const MAX_EXPIRY_BYTES = 64

const ASSERTION_DENIED_BODY = Buffer.from(
  JSON.stringify({ error: 'Unauthorized', statusCode: 401, message: 'invocation assertion denied' })
)
const IN_PROGRESS_BODY = Buffer.from(
  JSON.stringify({ error: 'Conflict', statusCode: 409, message: 'invocation is already in progress' })
)
const AMBIGUOUS_BODY = Buffer.from(
  JSON.stringify({
    error: 'Conflict',
    statusCode: 409,
    message: 'the operation may have taken effect; inspect current state before retrying'
  })
)

export const WEBCHAT_MCP_RECONNECT_ERROR =
  'Your AgentConnect session authorization expired. Reconnect this conversation and retry.'
export const WEBCHAT_MCP_AMBIGUOUS_ERROR = 'The operation may have taken effect. Inspect current state before retrying.'

export interface DelegatedMcpCpClient {
  mintMcpInvocation(input: McpInvocationMint): Promise<McpInvocationMinted>
  revokeWebchatMcpDelegation(input: WebchatMcpDelegationRevoke): Promise<WebchatMcpDelegationRevoked>
}

export interface DelegatedMcpFetchInit {
  method: 'POST'
  headers: {
    authorization: string
    'x-agentconnect-invocation-id': string
    accept: string
    'content-type': string
  }
  body: Buffer
  signal: AbortSignal
}

export interface SessionMcpBrokerDeps {
  /** Trusted daemon-owned root; every per-cell source directory is created below it. */
  socketRoot: string
  /** Fixed directory visible only inside the entitled cell's private mount namespace. */
  inCellSocketDirectory: string
  cliEntry: string
  mcpEndpoint: string
  cpClient: DelegatedMcpCpClient
  fetch?: (url: string, init: DelegatedMcpFetchInit) => Promise<Response>
  now?: () => number
  randomUUID?: () => string
  randomToken?: () => string
  /** Slightly exceeds the CP's 120-second execution boundary. Test-injectable. */
  postDeadlineMs?: number
  recoveryAttempts?: number
  recoveryPollMs?: number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  metrics?: DelegatedMcpMetrics
  /**
   * Test-only capacity reduction. Values are always clamped to the immutable
   * production hard caps, so ordinary construction cannot raise them.
   */
  testCapacityLimits?: {
    maxConversationFences?: number
    maxSeenCellIds?: number
    maxConnectionsPerBinding?: number
    maxPendingRequestsPerBinding?: number
  }
}

export interface RegisterSessionMcpCell {
  isolationCellId: string
  platform: string
  agentId: string
  conversationId: string
  delegationId: string
  generation: number
  expiresAt: string
}

export interface ReleaseSessionMcpCell {
  isolationCellId: string
  agentId: string
  conversationId: string
  delegationId: string
  generation: number
}

/** Immutable authority fence emitted only after a token-authenticated bridge
 * connection for this exact cell transitions from established to closed. */
export type SessionMcpBridgeDisconnected = ReleaseSessionMcpCell

export interface SessionMcpCellMount {
  sourceDirectory: string
  sourceSocketPath: string
  targetDirectory: string
}

interface DelegationHistory {
  generation: number
  delegationId: string
  expiresAt: string
}

interface CellBinding extends RegisterSessionMcpCell {
  expiresAtMs: number
  token: string
  sourceDirectory: string
  sourceSocketPath: string
  descriptor: McpStdioServer
  server: net.Server
  connections: Set<net.Socket>
  pendingRequests: number
  accepting: boolean
  serverClosed: boolean
  sourceRemoved: boolean
}

type RpcResponse = {
  jsonrpc: '2.0'
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

type PostOutcome =
  | { kind: 'rpc'; response: RpcResponse }
  | { kind: 'assertion_denied' }
  | { kind: 'in_progress' }
  | { kind: 'ambiguous' }
  | { kind: 'uncertain' }

class AmbiguousInvocationError extends Error {
  constructor() {
    super(WEBCHAT_MCP_AMBIGUOUS_ERROR)
  }
}

class DefiniteMcpError extends Error {}

function logicalKey(input: Pick<RegisterSessionMcpCell, 'agentId' | 'conversationId'>): string {
  return JSON.stringify([input.agentId, input.conversationId])
}

function validateIdentifier(name: string, value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_BINDING_IDENTIFIER_BYTES
  ) {
    throw new Error(`${name} identifier must be non-empty and at most ${MAX_BINDING_IDENTIFIER_BYTES} bytes`)
  }
}

function capacityLimit(value: number | undefined, hardCap: number, name: string): number {
  if (value === undefined) return hardCap
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} test capacity must be a positive safe integer`)
  }
  return Math.min(value, hardCap)
}

function sameRegistration(a: CellBinding, b: RegisterSessionMcpCell): boolean {
  return (
    a.isolationCellId === b.isolationCellId &&
    a.platform === b.platform &&
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId &&
    a.delegationId === b.delegationId &&
    a.generation === b.generation &&
    a.expiresAt === b.expiresAt
  )
}

function sameRelease(a: CellBinding, b: ReleaseSessionMcpCell): boolean {
  return (
    a.isolationCellId === b.isolationCellId &&
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId &&
    a.delegationId === b.delegationId &&
    a.generation === b.generation
  )
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
}

function parseSingleSseData(text: string): string {
  const events: string[] = []
  let data: string[] = []
  const flush = () => {
    if (data.length === 0) return
    events.push(data.join('\n'))
    data = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
  }
  flush()
  if (events.length !== 1 || events[0] === '[DONE]') {
    throw new Error('AgentConnect MCP returned an invalid SSE response count')
  }
  return events[0]!
}

function rpcFromResponse(response: Response, bytes: Buffer, invocationId: string): RpcResponse {
  const type = mediaType(response)
  let serialized: string
  if (type === 'application/json') {
    serialized = bytes.toString('utf8')
  } else if (type === 'text/event-stream') {
    serialized = parseSingleSseData(bytes.toString('utf8'))
  } else {
    throw new Error('AgentConnect MCP returned an unsupported content type')
  }
  const parsed = JSON.parse(serialized) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AgentConnect MCP returned an invalid JSON-RPC response')
  }
  if (parsed.jsonrpc !== '2.0' || parsed.id !== invocationId) {
    throw new Error('AgentConnect MCP returned a mismatched JSON-RPC response')
  }
  const hasResult = Object.hasOwn(parsed, 'result')
  const hasError = Object.hasOwn(parsed, 'error')
  if (hasResult === hasError) {
    throw new Error('AgentConnect MCP response must contain exactly one of result or error')
  }
  if (hasError) {
    const error = parsed.error
    if (
      !error ||
      typeof error !== 'object' ||
      Array.isArray(error) ||
      typeof (error as { code?: unknown }).code !== 'number' ||
      typeof (error as { message?: unknown }).message !== 'string'
    ) {
      throw new Error('AgentConnect MCP returned an invalid JSON-RPC error')
    }
  }
  return parsed as RpcResponse
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNarrowIpcRequest(value: unknown): value is IpcRequest {
  if (!isPlainRecord(value)) return false
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) return false
  if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 256) return false
  if (value.op === 'listTools') return exactKeys(value, ['id', 'op', 'token'])
  if (value.op !== 'callTool') return false
  return (
    exactKeys(value, ['args', 'id', 'name', 'op', 'token']) &&
    typeof value.name === 'string' &&
    value.name.length >= 1 &&
    value.name.length <= 256 &&
    isPlainRecord(value.args)
  )
}

function isNarrowAttachRequest(value: unknown): value is IpcAttachReq {
  return (
    isPlainRecord(value) &&
    Number.isSafeInteger(value.id) &&
    (value.id as number) >= 0 &&
    typeof value.token === 'string' &&
    value.token.length >= 1 &&
    value.token.length <= 256 &&
    value.op === 'attach' &&
    exactKeys(value, ['id', 'op', 'token'])
  )
}

/**
 * Conversation-private adapter between the cell-local mcp-bridge IPC and the
 * CP's standard MCP HTTP endpoint. It stores no user credential and never
 * registers delegated contexts on the daemon's shared MCP control server.
 */
export class SessionMcpBroker {
  private readonly cells = new Map<string, CellBinding>()
  private readonly conversations = new Map<string, CellBinding>()
  private readonly history = new Map<string, DelegationHistory>()
  private readonly seenCellIds = new Set<string>()
  private readonly activeTokens = new Set<string>()
  private readonly bridgeDisconnectListeners = new Set<(event: SessionMcpBridgeDisconnected) => void>()
  private readonly maxConversationFences: number
  private readonly maxSeenCellIds: number
  private readonly maxConnectionsPerBinding: number
  private readonly maxPendingRequestsPerBinding: number
  private mutationTail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: SessionMcpBrokerDeps) {
    this.maxConversationFences = capacityLimit(
      deps.testCapacityLimits?.maxConversationFences,
      MAX_CONVERSATION_FENCES,
      'conversation fence'
    )
    this.maxSeenCellIds = capacityLimit(deps.testCapacityLimits?.maxSeenCellIds, MAX_SEEN_CELL_IDS, 'seen cell id')
    this.maxConnectionsPerBinding = capacityLimit(
      deps.testCapacityLimits?.maxConnectionsPerBinding,
      PRIVATE_MCP_MAX_CONNECTIONS_PER_BINDING,
      'connections per binding'
    )
    this.maxPendingRequestsPerBinding = capacityLimit(
      deps.testCapacityLimits?.maxPendingRequestsPerBinding,
      PRIVATE_MCP_MAX_PENDING_REQUESTS_PER_BINDING,
      'pending requests per binding'
    )
  }

  async registerCell(input: RegisterSessionMcpCell): Promise<McpStdioServer | null> {
    return this.serialized(async () => {
      if (this.stopped) {
        this.reportDenied('broker_validation')
        throw new Error('private MCP broker is stopped')
      }
      if (input.platform !== 'webchat') return null
      try {
        validateIdentifier('isolation cell', input.isolationCellId)
        validateIdentifier('agent', input.agentId)
        validateIdentifier('conversation', input.conversationId)
        validateIdentifier('delegation', input.delegationId)
      } catch (error) {
        this.reportDenied('broker_validation')
        throw error
      }
      const now = this.now()
      if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
        this.reportDenied('broker_validation')
        throw new Error('delegation generation must be a positive safe integer')
      }
      if (
        typeof input.expiresAt !== 'string' ||
        input.expiresAt.length === 0 ||
        Buffer.byteLength(input.expiresAt, 'utf8') > MAX_EXPIRY_BYTES
      ) {
        this.reportDenied('broker_validation')
        throw new Error('delegation expiry must be a bounded timestamp')
      }
      const expiresAtMs = Date.parse(input.expiresAt)
      if (!Number.isFinite(expiresAtMs)) {
        this.reportDenied('broker_validation')
        throw new Error('delegation expiry must be a valid timestamp')
      }
      if (expiresAtMs <= now) {
        this.reportDenied('fence')
        return null
      }

      const currentCell = this.cells.get(input.isolationCellId)
      if (currentCell) {
        if (sameRegistration(currentCell, input)) {
          this.reportIsolation('resumed')
          return currentCell.descriptor
        }
        this.reportDenied('fence')
        throw new Error(`isolation cell ${input.isolationCellId} is already bound`)
      }
      if (this.seenCellIds.has(input.isolationCellId)) {
        this.reportDenied('fence')
        throw new Error(`isolation cell ${input.isolationCellId} cannot be reused`)
      }

      const key = logicalKey(input)
      const currentConversation = this.conversations.get(key)
      if (currentConversation) {
        this.reportDenied('fence')
        throw new Error(`conversation ${input.conversationId} is already bound to another isolation cell`)
      }
      const prior = this.history.get(key)
      if (prior) {
        if (input.generation < prior.generation) {
          this.reportDenied('fence')
          throw new Error(`stale generation ${input.generation}; current generation is ${prior.generation}`)
        }
        if (input.generation === prior.generation && input.delegationId !== prior.delegationId) {
          this.reportDenied('fence')
          throw new Error('same generation cannot use a different delegation')
        }
        if (input.generation === prior.generation && input.expiresAt !== prior.expiresAt) {
          this.reportDenied('fence')
          throw new Error('same generation cannot use a different expiry')
        }
      }

      const needsConversationFence = prior === undefined
      if (
        (needsConversationFence && this.history.size >= this.maxConversationFences) ||
        this.seenCellIds.size >= this.maxSeenCellIds
      ) {
        this.reportDenied('capacity')
        throw new Error('isolated-host capacity error: permanent authority fence capacity exhausted')
      }

      // Burn authority before any fallible resource creation. A failed listener
      // may be retried only with a fresh cell id, never by rolling back fences.
      this.seenCellIds.add(input.isolationCellId)
      this.history.set(key, {
        generation: input.generation,
        delegationId: input.delegationId,
        expiresAt: input.expiresAt
      })

      try {
        const binding = await this.createBinding(input, expiresAtMs)
        // Publish the live binding only after every private resource is ready.
        this.cells.set(input.isolationCellId, binding)
        this.conversations.set(key, binding)
        this.reportIsolation('created')
        return binding.descriptor
      } catch (error) {
        this.reportIsolation('failed', 'cell_creation')
        throw error
      }
    })
  }

  getCellMount(isolationCellId: string): SessionMcpCellMount | null {
    const binding = this.cells.get(isolationCellId)
    if (!binding) return null
    return {
      sourceDirectory: binding.sourceDirectory,
      sourceSocketPath: binding.sourceSocketPath,
      targetDirectory: this.deps.inCellSocketDirectory
    }
  }

  subscribeBridgeDisconnect(listener: (event: SessionMcpBridgeDisconnected) => void): () => void {
    this.bridgeDisconnectListeners.add(listener)
    return () => this.bridgeDisconnectListeners.delete(listener)
  }

  /** Non-secret lifecycle counters used by health checks and resource-bound tests. */
  debugStats(): {
    activeCells: number
    historyEntries: number
    seenCellIds: number
    connections: number
    stopped: boolean
  } {
    let connections = 0
    for (const binding of this.cells.values()) connections += binding.connections.size
    return {
      activeCells: this.cells.size,
      historyEntries: this.history.size,
      seenCellIds: this.seenCellIds.size,
      connections,
      stopped: this.stopped
    }
  }

  /** Bounded, identifier-free authority-fence health for daemon diagnostics. */
  capacityStats(): {
    conversationFences: { count: number; cap: number; exhausted: boolean }
    seenCellIds: { count: number; cap: number; exhausted: boolean }
  } {
    return {
      conversationFences: {
        count: this.history.size,
        cap: this.maxConversationFences,
        exhausted: this.history.size >= this.maxConversationFences
      },
      seenCellIds: {
        count: this.seenCellIds.size,
        cap: this.maxSeenCellIds,
        exhausted: this.seenCellIds.size >= this.maxSeenCellIds
      }
    }
  }

  async releaseCell(input: ReleaseSessionMcpCell): Promise<boolean> {
    return this.serialized(async () => {
      const binding = this.cells.get(input.isolationCellId)
      if (!binding || !sameRelease(binding, input)) {
        this.reportDenied('fence')
        return false
      }
      this.beginDrainBinding(binding)
      await this.destroyBinding(binding)
      this.detachBinding(binding)
      return true
    })
  }

  /** Disable one exact cell before slow host/filesystem cleanup while retaining
   * its binding so releaseCell can retry destruction. */
  async beginDrainCell(input: ReleaseSessionMcpCell): Promise<boolean> {
    return this.serialized(async () => {
      const binding = this.cells.get(input.isolationCellId)
      if (!binding || !sameRelease(binding, input)) {
        this.reportDenied('fence')
        return false
      }
      this.beginDrainBinding(binding)
      return true
    })
  }

  /** Daemon shutdown clears local material only; it deliberately does not revoke CP authority. */
  async stop(): Promise<void> {
    return this.serialized(async () => {
      this.stopped = true
      const bindings = [...this.cells.values()]
      for (const binding of bindings) this.beginDrainBinding(binding)
      await Promise.all(
        bindings.map(async (binding) => {
          await this.destroyBinding(binding)
          this.detachBinding(binding)
        })
      )
      this.history.clear()
      this.seenCellIds.clear()
    })
  }

  private async createBinding(input: RegisterSessionMcpCell, expiresAtMs: number): Promise<CellBinding> {
    await this.ensureSocketRoot()
    const sourceDirectory = await mkdtemp(join(this.deps.socketRoot, 'cell-'))
    let token: string | undefined
    let server: net.Server | undefined
    try {
      await chmod(sourceDirectory, 0o700)
      const sourceSocketPath = join(sourceDirectory, PRIVATE_SOCKET_NAME)
      token = this.allocateToken()
      const inCellSocketPath = join(this.deps.inCellSocketDirectory, PRIVATE_SOCKET_NAME)
      const descriptor = buildMcpServers({
        socketPath: inCellSocketPath,
        token,
        cliEntry: this.deps.cliEntry,
        name: ADMIN_SERVER_NAME,
        lazyTools: true
      })[0]!
      const connections = new Set<net.Socket>()
      server = net.createServer()
      const binding: CellBinding = {
        ...input,
        expiresAtMs,
        token,
        sourceDirectory,
        sourceSocketPath,
        descriptor,
        server,
        connections,
        pendingRequests: 0,
        accepting: true,
        serverClosed: false,
        sourceRemoved: false
      }
      server.on('connection', (socket) => this.onConnection(binding, socket))
      await new Promise<void>((resolve, reject) => {
        const startupError = (error: Error) => reject(error)
        server!.once('error', startupError)
        server!.listen(sourceSocketPath, () => {
          server!.off('error', startupError)
          server!.on('error', () => {
            // A post-listen socket error is contained to this admin endpoint.
          })
          resolve()
        })
      })
      await chmod(sourceSocketPath, 0o600)
      return binding
    } catch (error) {
      if (token) this.activeTokens.delete(token)
      if (server?.listening) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
      }
      await rm(sourceDirectory, { recursive: true, force: true })
      throw error
    }
  }

  private async ensureSocketRoot(): Promise<void> {
    await mkdir(this.deps.socketRoot, { recursive: true, mode: 0o700 })
    const info = await lstat(this.deps.socketRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('private MCP socket root must be a real directory')
    }
    await chmod(this.deps.socketRoot, 0o700)
  }

  private onConnection(binding: CellBinding, socket: net.Socket): void {
    if (!binding.accepting || binding.connections.size >= this.maxConnectionsPerBinding) {
      this.reportDenied('capacity')
      socket.destroy()
      return
    }
    binding.connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let pending = 0
    let authenticated = false
    let disconnectEmitted = false
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > PRIVATE_MCP_MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      const decoded = decodeFrames<unknown>(buffer)
      buffer = decoded.rest
      const workRequests = decoded.messages.reduce<number>(
        (count, request) => count + (isNarrowAttachRequest(request) ? 0 : 1),
        0
      )
      if (
        decoded.messages.length > PRIVATE_MCP_MAX_PIPELINED_REQUESTS ||
        pending + workRequests > PRIVATE_MCP_MAX_PENDING_REQUESTS ||
        binding.pendingRequests + workRequests > this.maxPendingRequestsPerBinding
      ) {
        this.reportDenied('capacity')
        socket.destroy()
        return
      }
      for (const request of decoded.messages) {
        if (isNarrowAttachRequest(request)) {
          const reply = (response: IpcResponse) => {
            if (!socket.destroyed) socket.write(encodeFrame(response))
          }
          if (!binding.accepting || !tokenMatches(binding.token, request.token)) {
            this.reportDenied('token_mismatch')
            reply({ id: request.id, ok: false, error: UNKNOWN_TOKEN_ERROR })
          } else if (this.now() >= binding.expiresAtMs) {
            reply({ id: request.id, ok: false, error: WEBCHAT_MCP_RECONNECT_ERROR })
          } else if (!socket.destroyed) {
            reply({ id: request.id, ok: true, result: { attached: true } })
            authenticated = true
          }
          continue
        }
        pending += 1
        binding.pendingRequests += 1
        void this.handle(binding, request, socket, authenticated).finally(() => {
          pending -= 1
          binding.pendingRequests -= 1
        })
      }
    })
    socket.on('error', () => {
      // Cell-local bridge failures never escape into the daemon.
    })
    socket.on('close', () => {
      binding.connections.delete(socket)
      // Active release flips `accepting` before closing its sockets, so a normal
      // manager teardown cannot recursively re-enter the lifecycle callback.
      if (!authenticated || !binding.accepting || disconnectEmitted) return
      disconnectEmitted = true
      const event: SessionMcpBridgeDisconnected = {
        isolationCellId: binding.isolationCellId,
        agentId: binding.agentId,
        conversationId: binding.conversationId,
        delegationId: binding.delegationId,
        generation: binding.generation
      }
      for (const listener of this.bridgeDisconnectListeners) {
        try {
          listener(event)
        } catch {
          // Lifecycle observers are containment boundaries; broker serving must
          // not fail because a host-manager cleanup callback threw.
        }
      }
    })
  }

  private async handle(
    binding: CellBinding,
    request: unknown,
    socket: net.Socket,
    authenticated: boolean
  ): Promise<void> {
    const reply = (response: IpcResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(response))
    }
    if (!isNarrowIpcRequest(request)) {
      this.reportDenied('broker_validation')
      const id = isPlainRecord(request) && Number.isSafeInteger(request.id) ? (request.id as number) : 0
      reply({ id, ok: false, error: 'invalid private MCP request' })
      return
    }
    if (!authenticated) {
      this.reportDenied('broker_validation')
      reply({ id: request.id, ok: false, error: 'private MCP bridge is not attached' })
      return
    }
    if (!binding.accepting || !tokenMatches(binding.token, request.token)) {
      this.reportDenied('token_mismatch')
      reply({ id: request.id, ok: false, error: UNKNOWN_TOKEN_ERROR })
      return
    }
    if (this.now() >= binding.expiresAtMs) {
      reply({ id: request.id, ok: false, error: WEBCHAT_MCP_RECONNECT_ERROR })
      return
    }
    try {
      const result = await this.forward(binding, request)
      reply({ id: request.id, ok: true, result })
    } catch (error) {
      reply({ id: request.id, ok: false, error: this.publicError(error, binding) })
    }
  }

  private async forward(binding: CellBinding, request: IpcRequest): Promise<unknown> {
    if (request.op !== 'listTools' && request.op !== 'callTool') {
      throw new Error('unsupported private MCP operation')
    }
    const invocationId = this.deps.randomUUID?.() ?? randomUUID()
    const rpc =
      request.op === 'listTools'
        ? { jsonrpc: '2.0', id: invocationId, method: 'tools/list', params: {} }
        : {
            jsonrpc: '2.0',
            id: invocationId,
            method: 'tools/call',
            params: { name: request.name, arguments: request.args ?? {} }
          }
    const body = Buffer.from(JSON.stringify(rpc))
    const mintInput: McpInvocationMint = {
      delegationId: binding.delegationId,
      generation: binding.generation,
      agentId: binding.agentId,
      conversationId: binding.conversationId,
      invocationId,
      requestHash: createHash('sha256').update(body).digest('hex'),
      method: request.op === 'listTools' ? 'tools/list' : 'tools/call',
      ...(request.op === 'callTool' ? { toolName: request.name } : {})
    }
    const minted = await this.mintUsableAssertion(mintInput)
    const parsed = await this.withPostDeadline((signal) =>
      this.dispatchWithRecovery(body, invocationId, mintInput, minted, signal)
    )
    if (parsed.error) {
      throw new DefiniteMcpError(parsed.error.message)
    }
    if (request.op === 'listTools') {
      const result = parsed.result as { tools?: unknown } | undefined
      if (!result || !Array.isArray(result.tools))
        throw new Error('AgentConnect MCP returned an invalid tools/list result')
      return { tools: result.tools }
    }
    const result = parsed.result as { content?: unknown; isError?: unknown } | undefined
    if (!result || !Array.isArray(result.content))
      throw new Error('AgentConnect MCP returned an invalid tools/call result')
    return { mcpContent: result.content, ...(result.isError === true ? { mcpIsError: true } : {}) }
  }

  private async mintUsableAssertion(input: McpInvocationMint): Promise<McpInvocationMinted> {
    // Normally one pass. A fake/near-dead assertion can be rotated once before
    // any HTTP claim, preserving the invocation id and exact request hash.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const minted = await this.timed('mint_ws', () => this.deps.cpClient.mintMcpInvocation(input))
      if (Date.parse(minted.expiresAt) > this.now()) return minted
    }
    throw new Error('invocation assertion expired before use')
  }

  private post(body: Buffer, invocationId: string, assertion: string, signal: AbortSignal): Promise<Response> {
    const fetchImpl =
      this.deps.fetch ?? ((url: string, init: DelegatedMcpFetchInit) => fetch(url, init as unknown as RequestInit))
    return fetchImpl(this.deps.mcpEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${assertion}`,
        'x-agentconnect-invocation-id': invocationId,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      body,
      signal
    })
  }

  private async dispatchWithRecovery(
    body: Buffer,
    invocationId: string,
    mintInput: McpInvocationMint,
    initialMint: McpInvocationMinted,
    signal: AbortSignal
  ): Promise<RpcResponse> {
    let assertion = initialMint.assertion
    let reminted = false
    let recoveryAttempt = 0
    const recoveryAttempts = this.deps.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS
    let outcome = await this.postAttempt(body, invocationId, assertion, signal)

    for (;;) {
      if (outcome.kind === 'rpc') return outcome.response
      if (outcome.kind === 'ambiguous') throw new AmbiguousInvocationError()

      // Only the CP's exact fixed denial proves that this assertion never claimed
      // the ledger row. Rotate at most once, preserving the invocation id/hash/body.
      if (outcome.kind === 'assertion_denied') {
        if (reminted) throw new Error('invocation assertion expired before use')
        assertion = (await this.mintUsableAssertion(mintInput)).assertion
        reminted = true
        outcome = await this.postAttempt(body, invocationId, assertion, signal)
        continue
      }

      // Both an exact in-progress response and every untrusted/invalid transport
      // outcome are recovered only by observing the same invocation. Never mint a
      // new id or alter the exact Buffer after any POST may have reached the CP.
      if (recoveryAttempt >= recoveryAttempts) throw new AmbiguousInvocationError()
      if (recoveryAttempt > 0) await this.pollDelay(signal)
      recoveryAttempt += 1
      outcome = await this.postAttempt(body, invocationId, assertion, signal)
    }
  }

  private async postAttempt(
    body: Buffer,
    invocationId: string,
    assertion: string,
    signal: AbortSignal
  ): Promise<PostOutcome> {
    const startedAt = performance.now()
    try {
      const outcome = await this.postAttemptUnmeasured(body, invocationId, assertion, signal)
      this.reportDuration('mcp_http', performance.now() - startedAt, outcome.kind === 'rpc' ? 'succeeded' : 'failed')
      return outcome
    } catch (error) {
      this.reportDuration('mcp_http', performance.now() - startedAt, 'failed')
      throw error
    }
  }

  private async postAttemptUnmeasured(
    body: Buffer,
    invocationId: string,
    assertion: string,
    signal: AbortSignal
  ): Promise<PostOutcome> {
    if (signal.aborted) throw new AmbiguousInvocationError()
    let response: Response
    try {
      response = await this.post(body, invocationId, assertion, signal)
    } catch {
      if (signal.aborted) throw new AmbiguousInvocationError()
      return { kind: 'uncertain' }
    }

    let bytes: Buffer
    try {
      bytes = await this.readBoundedBody(response, signal)
    } catch {
      if (signal.aborted) throw new AmbiguousInvocationError()
      return { kind: 'uncertain' }
    }

    try {
      return { kind: 'rpc', response: rpcFromResponse(response, bytes, invocationId) }
    } catch {
      // Only the byte-exact fixed CP control responses carry recovery authority.
      // Status-only or proxy-shaped 401/409 responses remain transport-uncertain.
    }
    if (response.status === 401 && bytes.equals(ASSERTION_DENIED_BODY)) {
      return { kind: 'assertion_denied' }
    }
    if (response.status === 409 && response.headers.get('retry-after') !== null && bytes.equals(IN_PROGRESS_BODY)) {
      return { kind: 'in_progress' }
    }
    if (response.status === 409 && bytes.equals(AMBIGUOUS_BODY)) {
      return { kind: 'ambiguous' }
    }
    return { kind: 'uncertain' }
  }

  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    const abort = () => {
      aborted = true
      void reader.cancel(new AmbiguousInvocationError()).catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      for (;;) {
        const item = await reader.read()
        if (aborted) throw new AmbiguousInvocationError()
        if (item.done) break
        const chunk = Buffer.from(item.value)
        size += chunk.byteLength
        if (size > PRIVATE_MCP_MAX_FRAME_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new Error('AgentConnect MCP response exceeded the bounded body limit')
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, size)
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      reader.releaseLock()
    }
  }

  private async withPostDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const setTimer = this.deps.setTimeout ?? globalThis.setTimeout
    const clearTimer = this.deps.clearTimeout ?? globalThis.clearTimeout
    const deadlineMs = this.deps.postDeadlineMs ?? DEFAULT_POST_DEADLINE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
        controller.abort()
        reject(new AmbiguousInvocationError())
      }, deadlineMs)
    })
    try {
      return await Promise.race([operation(controller.signal), deadline])
    } finally {
      if (timer !== undefined) clearTimer(timer)
    }
  }

  private async pollDelay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AmbiguousInvocationError()
    const setTimer = this.deps.setTimeout ?? globalThis.setTimeout
    const clearTimer = this.deps.clearTimeout ?? globalThis.clearTimeout
    const delayMs = this.deps.recoveryPollMs ?? DEFAULT_RECOVERY_POLL_MS
    await new Promise<void>((resolve, reject) => {
      const timer = setTimer(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      const abort = () => {
        clearTimer(timer)
        signal.removeEventListener('abort', abort)
        reject(new AmbiguousInvocationError())
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private publicError(error: unknown, binding: CellBinding): string {
    if (this.now() >= binding.expiresAtMs) return WEBCHAT_MCP_RECONNECT_ERROR
    if (error instanceof WireError && error.code === 'DELEGATION_DENIED') {
      return WEBCHAT_MCP_RECONNECT_ERROR
    }
    if (error instanceof AmbiguousInvocationError) return WEBCHAT_MCP_AMBIGUOUS_ERROR
    if (error instanceof DefiniteMcpError) return error.message
    const message = error instanceof Error ? error.message : ''
    if (
      message === WEBCHAT_MCP_RECONNECT_ERROR ||
      message === 'invocation assertion expired before use' ||
      message.startsWith('AgentConnect MCP request failed') ||
      message.includes('operation may have taken effect') ||
      message.includes('already in progress')
    ) {
      return message
    }
    return ADMIN_UNAVAILABLE_ERROR
  }

  private detachBinding(binding: CellBinding): void {
    this.cells.delete(binding.isolationCellId)
    if (this.conversations.get(logicalKey(binding)) === binding) {
      this.conversations.delete(logicalKey(binding))
    }
    this.activeTokens.delete(binding.token)
    this.reportIsolation('destroyed')
  }

  private beginDrainBinding(binding: CellBinding): void {
    binding.accepting = false
    for (const connection of binding.connections) connection.destroy()
  }

  private async destroyBinding(binding: CellBinding): Promise<void> {
    for (const connection of binding.connections) connection.destroy()
    if (!binding.serverClosed) {
      if (binding.server.listening) {
        await new Promise<void>((resolve) => binding.server.close(() => resolve()))
      }
      binding.serverClosed = true
    }
    if (!binding.sourceRemoved) {
      await rm(binding.sourceDirectory, { recursive: true, force: true })
      binding.sourceRemoved = true
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private allocateToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.deps.randomToken?.() ?? randomBytes(32).toString('base64url')
      if (!token || this.activeTokens.has(token)) continue
      this.activeTokens.add(token)
      return token
    }
    throw new Error('could not allocate a unique private MCP token')
  }

  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async timed<T>(stage: DelegatedMcpRequestStage, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
      const value = await operation()
      this.reportDuration(stage, performance.now() - startedAt, 'succeeded')
      return value
    } catch (error) {
      this.reportDuration(stage, performance.now() - startedAt, 'failed')
      throw error
    }
  }

  private reportIsolation(
    event: Parameters<DelegatedMcpMetrics['isolation']>[0],
    reason?: Parameters<DelegatedMcpMetrics['isolation']>[1]
  ): void {
    try {
      if (reason === undefined) this.deps.metrics?.isolation(event)
      else this.deps.metrics?.isolation(event, reason)
    } catch {
      // Custom observers never participate in broker state.
    }
  }

  private reportDenied(reason: DelegatedIsolationDenialReason): void {
    try {
      this.deps.metrics?.denied(reason)
    } catch {
      // Custom observers never participate in broker authorization.
    }
  }

  private reportDuration(
    stage: DelegatedMcpRequestStage,
    durationMs: number,
    outcome: Parameters<DelegatedMcpMetrics['requestDuration']>[2]
  ): void {
    try {
      this.deps.metrics?.requestDuration(stage, Math.max(0, durationMs), outcome)
    } catch {
      // Custom observers never participate in broker requests.
    }
  }
}
