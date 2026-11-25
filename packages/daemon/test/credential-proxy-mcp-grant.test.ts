import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import {
  grantKeyOf,
  judgeMcpGrantPost,
  mcpGrantShimRefusal,
  placeholderHeaders,
  type McpGrantRoute
} from '../src/credential-proxy/mcp-grant-route.js'
import { loadPlaceholderKey, openPlaceholder, sealPlaceholder } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { GITHUB_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'
import { APPROVAL_WAIT_MS, ApprovalRecords, argumentsDigest } from '../src/mcp/approval-records.js'

// A `daemon`-custody MCP grant through the credential proxy (mcp-tool-permissions.md §7.2): the runtime holds a placeholder, and each call is judged here.

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const KEY = 'mcpg_real_grant_key'
const RELAY = 'relay.example.test'
const PATH = '/mcp/00000000-0000-4000-8000-000000000001'
const HTTPS = { scheme: 'https' as const }
const quiet = { info: () => {}, warn: () => {} }
const DECISIONS: McpToolDecisions = {
  allow: ['read_note'],
  approval: ['write_note'],
  ask: ['wire_transfer'],
  block: ['delete_all']
}

const toLoopback: LookupFunction = (_host, options, callback) => {
  if (options.all)
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 }
    ])
  else callback(null, '127.0.0.1', 4)
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  vi.useRealTimers()
})

function routesAt(port: number): McpGrantRoute[] {
  return [
    { provider: 'probe', url: `https://${RELAY}:${port}${PATH}`, key: KEY, decisions: DECISIONS },
    { provider: 'other', url: `https://other-relay.example.test:${port}/mcp/2`, key: 'other-key', decisions: DECISIONS }
  ]
}

function proxyWith(options: { port?: number; upstream?: { lookupFor: () => LookupFunction; trustedCa: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-mcpg-'))
  dirs.push(dir)
  const records = new ApprovalRecords()
  const log = { info: vi.fn(), warn: vi.fn() }
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca: loadProxyCa(join(dir, 'ca')),
    mint: async () => ({ username: 'x-access-token', token: 'ghs_minted', access: 'write' as const }),
    workspaceRepo: () => undefined,
    instancesOf: (agentId) => (agentId === AGENT ? [GITHUB_MANAGED_HOST] : []),
    runningAgents: () => [AGENT, OTHER],
    knownAgent: () => true,
    mcpGrantsOf: (agentId) =>
      agentId === AGENT
        ? routesAt(options.port ?? 443)
        : [{ provider: 'mine', url: `https://${RELAY}/mcp/3`, key: 'own-key', decisions: DECISIONS }],
    approvals: records,
    log,
    ...(options.upstream ? { upstream: options.upstream } : {})
  })
  return { proxy, records, dir, log }
}

const at = (port = 443) => `https://${RELAY}${port === 443 ? '' : `:${port}`}${PATH}`

function post(placeholder: string, message: unknown, extra: Record<string, string> = {}): Request {
  return new Request(at(), {
    method: 'POST',
    headers: { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json', ...extra },
    body: typeof message === 'string' ? message : JSON.stringify(message)
  })
}

const call = (name: string, args: unknown, id = 'toolu_1', meta: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args, _meta: { 'claudecode/toolUseId': id, ...meta } }
})

const info = { ...HTTPS, requestTarget: PATH }

