#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { selfHealCliEntry } from './self-heal.js'
import { delegate } from './delegate.js'
import { runShell } from './run-shell.js'
import { classifyInvocation, parseInstanceFlag, parseRootFlag, withResolvedRoot } from './route.js'
import { runLogin } from './login.js'
import {
  commandSelector,
  controllerFor,
  installService,
  listInstances,
  resolveController,
  resolveServiceTarget,
  shouldBakeRootEnv,
  uninstallService
} from './service/index.js'
import { runUpgrade, versionInstall, versionList, versionPrune, versionUse } from './version-commands.js'
import { CLI_VERSION } from './version.js'

const fail = (cmd: string, err: unknown): never => {
  console.error(`agentconnect ${cmd}: ${(err as Error).message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2)
  // `--instance <name>` is CLI vocabulary for "that daemon's root" (service/
  // instance.ts). Resolve it here, then rewrite argv into the `--root` form the
  // daemon understands so run/delegate never see the flag.
  const instance = parseInstanceFlag(argv)
  const target = resolveServiceTarget({
    ...(parseRootFlag(argv) !== undefined ? { root: parseRootFlag(argv)! } : {}),
    ...(instance !== undefined ? { instance } : {})
  })
  const root = target.root
  if (instance !== undefined) argv = withResolvedRoot(argv, root)
  const cliEntry = fileURLToPath(import.meta.url)
  selfHealCliEntry(root, cliEntry)

  // ── Route by the first positional command (honoring global options before it),
  //    reserving only CLI-owned commands; everything else delegates verbatim (§4.2).
  const route = classifyInvocation(argv)
  if (route === 'run') return runShell(root, argv)
  if (route === 'delegate') return delegate(root, argv)

  // ── CLI-owned surface: lifecycle, login, version management. ──
  const program = new Command()
  program
    .name('agentconnect')
    .description('AgentConnect CLI — daemon lifecycle, version management, upgrade')
    .version(CLI_VERSION)

  // Global options. The CLI itself only reads --root/--config/--api-*/--daemon-id;
  // the rest are declared so they pass validation on CLI-owned commands and are
  // forwarded verbatim to the daemon on delegated ones.
  program
    .option('--config <path>', 'path to config.json (default ~/.agentconnect/config.json)')
    .option('--root <dir>', 'override ~/.agentconnect root directory')
    .option('--instance <name>', 'address a named daemon service instance (root defaults to ~/.agentconnect-<name>)')
    .option('--api-url <url>', 'override AgentConnect API WebSocket URL')
    .option('--api-key <key>', 'override daemon API key')
    .option('--no-cp', 'run fully local, do not connect to the Control Plane')
    .option('--daemon-id <id>', 'override daemon identity')
    .option('--log-level <level>', 'trace|debug|info|warn|error')
    .option('--agents-dir <dir>', 'override agents directory')
    .option('--max-agents <n>', 'max agents this daemon advertises / enforces')
    .option('--require-sandbox', 'require an OS sandbox for every agent or refuse daemon startup')
    .option('--dry-run', 'load + validate config and print the reconcile plan, then exit')
    .option('--agent <name>', 'select a single agent by id (run/chat)')

  // Every service command addresses the same target the argv scan above resolved,
  // and every suggested follow-up command repeats that selector so a copy-paste
  // lands on this instance rather than the default one.
  const serviceTarget = () => ({ root, ...(instance !== undefined ? { instance } : {}) })
  const selector = commandSelector(serviceTarget())
  const controller = () => resolveController(serviceTarget())
  const requireInstalled = (c: ReturnType<typeof controller>): void => {
    if (!c.isInstalled()) {
      console.error(
        `agentconnect: no service installed (${c.label}) — run \`agentconnect${selector} install-service\` first, or \`agentconnect${selector} run\` for foreground`
      )
      process.exit(1)
    }
  }
  // includeRootEnv follows the RESOLVED root, not whether a flag was typed: an
  // AGENTCONNECT_ROOT-driven install must not write a unit that omits the root
  // and silently falls back to ~/.agentconnect at service start.
  const installOpts = () => ({
    execPath: process.execPath,
    includeRootEnv: shouldBakeRootEnv(root),
    cliEntry,
    ...(process.env.PATH ? { envPath: process.env.PATH } : {})
  })

  program
    .command('up')
    .description('Start the installed background service (launchd / systemd)')
    .action(async () => {
      const c = controller()
      requireInstalled(c)
      try {
        await c.up()
        console.log('agentconnect: service started')
      } catch (err) {
        fail('up', err)
      }
    })

  program
    .command('down')
    .description('Stop the installed background service')
    .action(async () => {
      const c = controller()
      requireInstalled(c)
      try {
        await c.down()
        console.log('agentconnect: service stopped')
      } catch (err) {
        fail('down', err)
      }
    })

  program
    .command('restart')
    .description('Restart the installed background service')
    .action(async () => {
      const c = controller()
      requireInstalled(c)
      try {
        await c.down()
      } catch (err) {
        fail('restart', err)
      }
      try {
        await c.up()
        console.log('agentconnect: service restarted')
      } catch (err) {
        console.error(
          `agentconnect restart: service stopped but failed to start again — run \`agentconnect${selector} up\` to retry: ${(err as Error).message}`
        )
        process.exit(1)
      }
    })

  program
    .command('status')
    .description('Print service status (installed / running / pid / log path)')
    .action(async () => {
      try {
        const s = await controller().status()
        if (!s.installed) {
          console.log(
            `service: not installed (${s.label}). Run \`agentconnect${selector} install-service\` or \`agentconnect${selector} run\`.`
          )
          return
        }
        console.log(`service:  ${s.label}`)
        console.log(`root:     ${root}`)
        console.log(`state:    ${s.running ? 'running' : 'stopped'}${s.pid ? ` (pid ${s.pid})` : ''}`)
        console.log(`logs:     ${s.logPath}`)
      } catch (err) {
        fail('status', err)
      }
    })

  program
    .command('install-service')
    .description('Install the launchd / systemd service (does not start it — run `agentconnect up`)')
    .action(async () => {
      try {
        const c = await installService(serviceTarget(), installOpts())
        console.log(`agentconnect: service installed (${c.label}, root ${root}).`)
        console.log(`Run \`agentconnect${selector} up\` to start it.`)
      } catch (err) {
        fail('install-service', err)
      }
    })

  program
    .command('uninstall-service')
    .description('Stop and remove the system service')
    .action(async () => {
      try {
        const c = await uninstallService(serviceTarget())
        console.log(`agentconnect: service uninstalled (${c.label})`)
      } catch (err) {
        fail('uninstall-service', err)
      }
    })

  program
    .command('instances')
    .description('List the daemon services installed on this host (one per instance)')
    .action(async () => {
      try {
        const found = listInstances()
        if (found.length === 0) {
          console.log(
            'no daemon service installed — run `agentconnect install-service` (add `--instance <name>` for a second one)'
          )
          return
        }
        for (const unit of found) {
          const s = await controllerFor(unit).status()
          const state = s.running ? `running${s.pid ? ` (pid ${s.pid})` : ''}` : 'stopped'
          console.log(`${unit.instance ?? '(default)'}\t${state}\t${unit.root}\t${unit.label}`)
        }
      } catch (err) {
        fail('instances', err)
      }
    })

  program
    .command('login')
    .description(
      'Interactive onboarding: test API credentials, save them, then install+start the service or run in the foreground'
    )
    .action(async () => {
      const opts = program.opts()
      try {
        await runLogin({
          apiUrl: opts.apiUrl,
          apiKey: opts.apiKey,
          daemonId: opts.daemonId,
          root,
          ...(instance !== undefined ? { instance } : {}),
          configPath: opts.config,
          cliEntry
        })
        process.exit(0)
      } catch (err) {
        fail('login', err)
      }
    })

  // Version management (cli-daemon-split.md §5).
  const asChannel = (c?: string): 'stable' | 'rc' | undefined =>
    c === 'stable' || c === 'rc'
      ? c
      : c === undefined
        ? undefined
        : fail('version', new Error(`unknown channel '${c}' (use stable|rc)`))

  const version = program.command('version').description('Manage installed daemon versions')
  // Bare `agentconnect version` → list (and the CLI's own version prints via --version).
  version.action(() => versionList(root))
  version
    .command('list')
    .description('List installed daemon versions and the active one')
    .action(() => versionList(root))
  version
    .command('install [version]')
    .description('Download and unpack a daemon version (defaults to the channel dist-tag)')
    .option('--channel <channel>', 'stable|rc (default: the stored channel)')
    .action(async (v: string | undefined, o: { channel?: string }) => {
      try {
        await versionInstall(root, { to: v, channel: asChannel(o.channel) })
      } catch (err) {
        fail('version install', err)
      }
    })
  version
    .command('use <version>')
    .description('Activate an installed daemon version (does not restart)')
    .action(async (v: string) => {
      try {
        await versionUse(root, v)
      } catch (err) {
        fail('version use', err)
      }
    })
  version
    .command('prune')
    .description('Remove old daemon versions, keeping the newest N (current/previous always kept)')
    .option('--keep <n>', 'how many prunable versions to keep', '2')
    .action(async (o: { keep: string }) => {
      try {
        await versionPrune(root, Math.max(0, Number(o.keep) || 0))
      } catch (err) {
        fail('version prune', err)
      }
    })
  // Top-level `install` — the convenient alias of `version install`. First
  // install on a fresh root also activates it (versionInstall), so manual
  // installs do not need a follow-up `version use`.
  program
    .command('install [version]')
    .description('Download, unpack, and (on a fresh host) activate a daemon version')
    .option('--channel <channel>', 'stable|rc (default: the stored channel)')
    .action(async (v: string | undefined, o: { channel?: string }) => {
      try {
        await versionInstall(root, { to: v, channel: asChannel(o.channel) })
      } catch (err) {
        fail('install', err)
      }
    })

  program
    .command('upgrade')
    .description('Install the latest daemon version, switch to it, and (with --restart) restart + health-check')
    .option('--to <version>', 'upgrade to a specific version instead of the channel latest')
    .option('--channel <channel>', 'stable|rc (default: the stored channel)')
    .option('--restart', 'restart the service now and roll back if it fails its health check')
    .action(async (o: { to?: string; channel?: string; restart?: boolean }) => {
      try {
        await runUpgrade(root, { to: o.to, channel: asChannel(o.channel), restart: Boolean(o.restart) })
      } catch (err) {
        fail('upgrade', err)
      }
    })

  await program.parseAsync()
}

// Delegation / run-shell surface their failures (e.g. no active daemon) as thrown
// errors; present them as a clean CLI message rather than an unhandled stack trace.
// (commander handles its own command errors and exits before returning here.)
try {
  await main()
} catch (err) {
  console.error(`agentconnect: ${(err as Error).message}`)
  process.exit(1)
}
