import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, stat, symlink } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  McpInvocationMint,
  McpInvocationMinted,
  WebchatMcpDelegationRevoke,
  WebchatMcpDelegationRevoked
} from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import {
  PRIVATE_MCP_MAX_FRAME_BYTES,
  PRIVATE_MCP_MAX_PIPELINED_REQUESTS,
  SessionMcpBroker,
  WEBCHAT_MCP_AMBIGUOUS_ERROR,
  WEBCHAT_MCP_RECONNECT_ERROR,
  type SessionMcpBrokerDeps
} from '../src/mcp/session-mcp-broker.js'
import { decodeFrames, encodeFrame, type IpcRequest, type IpcResponse } from '../src/mcp/ipc.js'

const CELL_ID = 'cell-a'
const OTHER_CELL_ID = 'cell-b'
const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const DELEGATION_ID = '44444444-4444-4444-8444-444444444444'
const NEXT_DELEGATION_ID = '55555555-5555-4555-8555-555555555555'
const INVOCATION_ID = '66666666-6666-4666-8666-666666666666'
const NOW = Date.parse('2026-07-31T00:00:00.000Z')
const EXPIRY = '2026-07-31T12:00:00.000Z'

const roots: string[] = []
const brokers: SessionMcpBroker[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()))
  await Promise.all(
    roots.splice(0).map((root) => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true })))
  )
})

function binding(over: Partial<Parameters<SessionMcpBroker['registerCell']>[0]> = {}) {
  return {
    isolationCellId: CELL_ID,
    platform: 'webchat',
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    delegationId: DELEGATION_ID,
    generation: 1,
    expiresAt: EXPIRY,
    ...over
  }
}

async function harness(over: Partial<SessionMcpBrokerDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ac-private-broker-test-'))
  roots.push(root)
  let now = NOW
  let tokenCount = 0
  const mintMcpInvocation = vi.fn(async (input: McpInvocationMint): Promise<McpInvocationMinted> => ({
    invocationId: input.invocationId,
    assertion: 'ac_inv_assertion',
    expiresAt: new Date(now + 30_000).toISOString()
  }))
  const revokeWebchatMcpDelegation = vi.fn(
    async (input: WebchatMcpDelegationRevoke): Promise<WebchatMcpDelegationRevoked> => ({
      delegationId: input.delegationId,
      generation: input.generation,
      revoked: true
    })
  )
  const fetch = vi.fn(async (_url: string, init: { body: Buffer }) => {
    const rpc = JSON.parse(init.body.toString('utf8')) as { id: string; method: string }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'listAgents',
                    description: 'List agents',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
                  }
                ]
              }
            : { content: [{ type: 'text', text: 'called' }] }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  })
  const deps: SessionMcpBrokerDeps = {
    socketRoot: root,
    inCellSocketDirectory: '/run/agentconnect-admin',
    cliEntry: '/opt/agentconnect/current/index.js',
    mcpEndpoint: 'https://cp.example/api/v1/mcp',
    cpClient: { mintMcpInvocation, revokeWebchatMcpDelegation },
    fetch,
    now: () => now,
    randomUUID: () => INVOCATION_ID,
    randomToken: () => (tokenCount++ === 0 ? 'private-local-token' : `private-local-token-${tokenCount}`),
    ...over
  }
  const broker = new SessionMcpBroker(deps)
  brokers.push(broker)
  return {
    broker,
    root,
    deps,
    mintMcpInvocation,
    revokeWebchatMcpDelegation,
    fetch,
    setNow(value: number) {
      now = value
    }
  }
}

function descriptorEnv(server: NonNullable<Awaited<ReturnType<SessionMcpBroker['registerCell']>>>) {
  return Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
}

async function ipc(endpoint: string, request: IpcRequest): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const decoded = decodeFrames<IpcResponse>(buffer)
      buffer = decoded.rest
      const response = decoded.messages[0]
      if (!response) return
      socket.destroy()
      resolve(response)
    })
    socket.once('connect', () => socket.write(encodeFrame(request)))
  })
}

async function writeUntilClose(endpoint: string, body: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(endpoint)
    socket.once('error', reject)
    socket.once('close', () => resolve())
    socket.once('connect', () => socket.write(body))
  })
}

