#!/usr/bin/env node
import { startDaemonOpenTelemetry } from './observability.js'
import { DAEMON_VERSION } from './version.js'

const telemetry = startDaemonOpenTelemetry({ serviceVersion: DAEMON_VERSION })
const [{ Command }, { runChat }, { runForeground }, { acquireSingletonLock }, { resolveRoot }] = await Promise.all([
  import('commander'),
  import('./cli/chat.js'),
  import('./cli/run-foreground.js'),
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
  .option('--cp-url <url>', 'override controlPlane.url')
  .option('--cp-key <key>', 'override controlPlane.key (the CP API key)')
  .option('--no-cp', 'run fully local, do not connect to the Control Plane')
  .option('--daemon-id <id>', 'override daemon identity')
  .option('--log-level <level>', 'trace|debug|info|warn|error')
  .option('--agents-dir <dir>', 'override agents directory')
  .option('--max-agents <n>', 'max agents this daemon advertises / enforces')
  .option('--require-sandbox', 'require an OS sandbox for every agent or refuse daemon startup')
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
      await runForeground({
        root: opts.root,
        agentName: opts.agent,
        // The launcher (CLI respawn shell or launchd/systemd unit) declares how
        // this daemon is supervised; the daemon can no longer self-detect it now
        // that the service layer lives in the CLI (cli-daemon-split.md §7.1).
        supervisor: process.env.AGENTCONNECT_SUPERVISOR,
        overrides: {
          cpUrl: opts.cpUrl,
          cpKey: opts.cpKey,
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

// Hidden: the stdio MCP server spawned by an agent harness. Not user-facing —
// it's referenced by `mcpServers[].command/args` at `session/new`. Reads its
// target socket + session token from AC_MCP_ENDPOINT / AC_MCP_TOKEN.
program
  .command('mcp-bridge', { hidden: true })
  .description('internal: stdio MCP bridge to the running daemon')
  .action(async () => {
    const { runBridge } = await import('./mcp/bridge.js')
    await runBridge()
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
// (same tsx-shim reasoning as git-credential). Prints ONLY the token on
// stdout; exit 2 = non-github target (wrapper runs the real gh untouched).
program
  .command('gh-token', { hidden: true })
  .description('Fetch a per-repo GH_TOKEN from the local daemon (gh wrapper backend)')
  .argument('<agentId>', 'agent whose credentials to serve')
  .argument('[repo]', 'target repo (owner/repo, host/owner/repo, or URL); absent = workspace')
  .action(async (agentId: string, repo?: string) => {
    const { runGhToken } = await import('./cli/gh-token.js')
    await runGhToken(agentId, repo)
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
