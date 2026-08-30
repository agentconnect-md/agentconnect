/**
 * Unit tests for the AgentConnect MCP tool registry (agent-assistant.md §6.2).
 *
 * The contract under test: read tools issue ONLY GETs, write tools are flagged
 * `write: true` (the scope/rate gates key off it), destructive tools carry the
 * §6.4 required-`confirm` gate compared at the execution layer, every org
 * resource path stays inside the caller's org subtree, path parameters cannot
 * traverse into sibling routes, and the published JSON Schemas + behavior
 * annotations are well-formed tool contracts.
 */
import { describe, it, expect } from 'vitest'
import { KNOWN_PLATFORMS } from '@agentconnect.md/protocol'
import { MCP_TOOLS, findTool, toolDescriptor, type McpToolCtx, type RestResult } from './tools.js'

const ORG_ID = 'org-123'

interface RecordedCall {
  method: string
  path: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}

/** A recording ctx: every request succeeds. GETs answer with a resource whose
 *  name matches the confirm fixtures (list paths answer with an array of one). */
function recordingCtx(): { ctx: McpToolCtx; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const ctx: McpToolCtx = {
    orgId: ORG_ID,
    get: async (path, query): Promise<RestResult> => {
      calls.push({ method: 'GET', path, ...(query ? { query } : {}) })
      const resource = { id: 'integ-1', name: 'my-agent' }
      return {
        statusCode: 200,
        body: path.endsWith('/integrations') ? JSON.stringify([resource]) : JSON.stringify(resource)
      }
    },
    send: async (method, path, body): Promise<RestResult> => {
      calls.push({ method, path, ...(body ? { body } : {}) })
      return { statusCode: 200, body: '{}' }
    }
  }
  return { ctx, calls }
}

const CRON_ID = '7b1f9df2-9f63-4a2e-a2d4-3a1a55f5f001'
const AGENT_UUID = '5e0f8a25-31c8-4a1a-bb0e-9a8f6a2b1c22'

/** Minimal happy-path args per tool (tools with no args pass {}). */
const ARGS: Record<string, Record<string, unknown>> = {
  getAgent: { agentId: 'agent-1' },
  getCron: { cronId: 'cron-1' },
  listCronRuns: { cronId: 'cron-1' },
  getSession: { sessionId: 'sess-1' },
  listAgentHooks: { agentId: 'agent-1' },
  listHookRuns: { hookId: 'hook-1' },
  createAgent: { name: 'my-agent', runtime: 'claude' },
  updateAgent: { agentId: AGENT_UUID, model: 'opus' },
  deleteAgent: { agentId: AGENT_UUID, confirm: 'my-agent' },
  renameDaemon: { daemonId: 'daemon-1', name: 'edge-1' },
  upsertCron: { agentId: AGENT_UUID, schedule: '0 9 * * *', trigger: 'do the thing', timezone: 'Asia/Shanghai' },
  runCron: { cronId: 'cron-1' },
  deleteCron: { cronId: 'cron-1', confirm: 'my-agent' },
  setChannelTrigger: { integrationId: 'integ-1', channelId: 'C123', trigger: 'any' },
  removeIntegration: { integrationId: 'integ-1', confirm: 'my-agent' }
}

async function run(toolName: string, args?: Record<string, unknown>) {
  const { ctx, calls } = recordingCtx()
  const tool = findTool(toolName)!
  const parsed = tool.schema.safeParse(args ?? ARGS[toolName] ?? {})
  expect(parsed.success, `${toolName}: fixture args must validate`).toBe(true)
  const result = await tool.call(ctx, parsed.success ? parsed.data : {})
  return { calls, result }
}

