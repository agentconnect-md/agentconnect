// A new agent and a runtime switch take the runtime's auto mode, else its full-access one, else its own default (product-conventions.md).
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function setup() {
  const app = buildHttpApp(prisma)
  running = app
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId, {
    capabilities: {
      platforms: [],
      runtimes: ['claude-acp', 'codex-acp', 'dsh-acp', 'opencode'],
      acp: true,
      features: []
    }
  })
  const create = (payload: Record<string, unknown>) =>
    app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { daemonId, ...payload } })
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${id}`, payload })
  return { create, patch }
}

describe('permission mode defaults', () => {
  it('a create without a mode takes the auto mode, else full access, else the runtime default', async () => {
    const { create } = await setup()
    const mode = async (name: string, runtime: string) => {
      const res = await create({ name, runtime })
      expect(res.statusCode).toBe(201)
      return (res.json() as { permissionMode: string | null }).permissionMode
    }
    expect(await mode('claude-agent', 'claude-acp')).toBe('auto')
    expect(await mode('codex-agent', 'codex-acp')).toBe('agent')
    expect(await mode('dsh-agent', 'dsh-acp')).toBe('danger-full-access')
    expect(await mode('opencode-agent', 'opencode')).toBeNull()
    // A mode the caller chose is kept.
    const chosen = await create({ name: 'manual-agent', runtime: 'claude-acp', permissionMode: 'default' })
    expect(chosen.json()).toMatchObject({ permissionMode: 'default' })
  })

  it('a runtime switch without a mode takes the new runtime’s; one with a mode keeps it', async () => {
    const { create, patch } = await setup()
    const made = await create({ name: 'switcher', runtime: 'claude-acp', permissionMode: 'default' })
    const id = (made.json() as { id: string }).id

    expect((await patch(id, { runtime: 'codex-acp' })).json()).toMatchObject({ permissionMode: 'agent' })
    expect((await patch(id, { runtime: 'dsh-acp' })).json()).toMatchObject({ permissionMode: 'danger-full-access' })
    // No auto or full-access mode ⇒ the previous runtime's mode is cleared to the runtime's own default.
    expect((await patch(id, { runtime: 'opencode' })).json()).toMatchObject({ permissionMode: null })
    expect((await patch(id, { runtime: 'claude-acp', permissionMode: 'plan' })).json()).toMatchObject({
      permissionMode: 'plan'
    })
    // An edit that keeps the runtime keeps the mode.
    expect((await patch(id, { runtime: 'claude-acp' })).json()).toMatchObject({ permissionMode: 'plan' })
  })
})
