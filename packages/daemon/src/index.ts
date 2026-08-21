#!/usr/bin/env node
import { startDaemonOpenTelemetry } from './observability.js'
import { DAEMON_VERSION } from './version.js'

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
if (!(nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 12))) {
  console.error(
    `agentconnect: Node.js >=24.12.0 is required; found ${process.versions.node} at ${process.execPath}. Upgrade Node.js before starting AgentConnect (reinstall the background service after changing Node).`
  )
  process.exit(1)
}

// Internal per-ACP-host SRT provider. Fast-path it before telemetry/Commander:
// the process is only a stdio-preserving sandbox parent and must not initialize
// a second daemon's observability or CLI lifecycle.
if (process.argv[2] === '__sandbox-runtime' || process.argv[2] === '__sandbox-runtime-offline') {
  const { runSandboxRuntimeProvider } = await import('./acp/sandbox-runtime-provider.js')
  process.exit(
    await runSandboxRuntimeProvider(process.argv.slice(3), {
      offline: process.argv[2] === '__sandbox-runtime-offline'
    })
  )
}

const telemetry = startDaemonOpenTelemetry({ serviceVersion: DAEMON_VERSION })
const [{ Command }, { acquireSingletonLock }, { resolveRoot }] = await Promise.all([
  import('commander'),
  import('./lock.js'),
  import('./paths.js')
])

// CLI surface mirrors docs/designs/daemon-detailed-design.md §1.2.

const program = new Command()

const exit = async (code: number): Promise<never> => {
  await telemetry.shutdown().catch((err) => {
    console.error(`agentconnect: opentelemetry shutdown failed: ${(err as Error).message}`)
  })
  process.exit(code)
}

program
  .name('agentconnect')
  .description('AgentConnect daemon — edge message + agent execution unit')
  .version(DAEMON_VERSION)

// Process-level overrides (docs §1.3). Declared as global options so every
// subcommand can read them; they take precedence over config.json.
program
  .option('--config <path>', 'path to config.json (default ~/.agentconnect/config.json)')
  .option('--root <dir>', 'override ~/.agentconnect root directory')
  .option('--api-url <url>', 'override AgentConnect API WebSocket URL')
  .option('--api-key <key>', 'override daemon API key')
  .option('--no-cp', 'run fully local, do not connect to the Control Plane')
  .option('--daemon-id <id>', 'override daemon identity')
  .option('--log-level <level>', 'trace|debug|info|warn|error')
  .option('--agents-dir <dir>', 'override agents directory')
  .option('--max-agents <n>', 'max agents this daemon advertises / enforces')
  .option('--require-sandbox', 'require the Linux SRT sandbox for every agent or refuse daemon startup')
  .option('--k8s', 'run runtimes in cluster sandbox pods instead of on this host (no probing, no local runtimes)')
  .option('--key-server <url>', 'http(s) endpoint for session-scoped model credentials')
  .option('--key-server-token-path <path>', 'file containing the key-server bearer token')
  .option('--dry-run', 'load + validate config and print the reconcile plan, then exit')
  .option('--agent <name>', 'select a single agent by id (run/chat)')

