import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import { loadConfig } from '../config/load-config.js'
import { resolveRuntimeCatalog, type ResolvedRuntimeCatalog } from '../runtimes/registry.js'
import { selectAgent } from '../agents/load-agents.js'
import { agentChildEnv } from '../agents/agent-env.js'
import { cleanupConfigFiles } from '../shim/config-file-env.js'
import { memoryKindOf, memoryProviderFor } from '../memory/provider.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { configureWorkspaceGitOrigins } from '../workspace/git-origin-policy.js'
import { AcpHost } from '../acp/acp-host.js'
import { effectiveRunInSandbox } from '../launch/prepare.js'
import { detectSandbox } from '../acp/sandbox.js'
import { agentHostKey } from '../acp/host-key.js'
import { resolveRoot } from '../paths.js'
import { runtimeHomePath } from '../runtimes/runtime-home.js'
import { sandboxReadRoots } from '../runtimes/read-roots.js'
import { installedRuntimeCatalog } from '../runtimes/probe.js'
import { probeAllRuntimes, type ProbeOptions, type RuntimeProbeResult } from '../runtimes/runtime-prober.js'
import { defaultProbeHostFactory } from '../acp/probe-host-factory.js'
import { CuratedRuntimeAdmission } from '../runtimes/curated-admission.js'
import { assembleRuntimeLaunch } from '../launch/assemble.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { persistSkillSandboxRequirement } from '../skills/skill-sandbox-policy.js'

export function renderUpdate(out: NodeJS.WritableStream) {
  return (_sessionId: string, update: SessionUpdate): void => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      out.write(update.content.text)
    } else if (update.sessionUpdate === 'tool_call') {
      const title = ('title' in update && update.title) || update.toolCallId || 'tool'
      out.write(`\n[tool] ${title}\n`)
    }
  }
}

export interface RunChatOpts {
  agentsDir?: string
  agentName?: string
  message?: string
  configPath?: string
  root?: string
  out?: NodeJS.WritableStream
  input?: NodeJS.ReadableStream
  /** Test/embedding seams; production uses the normal catalog, host probe, ACP
   * compatibility probe, and AcpHost constructor. */
  resolveCatalog?: () => Promise<ResolvedRuntimeCatalog>
  installed?: (runtimes: Record<string, RuntimeDef>) => Record<string, RuntimeDef>
  probeRuntimes?: (runtimes: Record<string, RuntimeDef>, opts: ProbeOptions) => Promise<RuntimeProbeResult[]>
  hostFactory?: (runtime: RuntimeDef, options: ConstructorParameters<typeof AcpHost>[1]) => AcpHost
}