describe('the mcp-grant placeholder', () => {
  it('is sealed for the agent, the provider, the relay origin and the session, and never carries the key', () => {
    const { proxy, dir } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe', 'session-a')!
    expect(placeholder).not.toContain(KEY)
    expect(Buffer.from(placeholder.split('.')[0]!.slice(6), 'base64url').toString()).not.toContain(KEY)
    expect(openPlaceholder(loadPlaceholderKey(join(dir, 'proxy.key')), placeholder)).toEqual({
      agentId: AGENT,
      hosts: [RELAY],
      kind: 'mcp-grant',
      mcpProvider: 'probe',
      session: 'session-a'
    })
    expect(proxy.mcpGrantPlaceholderFor(AGENT, 'missing')).toBeUndefined()
    expect(proxy.mcpGrantPlaceholderFor(OTHER, 'probe')).toBeUndefined()
    expect(proxy.mcpGrantPlaceholderFor(OTHER, 'mine')).toBeDefined()
    expect(() => sealPlaceholder(Buffer.alloc(32), { agentId: AGENT, hosts: [], kind: 'mcp-grant' })).toThrow()
    expect(proxy.domainsFor(AGENT)).toEqual(expect.arrayContaining([RELAY, 'other-relay.example.test']))
    expect(proxy.domainsFor(OTHER)).not.toContain('other-relay.example.test')
  })

  it('swaps in the key with the inbound approval header dropped, for GET and DELETE', async () => {
    const { proxy } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    for (const method of ['GET', 'DELETE']) {
      const request = new Request(at(), {
        method,
        headers: { authorization: `Bearer ${placeholder}`, 'x-ac-tool-approval': 'person' }
      })
      expect(await proxy.decide(request, info)).toEqual({
        action: 'allow',
        removeHeaders: ['x-ac-tool-approval'],
        setHeaders: [['authorization', `Bearer ${KEY}`]]
      })
    }
  })

  it('refuses another agent’s socket, another origin or path, cleartext, a forged seal and a non-Bearer scheme', async () => {
    const { proxy } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const get = (url: string, authorization = `Bearer ${placeholder}`) =>
      new Request(url, { headers: { authorization } })
    expect(await proxy.decide(get(at()), info, OTHER)).toMatchObject({ action: 'deny', status: 403 })
    const elsewhere = get(`https://other-relay.example.test/mcp/2`)
    expect(await proxy.decide(elsewhere, { ...HTTPS, requestTarget: '/mcp/2' })).toMatchObject({
      action: 'deny',
      status: 403
    })
    expect(await proxy.decide(get(at()), { ...HTTPS, requestTarget: '/mcp/other' })).toMatchObject({
      action: 'deny',
      status: 403
    })
    expect(await proxy.decide(get(at()), { scheme: 'http', requestTarget: PATH })).toMatchObject({
      action: 'deny',
      status: 403
    })
    expect(await proxy.decide(get(at(), `Bearer ${placeholder.slice(0, -2)}xx`), info)).toMatchObject({
      action: 'deny',
      status: 403
    })
    expect(await proxy.decide(get(at(), `token ${placeholder}`), info)).toMatchObject({ action: 'deny', status: 400 })
    // Nor is it a code-host token, nor a code-host placeholder the grant.
    expect(
      await proxy.decide(
        new Request('https://api.github.com/user', { headers: { authorization: `Bearer ${placeholder}` } }),
        HTTPS
      )
    ).toMatchObject({ action: 'deny', status: 403 })
    expect(await proxy.decide(get(at(), `Bearer ${proxy.placeholderFor(AGENT)}`), info)).toMatchObject({
      action: 'allow'
    })
  })

  it('passes a request without its placeholder through unjudged, and a bypass reaches the relay with only the placeholder', async () => {
    const { proxy } = proxyWith()
    const shared = new Request(at(), {
      method: 'POST',
      headers: { authorization: 'Bearer shared-grant-key', 'x-ac-tool-approval': 'person' },
      body: JSON.stringify(call('delete_all', {}))
    })
    expect(await proxy.decide(shared, info)).toEqual({ action: 'allow', removeHeaders: ['x-ac-tool-approval'] })
    // An origin the proxy does not serve is left alone, so a runtime that skips the proxy presents a placeholder the relay refuses.
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const bypass = new Request('https://unserved.example.test/mcp/1', {
      headers: { authorization: `Bearer ${placeholder}` }
    })
    expect(await proxy.decide(bypass, HTTPS)).toEqual({ action: 'allow' })
  })

  it('caps a session’s GET streams at four, counted until each closes', async () => {
    const { proxy } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe', 'session-a')!
    const open = () => {
      const controller = new AbortController()
      const request = new Request(at(), {
        headers: { authorization: `Bearer ${placeholder}` },
        signal: controller.signal
      })
      return { controller, decision: proxy.decide(request, info) }
    }
    const streams = Array.from({ length: 4 }, open)
    for (const stream of streams) expect(await stream.decision).toMatchObject({ action: 'allow' })
    expect(await open().decision).toMatchObject({ action: 'deny', status: 429 })
    const another = proxy.mcpGrantPlaceholderFor(AGENT, 'probe', 'session-b')!
    expect(
      await proxy.decide(new Request(at(), { headers: { authorization: `Bearer ${another}` } }), info)
    ).toMatchObject({ action: 'allow' })
    streams[0]!.controller.abort()
    expect(await open().decision).toMatchObject({ action: 'allow' })
  })
})