describe('SessionMcpBroker immutable registration', () => {
  it('registers only webchat and never exposes CP authority in the descriptor', async () => {
    const h = await harness()
    await expect(h.broker.registerCell(binding({ platform: 'slack' }))).resolves.toBeNull()
    const server = await h.broker.registerCell(binding())
    expect(server?.name).toBe('agentconnect-admin')
    const env = descriptorEnv(server!)
    expect(env).toEqual({
      AC_MCP_ENDPOINT: '/run/agentconnect-admin/mcp.sock',
      AC_MCP_TOKEN: 'private-local-token'
    })
    expect(server!.args).toContain('--lazy-tools')
    expect(JSON.stringify(server)).not.toContain(DELEGATION_ID)
    expect(JSON.stringify(server)).not.toContain('ac_inv_')
    expect(JSON.stringify(server)).not.toContain('cp.example')
  })

  it('uses a private 0700 source directory and 0600 socket without registering on a shared server', async () => {
    const h = await harness()
    await h.broker.registerCell(binding())
    const mount = h.broker.getCellMount(CELL_ID)!
    expect(mount.targetDirectory).toBe('/run/agentconnect-admin')
    expect((await stat(mount.sourceDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(mount.sourceSocketPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(mount.sourceDirectory)).isSymbolicLink()).toBe(false)
  })

  it('is idempotent only for the exact live binding and rejects cell or conversation rebinding', async () => {
    const h = await harness()
    const first = await h.broker.registerCell(binding())
    await expect(h.broker.registerCell(binding())).resolves.toEqual(first)
    await expect(h.broker.registerCell(binding({ conversationId: OTHER_CONVERSATION_ID }))).rejects.toThrow(
      /cell.*already bound/i
    )
    await expect(h.broker.registerCell(binding({ isolationCellId: OTHER_CELL_ID }))).rejects.toThrow(
      /conversation.*already bound/i
    )
  })

  it('serializes concurrent duplicate registration and a following fenced release', async () => {
    const h = await harness()
    const [first, second] = await Promise.all([h.broker.registerCell(binding()), h.broker.registerCell(binding())])
    expect(second).toEqual(first)
    await expect((await import('node:fs/promises')).readdir(h.root).then((entries) => entries.length)).resolves.toBe(1)

    await expect(h.broker.releaseCell(binding())).resolves.toBe(true)
    expect(h.broker.getCellMount(CELL_ID)).toBeNull()
    await expect(h.broker.registerCell(binding())).rejects.toThrow(/cell.*cannot be reused/i)
  })

  it('refuses a symlink socket root before creating any private listener', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ac-private-broker-symlink-'))
    roots.push(parent)
    const target = join(parent, 'target')
    const link = join(parent, 'link')
    await (await import('node:fs/promises')).mkdir(target)
    await symlink(target, link)
    const h = await harness({ socketRoot: link })

    await expect(h.broker.registerCell(binding())).rejects.toThrow(/real directory/i)
    expect(await (await import('node:fs/promises')).readdir(target)).toEqual([])
  })

  it('cleans a partial source directory when unique-token allocation fails', async () => {
    const h = await harness({ randomToken: () => 'always-the-same-token' })
    await h.broker.registerCell(binding())
    await expect(
      h.broker.registerCell(
        binding({
          isolationCellId: OTHER_CELL_ID,
          conversationId: OTHER_CONVERSATION_ID,
          delegationId: NEXT_DELEGATION_ID
        })
      )
    ).rejects.toThrow(/unique private MCP token/i)
    await expect((await import('node:fs/promises')).readdir(h.root).then((entries) => entries.length)).resolves.toBe(1)
  })

  it('bounds expired history and retired-cell tombstones', async () => {
    const h = await harness()
    const count = 150
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(12, '0')
      const cell = `expired-${index}`
      const row = binding({
        isolationCellId: cell,
        conversationId: `22222222-2222-4222-8222-${suffix}`,
        delegationId: `44444444-4444-4444-8444-${suffix}`,
        expiresAt: '2026-07-31T00:00:01.000Z'
      })
      await h.broker.registerCell(row)
      await h.broker.releaseCell(row)
    }
    expect(h.broker.debugStats()).toMatchObject({ activeCells: 0, historyEntries: count, retiredCellIds: count })

    h.setNow(Date.parse('2026-07-31T00:00:02.000Z'))
    await h.broker.registerCell(
      binding({
        isolationCellId: 'fresh-cell',
        conversationId: OTHER_CONVERSATION_ID,
        delegationId: NEXT_DELEGATION_ID
      })
    )
    expect(h.broker.debugStats()).toMatchObject({ activeCells: 1, historyEntries: 1, retiredCellIds: 0 })
  })

  it('enforces monotonic generations, same-generation identity, and generation-fenced release', async () => {
    const h = await harness()
    await h.broker.registerCell(binding({ generation: 2, delegationId: NEXT_DELEGATION_ID }))
    await expect(h.broker.releaseCell(binding({ generation: 1, delegationId: DELEGATION_ID }))).resolves.toBe(false)
    expect(h.broker.getCellMount(CELL_ID)).not.toBeNull()
    await expect(h.broker.releaseCell(binding({ generation: 2, delegationId: NEXT_DELEGATION_ID }))).resolves.toBe(true)
    await expect(h.broker.registerCell(binding({ isolationCellId: OTHER_CELL_ID, generation: 1 }))).rejects.toThrow(
      /stale generation/i
    )
    await expect(h.broker.registerCell(binding({ isolationCellId: OTHER_CELL_ID, generation: 2 }))).rejects.toThrow(
      /same generation.*different delegation/i
    )
    await expect(
      h.broker.registerCell(
        binding({
          isolationCellId: OTHER_CELL_ID,
          generation: 2,
          delegationId: NEXT_DELEGATION_ID,
          expiresAt: '2026-07-31T11:59:59.000Z'
        })
      )
    ).rejects.toThrow(/same generation.*different expiry/i)
    await expect(
      h.broker.registerCell(binding({ isolationCellId: OTHER_CELL_ID, generation: 3, delegationId: DELEGATION_ID }))
    ).resolves.not.toBeNull()
  })

  it('rejects expired registration and fences every call at delegation expiry', async () => {
    const h = await harness()
    await expect(h.broker.registerCell(binding({ expiresAt: new Date(NOW).toISOString() }))).resolves.toBeNull()
    const server = await h.broker.registerCell(binding())
    h.setNow(Date.parse(EXPIRY))
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 7,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toMatchObject({ id: 7, ok: false, error: WEBCHAT_MCP_RECONNECT_ERROR })
    expect(h.mintMcpInvocation).not.toHaveBeenCalled()
  })
})

