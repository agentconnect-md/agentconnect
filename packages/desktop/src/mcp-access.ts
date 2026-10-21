// Who may call `/mcp` (computer-use.md §3.7, §8.2): an agent session's CP-issued channel token, or a prototype local client token.
import { WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server'
import {
  COMPUTER_CHANNEL_TOKEN_PREFIX,
  COMPUTER_VIEWER_API_PREFIX,
  computerLeaseHolderName,
  RELAY_COMPUTER_MAX_BODY_BYTES,
  type CrHttpRequest,
  type CrHttpResponse
} from '@agentconnect.md/protocol/computer'
import type { ChannelAuthority } from './cp/authority.js'
import type { ViewerPrincipal, ViewerRequest, ViewerResponse, ViewerVia } from './viewer.js'

/** The caller of one MCP request: its lease holder name, and whether its policy lets it only watch. */
export interface McpPrincipal {
  client: string
  viewOnly: boolean
  // Set for an agent session's channel token: the agent daemon behind it reports how each call was approved.
  agent?: { agentId: string; sessionId: string }
}

const bearer = (authorization: string | undefined): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]

/** A channel token's agent and session, the holder the CP's control lease names; undefined for anything else. */
export function channelPrincipal(
  authorization: string | undefined,
  authority: ChannelAuthority,
  computerId: () => string | undefined
): McpPrincipal | undefined {
  const token = bearer(authorization)
  const id = computerId()
  if (!token?.startsWith(`${COMPUTER_CHANNEL_TOKEN_PREFIX}.`) || !id) return undefined
  const claims = authority.verify(token, 'mcp', id)
  if (!claims?.ses || !claims.agt) return undefined
  return {
    client: computerLeaseHolderName({ agentId: claims.agt, sessionId: claims.ses }),
    viewOnly: claims.mode === 'view',
    agent: { agentId: claims.agt, sessionId: claims.ses }
  }
}

const RESPONSE_HEADERS = ['allow', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'www-authenticate']

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
  // The console viewer's API (`/view/api/*`); it authenticates view tokens itself.
  viewer?: (request: ViewerRequest) => Promise<ViewerResponse>
}

/** A console member's view token: who watches, whether they may take over, and the TURN servers issued with it. */
export function viewerPrincipal(
  authorization: string | undefined,
  authority: ChannelAuthority,
  computerId: () => string | undefined
): ViewerPrincipal | undefined {
  const token = bearer(authorization)
  const id = computerId()
  if (!token?.startsWith(`${COMPUTER_CHANNEL_TOKEN_PREFIX}.`) || !id) return undefined
  const claims = authority.verify(token, 'view', id)
  if (!claims?.usr) return undefined
  return {
    client: `console:${claims.usr}`,
    control: claims.mode === 'control',
    iceServers: claims.ice ?? [],
    valid: () => authority.verify(token, 'view', id) !== undefined
  }
}

/** Viewer auth: a console view token on either path, a local client token only on the local port, never through a relay. */
export function viewerAuthenticator(
  member: (authorization: string | undefined) => ViewerPrincipal | undefined,
  localClient: (authorization: string | undefined) => string | undefined
): (authorization: string | undefined, via: ViewerVia) => ViewerPrincipal | undefined {
  return (authorization, via) => {
    const principal = member(authorization)
    if (principal) return principal
    if (via !== 'local') return undefined
    const client = localClient(authorization)
    return client ? { client, control: true } : undefined
  }
}

/** Serve one `cr/http` request the relay forwarded, in process, through the same MCP server the local port serves. */
export function createRelayedMcpHandler(deps: RelayedMcpDeps): (request: CrHttpRequest) => Promise<CrHttpResponse> {
  return async (request) => {
    const pathname = new URL(request.path, 'http://desktop.invalid').pathname
    if (deps.viewer && pathname.startsWith(COMPUTER_VIEWER_API_PREFIX)) {
      const out = await deps.viewer({
        method: request.method,
        path: pathname,
        authorization: request.headers.authorization,
        via: 'relay',
        ...(request.body ? { body: Buffer.from(request.body, 'base64') } : {})
      })
      if (out.body.length > RELAY_COMPUTER_MAX_BODY_BYTES) return reply(500, { error: 'response too large' })
      return {
        status: out.status,
        headers: out.headers,
        ...(out.body.length > 0 ? { body: out.body.toString('base64') } : {})
      }
    }
    if (pathname !== '/mcp') return reply(404, { error: 'not found' })
    const principal = deps.authenticate(request.headers.authorization)
    if (!principal) return reply(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
    // A buffered relay cannot carry the standalone SSE stream a GET opens; 405 tells the client there is none.
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return reply(405, { error: 'method not allowed' }, { allow: 'POST, DELETE' })
    }
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