describe('the proxy’s judgment of a call', () => {
  it('forwards Always allow re-serialized with the key, and refuses Blocked with the relay’s wording', async () => {
    const { proxy, log } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const allowed = await proxy.decide(
      post(
        placeholder,
        '{ "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"n":2.50}}}'
      ),
      info
    )
    expect(allowed).toEqual({
      action: 'allow',
      removeHeaders: ['x-ac-tool-approval'],
      setHeaders: [['authorization', `Bearer ${KEY}`]],
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"n":2.5}}}'
    })
    // A duplicate key reads as the parser reads it, and what is forwarded is that reading.
    const smuggled = await proxy.decide(
      post(
        placeholder,
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","name":"delete_all"}}'
      ),
      info
    )
    expect(smuggled).toMatchObject({ action: 'respond', status: 200, contentType: 'application/json' })
    expect(JSON.parse((smuggled as { body: string }).body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'The tool "delete_all" is blocked for this agent.' }], isError: true }
    })
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('"delete_all" of probe'))
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(KEY)
    const other = await proxy.decide(post(placeholder, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), info)
    expect(other).toMatchObject({ action: 'allow', body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' })
    expect(await proxy.decide(post(placeholder, '{not json'), info)).toMatchObject({ action: 'respond', status: 400 })
  })

  it('forwards a Needs approval call once, with its record’s source, for the same tool and arguments', async () => {
    const { proxy, records } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const put = (
      id: string,
      args: unknown,
      source: 'person' | 'runtime-review' = 'runtime-review',
      tool = 'write_note'
    ) =>
      records.put({
        agentId: AGENT,
        toolCallId: id,
        provider: 'probe',
        tool,
        argsDigest: argumentsDigest(args),
        source
      })
    put('toolu_1', { text: 'hello', n: 2.5 })
    const approved = await proxy.decide(
      post(
        placeholder,
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"write_note","arguments":{"n":2.50,"text":"hello"},"_meta":{"claudecode/toolUseId":"toolu_1"}}}'
      ),
      info
    )
    expect(approved).toMatchObject({
      action: 'allow',
      setHeaders: [
        ['authorization', `Bearer ${KEY}`],
        ['x-ac-tool-approval', 'runtime-review']
      ]
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const refusedAfter = async (request: Request) => {
      const decision = proxy.decide(request, info)
      await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS)
      const answer = (await decision) as { action: string; body: string }
      expect(answer.action).toBe('respond')
      expect(JSON.parse(answer.body).result.content[0].text).toBe(
        'The tool "write_note" requires approval, and this call was not approved.'
      )
    }
    // Used once.
    await refusedAfter(post(placeholder, call('write_note', { text: 'hello', n: 2.5 })))
    // Other arguments, another tool's record, or no call id.
    put('toolu_1', { text: 'hello' })
    await refusedAfter(post(placeholder, call('write_note', { text: 'changed' })))
    put('toolu_2', { text: 'hello' }, 'person', 'read_note')
    await refusedAfter(post(placeholder, call('write_note', { text: 'hello' }, 'toolu_2')))
    await refusedAfter(
      post(placeholder, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_note' } })
    )
    // Codex names its call by `callId`.
    put('exec-1', { text: 'x' }, 'person')
    const codex = await proxy.decide(
      post(placeholder, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'write_note', arguments: { text: 'x' }, _meta: { callId: 'exec-1' } }
      }),
      info
    )
    expect(codex).toMatchObject({
      action: 'allow',
      setHeaders: [
        ['authorization', `Bearer ${KEY}`],
        ['x-ac-tool-approval', 'person']
      ]
    })
  })

  it('waits up to two seconds for a record its call outran', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { proxy, records } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const decision = proxy.decide(post(placeholder, call('write_note', { text: 'late' })), info)
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS - 50)
    records.put({
      agentId: AGENT,
      toolCallId: 'toolu_1',
      provider: 'probe',
      tool: 'write_note',
      argsDigest: argumentsDigest({ text: 'late' }),
      source: 'person'
    })
    expect(await decision).toMatchObject({ action: 'allow', body: expect.stringContaining('write_note') })
  })

  it('accepts only a person for Always ask, and judges a batch as if nothing were approved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { proxy, records } = proxyWith()
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
    const record = (source: 'person' | 'runtime-review') =>
      records.put({
        agentId: AGENT,
        toolCallId: 'toolu_1',
        provider: 'probe',
        tool: 'wire_transfer',
        argsDigest: argumentsDigest({ iban: 'x' }),
        source
      })
    record('runtime-review')
    const reviewed = proxy.decide(post(placeholder, call('wire_transfer', { iban: 'x' })), info)
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS)
    expect(await reviewed).toMatchObject({ action: 'respond', status: 200 })
    record('person')
    expect(await proxy.decide(post(placeholder, call('wire_transfer', { iban: 'x' })), info)).toMatchObject({
      action: 'allow',
      setHeaders: [
        ['authorization', `Bearer ${KEY}`],
        ['x-ac-tool-approval', 'person']
      ]
    })
    record('person')
    const batch = await proxy.decide(
      post(placeholder, [call('wire_transfer', { iban: 'x' }), { jsonrpc: '2.0', id: 8, method: 'tools/list' }]),
      info
    )
    expect(batch).toMatchObject({ action: 'respond', status: 200 })
    const answers = JSON.parse((batch as { body: string }).body) as { id: number; result?: unknown; error?: unknown }[]
    expect(answers.map((answer) => answer.id)).toEqual([7, 8])
    expect(answers[0]!.result).toMatchObject({ isError: true })
    expect(answers[1]!.error).toMatchObject({ code: -32600 })
    // A batch never consumes the record.
    expect(records.get(AGENT, 'toolu_1')).toBeDefined()
    const notification = await judgeMcpGrantPost(
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'delete_all' } }),
      DECISIONS,
      async () => 'person'
    )
    expect(notification).toEqual({ kind: 'respond', status: 202, refused: ['delete_all'] })
  })
})