program
  .command('run')
  .description('Run the daemon in the foreground')
  .action(async () => {
    const opts = program.opts()
    // A long-running edge daemon holds many tenants' platform connections; one bad
    // credential must not take down the whole process. Some platform SDKs surface a
    // bad token as a FLOATING promise rejection we cannot await/catch at the call
    // site — e.g. Slack Bolt fires an identity `auth.test` at App construction, so an
    // invalid token rejects outside `SlackConnection.start`'s try/catch. Log and keep
    // running instead of Node's default (crash the process).
    process.on('unhandledRejection', (reason) => {
      console.error(
        `agentconnect: unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
      )
    })
    // Single-instance guard (same root): blocks a second daemon from opening a
    // second Socket Mode connection on the same Slack app token, which would make
    // Slack split events across the two and silently drop ~half on each.
    let lock
    try {
      lock = acquireSingletonLock(resolveRoot(opts.root))
    } catch (err) {
      console.error(`agentconnect run: ${(err as Error).message}`)
      return exit(1)
    }
    try {
      // A k8s daemon's version IS its image: there is no CLI or version store to
      // self-install from, so the bootstrap upgrade path is skipped outright rather
      // than left to fail on a missing cli-entry pointer.
      if (opts.k8s !== true) {
        const bootstrap = await import('./bootstrap-upgrade.js')
        const bootstrapOutcome = await bootstrap.runBootstrapUpgrade({
          root: opts.root,
          configPath: opts.config,
          supervisor: process.env.AGENTCONNECT_SUPERVISOR,
          overrides: {
            apiUrl: opts.apiUrl,
            apiKey: opts.apiKey,
            noCp: opts.cp === false,
            daemonId: opts.daemonId
          }
        })
        if (bootstrapOutcome === 'restart') {
          lock.release()
          return exit(bootstrap.BOOTSTRAP_RESTART_CODE)
        }
      }
      // Load the business graph only after auth-only recovery.
      const { runForeground } = await import('./cli/run-foreground.js')
      await runForeground({
        root: opts.root,
        configPath: opts.config,
        agentName: opts.agent,
        // The launcher (CLI respawn shell or launchd/systemd unit) declares how
        // this daemon is supervised; the daemon can no longer self-detect it now
        // that the service layer lives in the CLI (cli-daemon-split.md §7.1).
        supervisor: process.env.AGENTCONNECT_SUPERVISOR,
        k8s: opts.k8s === true,
        keyServer: opts.keyServer,
        keyServerTokenPath: opts.keyServerTokenPath,
        overrides: {
          apiUrl: opts.apiUrl,
          apiKey: opts.apiKey,
          noCp: opts.cp === false,
          daemonId: opts.daemonId,
          logLevel: opts.logLevel,
          agentsDir: opts.agentsDir,
          maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
          requireSandbox: opts.requireSandbox
        }
      })
      lock.release()
      return exit(0)
    } catch (err) {
      lock.release()
      console.error(`agentconnect run: ${(err as Error).message}`)
      return exit(1)
    }
  })

// The pool's orphan reconciler, as a one-shot job. It runs as a Kubernetes CronJob rather than a
// timer inside every member, so the cluster owns the schedule and the mutual exclusion
// (`concurrencyPolicy: Forbid`); a non-zero exit is a failed Job the cluster already reports.
program
  .command('reconcile')
  .description('Sweep the sandbox namespace for orphaned sandbox objects once, then exit')
  .requiredOption('--once', 'run exactly one sweep (the only mode)')
  .action(async () => {
    const opts = program.opts()
    const { runReconcileOnce } = await import('./cli/reconcile.js')
    return exit(await runReconcileOnce({ ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}) }))
  })

// Hidden: the stdio MCP server spawned by an agent harness. Not user-facing —
// it's referenced by `mcpServers[].command/args` at `session/new`. Reads its
// target socket + session token from AC_MCP_ENDPOINT / AC_MCP_TOKEN.
program
  .command('mcp-bridge', { hidden: true })
  .description('internal: stdio MCP bridge to the running daemon')
  .option('--lazy-tools', 'resolve tools/list dynamically for a private delegated broker')
  .action(async (opts: { lazyTools?: boolean }) => {
    const { runBridge } = await import('./mcp/bridge.js')
    await runBridge({ lazyTools: opts.lazyTools === true, version: DAEMON_VERSION })
  })

// Service lifecycle (up/down/restart/status/install-service/uninstall-service)
// and interactive `login` now live in @agentconnect.md/cli — the stable bin that
// supervises and version-manages this daemon (cli-daemon-split.md §4). The
// daemon bundle only provides `run` + the hidden helpers below.

// Git credential helper (github-app workspaces): invoked BY GIT via the shim in
// repo config / session env, once or more per remote operation — lazy import
// keeps its cost to bundle init only. Speaks the git credential protocol on
// stdin/stdout and proxies the daemon's gitcred.sock; tokens never touch disk.
program
  .command('git-credential', { hidden: true })
  .description('Git credential helper backed by the local daemon (github-app workspaces)')
  // POSITIONAL on purpose: git appends the action to the helper line, and a
  // dev daemon's shim routes through the tsx CLI, which swallows unknown
  // --flags before they reach commander. `<agentId> <action>` survives both.
  .argument('<agentId>', 'agent whose workspace credentials to serve')
  .argument('<action>', 'git credential action: get | store | erase')
  .action(async (agentId: string, action: string) => {
    const { runGitCredential } = await import('./cli/git-credential.js')
    await runGitCredential(action, agentId)
  })

// gh token fetch (multi-repo authorization, issue #457): invoked BY the
// run/bin/gh wrapper once per gh invocation — lazy import, positional args
// (same tsx-shim reasoning as git-credential). The wrapper forwards the agent's
// whole gh argv after `--`; target-repo resolution lives in cp/gh-target.ts.
// Prints ONLY the token on stdout; exit 2 = non-github target (wrapper runs the
// real gh untouched).
program
  .command('gh-token', { hidden: true })
  .description('Fetch a per-repo GH_TOKEN from the local daemon (gh wrapper backend)')
  .argument('<agentId>', 'agent whose credentials to serve')
  .argument('[ghArgs...]', "the agent's gh argv, forwarded verbatim after `--`")
  // The wrapper's `--` already ends commander's option parsing; this covers a stray gh flag before it.
  .allowUnknownOption()
  .action(async (agentId: string, ghArgs: string[]) => {
    const { runGhToken } = await import('./cli/gh-token.js')
    await runGhToken(agentId, ghArgs)
  })

// glab token fetch (gitlab-com-integration.md §13.3): the gh-token twin —
// invoked BY the run/bin/glab wrapper once per invocation. Prints ONLY the
// READ token on stdout; exit 2 = non-gitlab target (wrapper runs real glab).
program
  .command('glab-token', { hidden: true })
  .description('Fetch a read-only GITLAB_TOKEN from the local daemon (glab wrapper backend)')
  .argument('<agentId>', 'agent whose credentials to serve')
  .argument('[glabArgs...]', "the agent's glab argv, forwarded verbatim after `--`")
  .allowUnknownOption()
  .action(async (agentId: string, glabArgs: string[]) => {
    const { runGlabToken } = await import('./cli/glab-token.js')
    await runGlabToken(agentId, glabArgs)
  })

// Agent business config (identity, status, bindings) is owned by the Control
// Plane or by hand-editing agent.json — the daemon only reconciles what it finds
// on disk (docs §4/§5). So the CLI exposes a read-only `list`, not local CRUD.
const agent = program.command('agent').description('Inspect local agent directories')
agent
  .command('list')
  .description('List agents discovered under --agents-dir (id, status, runtime, name, dir)')
  .action(async () => {
    const opts = program.opts()
    try {
      const { runAgentList } = await import('./cli/agent-list.js')
      await runAgentList({ agentsDir: opts.agentsDir, configPath: opts.config, root: opts.root })
    } catch (err) {
      console.error(`agentconnect agent list: ${(err as Error).message}`)
      return exit(1)
    }
  })

program
  .command('chat [message]')
  .description('Discover an agent under --agents-dir (or --agent <name>) and chat over ACP')
  .action(async (message?: string) => {
    const opts = program.opts()
    try {
      const { runChat } = await import('./cli/chat.js')
      await runChat({
        agentsDir: opts.agentsDir,
        agentName: opts.agent,
        message,
        configPath: opts.config,
        root: opts.root
      })
      return exit(0)
    } catch (err) {
      console.error(`agentconnect chat: ${(err as Error).message}`)
      return exit(1)
    }
  })

await program.parseAsync()
await telemetry.shutdown()
