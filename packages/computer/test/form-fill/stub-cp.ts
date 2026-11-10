// A stub Control Plane for the form-fill image suite: registers the desktop, hands it a channel key, and signs agent tokens.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  buildComputerCpFrame,
  COMPUTER_CP_SUBPROTOCOL,
  COMPUTER_DESKTOPS_FEATURE,
  ComputerPolicySchema,
  signComputerChannelToken
} from '@agentconnect.md/protocol/computer'
import { WebSocketServer } from 'ws'

export interface StubCp {
  url: string
  registerToken: string
  authenticated(): boolean
  /** An `mcp` channel token for one agent session, as the CP's computer-channel/grant would issue it. */
  token(agentId: string, sessionId: string): string
  close(): Promise<void>
}

export async function startStubCp(host: string): Promise<StubCp> {
  const computerId = randomUUID()
  const registerToken = `acr_e2e_${randomBytes(12).toString('hex')}`
  const key = randomBytes(32)
  const keyId = 'k1'
  let authed = false
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/computers/register') return res.writeHead(404).end()
      if ((JSON.parse(body) as { token?: string }).token !== registerToken) return res.writeHead(401).end()
      const port = (http.address() as AddressInfo).port
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          computerId,
          orgId: 'org_e2e',
          apiKeyId: 'key_e2e',
          apiKey: 'ack_e2e',
          channelUrl: `ws://${host}:${port}/v1/computers/ws`
        })
      )
    })
  })
  const wss = new WebSocketServer({
    server: http,
    path: '/v1/computers/ws',
    handleProtocols: (protocols) => (protocols.has(COMPUTER_CP_SUBPROTOCOL) ? COMPUTER_CP_SUBPROTOCOL : false)
  })
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; id: string }
      if (frame.type !== 'computer/auth') return
      const now = Date.now()
      authed = true
      socket.send(
        JSON.stringify(
          buildComputerCpFrame(
            'computer/auth/ok',
            {
              computerId,
              orgId: 'org_e2e',
              name: 'form-fill-e2e',
              heartbeatSec: 15,
              serverTime: new Date(now).toISOString(),
              credential: {
                keyId,
                key: key.toString('base64url'),
                issuedAt: new Date(now).toISOString(),
                expiresAt: new Date(now + 3_600_000).toISOString()
              },
              policy: ComputerPolicySchema.parse({ shell: 'off' }),
              // Each agent gets its own desktop, as on a Computer that agents share (computer-use.md §3.9).
              features: [COMPUTER_DESKTOPS_FEATURE]
            },
            { corr: frame.id }
          )
        )
      )
    })
  })
  http.listen(0, '0.0.0.0')
  await new Promise((resolve) => http.once('listening', resolve))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://${host}:${port}`,
    registerToken,
    authenticated: () => authed,
    token: (agentId, sessionId) => {
      const now = Date.now()
      return signComputerChannelToken(
        {
          aud: 'mcp',
          cmp: computerId,
          kid: keyId,
          iat: now,
          exp: now + 240_000,
          ses: sessionId,
          agt: agentId,
          mode: 'control'
        },
        key
      )
    },
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => http.close(resolve))
    }
  }
}
