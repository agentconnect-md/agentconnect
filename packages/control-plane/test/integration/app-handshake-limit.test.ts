// The daemon handshake limit reaches the gateway through the full container, not only through the test app.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'

const SUBPROTOCOL = 'agentconnect.v1'
const PEPPER = 'handshake-limit-pepper-0123456789abcdef'

let running: App | undefined

afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

describe('daemon handshake limit through buildApp', () => {
  it('refuses concurrent auth steps past a limit of 1 with close 4429', async () => {
    const config = AppConfigSchema.parse({
      DATABASE_URL: 'postgresql://handshake-limit/ignored', // prisma is injected; URL unused
      API_KEY_PEPPER: PEPPER,
      SECRETS_PROVIDER: 'memory',
      WS_PATH: '/daemon/ws',
      DAEMON_HANDSHAKE_CONCURRENCY: '1'
    })
    const app = buildApp({ prisma, config, clock: systemClock, secretsProvider: new MemorySecretsProvider() })
    running = app
    const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
    app.mountWs()
    const url = `${address.replace(/^http/, 'ws')}${config.WS_PATH}`

    // Five stays under the seven an unwired pool-of-10 default would admit, so only the configured 1 refuses.
    const sockets: WebSocket[] = []
    try {
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(url, SUBPROTOCOL)
        ws.on('error', () => {})
        sockets.push(ws)
        await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      }
      const closes = sockets.map((ws) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code))))
      // Well-formed but unknown keys, so each admitted auth holds its slot across a real key lookup before its 4401.
      const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })
      for (const ws of sockets) {
        const payload = { apiKey: codec.mint().token, agentVersion: '1.4.0' }
        ws.send(JSON.stringify({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type: 'auth', payload }))
      }
      const codes = await Promise.all(closes)
      expect(codes.every((code) => code === 4401 || code === 4429)).toBe(true)
      expect(codes.filter((code) => code === 4429).length).toBeGreaterThan(0)
    } finally {
      for (const ws of sockets) ws.terminate()
    }
  })
})