describe('a session’s grant definition', () => {
  it('carries the placeholder in Authorization, and is refused where the key appears elsewhere', () => {
    const headers = [{ name: 'Authorization', value: `Bearer ${KEY}` }]
    expect(grantKeyOf(headers)).toBe(KEY)
    expect(placeholderHeaders(headers, KEY, 'acph1_x.y')).toEqual([
      { name: 'Authorization', value: 'Bearer acph1_x.y' }
    ])
    expect(placeholderHeaders([...headers, { name: 'X-Copy', value: KEY }], KEY, 'acph1_x.y')).toBeUndefined()
  })

  it('stays off an srt session placed on an executor, naming that shim; every other shim is asked at spawn', () => {
    expect(mcpGrantShimRefusal({ strategy: 'host' })).toBeUndefined()
    expect(mcpGrantShimRefusal({ strategy: 'srt' })).toBeUndefined()
    expect(mcpGrantShimRefusal({ strategy: 'microsandbox' })).toBeUndefined()
    expect(
      mcpGrantShimRefusal({ strategy: 'host', placed: { strategy: 'srt', executorDaemonId: 'exec-daemon' } })
    ).toContain('the srt shim of daemon exec-daemon')
  })
})

interface Seen {
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

/** One request through the proxy's loopback listener to `authority`, answered whole. */
function through(
  proxyUrl: string,
  authority: string,
  caPem: string,
  request: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const connect = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: authority })
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return resolve({ status: res.statusCode ?? 0, body: '', headers: {} })
      }
      const [hostname = '', port = '443'] = authority.split(':')
      const tls = tlsConnect({ socket, servername: hostname, ca: caPem })
      const req = httpRequest(
        {
          createConnection: () => tls as unknown as Socket,
          host: hostname,
          port: Number(port),
          method: request.method ?? 'GET',
          path: request.path,
          headers: { ...request.headers, connection: 'close' }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (body += chunk))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }))
          response.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end(request.body)
    })
    connect.on('error', reject)
    connect.end()
  })
}