export async function runChat(opts: RunChatOpts): Promise<void> {
  const out = opts.out ?? process.stdout
  const root = resolveRoot(opts.root)
  const cfg = loadConfig({
    root: opts.root,
    configPath: opts.configPath,
    optional: true,
    overrides: { agentsDir: opts.agentsDir }
  })
  configureWorkspaceGitOrigins(cfg.security.workspaceGitAllowedOrigins)
  // Same fail-fast the daemon applies at boot: a missing operator read root is a config error, not a turn error.
  const operatorReadRoots = sandboxReadRoots(cfg.security.sandboxReadRoots)
  const agent = selectAgent(cfg.agentsDir!, opts.agentName)
  await persistSkillSandboxRequirement(root)

  const catalog = opts.resolveCatalog
    ? await opts.resolveCatalog()
    : await resolveRuntimeCatalog(cfg, root, { neededRuntimes: [agent.runtime], mode: 'cache-first' })
  const runtimes = opts.installed ? opts.installed(catalog.runtimes) : installedRuntimeCatalog(catalog).runtimes
  const entry = catalog.entries[agent.runtime]
  const runtime = runtimes[agent.runtime]
  if (!runtime) {
    if (entry?.source === 'curated') {
      throw new Error(`curated runtime "${agent.runtime}" is not installed or initialized on this host`)
    }
    const available = Object.keys(runtimes).sort().join(', ') || '(none)'
    throw new Error(`runtime "${agent.runtime}" not found. Available: ${available}`)
  }

  const sandboxMechanism = detectSandbox()
  // Sandbox-optional principle (#36): the single-shot host follows the agent's OWN
  // sandbox decision (and the explicit operator requireSandbox), never a forced
  // skill-authority requirement — so chat runs on hosts with or without an OS
  // sandbox instead of failing closed.
  const runInSandbox = effectiveRunInSandbox(cfg.security.requireSandbox, agent.runInSandbox, sandboxMechanism, runtime)
  if (entry?.source === 'curated') {
    const admission = new CuratedRuntimeAdmission()
    const probe = opts.probeRuntimes ?? probeAllRuntimes
    const results = await probe(
      { [agent.runtime]: runtime },
      {
        curated: true,
        hostFactory: defaultProbeHostFactory({ isolateAccountApps: cfg.security.isolateAccountApps }),
        runInSandbox,
        requireSandbox: cfg.security.requireSandbox,
        daemonRoot: root,
        agentsRoot: cfg.agentsDir,
        sandboxMechanism,
        hostEnv: process.env
      }
    )
    admission.record(
      results.find((result) => result.runtime === agent.runtime) ?? {
        runtime: agent.runtime,
        ok: false,
        models: [],
        error: 'ACP probe returned no result'
      }
    )
    admission.assertLaunch(agent.runtime, entry.source)
  }

  const agentEnv = agentChildEnv(agent)
  const runtimeEnv = Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value]))
  const memoryAgent =
    memoryKindOf(agent) === 'native' && runInSandbox ? { ...agent, dir: runtimeHomePath(agent.dir) } : agent
  // Memory backend env joins the agent env BEFORE materialization, as the daemon does, so
  // config-file detection sees the same child env on both paths.
  Object.assign(agentEnv, memoryProviderFor(memoryAgent, runtime, agentEnv).runtimeEnv())
  // The standalone chat CLI runs one agent locally, so it owns a plane with nothing registered
  // on it: git runs here and no path lives in a sandbox.
  const workspaces = new WorkspaceManager()
  // Before the launch policy, not after: the sandbox boundary is computed from what is ON DISK, so
  // a first run that assembled first would confine the runtime out of the checkouts it just cloned.
  // The daemon's cold-host gate prepares in this order too (startHostWithRetry).
  const cwd = await workspaces.prepareWorkspace(agent, {
    skillsStateDir: join(root, 'skill-installs'),
    skillsAgentId: entry?.skillsAgentId ?? null
  })
  const assembled = assembleRuntimeLaunch({
    runtimeId: agent.runtime,
    runtime,
    provider: memoryKindOf(agent),
    hostKey: agentHostKey(agent.id),
    scopeDir: agent.dir,
    cwd: agent.workspace.path,
    runInSandbox,
    daemonRoot: root,
    agentsRoot: cfg.agentsDir,
    runtimeEnv,
    agentEnv,
    configFileDir: agent.dir,
    // Same sandbox write carve-back the daemon grants: without it a sandboxed chat run cannot write
    // its own session worktrees, nor read the secondary roots beside them.
    trustedWorkspaceWriteRoots: runInSandbox ? workspaces.trustedWorkspaceWriteRoots(agent) : undefined,
    trustedPrimaryCheckout: runInSandbox ? workspaces.localPrimaryCheckoutFor(agent) : undefined,
    // No daemon here, so there is no MCP bridge socket, gh wrapper, or git-credential shim to carve
    // back: mcpSocketPath / allowModelToolUnixSockets stay genuinely unused. The operator's
    // daemon-wide toolchain roots still apply, exactly as they do under the daemon.
    runtimeReadRoots: runInSandbox ? operatorReadRoots : undefined,
    sandboxMechanism
  })
  for (const notice of assembled.configFiles?.notices ?? []) out.write(`⚠️ ${notice}\n`)
  const hostOptions: ConstructorParameters<typeof AcpHost>[1] = {
    onUpdate: renderUpdate(out),
    runtimeId: agent.runtime,
    isolateAccountApps: cfg.security.isolateAccountApps,
    env: assembled.launch.env,
    inheritProcessEnv: assembled.launch.inheritProcessEnv,
    sandbox: assembled.launch.sandbox,
    configPrefs: {
      model: agent.runtimeOverrides?.model,
      permissionMode: agent.permissionMode,
      reasoningEffort: agent.reasoningEffort,
      fastMode: agent.fastMode
    }
  }
  const host = opts.hostFactory
    ? opts.hostFactory(assembled.runtime, hostOptions)
    : new AcpHost(assembled.runtime, hostOptions)
  // The adapter child runs in its own process group (see AcpHost.start), so a
  // terminal Ctrl-C no longer kills it as a side effect — Node's default SIGINT
  // exit would skip the finally below and leak it. Stop the host, then re-exit.
  // Registered BEFORE start(): a first-run `npx -y` runtime download takes long
  // enough that Ctrl-C mid-start is common, and the spawn happens early in start().
  const onSigint = () => {
    void host.stop().finally(() => {
      cleanupConfigFiles(agent.dir)
      process.exit(130)
    })
  }
  process.once('SIGINT', onSigint)
  try {
    // Runtime adapters may discover skills only during initialization, and the clone/pull +
    // unified-skill reconciliation above is complete before the child starts.
    await host.start()
    const sessionId = await host.newSession(
      cwd,
      [],
      undefined,
      undefined,
      await workspaces.additionalWorkspaceDirectories(agent, cwd)
    )

    const send = async (text: string) => {
      const blocks: ContentBlock[] = [{ type: 'text', text }]
      await host.prompt(sessionId, blocks)
      out.write('\n')
    }

    if (typeof opts.message === 'string' && opts.message.length > 0) {
      await send(opts.message)
      return
    }

    const rl = createInterface({ input: opts.input ?? process.stdin })
    out.write(`Chatting with ${agent.name} (${agent.id}). Type .exit to quit.\n> `)
    try {
      for await (const line of rl) {
        const text = line.trim()
        if (text === '.exit' || text === '.quit') break
        if (text.length > 0) await send(text)
        out.write('> ')
      }
    } finally {
      rl.close()
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    await host.stop()
    // The chat "session" ends with the process — don't leave the materialized
    // secret files behind (best-effort, mirrors the daemon's stopHost cleanup).
    cleanupConfigFiles(agent.dir)
  }
}
