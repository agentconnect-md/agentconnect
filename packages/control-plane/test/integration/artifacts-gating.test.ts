// Artifacts are offered only with a transfer bucket and a content domain (artifacts.md §12), over the assembled app.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ARTIFACTS_FEATURE, isFrame, type AnyFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const API_KEY_PEPPER = 'gating-api-key-pepper-0123456789abcdef'
// The bucket's static keys are read at boot, so they exist on disk; nothing ever dials the store.
const CREDS = mkdtempSync(join(tmpdir(), 'ac-artifacts-gating-'))
writeFileSync(join(CREDS, 'id'), 'AKIDEXAMPLE')
writeFileSync(join(CREDS, 'secret'), 'example-secret')
const BUCKET = JSON.stringify({
  version: 1,
  endpoint: 'https://store.example.test',
  region: 'us-east-1',
  bucket: 'ac-cache',
  forcePathStyle: true,
  credentials: { source: 'static', dir: CREDS, accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' }
})

let running: App | undefined
afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

function nextFrame(ws: WebSocket, type: string): Promise<AnyFrame> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as AnyFrame
      if (frame.type !== type) return
      ws.off('message', onMsg)
      resolve(frame)
    }
    ws.on('message', onMsg)
    ws.once('close', (code) => reject(new Error(`closed waiting for ${type}: ${code}`)))
  })
}

const send = (ws: WebSocket, type: string, payload: unknown) =>
  ws.send(JSON.stringify({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload }))

/** The features one daemon is told and the console's runtime config, for a deployment with `env`. */
async function deployment(env: Record<string, string>) {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://gating/ignored',
    API_KEY_PEPPER,
    SECRETS_PROVIDER: 'memory',
    PUBLIC_WEB_URL: 'https://console.example.test',
    ...env
  })
  const app = buildApp({ prisma, config, clock: systemClock, secretsProvider: new MemorySecretsProvider() })
  running = app
  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()

  const daemonId = randomUUID()
  const minted = new ApiKeyCodec({ API_KEY_PEPPER }).mint()
  await prisma.daemon.create({ data: { id: daemonId, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
  await prisma.apiKey.create({
    data: {
      principalType: 'daemon',
      orgId: DEFAULT_ORG_ID,
      daemonId,
      hash: minted.hash,
      displayTail: minted.displayTail
    }
  })
  const ws = new WebSocket(`${address.replace(/^http/, 'ws')}${config.WS_PATH}`, 'agentconnect.v1')
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
  try {
    send(ws, 'auth', { apiKey: minted.token, daemonId, agentVersion: '1.5.0' })
    await nextFrame(ws, 'auth/ok')
    send(ws, 'register', {
      host: 'gating-host',
      capabilities: { platforms: [], runtimes: ['claude'], acp: true },
      maxAgents: 1,
      localState: { assignments: [], crons: [], leases: [] }
    })
    const ok = await nextFrame(ws, 'register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
    const runtime = await app.http.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    return { features: ok.payload.serverFeatures ?? [], artifacts: runtime.json().artifacts }
  } finally {
    ws.close()
    await app.shutdown()
    running = undefined
  }
}

describe('artifact feature gating', () => {
  it('advertises artifacts-v1 and tells the console the content domain only with a bucket and a content domain', async () => {
    const both = await deployment({ AC_FILE_TRANSFER: BUCKET, ARTIFACTS_CONTENT_DOMAIN: 'example-usercontent.net' })
    expect(both.features).toContain(ARTIFACTS_FEATURE)
    expect(both.artifacts).toEqual({ enabled: true, contentDomain: 'example-usercontent.net' })

    const halves: Record<string, string>[] = [
      { AC_FILE_TRANSFER: BUCKET },
      { ARTIFACTS_CONTENT_DOMAIN: 'example-usercontent.net' }
    ]
    for (const env of halves) {
      const off = await deployment(env)
      expect(off.features).not.toContain(ARTIFACTS_FEATURE)
      expect(off.artifacts).toEqual({ enabled: false, contentDomain: null })
    }
  })
})
