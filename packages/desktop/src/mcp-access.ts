// Who may call `/mcp` (computer-use.md §3.7, §8.2): an agent session's CP-issued channel token, or a prototype local client token.
import { WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server'
import {
  COMPUTER_CHANNEL_TOKEN_PREFIX,
  RELAY_COMPUTER_MAX_BODY_BYTES,
  type CrHttpRequest,
  type CrHttpResponse
} from '@agentconnect.md/protocol/computer'
import type { ChannelAuthority } from './cp/authority.js'

/** The caller of one MCP request: its lease holder name, and whether its policy lets it only watch. */
export interface McpPrincipal {
  client: string
  viewOnly: boolean
}

const bearer = (authorization: string | undefined): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]

/** A channel token's session, the holder name the CP's control lease names; undefined for anything else. */
export function channelPrincipal(
  authorization: string | undefined,
  authority: ChannelAuthority,
  computerId: () => string | undefined
): McpPrincipal | undefined {
  const token = bearer(authorization)
  const id = computerId()
  if (!token?.startsWith(`${COMPUTER_CHANNEL_TOKEN_PREFIX}.`) || !id) return undefined
  const claims = authority.verify(token, 'mcp', id)
  return claims?.ses ? { client: claims.ses, viewOnly: claims.mode === 'view' } : undefined
}

const RESPONSE_HEADERS = ['content-type', 'mcp-protocol-version', 'mcp-session-id', 'www-authenticate']

function reply(status: number, body: unknown, headers: Record<string, string> = {}): CrHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(body)).toString('base64')
  }
}

export interface RelayedMcpDeps {
  /** Channel tokens only: a relayed request never authenticates with a local client token. */
  authenticate: (authorization: string | undefined) => McpPrincipal | undefined
  createMcpServer: (principal: McpPrincipal) => McpServer
  log: (line: string) => void
}

/** Serve one `cr/http` request the relay forwarded, in process, through the same MCP server the local port serves. */
export function createRelayedMcpHandler(deps: RelayedMcpDeps): (request: CrHttpRequest) => Promise<CrHttpResponse> {
  return async (request) => {
    if (new URL(request.path, 'http://desktop.invalid').pathname !== '/mcp') return reply(404, { error: 'not found' })
    const principal = deps.authenticate(request.headers.authorization)
    if (!principal) return reply(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
    const mcp = deps.createMcpServer(principal)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    try {
      await mcp.connect(transport)
      const response = await transport.handleRequest(
        new Request('http://desktop.invalid/mcp', {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: Buffer.from(request.body, 'base64') } : {})
        })
      )
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > RELAY_COMPUTER_MAX_BODY_BYTES) return reply(500, { error: 'response too large' })
      const headers: Record<string, string> = {}
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name)
        if (value !== null) headers[name] = value
      }
      return { status: response.status, headers, ...(body.length > 0 ? { body: body.toString('base64') } : {}) }
    } catch (error) {
      deps.log(`relayed request failed: ${(error as Error).message}`)
      return reply(500, { error: 'failed' })
    } finally {
      void mcp.close().catch(() => undefined)
    }
  }
}