describe('SessionMcpBroker forwarding', () => {
  it('creates a broker UUID, hashes the exact sent Buffer, and derives mint identity from the stored binding', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    const response = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 919,
      token: env.AC_MCP_TOKEN!,
      op: 'callTool',
      name: 'listAgents',
      args: { ignoredIdentity: 'model-controlled' }
    })

    expect(response).toMatchObject({
      id: 919,
      ok: true,
      result: { mcpContent: [{ type: 'text', text: 'called' }] }
    })
    const sentBody = h.fetch.mock.calls[0]![1].body
    const parsed = JSON.parse(sentBody.toString('utf8'))
    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: INVOCATION_ID,
      method: 'tools/call',
      params: { name: 'listAgents', arguments: { ignoredIdentity: 'model-controlled' } }
    })
    expect(parsed.id).not.toBe(919)
    expect(h.mintMcpInvocation).toHaveBeenCalledWith({
      delegationId: DELEGATION_ID,
      generation: 1,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      requestHash: createHash('sha256').update(sentBody).digest('hex'),
      method: 'tools/call',
      toolName: 'listAgents'
    })
    expect(Buffer.isBuffer(sentBody)).toBe(true)
  })

  it('maps listTools to standard tools/list and relays the CP catalog', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    const response = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 17,
      token: env.AC_MCP_TOKEN!,
      op: 'listTools'
    })

    expect(JSON.parse(h.fetch.mock.calls[0]![1].body.toString('utf8'))).toEqual({
      jsonrpc: '2.0',
      id: INVOCATION_ID,
      method: 'tools/list',
      params: {}
    })
    expect(response).toMatchObject({
      id: 17,
      ok: true,
      result: { tools: [{ name: 'listAgents', description: 'List agents' }] }
    })
  })

  it('remints the same unstarted invocation when its assertion expires before use', async () => {
    let mintCount = 0
    const h = await harness({
      cpClient: {
        mintMcpInvocation: vi.fn(async (input) => ({
          invocationId: input.invocationId,
          assertion: `assertion-${++mintCount}`,
          expiresAt: new Date(NOW + (mintCount === 1 ? -1 : 30_000)).toISOString()
        })),
        revokeWebchatMcpDelegation: vi.fn()
      }
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 1,
      token: env.AC_MCP_TOKEN!,
      op: 'listTools'
    })

    const mint = h.deps.cpClient.mintMcpInvocation as ReturnType<typeof vi.fn>
    expect(mint).toHaveBeenCalledTimes(2)
    expect(mint.mock.calls[0]![0].invocationId).toBe(INVOCATION_ID)
    expect(mint.mock.calls[1]![0].invocationId).toBe(INVOCATION_ID)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.fetch.mock.calls[0]![1].headers.authorization).toBe('Bearer assertion-2')
  })

  it('remints the exact same invocation once when HTTP reports an unclaimed expired assertion', async () => {
    let posts = 0
    const post = vi.fn(async (_url: string, init: { body: Buffer }) => {
      posts += 1
      if (posts === 1) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized', statusCode: 401, message: 'invocation assertion denied' }),
          { status: 401 }
        )
      }
      const { id } = JSON.parse(init.body.toString('utf8'))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const h = await harness({
      fetch: post
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    const response = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 8,
      token: env.AC_MCP_TOKEN!,
      op: 'listTools'
    })

    expect(response).toEqual({ id: 8, ok: true, result: { tools: [] } })
    expect(h.mintMcpInvocation).toHaveBeenCalledTimes(2)
    expect(h.mintMcpInvocation.mock.calls[0]![0]).toEqual(h.mintMcpInvocation.mock.calls[1]![0])
    expect(post.mock.calls[0]![1].body).toEqual(post.mock.calls[1]![1].body)
  })

  it('retrieves a committed result with the same assertion, invocation id, and bytes after a response transport failure', async () => {
    let executions = 0
    const post = vi.fn(async (_url: string, init: { body: Buffer; headers: Record<string, string> }) => {
      if (post.mock.calls.length === 1) {
        executions += 1
        throw new Error('socket reset after commit')
      }
      const { id } = JSON.parse(init.body.toString('utf8'))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const h = await harness({ fetch: post })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    const response = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 10,
      token: env.AC_MCP_TOKEN!,
      op: 'listTools'
    })

    expect(response).toEqual({ id: 10, ok: true, result: { tools: [] } })
    expect(executions).toBe(1)
    expect(h.mintMcpInvocation).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1].body).toEqual(post.mock.calls[0]![1].body)
    expect(post.mock.calls[1]![1].headers.authorization).toBe(post.mock.calls[0]![1].headers.authorization)
    expect(post.mock.calls[1]![1].headers['x-agentconnect-invocation-id']).toBe(INVOCATION_ID)
  })

  it('bounds a never-resolving POST, aborts it, clears timers, and returns ambiguous', async () => {
    const timers = new Set<ReturnType<typeof globalThis.setTimeout>>()
    const setTimeoutTracked = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = globalThis.setTimeout(() => {
        timers.delete(timer)
        if (typeof handler === 'function') handler(...args)
      }, timeout)
      timers.add(timer)
      return timer
    }) as typeof globalThis.setTimeout
    const clearTimeoutTracked = ((timer: ReturnType<typeof globalThis.setTimeout>) => {
      timers.delete(timer)
      globalThis.clearTimeout(timer)
    }) as typeof globalThis.clearTimeout
    let signal: AbortSignal | undefined
    const post = vi.fn(
      async (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>(() => {
          signal = init.signal
          // Deliberately ignores AbortSignal to prove the broker's own hard race.
        })
    )
    const h = await harness({
      fetch: post,
      postDeadlineMs: 20,
      setTimeout: setTimeoutTracked,
      clearTimeout: clearTimeoutTracked
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    const pending = ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 11,
      token: env.AC_MCP_TOKEN!,
      op: 'callTool',
      name: 'updateAgent',
      args: {}
    })

    await expect(pending).resolves.toEqual({ id: 11, ok: false, error: WEBCHAT_MCP_AMBIGUOUS_ERROR })
    expect(h.mintMcpInvocation).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    expect(timers.size).toBe(0)
  })

  it('keeps a mint failure retryable because no HTTP request could have been sent', async () => {
    const h = await harness({
      cpClient: {
        mintMcpInvocation: vi.fn(async () => {
          throw new WireError('INTERNAL', 'control plane disconnected', true)
        }),
        revokeWebchatMcpDelegation: vi.fn()
      }
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 12,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toEqual({
      id: 12,
      ok: false,
      error: 'AgentConnect admin tools are temporarily unavailable. Retry shortly.'
    })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['403', [{ type: 'text', text: 'Request failed (HTTP 403): forbidden' }]],
    ['412', [{ type: 'text', text: 'confirmation mismatch' }]],
    ['invalid', [{ type: 'text', text: 'invalid arguments' }]],
    ['rate-limit', [{ type: 'text', text: 'rate limit exceeded' }]]
  ])('preserves CP MCP isError content for %s results', async (_label, content) => {
    const h = await harness({
      fetch: vi.fn(async (_url, init) => {
        const { id } = JSON.parse((init.body as Buffer).toString('utf8'))
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content } }), {
          headers: { 'content-type': 'application/json' }
        })
      })
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 13,
        token: env.AC_MCP_TOKEN!,
        op: 'callTool',
        name: 'updateAgent',
        args: {}
      })
    ).resolves.toEqual({ id: 13, ok: true, result: { mcpContent: content, mcpIsError: true } })
  })

  it('maps a durable delegation denial to the reconnect error', async () => {
    const h = await harness({
      cpClient: {
        mintMcpInvocation: vi.fn(async () => {
          throw new WireError('DELEGATION_DENIED', 'Delegated MCP invocation is not authorized.', false)
        }),
        revokeWebchatMcpDelegation: vi.fn()
      }
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)

    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 9,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toEqual({ id: 9, ok: false, error: WEBCHAT_MCP_RECONNECT_ERROR })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('uses the reconnect error for an expired delegation denial and never falls back to another credential', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    h.setNow(Date.parse(EXPIRY))
    const response = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 3,
      token: env.AC_MCP_TOKEN!,
      op: 'callTool',
      name: 'listAgents',
      args: {}
    })

    expect(response).toEqual({ id: 3, ok: false, error: WEBCHAT_MCP_RECONNECT_ERROR })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('contains CP outages to this private admin server and remains usable after recovery', async () => {
    let fail = true
    const h = await harness({
      fetch: vi.fn(async (_url, init) => {
        if (fail) throw new Error('control plane offline')
        const body = init.body as Buffer
        const { id } = JSON.parse(body.toString('utf8'))
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }), {
          headers: { 'content-type': 'application/json' }
        })
      })
    })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 1,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toEqual({
      id: 1,
      ok: false,
      error: WEBCHAT_MCP_AMBIGUOUS_ERROR
    })
    fail = false
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 2,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toEqual({
      id: 2,
      ok: true,
      result: { tools: [] }
    })
  })

  it('rejects a copied token at another cell endpoint before mint', async () => {
    const h = await harness()
    const first = await h.broker.registerCell(binding())
    const second = await h.broker.registerCell(
      binding({
        isolationCellId: OTHER_CELL_ID,
        conversationId: OTHER_CONVERSATION_ID,
        delegationId: NEXT_DELEGATION_ID
      })
    )
    expect(first).not.toBeNull()
    const secondEnv = descriptorEnv(second!)
    const result = await ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
      id: 4,
      token: secondEnv.AC_MCP_TOKEN!,
      op: 'listTools'
    })
    expect(result).toEqual({ id: 4, ok: false, error: 'unknown or expired session token' })
    expect(h.mintMcpInvocation).not.toHaveBeenCalled()
  })

  it('cleans up sockets, tokens, and source directories on fenced release and shutdown', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const mount = h.broker.getCellMount(CELL_ID)!
    const token = descriptorEnv(server!).AC_MCP_TOKEN!
    await expect(h.broker.releaseCell(binding())).resolves.toBe(true)
    await expect(readFile(mount.sourceSocketPath)).rejects.toThrow()
    await expect(lstat(mount.sourceDirectory)).rejects.toThrow()
    await expect(ipc(mount.sourceSocketPath, { id: 1, token, op: 'listTools' })).rejects.toThrow()

    await h.broker.registerCell(
      binding({
        isolationCellId: OTHER_CELL_ID,
        generation: 2,
        delegationId: NEXT_DELEGATION_ID
      })
    )
    await h.broker.stop()
    expect(h.broker.getCellMount(OTHER_CELL_ID)).toBeNull()
  })
})

