// The daemon handshake limit reaches the gateway through the full container, not only through the test app.
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'

const SUBPROTOCOL = 'agentconnect.v1'

let running: App | undefined

afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

describe('daemon handshake limit through buildApp', () => {
  it('refuses a second upgrade with 503 while the only handshake slot is held', async () => {
    const config = AppConfigSchema.parse({
      DATABASE_URL: 'postgresql://handshake-limit/ignored', // prisma is injected; URL unused
      API_KEY_PEPPER: 'handshake-limit-pepper-0123456789abcdef',
      SECRETS_PROVIDER: 'memory',
      WS_PATH: '/daemon/ws',
      DAEMON_HANDSHAKE_CONCURRENCY: '1'
    })
    const app = buildApp({ prisma, config, clock: systemClock, secretsProvider: new MemorySecretsProvider() })
    running = app
    const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
    app.mountWs()
    const url = `${address.replace(/^http/, 'ws')}${config.WS_PATH}`

    const opened: WebSocket[] = []
    try {
      const holder = new WebSocket(url, SUBPROTOCOL)
      opened.push(holder)
      await new Promise<void>((resolve, reject) => {
        holder.once('open', () => resolve())
        holder.once('error', reject)
      })
      const refused = new WebSocket(url, SUBPROTOCOL)
      opened.push(refused)
      const status = await new Promise<number>((resolve) => {
        refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        refused.once('open', () => resolve(101))
      })
      expect(status).toBe(503)
    } finally {
      for (const ws of opened) ws.terminate()
    }
  })
})
