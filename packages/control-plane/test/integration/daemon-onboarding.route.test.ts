/**
 * Daemon onboarding — API key + copy-paste start command.
 *
 * `POST /daemons/token` provisions a fresh daemon identity (a `provisioned` Daemon row +
 * an `ApiKey` row) and returns the one-time opaque key + the ready-to-run
 * `npx` command. The daemon adopts its id from `auth/ok`, so the command carries just
 * url + key (no `--daemon-id`).
 *
 * Also covers the `POST /agents?connect=true` tie-in. Driven through `app.inject`
 * (DB-backed, no socket). The minted key is verified by hashing its secret with the
 * same pepper and finding the persisted `api_key` row (hash-only, no plaintext stored).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function build(publicCpUrl?: string, daemonDistTag?: string): HttpApp {
  const overrides =
    publicCpUrl || daemonDistTag
      ? {
          ...(publicCpUrl ? { PUBLIC_CP_URL: publicCpUrl } : {}),
          ...(daemonDistTag ? { DAEMON_DIST_TAG: daemonDistTag } : {})
        }
      : undefined
  const app = buildHttpApp(prisma, overrides)
  running = app
  return app
}

const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('Daemon onboarding — POST /daemons/token', () => {
  it('provisions a daemon + mints an API key + a runnable start command', async () => {
    const app = build('https://cp.example.com')
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { daemonId: string; apiKey: string; displayTail: string; command: string }

    expect(body.daemonId).toMatch(UUID_RE)
    expect(body.apiKey).toMatch(/^[0-9A-Za-z]+$/)
    expect(body.displayTail.startsWith('…')).toBe(true)

    // The command is copy-pasteable and carries just url + key —
    // the daemon derives its id from `auth/ok`, so NO --daemon-id is needed.
    expect(body.command).toContain('--cp-url wss://cp.example.com/daemon/ws')
    expect(body.command).toContain(`--cp-key ${body.apiKey}`)
    expect(body.command).not.toContain('--daemon-id')
    expect(body.command).not.toContain('--cp-token')

    // Onboarding WROTE rows: a provisioned daemon (epoch 0) + a hash-only api_key.
    const daemon = await prisma.daemon.findUnique({ where: { id: body.daemonId } })
    expect(daemon?.status).toBe('provisioned')
    expect(daemon?.sessionEpoch).toBe(0n)

    const parsed = codec.parse(body.apiKey)
    expect(parsed).not.toBeNull()
    const keyRow = await prisma.apiKey.findUnique({ where: { hash: codec.hash(parsed!.secret) } })
    expect(keyRow?.daemonId).toBe(body.daemonId)
    expect(keyRow?.principalType).toBe('daemon')
    expect(keyRow?.expiresAt).toBeNull()
  })

  it('each call provisions a distinct daemon id + key', async () => {
    const app = build('https://cp.example.com')
    const a = (await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json() as {
      daemonId: string
      apiKey: string
    }
    const b = (await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json() as {
      daemonId: string
      apiKey: string
    }
    expect(a.daemonId).not.toBe(b.daemonId)
    expect(a.apiKey).not.toBe(b.apiKey)
  })

  it('pins the configured daemon dist-tag in the command (e.g. @rc on the test CP)', async () => {
    const app = build('https://cp.example.com', 'rc')
    const body = (await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json() as { command: string }
    expect(body.command).toContain('npx -y @agentconnect.md/daemon@rc run')
  })

  it('derives a ws:// command url from HOST:PORT when PUBLIC_CP_URL is unset', async () => {
    const app = build() // no PUBLIC_CP_URL
    const body = (await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json() as { command: string }
    // Falls back to a host:port ws URL (default 0.0.0.0:8080 unless configured).
    expect(body.command).toMatch(/--cp-url wss?:\/\/[^ ]+\/daemon\/ws/)
  })
})

describe('Agent create — connect block tie-in', () => {
  it('POST /agents?connect=true returns a connect { apiKey, command } for onboarding', async () => {
    const app = build('https://cp.example.com')
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents?connect=true`,
      payload: { name: 'router-bot', runtime: 'claude' }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as {
      id: string
      name: string
      connect?: { daemonId: string; apiKey: string; displayTail: string; command: string }
    }
    expect(body.name).toBe('router-bot')
    expect(body.connect).toBeDefined()
    expect(body.connect!.apiKey).toMatch(/^[0-9A-Za-z]+$/)
    expect(body.connect!.command).toContain('--cp-key ')
    expect(body.connect!.command).not.toContain('--daemon-id')
  })

  it('POST /agents without connect=true keeps the plain agent response (no connect block)', async () => {
    const app = build('https://cp.example.com')
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'plain', runtime: 'claude' }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; connect?: unknown }
    expect(body.connect).toBeUndefined()
  })
})
