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
import { decodeFrames, encodeFrame, type IpcRequest, type IpcResponse } from './ipc.js'

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

export interface SessionMcpCellMount {
  sourceDirectory: string
  sourceSocketPath: string
  targetDirectory: string
}

interface DelegationHistory {
  generation: number
  delegationId: string
  expiresAt: string
  expiresAtMs: number
}

interface CellBinding extends RegisterSessionMcpCell {
  expiresAtMs: number
  token: string
  sourceDirectory: string
  sourceSocketPath: string
  descriptor: McpStdioServer
  server: net.Server
  connections: Set<net.Socket>
  accepting: boolean
}

type RpcResponse = {
  jsonrpc: '2.0'
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

class AmbiguousInvocationError extends Error {
  constructor() {
    super(WEBCHAT_MCP_AMBIGUOUS_ERROR)
  }
}

function logicalKey(input: Pick<RegisterSessionMcpCell, 'agentId' | 'conversationId'>): string {
  return `${input.agentId}\0${input.conversationId}`
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

/**
 * Conversation-private adapter between the cell-local mcp-bridge IPC and the
 * CP's standard MCP HTTP endpoint. It stores no user credential and never
 * registers delegated contexts on the daemon's shared MCP control server.
 */
export class SessionMcpBroker {
  private readonly cells = new Map<string, CellBinding>()
  private readonly conversations = new Map<string, CellBinding>()
  private readonly history = new Map<string, DelegationHistory>()
  private readonly retiredCellIds = new Map<string, number>()
  private readonly activeTokens = new Set<string>()
  private mutationTail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: SessionMcpBrokerDeps) {}

  async registerCell(input: RegisterSessionMcpCell): Promise<McpStdioServer | null> {
    return this.serialized(async () => {
      if (this.stopped) throw new Error('private MCP broker is stopped')
      if (input.platform !== 'webchat') return null
      const now = this.now()
      this.pruneExpiredState(now)
      const expiresAtMs = Date.parse(input.expiresAt)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null
      if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
        throw new Error('delegation generation must be a positive safe integer')
      }

      const currentCell = this.cells.get(input.isolationCellId)
      if (currentCell) {
        if (sameRegistration(currentCell, input)) return currentCell.descriptor
        throw new Error(`isolation cell ${input.isolationCellId} is already bound`)
      }
      if (this.retiredCellIds.has(input.isolationCellId)) {
        throw new Error(`isolation cell ${input.isolationCellId} cannot be reused`)
      }

      const key = logicalKey(input)
      const currentConversation = this.conversations.get(key)
      if (currentConversation) {
        throw new Error(`conversation ${input.conversationId} is already bound to another isolation cell`)
      }
      const prior = this.history.get(key)
      if (prior) {
        if (input.generation < prior.generation) {
          throw new Error(`stale generation ${input.generation}; current generation is ${prior.generation}`)
        }
        if (input.generation === prior.generation && input.delegationId !== prior.delegationId) {
          throw new Error('same generation cannot use a different delegation')
        }
        if (input.generation === prior.generation && input.expiresAt !== prior.expiresAt) {
          throw new Error('same generation cannot use a different expiry')
        }
      }

      const binding = await this.createBinding(input, expiresAtMs)
      this.cells.set(input.isolationCellId, binding)
      this.conversations.set(key, binding)
      this.history.set(key, {
        generation: input.generation,
        delegationId: input.delegationId,
        expiresAt: input.expiresAt,
        expiresAtMs
      })
      return binding.descriptor
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

  /** Non-secret lifecycle counters used by health checks and resource-bound tests. */
  debugStats(): {
    activeCells: number
    historyEntries: number
    retiredCellIds: number
    connections: number
  } {
    this.pruneExpiredState(this.now())
    let connections = 0
    for (const binding of this.cells.values()) connections += binding.connections.size
    return {
      activeCells: this.cells.size,
      historyEntries: this.history.size,
      retiredCellIds: this.retiredCellIds.size,
      connections
    }
  }

  async releaseCell(input: ReleaseSessionMcpCell): Promise<boolean> {
    return this.serialized(async () => {
      const binding = this.cells.get(input.isolationCellId)
      if (!binding || !sameRelease(binding, input)) return false
      this.detachBinding(binding)
      await this.destroyBinding(binding)
      return true
    })
  }

  /** Daemon shutdown clears local material only; it deliberately does not revoke CP authority. */
  async stop(): Promise<void> {
    return this.serialized(async () => {
      this.stopped = true
      const bindings = [...this.cells.values()]
      for (const binding of bindings) this.detachBinding(binding)
      await Promise.all(bindings.map((binding) => this.destroyBinding(binding)))
      this.history.clear()
      this.retiredCellIds.clear()
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
        accepting: true
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
    if (!binding.accepting) {
      socket.destroy()
      return
    }
    binding.connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let pending = 0
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > PRIVATE_MCP_MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      const decoded = decodeFrames<unknown>(buffer)
      buffer = decoded.rest
      if (
        decoded.messages.length > PRIVATE_MCP_MAX_PIPELINED_REQUESTS ||
        pending + decoded.messages.length > PRIVATE_MCP_MAX_PENDING_REQUESTS
      ) {
        socket.destroy()
        return
      }
      for (const request of decoded.messages) {
        pending += 1
        void this.handle(binding, request, socket).finally(() => {
          pending -= 1
        })
      }
    })
    socket.on('error', () => {
      // Cell-local bridge failures never escape into the daemon.
    })
    socket.on('close', () => binding.connections.delete(socket))
  }

  private async handle(binding: CellBinding, request: unknown, socket: net.Socket): Promise<void> {
    const reply = (response: IpcResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(response))
    }
    if (!isNarrowIpcRequest(request)) {
      const id = isPlainRecord(request) && Number.isSafeInteger(request.id) ? (request.id as number) : 0
      reply({ id, ok: false, error: 'invalid private MCP request' })
      return
    }
    if (!binding.accepting || !tokenMatches(binding.token, request.token)) {
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
    const { response, responseBytes } = await this.withPostDeadline(async (signal) => {
      const response = await this.dispatchWithRecovery(body, invocationId, mintInput, minted, signal)
      return { response, responseBytes: Buffer.from(await response.arrayBuffer()) }
    })
    if (!response.ok) {
      const message = this.httpError(response.status, responseBytes)
      throw new Error(message)
    }
    const parsed = rpcFromResponse(response, responseBytes, invocationId)
    if (parsed.error) {
      throw new Error(
        typeof parsed.error.message === 'string' ? parsed.error.message : 'AgentConnect MCP request failed'
      )
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
      const minted = await this.deps.cpClient.mintMcpInvocation(input)
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
  ): Promise<Response> {
    let minted = initialMint
    let response: Response
    try {
      response = await this.post(body, invocationId, minted.assertion, signal)
    } catch {
      return this.recoverSameInvocation(body, invocationId, minted.assertion, signal)
    }

    // A definite 401 proves this assertion did not claim execution. Rotating it
    // for the same unstarted ledger row remains safe.
    if (response.status === 401) {
      minted = await this.mintUsableAssertion(mintInput)
      try {
        response = await this.post(body, invocationId, minted.assertion, signal)
      } catch {
        return this.recoverSameInvocation(body, invocationId, minted.assertion, signal)
      }
    }
    if (this.isInProgress(response)) {
      return this.recoverSameInvocation(body, invocationId, minted.assertion, signal)
    }
    return response
  }

  private async recoverSameInvocation(
    body: Buffer,
    invocationId: string,
    assertion: string,
    signal: AbortSignal
  ): Promise<Response> {
    const attempts = this.deps.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw new AmbiguousInvocationError()
      try {
        const response = await this.post(body, invocationId, assertion, signal)
        if (!this.isInProgress(response)) {
          if (response.status === 401) throw new AmbiguousInvocationError()
          return response
        }
      } catch (error) {
        if (error instanceof AmbiguousInvocationError) throw error
      }
      if (attempt + 1 < attempts) await this.pollDelay(signal)
    }
    throw new AmbiguousInvocationError()
  }

  private isInProgress(response: Response): boolean {
    return response.status === 409 && response.headers.get('retry-after') !== null
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

  private httpError(status: number, bytes: Buffer): string {
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
    } catch {
      // Keep HTTP bodies out of logs/errors unless they contain the bounded public message.
    }
    return `AgentConnect MCP request failed (HTTP ${status})`
  }

  private publicError(error: unknown, binding: CellBinding): string {
    if (this.now() >= binding.expiresAtMs) return WEBCHAT_MCP_RECONNECT_ERROR
    if (error instanceof WireError && error.code === 'DELEGATION_DENIED') {
      return WEBCHAT_MCP_RECONNECT_ERROR
    }
    if (error instanceof AmbiguousInvocationError) return WEBCHAT_MCP_AMBIGUOUS_ERROR
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
    binding.accepting = false
    this.cells.delete(binding.isolationCellId)
    if (this.conversations.get(logicalKey(binding)) === binding) {
      this.conversations.delete(logicalKey(binding))
    }
    this.retiredCellIds.set(binding.isolationCellId, binding.expiresAtMs)
    this.activeTokens.delete(binding.token)
  }

  private async destroyBinding(binding: CellBinding): Promise<void> {
    for (const connection of binding.connections) connection.destroy()
    binding.connections.clear()
    await new Promise<void>((resolve) => binding.server.close(() => resolve()))
    await rm(binding.sourceDirectory, { recursive: true, force: true })
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

  private pruneExpiredState(now: number): void {
    for (const [key, value] of this.history) {
      if (value.expiresAtMs <= now) this.history.delete(key)
    }
    for (const [cellId, expiresAtMs] of this.retiredCellIds) {
      if (expiresAtMs <= now) this.retiredCellIds.delete(cellId)
    }
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
}
