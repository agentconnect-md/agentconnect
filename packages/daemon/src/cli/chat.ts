import { createInterface } from 'node:readline'
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import { loadConfig } from '../config/load-config.js'
import { resolveRuntimeCatalog, type ResolvedRuntimeCatalog } from '../runtimes/registry.js'
import { selectAgent } from '../agents/load-agents.js'
import { agentChildEnv } from '../agents/agent-env.js'
import { cleanupConfigFiles, materializeConfigFiles } from '../agents/config-file-env.js'
import { memoryKindOf, memoryProviderFor } from '../agents/memory-provider.js'
import { prepareWorkspace } from '../workspace/workspace-manager.js'
import { configureWorkspaceGitOrigins } from '../workspace/git-origin-policy.js'
import { AcpHost } from '../acp/acp-host.js'
import { effectiveRunInSandbox } from '../acp/runtime-launch.js'
import { detectSandbox } from '../acp/sandbox.js'
import { resolveRoot } from '../paths.js'
import { runtimeHomePath } from '../runtimes/runtime-home.js'
import { installedRuntimeCatalog } from '../runtimes/probe.js'
import { probeAllRuntimes, type ProbeOptions, type RuntimeProbeResult } from '../runtimes/runtime-prober.js'
import { CuratedRuntimeAdmission } from '../runtimes/curated-admission.js'
import { composeRuntimeLaunch } from '../runtimes/launch-policy.js'
import type { RuntimeDef } from '../config/config-schema.js'

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
  const agent = selectAgent(cfg.agentsDir!, opts.agentName)

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
  const runInSandbox = effectiveRunInSandbox(cfg.security.requireSandbox, agent.runInSandbox, sandboxMechanism)
  if (entry?.source === 'curated') {
    const admission = new CuratedRuntimeAdmission()
    const probe = opts.probeRuntimes ?? probeAllRuntimes
    const results = await probe(
      { [agent.runtime]: runtime },
      {
        curated: true,
        isolateAccountApps: cfg.security.isolateAccountApps,
        runInSandbox,
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
  // Config-file secrets: same materialization the daemon performs at host spawn
  // (agents/config-file-env.ts) — *_DATA content becomes a file, the pointer var
  // replaces the raw value in the child env.
  const configFiles = materializeConfigFiles(agent.dir, { ...runtimeEnv, ...agentEnv })
  for (const name of configFiles.strip) {
    delete agentEnv[name]
    delete runtimeEnv[name]
  }
  Object.assign(agentEnv, configFiles.env)
  for (const notice of configFiles.notices) out.write(`⚠️ ${notice}\n`)
  const memoryAgent =
    memoryKindOf(agent) === 'native' && runInSandbox ? { ...agent, dir: runtimeHomePath(agent.dir) } : agent
  const composed = composeRuntimeLaunch({
    runtimeId: agent.runtime,
    runtime,
    provider: memoryKindOf(agent),
    scopeDir: agent.dir,
    cwd: agent.workspace.path,
    runInSandbox,
    daemonRoot: root,
    agentsRoot: cfg.agentsDir,
    explicitEnv: {
      ...runtimeEnv,
      ...agentEnv,
      ...memoryProviderFor(memoryAgent, runtime, agentEnv).runtimeEnv()
    },
    sandboxMechanism
  })
  const hostOptions: ConstructorParameters<typeof AcpHost>[1] = {
    onUpdate: renderUpdate(out),
    runtimeId: agent.runtime,
    isolateAccountApps: cfg.security.isolateAccountApps,
    env: composed.launch.env,
    inheritProcessEnv: composed.launch.inheritProcessEnv,
    sandbox: composed.launch.sandbox,
    configPrefs: {
      model: agent.runtimeOverrides?.model,
      permissionMode: agent.permissionMode,
      reasoningEffort: agent.reasoningEffort,
      fastMode: agent.fastMode
    }
  }
  const host = opts.hostFactory
    ? opts.hostFactory(composed.runtime, hostOptions)
    : new AcpHost(composed.runtime, hostOptions)
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
    await host.start()
    const cwd = await prepareWorkspace(agent)
    const sessionId = await host.newSession(cwd)

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
