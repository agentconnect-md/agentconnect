// Organization research in a running daemon (assistant-mode.md §5.15): the onboarding hello, the research task, its tools, memory binding, guard and host.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FOLLOW_UP_WATCH_FEATURE, KNOWLEDGE_RECORD_FEATURE } from '@agentconnect.md/protocol'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { researchCoordinate } from '../src/session/subsession-coordinate.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const INTEGRATION = 'int-bot-a'

function scaffold(enabledAt = new Date().toISOString(), runtime = 'claude'): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-research-d-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { [runtime]: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: [{ channel: 'C1', mode: 'append' }]
          },
          config: { botToken: 'xoxb-bot-a', appToken: 'xapp-bot-a' }
        }
      ],
      output: { mode: 'low' },
      assistantMode: { enabled: true },
      assistantOnboarding: {
        enabledByUserId: 'usr_1',
        enabledAt,
        hints: { organization: 'Example Org', emailDomains: ['example.test'] }
      }
    })
  )
  return root
}

/** A daemon whose turns are recorded rather than run, and whose Control Plane names the given DM target. */
async function boot(root: string, target: Record<string, unknown> | undefined) {
  const hostFactory = () =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }) as never
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory })
  await daemon.start()
  const d = daemon as any
  d.cpCollab.replace({
    generation: 0,
    channels: [],
    agents: [{ agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a', orgId: TEST_ORG }]
  })
  const calls: { msg: any; integrationId?: string; callMeta?: any }[] = []
  d.dispatch = vi.fn(async (_agentId: string, msg: any, integrationId?: string, _w?: any, callMeta?: any, o?: any) => {
    calls.push({ msg, integrationId, callMeta })
    await o?.onAdmission?.({ accepted: true })
    return 'acp-1'
  })
  const route = vi.fn(async (req: { requestId: string }) => ({
    requestId: req.requestId,
    ...(target ? { target } : {})
  }))
  // The Control Plane answers every feature but the organization record, and the approval route.
  const answers: Record<string | symbol, unknown> = {
    supportsServerFeature: (feature: string) => feature !== KNOWLEDGE_RECORD_FEATURE,
    approvalRoute: route
  }
  d.cpClient = new Proxy(answers, { get: (target, name) => (name in target ? target[name] : () => undefined) })
  // Slack's socket connects in the background; the DM can be opened only once it has.
  await vi.waitFor(() => expect(d.draftCardPort(INTEGRATION)).toBeDefined(), WAIT)
  return { daemon, d, calls, route }
}

const ALICE = { integrationId: INTEGRATION, teamId: 'T1', userId: 'U1', consoleUserId: 'usr_1', displayName: 'Alice' }

describe('the onboarding conversation', () => {
  it('greets the person who switched the mode on in their DM, then opens research as that DM’s task', async () => {
    const { daemon, d, calls, route } = await boot(scaffold(), ALICE)
    try {
      await d.research.sweep()
      expect(route).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'bot-a', consoleUserId: 'usr_1', integrationIds: [INTEGRATION] }),
        TEST_ORG
      )
      const row = await d.store.assistantOnboarding.get('bot-a')
      expect(row).toMatchObject({ state: 'researching', channel: 'D_FAKE', person: 'Alice', enabler: true })
      expect(calls).toHaveLength(2)
      const [hello, research] = calls
      // Hello first, opening the DM's long session as its first message would.
      expect(hello!.msg.channel).toBe('D_FAKE')
      expect(hello!.msg.text).toContain('Assistant mode was switched on for you by Alice')
      expect(hello!.msg.text).toContain(row.taskKey)
      expect(hello!.callMeta).toMatchObject({ opensPlace: true })
      // Then research, on its own coordinate, owned by that session.
      expect(research!.msg.thread).toMatch(/^subsession:research-\d+$/)
      expect(research!.msg).toMatchObject({
        channel: 'D_FAKE',
        headless: true,
        initialSessionTitle: 'Organization research'
      })
      const prompt: string = research!.msg.turnBody.prompt
      expect(prompt).toContain('current research instructions')
      expect(prompt).not.toContain('replyToSession')
      expect(research!.callMeta).toMatchObject({ originSessionId: row.parentSessionId, subsessionRound: 1 })
      expect(await d.store.assistantSubsessions.get('bot-a', row.taskKey)).toMatchObject({
        state: 'open',
        parentSessionKey: row.parentKey
      })
      // Every later sweep, and a repeated spec, run nothing again.
      await d.research.sweep()
      expect(calls).toHaveLength(2)
    } finally {
      await daemon.stop()
    }
  })

  it('takes no research when nobody has a DM, and none past its first day', async () => {
    const nobody = await boot(scaffold(), undefined)
    try {
      await nobody.d.research.sweep()
      expect(await nobody.d.store.assistantOnboarding.get('bot-a')).toMatchObject({ state: 'skipped' })
      expect(nobody.calls).toHaveLength(0)
    } finally {
      await nobody.daemon.stop()
    }
    const late = await boot(scaffold(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()), ALICE)
    try {
      await late.d.research.sweep()
      expect(await late.d.store.assistantOnboarding.get('bot-a')).toBeUndefined()
      expect(late.route).not.toHaveBeenCalled()
    } finally {
      await late.daemon.stop()
    }
  })
})