describe('MCP grants through the proxy end to end', () => {
  let upstream: HttpsServer
  let port = 0
  let upstreamCaPem = ''
  const seen: Seen[] = []

  beforeAll(async () => {
    const generated = generateCa({ cn: 'example relay CA' })
    upstreamCaPem = generated.certPem
    const mitm = createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem })
    const leaf = mintLeafCert(mitm, RELAY)
    const context = createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })
    upstream = createHttpsServer({ SNICallback: (_name, callback) => callback(null, context) }, (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => (body += chunk))
      req.on('end', () => {
        seen.push({ ...(req.url ? { url: req.url } : {}), headers: req.headers, body })
        res.setHeader('content-type', 'application/json')
        res.end('{"jsonrpc":"2.0","id":7,"result":{"content":[]}}')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    port = (upstream.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('forwards what it judged with the key, answers a refusal itself, and adds the approval it checked', async () => {
    const { proxy, records, dir } = proxyWith({
      port,
      upstream: { lookupFor: () => toLoopback, trustedCa: upstreamCaPem }
    })
    await proxy.start(join(dir, 'run'))
    try {
      const ca = loadProxyCa(join(dir, 'ca'))
      const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'probe')!
      const send = (body: string, headers: Record<string, string> = {}) =>
        through(proxy.loopbackUrl()!, `${RELAY}:${port}`, ca.certPem, {
          method: 'POST',
          path: PATH,
          headers: { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json', ...headers },
          body
        })
      seen.length = 0
      const allowed = await send(
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_note","arguments":{"n":2.50}}}',
        {
          'x-ac-tool-approval': 'person'
        }
      )
      expect(allowed.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(seen[0]!.headers['x-ac-tool-approval']).toBeUndefined()
      expect(seen[0]!.body).toBe(
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_note","arguments":{"n":2.5}}}'
      )
      expect(seen[0]!.headers['content-length']).toBe(String(Buffer.byteLength(seen[0]!.body)))

      const blocked = await send(JSON.stringify(call('delete_all', {})))
      expect(blocked.status).toBe(200)
      expect(blocked.headers['content-type']).toBe('application/json')
      expect(JSON.parse(blocked.body)).toMatchObject({ id: 7, result: { isError: true } })
      expect(seen).toHaveLength(1)

      records.put({
        agentId: AGENT,
        toolCallId: 'toolu_1',
        provider: 'probe',
        tool: 'write_note',
        argsDigest: argumentsDigest({ text: 'hello' }),
        source: 'person'
      })
      const approved = await send(JSON.stringify(call('write_note', { text: 'hello' })))
      expect(approved.status).toBe(200)
      expect(seen).toHaveLength(2)
      expect(seen[1]!.headers['x-ac-tool-approval']).toBe('person')
      expect(seen[1]!.headers.authorization).toBe(`Bearer ${KEY}`)
    } finally {
      await proxy.stop()
    }
  })
})
