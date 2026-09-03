import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from '../src/daemon.js'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from '../src/cp/gitcred-server.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// The outward `sessionId` a frame carries for the slot behind an ACP hop id (session-concept.md §1.1).
const outwardId = async (daemon: any, acpSessionId: string): Promise<string> => {
  const slot = await daemon.store.getSessionByAcpId(acpSessionId)
  return slot!.sessionId ?? (await daemon.store.ensureOutwardSessionId(slot!.key, slot!.agentId ?? undefined))
}

function scaffold(displayName?: string, memoryProvider?: 'none' | 'managed', iconUrl?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // This suite pins pre-staging flush semantics (verbatim terminal-error
      // delivery); staged delivery is covered by turn-output-workflow.
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      ...(displayName !== undefined ? { displayName } : {}),
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      status: 'active',
      runtime: 'claude',
      ...(memoryProvider ? { memory: { provider: memoryProvider } } : {}),
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('Daemon (no Slack, injected ACP host)', () => {
  it('sandboxes a host only when the agent opts in — skills are not force-sandboxed (#36)', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: 'bwrap',
      probeRuntimes: async () => []
    })
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      // Sandbox-optional principle: a default agent is NOT force-sandboxed by the
      // skill-authority requirement, even with a mechanism available.
      expect((daemon as any).agentRunsInSandbox(agent)).toBe(false)
      const defaultHost = (daemon as any).ensureHost('bot-a', (daemon as any).cfg)
      expect((defaultHost as any).opts.sandbox).toBeUndefined()
      // Opting the agent into the sandbox confines it via the available mechanism.
      ;(daemon as any).hosts.delete('bot-a')
      agent.runInSandbox = true
      expect((daemon as any).agentRunsInSandbox(agent)).toBe(true)
      const sandboxed = (daemon as any).ensureHost('bot-a', (daemon as any).cfg)
      expect((sandboxed as any).opts.sandbox).toMatchObject({ mechanism: 'bwrap' })
    } finally {
      await daemon.stop().catch(() => undefined)
      const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
      expect(realpathSync(root).startsWith(repoRoot + sep)).toBe(false)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses daemon startup when sandbox policy is required but the host has no mechanism', async () => {
    const root = scaffold()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, security: { requireSandbox: true } })
    )

    await expect(
      new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, sandboxMechanism: null }).start()
    ).rejects.toThrow(/daemon startup refused.*requireSandbox.*no supported Linux SRT\/bwrap/)
  })

  it('refuses daemon startup when security.sandboxReadRoots names a directory that does not exist', async () => {
    const root = scaffold()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        security: { sandboxReadRoots: [join(root, 'no-such-toolchain')] }
      })
    )

    await expect(
      new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, sandboxMechanism: null }).start()
    ).rejects.toThrow(/security\.sandboxReadRoots entry does not exist/)
  })

  it('does not force the skill sandbox or fail closed when the host has no sandbox mechanism (#36)', async () => {
    const root = scaffold()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, sandboxMechanism: null })
    try {
      // Sandbox-optional principle: skills are NOT force-sandboxed fleet-wide, so
      // boot/reconcile must not throw on a host with no OS sandbox (the exact
      // reconcile/CP-handshake path that used to break).
      await daemon.start()
      // The agent follows its OWN sandbox decision — unset ⇒ unsandboxed — rather
      // than a forced skill-authority requirement. (start() completing already
      // proves boot/reconcile did not fail closed on this no-sandbox host.)
      expect((daemon as any).agentRunsInSandbox((daemon as any).agents.get('bot-a'))).toBe(false)
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('enables production Dream operations (security hold lifted) without a host factory (#36 Phase C)', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: null,
      probeRuntimes: async () => []
    })
    try {
      await daemon.start()
      // The production security hold is lifted: a real (no host-factory) daemon
      // now allows Dream operations and re-advertises the organization-suggestion
      // review capability. Per-agent dreaming stays gated by each agent's policy.
      expect((daemon as any).dreamOperationsAllowed()).toBe(true)
      expect((daemon as any).registrationFeatures()).toContain('organization-suggestion-review-v1')
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets a dream session run its org-context tools off the chat-turn queue (#36 canRun carve-out)', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: null,
      probeRuntimes: async () => []
    })
    try {
      await daemon.start()
      // A dream never populates activeGateEntries (it runs off the chat-turn
      // queue), so without the carve-out its read-only tools would be gated shut.
      expect(
        (daemon as any).toolTurnRunnable({ agentId: 'bot-a', platform: 'dream', channel: 'memory', thread: 'drm-1' })
      ).toBe(true)
      // An ordinary session with no admitted turn still fails closed — a
      // session-static MCP token must not outlive its turn.
      expect(
        (daemon as any).toolTurnRunnable({ agentId: 'bot-a', platform: 'slack', channel: 'C1', thread: 'T1' })
      ).toBe(false)
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hands a scratch workspace with App credentials the same gitcred capability a clone gets', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: 'bwrap',
      probeRuntimes: async () => []
    })
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      const cwd = agent.workspace.path
      // Authorized repositories are the only repositories a scratch workspace can reach, and its
      // in-session git and gh authenticate for them through the same helper a clone uses.
      agent.workspace = {
        mode: 'from-scratch',
        path: cwd,
        gitBranch: 'main',
        gitCredential: 'github-app',
        pullOnNewSession: true,
        skills: []
      }
      const scratch = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
        hostKey: agentHostKey(agent.id),
        runInSandbox: true,
        cwd
      }).host
      expect((scratch as any).opts.env[GITCRED_CAPABILITY_ENV]).toEqual(expect.any(String))
      expect((scratch as any).opts.env[GITCRED_AGENT_ENV]).toBe('bot-a')
      // Without App credentials a scratch workspace still carries no git identity of any kind.
      agent.workspace = { mode: 'from-scratch', path: cwd, gitBranch: 'main', pullOnNewSession: true, skills: [] }
      const plain = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
        hostKey: agentHostKey(agent.id),
        runInSandbox: true,
        cwd
      }).host
      expect((plain as any).opts.env[GITCRED_CAPABILITY_ENV]).toBeUndefined()
      expect((plain as any).opts.env.GIT_CONFIG_KEY_0).toBeUndefined()
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps agent tool credentials out of the dream host without re-enabling repository hooks', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      sandboxMechanism: 'bwrap',
      probeRuntimes: async () => []
    })
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      agent.runtimeOverrides = { secrets: [{ name: 'API_KEY', value: 'super-secret' }] }
      const cwd = agent.workspace.path
      agent.workspace = {
        mode: 'git-repo',
        path: cwd,
        gitRepo: 'https://github.com/acme/repo',
        gitBranch: 'main',
        gitCredential: 'github-app',
        pullOnNewSession: true,
        skills: []
      }
      // A normal (non-dream) host still carries the agent's configured secret…
      const normal = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
        hostKey: agentHostKey(agent.id),
        runInSandbox: true,
        cwd
      }).host
      expect((normal as any).opts.env.API_KEY).toBe('super-secret')
      // …but a dream host must not — even sandboxed, the mined transcript's own
      // tools could otherwise read the secret straight from the environment.
      const dreamHost = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
        hostKey: agentHostKey(agent.id),
        runInSandbox: true,
        cwd,
        excludeAgentToolCredentials: true
      }).host
      const dreamEnv = (dreamHost as any).opts.env
      expect(dreamEnv.API_KEY).toBeUndefined()
      expect(dreamEnv[GITCRED_AGENT_ENV]).toBeUndefined()
      expect(dreamEnv[GITCRED_CAPABILITY_ENV]).toBeUndefined()
      // The policy rides the per-agent gitconfig, which the whole process tree inherits; the
      // indexed channel is gone, because a child that keeps COUNT without the pairs breaks git.
      expect(dreamEnv.GIT_CONFIG_COUNT).toBeUndefined()
      expect(Object.keys(dreamEnv).filter((key) => key.startsWith('GIT_CONFIG_KEY_'))).toEqual([])
      const dreamConfig = readFileSync(dreamEnv.GIT_CONFIG_GLOBAL, 'utf8')
      expect(dreamConfig).toContain(`hooksPath = ${process.platform === 'win32' ? 'NUL' : '/dev/null'}`)
      expect(dreamConfig).toContain('fsmonitor = false')
      // A dream gets NO tool credentials, so its file must carry no helper pointer either.
      expect(dreamConfig).not.toContain('[credential')
      // …and the confined launch must still be able to READ it. A hidden global config is read by
      // git as no config at all, so an uncarved path loses the hook pins silently rather than loudly.
      const runtimeDef = (daemon as any).runtimes[agent.runtime]
      const roots = (daemon as any).sandboxRuntimeReadRoots(agent, runtimeDef, dreamEnv, false, false)
      expect(roots).toContain(realpathSync(dreamEnv.GIT_CONFIG_GLOBAL))
      // A dream COEXISTS with the warm host, so it must not write over the file that host is still
      // pointing at: doing so would strip the live runtime's credential helper until it rebuilds.
      const normalEnv = (normal as any).opts.env
      expect(dreamEnv.GIT_CONFIG_GLOBAL).not.toBe(normalEnv.GIT_CONFIG_GLOBAL)
      expect(readFileSync(normalEnv.GIT_CONFIG_GLOBAL, 'utf8')).toContain('[credential')
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('single-agent mode still rejects an active sibling whose writable workspace overlaps', async () => {
    const root = scaffold()
    const sibling = join(root, 'agents', 'bot-b')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(
      join(sibling, 'agent.json'),
      JSON.stringify({
        id: 'bot-b',
        name: 'bot-b',
        status: 'active',
        runtime: 'claude',
        // This canonical root belongs to bot-a and would let bot-b retain
        // write authority over bot-a's later skill publication.
        workspace: { mode: 'from-scratch', path: join(root, 'agents', 'bot-a', 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )

    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      agentName: 'bot-a',
      sandboxMechanism: 'bwrap'
    })
    try {
      await expect(daemon.start()).rejects.toThrow(/workspace cwd.*not inside the agent dir/)
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate active agent IDs before roster maps can collapse them', async () => {
    const root = scaffold()
    const duplicate = join(root, 'agents', 'duplicate')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(
      join(duplicate, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'duplicate',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(duplicate, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )

    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, sandboxMechanism: 'bwrap' })
    try {
      await expect(daemon.start()).rejects.toThrow(/duplicate active agent id "bot-a"/)
    } finally {
      await daemon.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('boots and routes a synthetic message through to a prompt', async () => {
    const root = scaffold()
    const prompts: string[] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts.push(blocks.map((b) => b.text).join(''))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // directly exercise dispatch via the scheduler path
    await (daemon as any).dispatch('bot-a', {
      msgId: 'cron:x:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:1',
      sender: { id: 'cron:x', isBot: false },
      text: 'run report',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    expect(prompts.join('')).toContain('run report')
    await daemon.stop()
  })

  it('injects the memory MCP server even for a no-Slack agent (memory tools are universal)', async () => {
    const root = scaffold() // scaffolded agent has integrations: []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn<(cwd: string, mcpServers: unknown[]) => Promise<string>>(async () => 'acp-mem-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: '1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    })
    // newSession(cwd, mcpServers, …) — a no-Slack agent must still get the memory MCP
    // server (regression: previously mcpServersFor returned [] without an integration).
    const mcpServers = fakeHost.newSession.mock.calls[0]![1] as unknown[]
    expect(mcpServers.length).toBe(1)
    await daemon.stop()
  })

  it('does not inject the memory MCP server when persistent memory is disabled', async () => {
    const root = scaffold(undefined, 'none')
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn<(cwd: string, mcpServers: unknown[]) => Promise<string>>(async () => 'acp-none-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: '1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    })
    const mcpServers = fakeHost.newSession.mock.calls[0]![1] as Array<{
      env: Array<{ name: string; value: string }>
    }>
    const token = mcpServers[0]!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
    const session = (daemon as any).mcp.sessions.get(token)
    expect(session.tools.map((tool: { name: string }) => tool.name)).not.toEqual(
      expect.arrayContaining(['listMemory', 'readMemory', 'writeMemory'])
    )
    await daemon.stop()
  })

  it('emits session metadata snapshots on create and turn completion', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-sess-1'),
      hasSession: (id: string) => id === 'acp-sess-1',
      modelOptions: vi.fn(() => ({ current: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5'] })),
      prompt: vi
        .fn()
        .mockResolvedValueOnce({
          stopReason: 'end_turn',
          usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 }
        })
        .mockResolvedValueOnce({
          stopReason: 'end_turn',
          usage: { totalTokens: 200, inputTokens: 160, outputTokens: 40 }
        }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // Inject a fake CP client so the fire-and-forget emit is observable (no real WS).
    const emitEventSession = vi.fn()
    const emitUsageReport = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport, stop: vi.fn() }

    const mk = (ts: string, text: string) => ({
      msgId: `slack:C1:${ts}`,
      traceId: ts,
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      sender: { id: 'U1', isBot: false },
      text,
      mentionedBots: [],
      isDm: false
    })

    await (daemon as any).dispatch('bot-a', mk('100.1', 'first'))
    // The configured model is deliberately rejected by the runtime selector on
    // the warm turn. The end snapshot/report must clear to observed unknown,
    // never fabricate this configured value or retain the prior named model.
    ;(daemon as any).agents.get('bot-a').runtimeOverrides = { model: 'configured-but-rejected' }
    fakeHost.modelOptions.mockReturnValue({ current: 'default', models: ['default'] })
    // Second (warm) turn on the SAME session re-emits a start snapshot too: the
    // CP-stored state is the only active-turn signal a console watching a platform
    // session has, and the end snapshot fires only after the row resets to idle —
    // without a per-turn start, a warm turn never reads as in flight.
    await (daemon as any).dispatch('bot-a', mk('100.2', 'second'))

    expect(emitEventSession).toHaveBeenCalledTimes(4)
    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'end', 'start', 'end'])
    // The warm turn's start snapshot is what flips the console's work panel open:
    // it must carry the ACTIVE raw state, on the same session row.
    expect(emitEventSession.mock.calls[2]![0]).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-sess-1'),
      phase: 'start',
      status: 'prompting'
    })
    const start = emitEventSession.mock.calls[0]![0]
    expect(start).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-sess-1'),
      agentId: 'bot-a',
      phase: 'start',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      title: 'first',
      status: 'prompting',
      triggeredBy: 'U1',
      // This platform-shaped cron session is local automation, not a Slack
      // audience candidate. The CP uses this durable provenance instead of
      // guessing from the legacy-compatible session key.
      sourceBindingKind: 'local',
      // Execution-config snapshot: the agent's runtime + schema-defaulted
      // permission/output modes. The actual runtime-selected model is not known
      // until the host is ready, so the start snapshot leaves it absent.
      runtime: 'claude',
      permissionMode: 'default',
      outputMode: 'medium'
    })
    expect(start.model).toBeUndefined()
    expect(start.effort).toBeUndefined()
    expect(start.fastMode).toBeUndefined()
    expect(start.link).toContain(`/sessions/${await outwardId(daemon, 'acp-sess-1')}`)
    expect(typeof start.lastActivityAt).toBe('string')
    expect(typeof start.ts).toBe('string')
    expect(start.launchId).toBeUndefined() // Slack/Discord path — no CP launch fence
    const firstFinal = emitEventSession.mock.calls[1]![0]
    expect(firstFinal).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-sess-1'),
      phase: 'end',
      status: 'idle',
      title: 'first',
      model: 'claude-sonnet-4-5',
      observedModel: 'claude-sonnet-4-5'
    })
    const final = emitEventSession.mock.calls[3]![0]
    expect(final).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-sess-1'),
      phase: 'end',
      status: 'idle',
      observedModel: null
    })
    expect(final.model).toBeUndefined()
    expect(emitUsageReport.mock.calls.map(([report]) => report.observedModel)).toEqual(['claude-sonnet-4-5', null])
    await daemon.stop()
  })

  it('persists pre-client lifecycle events and drains only the latest snapshot after restart', async () => {
    const root = scaffold()
    const configPath = join(root, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.controlPlane = {
      enabled: true,
      url: 'wss://127.0.0.1:9/daemon/ws',
      key: 'test-daemon-key'
    }
    writeFileSync(configPath, JSON.stringify(config))
    const agentId = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionId = 'acp-durable-1'
    const first = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
    let firstStopped = false
    let restored: Daemon | undefined
    try {
      const startCpClient = vi.fn()
      ;(first as any).startCpClient = startCpClient
      ;(first as any).replayInbox = async () => {
        expect(startCpClient).not.toHaveBeenCalled()
        expect((first as any).cpClient).toBeUndefined()
        await (first as any).store.upsertSession({
          key: ['slack', 'C1', '100.1', agentId].join('\0'),
          agentId,
          platform: 'slack',
          channel: 'C1',
          thread: '100.1',
          acpSessionId: sessionId,
          state: 'idle',
          lastDeliveredTs: null,
          updatedAt: Date.now()
        })
        for (const phase of ['start', 'problem', 'end'] as const) {
          ;(first as any).sessionMetadataOutbox.emitSessionMetadataSnapshot({
            sessionId,
            agentId,
            phase,
            platform: 'slack',
            channel: 'C1',
            thread: '100.1'
          })
        }
      }
      await first.start()
      expect(startCpClient).toHaveBeenCalledTimes(1)

      await first.stop()
      firstStopped = true

      restored = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
      ;(restored as any).startCpClient = vi.fn()
      await restored.start()
      const replayed = vi.fn().mockResolvedValue('acknowledged')
      ;(restored as any).cpClient = {
        state: 'READY',
        supportsServerFeature: (feature: string) => feature === 'session-metadata-ack-v1',
        emitEventSession: vi.fn(),
        syncEventSession: replayed,
        stop: vi.fn()
      }

      await (restored as any).sessionMetadataOutbox.drainSessionMetadataSnapshots()

      expect(replayed).toHaveBeenCalledTimes(1)
      expect(replayed.mock.calls[0]![0]).toMatchObject({
        sessionId: await outwardId(restored, sessionId),
        agentId,
        phase: 'end',
        platform: 'slack',
        channel: 'C1'
      })
      expect(await (restored as any).store.hasPendingSessionMetadata()).toBe(false)
    } finally {
      if (restored) await restored.stop().catch(() => undefined)
      if (!firstStopped) await first.stop().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preempts a deferred session metadata retry when work is ready sooner', async () => {
    const root = scaffold()
    const clock = new FakeClock()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, clock, probeRuntimes: async () => [] })
    await daemon.start()
    const drain = vi
      .spyOn((daemon as any).sessionMetadataOutbox, 'drainSessionMetadataSnapshots')
      .mockResolvedValue(undefined)

    try {
      ;(daemon as any).sessionMetadataOutbox.scheduleSessionMetadataRetry(5 * 60_000)
      ;(daemon as any).sessionMetadataOutbox.scheduleSessionMetadataRetry(0)
      clock.advance(0)

      expect(drain).toHaveBeenCalledTimes(1)
      expect(clock.pending()).not.toContain(5 * 60_000)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defers a poisoned session metadata snapshot and drains unrelated sessions', async () => {
    const root = scaffold()
    const clock = new FakeClock()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, clock, probeRuntimes: async () => [] })
    await daemon.start()
    const agentId = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const poison = {
      sessionId: 'acp-poison',
      agentId,
      phase: 'start',
      ts: '2026-08-15T00:00:00.000Z'
    }
    const healthy = { ...poison, sessionId: 'acp-healthy' }
    const syncEventSession = vi.fn(async (event: typeof poison) => {
      if (event.sessionId === poison.sessionId) {
        throw Object.assign(new Error('permanent persistence rejection'), { retryable: true })
      }
      return 'acknowledged' as const
    })
    const warn = vi.fn()
    ;(daemon as any).log.warn = warn
    ;(daemon as any).cpClient = {
      state: 'READY',
      supportsServerFeature: (feature: string) => feature === 'session-metadata-ack-v1',
      syncEventSession,
      stop: vi.fn(async () => {})
    }
    await (daemon as any).store.saveSessionMetadataSnapshot(agentId, poison.sessionId, JSON.stringify(poison), true, 1)
    await (daemon as any).store.saveSessionMetadataSnapshot(
      agentId,
      healthy.sessionId,
      JSON.stringify(healthy),
      true,
      2
    )

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await (daemon as any).sessionMetadataOutbox.drainSessionMetadataSnapshots()
      }

      expect(syncEventSession.mock.calls.map(([event]) => event.sessionId)).toEqual([
        'acp-poison',
        'acp-poison',
        'acp-poison',
        'acp-poison',
        'acp-poison',
        'acp-healthy'
      ])
      expect(await (daemon as any).store.pendingSessionMetadataSnapshot(agentId, poison.sessionId)).toMatchObject({
        failedAttempts: 5,
        nextAttemptAt: 300_000
      })
      expect(await (daemon as any).store.pendingSessionMetadataSnapshot(agentId, healthy.sessionId)).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('snapshot deferred after 5 failures'))
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-emits session metadata when a runtime session title update arrives', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-1'),
      hasSession: (id: string) => id === 'acp-title-1',
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, { sessionUpdate: 'session_info_update', title: 'Runtime summary' })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const setTitle = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    // A CHANNEL thread on purpose: the native title is no longer DM-gated — every turn's
    // lifecycle setStatus registers the thread as an agent session, and Slack renders the
    // title as the thread panel's header in channels too (verified live 2026-08-29).
    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:200.1',
      traceId: 'title',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: '200.1',
      sender: { id: 'U1', isBot: false },
      text: 'first fallback',
      mentionedBots: [],
      isDm: false
    })

    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'plan', 'end'])
    expect(emitEventSession.mock.calls[1]![0]).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-title-1'),
      phase: 'plan',
      title: 'Runtime summary',
      status: 'prompting'
    })
    expect(emitEventSession.mock.calls[2]![0]).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-title-1'),
      phase: 'end',
      title: 'Runtime summary',
      status: 'idle'
    })
    expect(setTitle).toHaveBeenCalledWith('C1', '200.1', 'Runtime summary')
    await daemon.stop()
  })

  it('drops a runtime title that echoes the inlined standing context', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-echo'),
      hasSession: (id: string) => id === 'acp-title-echo',
      prompt: vi.fn(async (sid: string) => {
        // codex-acp >= 1.1.3 auto-titles an untitled session from the raw first
        // prompt — ALL text blocks joined, so it starts with the inlined standing
        // context. The daemon must not persist or fan out that echo (issue #659).
        onUpdate(sid, {
          sessionUpdate: 'session_info_update',
          title: '# Agent - Name: bot-a - ID: bot-a - Source: slack - Channel: C1 first fallback'
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const setTitle = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:201.1',
      traceId: 'title-echo',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '201.1',
      sender: { id: 'U1', isBot: false },
      text: 'first fallback',
      mentionedBots: [],
      isDm: true
    })

    // No 'plan' metadata re-emit: the echo never reaches persistSessionTitle.
    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'end'])
    // The session keeps its first-message fallback title instead of the echo.
    expect(emitEventSession.mock.calls[1]![0]).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-title-echo'),
      phase: 'end',
      title: 'first fallback',
      status: 'idle'
    })
    expect(setTitle).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('fans out a runtime title to the UI and Slack during the turn', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        // Some adapters publish metadata before replying to session/new, before
        // SessionManager can commit the local row.
        onUpdate('acp-tool-title', { sessionUpdate: 'session_info_update', title: 'Early runtime title' })
        return 'acp-tool-title'
      }),
      hasSession: (id: string) => id === 'acp-tool-title',
      prompt: vi.fn(async () => {
        // The rename a runtime publishes mid-turn (codex-acp's generated title): it must
        // reach the CURRENT dispatch route, not an integration the session once used.
        onUpdate('acp-tool-title', { sessionUpdate: 'session_info_update', title: 'Fix session titles' })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const staleSetTitle = vi.fn(async () => {})
    const setTitle = vi.fn(async () => {})
    ;(daemon as any).connByIntegration.set('int-a', {
      setStatus: vi.fn(async () => {}),
      setTitle: staleSetTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    ;(daemon as any).connByIntegration.set('int-b', {
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: 'slack:D1:205.1',
        traceId: 'tool-title',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '205.1',
        sender: { id: 'U1', isBot: false },
        text: 'fix session titles',
        mentionedBots: [],
        isDm: true
      },
      'int-b'
    )

    expect(setTitle.mock.calls).toEqual([
      ['D1', '205.1', 'Early runtime title'],
      ['D1', '205.1', 'Fix session titles']
    ])
    expect(staleSetTitle).not.toHaveBeenCalled()
    expect((await (daemon as any).store.getSessionByAcpId('acp-tool-title'))?.title).toBe('Fix session titles')
    expect(
      emitEventSession.mock.calls.some(([event]) => event.phase === 'plan' && event.title === 'Fix session titles')
    ).toBe(true)
    expect(emitEventSession.mock.calls.map(([event]) => event.phase).slice(0, 3)).toEqual(['start', 'plan', 'plan'])
    await daemon.stop()
  })

  it('never persists a runtime title that is only this turn\u2019s prompt echoed back', async () => {
    // A codex-shaped runtime auto-titles an untitled session by joining its prompt blocks.
    // On a created session that join starts with the inlined standing context and is dropped
    // as an agent-meta echo; on the NEXT turn nothing prepends standing context, so the join
    // is the caller's whole message and used to be persisted verbatim as the title.
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => Promise<void> | void
    const echoedTitles: string[] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-prompt-echo'),
      hasSession: (id: string) => id === 'acp-prompt-echo',
      prompt: vi.fn(async (sid: string, blocks: { type: string; text?: string }[]) => {
        const title = blocks
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        echoedTitles.push(title)
        await onUpdate(sid, { sessionUpdate: 'session_info_update', title })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })

    const deliver = async (ts: string, text: string): Promise<void> => {
      await (daemon as any).dispatch('bot-a', {
        msgId: `slack:D1:${ts}`,
        traceId: `prompt-echo-${ts}`,
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '300.1',
        sender: { id: 'U1', isBot: false },
        text,
        mentionedBots: [],
        isDm: true
      })
    }
    const born = 'Review acme/infra#1729 and report the verdict'
    await deliver('300.1', born)
    // The second turn inlines no standing context, so its echo is the bare delivery text.
    const followUp = 'GitHub pull_request:synchronize pushed a new revision of acme/infra#1729, re-review it'
    await deliver('300.2', followUp)

    expect(fakeHost.prompt).toHaveBeenCalledTimes(2)
    expect(echoedTitles[0]).toContain('# Agent')
    expect(echoedTitles[1]).not.toContain('# Agent')
    expect(echoedTitles[1]).toContain('pull_request:synchronize')
    // Both echoes were dropped: the session keeps the title it was born with.
    expect((await (daemon as any).store.getSessionByAcpId('acp-prompt-echo'))?.title).toBe(born)
    await daemon.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('clamps a runtime title to one line of at most 80 characters', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => Promise<void> | void
    const sprawling = `Reviewed the PR\n\n${'and considered every changed file '.repeat(8)}`
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-clamp'),
      hasSession: (id: string) => id === 'acp-title-clamp',
      prompt: vi.fn(async (sid: string) => {
        await onUpdate(sid, { sessionUpdate: 'session_info_update', title: sprawling })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:D1:301.1',
      traceId: 'title-clamp',
      source: 'user',
      platform: 'slack',
      channel: 'D1',
      thread: '301.1',
      sender: { id: 'U1', isBot: false },
      text: 'summarize',
      mentionedBots: [],
      isDm: true
    })

    const stored = (await (daemon as any).store.getSessionByAcpId('acp-title-clamp'))?.title as string
    expect([...stored].length).toBeLessThanOrEqual(80)
    expect([...stored].length).toBeGreaterThan(60)
    expect(stored).not.toContain('\n')
    expect(stored.startsWith('Reviewed the PR and considered')).toBe(true)
    await daemon.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('applies a late runtime title to the UI and the exact Slack DM integration', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-late'),
      hasSession: (id: string) => id === 'acp-title-late',
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(),
      stop: vi.fn(async () => {
        await onUpdate('acp-title-late', { sessionUpdate: 'session_info_update', title: 'Fix session titles' })
      })
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()

    const makeConn = () => ({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const connA = makeConn()
    const connB = makeConn()
    ;(daemon as any).connByIntegration.set('int-a', connA)
    ;(daemon as any).connByIntegration.set('int-b', connB)
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: 'slack:D1:210.1',
        traceId: 'title-late',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '210.1',
        sender: { id: 'U1', isBot: false },
        text: 'fix session titles',
        mentionedBots: [],
        isDm: true
      },
      'int-b'
    )

    // The turn has completed and `pending` is gone. A later adapter/user rename
    // flushed while the host stops must still converge the durable title, CP
    // projection, and original Slack bot before its delivery binding is released.
    expect((daemon as any).pending.size).toBe(0)
    await (daemon as any).onAcpUpdate('another-agent', 'acp-title-late', {
      sessionUpdate: 'session_info_update',
      title: 'Wrong agent title'
    })
    // Born with the first-message fallback; the wrong agent's rename must not replace it.
    expect((await (daemon as any).store.getSessionByAcpId('acp-title-late'))?.title).toBe('fix session titles')
    await await (daemon as any).stopHost('bot-a')

    await vi.waitFor(() => expect(connB.setTitle).toHaveBeenCalledWith('D1', '210.1', 'Fix session titles'), WAIT)
    expect(connA.setTitle).not.toHaveBeenCalled()
    expect((await (daemon as any).store.getSessionByAcpId('acp-title-late'))?.title).toBe('Fix session titles')
    expect(emitEventSession.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-title-late'),
      phase: 'plan',
      title: 'Fix session titles'
    })
    expect((daemon as any).sessionDeliveryBindings.size).toBe(0)
    await daemon.stop()
  })

  it('keeps same-id ACP turns isolated by agent', async () => {
    const root = scaffold()
    const agentDir = join(root, 'agents', 'bot-b')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'bot-b',
        name: 'bot-b',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )

    const releases = new Map<string, () => void>()
    const updates = new Map<string, (sessionId: string, update: unknown) => void>()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (agent, onUpdate) => {
        updates.set(agent.id, onUpdate)
        let release!: () => void
        const blocked = new Promise<void>((resolve) => (release = resolve))
        releases.set(agent.id, release)
        return {
          __started: true,
          start: vi.fn(async () => {}),
          newSession: vi.fn(async () => 'shared-acp-id'),
          hasSession: () => true,
          prompt: vi.fn(async () => {
            await blocked
            return { stopReason: 'end_turn' }
          }),
          cancel: vi.fn(),
          stop: vi.fn()
        } as any
      }
    })
    await daemon.start()

    const message = (agentId: string) => ({
      msgId: `slack:${agentId}:1.1`,
      traceId: agentId,
      source: 'cron',
      platform: 'slack',
      channel: agentId,
      thread: '1.1',
      sender: { id: 'U1', isBot: false },
      text: `work for ${agentId}`,
      mentionedBots: [],
      isDm: false
    })
    const a = (daemon as any).dispatch('bot-a', message('bot-a'))
    const b = (daemon as any).dispatch('bot-b', message('bot-b'))
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(2), WAIT)

    await updates.get('bot-a')?.('shared-acp-id', { sessionUpdate: 'session_info_update', title: 'Agent A title' })
    await updates.get('bot-b')?.('shared-acp-id', { sessionUpdate: 'session_info_update', title: 'Agent B title' })
    expect((await (daemon as any).store.getSessionByAcpIdForAgent('bot-a', 'shared-acp-id'))?.title).toBe(
      'Agent A title'
    )
    expect((await (daemon as any).store.getSessionByAcpIdForAgent('bot-b', 'shared-acp-id'))?.title).toBe(
      'Agent B title'
    )

    releases.get('bot-a')?.()
    releases.get('bot-b')?.()
    await expect(Promise.all([a, b])).resolves.toEqual(['shared-acp-id', 'shared-acp-id'])
    expect((daemon as any).pending.size).toBe(0)
    await daemon.stop()
  })

  // No non-DM row here any more: the title gate no longer branches on the surface (channels
  // are eligible — every turn's lifecycle setStatus registers the thread as an agent session,
  // and the positive channel case is pinned above), so blank/cleared cover the whole gate.
  it.each([
    { scenario: 'a blank title', title: '   ', isDm: true },
    { scenario: 'a cleared title', title: null, isDm: true }
  ])(
    'does not set a native Slack title for $scenario',
    async ({ title, isDm }) => {
      const root = scaffold()
      let onUpdate!: (sid: string, update: unknown) => void
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-title-skip'),
        hasSession: (id: string) => id === 'acp-title-skip',
        prompt: vi.fn(async (sid: string) => {
          onUpdate(sid, { sessionUpdate: 'session_info_update', title })
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({
        slackAppFactory: fakeSlackAppFactory(),
        root,
        hostFactory: (_agent, update) => {
          onUpdate = update
          return fakeHost as any
        }
      })
      await daemon.start()
      const setTitle = vi.fn(async () => {})
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus: vi.fn(async () => {}),
        setTitle,
        postMessage: vi.fn(async () => undefined),
        postContext: vi.fn(async () => {})
      })

      await (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:201.1',
        traceId: 'title-skip',
        source: 'cron',
        platform: 'slack',
        channel: 'C1',
        thread: '201.1',
        sender: { id: 'U1', isBot: false },
        text: 'first fallback',
        mentionedBots: [],
        isDm
      })

      expect(setTitle).not.toHaveBeenCalled()
      await daemon.stop()
    },
    15_000
  )

  it.each([
    { conversation: 'channel', channel: 'C1', isDm: false },
    { conversation: 'DM', channel: 'D1', isDm: true }
  ])(
    'uses the display name for $conversation authorship and the stable bot name in its footer',
    async ({ channel, isDm }) => {
      const root = scaffold('  Release Captain  ', undefined, 'https://console.example.test/icons/bot-a')
      let onUpdate!: (sid: string, update: unknown) => void
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-channel-username'),
        hasSession: (id: string) => id === 'acp-channel-username',
        prompt: vi.fn(async (sid: string) => {
          onUpdate(sid, { sessionUpdate: 'session_info_update', title: 'Unrelated session title' })
          onUpdate(sid, {
            sessionUpdate: 'tool_call',
            toolCallId: 'search-1',
            title: 'Searching…',
            status: 'in_progress'
          })
          onUpdate(sid, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'channel answer' }
          })
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({
        slackAppFactory: fakeSlackAppFactory(),
        root,
        hostFactory: (_agent, update) => {
          onUpdate = update
          return fakeHost as any
        }
      })
      await daemon.start()
      const postMessage = vi.fn(
        async (_channel: string, _text: string, _thread?: string, _options?: unknown) => 'reply-ts'
      )
      const setStatus = vi.fn(async () => {})
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus,
        setTitle: vi.fn(async () => {}),
        postMessage,
        updateMessage: vi.fn(async () => {}),
        postBlocks: vi.fn(async () => 'status-ts'),
        updateBlocks: vi.fn(async () => {}),
        postContext: vi.fn(async () => {})
      })

      await (daemon as any).dispatch('bot-a', {
        msgId: `slack:${channel}:202.1`,
        traceId: 'channel-username',
        source: 'cron',
        platform: 'slack',
        channel,
        thread: '202.1',
        sender: { id: 'U1', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm
      })

      const answerCall = postMessage.mock.calls.find(([, text]) => String(text).includes('channel answer'))
      expect(answerCall?.[3]).toMatchObject({
        username: 'Release Captain',
        icon_url: 'https://console.example.test/icons/bot-a',
        agentAuthorId: 'bot-a',
        trailingBlocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: expect.stringContaining('|bot-a>') }]
          }
        ]
      })
      const expectedStatusIdentity = {
        username: 'Release Captain',
        icon_url: 'https://console.example.test/icons/bot-a',
        sessionKey: `slack:${channel}:202.1:bot-a`
      }
      expect(setStatus).toHaveBeenCalledWith(channel, '202.1', 'is thinking…', expectedStatusIdentity)
      expect(setStatus).toHaveBeenCalledWith(channel, '202.1', 'Searching…', expectedStatusIdentity)
      await daemon.stop()
    },
    15_000
  )

  it.each([
    { scenario: 'a trimmed display name', displayName: '  Release Captain  ', expectedUsername: 'Release Captain' },
    { scenario: 'the agent name fallback', displayName: '   ', expectedUsername: 'bot-a' }
  ])(
    'labels a pre-session channel failure with $scenario',
    async ({ displayName, expectedUsername }) => {
      const root = scaffold(displayName)
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => {
          throw new Error('session init failed')
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
      await daemon.start()
      const postMessage = vi.fn(async () => 'failure-ts')
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus: vi.fn(async () => {}),
        postMessage
      })

      await expect(
        (daemon as any).dispatch('bot-a', {
          msgId: 'slack:C1:202.2',
          traceId: 'channel-username-failure',
          source: 'cron',
          platform: 'slack',
          channel: 'C1',
          thread: '202.2',
          sender: { id: 'U1', isBot: false },
          text: 'hello',
          mentionedBots: [],
          isDm: false
        })
      ).rejects.toThrow('session init failed')

      expect(postMessage).toHaveBeenCalledWith('C1', '⚠️ Agent failed to respond: session init failed', '202.2', {
        username: expectedUsername,
        chrome: true
      })
      await daemon.stop()
    },
    15_000
  )

  it('re-emits session metadata when display names are resolved after the turn', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-name-1'),
      hasSession: (id: string) => id === 'acp-name-1',
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:300.1',
      traceId: 'names',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: '300.1',
      sender: { id: 'U1', isBot: false },
      text: 'need names',
      mentionedBots: [],
      isDm: false
    })

    await (daemon as any).store.setDisplayName('C1', 'deploys', Date.now())
    await (daemon as any).store.setDisplayName('U1', 'Dana Reyes', Date.now())
    await (daemon as any).sessionMetadataOutbox.emitSessionMetadataSnapshotsForDisplayName('C1')

    const refresh = emitEventSession.mock.calls.at(-1)![0]
    expect(refresh).toMatchObject({
      sessionId: await outwardId(daemon, 'acp-name-1'),
      phase: 'plan',
      title: 'need names',
      status: 'idle',
      channelName: 'deploys',
      triggeredBy: 'U1',
      triggeredByName: 'Dana Reyes'
    })
    await daemon.stop()
  })

  it('pending map is cleaned up when host.prompt throws', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-err-1'),
      prompt: vi.fn(async () => {
        throw new Error('prompt exploded')
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const msg = {
      msgId: 'cron:x:2',
      traceId: '2',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:2',
      sender: { id: 'cron:x', isBot: false },
      text: 'fail',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    }
    await expect((daemon as any).dispatch('bot-a', msg)).rejects.toThrow('prompt exploded')
    expect((daemon as any).pending.size).toBe(0)
    await daemon.stop()
  })

  // codex-acp signals quota exhaustion by streaming the human-readable message as an
  // agent_message_chunk and then rejecting session/prompt with a bare "Internal error"
  // whose data carries the real text. The daemon must deliver that text exactly once —
  // as the flushed reply, recorded into the transcript — not a "⚠️ … Internal error".
  const USAGE_LIMIT_MSG =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:01 PM."
  const usageLimitError = () =>
    Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { message: USAGE_LIMIT_MSG, codexErrorInfo: 'usageLimitExceeded' }
    })

  it('flushes a runtime-streamed terminal error as the reply, with no duplicate ⚠️ notice', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-quota-1'),
      hasSession: (id: string) => id === 'acp-quota-1',
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${USAGE_LIMIT_MSG}\n\n` }
        })
        throw usageLimitError()
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const posts: string[] = []
    const setStatus = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus,
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async (_c: string, text: string) => {
        posts.push(text)
        return undefined
      }),
      postContext: vi.fn(async () => {})
    })

    await expect(
      (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:400.1',
        traceId: 'quota',
        source: 'cron',
        platform: 'slack',
        channel: 'C1',
        thread: '400.1',
        sender: { id: 'U1', isBot: false },
        text: 'summarize the day',
        mentionedBots: [],
        isDm: false
      })
    ).rejects.toThrow('Internal error')

    // The streamed message posted exactly once, verbatim — and no ⚠️ notice on top.
    expect(posts.filter((t) => t.includes("You've hit your usage limit"))).toHaveLength(1)
    expect(posts.some((t) => t.includes('⚠️'))).toBe(false)
    expect(setStatus).toHaveBeenCalledWith('C1', '400.1', '', undefined) // "is thinking…" cleared
    // …and it landed in the transcript, so the console session view shows it.
    const { rows } = await (daemon as any).store.transcriptPage('C1', '400.1', null, 10)
    const agentRows = rows.filter((r: any) => r.sender === 'bot-a' && r.kind === 'text')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0]!.text).toContain("You've hit your usage limit")
    await daemon.stop()
  })

  // Same path, but the narrated error is a single line with no trailing paragraph break —
  // the idle flush would hold that back, so the terminal drain must not be the idle one.
  it('flushes a runtime-streamed terminal error that has no paragraph break', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-quota-3'),
      hasSession: (id: string) => id === 'acp-quota-3',
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: USAGE_LIMIT_MSG } })
        throw usageLimitError()
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const posts: string[] = []
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async (_c: string, text: string) => {
        posts.push(text)
        return undefined
      }),
      postContext: vi.fn(async () => {})
    })

    await expect(
      (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:402.1',
        traceId: 'quota-no-break',
        source: 'cron',
        platform: 'slack',
        channel: 'C1',
        thread: '402.1',
        sender: { id: 'U1', isBot: false },
        text: 'summarize the day',
        mentionedBots: [],
        isDm: false
      })
    ).rejects.toThrow('Internal error')

    // Delivered verbatim exactly once, with no ⚠️ notice standing in for the lost body.
    expect(posts).toEqual([USAGE_LIMIT_MSG])
    const { rows } = await (daemon as any).store.transcriptPage('C1', '402.1', null, 10)
    const agentRows = rows.filter((r: any) => r.sender === 'bot-a' && r.kind === 'text')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0]!.text).toBe(USAGE_LIMIT_MSG)
    await daemon.stop()
  })

  it('surfaces the detailed data.message (not "Internal error") when nothing was streamed', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-quota-2'),
      prompt: vi.fn(async () => {
        throw usageLimitError()
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const posts: string[] = []
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async (_c: string, text: string) => {
        posts.push(text)
        return undefined
      }),
      postContext: vi.fn(async () => {})
    })

    await expect(
      (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:401.1',
        traceId: 'quota-bare',
        source: 'cron',
        platform: 'slack',
        channel: 'C1',
        thread: '401.1',
        sender: { id: 'U1', isBot: false },
        text: 'summarize the day',
        mentionedBots: [],
        isDm: false
      })
    ).rejects.toThrow('Internal error')

    expect(posts).toHaveLength(1)
    expect(posts[0]).toBe(`⚠️ Agent failed to respond: ${USAGE_LIMIT_MSG}`)
    const { rows } = await (daemon as any).store.transcriptPage('C1', '401.1', null, 10)
    const agentRows = rows.filter((r: any) => r.sender === 'bot-a' && r.kind === 'text')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0]!.text).toBe(`⚠️ Agent failed to respond: ${USAGE_LIMIT_MSG}`)
    await daemon.stop()
  })

  it('C1 regression: single onInbound call dispatches exactly once (no double-dispatch)', async () => {
    const root = scaffold()
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-c1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const dispatchSpy = vi.spyOn(daemon as any, 'dispatch')
    const msg = {
      msgId: 'm1',
      traceId: 't1',
      source: 'slack' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: 'T1',
      sender: { id: 'U1', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: false,
      trigger: 'mention' as const
    }
    await (daemon as any).onInboundOutcome(msg)
    // merged rule set is empty (bot-a has no Slack integrations) → routeRules() returns null → 0 dispatches.
    // With the old bug, the message would have been dispatched once per integration in the group.
    // The key invariant: onInbound calls dispatch AT MOST ONCE per physical message event.
    expect(dispatchSpy.mock.calls.length).toBeLessThanOrEqual(1)
    await daemon.stop()
  })

  it('preserves an explicit self-mention route as trusted prompt context', async () => {
    const root = scaffold()
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-mention'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    vi.spyOn(daemon as any, 'mergedRules').mockReturnValue([
      {
        agentId: 'bot-a',
        integrationId: 'slack-int',
        botUserId: 'U1234567890',
        platform: 'slack',
        scope: { channel: 'C1' },
        match: { kind: 'mention' },
        source: 'config'
      }
    ])
    const dispatchSpy = vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp-mention')
    const inbound = {
      msgId: 'slack:C1:500.1',
      traceId: 'self-mention',
      source: 'user' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: '500.1',
      sender: { id: 'U0987654321', isBot: false },
      text: '<@U1234567890> hello',
      mentionedBots: ['U1234567890'],
      isDm: false
    }

    await (daemon as any).onInboundOutcome(inbound)

    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(dispatchSpy.mock.calls[0]![0]).toBe('bot-a')
    expect(dispatchSpy.mock.calls[0]![1]).toEqual(expect.objectContaining({ trigger: 'mention', text: inbound.text }))
    expect(dispatchSpy.mock.calls[0]![2]).toBe('slack-int')
    await daemon.stop()
  })

  it('stop() releases all resources even if one throws, and rejects with AggregateError', async () => {
    const root = scaffold()
    const stopSpy = vi.fn(async () => {
      throw new Error('host stop failed')
    })
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-2'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: stopSpy
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // trigger host creation so it ends up in hosts map
    await (daemon as any).dispatch('bot-a', {
      msgId: 'cron:x:3',
      traceId: '3',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:3',
      sender: { id: 'cron:x', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    // spy on store.close to confirm it still runs despite the host throwing
    const storeSpy = vi.spyOn((daemon as any).store, 'close')
    const err = await daemon.stop().catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect(stopSpy).toHaveBeenCalled()
    expect(storeSpy).toHaveBeenCalled()
  })

  it('single-agent mode: --agent loads exactly that agent (zero-config) and dispatches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-single-')) // no config.json on purpose
    const agentsDir = join(root, 'agents')
    const adir = join(agentsDir, 'solo')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'solo',
        name: 'solo',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const prompts: string[] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-solo'),
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts.push(blocks.map((b) => b.text).join(''))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      agentName: 'solo',
      overrides: { agentsDir },
      hostFactory: () => fakeHost as any
    })
    await daemon.start()
    expect((daemon as any).agents.size).toBe(1)
    expect((daemon as any).agents.has('solo')).toBe(true)
    await (daemon as any).dispatch('solo', {
      msgId: 'cron:s:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:s:1',
      sender: { id: 'cron:s', isBot: false },
      text: 'go',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    expect(prompts.join('')).toContain('go')
    await daemon.stop()
  })

  it('low mode: cold agent gets "is starting up…" then "is thinking…"; warm agent goes straight to "is thinking…"', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-status'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()

    const statuses: string[] = []
    const fakeConn = {
      setStatus: vi.fn(async (_c: string, _t: string, status: string) => {
        statuses.push(status)
      }),
      postMessage: vi.fn(async () => {})
    }
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue(fakeConn)

    const mk = (id: string) => ({
      msgId: `cron:s:${id}`,
      traceId: id,
      source: 'cron' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: `cron:s:${id}`,
      sender: { id: 'cron:s', isBot: false },
      text: 'go',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron' as const
    })

    // cold: host not yet started → "is starting up…" then "is thinking…"
    await (daemon as any).dispatch('bot-a', mk('1'))
    expect(statuses.slice(0, 2)).toEqual(['is starting up…', 'is thinking…'])

    // warm: host already started → first status is "is thinking…", never "is starting up…"
    statuses.length = 0
    await (daemon as any).dispatch('bot-a', mk('2'))
    expect(statuses[0]).toBe('is thinking…')
    expect(statuses).not.toContain('is starting up…')

    await daemon.stop()
  })

  it('single-agent mode runs an inactive agent when selected by --agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-single-'))
    const agentsDir = join(root, 'agents')
    const adir = join(agentsDir, 'paused-bot')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'paused-bot',
        name: 'paused-bot',
        status: 'inactive',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      agentName: 'paused-bot',
      overrides: { agentsDir },
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })
    await daemon.start()
    expect((daemon as any).agents.has('paused-bot')).toBe(true)
    await daemon.stop()
  })
})