describe('SessionMcpBroker private IPC containment', () => {
  it('destroys oversized residual and framed requests before auth or mint, then still serves a legal connection', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const endpoint = h.broker.getCellMount(CELL_ID)!.sourceSocketPath
    const env = descriptorEnv(server!)

    await writeUntilClose(endpoint, 'x'.repeat(PRIVATE_MCP_MAX_FRAME_BYTES + 1))
    await writeUntilClose(
      endpoint,
      JSON.stringify({
        id: 1,
        token: env.AC_MCP_TOKEN,
        op: 'callTool',
        name: 'x',
        args: { body: 'x'.repeat(PRIVATE_MCP_MAX_FRAME_BYTES) }
      }) + '\n'
    )
    expect(h.mintMcpInvocation).not.toHaveBeenCalled()
    expect(h.broker.debugStats().connections).toBe(0)

    await expect(ipc(endpoint, { id: 2, token: env.AC_MCP_TOKEN!, op: 'listTools' })).resolves.toMatchObject({
      id: 2,
      ok: true
    })
  })

  it('rejects excessive pipelining atomically with zero mint and no leaked connection', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const endpoint = h.broker.getCellMount(CELL_ID)!.sourceSocketPath
    const env = descriptorEnv(server!)
    const pipeline = Array.from({ length: PRIVATE_MCP_MAX_PIPELINED_REQUESTS + 1 }, (_, index) =>
      encodeFrame({ id: index + 1, token: env.AC_MCP_TOKEN!, op: 'listTools' })
    ).join('')

    await writeUntilClose(endpoint, pipeline)
    expect(h.mintMcpInvocation).not.toHaveBeenCalled()
    expect(h.broker.debugStats().connections).toBe(0)
    await expect(ipc(endpoint, { id: 99, token: env.AC_MCP_TOKEN!, op: 'listTools' })).resolves.toMatchObject({
      id: 99,
      ok: true
    })
  })

  it('rejects non-narrow request objects before mint', async () => {
    const h = await harness()
    const server = await h.broker.registerCell(binding())
    const endpoint = h.broker.getCellMount(CELL_ID)!.sourceSocketPath
    const env = descriptorEnv(server!)
    const response = await ipc(endpoint, {
      id: 1,
      token: env.AC_MCP_TOKEN!,
      op: 'listTools',
      injected: true
    } as IpcRequest)
    expect(response).toMatchObject({ id: 1, ok: false })
    expect(h.mintMcpInvocation).not.toHaveBeenCalled()
  })
})