describe('MCP tool registry — §6.2 invariants', () => {
  it('every tool only touches /me or the caller-org subtree', async () => {
    for (const tool of MCP_TOOLS) {
      const { calls } = await run(tool.name)
      expect(calls.length, `${tool.name}: must issue at least one request`).toBeGreaterThan(0)
      for (const c of calls) {
        expect(
          c.path === '/me' || c.path.startsWith(`/orgs/${ORG_ID}`),
          `${tool.name}: unexpected path ${c.path}`
        ).toBe(true)
      }
    }
  })

  it('read tools are GET-only; write tools are flagged and mutate', async () => {
    for (const tool of MCP_TOOLS) {
      const { calls } = await run(tool.name)
      const mutations = calls.filter((c) => c.method !== 'GET')
      if (tool.write) {
        expect(mutations.length, `${tool.name}: a write tool must issue a mutating request`).toBe(1)
      } else {
        expect(mutations, `${tool.name}: a read tool may never mutate`).toEqual([])
      }
    }
  })

  it('destructive tools require a confirm argument; write-only tools must not', () => {
    for (const tool of MCP_TOOLS.filter((t) => t.write)) {
      const argsWithoutConfirm = { ...ARGS[tool.name] }
      delete argsWithoutConfirm.confirm
      const ok = tool.schema.safeParse(argsWithoutConfirm).success
      if (tool.destructive) {
        expect(tool.write, `${tool.name}: destructive implies write`).toBe(true)
        expect(ok, `${tool.name}: destructive tools must require confirm`).toBe(false)
      } else {
        expect(ok, `${tool.name}: non-destructive tools must not require confirm`).toBe(true)
      }
    }
  })

  it('path parameters are encoded — a crafted id cannot traverse into a sibling route', async () => {
    const { ctx, calls } = recordingCtx()
    await findTool('getAgent')!.call(ctx, { agentId: '../me/keys?x=1#f' })
    // The whole id stays ONE opaque segment under /agents/.
    const agentSeg = calls[0]!.path.slice(`/orgs/${ORG_ID}/agents/`.length)
    expect(calls[0]!.path.startsWith(`/orgs/${ORG_ID}/agents/`)).toBe(true)
    for (const bad of ['/', '?', '#']) expect(agentSeg).not.toContain(bad)

    // Write paths run through the same seg(): a two-param route keeps its exact shape.
    const w = recordingCtx()
    await findTool('setChannelTrigger')!.call(w.ctx, {
      integrationId: 'i/../x',
      channelId: 'C?limit=1',
      trigger: 'any'
    })
    const rest = w.calls[0]!.path.slice(`/orgs/${ORG_ID}/integrations/`.length)
    expect(rest.split('/')).toEqual(['i%2F..%2Fx', 'channels', 'C%3Flimit%3D1'])
  })

  it('strict schemas reject unknown arguments', () => {
    expect(findTool('listAgents')!.schema.safeParse({ surprise: true }).success).toBe(false)
    expect(findTool('getAgent')!.schema.safeParse({ agentId: 'a', extra: 1 }).success).toBe(false)
    expect(findTool('getUsage')!.schema.safeParse({ range: 'd999' }).success).toBe(false)
    expect(findTool('createAgent')!.schema.safeParse({ name: 'a', runtime: 'claude', secrets: {} }).success).toBe(false)
    expect(findTool('updateAgent')!.schema.safeParse({ agentId: 'a', visibility: 'org' }).success).toBe(false)
  })

  it.each([
    ['updateAgent', { agentId: AGENT_UUID.replaceAll('-', ''), model: 'bypass' }],
    ['updateAgent', { agentId: `{${AGENT_UUID}}`, model: 'bypass' }],
    ['deleteAgent', { agentId: AGENT_UUID.replaceAll('-', ''), confirm: 'my-agent' }],
    ['deleteAgent', { agentId: `{${AGENT_UUID}}`, confirm: 'my-agent' }]
  ] as const)('%s rejects PostgreSQL-compatible noncanonical UUID text before dispatch', (toolName, args) => {
    expect(findTool(toolName)!.schema.safeParse(args).success).toBe(false)
  })

  it.each([
    ['updateAgent', { agentId: AGENT_UUID.replaceAll('-', ''), model: 'bypass' }],
    ['updateAgent', { agentId: `{${AGENT_UUID}}`, model: 'bypass' }],
    ['deleteAgent', { agentId: AGENT_UUID.replaceAll('-', ''), confirm: 'my-agent' }],
    ['deleteAgent', { agentId: `{${AGENT_UUID}}`, confirm: 'my-agent' }]
  ] as const)('%s refuses a direct noncanonical UUID call without issuing REST requests', async (toolName, args) => {
    const { ctx, calls } = recordingCtx()
    const result = await findTool(toolName)!.call(ctx, args)
    expect(result.statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('tool names are unique and descriptors publish well-formed JSON Schema + annotations', () => {
    const names = MCP_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of MCP_TOOLS) {
      const d = toolDescriptor(tool)
      expect(d.name).toBe(tool.name)
      expect(d.description.length).toBeGreaterThan(10)
      const schema = d.inputSchema as { type?: string; $schema?: string; properties?: object }
      expect(schema.type).toBe('object')
      expect(schema.$schema).toBeUndefined()
      if (tool.write) {
        expect(d.annotations).toEqual({ readOnlyHint: false, destructiveHint: tool.destructive === true })
      } else {
        expect(d.annotations).toEqual({ readOnlyHint: true })
      }
    }
  })

  it('getSession/getUsage pass filters through as query parameters', async () => {
    const { ctx, calls } = recordingCtx()
    await findTool('listSessions')!.call(ctx, { agentId: 'a1', platform: 'slack', limit: 5 })
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `/orgs/${ORG_ID}/sessions`,
      query: { agentId: 'a1', platform: 'slack', channel: undefined, limit: 5 }
    })
    // The tool still speaks day presets; the ROUTE takes an explicit window, so the
    // tool resolves one — d7 by default, and `source` passes straight through.
    const usage = recordingCtx()
    await findTool('getUsage')!.call(usage.ctx, {})
    const call = usage.calls[0] as { method: string; path: string; query: Record<string, string> }
    expect(call.method).toBe('GET')
    expect(call.path).toBe(`/orgs/${ORG_ID}/usage`)
    expect(call.query.source).toBeUndefined()
    const span = Date.parse(call.query.to!) - Date.parse(call.query.from!)
    expect(span).toBe(7 * 24 * 60 * 60 * 1000)

    const scoped = recordingCtx()
    await findTool('getUsage')!.call(scoped.ctx, { range: 'd30', source: 'gateway' })
    const scopedCall = scoped.calls[0] as { query: Record<string, string> }
    expect(scopedCall.query.source).toBe('gateway')
    expect(Date.parse(scopedCall.query.to!) - Date.parse(scopedCall.query.from!)).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('listSessions filters by every canonical platform — the /sessions route accepts the same set', () => {
    const schema = findTool('listSessions')!.schema
    // S1a: the wire Platform schema is an open string; the MCP filter surface
    // deliberately stays the closed KNOWN_PLATFORMS vocabulary until S1b.
    for (const platform of KNOWN_PLATFORMS) {
      expect(schema.safeParse({ platform }).success, `platform=${platform} must be filterable`).toBe(true)
    }
    expect(schema.safeParse({ platform: 'irc' }).success).toBe(false)
  })

  it('whoami merges /me and the org view, and surfaces the first failure', async () => {
    const okCtx: McpToolCtx = {
      orgId: ORG_ID,
      get: async (path) =>
        path === '/me'
          ? { statusCode: 200, body: JSON.stringify({ userId: 'u1' }) }
          : { statusCode: 200, body: JSON.stringify({ id: ORG_ID, role: 'owner' }) },
      send: async () => ({ statusCode: 500, body: 'never' })
    }
    const ok = await findTool('whoami')!.call(okCtx, {})
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ user: { userId: 'u1' }, organization: { id: ORG_ID, role: 'owner' } })

    const failCtx: McpToolCtx = {
      ...okCtx,
      get: async (path) =>
        path === '/me'
          ? { statusCode: 200, body: '{}' }
          : { statusCode: 404, body: JSON.stringify({ message: 'organization not found' }) }
    }
    const fail = await findTool('whoami')!.call(failCtx, {})
    expect(fail.statusCode).toBe(404)
  })
})