describe('the research task’s session', () => {
  it('samples tool and research changes without registering tokens, ignoring reconnect generations', async () => {
    const { daemon, d } = await boot(scaffold(), ALICE)
    try {
      const agent = d.agents.get('bot-a')
      let supportsWatch = false
      let registration = 1
      d.cpClient.supportsServerFeature = (feature: string) =>
        feature === FOLLOW_UP_WATCH_FEATURE ? supportsWatch : feature !== KNOWLEDGE_RECORD_FEATURE
      d.cpClient.registration = () => registration
      const at = {
        agent,
        platform: 'slack',
        channel: 'D_FAKE',
        thread: 'append:1',
        deliveryThread: '1',
        integrationId: INTEGRATION,
        isDm: true,
        sessionKey: 'slack:D_FAKE:append:1:bot-a'
      }
      const snapshot = (thread = at.thread) => d.sessions.deps.toolContextFor({ ...at, thread })
      const quiescent = () => d.sessions.deps.sessionSdkQuiescent(agent.id, at.sessionKey, 'runtime-1')
      const owner = d.sessionOwnerKey(agent.id, at.sessionKey)
      expect(quiescent()).toBe(true)
      await d.onSdkLifecycle(owner, 'runtime-1', {
        type: 'system',
        subtype: 'task_started',
        task_id: 'build',
        subagent_type: 'worker'
      })
      expect(quiescent()).toBe(false)
      await d.onSdkLifecycle(owner, 'runtime-1', {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'build',
        patch: { status: 'completed' }
      })
      expect(quiescent()).toBe(true)
      const size = d.mcp.sessions.size
      const initial = snapshot()
      expect(snapshot().fingerprint).toBe(initial.fingerprint)
      expect(d.mcp.sessions.size).toBe(size)
      const registeredTools = (context: ReturnType<typeof snapshot>) => {
        const [server] = context.mcpServers()
        const token = server.env.find((entry: { name: string }) => entry.name === 'AC_MCP_TOKEN').value
        return d.mcp.sessions.get(token).tools as {
          name: string
          inputSchema: { properties: Record<string, unknown> }
        }[]
      }
      expect(
        registeredTools(initial).find((tool) => tool.name === 'followUp')?.inputSchema.properties
      ).not.toHaveProperty('watch')
      supportsWatch = true
      const current = snapshot()
      expect(current.fingerprint).not.toBe(initial.fingerprint)
      expect(d.mcp.sessions.size).toBe(size + 1)
      expect(registeredTools(current).find((tool) => tool.name === 'followUp')?.inputSchema.properties).toHaveProperty(
        'watch'
      )
      registration++
      expect(snapshot().fingerprint).toBe(current.fingerprint)
      expect(d.mcp.sessions.size).toBe(size + 2)
      supportsWatch = false
      expect(snapshot().fingerprint).toBe(initial.fingerprint)
      const research = snapshot(researchCoordinate('5'))
      agent.assistantOnboarding.hints.organization = 'Example Research Group'
      const updated = snapshot(researchCoordinate('5'))
      expect(updated.fingerprint).not.toBe(research.fingerprint)
      expect(updated.instructions).toContain('Example Research Group')
      expect(d.mcp.sessions.size).toBe(size + 2)
    } finally {
      await daemon.stop()
    }
  })

  it('is offered memory, knowledge, the channel listing and nothing that posts, bound to the shared layer, on a host of its own', async () => {
    const { daemon, d } = await boot(scaffold(), ALICE)
    try {
      const agent = d.agents.get('bot-a')
      const scope = d.transportScopeForIntegrationIds([INTEGRATION])
      const thread = researchCoordinate('5')
      const key = sessionKey('slack', 'D_FAKE', thread, 'bot-a', scope)
      const context = d.sessions.deps.toolContextFor({
        agent,
        platform: 'slack',
        channel: 'D_FAKE',
        thread,
        deliveryThread: thread,
        integrationId: INTEGRATION,
        transportScope: scope,
        isDm: false,
        sessionKey: key
      })
      expect(context.instructions).toContain('You are researching Example Org')
      expect(context.instructions).toContain('example.test')
      expect(context.instructions).toContain('findKnowledge')
      const servers = context.mcpServers() as { env: { name: string; value: string }[] }[]
      // The bridge alone: no user-configured server reaches research.
      expect(servers).toHaveLength(1)
      const token = servers[0]!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
      const ctx = d.mcp.sessions.get(token) as SessionContext
      const names = ctx.tools.map((tool) => tool.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'listChannels',
          'getChannelHistory',
          'findKnowledge',
          'listMemoryEntries',
          'createMemoryEntry'
        ])
      )
      for (const posting of ['sendMessage', 'followUp', 'getToKnow', 'listTasks', 'addReaction'])
        expect(names).not.toContain(posting)
      expect(ctx.memoryBinding).toEqual({
        source: 'tool',
        scope: { agentId: 'bot-a', withOutsiders: false, recordWriter: 'research' },
        layer: 'shared'
      })
      // As if its turn were live: the stop gate is the turn engine's, not this test's.
      const deps = { ...(d.mcp.deps as OpsDeps), canRun: () => true }
      // The bridge refuses any other name the runtime sends.
      await expect(
        executeTool(ctx, 'sendMessage', { action: 'delegateTask', message: 'post this' }, deps)
      ).rejects.toThrow('not available to organization research')
      // A write lands in the shared layer, and says so; a `layer` argument is refused.
      const written = (await executeTool(
        ctx,
        'createMemoryEntry',
        { label: 'research-notes.md', text: '# Notes\n' },
        deps
      )) as Record<string, unknown>
      expect(written).toMatchObject({ layer: 'shared' })
      // The organization files are the record's alone: a Control Plane that does not keep it refuses them.
      await expect(
        executeTool(ctx, 'createMemoryEntry', { label: 'organization.md', text: '# Organization\n' }, deps)
      ).rejects.toThrow('the organization record is not available right now')
      await expect(
        executeTool(ctx, 'createMemoryEntry', { label: 'x.md', text: 'x', layer: 'here' }, deps)
      ).rejects.toThrow('argument layer is not available')
      // Its standing memory is the shared layer's, whichever DM owns it.
      expect(
        await d.sessions.deps.memoryScopeFor(
          'bot-a',
          { platform: 'slack', channel: 'D_FAKE', thread, isDm: false, source: 'agent', sender: { id: 'bot-a' } },
          INTEGRATION,
          undefined
        )
      ).toEqual({ agentId: 'bot-a', withOutsiders: false })
      // It never shares the agent's host, which holds the tool credentials.
      expect(d.hostKeyFor('bot-a', key)).toBe(sessionHostKey('bot-a', key))
      expect(d.hostKeyFor('bot-a', sessionKey('slack', 'D_FAKE', 'append:1', 'bot-a', scope))).toBe(
        agentHostKey('bot-a')
      )
    } finally {
      await daemon.stop()
    }
  })

  it('is offered the code-host reads once a repository is in reach, and reads only the repositories it lists', async () => {
    const { daemon, d } = await boot(scaffold(), ALICE)
    try {
      const agent = d.agents.get('bot-a')
      const scope = d.transportScopeForIntegrationIds([INTEGRATION])
      const thread = researchCoordinate('9')
      const register = () => {
        const [server] = d.sessions.deps
          .toolContextFor({
            agent,
            platform: 'slack',
            channel: 'D_FAKE',
            thread,
            deliveryThread: thread,
            integrationId: INTEGRATION,
            transportScope: scope,
            isDm: false,
            sessionKey: sessionKey('slack', 'D_FAKE', thread, 'bot-a', scope)
          })
          .mcpServers() as { env: { name: string; value: string }[] }[]
        return d.mcp.sessions.get(server!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value) as SessionContext
      }
      expect(register().tools.map((tool) => tool.name)).not.toContain('listCodeHostRepositories')
      agent.workspace = {
        ...agent.workspace,
        additionalRepos: [
          { repoFullName: 'example-org/example-repo', repoId: '42', provider: 'github', materialize: 'always' }
        ]
      }
      const ctx = register()
      expect(ctx.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['listCodeHostRepositories', 'readCodeHostRepository'])
      )
      const deps = { ...(d.mcp.deps as OpsDeps), canRun: () => true }
      expect(await executeTool(ctx, 'listCodeHostRepositories', {}, deps)).toEqual({
        repositories: [
          { provider: 'github', repository: 'example-org/example-repo', source: 'authorized', readable: true }
        ]
      })
      await expect(
        executeTool(ctx, 'readCodeHostRepository', { repository: 'example-org/other-repo', part: 'overview' }, deps)
      ).rejects.toThrow('is not one listCodeHostRepositories lists')
    } finally {
      await daemon.stop()
    }
  })

  it('launches without the agent’s tool credentials, and on OpenCode keeps its tools under the agent’s mode', async () => {
    const root = scaffold(undefined, 'opencode')
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
    await daemon.start()
    const d = daemon as any
    try {
      const agent = d.agents.get('bot-a')
      agent.runtimeOverrides = { secrets: [{ name: 'API_KEY', value: 'example-secret' }] }
      const scope = d.transportScopeForIntegrationIds([INTEGRATION])
      const key = sessionHostKey('bot-a', sessionKey('slack', 'D_FAKE', researchCoordinate('6'), 'bot-a', scope))
      const research = d.ensureHost(key, d.cfg, join(root, 'research-cwd')).opts
      expect(research.env.API_KEY).toBeUndefined()
      // Every launch path builds through buildAcpHost, the model-session host's too: the research key alone decides it.
      const modelSession = d.buildAcpHost(agent, d.cfg, { hostKey: key, strategy: 'host', cwd: join(root, 'ms-cwd') })
        .host.opts
      expect(modelSession.env.API_KEY).toBeUndefined()
      expect(modelSession.env.OPENCODE_CONFIG_CONTENT ?? '').not.toContain('"read-only"')
      // A dream's credential-less host carries the read-only agent that denies every tool; research's does not.
      const dream = d.buildAcpHost(agent, d.cfg, {
        hostKey: sessionHostKey('bot-a', 'dream'),
        strategy: 'host',
        cwd: join(root, 'dream-cwd'),
        excludeAgentToolCredentials: true
      }).host.opts
      expect(dream.env.OPENCODE_CONFIG_CONTENT ?? '').toContain('"read-only"')
      expect(research.env.OPENCODE_CONFIG_CONTENT ?? '').not.toContain('"read-only"')
      // The normal host keeps the agent's secret, which is why research never shares it.
      const normal = d.buildAcpHost(agent, d.cfg, { hostKey: agentHostKey('bot-a'), strategy: 'host', cwd: root }).host
        .opts
      expect(normal.env.API_KEY).toBe('example-secret')
    } finally {
      await daemon.stop()
    }
  })
})