describe('SessionMcpBroker strict MCP response parsing', () => {
  it.each([
    ['wrong content type', new Response('{}', { headers: { 'content-type': 'text/plain' } })],
    [
      'wrong JSON-RPC version',
      new Response(JSON.stringify({ jsonrpc: '1.0', id: INVOCATION_ID, result: { tools: [] } }), {
        headers: { 'content-type': 'application/json' }
      })
    ],
    [
      'wrong response id',
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: { tools: [] } }), {
        headers: { 'content-type': 'application/json' }
      })
    ],
    [
      'result and error together',
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: INVOCATION_ID,
          result: { tools: [] },
          error: { code: -1, message: 'bad' }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    ],
    [
      'multiple SSE responses',
      new Response(
        `event: message\ndata: {"jsonrpc":"2.0","id":"${INVOCATION_ID}","result":{"tools":[]}}\n\n` +
          `event: message\ndata: {"jsonrpc":"2.0","id":"${INVOCATION_ID}","result":{"tools":[]}}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    ],
    ['empty SSE', new Response(': keepalive\n\n', { headers: { 'content-type': 'text/event-stream' } })],
    ['malformed SSE', new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } })]
  ])('rejects %s', async (_label, response) => {
    const h = await harness({ fetch: vi.fn(async () => response.clone()) })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 21,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toMatchObject({ id: 21, ok: false })
  })

  it('accepts exactly one SSE response with standard multi-line data', async () => {
    const response = new Response(
      `event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":"${INVOCATION_ID}","result":{"tools":[]}}\n\n`,
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
    )
    const h = await harness({ fetch: vi.fn(async () => response) })
    const server = await h.broker.registerCell(binding())
    const env = descriptorEnv(server!)
    await expect(
      ipc(h.broker.getCellMount(CELL_ID)!.sourceSocketPath, {
        id: 22,
        token: env.AC_MCP_TOKEN!,
        op: 'listTools'
      })
    ).resolves.toEqual({ id: 22, ok: true, result: { tools: [] } })
  })
})
