import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { INTEGRATION_SETUP_URI, NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { McpAppsHost, type McpAppsHostDeps } from '../src/mcp/apps/host.js'
import { RemoteWebchatGrantManager } from '../src/mcp/remote-webchat-grant.js'

const orgId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const ui = NativeMcpUi.parse({
  resourceUri: INTEGRATION_SETUP_URI,
  resourceVersion: 1,
  orgId,
  intent: { mode: 'create', provider: 'github', agentId }
})
const result = { content: [{ type: 'text', text: JSON.stringify(ui) }] }

describe('native MCP UI', () => {
  it('negotiates and calls the admin endpoint over HTTP while keeping native rendering free of resource reads', async () => {
    const methods: string[] = []
    const authorizations: Array<string | undefined> = []
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string }
      methods.push(rpc.method)
      authorizations.push(request.headers.authorization)
      if (rpc.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const answer =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'admin-test', version: '1' }
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'configureIntegration',
                    inputSchema: { type: 'object', properties: {} },
                    _meta: { ui: { resourceUri: INTEGRATION_SETUP_URI } }
                  }
                ]
              }
            : result
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: answer }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const client = {
      issueWebchatMcpGrant: async (input: any) => ({
        ...input,
        grantId: crypto.randomUUID(),
        grantRevision: 1,
        token: 'test-only-token',
        expiresAt: '2030-01-01T00:00:00.000Z',
        mcpUrl: `http://127.0.0.1:${address.port}/mcp`
      }),
      acceptWebchatMcpGrant: async (input: any) => ({ ...input, activated: true }),
      revokeWebchatMcpGrant: async (input: any) => ({ ...input, revoked: true })
    }
    const manager = new RemoteWebchatGrantManager(client, undefined, () => orgId)
    try {
      await manager.provision(
        'conversation',
        { authorityId: orgId, authorityGeneration: 1, expiresAt: '2030-01-01T00:00:00.000Z' },
        Date.now(),
        agentId
      )
      expect(await manager.prepareApps('conversation', agentId)).toBe(true)
      const host = manager.appsFor('conversation', agentId)!
      expect(host.cachedToolsFor(undefined, ['agentconnect-admin'])[0]?.name).toBe(
        'agentconnect-admin__configureIntegration'
      )
      const called = await host.call(undefined, 'agentconnect-admin', 'configureIntegration', ui.intent)
      expect(called.card?.nativeUi).toEqual(ui)
      expect(called.card?.html).toBeUndefined()
      expect(methods).toContain('initialize')
      expect(methods).toContain('tools/call')
      expect(methods).not.toContain('resources/read')
      expect(authorizations.every((header) => header === 'Bearer test-only-token')).toBe(true)
    } finally {
      await manager.revokeAll('session_closed')
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('substitutes a trusted resource without fetching HTML; ordinary providers cannot opt in through their result', async () => {
    const readResource = vi.fn(async () => ({
      contents: [{ uri: INTEGRATION_SETUP_URI, mimeType: 'text/html;profile=mcp-app', text: '<p>untrusted</p>' }]
    }))
    const conn = {
      client: { callTool: vi.fn(async () => ({ ...result, nativeUi: ui })), readResource },
      tools: new Map([
        [
          'configureIntegration',
          {
            descriptor: { name: 'admin__configureIntegration' },
            templateUri: INTEGRATION_SETUP_URI,
            resultVisibleToModel: true,
            raw: {}
          }
        ]
      ]),
      templates: new Map()
    }
    for (const trusted of [true, false]) {
      const host = new McpAppsHost({ defs: () => ({}), ...(trusted ? { nativeResource: () => ui } : {}) })
      vi.spyOn(host as unknown as { connect: () => Promise<unknown> }, 'connect').mockResolvedValue(conn)
      const called = await host.call(undefined, 'admin', 'configureIntegration', {})
      if (trusted) {
        expect(called.card?.nativeUi).toEqual(ui)
        expect(called.card?.html).toBeUndefined()
        expect(readResource).not.toHaveBeenCalled()
      } else {
        expect(called.card?.nativeUi).toBeUndefined()
        expect(called.card?.html).toBe('<p>untrusted</p>')
      }
    }
  })

  it('isolates connections by conversation, rejects a different agent, and retires them on revocation', async () => {
    const tools = vi.spyOn(McpAppsHost.prototype, 'toolsFor').mockResolvedValue([
      {
        name: 'agentconnect-admin__configureIntegration',
        description: '',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      }
    ])
    const close = vi.spyOn(McpAppsHost.prototype, 'close').mockResolvedValue()
    const client = {
      issueWebchatMcpGrant: vi.fn(async (input: any) => ({
        ...input,
        grantId: crypto.randomUUID(),
        grantRevision: 1,
        token: 'private-test-grant',
        expiresAt: '2030-01-01T00:00:00.000Z',
        mcpUrl: 'https://example.test/mcp'
      })),
      acceptWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, activated: true })),
      revokeWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, revoked: true }))
    }
    try {
      const manager = new RemoteWebchatGrantManager(client, undefined, () => orgId)
      const entitlement = { authorityId: orgId, authorityGeneration: 1, expiresAt: '2030-01-01T00:00:00.000Z' }
      for (const conversation of ['a', 'b']) {
        await manager.provision(conversation, entitlement, Date.now(), agentId)
        expect(await manager.prepareApps(conversation, agentId)).toBe(true)
      }
      const a = manager.appsFor('a', agentId)!
      expect(a).not.toBe(manager.appsFor('b', agentId))
      expect(manager.appsFor('a', 'another-agent')).toBeUndefined()
      const deps = (a as unknown as { deps: McpAppsHostDeps }).deps
      expect(deps.nativeResource?.('configureIntegration', INTEGRATION_SETUP_URI, result)).toEqual(ui)
      expect(deps.nativeResource?.('anotherTool', INTEGRATION_SETUP_URI, result)).toBeUndefined()
      expect(
        deps.nativeResource?.('configureIntegration', INTEGRATION_SETUP_URI, {
          content: [{ type: 'text', text: JSON.stringify({ ...ui, orgId: agentId }) }]
        })
      ).toBeUndefined()
      await manager.revokeConversation('a', 'session_closed')
      expect(manager.appsFor('a', agentId)).toBeUndefined()
      expect(manager.appsFor('b', agentId)).toBeDefined()
      expect(deps.defs(undefined)).toEqual({})
      expect(close).toHaveBeenCalledTimes(1)
      await manager.revokeAll('session_closed')
    } finally {
      tools.mockRestore()
      close.mockRestore()
    }
  })
})