describe('MCP write tools — bodies and upsert semantics', () => {
  it('updateAgent sends ONLY the provided fields (PATCH absent-vs-present)', async () => {
    const { calls } = await run('updateAgent', { agentId: AGENT_UUID, model: null, pause: true })
    expect(calls).toEqual([
      { method: 'PATCH', path: `/orgs/${ORG_ID}/agents/${AGENT_UUID}`, body: { model: null, pause: true } }
    ])
  })

  it('createAgent posts the curated body to the org agents collection', async () => {
    const { calls } = await run('createAgent', { name: 'helper', runtime: 'claude', fastMode: true })
    expect(calls).toEqual([
      { method: 'POST', path: `/orgs/${ORG_ID}/agents`, body: { name: 'helper', runtime: 'claude', fastMode: true } }
    ])
  })

  it('upsertCron PUTs to the given cron id, and mints a UUID when creating', async () => {
    const edit = await run('upsertCron', { ...ARGS.upsertCron, cronId: CRON_ID })
    expect(edit.calls[0]!.method).toBe('PUT')
    expect(edit.calls[0]!.path).toBe(`/orgs/${ORG_ID}/crons/${CRON_ID}`)
    expect(edit.calls[0]!.body).not.toHaveProperty('cronId') // routing key stays out of the body

    const create = await run('upsertCron')
    const minted = create.calls[0]!.path.slice(`/orgs/${ORG_ID}/crons/`.length)
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  // A caller that omitted the zone used to inherit the CP process's own, so "every morning at 9"
  // silently meant 9am somewhere else. There is no zone to guess from here, so the tool asks.
  it('upsertCron refuses a schedule with no timezone rather than choosing one', async () => {
    const { timezone: _omitted, ...withoutZone } = ARGS.upsertCron!
    const tool = findTool('upsertCron')!
    expect(tool.schema.safeParse(withoutZone).success).toBe(false)
    expect(tool.schema.safeParse(ARGS.upsertCron).success).toBe(true)
  })
})

describe('MCP destructive tools — the §6.4 confirm gate', () => {
  it('a confirm mismatch blocks the mutation (412, nothing sent)', async () => {
    for (const [tool, args] of [
      ['deleteAgent', { agentId: AGENT_UUID, confirm: 'wrong' }],
      ['deleteCron', { cronId: 'c1', confirm: 'wrong' }],
      ['removeIntegration', { integrationId: 'integ-1', confirm: 'wrong' }]
    ] as const) {
      const { calls, result } = await run(tool, args)
      expect(result.statusCode, tool).toBe(412)
      expect(JSON.parse(result.body).message).toContain('confirmation mismatch')
      expect(JSON.parse(result.body).message).not.toContain('my-agent') // never echo the expected name
      expect(
        calls.filter((c) => c.method !== 'GET'),
        `${tool}: must not mutate`
      ).toEqual([])
    }
  })

  it('a matching confirm releases exactly one DELETE', async () => {
    for (const tool of ['deleteAgent', 'deleteCron', 'removeIntegration']) {
      const { calls, result } = await run(tool)
      expect(result.statusCode, tool).toBe(200)
      const mutations = calls.filter((c) => c.method !== 'GET')
      expect(mutations, tool).toHaveLength(1)
      expect(mutations[0]!.method).toBe('DELETE')
    }
  })

  it('deleteCron falls back to the id as the confirm value for unnamed crons', async () => {
    const calls: RecordedCall[] = []
    const ctx: McpToolCtx = {
      orgId: ORG_ID,
      get: async (path) => {
        calls.push({ method: 'GET', path })
        return { statusCode: 200, body: JSON.stringify({ id: 'c1', name: null }) }
      },
      send: async (method, path) => {
        calls.push({ method, path })
        return { statusCode: 204, body: '' }
      }
    }
    const blocked = await findTool('deleteCron')!.call(ctx, { cronId: 'c1', confirm: 'anything' })
    expect(blocked.statusCode).toBe(412)
    const ok = await findTool('deleteCron')!.call(ctx, { cronId: 'c1', confirm: 'c1' })
    expect(ok.statusCode).toBe(204)
  })

  it('the confirm lookup surfaces resource errors as-is (404 passes through, nothing sent)', async () => {
    const ctx: McpToolCtx = {
      orgId: ORG_ID,
      get: async () => ({ statusCode: 404, body: JSON.stringify({ message: 'agent not found' }) }),
      send: async () => {
        throw new Error('must not be called')
      }
    }
    const out = await findTool('deleteAgent')!.call(ctx, { agentId: AGENT_UUID, confirm: 'x' })
    expect(out.statusCode).toBe(404)
  })

  it('removeIntegration 404s on an id absent from the integration list', async () => {
    const { result } = await run('removeIntegration', { integrationId: 'other', confirm: 'my-agent' })
    expect(result.statusCode).toBe(404)
  })
})
