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

export const WEBCHAT_MCP_RECONNECT_ERROR =
  'Your AgentConnect session authorization expired. Reconnect this conversation and retry.'

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
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: { message?: unknown }
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

function rpcFromResponse(bytes: Buffer): RpcResponse {
  const text = bytes.toString('utf8')
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line.indexOf(':') + 1).trim())
    .filter((line) => line.length > 0 && line !== '[DONE]')
  const serialized = dataLines.at(-1) ?? text
  return JSON.parse(serialized) as RpcResponse
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
  private readonly retiredCellIds = new Set<string>()
  private readonly activeTokens = new Set<string>()
  private mutationTail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: SessionMcpBrokerDeps) {}

  async registerCell(input: RegisterSessionMcpCell): Promise<McpStdioServer | null> {
    return this.serialized(async () => {
      if (this.stopped) throw new Error('private MCP broker is stopped')
      if (input.platform !== 'webchat') return null
      const expiresAtMs = Date.parse(input.expiresAt)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) return null
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
        expiresAt: input.expiresAt
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
        name: ADMIN_SERVER_NAME
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
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const decoded = decodeFrames<IpcRequest>(buffer)
      buffer = decoded.rest
      for (const request of decoded.messages) {
        void this.handle(binding, request, socket)
      }
    })
    socket.on('error', () => {
      // Cell-local bridge failures never escape into the daemon.
    })
    socket.on('close', () => binding.connections.delete(socket))
  }

  private async handle(binding: CellBinding, request: IpcRequest, socket: net.Socket): Promise<void> {
    const reply = (response: IpcResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(response))
    }
    if (!request || typeof request !== 'object' || typeof request.id !== 'number') return
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
    let minted = await this.mintUsableAssertion(mintInput)
    let response = await this.post(body, invocationId, minted.assertion)
    // A 401 can mean the assertion crossed its short claim deadline before the
    // CP could consume it. Rotating the assertion for this same unstarted
    // invocation is the only automatic retry allowed.
    if (response.status === 401) {
      minted = await this.mintUsableAssertion(mintInput)
      response = await this.post(body, invocationId, minted.assertion)
    }
    const responseBytes = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const message = this.httpError(response.status, responseBytes)
      throw new Error(message)
    }
    const parsed = rpcFromResponse(responseBytes)
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
    if (result.isError === true) {
      const text = result.content
        .map((item) =>
          item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
            ? (item as { text: string }).text
            : ''
        )
        .filter(Boolean)
        .join('\n')
      throw new Error(text || 'AgentConnect MCP tool call failed')
    }
    return { mcpContent: result.content }
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

  private post(body: Buffer, invocationId: string, assertion: string): Promise<Response> {
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
      body
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
    this.retiredCellIds.add(binding.isolationCellId)
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
